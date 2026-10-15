/**
 * Preview-resolution frames: a frame can be drawn into a canvas smaller than
 * the video's display size (`scale` < 1, the preview while it plays or scrubs).
 * Scale 1 is the display size itself and what the exporter, the snapshot and a
 * paused preview ask for.
 */

/** The smallest scale a frame is drawn at (the floor of `rasterScaleBucket`). */
export const MIN_FRAME_SCALE = 1 / 16;

/**
 * A usable scale: in [MIN_FRAME_SCALE, 1]. Anything that is not a positive
 * number (NaN, 0, negative, infinite) means "not told": full size.
 */
export function normalizeScale(scale: number): number {
	if (!Number.isFinite(scale) || scale <= 0) return 1;
	return Math.min(1, Math.max(MIN_FRAME_SCALE, scale));
}

/** Pixel size of a frame of `width` x `height` drawn at `scale` (scale 1: exactly its size). */
export function scaledFrameSize({
	width,
	height,
	scale,
}: {
	width: number;
	height: number;
	scale: number;
}): { width: number; height: number } {
	const factor = normalizeScale(scale);
	if (factor === 1) return { width, height };
	return {
		width: Math.max(1, Math.round(width * factor)),
		height: Math.max(1, Math.round(height * factor)),
	};
}

/**
 * Whether a frame already drawn at `drawnScale` must be decoded and drawn again
 * for a request at `scale`. Only an exact request (tolerance 0: a paused
 * preview, a scrub, an export, a snapshot) waits for that. While the preview
 * plays, the smaller frame is shown and the next new frame is drawn at the new
 * scale: a new decoder from the key frame would stall the playback for a frame
 * that is on screen for one draw.
 */
export function needsLargerDraw({
	drawnScale,
	scale,
	maxStaleSeconds,
}: {
	drawnScale: number;
	scale: number;
	maxStaleSeconds: number;
}): boolean {
	return drawnScale < scale && !(maxStaleSeconds > 0);
}
