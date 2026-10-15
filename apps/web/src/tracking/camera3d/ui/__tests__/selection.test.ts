import { describe, expect, test } from "bun:test";
import {
	findPointAt,
	findTriangleAt,
	indicesInPolygon,
	indicesInRect,
	pointInPolygon,
	pointInTriangle,
} from "../hit-test";
import { keepSelectable, selectInRegion, selectOnClick } from "../selection";
import type { Triangle } from "../delaunay";

const square = [
	{ x: 0, y: 0 },
	{ x: 10, y: 0 },
	{ x: 10, y: 10 },
	{ x: 0, y: 10 },
];

describe("hit tests", () => {
	test("pointInTriangle: inside, on an edge, outside, either orientation", () => {
		const a = { x: 0, y: 0 };
		const b = { x: 10, y: 0 };
		const c = { x: 0, y: 10 };
		expect(pointInTriangle({ a, b, c, p: { x: 2, y: 2 } })).toBe(true);
		expect(pointInTriangle({ a, b, c, p: { x: 5, y: 0 } })).toBe(true);
		expect(pointInTriangle({ a, b, c, p: { x: 6, y: 6 } })).toBe(false);
		expect(pointInTriangle({ a: c, b, c: a, p: { x: 2, y: 2 } })).toBe(true);
		expect(pointInTriangle({ a: c, b, c: a, p: { x: -1, y: 2 } })).toBe(false);
	});

	test("findPointAt: the nearest point within the radius, ties to the lower index", () => {
		const points = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }];
		expect(findPointAt({ points, at: { x: 3.4, y: 0 }, radius: 1 })).toBe(1);
		expect(findPointAt({ points, at: { x: 2.1, y: 0.1 }, radius: 1 })).toBe(2);
		expect(findPointAt({ points, at: { x: 20, y: 20 }, radius: 3 })).toBeNull();
		expect(findPointAt({ points: [], at: { x: 0, y: 0 }, radius: 3 })).toBeNull();
	});

	test("findTriangleAt: the triangle under the pointer or null", () => {
		const triangles: Triangle[] = [
			[0, 1, 2],
			[0, 2, 3],
		];
		expect(findTriangleAt({ points: square, triangles, at: { x: 8, y: 2 } })).toBe(0);
		expect(findTriangleAt({ points: square, triangles, at: { x: 2, y: 8 } })).toBe(1);
		expect(findTriangleAt({ points: square, triangles, at: { x: 12, y: 2 } })).toBeNull();
		expect(findTriangleAt({ points: square, triangles: [], at: { x: 2, y: 2 } })).toBeNull();
	});

	test("pointInPolygon: convex, concave, degenerate", () => {
		expect(pointInPolygon({ polygon: square, p: { x: 5, y: 5 } })).toBe(true);
		expect(pointInPolygon({ polygon: square, p: { x: 15, y: 5 } })).toBe(false);
		const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 3 }, { x: 0, y: 10 }];
		expect(pointInPolygon({ polygon: concave, p: { x: 5, y: 6 } })).toBe(false);
		expect(pointInPolygon({ polygon: concave, p: { x: 5, y: 1 } })).toBe(true);
		expect(pointInPolygon({ polygon: [{ x: 0, y: 0 }, { x: 5, y: 5 }], p: { x: 2, y: 2 } })).toBe(false);
	});

	test("indicesInRect: corners in any order, edges included", () => {
		const points = [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 2 }, { x: 5, y: 10 }];
		expect(indicesInRect({ points, from: { x: 6, y: 6 }, to: { x: 0, y: 0 } })).toEqual([0, 1]);
		expect(indicesInRect({ points, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } })).toEqual([0, 1, 2, 3]);
		expect(indicesInRect({ points, from: { x: 3, y: 3 }, to: { x: 3, y: 3 } })).toEqual([]);
	});

	test("indicesInPolygon: the lasso keeps what it encloses", () => {
		const points = [{ x: 1, y: 1 }, { x: 5, y: 6 }, { x: 5, y: 1 }, { x: 20, y: 20 }];
		const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 3 }, { x: 0, y: 10 }];
		expect(indicesInPolygon({ points, polygon: concave })).toEqual([0, 2]);
		expect(indicesInPolygon({ points, polygon: [] })).toEqual([]);
	});
});

describe("selection algebra (track ids, sorted, unique)", () => {
	test("click on a point selects it alone; Shift toggles it", () => {
		expect(selectOnClick({ selection: [3, 7], hit: { kind: "point", trackId: 5 }, shift: false })).toEqual([5]);
		expect(selectOnClick({ selection: [3, 7], hit: { kind: "point", trackId: 5 }, shift: true })).toEqual([3, 5, 7]);
		expect(selectOnClick({ selection: [3, 5, 7], hit: { kind: "point", trackId: 5 }, shift: true })).toEqual([3, 7]);
	});

	test("click on a triangle selects its three points; Shift adds them, or removes them when all three are selected", () => {
		const hit = { kind: "triangle", trackIds: [9, 2, 4] } as const;
		expect(selectOnClick({ selection: [1], hit, shift: false })).toEqual([2, 4, 9]);
		expect(selectOnClick({ selection: [1, 4], hit, shift: true })).toEqual([1, 2, 4, 9]);
		expect(selectOnClick({ selection: [1, 2, 4, 9], hit, shift: true })).toEqual([1]);
	});

	test("click on nothing clears; Shift-click on nothing keeps the selection", () => {
		expect(selectOnClick({ selection: [1, 2], hit: { kind: "none" }, shift: false })).toEqual([]);
		expect(selectOnClick({ selection: [1, 2], hit: { kind: "none" }, shift: true })).toEqual([1, 2]);
	});

	test("marquee or lasso replaces; with Shift it adds", () => {
		expect(selectInRegion({ selection: [1, 2], trackIds: [8, 2, 8], shift: false })).toEqual([2, 8]);
		expect(selectInRegion({ selection: [1, 2], trackIds: [8, 3], shift: true })).toEqual([1, 2, 3, 8]);
		expect(selectInRegion({ selection: [1, 2], trackIds: [], shift: false })).toEqual([]);
	});

	test("keepSelectable drops deleted or unsolved points and keeps the same array when nothing changes", () => {
		const selection = [1, 4, 6];
		expect(keepSelectable({ selection, selectable: (id) => id !== 4 })).toEqual([1, 6]);
		expect(keepSelectable({ selection, selectable: () => true })).toBe(selection);
	});
});
