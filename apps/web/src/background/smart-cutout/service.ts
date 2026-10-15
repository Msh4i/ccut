import type { MediaAsset } from "@/media/types";
import { mediaTimeToSeconds } from "@/wasm";
import type { VideoElement } from "@/timeline";
import { registerMatteSource, unregisterMatteSource } from "../matte/matte-registry";
import { LIMITS, MAX_TOTAL_MATTE_BYTES } from "./constants";
import { MatteLedger } from "./matte-ledger";
import type { SequenceMatteSource } from "./matte-sequence";
import { createFrameGrabber } from "./frame-grabber";
import { getModelsBridge } from "./models-bridge";
import { createOrtClient } from "./ort-client";
import {
	type CutoutRun,
	loadCutout,
	runCutout,
} from "./run-cutout";
import { IndexedDbMatteStore, matteKey, type MatteStore } from "./matte-store";

export type CutoutPhase =
	| "idle"
	| "loading-model"
	| "running"
	| "done"
	| "cancelled"
	| "model-missing"
	| "unsupported"
	| "error";

export type CutoutState = {
	phase: CutoutPhase;
	done: number;
	total: number;
	/** 1 = every frame, 2 = every 2nd (the rest interpolated), ... */
	stride: number;
	message: string;
};

const IDLE: CutoutState = { phase: "idle", done: 0, total: 0, stride: 1, message: "" };

const ledger = new MatteLedger(MAX_TOTAL_MATTE_BYTES);

/** Registers a finished run, dropping other clips' mattes from memory when the total would pass the cap. */
function registerWithBudget({ elementId, source }: { elementId: string; source: SequenceMatteSource }) {
	for (const dropped of ledger.admit({ clipId: elementId, bytes: source.size * source.meta.width * source.meta.height })) {
		unregisterMatteSource({ elementId: dropped, kind: "ai" });
	}
	registerMatteSource({ elementId, kind: "ai", source });
}

const states = new Map<string, CutoutState>();
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
let store: MatteStore | null = null;

function getStore(): MatteStore {
	store ??= new IndexedDbMatteStore({ factory: indexedDB, keyRange: IDBKeyRange });
	return store;
}

function setState({ elementId, state }: { elementId: string; state: CutoutState }) {
	states.set(elementId, state);
	for (const listener of listeners) listener();
}

export function getCutoutState({ elementId }: { elementId: string }): CutoutState {
	return states.get(elementId) ?? IDLE;
}

export function subscribeCutout(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The run (media, range, fps) a clip's cutout is made for, or null when the asset lacks what is needed. */
export function cutoutRunFor({
	element,
	asset,
}: {
	element: VideoElement;
	asset: MediaAsset;
}): (CutoutRun & { file: File }) | null {
	const { width, height, duration } = asset;
	if (!width || !height || !duration || duration <= 0) return null;
	const trimStart = mediaTimeToSeconds({ time: element.trimStart });
	const trimEnd = mediaTimeToSeconds({ time: element.trimEnd });
	const length = duration - trimStart - trimEnd;
	if (!(length > 0)) return null;
	return {
		key: matteKey({
			mediaId: asset.id,
			trimStartTicks: Number(element.trimStart),
			trimEndTicks: Number(element.trimEnd),
		}),
		file: asset.file,
		mediaWidth: width,
		mediaHeight: height,
		// the rate comes from the file's packets: a damaged or hostile file can say anything
		fps: asset.fps && Number.isFinite(asset.fps) && asset.fps > 0 ? Math.min(asset.fps, LIMITS.maxFps) : 30,
		startSeconds: trimStart,
		durationSeconds: length,
	};
}

/** Registers a finished cutout from the store (no model needed). True when there was one. */
export async function restoreCutout({
	element,
	asset,
}: {
	element: VideoElement;
	asset: MediaAsset;
}): Promise<boolean> {
	const run = cutoutRunFor({ element, asset });
	if (!run) return false;
	const source = await loadCutout({ key: run.key, store: getStore() });
	if (!source) {
		unregisterMatteSource({ elementId: element.id, kind: "ai" });
		return false;
	}
	registerWithBudget({ elementId: element.id, source });
	return true;
}

export function cancelCutout({ elementId }: { elementId: string }) {
	controllers.get(elementId)?.abort();
}

export async function clearCutout({ element, asset }: { element: VideoElement; asset: MediaAsset }) {
	cancelCutout({ elementId: element.id });
	const run = cutoutRunFor({ element, asset });
	unregisterMatteSource({ elementId: element.id, kind: "ai" });
	ledger.release({ clipId: element.id });
	if (run) await getStore().clear({ key: run.key });
	setState({ elementId: element.id, state: IDLE });
}

/** Runs the cutout for one clip and registers it. Resolves true when a matte is ready. */
export async function startCutout({
	element,
	asset,
}: {
	element: VideoElement;
	asset: MediaAsset;
}): Promise<boolean> {
	const elementId = element.id;
	if (controllers.has(elementId)) return false;
	const bridge = getModelsBridge();
	if (!bridge || typeof Worker === "undefined") {
		setState({ elementId, state: { ...IDLE, phase: "unsupported", message: "Smart cutout runs in the desktop app." } });
		return false;
	}
	const run = cutoutRunFor({ element, asset });
	if (!run) {
		setState({ elementId, state: { ...IDLE, phase: "error", message: "This clip's size or length is unknown." } });
		return false;
	}
	const controller = new AbortController();
	controllers.set(elementId, controller);
	setState({ elementId, state: { ...IDLE, phase: "loading-model", message: "Loading the model..." } });
	let client: Awaited<ReturnType<typeof createOrtClient>> | null = null;
	try {
		const cached = await loadCutout({ key: run.key, store: getStore() });
		if (cached) {
			registerWithBudget({ elementId, source: cached });
			setState({ elementId, state: { phase: "done", done: 1, total: 1, stride: cached.meta.stride, message: "" } });
			return true;
		}
		const status = await bridge.status();
		if (!status?.installed) {
			setState({ elementId, state: { ...IDLE, phase: "model-missing", message: "The smart cutout model is not installed." } });
			return false;
		}
		const model = await bridge.read();
		if (!model) {
			setState({ elementId, state: { ...IDLE, phase: "model-missing", message: "The model file is missing or does not match. Download it again." } });
			return false;
		}
		client = await createOrtClient({ model });
		const grab = createFrameGrabber({
			mediaId: asset.id,
			file: run.file,
			streamKey: `smart-cutout:${elementId}`,
			mediaWidth: run.mediaWidth,
			mediaHeight: run.mediaHeight,
		});
		const activeClient = client;
		const outcome = await runCutout({
			run,
			deps: {
				store: getStore(),
				grab,
				infer: ({ tensor }) => activeClient.infer({ tensor }),
				signal: controller.signal,
				yieldToUi: () => new Promise((resolve) => setTimeout(resolve, 0)),
				onProgress: ({ done, total, stride }) =>
					setState({ elementId, state: { phase: "running", done, total, stride, message: "" } }),
			},
		});
		if (outcome.status === "cancelled") {
			setState({ elementId, state: { ...IDLE, phase: "cancelled", message: "Cancelled." } });
			return false;
		}
		registerWithBudget({ elementId, source: outcome.source });
		setState({ elementId, state: { phase: "done", done: 1, total: 1, stride: outcome.stride, message: "" } });
		return true;
	} catch (error) {
		const text = error instanceof Error ? error.message : "Unknown error";
		setState({ elementId, state: { ...IDLE, phase: "error", message: `The cutout failed: ${text}` } });
		return false;
	} finally {
		client?.dispose();
		controllers.delete(elementId);
	}
}
