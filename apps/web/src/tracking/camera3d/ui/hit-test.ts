import type { Point2, Triangle } from "./delaunay";

/**
 * Pointer hit tests of the track points overlay, in one 2D space (the
 * overlay uses canvas pixels; radii are converted from screen pixels by the
 * caller).
 */

function cross({ o, a, b }: { o: Point2; a: Point2; b: Point2 }): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Whether `p` is inside the triangle or on its border, whatever its orientation. */
export function pointInTriangle({
	a,
	b,
	c,
	p,
}: {
	a: Point2;
	b: Point2;
	c: Point2;
	p: Point2;
}): boolean {
	const d1 = cross({ o: a, a: b, b: p });
	const d2 = cross({ o: b, a: c, b: p });
	const d3 = cross({ o: c, a, b: p });
	const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
	const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
	return !(hasNegative && hasPositive);
}

/** Index of the point nearest to `at` within `radius`, or `null`. Ties go to the lower index. */
export function findPointAt({
	points,
	at,
	radius,
}: {
	points: readonly Point2[];
	at: Point2;
	radius: number;
}): number | null {
	let best: number | null = null;
	let bestDistance = radius * radius;
	for (let index = 0; index < points.length; index++) {
		const distance = (points[index].x - at.x) ** 2 + (points[index].y - at.y) ** 2;
		if (distance < bestDistance || (distance === bestDistance && best === null)) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}

/** Index (into `triangles`) of the first triangle that contains `at`, or `null`. */
export function findTriangleAt({
	points,
	triangles,
	at,
}: {
	points: readonly Point2[];
	triangles: readonly Triangle[];
	at: Point2;
}): number | null {
	for (let index = 0; index < triangles.length; index++) {
		const [a, b, c] = triangles[index];
		if (pointInTriangle({ a: points[a], b: points[b], c: points[c], p: at })) {
			return index;
		}
	}
	return null;
}

/** Even-odd rule; a polygon with fewer than 3 vertices contains nothing. */
export function pointInPolygon({
	polygon,
	p,
}: {
	polygon: readonly Point2[];
	p: Point2;
}): boolean {
	if (polygon.length < 3) return false;
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i];
		const b = polygon[j];
		if (a.y > p.y !== b.y > p.y) {
			const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
			if (p.x < x) inside = !inside;
		}
	}
	return inside;
}

/** Indices of the points inside the rectangle spanned by two corners (edges included). */
export function indicesInRect({
	points,
	from,
	to,
}: {
	points: readonly Point2[];
	from: Point2;
	to: Point2;
}): number[] {
	const x0 = Math.min(from.x, to.x);
	const x1 = Math.max(from.x, to.x);
	const y0 = Math.min(from.y, to.y);
	const y1 = Math.max(from.y, to.y);
	if (!(x1 > x0) || !(y1 > y0)) return [];
	const indices: number[] = [];
	for (let index = 0; index < points.length; index++) {
		const { x, y } = points[index];
		if (x >= x0 && x <= x1 && y >= y0 && y <= y1) indices.push(index);
	}
	return indices;
}

/** Indices of the points inside a lasso polygon. */
export function indicesInPolygon({
	points,
	polygon,
}: {
	points: readonly Point2[];
	polygon: readonly Point2[];
}): number[] {
	const indices: number[] = [];
	for (let index = 0; index < points.length; index++) {
		if (pointInPolygon({ polygon, p: points[index] })) indices.push(index);
	}
	return indices;
}
