import { hostRate, trackedSourceStart, type HostTimingClip } from "@/tracking/host";
import { sampleCount, sourceTimes } from "@/tracking/sample-times";
import type { GrayFrame } from "@/tracking/types";
import { mediaTimeToSeconds } from "@/wasm";
import type { SourceWindow } from "./analysis-cache";
import { FeatureTracker } from "./tracker";
import type { CameraAnalysis } from "./types";

/** Progress is pushed to the UI this often at most, not per frame. */
export const PROGRESS_INTERVAL_MS = 100;
/** Plan decision 6: the analysis never samples faster than this. */
export const MAX_ANALYSIS_FPS = 30;

/** Frames per second the analysis reads: the project's rate, capped. */
export function analysisFps({ projectFps }: { projectFps: number }): number {
	return Math.min(projectFps, MAX_ANALYSIS_FPS);
}

/** A stretch of the timeline, in seconds. */
export interface TimelineWindow {
	start: number;
	end: number;
}

export type AnalysisErrorCode = "no-frames" | "decode-failed" | "frame-too-small";

/** What to tell the user, in the app's language, when the decoder gives no reason of its own. */
export const ANALYSIS_MESSAGES: Record<AnalysisErrorCode, string> = {
	"no-frames": "There is no frame of the video to analyse here.",
	"decode-failed": "The video could not be read.",
	"frame-too-small": "This video is too small to follow the scene in.",
};

export interface AnalysisFailure {
	status: "error";
	error: AnalysisErrorCode;
	message: string;
}

/**
 * A cancelled run has no analysis at all: whatever was tracked before the
 * stop is dropped, never cached and never stuck to.
 */
export type AnalysisOutcome =
	| { status: "complete"; analysis: CameraAnalysis }
	| { status: "cancelled" }
	| AnalysisFailure;

/** What the analysis needs from the outside, so it runs without a browser. */
export interface AnalysisDeps {
	/**
	 * Gray frames of `file` at the given source seconds, in order (`decodeGrayFrames`).
	 * `signal` aborts the analysis: a decoder that can stop what it waits on should, but
	 * the analysis does not depend on it, it stops waiting for the decoder on its own.
	 */
	decode: ({
		file,
		sourceTimes,
		signal,
	}: {
		file: File;
		sourceTimes: number[];
		signal: AbortSignal;
	}) => AsyncIterable<GrayFrame>;
	/** Milliseconds, for the progress throttle. */
	now: () => number;
	/** Lets the page paint between frames when the analysis runs on the main thread. */
	yieldToUi: () => Promise<void>;
	newId: () => string;
}

/** Where the window's frames start in the clip (seconds from its start) and how many there are. */
function windowFrames({
	host,
	window,
	fps,
}: {
	host: HostTimingClip;
	window: TimelineWindow;
	fps: number;
}): { clipStartSec: number; count: number } {
	const hostStartSec = mediaTimeToSeconds({ time: host.startTime });
	const clipStartSec = window.start - hostStartSec;
	const count =
		clipStartSec < 0
			? 0
			: sampleCount({ clipStartSec, clipDurationSec: window.end - hostStartSec, fps });
	return { clipStartSec, count };
}

/** The source seconds a timeline window of the host spans, as the clip plays it now. */
export function analysisSourceWindowOf({
	host,
	window,
}: {
	host: HostTimingClip;
	window: TimelineWindow;
}): SourceWindow {
	const hostStartSec = mediaTimeToSeconds({ time: host.startTime });
	return {
		start: trackedSourceStart({ host, clipStartSec: window.start - hostStartSec }),
		end: trackedSourceStart({ host, clipStartSec: window.end - hostStartSec }),
	};
}

function failure({ error, message }: { error: AnalysisErrorCode; message?: string }): AnalysisFailure {
	return { status: "error", error, message: message ?? ANALYSIS_MESSAGES[error] };
}

/** The message of an Error that has one; anything else gives none (callers fall back to their own). */
export function messageOf({ error }: { error: unknown }): string | undefined {
	return error instanceof Error && error.message ? error.message : undefined;
}

/** What a pull of the decoder comes to when the abort gets there first. */
const STOPPED = Symbol("analysis-stopped");

/**
 * The decoder's next step, or {@link STOPPED} as soon as `signal` aborts, whichever
 * comes first: a decoder that never answers (and never fails) cannot hold the
 * analysis, and with it the job, up. An already aborted signal pulls nothing.
 */
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

/**
 * Asks a decoder that did not run dry to let go of what it holds (a generator
 * runs its `finally`). Nobody waits for the answer: a decoder stuck on a read
 * queues the request behind it and may never answer, and one that rejects does
 * so because it was stopped. The run is over either way, so this is best-effort
 * and a rejection is dropped.
 */
async function stopDecoder({ iterator }: { iterator: AsyncIterator<GrayFrame> }): Promise<void> {
	try {
		await iterator.return?.();
	} catch {
		// best-effort teardown, see above
	}
}

/**
 * Analyses the frames of `host` inside `window` (timeline seconds): decodes
 * them small and gray at `analysisFps`, follows corner features through them
 * and packs the tracks into a {@link CameraAnalysis}. Progress comes at most
 * every {@link PROGRESS_INTERVAL_MS}; `signal` is honoured between frames and
 * also while the decoder is silent (the analysis stops waiting for it), and a
 * stop drops everything tracked so far. A decoder that gives up or a frame
 * too small to track are typed failures, nothing is thrown for them.
 */
export async function analyze({
	hostElementId,
	host,
	file,
	window,
	projectFps,
	signal,
	onProgress,
	deps,
}: {
	hostElementId: string;
	host: HostTimingClip;
	file: File;
	window: TimelineWindow;
	projectFps: number;
	signal: AbortSignal;
	onProgress?: ({ fraction }: { fraction: number }) => void;
	deps: AnalysisDeps;
}): Promise<AnalysisOutcome> {
	const fps = analysisFps({ projectFps });
	const { clipStartSec, count } = windowFrames({ host, window, fps });
	if (count < 1) return failure({ error: "no-frames" });
	if (signal.aborted) return { status: "cancelled" };

	const times = sourceTimes({
		clipStartSec,
		count,
		fps,
		trimStartSec: mediaTimeToSeconds({ time: host.trimStart }),
		retime: host.retime,
	});

	let iterator: AsyncIterator<GrayFrame> | null = null;
	let tracker: FeatureTracker | null = null;
	let index = 0;
	let lastPublish = deps.now();
	let drained = false;
	try {
		iterator = deps.decode({ file, sourceTimes: times, signal })[Symbol.asyncIterator]();
		for (;;) {
			const step = await nextOrStop({ iterator, signal });
			// the stop can also land between the decoder's answer and our reading it
			if (step === STOPPED || signal.aborted) return { status: "cancelled" };
			if (step.done) {
				drained = true;
				break;
			}
			const frame = step.value;
			if (!tracker) {
				try {
					tracker = new FeatureTracker({ w: frame.w, h: frame.h, fps });
				} catch (error) {
					if (error instanceof RangeError) return failure({ error: "frame-too-small" });
					throw error;
				}
			}
			tracker.push(frame);
			index++;
			const now = deps.now();
			if (now - lastPublish >= PROGRESS_INTERVAL_MS) {
				lastPublish = now;
				onProgress?.({ fraction: index / count });
			}
			await deps.yieldToUi();
		}
	} catch (error) {
		// a decoder that fails because it was stopped (its input disposed) did not fail the analysis
		if (signal.aborted) return { status: "cancelled" };
		return failure({ error: "decode-failed", message: messageOf({ error }) });
	} finally {
		// every way out but the decoder running dry leaves it suspended: let it release its input
		if (iterator && !drained) void stopDecoder({ iterator });
	}
	if (!tracker) return failure({ error: "no-frames" });

	return {
		status: "complete",
		analysis: {
			id: deps.newId(),
			hostElementId,
			mediaId: host.mediaId,
			sourceStart: trackedSourceStart({ host, clipStartSec }),
			rate0: hostRate({ host }),
			tracks: tracker.finish(),
			status: "complete",
		},
	};
}
