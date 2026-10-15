/** A point on the canvas -> the source picture's 0..1 coordinates, for a layer with these bounds (canvas px, rotation in degrees). */
export function canvasToSourceUv({
	point,
	bounds,
}: {
	point: { x: number; y: number };
	bounds: { cx: number; cy: number; width: number; height: number; rotation: number };
}): { x: number; y: number } {
	const angle = (-bounds.rotation * Math.PI) / 180;
	const dx = point.x - bounds.cx;
	const dy = point.y - bounds.cy;
	const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
	const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
	return { x: localX / bounds.width + 0.5, y: localY / bounds.height + 0.5 };
}

/** Brush radius in canvas pixels for a stroke radius (share of the source width) on a layer of this width. */
export function radiusOnCanvas({ radius, boundsWidth }: { radius: number; boundsWidth: number }): number {
	return radius * boundsWidth;
}

/** The inverse of `canvasToSourceUv`: a source picture point (0..1) -> its canvas position. */
export function sourceUvToCanvas({
	uv,
	bounds,
}: {
	uv: { x: number; y: number };
	bounds: { cx: number; cy: number; width: number; height: number; rotation: number };
}): { x: number; y: number } {
	const localX = (uv.x - 0.5) * bounds.width;
	const localY = (uv.y - 0.5) * bounds.height;
	const angle = (bounds.rotation * Math.PI) / 180;
	return {
		x: bounds.cx + localX * Math.cos(angle) - localY * Math.sin(angle),
		y: bounds.cy + localX * Math.sin(angle) + localY * Math.cos(angle),
	};
}
