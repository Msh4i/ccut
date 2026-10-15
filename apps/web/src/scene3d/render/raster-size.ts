/**
 * Size of the LOCAL texture a 3D layer whose content the renderer draws
 * itself (text) is rasterised into. It follows the layer's size on screen,
 * rounded up to half-octave buckets, so the layer is re-rasterised only when
 * its on-screen size crosses a bucket (not every frame while it moves), and
 * the texture is never more than ~1.41x the on-screen size (bilinear
 * sampling without mipmaps stays alias-free).
 */

/** Largest side of a local layer texture (WebGL2 guarantees 4096 at least on desktop GPUs). */
export const MAX_LAYER_TEXTURE_SIZE = 4096;

/** Raster scale limits (content units -> texture pixels). */
export const MIN_RASTER_SCALE = 1 / 16;
export const MAX_RASTER_SCALE = 8;

/**
 * `pixelScale` (canvas pixels per content unit on screen, `null` when
 * unbounded) rounded up to the next power of sqrt(2), within the limits.
 */
export function rasterScaleBucket(pixelScale: number | null): number {
	if (pixelScale === null || !Number.isFinite(pixelScale)) return MAX_RASTER_SCALE;
	if (!(pixelScale > MIN_RASTER_SCALE)) return MIN_RASTER_SCALE;
	// The tolerance keeps an exact power (1, sqrt 2, 2, ...) in its own bucket.
	const steps = Math.ceil(2 * Math.log2(pixelScale) - 1e-9);
	return Math.min(MAX_RASTER_SCALE, Math.max(MIN_RASTER_SCALE, 2 ** (steps / 2)));
}

/** Texture size for content of `contentWidth` x `contentHeight` units shown at `pixelScale`. */
export function localRasterSize({
	contentWidth,
	contentHeight,
	pixelScale,
}: {
	contentWidth: number;
	contentHeight: number;
	pixelScale: number | null;
}): { width: number; height: number } {
	const largest = Math.max(contentWidth, contentHeight);
	const scale = Math.min(
		rasterScaleBucket(pixelScale),
		largest > 0 ? MAX_LAYER_TEXTURE_SIZE / largest : MAX_RASTER_SCALE,
	);
	return {
		width: Math.max(1, Math.min(MAX_LAYER_TEXTURE_SIZE, Math.ceil(contentWidth * scale))),
		height: Math.max(1, Math.min(MAX_LAYER_TEXTURE_SIZE, Math.ceil(contentHeight * scale))),
	};
}
