import { LIMITS, SMART_CUTOUT_MODEL, SMOOTHING_ALPHA } from "./constants";
import {
	isSceneCut,
	letterboxLayout,
	lumaFingerprint,
	outputToMatte,
	rgbaToTensor,
	smoothMatte,
} from "./matte-math";
import { chooseStride, SequenceMatteSource, type SequenceMeta } from "./matte-sequence";
import { runsToEvict, type MatteStore } from "./matte-store";

export type CutoutRun = {
	key: string;
	mediaWidth: number;
	mediaHeight: number;
	fps: number;
	startSeconds: number;
	durationSeconds: number;
};

export type CutoutDeps = {
	store: MatteStore;
	/** The frame at a source second, drawn letterboxed into a square of `size` pixels (RGBA). Never on the UI thread's critical path. */
	grab({ sourceSeconds, size }: { sourceSeconds: number; size: number }): Promise<Uint8ClampedArray>;
	/** One model run: float32 CHW input -> the first output (size x size). */
	infer({ tensor }: { tensor: Float32Array }): Promise<Float32Array>;
	signal?: AbortSignal;
	onProgress?({ done, total, stride }: { done: number; total: number; stride: number }): void;
	/** Lets the UI breathe between frames. */
	yieldToUi?(): Promise<void>;
};

export type CutoutOutcome =
	| { status: "done"; source: SequenceMatteSource; stride: number; fromCache: boolean }
	| { status: "cancelled" };

/** A finished run from the store, or null. */
export async function loadCutout({
	key,
	store,
}: {
	key: string;
	store: MatteStore;
}): Promise<SequenceMatteSource | null> {
	const meta = await store.getMeta({ key });
	if (!meta?.complete) return null;
	// the stored run is in use now: it is the last to be pruned
	await store.putMeta({ key, meta: { ...meta, usedAt: Date.now() } }).catch(() => {});
	const source = new SequenceMatteSource({ id: key, meta });
	const total = Math.ceil(meta.frameCount / meta.stride);
	for (let step = 0; step < total; step++) {
		const index = step * meta.stride;
		const data = await store.getFrame({ key, index });
		// a frame of the wrong size (a damaged entry) makes the whole run "not stored"
		if (!data || data.length !== meta.width * meta.height) return null;
		source.set({ index, data });
	}
	return source;
}

export async function runCutout({ run, deps }: { run: CutoutRun; deps: CutoutDeps }): Promise<CutoutOutcome> {
	const { store, grab, infer, signal, onProgress, yieldToUi } = deps;
	const cached = await loadCutout({ key: run.key, store });
	if (cached) {
		onProgress?.({ done: 1, total: 1, stride: cached.meta.stride });
		return { status: "done", source: cached, stride: cached.meta.stride, fromCache: true };
	}
	await store.clear({ key: run.key });
	const size = SMART_CUTOUT_MODEL.inputSize;
	const box = letterboxLayout({ width: run.mediaWidth, height: run.mediaHeight, size });
	const fps = Math.min(Math.max(run.fps, 1), LIMITS.maxFps);
	const frameCount = Math.min(LIMITS.maxFrames, Math.max(1, Math.ceil(run.durationSeconds * fps)));
	const stride = chooseStride({ frameCount, matteBytes: box.width * box.height });
	const meta: SequenceMeta = {
		width: box.width,
		height: box.height,
		fps,
		startSeconds: run.startSeconds,
		stride,
		frameCount,
	};
	await store.putMeta({ key: run.key, meta: { ...meta, complete: false } });
	const source = new SequenceMatteSource({ id: run.key, meta });
	const total = Math.ceil(frameCount / stride);
	let previousMatte: Uint8Array | null = null;
	let previousPrint: Float32Array | null = null;
	for (let step = 0; step < total; step++) {
		if (signal?.aborted) {
			await store.clear({ key: run.key });
			return { status: "cancelled" };
		}
		const index = step * stride;
		const rgba = await grab({ sourceSeconds: run.startSeconds + index / fps, size });
		const print = lumaFingerprint({ rgba, size });
		const cut = isSceneCut({ previous: previousPrint, current: print });
		const raw = outputToMatte({ output: await infer({ tensor: rgbaToTensor({ rgba, size }) }), box });
		// a cut starts the smoothing again: the last picture says nothing about this one
		const matte: Uint8Array = cut ? raw : smoothMatte({ previous: previousMatte, current: raw, alpha: SMOOTHING_ALPHA });
		previousMatte = matte;
		previousPrint = print;
		source.set({ index, data: matte });
		await store.putFrame({ key: run.key, index, data: matte });
		onProgress?.({ done: step + 1, total, stride });
		await yieldToUi?.();
	}
	if (signal?.aborted) {
		await store.clear({ key: run.key });
		return { status: "cancelled" };
	}
	await store.putMeta({ key: run.key, meta: { ...meta, complete: true, usedAt: Date.now() } });
	const stale = runsToEvict({ metas: await store.listMetas(), protect: run.key });
	for (const old of stale) await store.clear({ key: old });
	return { status: "done", source, stride, fromCache: false };
}
