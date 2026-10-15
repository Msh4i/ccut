/**
 * Delaunay triangulation of the track points visible at a frame (AE: hover
 * "between three neighbouring points"). Bowyer-Watson with a super triangle:
 * O(n^2), fine for the few hundred points a frame shows. Deterministic: the
 * points are inserted in (x, y, index) order and the result is listed in a
 * canonical form, so the same points always give the same triangles.
 */

export interface Point2 {
	x: number;
	y: number;
}

/** Indices into the input points, ordered with a positive signed area (x right, y down: clockwise on screen). */
export type Triangle = readonly [number, number, number];

/** Above this many points the overlay stops triangulating (the hover would cost more than a frame). */
export const MAX_TRIANGULATED_POINTS = 2000;

/** The super triangle is this many times larger than the points' bounding box. */
const SUPER_SCALE = 1000;

function orient({ a, b, c }: { a: Point2; b: Point2; c: Point2 }): number {
	return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/** > 0 when `d` is strictly inside the circumcircle of the positively oriented triangle a, b, c. */
function inCircle({
	a,
	b,
	c,
	d,
}: {
	a: Point2;
	b: Point2;
	c: Point2;
	d: Point2;
}): number {
	const adx = a.x - d.x;
	const ady = a.y - d.y;
	const bdx = b.x - d.x;
	const bdy = b.y - d.y;
	const cdx = c.x - d.x;
	const cdy = c.y - d.y;
	return (
		(adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) -
		(bdx * bdx + bdy * bdy) * (adx * cdy - cdx * ady) +
		(cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady)
	);
}

function canonical(triangle: Triangle): Triangle {
	const [a, b, c] = triangle;
	if (a <= b && a <= c) return [a, b, c];
	if (b <= a && b <= c) return [b, c, a];
	return [c, a, b];
}

/**
 * Indices of the usable points: finite, and the first of any exact
 * duplicates (a duplicate would give zero-area triangles).
 */
function usableIndices(points: readonly Point2[]): number[] {
	const seen = new Set<string>();
	const indices: number[] = [];
	for (let index = 0; index < points.length; index++) {
		const { x, y } = points[index];
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		const key = `${x},${y}`;
		if (seen.has(key)) continue;
		seen.add(key);
		indices.push(index);
	}
	return indices;
}

/**
 * The Delaunay triangles of `points` (indices into `points`). Fewer than
 * three usable points, or all of them on one line, give no triangle.
 */
export function triangulate({
	points,
}: {
	points: readonly Point2[];
}): Triangle[] {
	const indices = usableIndices(points);
	if (indices.length < 3) return [];
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const index of indices) {
		minX = Math.min(minX, points[index].x);
		minY = Math.min(minY, points[index].y);
		maxX = Math.max(maxX, points[index].x);
		maxY = Math.max(maxY, points[index].y);
	}
	const size = Math.max(maxX - minX, maxY - minY);
	if (!(size > 0)) return [];
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const span = size * SUPER_SCALE;
	// vertices n, n + 1, n + 2 of `all` are the super triangle (positively oriented)
	const all: Point2[] = [...points];
	const s0 = all.length;
	all.push(
		{ x: cx - span, y: cy - span },
		{ x: cx + span, y: cy - span },
		{ x: cx, y: cy + span },
	);
	const circleRight = ([a, b, c]: readonly [number, number, number]) =>
		circumcircleRight({ a: all[a], b: all[b], c: all[c] });
	// triangles still open to change, flat (a, b, c per triangle), with their circumcircle's right edge
	let open: number[] = [s0, s0 + 1, s0 + 2];
	let openRight: number[] = [circleRight([s0, s0 + 1, s0 + 2])];
	const closed: number[] = [];
	const edgeBase = all.length;
	const edgeKey = ([u, v]: readonly [number, number]) =>
		u < v ? u * edgeBase + v : v * edgeBase + u;
	// sweep in x: a triangle whose circumcircle lies left of the current point stays Delaunay for good
	const order = [...indices].sort(
		(i, j) => points[i].x - points[j].x || points[i].y - points[j].y || i - j,
	);
	for (const p of order) {
		const point = all[p];
		const nextOpen: number[] = [];
		const nextRight: number[] = [];
		const edgeCount = new Map<number, number>();
		// the bad triangles' edges, as (u, v) pairs in their orientation
		const cavity: number[] = [];
		for (let t = 0; t < openRight.length; t++) {
			const a = open[3 * t];
			const b = open[3 * t + 1];
			const c = open[3 * t + 2];
			if (openRight[t] < point.x) {
				closed.push(a, b, c);
				continue;
			}
			if (inCircle({ a: all[a], b: all[b], c: all[c], d: point }) > 0) {
				cavity.push(a, b, b, c, c, a);
				for (let e = cavity.length - 6; e < cavity.length; e += 2) {
					const key = edgeKey([cavity[e], cavity[e + 1]]);
					edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
				}
			} else {
				nextOpen.push(a, b, c);
				nextRight.push(openRight[t]);
			}
		}
		// the cavity's boundary (edges of one bad triangle only), joined to the new point
		for (let e = 0; e < cavity.length; e += 2) {
			const u = cavity[e];
			const v = cavity[e + 1];
			if (edgeCount.get(edgeKey([u, v])) !== 1) continue;
			// (u, v) keeps the bad triangle's orientation, so (u, v, p) is positive too
			if (orient({ a: all[u], b: all[v], c: point }) > 0) {
				nextOpen.push(u, v, p);
				nextRight.push(circleRight([u, v, p]));
			}
		}
		open = nextOpen;
		openRight = nextRight;
	}
	const flat = [...closed, ...open];
	const triangles: Triangle[] = [];
	for (let t = 0; t < flat.length; t += 3) {
		const a = flat[t];
		const b = flat[t + 1];
		const c = flat[t + 2];
		if (a < s0 && b < s0 && c < s0) triangles.push(canonical([a, b, c]));
	}
	return triangles.sort(
		(left, right) =>
			left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
	);
}

/**
 * The x of the rightmost point of a triangle's circumcircle, rounded up a
 * little so a triangle is only retired when its circle is clearly passed.
 * Degenerate triangles never retire.
 */
function circumcircleRight({
	a,
	b,
	c,
}: {
	a: Point2;
	b: Point2;
	c: Point2;
}): number {
	const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
	if (d === 0) return Number.POSITIVE_INFINITY;
	const a2 = a.x * a.x + a.y * a.y;
	const b2 = b.x * b.x + b.y * b.y;
	const c2 = c.x * c.x + c.y * c.y;
	const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
	const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
	const r = Math.hypot(a.x - ux, a.y - uy);
	const right = ux + r;
	if (!Number.isFinite(right)) return Number.POSITIVE_INFINITY;
	return right + 1e-9 * (Math.abs(ux) + r + 1);
}

/**
 * Drops triangles with an edge longer than `maxEdge` (the long slivers along
 * the hull and across empty areas that AE does not offer as a plane).
 */
export function dropLongTriangles({
	triangles,
	points,
	maxEdge,
}: {
	triangles: readonly Triangle[];
	points: readonly Point2[];
	maxEdge: number;
}): Triangle[] {
	const limit = maxEdge * maxEdge;
	const edge2 = ([i, j]: readonly [number, number]) =>
		(points[i].x - points[j].x) ** 2 + (points[i].y - points[j].y) ** 2;
	return triangles.filter(
		([a, b, c]) =>
			edge2([a, b]) <= limit && edge2([b, c]) <= limit && edge2([c, a]) <= limit,
	);
}
