/**
 * How much smaller than the frame the blur background's backdrop texture can be.
 *
 * The backdrop is drawn into a 2D canvas, uploaded to the GPU, stretched over the
 * frame by the compositor (bilinear) and only then blurred, at frame resolution
 * and with the unchanged sigma. Uploading a frame-sized canvas for every video
 * frame is the slow part (70 ms for 1080x1920, against 8 ms for the 1920x1080
 * video frame itself), so for a strong blur the texture is drawn smaller.
 *
 * Drawing k times smaller and stretching back softens the picture by about
 * 0.4*k px (measured on a sharp edge, averaged over sub-pixel positions: bilinear
 * draw into the small canvas plus the bilinear stretch). The Gaussian blur adds
 * sigma^2 of variance, so the resample hides inside it when
 * (0.4*k)^2 <= 0.2 * sigma^2, that is k <= 1.12 * sigma. The weakest axis sets the
 * limit because the blur is not isotropic (sigma follows each axis' resolution).
 */
export const MAX_BACKDROP_DOWNSCALE = 8;
const DOWNSCALE_PER_SIGMA = 1.1;

export function backdropDownscale({
	sigmaX,
	sigmaY,
}: {
	sigmaX: number;
	sigmaY: number;
}): number {
	const weakest = Math.min(sigmaX, sigmaY);
	if (Number.isNaN(weakest)) {
		return 1;
	}
	return Math.min(
		MAX_BACKDROP_DOWNSCALE,
		Math.max(1, Math.floor(DOWNSCALE_PER_SIGMA * weakest)),
	);
}

/** Size of the backdrop texture for a frame; an unusable downscale means the frame size. */
export function backdropTextureSize({
	width,
	height,
	downscale,
}: {
	width: number;
	height: number;
	downscale: number;
}): { width: number; height: number } {
	const factor = Number.isFinite(downscale) && downscale >= 1 ? downscale : 1;
	return {
		width: Math.max(1, Math.ceil(width / factor)),
		height: Math.max(1, Math.ceil(height / factor)),
	};
}
