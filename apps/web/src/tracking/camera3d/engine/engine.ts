import { registerCanceller } from "@/editor/cancel-interaction";
import type { MediaType } from "@/media/types";
import type { Target } from "@/scene3d/types";
import type {
	CreateCameraElement,
	CreateTextElement,
	CreateTimelineElement,
	SceneTracks,
	VideoElement,
} from "@/timeline";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { GrayFrame } from "@/tracking/types";
import type { MediaTime } from "@/wasm";
import { packSolve, packTracks } from "../codec";
import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	useCameraTrackerSession,
	type CameraTrackerApi,
	type CameraTrackerRunOutcome,
	type CreateTrackedLayersOutcome,
	type DecodedCameraTracker,
} from "../session";
import {
	ANALYSIS_SETTING_KEYS,
	CAMERA_SOLVE_MESSAGES,
	DEFAULT_CAMERA_TRACKER_SETTINGS,
	SOLVE_SETTING_KEYS,
	type CameraSolve,
	type CameraSolveOutcome,
	type CameraTrackerData,
	type CameraTrackerPhase,
	type CameraTrackerSettings,
	type CameraTrackerStale,
	type SolveCamera,
} from "../types";
import {
	analysisSourceTimes,
	analysisTiming,
	CAMERA_ANALYSIS_PROFILES,
	PROGRESS_INTERVAL_MS,
	trackFeatures,
	type AnalysisResult,
	type AnalysisTiming,
} from "./analysis";
import { planTrackedLayers } from "./create-layers";
import { decodedParts } from "./decoded-cache";
import { analysisFrameAt } from "./frame-time";
import {
	CAMERA_TRACKER_LOAD_LIMITS,
	normalizeCameraTracker,
	sanitizeSettingsPatch,
	tracksFitLoadLimits,
} from "./normalize";
import { findVideoClip, maxStale } from "./tracker-tracks";

export { analysisFrameAt } from "./frame-time";

/** What the user is told, in the app's language. */
export const CAMERA_TRACKER_MESSAGES = {
	notVideo: "Track Camera works on video clips.",
	clipMissing: "This clip is no longer in the timeline.",
	mediaMissing: "The video file of this clip is not loaded.",
	busy: "Track Camera is already running. Wait for it to finish or cancel it.",
	tooShort: CAMERA_SOLVE_MESSAGES["too-short"],
	// the frame limit is only one of two: the sample limit usually binds first, so long or detailed clips can still be too large
	tooLong: `This clip is too long to track the camera (at most ${CAMERA_TRACKER_LOAD_LIMITS.frameCount} frames). Long clips, or Detailed Analysis, can also be too large to save: trim the clip to a few minutes and try again.`,
	tooLarge: "The analysis found too many feature points to save in the project. Trim the clip or use the Normal analysis (Detailed Analysis off) and try again.",
	clipChanged: "The clip changed while its camera was being tracked. Track it again.",
	noAnalysis: "Track the camera of this clip first.",
	decodeFailed: "The video could not be read.",
	frameTooSmall: "This video is too small to track the camera.",
	solverFailed: CAMERA_SOLVE_MESSAGES.diverged,
	saveFailed: "The camera track could not be saved.",
} as const;

export interface CameraTrackerScene {
	tracks: SceneTracks;
	canvasSize: { width: number; height: number };
	playhead: MediaTime;
}

export interface CameraTrackerMedia {
	file: File | null;
	type: MediaType;
	name: string;
	width?: number;
	height?: number;
	fps?: number;
}

/** The project writes, each one undo step (`TimelineManager` fits). */
export interface CameraTrackerWriter {
	setCameraTracker(args: { elementId: string; data: CameraTrackerData | null }): void;
	deleteTrackPoints(args: { elementId: string; trackIds: readonly number[] }): boolean;
	setGroundPlane(args: { elementId: string; target: Target; frame: number }): void;
	createTrackedLayers(args: {
		layers: readonly CreateTimelineElement[];
		camera: CreateCameraElement | null;
	}): { elementIds: string[]; cameraElementId: string | null };
}

/** Everything the engine needs from the editor and the browser, so it runs without either. */
export interface CameraTrackerEngineDeps {
	/** The active scene, or `null` when no project is open. */
	readScene(): CameraTrackerScene | null;
	media(args: { mediaId: string }): CameraTrackerMedia | null;
	pause(): void;
	/** Gray frames of `file` at the source times, at most `maxWidth` wide (`decodeGrayFrames`). */
	decode(args: { file: File; sourceTimes: number[]; signal: AbortSignal; maxWidth: number }): AsyncIterable<GrayFrame>;
	solveCamera: SolveCamera;
	yieldToUi(): Promise<void>;
	now(): number;
	/** A text layer's local content size (its measured layout at 2D scale 1). */
	measureText(args: {
		element: CreateTextElement;
		canvasSize: { width: number; height: number };
	}): { width: number; height: number } | null;
	writer: CameraTrackerWriter;
}

export interface CameraTrackerEngine extends CameraTrackerApi {
	/** Is an analysis or solve in flight? */
	readonly running: boolean;
	/**
	 * Drops session state (settings chosen before a first track, kept
	 * analyses, outcomes) of clips that are gone (`mediaIdOf` gives `null`)
	 * or now play other media.
	 */
	prune(args: { mediaIdOf: (elementId: string) => string | null }): void;
	/** Forgets all session state (another project was opened). */
	clearSession(): void;
	/** The editor session is over: stops the run, writes nothing more, leaves the phase idle. */
	dispose(): void;
}

/** An analysis made this session whose solve did not get written (failed or cancelled). */
interface SessionAnalysis {
	mediaId: string;
	detailed: boolean;
	sourceStart: number;
	fps: number;
	frameWidth: number;
	frameHeight: number;
	tracks: FeatureTracks;
}

type SolveSource =
	| { kind: "stored"; data: CameraTrackerData; tracks: FeatureTracks }
	| { kind: "session"; analysis: SessionAnalysis };

interface Job {
	elementId: string;
	mediaId: string;
	signal: AbortSignal;
	clipChanged: boolean;
	abortForClip(): void;
}

const IDLE: CameraTrackerPhase = { phase: "idle" };

const SETTING_KEYS = Object.keys(DEFAULT_CAMERA_TRACKER_SETTINGS).filter(
	(key): key is keyof CameraTrackerSettings => key in DEFAULT_CAMERA_TRACKER_SETTINGS,
);

function failed({ elementId, message }: { elementId: string; message: string }): CameraTrackerRunOutcome {
	return { status: "failed", elementId, message };
}

function errorMessage(error: unknown): string | undefined {
	return error instanceof Error && error.message ? error.message : undefined;
}

/** Does the analysis (frames from `sourceStart` at `fps`) cover the clip's analysis frames now? */
function covers({
	sourceStart,
	fps,
	frameCount,
	timing,
}: {
	sourceStart: number;
	fps: number;
	frameCount: number;
	timing: AnalysisTiming;
}): boolean {
	const slack = 0.5 / Math.max(fps, timing.fps);
	return (
		sourceStart <= timing.sourceStart + slack &&
		sourceStart + frameCount / fps >= timing.sourceStart + timing.frameCount / timing.fps - slack
	);
}

function sameIds({ a, b }: { a: readonly number[]; b: readonly number[] }): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

function solveSettingsChanged({ a, b }: { a: CameraTrackerSettings; b: CameraTrackerSettings }): boolean {
	return SOLVE_SETTING_KEYS.some((key) => a[key] !== b[key]);
}

function analysisSettingsChanged({ a, b }: { a: CameraTrackerSettings; b: CameraTrackerSettings }): boolean {
	return ANALYSIS_SETTING_KEYS.some((key) => a[key] !== b[key]);
}

/**
 * The Track Camera engine (`CameraTrackerApi`): analysis (feature tracks
 * over the clip's visible source range), the injected solver, and the
 * project writes (one undo step each through `deps.writer`). One job at a
 * time; playback paused when a job starts; Cancel / Esc stop it; the clip
 * deleted or given other media stops it; failed and cancelled runs write
 * nothing (a failure is recorded in the session outcome). Phases and
 * outcomes go to `useCameraTrackerSession`.
 */
export function createCameraTrackerEngine({ deps }: { deps: CameraTrackerEngineDeps }): CameraTrackerEngine {
	const session = () => useCameraTrackerSession.getState();
	let activeRun: AbortController | null = null;
	let disposed = false;
	const sessionAnalyses = new Map<string, SessionAnalysis>();
	const pendingSettings = new Map<string, { mediaId: string; settings: CameraTrackerSettings }>();
	const decodedByData = new WeakMap<CameraTrackerData, Map<string, DecodedCameraTracker>>();

	function publishPhase(phase: CameraTrackerPhase): void {
		if (!disposed) session().setPhase(phase);
	}

	function clipNow({ elementId }: { elementId: string }): VideoElement | null {
		const scene = deps.readScene();
		return scene ? (findVideoClip({ tracks: scene.tracks, elementId })?.element ?? null) : null;
	}

	function clipPresent({ elementId, mediaId }: { elementId: string; mediaId: string }): boolean {
		return clipNow({ elementId })?.mediaId === mediaId;
	}

	/** Records the outcome for the banner, while the clip is there to show it on. */
	function finish(outcome: CameraTrackerRunOutcome): CameraTrackerRunOutcome {
		const scene = deps.readScene();
		const exists = !!scene && findVideoClip({ tracks: scene.tracks, elementId: outcome.elementId }) !== null;
		if (!disposed && outcome.status !== "busy" && exists) session().recordOutcome(outcome);
		return outcome;
	}

	function settingsFor({ clip }: { clip: VideoElement }): CameraTrackerSettings {
		if (clip.cameraTracker) return clip.cameraTracker.settings;
		const pending = pendingSettings.get(clip.id);
		return pending && pending.mediaId === clip.mediaId ? pending.settings : DEFAULT_CAMERA_TRACKER_SETTINGS;
	}

	type Prepared = { status: "ready"; scene: CameraTrackerScene; clip: VideoElement } | { status: "failed"; message: string };

	function prepare({ elementId }: { elementId: string }): Prepared {
		const scene = deps.readScene();
		if (!scene) return { status: "failed", message: CAMERA_TRACKER_NOT_READY_MESSAGE };
		const found = findVideoClip({ tracks: scene.tracks, elementId });
		if (found) return { status: "ready", scene, clip: found.element };
		const other = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].some((track) =>
			track.elements.some((element) => element.id === elementId),
		);
		return { status: "failed", message: other ? CAMERA_TRACKER_MESSAGES.notVideo : CAMERA_TRACKER_MESSAGES.clipMissing };
	}

	async function runJob({
		elementId,
		mediaId,
		work,
	}: {
		elementId: string;
		mediaId: string;
		work: (job: Job) => Promise<CameraTrackerRunOutcome>;
	}): Promise<CameraTrackerRunOutcome> {
		const controller = new AbortController();
		activeRun = controller;
		// Esc empties the canceller list before calling it: stay registered until the
		// job is really over, so a second Esc is still taken as ours.
		let releaseCanceller = () => {};
		const cancel = () => {
			controller.abort();
			releaseCanceller = registerCanceller({ fn: cancel });
		};
		releaseCanceller = registerCanceller({ fn: cancel });
		const job: Job = {
			elementId,
			mediaId,
			signal: controller.signal,
			clipChanged: false,
			abortForClip: () => {
				job.clipChanged = true;
				controller.abort();
			},
		};
		// everything is inside the try: whatever throws, the job ends idle and Esc is released
		try {
			deps.pause();
			return finish(await work(job));
		} catch (error) {
			return finish(failed({ elementId, message: errorMessage(error) ?? CAMERA_TRACKER_MESSAGES.solverFailed }));
		} finally {
			releaseCanceller();
			if (activeRun === controller) activeRun = null;
			publishPhase(IDLE);
		}
	}

	function checkClip(job: Job): void {
		if (!clipPresent(job)) job.abortForClip();
	}

	/** Why a finished step does not count: the session ended, the clip changed, or a stop. */
	function interrupted(job: Job): CameraTrackerRunOutcome | null {
		if (disposed) return { status: "cancelled", elementId: job.elementId };
		if (job.clipChanged || !clipPresent(job)) {
			return failed({ elementId: job.elementId, message: CAMERA_TRACKER_MESSAGES.clipChanged });
		}
		if (job.signal.aborted) return { status: "cancelled", elementId: job.elementId };
		return null;
	}

	function analysisFailureMessage(result: Extract<AnalysisResult, { status: "failed" }>): string {
		switch (result.reason) {
			case "frame-too-small":
				return CAMERA_TRACKER_MESSAGES.frameTooSmall;
			case "no-frames":
				return CAMERA_TRACKER_MESSAGES.tooShort;
			case "decode-failed":
				return result.message ?? CAMERA_TRACKER_MESSAGES.decodeFailed;
		}
	}

	/** The data to write for a solve; `null` when the stored analysis was replaced meanwhile. */
	function dataToWrite({
		job,
		source,
		usedSettings,
		solve,
	}: {
		job: Job;
		source: SolveSource;
		usedSettings: CameraTrackerSettings;
		solve: CameraSolve;
	}): CameraTrackerData | null {
		const clip = clipNow(job);
		if (!clip) return null;
		const current = clip.cameraTracker;
		if (source.kind === "stored") {
			if (!current || current.tracks !== source.data.tracks || current.mediaId !== source.data.mediaId) return null;
			const changed =
				solveSettingsChanged({ a: current.settings, b: usedSettings }) ||
				!sameIds({ a: current.deletedTrackIds, b: source.data.deletedTrackIds });
			const stale: CameraTrackerStale = current.stale === "analysis" ? "analysis" : changed ? "solve" : "none";
			return { ...current, solve: packSolve(solve), failure: null, stale, groundPlaneSet: false };
		}
		const { analysis } = source;
		const settings = settingsFor({ clip });
		const stale: CameraTrackerStale =
			settings.detailedAnalysis !== analysis.detailed || analysisSettingsChanged({ a: settings, b: usedSettings })
				? "analysis"
				: solveSettingsChanged({ a: settings, b: usedSettings })
					? "solve"
					: "none";
		return {
			version: 1,
			settings,
			mediaId: analysis.mediaId,
			sourceStart: analysis.sourceStart,
			frameWidth: analysis.frameWidth,
			frameHeight: analysis.frameHeight,
			tracks: packTracks(analysis.tracks),
			deletedTrackIds: [],
			solve: packSolve(solve),
			failure: null,
			stale,
			groundPlaneSet: false,
		};
	}

	async function solveAndWrite({
		job,
		source,
		settings,
	}: {
		job: Job;
		source: SolveSource;
		settings: CameraTrackerSettings;
	}): Promise<CameraTrackerRunOutcome> {
		const { elementId } = job;
		publishPhase({ phase: "solving", elementId, progress: 0 });
		const input =
			source.kind === "stored"
				? {
						tracks: source.tracks,
						frameWidth: source.data.frameWidth,
						frameHeight: source.data.frameHeight,
						excludedTrackIds: new Set(source.data.deletedTrackIds),
					}
				: {
						tracks: source.analysis.tracks,
						frameWidth: source.analysis.frameWidth,
						frameHeight: source.analysis.frameHeight,
					};
		let lastPublish = Number.NEGATIVE_INFINITY;
		let outcome: CameraSolveOutcome;
		try {
			outcome = await deps.solveCamera({
				input: {
					...input,
					settings: {
						shotType: settings.shotType,
						horizontalAngleOfViewDeg: settings.horizontalAngleOfViewDeg,
						solveMethod: settings.solveMethod,
					},
				},
				deps: { yieldToUi: deps.yieldToUi, now: deps.now },
				signal: job.signal,
				onProgress: (fraction) => {
					checkClip(job);
					const now = deps.now();
					if (now - lastPublish < PROGRESS_INTERVAL_MS) return;
					lastPublish = now;
					if (!job.signal.aborted && Number.isFinite(fraction)) {
						publishPhase({ phase: "solving", elementId, progress: Math.min(1, Math.max(0, fraction)) });
					}
				},
			});
		} catch {
			outcome = { status: "failed", reason: "diverged", message: CAMERA_TRACKER_MESSAGES.solverFailed };
		}
		const stop = interrupted(job);
		if (stop) return stop;
		if (outcome.status === "cancelled") return { status: "cancelled", elementId };
		if (outcome.status === "failed") return failed({ elementId, message: outcome.message });
		const data = dataToWrite({ job, source, usedSettings: settings, solve: outcome.solve });
		if (!data) return failed({ elementId, message: CAMERA_TRACKER_MESSAGES.clipChanged });
		// write only what a later load accepts (a solver result that does not fit its tracks is a failure)
		const checked = normalizeCameraTracker(data);
		if (!checked) return failed({ elementId, message: CAMERA_TRACKER_MESSAGES.solverFailed });
		try {
			deps.writer.setCameraTracker({ elementId, data: checked });
		} catch {
			return failed({ elementId, message: CAMERA_TRACKER_MESSAGES.saveFailed });
		}
		if (source.kind === "session") {
			sessionAnalyses.delete(elementId);
			pendingSettings.delete(elementId);
		}
		return { status: "solved", elementId };
	}

	async function analyzeAndSolve({
		job,
		file,
		media,
		timing,
		settings,
	}: {
		job: Job;
		file: File;
		media: CameraTrackerMedia;
		timing: AnalysisTiming;
		settings: CameraTrackerSettings;
	}): Promise<CameraTrackerRunOutcome> {
		const { elementId } = job;
		publishPhase({ phase: "analyzing", elementId, progress: 0 });
		const profile = settings.detailedAnalysis ? CAMERA_ANALYSIS_PROFILES.detailed : CAMERA_ANALYSIS_PROFILES.normal;
		let result: AnalysisResult;
		try {
			result = await trackFeatures({
				frames: deps.decode({
					file,
					sourceTimes: analysisSourceTimes({ timing }),
					signal: job.signal,
					maxWidth: profile.width,
				}),
				fps: timing.fps,
				frameCount: timing.frameCount,
				tracker: profile.tracker,
				signal: job.signal,
				deps: { yieldToUi: deps.yieldToUi, now: deps.now },
				onProgress: (progress) => {
					if (!job.signal.aborted) publishPhase({ phase: "analyzing", elementId, progress });
				},
				onFrame: () => checkClip(job),
			});
		} catch (error) {
			result = { status: "failed", reason: "decode-failed", message: errorMessage(error) };
		}
		const stop = interrupted(job);
		if (stop) return stop;
		if (result.status === "cancelled") return { status: "cancelled", elementId };
		if (result.status === "failed") return failed({ elementId, message: analysisFailureMessage(result) });
		const { tracks } = result;
		// only what a later load accepts is written
		if (!tracksFitLoadLimits({ tracks })) {
			return failed({ elementId, message: CAMERA_TRACKER_MESSAGES.tooLarge });
		}
		// the picture size in frame pixels; without one, the analysis frame's (same aspect)
		const known = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0;
		const pictureKnown = known(media.width) && known(media.height);
		const analysis: SessionAnalysis = {
			mediaId: job.mediaId,
			detailed: settings.detailedAnalysis,
			sourceStart: timing.sourceStart,
			fps: tracks.fps,
			frameWidth: pictureKnown && media.width ? media.width : tracks.w,
			frameHeight: pictureKnown && media.height ? media.height : tracks.h,
			tracks,
		};
		sessionAnalyses.set(elementId, analysis);
		return solveAndWrite({ job, source: { kind: "session", analysis }, settings });
	}

	function storedSource({ clip }: { clip: VideoElement }): Extract<SolveSource, { kind: "stored" }> | null {
		const data = clip.cameraTracker;
		if (!data || data.mediaId !== clip.mediaId) return null;
		const tracks = decodedParts({ data }).tracks;
		return tracks ? { kind: "stored", data, tracks } : null;
	}

	function sessionSource({ clip }: { clip: VideoElement }): Extract<SolveSource, { kind: "session" }> | null {
		const analysis = sessionAnalyses.get(clip.id);
		return analysis && analysis.mediaId === clip.mediaId ? { kind: "session", analysis } : null;
	}

	const api: CameraTrackerEngine = {
		get running() {
			return activeRun !== null;
		},

		async trackCamera({ elementId }) {
			if (activeRun) return { status: "busy", elementId, message: CAMERA_TRACKER_MESSAGES.busy };
			const prepared = prepare({ elementId });
			if (prepared.status === "failed") return finish(failed({ elementId, message: prepared.message }));
			const { clip } = prepared;
			const settings = settingsFor({ clip });
			const media = deps.media({ mediaId: clip.mediaId });
			const timing = analysisTiming({ clip, mediaFps: media?.fps });
			if (timing.frameCount < 1) return finish(failed({ elementId, message: CAMERA_TRACKER_MESSAGES.tooShort }));
			if (timing.frameCount > CAMERA_TRACKER_LOAD_LIMITS.frameCount) {
				return finish(failed({ elementId, message: CAMERA_TRACKER_MESSAGES.tooLong }));
			}
			const job = { elementId, mediaId: clip.mediaId };

			const stored = storedSource({ clip });
			if (
				stored &&
				stored.data.stale !== "analysis" &&
				covers({ sourceStart: stored.data.sourceStart, fps: stored.tracks.fps, frameCount: stored.tracks.frameCount, timing })
			) {
				// nothing changed since the last solve: solving again would only undo a Set Ground Plane
				if (stored.data.stale === "none" && stored.data.solve) return finish({ status: "solved", elementId });
				return runJob({ ...job, work: (run) => solveAndWrite({ job: run, source: stored, settings }) });
			}
			const kept = sessionSource({ clip });
			if (
				kept &&
				kept.analysis.detailed === settings.detailedAnalysis &&
				covers({ sourceStart: kept.analysis.sourceStart, fps: kept.analysis.fps, frameCount: kept.analysis.tracks.frameCount, timing })
			) {
				return runJob({ ...job, work: (run) => solveAndWrite({ job: run, source: kept, settings }) });
			}
			const file = media?.file;
			if (!media || !file) return finish(failed({ elementId, message: CAMERA_TRACKER_MESSAGES.mediaMissing }));
			return runJob({ ...job, work: (run) => analyzeAndSolve({ job: run, file, media, timing, settings }) });
		},

		async resolve({ elementId }) {
			if (activeRun) return { status: "busy", elementId, message: CAMERA_TRACKER_MESSAGES.busy };
			const prepared = prepare({ elementId });
			if (prepared.status === "failed") return finish(failed({ elementId, message: prepared.message }));
			const { clip } = prepared;
			const settings = settingsFor({ clip });
			const source = storedSource({ clip }) ?? sessionSource({ clip });
			if (!source) return finish(failed({ elementId, message: CAMERA_TRACKER_MESSAGES.noAnalysis }));
			return runJob({
				elementId,
				mediaId: clip.mediaId,
				work: (run) => solveAndWrite({ job: run, source, settings }),
			});
		},

		cancel() {
			activeRun?.abort();
		},

		updateSettings({ elementId, patch }) {
			const clip = clipNow({ elementId });
			if (!clip) return;
			const clean = sanitizeSettingsPatch(patch);
			if (Object.keys(clean).length === 0) return;
			const data = clip.cameraTracker;
			if (!data) {
				pendingSettings.set(elementId, { mediaId: clip.mediaId, settings: { ...settingsFor({ clip }), ...clean } });
				return;
			}
			const next: CameraTrackerSettings = { ...data.settings, ...clean };
			if (SETTING_KEYS.every((key) => next[key] === data.settings[key])) return;
			const stale = analysisSettingsChanged({ a: next, b: data.settings })
				? maxStale({ a: data.stale, b: "analysis" })
				: solveSettingsChanged({ a: next, b: data.settings })
					? maxStale({ a: data.stale, b: "solve" })
					: data.stale;
			try {
				deps.writer.setCameraTracker({ elementId, data: { ...data, settings: next, stale } });
			} catch {
				// the clip went away between the read and the write: nothing to change
			}
		},

		deletePoints({ elementId, trackIds }) {
			try {
				deps.writer.deleteTrackPoints({ elementId, trackIds });
			} catch {
				// nothing deleted: the clip or its data went away
			}
		},

		setGroundPlane({ elementId, target }) {
			const scene = deps.readScene();
			const clip = scene ? findVideoClip({ tracks: scene.tracks, elementId })?.element : undefined;
			const data = clip?.cameraTracker;
			if (!scene || !clip || !data?.solve) return;
			try {
				deps.writer.setGroundPlane({
					elementId,
					target,
					frame: analysisFrameAt({ clip, data, time: scene.playhead }),
				});
			} catch {
				// a degenerate target or an unreadable solve: nothing is changed
			}
		},

		createLayers(args): CreateTrackedLayersOutcome {
			const scene = deps.readScene();
			if (!scene) return { status: "failed", message: CAMERA_TRACKER_NOT_READY_MESSAGE };
			const clip = findVideoClip({ tracks: scene.tracks, elementId: args.elementId })?.element;
			if (!clip) return { status: "failed", message: CAMERA_TRACKER_MESSAGES.clipMissing };
			const data = clip.cameraTracker;
			if (!data) return { status: "failed", message: CAMERA_TRACKER_MESSAGES.noAnalysis };
			const parts = decodedParts({ data });
			const media = args.kind === "image" && args.mediaId ? deps.media({ mediaId: args.mediaId }) : null;
			const imageMedia = media && media.type === "image" && args.mediaId ? { id: args.mediaId, name: media.name } : null;
			const { width: canvasWidth, height: canvasHeight } = scene.canvasSize;
			const plan = planTrackedLayers({
				tracks: scene.tracks,
				clip,
				data,
				solve: parts.solve,
				featureTracks: parts.tracks,
				args,
				imageMedia,
				contentSize: ({ element }) => {
					if (element.type === "text") return deps.measureText({ element, canvasSize: scene.canvasSize });
					if (element.type === "graphic") {
						// graphics are a square source contain-fitted to the canvas (as the renderer draws them)
						const side = Math.min(canvasWidth, canvasHeight);
						return { width: side, height: side };
					}
					if (element.type === "image") {
						const width = media?.width ?? canvasWidth;
						const height = media?.height ?? canvasHeight;
						if (!(width > 0 && height > 0)) return null;
						const fit = Math.min(canvasWidth / width, canvasHeight / height);
						return { width: width * fit, height: height * fit };
					}
					return null;
				},
			});
			if (plan.status === "failed") return plan;
			try {
				const created = deps.writer.createTrackedLayers({ layers: plan.layers, camera: plan.camera });
				return { status: "created", elementIds: created.elementIds, cameraElementId: created.cameraElementId };
			} catch {
				return { status: "failed", message: CAMERA_TRACKER_MESSAGES.saveFailed };
			}
		},

		decoded({ elementId }) {
			const data = clipNow({ elementId })?.cameraTracker;
			if (!data) return null;
			let perClip = decodedByData.get(data);
			if (!perClip) {
				perClip = new Map();
				decodedByData.set(data, perClip);
			}
			const cached = perClip.get(elementId);
			if (cached) return cached;
			const parts = decodedParts({ data });
			if (!parts.tracks) return null;
			const decoded: DecodedCameraTracker = {
				elementId,
				data,
				tracks: parts.tracks,
				solve: parts.solve,
				deleted: parts.deleted,
			};
			perClip.set(elementId, decoded);
			return decoded;
		},

		prune({ mediaIdOf }) {
			for (const [elementId, entry] of sessionAnalyses) {
				if (mediaIdOf(elementId) !== entry.mediaId) sessionAnalyses.delete(elementId);
			}
			for (const [elementId, entry] of pendingSettings) {
				if (mediaIdOf(elementId) !== entry.mediaId) pendingSettings.delete(elementId);
			}
			if (disposed) return;
			for (const elementId of Object.keys(session().outcomes)) {
				if (mediaIdOf(elementId) === null) session().forget({ elementId });
			}
		},

		clearSession() {
			sessionAnalyses.clear();
			pendingSettings.clear();
			if (disposed) return;
			for (const elementId of Object.keys(session().outcomes)) session().forget({ elementId });
		},

		dispose() {
			disposed = true;
			activeRun?.abort();
			// the stopped run no longer reports: its phase is over now, not whenever it notices
			session().setPhase(IDLE);
		},
	};
	return api;
}
