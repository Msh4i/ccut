import { describe, expect, test } from "bun:test";
import { fitH, hApply, hMul, IDENTITY_H, ransacH } from "../homography";
import { createRng } from "../random";

// a mild perspective warp with rotation and scale: h31, h32 well below 0.01
const TRUTH = Float64Array.from([1.08, -0.12, 14, 0.1, 0.97, -9, 0.0004, -0.0002, 1]);

function pointPairs({
	count,
	seed,
	h = TRUTH,
	spread = 1,
}: {
	count: number;
	seed: number;
	h?: Float64Array;
	spread?: number;
}) {
	const random = createRng({ seed });
	const za = new Float64Array(2 * count);
	const zb = new Float64Array(2 * count);
	for (let i = 0; i < count; i++) {
		const x = (20 + random() * 440) * spread;
		const y = (20 + random() * 230) * spread;
		const p = hApply({ h, x, y });
		za[2 * i] = x;
		za[2 * i + 1] = y;
		zb[2 * i] = p.x;
		zb[2 * i + 1] = p.y;
	}
	return { za, zb };
}

function expectSameWarp({
	got,
	want,
	tolerance,
	spread = 1,
}: {
	got: Float64Array | null;
	want: Float64Array;
	tolerance: number;
	spread?: number;
}) {
	expect(got).not.toBeNull();
	if (!got) return;
	for (const [x, y] of [
		[0, 0],
		[480, 0],
		[480, 270],
		[0, 270],
		[240, 135],
	]) {
		const a = hApply({ h: got, x: x * spread, y: y * spread });
		const b = hApply({ h: want, x: x * spread, y: y * spread });
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(tolerance);
	}
}

const indices = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

describe("hApply and hMul", () => {
	test("the identity leaves points alone and a translation moves them", () => {
		expect(hApply({ h: IDENTITY_H, x: 7, y: -2 })).toEqual({ x: 7, y: -2 });
		const t = Float64Array.from([1, 0, 5, 0, 1, -3, 0, 0, 1]);
		expect(hApply({ h: t, x: 7, y: -2 })).toEqual({ x: 12, y: -5 });
	});

	test("multiplying applies the right-hand warp first", () => {
		const other = Float64Array.from([0.9, 0.2, -4, -0.1, 1.1, 20, 0, 0.0003, 1]);
		const both = hMul({ left: TRUTH, right: other });
		for (const [x, y] of [
			[10, 20],
			[300, 200],
		]) {
			const step = hApply({ h: TRUTH, ...hApply({ h: other, x, y }) });
			const once = hApply({ h: both, x, y });
			expect(once.x).toBeCloseTo(step.x, 8);
			expect(once.y).toBeCloseTo(step.y, 8);
		}
	});
});

describe("fitH", () => {
	test("recovers a perspective warp from exact points", () => {
		const { za, zb } = pointPairs({ count: 40, seed: 1 });
		const w = new Float64Array(40).fill(1);
		expectSameWarp({ got: fitH({ za, zb, w, idx: indices(40), n: 40 }), want: TRUTH, tolerance: 1e-6 });
	});

	test("normalisation keeps it accurate for pixel-scale and large coordinates", () => {
		const { za, zb } = pointPairs({ count: 40, seed: 2, spread: 8 });
		const w = new Float64Array(40).fill(1);
		// the same warp on 8x larger coordinates: badly conditioned unless normalised
		const got = fitH({ za, zb, w, idx: indices(40), n: 40 });
		expect(got).not.toBeNull();
		if (!got) return;
		for (const [x, y] of [
			[100, 100],
			[2000, 1500],
			[3500, 1800],
		]) {
			const a = hApply({ h: got, x, y });
			const b = hApply({ h: TRUTH, x, y });
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-4 * 8);
		}
	});

	test("zero-weight points and unlisted points are ignored", () => {
		const { za, zb } = pointPairs({ count: 30, seed: 3 });
		for (let i = 20; i < 30; i++) zb[2 * i] += 50;
		const w = new Float64Array(30).fill(1);
		for (let i = 20; i < 30; i++) w[i] = 0;
		expectSameWarp({ got: fitH({ za, zb, w, idx: indices(30), n: 30 }), want: TRUTH, tolerance: 1e-6 });
		expectSameWarp({ got: fitH({ za, zb, w: new Float64Array(30).fill(1), idx: indices(20), n: 20 }), want: TRUTH, tolerance: 1e-6 });
	});

	test("gives up on points that cannot define a warp", () => {
		const n = 8;
		const line = new Float64Array(2 * n);
		const moved = new Float64Array(2 * n);
		for (let i = 0; i < n; i++) {
			line[2 * i] = 20 + 30 * i;
			line[2 * i + 1] = 50 + 10 * i;
			moved[2 * i] = line[2 * i] + 3;
			moved[2 * i + 1] = line[2 * i + 1] + 1;
		}
		const w = new Float64Array(n).fill(1);
		expect(fitH({ za: line, zb: moved, w, idx: indices(n), n })).toBeNull();
		expect(fitH({ za: line, zb: moved, w: new Float64Array(n), idx: indices(n), n })).toBeNull();
		expect(fitH({ za: line, zb: moved, w, idx: indices(n), n: 0 })).toBeNull();
	});
});

describe("ransacH", () => {
	const options = { hyp: 120, tau: 1, minSep: 25 };

	test("finds the warp behind 35 percent outliers", () => {
		const { za, zb } = pointPairs({ count: 100, seed: 4 });
		const random = createRng({ seed: 99 });
		for (let i = 0; i < 35; i++) {
			zb[2 * i] = random() * 480;
			zb[2 * i + 1] = random() * 270;
		}
		const found = ransacH({ za, zb, n: 100, options, random: createRng({ seed: 7 }) });
		expectSameWarp({ got: found, want: TRUTH, tolerance: 1e-4 });
	});

	test("is deterministic for a given random stream", () => {
		const { za, zb } = pointPairs({ count: 60, seed: 5 });
		for (let i = 0; i < 20; i++) zb[2 * i + 1] += 11 * Math.cos(i);
		const run = () => ransacH({ za, zb, n: 60, options, random: createRng({ seed: 3 }) });
		expect(run()).toEqual(run());
	});

	test("refuses a warp with more perspective than a camera frame can show", () => {
		const absurd = Float64Array.from([1, 0, 0, 0, 1, 0, 0.02, 0.01, 1]);
		const { za, zb } = pointPairs({ count: 50, seed: 6, h: absurd });
		expect(ransacH({ za, zb, n: 50, options, random: createRng({ seed: 1 }) })).toBeNull();
	});

	test("needs four points that are spread apart", () => {
		const n = 20;
		const za = new Float64Array(2 * n);
		const zb = new Float64Array(2 * n);
		for (let i = 0; i < n; i++) {
			za[2 * i] = 200 + (i % 5) * 4;
			za[2 * i + 1] = 100 + Math.floor(i / 5) * 4;
			zb[2 * i] = za[2 * i] + 3;
			zb[2 * i + 1] = za[2 * i + 1];
		}
		expect(ransacH({ za, zb, n, options, random: createRng({ seed: 1 }) })).toBeNull();
	});
});
