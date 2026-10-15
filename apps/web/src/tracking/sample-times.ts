import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime } from "@/retime/resolve";

/**
 * Timeline frames from `clipStartSec` up to, not including, the clip end, all
 * relative to the clip start.
 */
export function sampleCount({
	clipStartSec,
	clipDurationSec,
	fps,
}: {
	clipStartSec: number;
	clipDurationSec: number;
	fps: number;
}): number {
	const span = clipDurationSec - clipStartSec;
	return span > 0 ? Math.ceil(span * fps - 1e-9) : 0;
}

/** Where in the source media (seconds) each of the `count` timeline frames lands, retime included. */
export function sourceTimes({
	clipStartSec,
	count,
	fps,
	trimStartSec,
	retime,
}: {
	clipStartSec: number;
	count: number;
	fps: number;
	trimStartSec: number;
	retime?: RetimeConfig;
}): number[] {
	return Array.from(
		{ length: count },
		(_, i) =>
			trimStartSec +
			getSourceTimeAtClipTime({ clipTime: clipStartSec + i / fps, retime }),
	);
}
