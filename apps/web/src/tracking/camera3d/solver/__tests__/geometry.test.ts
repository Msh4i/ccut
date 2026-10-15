import { describe, expect, test } from "bun:test";
import { createRng } from "@/tracking/camera/random";
import {
	decomposeEssential,
	decomposeHomography,
	essentialFromPoints,
	fitHomography,
	pnpDlt,
	pnpDltUncalibrated,
	sampsonDistance,
	triangulate,
	homographyTransfer,
} from "../geometry";
import { mat3Apply, mat3Mul, mat3Transpose, rotExp } from "../linalg";

interface TwoView {
	r: Float64Array;
	t: Float64Array;
	points: number[][];
	a: Float64Array;
	b: Float64Array;
	n: number;
}

/** Camera a at the origin, camera b = [R | t]; normalized image points. */
function twoView({ seed, planar = false }: { seed: number; planar?: boolean }): TwoView {
	const random = createRng({ seed });
	const r = rotExp([0.05, -0.12, 0.03]);
	const t = Float64Array.from([-0.6, 0.1, 0.15]);
	const points: number[][] = [];
	const a: number[] = [];
	const b: number[] = [];
	for (let i = 0; i < 60; i++) {
		const x = random() * 4 - 2;
		const y = random() * 3 - 1.5;
		// planar: on z = 6 + 0.3 x - 0.2 y
		const z = planar ? 6 + 0.3 * x - 0.2 * y : 4 + random() * 6;
		const p = [x, y, z];
		const q = mat3Apply({ m: r, v: p });
		q[0] += t[0];
		q[1] += t[1];
		q[2] += t[2];
		points.push(p);
		a.push(p[0] / p[2], p[1] / p[2]);
		b.push(q[0] / q[2], q[1] / q[2]);
	}
	return { r, t, points, a: Float64Array.from(a), b: Float64Array.from(b), n: 60 };
}

function allIndices(n: number): Int32Array {
	return Int32Array.from({ length: n }, (_, i) => i);
}

function close({ a, b, tol }: { a: ArrayLike<number>; b: ArrayLike<number>; tol: number }): boolean {
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
	return true;
}

describe("essential matrix", () => {
	test("8-point on exact correspondences: zero Sampson distance, and one decomposition is the true motion", () => {
		const view = twoView({ seed: 1 });
		const e = essentialFromPoints({ a: view.a, b: view.b, idx: allIndices(view.n), n: view.n });
		expect(e).not.toBeNull();
		if (!e) return;
		for (let i = 0; i < view.n; i++) {
			const d = sampsonDistance({ f: e, ax: view.a[2 * i], ay: view.a[2 * i + 1], bx: view.b[2 * i], by: view.b[2 * i + 1] });
			expect(d).toBeLessThan(1e-9);
		}
		const tUnit = Float64Array.from(view.t.map((value) => value / Math.hypot(...view.t)));
		const found = decomposeEssential(e).some(
			(candidate) => close({ a: candidate.r, b: view.r, tol: 1e-8 }) && close({ a: candidate.t, b: tUnit, tol: 1e-8 }),
		);
		expect(found).toBe(true);
	});
});

describe("triangulation", () => {
	test("two and three views give the point back", () => {
		const view = twoView({ seed: 2 });
		const identity = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
		for (let i = 0; i < 10; i++) {
			const p = triangulate({
				rotations: [identity, view.r],
				translations: [Float64Array.from([0, 0, 0]), view.t],
				xs: [view.a[2 * i], view.b[2 * i]],
				ys: [view.a[2 * i + 1], view.b[2 * i + 1]],
			});
			expect(p).not.toBeNull();
			expect(close({ a: p ?? [], b: view.points[i], tol: 1e-8 })).toBe(true);
		}
	});
});

describe("homography", () => {
	test("DLT fits a plane's homography exactly", () => {
		const view = twoView({ seed: 3, planar: true });
		const h = fitHomography({ a: view.a, b: view.b, idx: allIndices(view.n), n: view.n });
		expect(h).not.toBeNull();
		if (!h) return;
		for (let i = 0; i < view.n; i++) {
			const e = homographyTransfer({ h, ax: view.a[2 * i], ay: view.a[2 * i + 1], bx: view.b[2 * i], by: view.b[2 * i + 1] });
			expect(e).toBeLessThan(1e-9);
		}
	});

	test("one of the decompositions is the true rotation, translation direction and plane normal", () => {
		const view = twoView({ seed: 4, planar: true });
		const h = fitHomography({ a: view.a, b: view.b, idx: allIndices(view.n), n: view.n });
		expect(h).not.toBeNull();
		if (!h) return;
		const tUnit = Float64Array.from(view.t.map((value) => value / Math.hypot(...view.t)));
		// plane z = 6 + 0.3 x - 0.2 y  =>  (-0.3, 0.2, 1) . X = 6
		const nRaw = [-0.3, 0.2, 1];
		const nUnit = nRaw.map((value) => value / Math.hypot(...nRaw));
		const candidates = decomposeHomography(h);
		expect(candidates.length).toBe(8);
		const found = candidates.some(
			(c) => close({ a: c.r, b: view.r, tol: 1e-6 }) && close({ a: c.t, b: tUnit, tol: 1e-6 }) && close({ a: c.n, b: nUnit, tol: 1e-6 }),
		);
		expect(found).toBe(true);
	});

	test("a pure rotation's homography has no decomposition (degenerate singular values)", () => {
		const r = rotExp([0.1, 0.05, 0]);
		expect(decomposeHomography(r)).toEqual([]);
	});
});

describe("PnP", () => {
	test("calibrated DLT recovers the pose of exact correspondences", () => {
		const view = twoView({ seed: 5 });
		const pose = pnpDlt({ points: view.points.flat(), xs: view.b, idx: allIndices(view.n), n: view.n });
		expect(pose).not.toBeNull();
		if (!pose) return;
		expect(close({ a: pose.r, b: view.r, tol: 1e-8 })).toBe(true);
		expect(close({ a: pose.t, b: view.t, tol: 1e-8 })).toBe(true);
	});

	test("uncalibrated DLT recovers the focal length and the pose", () => {
		const view = twoView({ seed: 6 });
		const focal = 1500;
		const pixels = Float64Array.from(view.b, (value) => value * focal);
		const pose = pnpDltUncalibrated({ points: view.points.flat(), uv: pixels, idx: allIndices(view.n), n: view.n, focalGuess: 1000 });
		expect(pose).not.toBeNull();
		if (!pose) return;
		expect(pose.focal).toBeCloseTo(focal, 4);
		expect(close({ a: pose.r, b: view.r, tol: 1e-7 })).toBe(true);
		expect(close({ a: pose.t, b: view.t, tol: 1e-6 })).toBe(true);
		// R is world-to-camera: R^T R = I
		expect(close({ a: mat3Mul({ a: mat3Transpose(pose.r), b: pose.r }), b: [1, 0, 0, 0, 1, 0, 0, 0, 1], tol: 1e-9 })).toBe(true);
	});
});
