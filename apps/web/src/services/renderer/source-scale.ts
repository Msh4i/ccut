import { rasterScaleBucket } from "@/scene3d/render/raster-size";

/**
 * Preview-resolution video frames (see `services/video-cache/frame-scale.ts`).
 *
 * While the preview plays or scrubs, a decoded frame is drawn and uploaded at
 * about the pixels it covers on screen instead of its full size. Everything
 * here is pure and answers with a SCALE: a share of the video's display size,
 * 1 meaning full size, which is what a paused preview, the exporter, the
 * snapshot and the thumbnails always use.
 *
 * `density` is the scene's device pixels per scene pixel (null: full size).
 */

/**
 * The preview's density: the scene's width on screen (CSS px) times the device
 * pixel ratio, over the scene's own width. Null (full size) when paused or when
 * any input is unusable.
 */
export function previewSourceDensity({
	isPlaying,
	isScrubbing,
	sceneCssWidth,
	canvasWidth,
	devicePixelRatio,
}: {
	isPlaying: boolean;
	isScrubbing: boolean;
	sceneCssWidth: number;
	canvasWidth: number;
	devicePixelRatio: number;
}): number | null {
	if (!isPlaying && !isScrubbing) return null;
	return usableDensity((sceneCssWidth / canvasWidth) * devicePixelRatio);
}

function usableDensity(density: number | null): number | null {
	return density !== null && Number.isFinite(density) && density > 0 ? density : null;
}

/**
 * Scale for a layer's video frame: the larger of the quad's per-side ratios to
 * the source, times the density, rounded up to the next power of sqrt(2)
 * (`rasterScaleBucket`: a drag or an animation does not change the frame size
 * every frame, and the frame is at most sqrt 2 times larger per side than the
 * screen needs), never above 1. A zero-size quad is the smallest bucket;
 * anything unusable (density, NaN, an empty source) is 1.
 *
 * `quad*` is the layer's size in scene pixels (after its own transform), `source*`
 * the video's display size.
 */
export function layerSourceScale({
	quadWidth,
	quadHeight,
	sourceWidth,
	sourceHeight,
	density,
}: {
	quadWidth: number;
	quadHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	density: number | null;
}): number {
	const usable = usableDensity(density);
	if (usable === null) return 1;
	const needed =
		Math.max(quadWidth / sourceWidth, quadHeight / sourceHeight) * usable;
	return boundedScale(needed);
}

/**
 * Scale for the frame of a blur backdrop. The backdrop covers the whole scene
 * (cover fit: the source enlarged by `cover`) and is drawn `downscale` times
 * smaller into its texture, so the frame needs `cover / downscale` of its size
 * whatever the density; null density (paused, export) is full size.
 */
export function backdropSourceScale({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	downscale,
	density,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	downscale: number;
	density: number | null;
}): number {
	if (usableDensity(density) === null) return 1;
	const cover = Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
	const shrink = Number.isFinite(downscale) && downscale >= 1 ? downscale : 1;
	return boundedScale(cover / shrink);
}

function boundedScale(needed: number): number {
	// NaN or infinite (an empty source): nothing to go by, full size. A finite
	// zero (a layer scaled to 0 by a keyframe) shows no pixels: the smallest
	// bucket, not a full-size draw and upload of an invisible layer.
	if (!Number.isFinite(needed)) return 1;
	return Math.min(1, rasterScaleBucket(needed));
}

/**
 * The bucket a density falls into, for the preview's redraw decision: a
 * change of density across a bucket changes the size of the frames to draw.
 * Null (full size) is above every number.
 */
export function densityBucket(density: number | null): number {
	const usable = usableDensity(density);
	return usable === null ? Number.POSITIVE_INFINITY : rasterScaleBucket(usable);
}
