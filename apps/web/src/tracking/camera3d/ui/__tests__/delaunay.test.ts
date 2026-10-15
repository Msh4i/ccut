import { describe, expect, test } from "bun:test";
import { dropLongTriangles, triangulate, type Point2, type Triangle } from "../delaunay";

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

function randomPoints({ count, seed }: { count: number; seed: number }): Point2[] {
	const next = seeded(seed);
	return Array.from({ length: count }, () => ({ x: next() * 1000, y: next() * 600 }));
}

function signedArea({ a, b, c }: { a: Point2; b: Point2; c: Point2 }): number {
	return ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

/** Monotone chain hull area, independent of the code under test. */
function hullArea(points: readonly Point2[]): number {
	const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
	const cross = ([o, a, b]: readonly [Point2, Point2, Point2]) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower: Point2[] = [];
	for (const p of sorted) {
		while (lower.length >= 2 && cross([lower[lower.length - 2], lower[lower.length - 1], p]) <= 0) lower.pop();
		lower.push(p);
	}
	const upper: Point2[] = [];
	for (let i = sorted.length - 1; i >= 0; i--) {
		const p = sorted[i];
		while (upper.length >= 2 && cross([upper[upper.length - 2], upper[upper.length - 1], p]) <= 0) upper.pop();
		upper.push(p);
	}
	const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
	let area = 0;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		area += a.x * b.y - b.x * a.y;
	}
	return Math.abs(area) / 2;
}

/** Whether `p` lies strictly inside the circumcircle of the triangle (with a relative tolerance). */
function insideCircumcircle({ triangle, points, p }: { triangle: Triangle; points: readonly Point2[]; p: Point2 }): boolean {
	const [a, b, c] = triangle.map((index) => points[index]);
	const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
	const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
	const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
	const r = Math.hypot(a.x - ux, a.y - uy);
	return Math.hypot(p.x - ux, p.y - uy) < r * (1 - 1e-9);
}

describe("triangulate (Bowyer-Watson)", () => {
	test("fewer than 3 points: no triangle", () => {
		expect(triangulate({ points: [] })).toEqual([]);
		expect(triangulate({ points: [{ x: 1, y: 1 }] })).toEqual([]);
		expect(triangulate({ points: [{ x: 1, y: 1 }, { x: 5, y: 2 }] })).toEqual([]);
	});

	test("collinear points: no triangle", () => {
		const points = [0, 1, 2, 3, 4].map((i) => ({ x: i * 10, y: i * 5 + 3 }));
		expect(triangulate({ points })).toEqual([]);
	});

	test("coincident or non-finite points are ignored", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: Number.NaN, y: 4 },
			{ x: 10, y: 0 },
			{ x: 0, y: Number.POSITIVE_INFINITY },
			{ x: 0, y: 10 },
		];
		expect(triangulate({ points })).toEqual([[0, 3, 5]]);
	});

	test("three points: one triangle with a consistent orientation", () => {
		const points = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 }];
		const triangles = triangulate({ points });
		expect(triangles).toHaveLength(1);
		const [i, j, k] = triangles[0];
		expect(signedArea({ a: points[i], b: points[j], c: points[k] })).toBeGreaterThan(0);
		expect([...triangles[0]].sort()).toEqual([0, 1, 2]);
	});

	test("a square: two triangles that cover it", () => {
		const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
		const triangles = triangulate({ points });
		expect(triangles).toHaveLength(2);
		const area = triangles.reduce((sum, [i, j, k]) => sum + signedArea({ a: points[i], b: points[j], c: points[k] }), 0);
		expect(area).toBeCloseTo(100, 9);
	});

	test("random points: empty circumcircles, every triangle oriented, the hull covered", () => {
		for (const seed of [1, 2, 3]) {
			const points = randomPoints({ count: 60, seed });
			const triangles = triangulate({ points });
			expect(triangles.length).toBeGreaterThan(60);
			let area = 0;
			for (const triangle of triangles) {
				const [i, j, k] = triangle;
				const a = signedArea({ a: points[i], b: points[j], c: points[k] });
				expect(a).toBeGreaterThan(0);
				area += a;
				for (let p = 0; p < points.length; p++) {
					if (triangle.includes(p)) continue;
					expect(insideCircumcircle({ triangle, points, p: points[p] })).toBe(false);
				}
			}
			expect(area).toBeCloseTo(hullArea(points), 6);
		}
	});

	test("deterministic: the same input gives the same output, and input order does not matter", () => {
		const points = randomPoints({ count: 40, seed: 9 });
		const first = triangulate({ points });
		expect(triangulate({ points })).toEqual(first);
		const order = points.map((_, index) => index).reverse();
		const reversed = order.map((index) => points[index]);
		const mapped = triangulate({ points: reversed })
			.map((triangle) => triangle.map((index) => order[index]))
			.map((triangle) => [...triangle].sort((a, b) => a - b).join(","))
			.sort();
		const expected = first.map((triangle) => [...triangle].sort((a, b) => a - b).join(",")).sort();
		expect(mapped).toEqual(expected);
	});

	test("a regular grid (co-circular points) still triangulates every cell", () => {
		const points: Point2[] = [];
		for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) points.push({ x: x * 20, y: y * 20 });
		const triangles = triangulate({ points });
		expect(triangles).toHaveLength(2 * 5 * 4);
		const area = triangles.reduce((sum, [i, j, k]) => sum + signedArea({ a: points[i], b: points[j], c: points[k] }), 0);
		expect(area).toBeCloseTo(100 * 80, 6);
	});
});

describe("dropLongTriangles", () => {
	test("keeps triangles whose edges are all within the limit", () => {
		const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 200, y: 0 }];
		const triangles: Triangle[] = [
			[0, 1, 2],
			[1, 3, 2],
		];
		expect(dropLongTriangles({ triangles, points, maxEdge: 50 })).toEqual([[0, 1, 2]]);
		expect(dropLongTriangles({ triangles, points, maxEdge: 1000 })).toEqual(triangles);
	});
});
