import type { TrackPointDisplay } from "../types";

/** A "+" marker at Track Point Size 100 %, screen pixels (the overlay keeps it zoom-independent). */
export const MARKER_BASE_PX = 10;

/** 3D Solved perspective hint: a marker is at most this much bigger or smaller than at the median depth. */
const DEPTH_HINT_RANGE = { min: 0.4, max: 2.5 } as const;
const SIZE_PERCENT_RANGE = { min: 1, max: 1000 } as const;

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Marker sizes (screen pixels) of the visible points, in their order. 2D
 * Source: all the same. 3D Solved: perspective size hinting, nearer = bigger
 * (`median depth / depth`, clamped), as AE does. Both scale with Track Point
 * Size (percent).
 */
export function markerSizes({
	depths,
	trackPointSize,
	display,
}: {
	depths: readonly (number | null)[];
	trackPointSize: number;
	display: TrackPointDisplay;
}): number[] {
	const percent = Number.isFinite(trackPointSize)
		? Math.min(SIZE_PERCENT_RANGE.max, Math.max(SIZE_PERCENT_RANGE.min, trackPointSize))
		: 100;
	const base = (MARKER_BASE_PX * percent) / 100;
	if (display === "2d-source") return depths.map(() => base);
	const known = depths.filter(
		(depth): depth is number => depth !== null && depth > 0 && Number.isFinite(depth),
	);
	if (known.length === 0) return depths.map(() => base);
	const reference = median(known);
	return depths.map((depth) => {
		if (depth === null || !(depth > 0) || !Number.isFinite(depth)) return base;
		const hint = Math.min(
			DEPTH_HINT_RANGE.max,
			Math.max(DEPTH_HINT_RANGE.min, reference / depth),
		);
		return base * hint;
	});
}

/** A stable hue (degrees) per track id, spread by the golden angle so neighbours differ. */
export function markerHue(trackId: number): number {
	const hue = (trackId * 137.50776405003785) % 360;
	return hue < 0 ? hue + 360 : hue;
}
