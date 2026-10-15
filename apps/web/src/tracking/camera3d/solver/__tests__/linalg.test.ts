import { describe, expect, test } from "bun:test";
import { createRng } from "@/tracking/camera/random";
import {
	choleskySolve,
	closestRotation,
	mat3Det,
	mat3Mul,
	mat3Transpose,
	nullVector,
	rotExp,
	rotLog,
	svd3,
	symmetricEigen,
} from "../linalg";

function randomMatrix({ n, seed }: { n: number; seed: number }): Float64Array {
	const random = createRng({ seed });
	const m = new Float64Array(n * n);
	for (let i = 0; i < m.length; i++) m[i] = random() * 2 - 1;
	return m;
}

function maxAbsDiff({ a, b }: { a: ArrayLike<number>; b: ArrayLike<number> }): number {
	let worst = 0;
	for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
	return worst;
}

describe("symmetricEigen", () => {
	test("reconstructs a random symmetric 9x9 matrix, ascending values, orthonormal vectors", () => {
		const n = 9;
		const r = randomMatrix({ n, seed: 3 });
		const a = new Float64Array(n * n);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) a[i * n + j] = r[i * n + j] + r[j * n + i];
		}
		const { values, vectors } = symmetricEigen({ a, n });
		for (let k = 1; k < n; k++) expect(values[k]).toBeGreaterThanOrEqual(values[k - 1]);
		const rebuilt = new Float64Array(n * n);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				let s = 0;
				for (let k = 0; k < n; k++) s += vectors[i * n + k] * values[k] * vectors[j * n + k];
				rebuilt[i * n + j] = s;
			}
		}
		expect(maxAbsDiff({ a: rebuilt, b: a })).toBeLessThan(1e-10);
		for (let p = 0; p < n; p++) {
			for (let q = 0; q < n; q++) {
				let dot = 0;
				for (let i = 0; i < n; i++) dot += vectors[i * n + p] * vectors[i * n + q];
				expect(Math.abs(dot - (p === q ? 1 : 0))).toBeLessThan(1e-10);
			}
		}
	});

	test("the input matrix is left untouched", () => {
		const a = Float64Array.from([2, 1, 1, 3]);
		symmetricEigen({ a, n: 2 });
		expect(Array.from(a)).toEqual([2, 1, 1, 3]);
	});
});

describe("nullVector", () => {
	test("finds the direction a rank-deficient system annihilates", () => {
		// rows orthogonal to (1, 2, -1) / sqrt(6)
		const rows = Float64Array.from([1, 0, 1, 0, 1, 2, 2, -1, 0, 1, 1, 3]);
		const v = nullVector({ rows, m: 4, n: 3 });
		const expected = [1 / Math.sqrt(6), 2 / Math.sqrt(6), -1 / Math.sqrt(6)];
		const sign = Math.sign(v[0]);
		for (let i = 0; i < 3; i++) expect(v[i] * sign).toBeCloseTo(expected[i], 10);
	});
});

describe("svd3", () => {
	test("U diag(s) V^T rebuilds the matrix, singular values descending and non-negative", () => {
		for (let seed = 1; seed <= 20; seed++) {
			const m = randomMatrix({ n: 3, seed });
			const { u, s, v } = svd3(m);
			expect(s[0]).toBeGreaterThanOrEqual(s[1]);
			expect(s[1]).toBeGreaterThanOrEqual(s[2]);
			expect(s[2]).toBeGreaterThanOrEqual(0);
			const us = new Float64Array(9);
			for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) us[i * 3 + j] = u[i * 3 + j] * s[j];
			const rebuilt = mat3Mul({ a: us, b: mat3Transpose(v) });
			expect(maxAbsDiff({ a: rebuilt, b: m })).toBeLessThan(1e-12);
			const utu = mat3Mul({ a: mat3Transpose(u), b: u });
			expect(maxAbsDiff({ a: utu, b: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBeLessThan(1e-12);
		}
	});

	test("a rank-2 matrix has a zero third singular value", () => {
		const m = Float64Array.from([1, 2, 3, 2, 4, 6.5, 0, 1, 0]);
		// make row 2 = 2 row 0: rank 2
		m[3] = 2;
		m[4] = 4;
		m[5] = 6;
		const { s } = svd3(m);
		expect(s[2]).toBeLessThan(1e-12);
		expect(s[1]).toBeGreaterThan(0.1);
	});
});

describe("rotations", () => {
	test("rotExp and rotLog are inverse, and rotExp gives a proper rotation", () => {
		const random = createRng({ seed: 11 });
		for (let k = 0; k < 50; k++) {
			const w: [number, number, number] = [random() * 4 - 2, random() * 4 - 2, random() * 4 - 2];
			const angle = Math.hypot(...w);
			if (angle > Math.PI - 1e-3) continue;
			const r = rotExp(w);
			expect(Math.abs(mat3Det(r) - 1)).toBeLessThan(1e-12);
			const rtr = mat3Mul({ a: mat3Transpose(r), b: r });
			expect(maxAbsDiff({ a: rtr, b: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBeLessThan(1e-12);
			const back = rotLog(r);
			expect(maxAbsDiff({ a: back, b: w })).toBeLessThan(1e-9);
		}
	});

	test("rotExp of a small vector is I + [w]x to first order, about the right axis", () => {
		const r = rotExp([0, 0, 0.5]);
		// rotation about z by 0.5 rad: x axis goes to (cos, sin, 0)
		expect(r[0]).toBeCloseTo(Math.cos(0.5), 12);
		expect(r[3]).toBeCloseTo(Math.sin(0.5), 12);
		expect(r[8]).toBeCloseTo(1, 12);
	});

	test("rotLog near pi keeps the axis", () => {
		const w: [number, number, number] = [0, (Math.PI - 1e-6) / Math.SQRT2, (Math.PI - 1e-6) / Math.SQRT2];
		const back = rotLog(rotExp(w));
		expect(maxAbsDiff({ a: back, b: w })).toBeLessThan(1e-4);
	});

	test("closestRotation turns a perturbed rotation into the nearest proper one", () => {
		const r = rotExp([0.3, -0.2, 0.1]);
		const noisy = Float64Array.from(r);
		noisy[1] += 0.01;
		noisy[5] -= 0.02;
		const fixed = closestRotation(noisy);
		expect(Math.abs(mat3Det(fixed) - 1)).toBeLessThan(1e-12);
		expect(maxAbsDiff({ a: fixed, b: r })).toBeLessThan(0.02);
		// a scaled reflection becomes a rotation, never a reflection
		const reflected = Float64Array.from([-2, 0, 0, 0, 2, 0, 0, 0, 2]);
		expect(mat3Det(closestRotation(reflected))).toBeCloseTo(1, 12);
	});
});

describe("choleskySolve", () => {
	test("solves a symmetric positive definite system", () => {
		const n = 6;
		const r = randomMatrix({ n, seed: 5 });
		const a = new Float64Array(n * n);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				let s = 0;
				for (let k = 0; k < n; k++) s += r[i * n + k] * r[j * n + k];
				a[i * n + j] = s + (i === j ? 0.5 : 0);
			}
		}
		const x = Float64Array.from([1, -2, 3, 0.5, -1, 2]);
		const b = new Float64Array(n);
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i] += a[i * n + j] * x[j];
		const copy = Float64Array.from(a);
		expect(choleskySolve({ a: copy, b, n })).toBe(true);
		expect(maxAbsDiff({ a: b, b: x })).toBeLessThan(1e-10);
	});

	test("reports a matrix that is not positive definite", () => {
		const a = Float64Array.from([1, 2, 2, 1]);
		const b = Float64Array.from([1, 1]);
		expect(choleskySolve({ a, b, n: 2 })).toBe(false);
	});
});
