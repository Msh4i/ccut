/**
 * Pure decisions of the video frame cache (see `frame-stream.ts`).
 *
 * Times are in seconds of the media. A "frame" here is anything with a start
 * timestamp and a duration.
 */

export type TimedFrame = {
	timestamp: number;
	duration: number;
};

/**
 * How far the running decoder may be pushed forward instead of being
 * restarted from a key frame.
 */
export type DecoderLimits = {
	/** Forward jumps up to this long always keep the running decoder. */
	alwaysAdvanceSeconds: number;
	/** Forward jumps longer than this always restart it (the bound). */
	maxAdvanceSeconds: number;
	/**
	 * What a restart costs on top of decoding from its key frame (a new
	 * decoder, its first-output latency), in seconds of video to decode.
	 * A heuristic, not a measurement.
	 */
	restartCostSeconds: number;
};

export const DEFAULT_DECODER_LIMITS: DecoderLimits = {
	alwaysAdvanceSeconds: 0.5,
	maxAdvanceSeconds: 3,
	restartCostSeconds: 0.25,
};

/**
 * Read-ahead of decoded frames, in seconds of video, when no memory budget
 * sets it (the cache passes the mode's seconds: 0.25 balanced, 0.5 high).
 */
export const READ_AHEAD_SECONDS = 0.25;
/**
 * Bounds of the read-ahead in frames: decoded frames hold decoder memory.
 *
 * The upper bound is a HARD cap, whatever the memory budget allows: a
 * hardware decoder (VA-API on the owner's Intel iGPU) owns a fixed pool of
 * output surfaces, and every decoded frame held here keeps one of them, on
 * top of the up to 8 that mediabunny's VideoSampleSink queues itself
 * (`computeMaxQueueSize` in mediabunny's media-sink.ts). Holding more would
 * not deadlock (a request closes the frames before its time first), but it
 * would stall the decoder. The pool size of Chromium's VA-API decoder is NOT
 * verified; raise this only after the owner's HUD shows no extra waits with
 * hardware decode (docs/ccut/playback-proposals.md 1.3).
 */
export const READ_AHEAD_MIN_FRAMES = 2;
export const READ_AHEAD_MAX_FRAMES = 8;

/**
 * Decoded frames mediabunny's `VideoSampleSink` lets one decoder hold before
 * the stream takes them: decoded samples plus the decode queue are capped at
 * 8 while decoded samples wait (`computeMaxQueueSize`,
 * node_modules/mediabunny/src/media-sink.ts, mediabunny 1.41.0). The cache
 * counts this much for every running decoder.
 */
export const DECODER_QUEUE_FRAMES = 8;

const FALLBACK_FRAME_DURATION = 1 / 30;

export function readAheadFrameCount({
	seconds,
	frameDuration,
	min,
	max,
}: {
	seconds: number;
	frameDuration: number;
	min: number;
	max: number;
}): number {
	const duration =
		Number.isFinite(frameDuration) && frameDuration > 0
			? frameDuration
			: FALLBACK_FRAME_DURATION;
	// The epsilon keeps 0.25 s at 30 fps (7.5000000001 frames) at 8, not 9.
	const frames = Math.ceil(seconds / duration - 1e-9);
	return Math.min(max, Math.max(min, frames));
}

/**
 * Whether `frame` is the one to show at `time`: its own span, or the gap up to
 * the next frame when that one starts later (variable frame rate, rounding).
 */
export function frameCovers({
	frame,
	time,
	nextTimestamp,
}: {
	frame: TimedFrame;
	time: number;
	nextTimestamp: number | undefined;
}): boolean {
	if (time < frame.timestamp) return false;
	if (time < frame.timestamp + frame.duration) return true;
	return nextTimestamp !== undefined && time < nextTimestamp;
}

/** How long ago `frame` should have been replaced, at `time` (0 while it is current). */
export function frameStaleness({
	frame,
	time,
}: {
	frame: TimedFrame;
	time: number;
}): number {
	return Math.max(0, time - (frame.timestamp + frame.duration));
}

/**
 * First step of the forward-jump decision. `frontier` is the timestamp of the
 * newest frame the running decoder has delivered (or where it was started).
 */
export function planForwardJump({
	target,
	frontier,
	limits,
}: {
	target: number;
	frontier: number;
	limits: DecoderLimits;
}): "advance" | "restart" | "ask-keyframe" {
	const gap = target - frontier;
	if (gap <= limits.alwaysAdvanceSeconds) return "advance";
	if (gap > limits.maxAdvanceSeconds) return "restart";
	return "ask-keyframe";
}

/**
 * Second step: advancing decodes `target - frontier` of video, a restart
 * decodes `target - keyframe` plus its start-up cost. The cheaper one wins.
 */
export function chooseWithKeyframe({
	target,
	frontier,
	keyframe,
	limits,
}: {
	target: number;
	frontier: number;
	keyframe: number | null;
	limits: DecoderLimits;
}): "advance" | "restart" {
	if (keyframe === null) return "advance";
	const advanceCost = target - frontier;
	const restartCost = target - keyframe + limits.restartCostSeconds;
	return restartCost < advanceCost ? "restart" : "advance";
}
