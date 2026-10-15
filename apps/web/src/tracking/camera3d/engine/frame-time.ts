import { clampRetimeRate } from "@/retime/rate";
import type { VideoElement } from "@/timeline";
import { mediaTimeToSeconds, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import type { CameraTrackerData } from "../types";

/**
 * Analysis frames sample SOURCE time: frame i is at
 * `data.sourceStart + i / data.tracks.fps` seconds of the media. These map
 * between that and the timeline through the clip's trim and speed.
 */

type ClipTiming = Pick<VideoElement, "startTime" | "trimStart" | "retime">;

function rateOf(clip: ClipTiming): number {
	return clampRetimeRate({ rate: clip.retime?.rate ?? 1 });
}

/** The (fractional, unclamped) analysis frame shown at timeline time `time`. */
export function analysisFrameAt({
	clip,
	data,
	time,
}: {
	clip: ClipTiming;
	data: Pick<CameraTrackerData, "sourceStart" | "tracks">;
	time: MediaTime;
}): number {
	const clipSeconds = mediaTimeToSeconds({ time }) - mediaTimeToSeconds({ time: clip.startTime });
	const sourceSeconds = mediaTimeToSeconds({ time: clip.trimStart }) + clipSeconds * rateOf(clip);
	return (sourceSeconds - data.sourceStart) * data.tracks.fps;
}

/** The timeline time (ticks, fractional) at which analysis frame `frame` is shown. */
export function timelineTicksOfFrame({
	clip,
	data,
	frame,
}: {
	clip: ClipTiming;
	data: Pick<CameraTrackerData, "sourceStart" | "tracks">;
	frame: number;
}): number {
	const sourceSeconds = data.sourceStart + frame / data.tracks.fps;
	const clipSeconds = (sourceSeconds - mediaTimeToSeconds({ time: clip.trimStart })) / rateOf(clip);
	return clip.startTime + clipSeconds * TICKS_PER_SECOND;
}
