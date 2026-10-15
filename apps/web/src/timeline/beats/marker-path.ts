/** Below this average gap between ticks the clip is just a smear: draw none. */
export const BEAT_MARKER_MIN_SPACING_PX = 4;

export function isBeatMarkerSpacingTooDense({
	firstPx,
	lastPx,
	count,
}: {
	firstPx: number;
	lastPx: number;
	count: number;
}): boolean {
	return count > 1 && (lastPx - firstPx) / (count - 1) < BEAT_MARKER_MIN_SPACING_PX;
}

/** The ticks as one SVG path: whole pixels, so a 2 px stroke covers two columns. */
export function buildBeatTickPath({
	positions,
	top,
	bottom,
}: {
	positions: number[];
	top: number;
	bottom: number;
}): string | null {
	if (positions.length === 0) {
		return null;
	}
	return positions.map((x) => `M${Math.round(x)} ${top}V${bottom}`).join("");
}

/**
 * One SVG path of vertical ticks, or `null` when there is nothing to draw or the
 * beats are too dense to be anything but a smear.
 */
export function getBeatMarkerPath({
	positions,
	top,
	bottom,
}: {
	positions: number[];
	top: number;
	bottom: number;
}): string | null {
	if (positions.length === 0) {
		return null;
	}
	if (
		isBeatMarkerSpacingTooDense({
			firstPx: positions[0],
			lastPx: positions[positions.length - 1],
			count: positions.length,
		})
	) {
		return null;
	}

	return buildBeatTickPath({ positions, top, bottom });
}

/**
 * The beat tick closest to `x`, or `null` when none is within `radius` pixels.
 * Ticks are found by a plain scan, not a search that needs them ascending: a
 * click happens once, not once per frame.
 */
export function nearestBeatIndex({
	positions,
	x,
	radius,
}: {
	positions: readonly number[];
	x: number;
	radius: number;
}): number | null {
	let best: number | null = null;
	let bestDistance = radius;
	for (let i = 0; i < positions.length; i++) {
		const distance = Math.abs(Math.round(positions[i]) - x);
		if (distance <= bestDistance) {
			best = i;
			bestDistance = distance;
		}
	}
	return best;
}
