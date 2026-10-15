import type { ElementBounds } from "@/preview/element-bounds";

/**
 * Maps a point of a visual element's own picture, `u`, `v` in 0..1 from its
 * top-left, to canvas pixels. `bounds` is what the transform handles use: a
 * negative `width`/`height` is a flip, `rotation` (degrees, clockwise) turns
 * the picture around its center after the flip.
 */
export function uvToCanvas({
	u,
	v,
	bounds,
}: {
	u: number;
	v: number;
	bounds: ElementBounds;
}): { x: number; y: number } {
	const radians = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const localX = (u - 0.5) * bounds.width;
	const localY = (v - 0.5) * bounds.height;
	return {
		x: bounds.cx + localX * cos - localY * sin,
		y: bounds.cy + localX * sin + localY * cos,
	};
}

/** Inverse of {@link uvToCanvas}. `bounds` must not be zero-sized. */
export function canvasToUv({
	x,
	y,
	bounds,
}: {
	x: number;
	y: number;
	bounds: ElementBounds;
}): { u: number; v: number } {
	const radians = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const dx = x - bounds.cx;
	const dy = y - bounds.cy;
	return {
		u: (dx * cos + dy * sin) / bounds.width + 0.5,
		v: (dy * cos - dx * sin) / bounds.height + 0.5,
	};
}
