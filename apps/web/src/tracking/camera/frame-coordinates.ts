/**
 * The pixel-centre rule of the camera tracker (see `types.ts`): a feature
 * position is a pixel index coordinate, the centre of pixel `i` is at `x = i`.
 * The unit square of the picture is `u = (x + 0.5) / size`.
 */

/** Unit coordinate (0..1 across the picture) of the frame coordinate `x`, along an axis `size` pixels long. */
export function frameToUnit({ x, size }: { x: number; size: number }): number {
	return (x + 0.5) / size;
}

/** The inverse of {@link frameToUnit}. */
export function unitToFrame({ u, size }: { u: number; size: number }): number {
	return u * size - 0.5;
}

/** The centre of a `w` x `h` picture in frame coordinates: `((w - 1) / 2, (h - 1) / 2)`. */
export function frameCentre({ w, h }: { w: number; h: number }): { x: number; y: number } {
	return { x: (w - 1) / 2, y: (h - 1) / 2 };
}
