import { clampRetimeRate } from "@/retime/rate";
import type { VideoElement } from "@/timeline";
import { FeatureTracker, type TrackerOptions } from "@/tracking/camera/tracker";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { GrayFrame } from "@/tracking/types";
import {
	DETAILED_ANALYSIS_PROFILE,
	NORMAL_ANALYSIS_PROFILE,
} from "@/tracking/camera3d/solver/analysis-profile";
import { mediaTimeToSeconds } from "@/wasm";

/**
 * Step 1 of Track Camera: follow corner features through the clip's
 * visible source range, sampled at UNIFORM source times (frame i at
 * `sourceStart + i / fps`), so the solve is indexed by source time whatever
 * the clip's trim and speed.
 */

export interface AnalysisProfile {
	/** Widest analysis frame asked of the decoder (px). */
	width: number;
	/** Tracker options laid over its defaults. */
	tracker: Partial<TrackerOptions>;
}

/**
 * Normal and Detailed Analysis, taken from the solver's recommended profile
 * (`solver/analysis-profile.ts`: provisional, partly measured).
 */
export const CAMERA_ANALYSIS_PROFILES: Readonly<Record<"normal" | "detailed", AnalysisProfile>> = {
	normal: {
		width: NORMAL_ANALYSIS_PROFILE.analysisWidth,
		tracker: NORMAL_ANALYSIS_PROFILE.trackerOptions,
	},
	detailed: {
		width: DETAILED_ANALYSIS_PROFILE.analysisWidth,
		tracker: DETAILED_ANALYSIS_PROFILE.trackerOptions,
	},
};

/** The analysis never samples faster than this. */
export const MAX_ANALYSIS_FPS = 30;
/** Rate used when the media does not say its own. */
export const FALLBACK_MEDIA_FPS = 30;
/** Progress is published this often at most. */
export const PROGRESS_INTERVAL_MS = 100;

export interface AnalysisTiming {
	/** Source-media second of analysis frame 0 (the clip's trim start). */
	sourceStart: number;
	fps: number;
	frameCount: number;
}

/**
 * The analysis frames of the clip as it plays now: its visible source range
 * (trim start .. trim start + duration x speed) at min(media fps, 30).
 */
export function analysisTiming({
	clip,
	mediaFps,
}: {
	clip: Pick<VideoElement, "trimStart" | "duration" | "retime">;
	mediaFps: number | undefined;
}): AnalysisTiming {
	const fps = Math.min(
		typeof mediaFps === "number" && Number.isFinite(mediaFps) && mediaFps > 0 ? mediaFps : FALLBACK_MEDIA_FPS,
		MAX_ANALYSIS_FPS,
	);
	const span = mediaTimeToSeconds({ time: clip.duration }) * clampRetimeRate({ rate: clip.retime?.rate ?? 1 });
	return {
		sourceStart: mediaTimeToSeconds({ time: clip.trimStart }),
		fps,
		frameCount: span > 0 ? Math.ceil(span * fps - 1e-9) : 0,
	};
}

/** Source second of every analysis frame. */
export function analysisSourceTimes({ timing }: { timing: AnalysisTiming }): number[] {
	return Array.from({ length: timing.frameCount }, (_, i) => timing.sourceStart + i / timing.fps);
}

export type AnalysisResult =
	| { status: "complete"; tracks: FeatureTracks }
	| { status: "cancelled" }
	| { status: "failed"; reason: "decode-failed" | "no-frames" | "frame-too-small"; message?: string };

const STOPPED = Symbol("analysis-stopped");

/** The decoder's next frame, or STOPPED as soon as `signal` aborts (a decoder that never answers cannot hold the job). */
async function nextOrStop({
	iterator,
	signal,
}: {
	iterator: AsyncIterator<GrayFrame>;
	signal: AbortSignal;
}): Promise<IteratorResult<GrayFrame> | typeof STOPPED> {
	if (signal.aborted) return STOPPED;
	let onAbort = () => {};
	const stopped = new Promise<typeof STOPPED>((resolve) => {
		onAbort = () => resolve(STOPPED);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([iterator.next(), stopped]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Best-effort release of a decoder that did not run dry; nobody waits for it. */
async function stopDecoder({ iterator }: { iterator: AsyncIterator<GrayFrame> }): Promise<void> {
	try {
		await iterator.return?.();
	} catch {
		// it was stopped; the run is over either way
	}
}

/**
 * Tracks features through `frames` (gray, all the same size), yielding to
 * the UI after every frame and reporting progress (0..1 of `frameCount`) at
 * most every {@link PROGRESS_INTERVAL_MS}. `onFrame` runs after every frame
 * (the caller checks its clip there and may abort); `signal` stops the run
 * between frames and while the decoder is silent. A stop drops everything
 * tracked.
 */
export async function trackFeatures({
	frames,
	fps,
	frameCount,
	tracker,
	signal,
	deps,
	onProgress,
	onFrame,
}: {
	frames: AsyncIterable<GrayFrame>;
	fps: number;
	frameCount: number;
	tracker: Partial<TrackerOptions>;
	signal: AbortSignal;
	deps: { yieldToUi: () => Promise<void>; now: () => number };
	onProgress?: (fraction: number) => void;
	onFrame?: () => void;
}): Promise<AnalysisResult> {
	if (signal.aborted) return { status: "cancelled" };
	let iterator: AsyncIterator<GrayFrame> | null = null;
	let featureTracker: FeatureTracker | null = null;
	let index = 0;
	let lastPublish = Number.NEGATIVE_INFINITY;
	let drained = false;
	try {
		iterator = frames[Symbol.asyncIterator]();
		for (;;) {
			const step = await nextOrStop({ iterator, signal });
			if (step === STOPPED || signal.aborted) return { status: "cancelled" };
			if (step.done) {
				drained = true;
				break;
			}
			const frame = step.value;
			if (!featureTracker) {
				try {
					featureTracker = new FeatureTracker({ w: frame.w, h: frame.h, fps, options: tracker });
				} catch (error) {
					if (error instanceof RangeError) return { status: "failed", reason: "frame-too-small" };
					throw error;
				}
			}
			featureTracker.push(frame);
			index++;
			onFrame?.();
			if (signal.aborted) return { status: "cancelled" };
			const now = deps.now();
			if (index === frameCount || now - lastPublish >= PROGRESS_INTERVAL_MS) {
				lastPublish = now;
				onProgress?.(Math.min(1, index / Math.max(1, frameCount)));
			}
			await deps.yieldToUi();
			if (signal.aborted) return { status: "cancelled" };
		}
	} catch (error) {
		if (signal.aborted) return { status: "cancelled" };
		return {
			status: "failed",
			reason: "decode-failed",
			message: error instanceof Error && error.message ? error.message : undefined,
		};
	} finally {
		if (iterator && !drained) void stopDecoder({ iterator });
	}
	if (!featureTracker) return { status: "failed", reason: "no-frames" };
	return { status: "complete", tracks: featureTracker.finish() };
}
