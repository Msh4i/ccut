import { describe, expect, test } from "bun:test";
import { createRng } from "../random";
import {
	applySim,
	composeSim,
	fitSim,
	IDENTITY_SIM,
	ransacSim,
	type Similarity,
} from "../similarity";

/** z' = a z + b with a = s e^(i theta). */
function similarity({
	scale,
	theta,
	tx,
	ty,
}: {
	scale: number;
	theta: number;
	tx: number;
	ty: number;
}): Similarity {
	return { ar: scale * Math.cos(theta), ai: scale * Math.sin(theta), br: tx, bi: ty };
}

const TRUTH = similarity({ scale: 1.3, theta: 0.4, tx: 25, ty: -12 });

function pointPairs({
	count,
	seed,
	map = TRUTH,
}: {
	count: number;
	seed: number;
	map?: Similarity;
}) {
	const random = createRng({ seed });
	const za = new Float64Array(2 * count);
	const zb = new Float64Array(2 * count);
	for (let i = 0; i < count; i++) {
		const x = 20 + random() * 440;
		const y = 20 + random() * 230;
		const p = applySim({ map, x, y });
		za[2 * i] = x;
		za[2 * i + 1] = y;
		zb[2 * i] = p.x;
		zb[2 * i + 1] = p.y;
	}
	return { za, zb };
}

function expectSameMap({ got, want, tolerance }: { got: Similarity | null; want: Similarity; tolerance: number }) {
	expect(got).not.toBeNull();
	if (!got) return;
	for (const p of [
		{ x: 0, y: 0 },
		{ x: 480, y: 0 },
		{ x: 480, y: 270 },
		{ x: 240, y: 135 },
	]) {
		const a = applySim({ map: got, x: p.x, y: p.y });
		const b = applySim({ map: want, x: p.x, y: p.y });
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(tolerance);
	}
}

describe("applySim and composeSim", () => {
	test("the identity leaves points alone", () => {
		expect(applySim({ map: IDENTITY_SIM, x: 12.5, y: -3 })).toEqual({ x: 12.5, y: -3 });
	});

	test("multiplying by i sends (1, 0) to (0, 1), as z' = a z + b says", () => {
		// a = i: (1, 0) -> (0, 1)
		const p = applySim({ map: { ar: 0, ai: 1, br: 0, bi: 0 }, x: 1, y: 0 });
		expect(p.x).toBeCloseTo(0, 12);
		expect(p.y).toBeCloseTo(1, 12);
	});

	test("composing applies the inner map first", () => {
		const inner = similarity({ scale: 0.8, theta: -0.3, tx: 4, ty: 9 });
		const outer = similarity({ scale: 1.7, theta: 0.9, tx: -30, ty: 2 });
		const both = composeSim({ outer, inner });
		for (const [x, y] of [
			[0, 0],
			[100, 50],
			[-40, 300],
		]) {
			const step = applySim({
				map: outer,
				...applySim({ map: inner, x, y }),
			});
			const once = applySim({ map: both, x, y });
			expect(once.x).toBeCloseTo(step.x, 9);
			expect(once.y).toBeCloseTo(step.y, 9);
		}
		expect(composeSim({ outer: IDENTITY_SIM, inner })).toEqual(inner);
	});
});

describe("fitSim", () => {
	test("recovers the exact map from exact points", () => {
		const { za, zb } = pointPairs({ count: 30, seed: 1 });
		const w = new Float64Array(30).fill(1);
		const idx = Int32Array.from({ length: 30 }, (_, i) => i);
		expectSameMap({ got: fitSim({ za, zb, w, idx, n: 30 }), want: TRUTH, tolerance: 1e-9 });
	});

	test("uses only the listed points and weights them", () => {
		const { za, zb } = pointPairs({ count: 40, seed: 2 });
		// poison the last ten: they must not matter when left out of idx
		for (let i = 30; i < 40; i++) {
			zb[2 * i] += 90;
			zb[2 * i + 1] -= 40;
		}
		const w = new Float64Array(40).fill(1);
		const idx = Int32Array.from({ length: 30 }, (_, i) => i);
		expectSameMap({ got: fitSim({ za, zb, w, idx, n: 30 }), want: TRUTH, tolerance: 1e-9 });
		// a zero weight is as good as leaving the point out
		const all = Int32Array.from({ length: 40 }, (_, i) => i);
		for (let i = 30; i < 40; i++) w[i] = 0;
		expectSameMap({ got: fitSim({ za, zb, w, idx: all, n: 40 }), want: TRUTH, tolerance: 1e-9 });
	});

	test("the heavier of two conflicting groups wins", () => {
		const a = pointPairs({ count: 20, seed: 3 });
		const otherMap = similarity({ scale: 1, theta: 0, tx: 60, ty: 60 });
		const b = pointPairs({ count: 20, seed: 4, map: otherMap });
		const za = Float64Array.from([...a.za, ...b.za]);
		const zb = Float64Array.from([...a.zb, ...b.zb]);
		const idx = Int32Array.from({ length: 40 }, (_, i) => i);
		const w = new Float64Array(40);
		w.fill(1000, 0, 20);
		w.fill(1, 20, 40);
		const heavy = fitSim({ za, zb, w, idx, n: 40 });
		const p = applySim({ map: heavy ?? IDENTITY_SIM, x: 240, y: 135 });
		const t = applySim({ map: TRUTH, x: 240, y: 135 });
		expect(Math.hypot(p.x - t.x, p.y - t.y)).toBeLessThan(1);
	});

	test("gives up when the points cannot define a similarity", () => {
		const same = new Float64Array(2 * 5);
		for (let i = 0; i < 5; i++) {
			same[2 * i] = 100;
			same[2 * i + 1] = 80;
		}
		const w = new Float64Array(5).fill(1);
		const idx = Int32Array.from({ length: 5 }, (_, i) => i);
		expect(fitSim({ za: same, zb: same, w, idx, n: 5 })).toBeNull();
		expect(fitSim({ za: same, zb: same, w: new Float64Array(5), idx, n: 5 })).toBeNull();
		expect(fitSim({ za: same, zb: same, w, idx, n: 0 })).toBeNull();
		expect(fitSim({ za: same, zb: same, w, idx, n: 1 })).toBeNull();
	});
});

describe("ransacSim", () => {
	const options = { hyp: 80, tau: 1, minSep: 12 };

	test("finds the map behind 40 percent outliers", () => {
		const { za, zb } = pointPairs({ count: 100, seed: 5 });
		const random = createRng({ seed: 77 });
		for (let i = 0; i < 40; i++) {
			zb[2 * i] = random() * 480;
			zb[2 * i + 1] = random() * 270;
		}
		const found = ransacSim({ za, zb, n: 100, weights: new Float64Array(100).fill(1), options, random: createRng({ seed: 7 }) });
		expectSameMap({ got: found, want: TRUTH, tolerance: 1e-6 });
	});

	test("never picks a point whose weight is zero", () => {
		const { za, zb } = pointPairs({ count: 63, seed: 6 });
		const random = createRng({ seed: 78 });
		const weights = new Float64Array(63);
		for (let i = 0; i < 60; i++) {
			zb[2 * i] = random() * 480;
			zb[2 * i + 1] = random() * 270;
		}
		weights.fill(1, 60, 63);
		const found = ransacSim({ za, zb, n: 63, weights, options, random: createRng({ seed: 7 }) });
		expectSameMap({ got: found, want: TRUTH, tolerance: 1e-6 });
	});

	test("is deterministic for a given random stream", () => {
		const { za, zb } = pointPairs({ count: 50, seed: 8 });
		for (let i = 0; i < 25; i++) zb[2 * i] += 17 * Math.sin(i);
		const weights = new Float64Array(50).fill(1);
		const run = () => ransacSim({ za, zb, n: 50, weights, options, random: createRng({ seed: 3 }) });
		expect(run()).toEqual(run());
	});

	test("rejects hypotheses that scale by more than 2x or less than 0.5x", () => {
		const big = pointPairs({ count: 30, seed: 9, map: similarity({ scale: 3, theta: 0, tx: 0, ty: 0 }) });
		const small = pointPairs({ count: 30, seed: 9, map: similarity({ scale: 0.4, theta: 0, tx: 0, ty: 0 }) });
		const weights = new Float64Array(30).fill(1);
		for (const { za, zb } of [big, small]) {
			expect(ransacSim({ za, zb, n: 30, weights, options, random: createRng({ seed: 1 }) })).toBeNull();
		}
	});

	test("needs two points that are far enough apart", () => {
		const za = new Float64Array(2 * 10);
		const zb = new Float64Array(2 * 10);
		for (let i = 0; i < 10; i++) {
			za[2 * i] = 100 + i;
			za[2 * i + 1] = 100;
			zb[2 * i] = 110 + i;
			zb[2 * i + 1] = 100;
		}
		const weights = new Float64Array(10).fill(1);
		expect(ransacSim({ za, zb, n: 10, weights, options, random: createRng({ seed: 1 }) })).toBeNull();
	});
});
