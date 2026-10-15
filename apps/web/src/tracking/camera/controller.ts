import { registerCanceller } from "@/editor/cancel-interaction";
import { frameRateToFloat } from "@/fps/utils";
import type { MediaAsset } from "@/media/types";
import type { Transform } from "@/rendering";
import type { SceneTracks, VideoElement } from "@/timeline";
import { isVisualElement } from "@/timeline/element-utils";
import { decodeGrayFrames } from "@/tracking/frame-source";
import { findElementInTracks, type HostTimingClip } from "@/tracking/host";
import { generateUUID } from "@/utils/id";
import type { FrameRate } from "opencut-wasm";
import { AnalysisCache } from "./analysis-cache";
import {
	ANALYSIS_MESSAGES,
	analysisSourceWindowOf,
	analyze,
	type AnalysisDeps,
	type AnalysisOutcome,
	messageOf,
	type TimelineWindow,
} from "./analysis-service";
import {
	type CameraAnalysisJob,
	type CameraPinController,
	type CameraPinOutcome,
	IDLE_CAMERA_JOB,
} from "./analysis-types";
import {
	boxFor,
	CAMERA_PIN_MESSAGES,
	type CameraPinErrorCode,
	type CameraPinRecord,
	type NoKeysPlan,
	type PinFailure,
	type PinModeChoice,
	type PinScene,
	type PinnedPlan,
	pinWindow,
	readScene,
	repinElement,
	selectPinHost,
	stickToScene,
} from "./pin-element";
import { registerCameraPinController, useCameraPinStore } from "./store";
import type { LocalRect } from "./to-channels";
import type { CameraAnalysis } from "./types";
import { yieldToUi } from "./yield-to-ui";

export const MEDIA_FILE_MISSING_MESSAGE = "The video file of this clip is not loaded.";
export const NOT_STUCK_MESSAGE = "This clip is not stuck to the scene.";

/** What the controller reads of a plan: slice T3's plans fit, and so do plain test doubles. */
export type CameraPinPlanLike =
	| Pick<
			PinnedPlan,
			"status" | "elementId" | "notices" | "lostFrame" | "cutTimes" | "mode" | "model" | "pin"
	  >
	| NoKeysPlan
	| PinFailure;

/** What the controller needs from the editor and the engine, so it runs without either. */
export interface CameraPinControllerDeps {
	/** The active scene as the planner reads it (`readScene` of pin-element.ts). */
	readScene: () => PinScene | null;
	pause: () => void;
	getProjectFps: () => number;
	/** The media file of a clip, or null when it is not loaded. */
	mediaFile: ({ mediaId }: { mediaId: string }) => File | null;
	analyze: (args: {
		hostElementId: string;
		host: HostTimingClip;
		file: File;
		window: TimelineWindow;
		projectFps: number;
		signal: AbortSignal;
		onProgress?: ({ fraction }: { fraction: number }) => void;
	}) => Promise<AnalysisOutcome>;
	/** Slice T3's `stickToScene`: plans and writes the keys, one undo step. */
	stick: (args: {
		elementId: string;
		analysis: CameraAnalysis;
		mode?: PinModeChoice;
		box?: LocalRect;
	}) => CameraPinPlanLike;
	/** Slice T3's `repinElement`. */
	repin: (args: {
		elementId: string;
		analysis: CameraAnalysis;
		pin: CameraPinRecord;
		look?: Transform;
		box?: LocalRect;
	}) => CameraPinPlanLike;
}

export interface CameraPinEngine extends CameraPinController {
	readonly cache: AnalysisCache;
	readonly deps: CameraPinControllerDeps;
	/** Is an analysis in flight? */
	readonly running: boolean;
	/**
	 * The editor session this engine served is over: stops the run in flight, leaves
	 * the job idle, and from now on nothing the engine still has under way (the
	 * stopped run ending, a progress report) is written to the store or the
	 * timeline. The run frees its own resources as it ends.
	 */
	dispose(): void;
}

function fail({
	error,
	message = CAMERA_PIN_MESSAGES[error],
}: {
	error: CameraPinErrorCode;
	message?: string;
}): PinFailure {
	return { status: "error", error, message };
}

/** A plan, as the UI is told about it. */
export function outcomeOf({
	plan,
	elementId,
}: {
	plan: CameraPinPlanLike;
	elementId: string;
}): CameraPinOutcome {
	switch (plan.status) {
		case "pinned":
			return {
				status: "pinned",
				elementId,
				notices: plan.notices,
				lostFrame: plan.lostFrame,
				cutTimes: plan.cutTimes,
				mode: plan.mode,
				model: plan.model,
			};
		case "no-keys":
			return { status: "no-keys", elementId, notices: plan.notices, lostFrame: plan.lostFrame };
		case "error":
			return { ...plan, elementId };
	}
}

/** The host chosen for an element, and the stretch of the timeline they share. */
interface Prepared {
	status: "ready";
	host: VideoElement;
	window: TimelineWindow;
	box: LocalRect | null;
}

type Obtained = { status: "ready"; analysis: CameraAnalysis } | { status: "cancelled" } | PinFailure;

/**
 * The engine behind "Stick to scene": finds the video under an element,
 * analyses it (one job at a time, paused playback, progress in the store,
 * stopped by `cancel` or Esc) or takes the analysis from the session cache,
 * then has slice T3 solve and write the keys and records the outcome and the
 * pin in the store. A cancelled or failed run writes nothing and caches
 * nothing; the host deleted meanwhile drops the result.
 */
export function createCameraPinController({
	deps,
	cache = new AnalysisCache(),
}: {
	deps: CameraPinControllerDeps;
	cache?: AnalysisCache;
}): CameraPinEngine {
	const store = () => useCameraPinStore.getState();
	let activeRun: AbortController | null = null;
	let disposed = false;

	/** The store, unless the session this engine served has ended: then it belongs to the next one. */
	function publishJob(job: CameraAnalysisJob): void {
		if (!disposed) store().setJob(job);
	}

	function prepare({ elementId }: { elementId: string }): Prepared | PinFailure {
		const scene = deps.readScene();
		if (!scene) return fail({ error: "no-element" });
		const found = findElementInTracks({ tracks: scene.tracks, elementId });
		if (!found) return fail({ error: "no-element" });
		if (!isVisualElement(found.element)) return fail({ error: "unsupported-element" });
		const box = boxFor({ scene, elementId, box: undefined });
		const selection = selectPinHost({ scene, elementId, box });
		if (!selection) return fail({ error: "no-video" });
		const window = pinWindow({ element: found.element, host: selection.host });
		if (!window) return fail({ error: "no-video" });
		return { status: "ready", host: selection.host, window, box };
	}

	/** Is the host still in the scene, playing the same media? */
	function hostPresent({ host }: { host: VideoElement }): boolean {
		const scene = deps.readScene();
		const now = scene && findElementInTracks({ tracks: scene.tracks, elementId: host.id })?.element;
		return !!now && now.type === "video" && now.mediaId === host.mediaId;
	}

	/** Runs the analysis job for a host and window, and caches a complete result. */
	async function runJob({ host, window, file }: { host: VideoElement; window: TimelineWindow; file: File }): Promise<Obtained> {
		const controller = new AbortController();
		activeRun = controller;
		// Esc empties the canceller list before calling it. Stay registered until
		// the decoder has really stopped, so a second Esc is still taken as ours.
		let releaseCanceller = () => {};
		const cancel = () => {
			controller.abort();
			releaseCanceller = registerCanceller({ fn: cancel });
		};
		releaseCanceller = registerCanceller({ fn: cancel });
		let hostChanged = false;

		// everything from here on is inside the try: whatever throws, the job ends idle and Esc is released
		try {
			let outcome: AnalysisOutcome;
			try {
				deps.pause();
				publishJob({ state: "running", hostElementId: host.id, progress: 0 });
				outcome = await deps.analyze({
					hostElementId: host.id,
					host,
					file,
					window,
					projectFps: deps.getProjectFps(),
					signal: controller.signal,
					onProgress: ({ fraction }) => {
						if (!hostPresent({ host })) {
							hostChanged = true;
							controller.abort();
							return;
						}
						publishJob({ state: "running", hostElementId: host.id, progress: fraction });
					},
				});
			} catch (error) {
				outcome = {
					status: "error",
					error: "decode-failed",
					message: messageOf({ error }) ?? ANALYSIS_MESSAGES["decode-failed"],
				};
			}
			// the clip the frames came from is gone or plays other media: the result is worthless
			if (hostChanged || !hostPresent({ host })) return fail({ error: "host-changed" });
			// a stop wins over whatever the analysis answered: it may have finished (or failed on being stopped) without looking at the signal
			if (outcome.status === "cancelled" || controller.signal.aborted) return { status: "cancelled" };
			if (outcome.status === "error") {
				return fail({ error: "analysis-failed", message: outcome.message });
			}
			cache.put({ analysis: outcome.analysis });
			return { status: "ready", analysis: outcome.analysis };
		} finally {
			releaseCanceller();
			activeRun = null;
			publishJob(IDLE_CAMERA_JOB);
		}
	}

	/** The analysis of the host's window: from the cache at once, else from a job. */
	async function obtainAnalysis({ host, window }: Prepared): Promise<Obtained> {
		const cached = cache.getCached({
			hostElementId: host.id,
			mediaId: host.mediaId,
			window: analysisSourceWindowOf({ host, window }),
		});
		if (cached) return { status: "ready", analysis: cached };
		const file = deps.mediaFile({ mediaId: host.mediaId });
		if (!file) return fail({ error: "analysis-failed", message: MEDIA_FILE_MISSING_MESSAGE });
		// only a real analysis needs the one job slot: a cache hit above needs no media at all
		if (activeRun) return fail({ error: "busy" });
		return runJob({ host, window, file });
	}

	function record({ plan, elementId }: { plan: CameraPinPlanLike; elementId: string }): CameraPinOutcome {
		const outcome = outcomeOf({ plan, elementId });
		// busy says nothing about the element: it keeps the outcome and pin it has
		const busy = plan.status === "error" && plan.error === "busy";
		if (!disposed && !busy) {
			store().recordOutcome({ outcome, pin: plan.status === "pinned" ? plan.pin : undefined });
		}
		return outcome;
	}

	function settle({ got, elementId }: { got: Obtained; elementId: string }): CameraPinOutcome {
		if (got.status === "cancelled") {
			const outcome: CameraPinOutcome = { status: "cancelled", elementId };
			if (!disposed) store().recordOutcome({ outcome });
			return outcome;
		}
		if (got.status === "error") return record({ plan: got, elementId });
		throw new Error("settle: a ready analysis is not an outcome");
	}

	return {
		cache,
		deps,
		get running() {
			return activeRun !== null;
		},

		async stick({ elementId, mode }) {
			const prepared = prepare({ elementId });
			if (prepared.status === "error") return record({ plan: prepared, elementId });
			const got = await obtainAnalysis(prepared);
			// the session ended while the analysis was found or made: nothing is written to the timeline either
			if (disposed) return settle({ got: { status: "cancelled" }, elementId });
			if (got.status !== "ready") return settle({ got, elementId });
			let plan: CameraPinPlanLike;
			try {
				plan = deps.stick({
					elementId,
					analysis: got.analysis,
					mode,
					box: prepared.box ?? undefined,
				});
			} catch (error) {
				plan = fail({ error: "apply-failed", message: messageOf({ error }) });
			}
			return record({ plan, elementId });
		},

		async repin({ elementId, look }) {
			const pin = store().pins[elementId];
			if (!pin) return record({ plan: fail({ error: "no-element", message: NOT_STUCK_MESSAGE }), elementId });
			let analysis = cache.byId({ analysisId: pin.analysisId });
			let box: LocalRect | undefined;
			if (!analysis) {
				// evicted or a fresh session: the host is analysed again, the pin solved from that
				const prepared = prepare({ elementId });
				if (prepared.status === "error") return record({ plan: prepared, elementId });
				const got = await obtainAnalysis(prepared);
				if (disposed) return settle({ got: { status: "cancelled" }, elementId });
				if (got.status !== "ready") return settle({ got, elementId });
				analysis = got.analysis;
				box = prepared.box ?? undefined;
			}
			let plan: CameraPinPlanLike;
			try {
				plan = deps.repin({ elementId, analysis, pin, look, box });
			} catch (error) {
				plan = fail({ error: "apply-failed", message: messageOf({ error }) });
			}
			return record({ plan, elementId });
		},

		cancel() {
			activeRun?.abort();
		},

		dispose() {
			disposed = true;
			if (!activeRun) return;
			activeRun.abort();
			// the stopped run no longer reports: its job is over now, not whenever it notices
			store().setJob(IDLE_CAMERA_JOB);
		},
	};
}

// ---------------------------------------------------------------------------
// Installation in the editor
// ---------------------------------------------------------------------------

/** What the installation reads of the editor (`EditorCore` fits). */
export interface CameraPinEditor {
	playback: { pause(): void };
	project: {
		subscribe(listener: () => void): () => void;
		getActiveOrNull(): { metadata: { id: string }; settings: { fps: FrameRate } } | null;
	};
	timeline: { subscribe(listener: () => void): () => void };
	scenes: {
		subscribe(listener: () => void): () => void;
		getScenes(): Array<{ tracks: SceneTracks }>;
	};
	media: { getAssets(): Array<Pick<MediaAsset, "id" | "file">> };
}

const FALLBACK_FPS = 30;

function editorDeps({ editor }: { editor: CameraPinEditor }): CameraPinControllerDeps {
	const analysisDeps: AnalysisDeps = {
		decode: decodeGrayFrames,
		now: () => performance.now(),
		yieldToUi,
		newId: generateUUID,
	};
	return {
		readScene,
		pause: () => editor.playback.pause(),
		getProjectFps: () => {
			const project = editor.project.getActiveOrNull();
			return project ? frameRateToFloat(project.settings.fps) : FALLBACK_FPS;
		},
		mediaFile: ({ mediaId }) =>
			editor.media.getAssets().find((asset) => asset.id === mediaId)?.file ?? null,
		analyze: (args) => analyze({ ...args, deps: analysisDeps }),
		stick: stickToScene,
		repin: repinElement,
	};
}

/** The media a video clip plays now, in whichever scene it lives, or null when it is gone. */
function hostMediaId({
	editor,
	hostElementId,
}: {
	editor: CameraPinEditor;
	hostElementId: string;
}): string | null {
	for (const scene of editor.scenes.getScenes()) {
		const element = findElementInTracks({ tracks: scene.tracks, elementId: hostElementId })?.element;
		if (element) return element.type === "video" ? element.mediaId : null;
	}
	return null;
}

/** Forgets every pin record and outcome: they belong to a session that has ended. */
function forgetSession(): void {
	const { pins, outcomes, forget } = useCameraPinStore.getState();
	for (const elementId of new Set([...Object.keys(pins), ...Object.keys(outcomes)])) {
		forget({ elementId });
	}
}

let activeTeardown: (() => void) | null = null;

/**
 * Registers the engine with the store for this editor session and keeps the
 * cache in step with the project: an analysis goes when its host clip is
 * deleted or plays other media, everything goes (pins too) when the project
 * changes. Returns the teardown, which stops a running job, unsubscribes,
 * unregisters and forgets the session's pins (their analyses go with the
 * cache); installing again tears the earlier installation down first (hot
 * reload).
 */
export function installCameraPinController({
	editor,
	deps = {},
	cache = new AnalysisCache(),
}: {
	editor: CameraPinEditor;
	/** Replacements for parts of the editor-bound dependencies (tests). */
	deps?: Partial<CameraPinControllerDeps>;
	cache?: AnalysisCache;
}): () => void {
	activeTeardown?.();
	const engine = createCameraPinController({ cache, deps: { ...editorDeps({ editor }), ...deps } });
	registerCameraPinController(engine);

	let projectId = editor.project.getActiveOrNull()?.metadata.id ?? null;
	const sync = () => {
		const now = editor.project.getActiveOrNull()?.metadata.id ?? null;
		if (now !== projectId) {
			projectId = now;
			cache.clear();
			forgetSession();
		}
		if (cache.size > 0) {
			cache.prune({ mediaIdOf: ({ hostElementId }) => hostMediaId({ editor, hostElementId }) });
		}
	};
	const unsubscribes = [
		editor.project.subscribe(sync),
		editor.timeline.subscribe(sync),
		editor.scenes.subscribe(sync),
	];

	const teardown = () => {
		if (activeTeardown !== teardown) return;
		activeTeardown = null;
		for (const unsubscribe of unsubscribes) unsubscribe();
		engine.dispose();
		registerCameraPinController(null);
		forgetSession();
	};
	activeTeardown = teardown;
	return teardown;
}
