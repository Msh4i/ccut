/**
 * Two-view estimation for the camera solver: robust essential matrix and
 * homography fits (RANSAC with MSAC scoring, Torr & Zisserman, "MLESAC",
 * 2000), the relative pose and points of an initial pair, Torr's GRIC model
 * selection ("Geometric motion segmentation and model selection", 1998),
 * a rotation-only (tripod) model, and focal-length search from fundamental
 * matrices (Mendonca & Cipolla, "A simple technique for self-calibration",
 * CVPR 1999: the right focal length makes `K^T F K` an essential matrix,
 * whose two non-zero singular values are equal).
 *
 * Image points are frame pixels relative to the frame centre unless named
 * "normalised" (`/ focal`).
 */
import {
	decomposeEssential,
	decomposeHomography,
	essentialFromPoints,
	fitFundamental,
	fitHomography,
	homographyTransfer,
	sampsonDistance,
	triangulate,
	type Motion,
} from "./geometry";
import { choleskySolve, closestRotation, mat3Det, mat3Mul, median, rotExp, svd3 } from "./linalg";
import type { PairData } from "./tracks";

/** `k` distinct random indices below `n` into `out`. */
function sampleDistinct({ n, k, random, out }: { n: number; k: number; random: () => number; out: Int32Array }): void {
	for (let i = 0; i < k; i++) {
		let pick = Math.floor(random() * n);
		for (let tries = 0; tries < 32; tries++) {
			let clash = false;
			for (let j = 0; j < i; j++) if (out[j] === pick) clash = true;
			if (!clash) break;
			pick = Math.floor(random() * n);
		}
		out[i] = pick;
	}
}

/** RANSAC rounds for an inlier share `w` and sample size `k` at 99.9 % confidence, within limits. */
function ransacRounds({ w, k, min, max }: { w: number; k: number; min: number; max: number }): number {
	const good = Math.pow(Math.max(1e-6, Math.min(1 - 1e-9, w)), k);
	return Math.max(min, Math.min(max, Math.ceil(Math.log(0.001) / Math.log(1 - good))));
}

export interface RobustFit {
	model: Float64Array;
	inliers: Uint8Array;
	count: number;
}

/**
 * Essential matrix of a pair seen with a known focal length, by 8-point
 * RANSAC on normalised points with MSAC scoring of the Sampson distance;
 * refitted on its inliers. `threshold` in frame pixels.
 */
export function ransacEssential({
	pair,
	focal,
	threshold,
	maxRounds,
	random,
}: {
	pair: PairData;
	focal: number;
	threshold: number;
	maxRounds: number;
	random: () => number;
}): RobustFit | null {
	const { n } = pair;
	if (n < 12) return null;
	const a = Float64Array.from(pair.pa, (value) => value / focal);
	const b = Float64Array.from(pair.pb, (value) => value / focal);
	const t = threshold / focal;
	const t2 = t * t;
	const sample = new Int32Array(8);
	let best: Float64Array | null = null;
	let bestScore = Infinity;
	let bestCount = 0;
	let rounds = maxRounds;
	for (let round = 0; round < rounds; round++) {
		sampleDistinct({ n, k: 8, random, out: sample });
		const e = essentialFromPoints({ a, b, idx: sample, n: 8 });
		if (!e) continue;
		let score = 0;
		let count = 0;
		for (let i = 0; i < n; i++) {
			const d = sampsonDistance({ f: e, ax: a[2 * i], ay: a[2 * i + 1], bx: b[2 * i], by: b[2 * i + 1] });
			const d2 = d * d;
			if (d2 < t2) {
				score += d2;
				count++;
			} else {
				score += t2;
			}
		}
		if (score < bestScore) {
			bestScore = score;
			best = e;
			bestCount = count;
			rounds = Math.min(rounds, ransacRounds({ w: count / n, k: 8, min: 30, max: maxRounds }));
		}
	}
	if (!best || bestCount < 8) return null;
	return refitEssential({ a, b, n, e: best, t2 });
}

/**
 * Refits the RANSAC essential matrix on its inliers (8-point), keeping a refit
 * only when it lowers the MSAC score: the linear fit on many noisy pairs is
 * biased (badly so for forward motion) and can lose most inliers.
 */
function refitEssential({ a, b, n, e, t2 }: { a: Float64Array; b: Float64Array; n: number; e: Float64Array; t2: number }): RobustFit | null {
	const score = (model: Float64Array): { value: number; inliers: Uint8Array; idx: number[] } => {
		const inliers = new Uint8Array(n);
		const idx: number[] = [];
		let value = 0;
		for (let i = 0; i < n; i++) {
			const d = sampsonDistance({ f: model, ax: a[2 * i], ay: a[2 * i + 1], bx: b[2 * i], by: b[2 * i + 1] });
			const d2 = d * d;
			if (d2 < t2) {
				inliers[i] = 1;
				idx.push(i);
				value += d2;
			} else {
				value += t2;
			}
		}
		return { value, inliers, idx };
	};
	let model = e;
	let current = score(model);
	for (let pass = 0; pass < 3; pass++) {
		if (current.idx.length < 8) return null;
		const refit = essentialFromPoints({ a, b, idx: Int32Array.from(current.idx), n: current.idx.length });
		if (!refit) break;
		const next = score(refit);
		if (!(next.value < current.value)) break;
		model = refit;
		current = next;
	}
	if (current.idx.length < 8) return null;
	return { model, inliers: current.inliers, count: current.idx.length };
}

/** Fundamental matrix of a pair (pixel coordinates), 8-point RANSAC with MSAC scoring. */
export function ransacFundamental({
	pair,
	threshold,
	maxRounds,
	random,
}: {
	pair: PairData;
	threshold: number;
	maxRounds: number;
	random: () => number;
}): RobustFit | null {
	const { n, pa, pb } = pair;
	if (n < 12) return null;
	const t2 = threshold * threshold;
	const sample = new Int32Array(8);
	let best: Float64Array | null = null;
	let bestScore = Infinity;
	let rounds = maxRounds;
	for (let round = 0; round < rounds; round++) {
		sampleDistinct({ n, k: 8, random, out: sample });
		const f = fitFundamental({ a: pa, b: pb, idx: sample, n: 8 });
		if (!f) continue;
		let score = 0;
		let count = 0;
		for (let i = 0; i < n; i++) {
			const d = sampsonDistance({ f, ax: pa[2 * i], ay: pa[2 * i + 1], bx: pb[2 * i], by: pb[2 * i + 1] });
			if (d * d < t2) {
				score += d * d;
				count++;
			} else {
				score += t2;
			}
		}
		if (score < bestScore) {
			bestScore = score;
			best = f;
			rounds = Math.min(rounds, ransacRounds({ w: count / n, k: 8, min: 30, max: maxRounds }));
		}
	}
	if (!best) return null;
	let model = best;
	let inliers = new Uint8Array(n);
	let count = 0;
	for (let pass = 0; pass < 2; pass++) {
		const next = new Uint8Array(n);
		const idx: number[] = [];
		for (let i = 0; i < n; i++) {
			const d = sampsonDistance({ f: model, ax: pa[2 * i], ay: pa[2 * i + 1], bx: pb[2 * i], by: pb[2 * i + 1] });
			if (d * d < t2) {
				next[i] = 1;
				idx.push(i);
			}
		}
		inliers = next;
		count = idx.length;
		if (count < 8) return null;
		const refit = fitFundamental({ a: pa, b: pb, idx: Int32Array.from(idx), n: count });
		if (!refit) break;
		model = refit;
	}
	return { model, inliers, count };
}

/** Homography of a pair (pixel coordinates), 4-point RANSAC with MSAC scoring of the transfer error. */
export function ransacHomography({
	pair,
	threshold,
	maxRounds,
	random,
}: {
	pair: PairData;
	threshold: number;
	maxRounds: number;
	random: () => number;
}): RobustFit | null {
	const { n, pa, pb } = pair;
	if (n < 8) return null;
	const t2 = threshold * threshold;
	const sample = new Int32Array(4);
	let best: Float64Array | null = null;
	let bestScore = Infinity;
	let rounds = maxRounds;
	for (let round = 0; round < rounds; round++) {
		sampleDistinct({ n, k: 4, random, out: sample });
		const h = fitHomography({ a: pa, b: pb, idx: sample, n: 4 });
		if (!h) continue;
		let score = 0;
		let count = 0;
		for (let i = 0; i < n; i++) {
			const d = homographyTransfer({ h, ax: pa[2 * i], ay: pa[2 * i + 1], bx: pb[2 * i], by: pb[2 * i + 1] });
			if (d * d < t2) {
				score += d * d;
				count++;
			} else {
				score += t2;
			}
		}
		if (score < bestScore) {
			bestScore = score;
			best = h;
			rounds = Math.min(rounds, ransacRounds({ w: count / n, k: 4, min: 30, max: maxRounds }));
		}
	}
	if (!best) return null;
	let model = best;
	let inliers = new Uint8Array(n);
	let count = 0;
	for (let pass = 0; pass < 3; pass++) {
		const next = new Uint8Array(n);
		const idx: number[] = [];
		for (let i = 0; i < n; i++) {
			const d = homographyTransfer({ h: model, ax: pa[2 * i], ay: pa[2 * i + 1], bx: pb[2 * i], by: pb[2 * i + 1] });
			if (d * d < t2) {
				next[i] = 1;
				idx.push(i);
			}
		}
		inliers = next;
		count = idx.length;
		if (count < 4) return null;
		const refit = fitHomography({ a: pa, b: pb, idx: Int32Array.from(idx), n: count });
		if (!refit) break;
		model = refit;
	}
	return { model, inliers, count };
}

export interface TwoViewInit extends Motion {
	/** Indices into the pair of the points that were reconstructed. */
	pairIndices: Int32Array;
	/** 3 per reconstructed point, camera-a coordinates (|t| = 1). */
	points: Float64Array;
}

/** Angle in degrees between the rays from the two centres (a at the origin, b at -R^T t) to X. */
function parallaxDeg({ x, r, t }: { x: ArrayLike<number>; r: ArrayLike<number>; t: ArrayLike<number> }): number {
	// centre of b in a's coordinates
	const cb = [
		-(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]),
		-(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]),
		-(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]),
	];
	const ax = x[0];
	const ay = x[1];
	const az = x[2];
	const bx = x[0] - cb[0];
	const by = x[1] - cb[1];
	const bz = x[2] - cb[2];
	const cos = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
	return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Triangulates the selected pairs for a motion; keeps the points in front of both cameras within `maxError` px. */
function reconstructPair({
	pair,
	focal,
	motion,
	select,
	maxError,
	minParallaxDeg,
}: {
	pair: PairData;
	focal: number;
	motion: Motion;
	select: Uint8Array;
	maxError: number;
	minParallaxDeg: number;
}): { indices: number[]; points: number[]; front: number } {
	const identity = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
	const zero = Float64Array.from([0, 0, 0]);
	const indices: number[] = [];
	const points: number[] = [];
	let front = 0;
	const { r, t } = motion;
	for (let i = 0; i < pair.n; i++) {
		if (!select[i]) continue;
		const xa = pair.pa[2 * i] / focal;
		const ya = pair.pa[2 * i + 1] / focal;
		const xb = pair.pb[2 * i] / focal;
		const yb = pair.pb[2 * i + 1] / focal;
		const x = triangulate({ rotations: [identity, r], translations: [zero, t], xs: [xa, xb], ys: [ya, yb] });
		if (!x || !(x[2] > 0)) continue;
		const bz = r[6] * x[0] + r[7] * x[1] + r[8] * x[2] + t[2];
		if (!(bz > 0)) continue;
		front++;
		const bx = r[0] * x[0] + r[1] * x[1] + r[2] * x[2] + t[0];
		const by = r[3] * x[0] + r[4] * x[1] + r[5] * x[2] + t[1];
		const ea = Math.hypot((focal * x[0]) / x[2] - pair.pa[2 * i], (focal * x[1]) / x[2] - pair.pa[2 * i + 1]);
		const eb = Math.hypot((focal * bx) / bz - pair.pb[2 * i], (focal * by) / bz - pair.pb[2 * i + 1]);
		if (ea > maxError || eb > maxError) continue;
		if (parallaxDeg({ x, r, t }) < minParallaxDeg) continue;
		indices.push(i);
		points.push(x[0], x[1], x[2]);
	}
	return { indices, points, front };
}

/** The motion among `candidates` that puts the most inliers in front of both cameras, with its points. */
function bestMotion({
	pair,
	focal,
	candidates,
	inliers,
	maxError,
	minParallaxDeg,
}: {
	pair: PairData;
	focal: number;
	candidates: readonly Motion[];
	inliers: Uint8Array;
	maxError: number;
	minParallaxDeg: number;
}): TwoViewInit | null {
	let best: TwoViewInit | null = null;
	let bestFront = -1;
	let secondFront = -1;
	for (const motion of candidates) {
		const rebuilt = reconstructPair({ pair, focal, motion, select: inliers, maxError, minParallaxDeg });
		if (rebuilt.front > bestFront) {
			secondFront = bestFront;
			bestFront = rebuilt.front;
			best = {
				r: motion.r,
				t: motion.t,
				pairIndices: Int32Array.from(rebuilt.indices),
				points: Float64Array.from(rebuilt.points),
			};
		} else if (rebuilt.front > secondFront) {
			secondFront = rebuilt.front;
		}
	}
	// two motions that explain the pair equally well: ambiguous, refuse
	if (!best || secondFront > 0.9 * bestFront) return null;
	return best;
}

/** Relative pose and points of an initial pair from its essential matrix. */
export function initFromEssential({
	pair,
	focal,
	fit,
	maxError,
	minParallaxDeg,
}: {
	pair: PairData;
	focal: number;
	fit: RobustFit;
	maxError: number;
	minParallaxDeg: number;
}): TwoViewInit | null {
	return bestMotion({ pair, focal, candidates: decomposeEssential(fit.model), inliers: fit.inliers, maxError, minParallaxDeg });
}

/** Relative pose and points of an initial pair from the homography of a (mostly) planar scene. */
export function initFromHomography({
	pair,
	focal,
	fit,
	maxError,
	minParallaxDeg,
}: {
	pair: PairData;
	focal: number;
	fit: RobustFit;
	maxError: number;
	minParallaxDeg: number;
}): TwoViewInit | null {
	const h = fit.model;
	// calibrated homography K^-1 H K with K = diag(f, f, 1)
	const hc = Float64Array.from([h[0], h[1], h[2] / focal, h[3], h[4], h[5] / focal, h[6] * focal, h[7] * focal, h[8]]);
	const candidates = decomposeHomography(hc);
	if (candidates.length === 0) return null;
	return bestMotion({ pair, focal, candidates, inliers: fit.inliers, maxError, minParallaxDeg });
}

/**
 * Torr's GRIC of a model with `k` parameters on a manifold of dimension
 * `d` in the 4D space of point pairs, for squared residuals `e2` (joint
 * image error) and noise variance `sigma2`. Lower is better.
 */
export function gric({ e2, sigma2, d, k }: { e2: ArrayLike<number>; sigma2: number; d: number; k: number }): number {
	const r = 4;
	const n = e2.length;
	const lambda1 = Math.log(r);
	const lambda2 = Math.log(r * n);
	const cap = 2 * (r - d);
	let sum = 0;
	for (let i = 0; i < n; i++) sum += Math.min(e2[i] / sigma2, cap);
	return sum + lambda1 * d * n + lambda2 * k;
}

/** Squared Sampson residuals of a fundamental matrix over a pair. */
export function fundamentalResiduals({ pair, f }: { pair: PairData; f: Float64Array }): Float64Array {
	const out = new Float64Array(pair.n);
	for (let i = 0; i < pair.n; i++) {
		const d = sampsonDistance({ f, ax: pair.pa[2 * i], ay: pair.pa[2 * i + 1], bx: pair.pb[2 * i], by: pair.pb[2 * i + 1] });
		out[i] = d * d;
	}
	return out;
}

/** Squared joint-image residuals of a homography (one-way transfer error squared over 2). */
export function homographyResiduals({ pair, h }: { pair: PairData; h: ArrayLike<number> }): Float64Array {
	const out = new Float64Array(pair.n);
	for (let i = 0; i < pair.n; i++) {
		const d = homographyTransfer({ h, ax: pair.pa[2 * i], ay: pair.pa[2 * i + 1], bx: pair.pb[2 * i], by: pair.pb[2 * i + 1] });
		out[i] = Math.min(1e12, (d * d) / 2);
	}
	return out;
}

/** The homography `K_b R K_a^-1` of a rotating camera. */
export function rotationHomography({ r, focalA, focalB }: { r: ArrayLike<number>; focalA: number; focalB: number }): Float64Array {
	return Float64Array.from([
		r[0] * (focalB / focalA),
		r[1] * (focalB / focalA),
		r[2] * focalB,
		r[3] * (focalB / focalA),
		r[4] * (focalB / focalA),
		r[5] * focalB,
		r[6] / focalA,
		r[7] / focalA,
		r[8],
	]);
}

export interface RotationFit {
	r: Float64Array;
	focalA: number;
	focalB: number;
	/** Squared joint-image residuals over the whole pair. */
	e2: Float64Array;
}

/**
 * Rotation-only model of a pair (a camera turning about its centre, the
 * tripod case): `x_b ~ K_b R K_a^-1 x_a`. Unknown focal lengths are found
 * by a search over angles of view from the homography, then Gauss-Newton
 * on (rotation, ln f) over the pairs `select` marks. `focal` given = known;
 * `zoom` = the two views may have different focal lengths.
 */
export function fitRotationOnly({
	pair,
	h,
	select,
	focal,
	zoom,
	frameWidth,
}: {
	pair: PairData;
	h: Float64Array;
	select: Uint8Array;
	focal: number | null;
	zoom: boolean;
	frameWidth: number;
}): RotationFit | null {
	let bestF = focal ?? frameWidth;
	let bestR: Float64Array | null = null;
	let bestErr = Infinity;
	const candidates = focal !== null ? [focal] : focalGrid({ frameWidth, steps: 40 });
	for (const f of candidates) {
		// K^-1 H K should be a scaled rotation
		const m = Float64Array.from([h[0], h[1], h[2] / f, h[3], h[4], h[5] / f, h[6] * f, h[7] * f, h[8]]);
		const det = mat3Det(m);
		if (!(Math.abs(det) > 1e-300)) continue;
		const scale = Math.cbrt(det);
		const r = closestRotation(m.map((value) => value / scale));
		const err = rotationError({ pair, r, focalA: f, focalB: f, select });
		if (err < bestErr) {
			bestErr = err;
			bestF = f;
			bestR = r;
		}
	}
	if (!bestR) return null;
	// Gauss-Newton with numeric derivatives on [w (3), ln fa, ln fb]
	let r = bestR;
	let lnA = Math.log(bestF);
	let lnB = Math.log(bestF);
	const freeFocal = focal === null;
	const dims = 3 + (freeFocal ? (zoom ? 2 : 1) : 0);
	const evaluate = ({ w, la, lb }: { w: number[]; la: number; lb: number }): number =>
		rotationError({ pair, r: mat3Mul({ a: rotExp(w), b: r }), focalA: Math.exp(la), focalB: Math.exp(lb), select });
	let cost = rotationError({ pair, r, focalA: bestF, focalB: bestF, select });
	let lambda = 1e-3;
	for (let iter = 0; iter < 30; iter++) {
		const params = (delta: number[]): { w: number[]; la: number; lb: number } => {
			const w = [delta[0], delta[1], delta[2]];
			let la = lnA;
			let lb = lnB;
			if (freeFocal && zoom) {
				la += delta[3];
				lb += delta[4];
			} else if (freeFocal) {
				la += delta[3];
				lb += delta[3];
			}
			return { w, la, lb };
		};
		// residual vectors for the numeric Jacobian
		const base = rotationResiduals({ pair, r, focalA: Math.exp(lnA), focalB: Math.exp(lnB), select });
		const m = base.length;
		const jac = new Float64Array(m * dims);
		const eps = 1e-6;
		for (let p = 0; p < dims; p++) {
			const delta = new Array<number>(dims).fill(0);
			delta[p] = eps;
			const q = params(delta);
			const shifted = rotationResiduals({ pair, r: mat3Mul({ a: rotExp(q.w), b: r }), focalA: Math.exp(q.la), focalB: Math.exp(q.lb), select });
			for (let i = 0; i < m; i++) jac[i * dims + p] = (shifted[i] - base[i]) / eps;
		}
		const jtj = new Float64Array(dims * dims);
		const jtr = new Float64Array(dims);
		for (let i = 0; i < m; i++) {
			for (let p = 0; p < dims; p++) {
				jtr[p] += jac[i * dims + p] * base[i];
				for (let q = 0; q < dims; q++) jtj[p * dims + q] += jac[i * dims + p] * jac[i * dims + q];
			}
		}
		let accepted = false;
		for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
			const a = Float64Array.from(jtj);
			const b = Float64Array.from(jtr, (value) => -value);
			for (let p = 0; p < dims; p++) a[p * dims + p] += lambda * jtj[p * dims + p] + 1e-12;
			if (!choleskySolve({ a, b, n: dims })) {
				lambda *= 10;
				continue;
			}
			const q = params(Array.from(b));
			const next = evaluate(q);
			if (next < cost) {
				const gain = (cost - next) / Math.max(cost, 1e-300);
				r = mat3Mul({ a: rotExp(q.w), b: r });
				lnA = q.la;
				lnB = q.lb;
				cost = next;
				lambda = Math.max(1e-9, lambda / 3);
				accepted = true;
				if (gain < 1e-9) iter = 30;
			} else {
				lambda *= 10;
			}
		}
		if (!accepted) break;
	}
	const focalA = Math.exp(lnA);
	const focalB = Math.exp(lnB);
	return { r, focalA, focalB, e2: homographyResiduals({ pair, h: rotationHomography({ r, focalA, focalB }) }) };
}

/** Transfer residuals (x and y) of the selected pairs under a rotation model. */
function rotationResiduals({
	pair,
	r,
	focalA,
	focalB,
	select,
}: {
	pair: PairData;
	r: ArrayLike<number>;
	focalA: number;
	focalB: number;
	select: Uint8Array;
}): Float64Array {
	const h = rotationHomography({ r, focalA, focalB });
	const out: number[] = [];
	for (let i = 0; i < pair.n; i++) {
		if (!select[i]) continue;
		const ax = pair.pa[2 * i];
		const ay = pair.pa[2 * i + 1];
		const w = h[6] * ax + h[7] * ay + h[8];
		out.push((h[0] * ax + h[1] * ay + h[2]) / w - pair.pb[2 * i], (h[3] * ax + h[4] * ay + h[5]) / w - pair.pb[2 * i + 1]);
	}
	return Float64Array.from(out);
}

function rotationError({
	pair,
	r,
	focalA,
	focalB,
	select,
}: {
	pair: PairData;
	r: ArrayLike<number>;
	focalA: number;
	focalB: number;
	select: Uint8Array;
}): number {
	const residuals = rotationResiduals({ pair, r, focalA, focalB, select });
	let sum = 0;
	for (const value of residuals) sum += value * value;
	return sum;
}

/** Focal lengths (frame pixels) of horizontal angles of view from 15 to 120 degrees, log-spaced. */
export function focalGrid({ frameWidth, steps }: { frameWidth: number; steps: number }): number[] {
	const lo = frameWidth / (2 * Math.tan((120 * Math.PI) / 360));
	const hi = frameWidth / (2 * Math.tan((15 * Math.PI) / 360));
	const out: number[] = [];
	for (let i = 0; i < steps; i++) out.push(lo * Math.pow(hi / lo, i / (steps - 1)));
	return out;
}

/**
 * Mendonca-Cipolla cost of a focal length over fundamental matrices (pixel
 * coordinates relative to the frame centre): mean of `(s1 - s2) / (s1 +
 * s2)` of `K^T F K`, 0 for a perfect essential matrix.
 */
export function essentialityCost({ fundamentals, focal }: { fundamentals: readonly Float64Array[]; focal: number }): number {
	if (fundamentals.length === 0) return Infinity;
	let sum = 0;
	for (const f of fundamentals) {
		const e = Float64Array.from([f[0] * focal * focal, f[1] * focal * focal, f[2] * focal, f[3] * focal * focal, f[4] * focal * focal, f[5] * focal, f[6] * focal, f[7] * focal, f[8]]);
		const { s } = svd3(e);
		sum += (s[0] - s[1]) / Math.max(s[0] + s[1], 1e-300);
	}
	return sum / fundamentals.length;
}

/** The focal length of the grid with the lowest {@link essentialityCost}, refined by golden-section search. */
export function searchFocal({ fundamentals, frameWidth }: { fundamentals: readonly Float64Array[]; frameWidth: number }): { focal: number; cost: number } | null {
	if (fundamentals.length === 0) return null;
	const grid = focalGrid({ frameWidth, steps: 60 });
	const costs = grid.map((focal) => essentialityCost({ fundamentals, focal }));
	let bestIndex = 0;
	for (let i = 1; i < grid.length; i++) if (costs[i] < costs[bestIndex]) bestIndex = i;
	let lo = Math.log(grid[Math.max(0, bestIndex - 1)]);
	let hi = Math.log(grid[Math.min(grid.length - 1, bestIndex + 1)]);
	const golden = (Math.sqrt(5) - 1) / 2;
	for (let iter = 0; iter < 30; iter++) {
		const m1 = hi - golden * (hi - lo);
		const m2 = lo + golden * (hi - lo);
		if (essentialityCost({ fundamentals, focal: Math.exp(m1) }) < essentialityCost({ fundamentals, focal: Math.exp(m2) })) hi = m2;
		else lo = m1;
	}
	const focal = Math.exp((lo + hi) / 2);
	return { focal, cost: essentialityCost({ fundamentals, focal }) };
}

/** Robust noise sigma (per image axis) from squared residuals of the best model: median / 0.6745. */
export function robustSigma({ e2 }: { e2: ArrayLike<number> }): number {
	const values = Float64Array.from({ length: e2.length }, (_, i) => Math.sqrt(e2[i]));
	return median({ values }) / 0.6745;
}
