import type { RefineOptions, RefineScratch } from "./similarity";
import { tukeyCutoff } from "./robust";

/**
 * A homography is a 3x3 matrix, row-major, with `h[8] = 1` once normalised:
 * `(x, y) -> ((h0 x + h1 y + h2) / w, (h3 x + h4 y + h5) / w)` with
 * `w = h6 x + h7 y + h8`.
 */
export const IDENTITY_H: Readonly<Float64Array> = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function hApply({
	h,
	x,
	y,
}: {
	h: ArrayLike<number>;
	x: number;
	y: number;
}): { x: number; y: number } {
	const w = h[6] * x + h[7] * y + h[8];
	return {
		x: (h[0] * x + h[1] * y + h[2]) / w,
		y: (h[3] * x + h[4] * y + h[5]) / w,
	};
}

/** The warp that applies `right` first, then `left`. */
export function hMul({
	left,
	right,
}: {
	left: ArrayLike<number>;
	right: ArrayLike<number>;
}): Float64Array {
	const out = new Float64Array(9);
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			let sum = 0;
			for (let k = 0; k < 3; k++) sum += left[i * 3 + k] * right[k * 3 + j];
			out[i * 3 + j] = sum;
		}
	}
	return out;
}

/** Solves `A x = b` for an `n x n` row-major system in place; null when singular. */
function solveLinear({
	a,
	b,
	n,
}: {
	a: Float64Array;
	b: Float64Array;
	n: number;
}): Float64Array | null {
	for (let i = 0; i < n; i++) {
		let pivot = i;
		for (let r = i + 1; r < n; r++) {
			if (Math.abs(a[r * n + i]) > Math.abs(a[pivot * n + i])) pivot = r;
		}
		if (Math.abs(a[pivot * n + i]) < 1e-12) return null;
		if (pivot !== i) {
			for (let c = 0; c < n; c++) {
				const t = a[i * n + c];
				a[i * n + c] = a[pivot * n + c];
				a[pivot * n + c] = t;
			}
			const t = b[i];
			b[i] = b[pivot];
			b[pivot] = t;
		}
		for (let r = i + 1; r < n; r++) {
			const f = a[r * n + i] / a[i * n + i];
			if (f === 0) continue;
			for (let c = i; c < n; c++) a[r * n + c] -= f * a[i * n + c];
			b[r] -= f * b[i];
		}
	}
	const x = new Float64Array(n);
	for (let i = n - 1; i >= 0; i--) {
		let s = b[i];
		for (let c = i + 1; c < n; c++) s -= a[i * n + c] * x[c];
		x[i] = s / a[i * n + i];
	}
	return x;
}

/**
 * Weighted least-squares homography (normalised DLT with `h33 = 1`) from point
 * pairs: `idx[0..n)` lists the pairs, `w[i]` weights pair `i`. Points are
 * centred and scaled to a mean distance of sqrt(2) first, which is what keeps
 * the 8x8 system well conditioned. Null when the pairs cannot fix a warp.
 */
export function fitH({
	za,
	zb,
	w,
	idx,
	n,
}: {
	za: ArrayLike<number>;
	zb: ArrayLike<number>;
	w: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): Float64Array | null {
	let acx = 0;
	let acy = 0;
	let bcx = 0;
	let bcy = 0;
	let sw = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const ww = w[i];
		sw += ww;
		acx += ww * za[2 * i];
		acy += ww * za[2 * i + 1];
		bcx += ww * zb[2 * i];
		bcy += ww * zb[2 * i + 1];
	}
	if (sw < 1e-9) return null;
	acx /= sw;
	acy /= sw;
	bcx /= sw;
	bcy /= sw;
	let da = 0;
	let db = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const ww = w[i];
		da += ww * Math.hypot(za[2 * i] - acx, za[2 * i + 1] - acy);
		db += ww * Math.hypot(zb[2 * i] - bcx, zb[2 * i + 1] - bcy);
	}
	da /= sw;
	db /= sw;
	if (da < 1e-6 || db < 1e-6) return null;
	const sa = Math.SQRT2 / da;
	const sb = Math.SQRT2 / db;

	const a = new Float64Array(64);
	const rhs = new Float64Array(8);
	const row1 = new Float64Array(8);
	const row2 = new Float64Array(8);
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const ww = w[i];
		const x = (za[2 * i] - acx) * sa;
		const y = (za[2 * i + 1] - acy) * sa;
		const u = (zb[2 * i] - bcx) * sb;
		const v = (zb[2 * i + 1] - bcy) * sb;
		// [x y 1 0 0 0 -u x -u y] h = u and [0 0 0 x y 1 -v x -v y] h = v
		row1[0] = x;
		row1[1] = y;
		row1[2] = 1;
		row1[3] = 0;
		row1[4] = 0;
		row1[5] = 0;
		row1[6] = -u * x;
		row1[7] = -u * y;
		row2[0] = 0;
		row2[1] = 0;
		row2[2] = 0;
		row2[3] = x;
		row2[4] = y;
		row2[5] = 1;
		row2[6] = -v * x;
		row2[7] = -v * y;
		for (let r = 0; r < 8; r++) {
			for (let c = 0; c < 8; c++) {
				a[r * 8 + c] += ww * (row1[r] * row1[c] + row2[r] * row2[c]);
			}
			rhs[r] += ww * (row1[r] * u + row2[r] * v);
		}
	}
	const h = solveLinear({ a, b: rhs, n: 8 });
	if (!h) return null;
	// Hn maps normalised a to normalised b, so H = Tb^-1 Hn Ta
	const hn = Float64Array.from([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
	const ta = Float64Array.from([sa, 0, -sa * acx, 0, sa, -sa * acy, 0, 0, 1]);
	const tbInv = Float64Array.from([1 / sb, 0, bcx, 0, 1 / sb, bcy, 0, 0, 1]);
	const full = hMul({ left: tbInv, right: hMul({ left: hn, right: ta }) });
	const scale = full[8];
	if (Math.abs(scale) < 1e-12) return null;
	for (let i = 0; i < 9; i++) full[i] /= scale;
	return full;
}

function reprojectionError({
	h,
	ax,
	ay,
	bx,
	by,
}: {
	h: ArrayLike<number>;
	ax: number;
	ay: number;
	bx: number;
	by: number;
}): number {
	const w = h[6] * ax + h[7] * ay + h[8];
	if (Math.abs(w) < 1e-9) return 1e9;
	const x = (h[0] * ax + h[1] * ay + h[2]) / w;
	const y = (h[3] * ax + h[4] * ay + h[5]) / w;
	return Math.hypot(x - bx, y - by);
}

/**
 * RANSAC with four-point hypotheses drawn uniformly. The four points must be
 * `minSep` apart from each other (20 tries per point, a draw that needs all of
 * them is dropped), and a warp with `|h31|` or `|h32|` above 0.01 is not a
 * camera frame's perspective and is skipped. Score is the number of pairs
 * within `tau` pixels. Null when no hypothesis survived.
 */
export function ransacH({
	za,
	zb,
	n,
	options,
	random,
}: {
	za: ArrayLike<number>;
	zb: ArrayLike<number>;
	n: number;
	options: { hyp: number; tau: number; minSep: number };
	random: () => number;
}): Float64Array | null {
	const chosen = new Int32Array(4);
	const ones = new Float64Array(n).fill(1);
	let best: Float64Array | null = null;
	let bestScore = -1;
	for (let h = 0; h < options.hyp; h++) {
		let ok = true;
		for (let k = 0; k < 4; k++) {
			let i = 0;
			let tries = 0;
			let rejected = true;
			while (tries < 20 && rejected) {
				i = Math.floor(random() * n);
				tries++;
				rejected = false;
				for (let m = 0; m < k && !rejected; m++) {
					const j = chosen[m];
					if (
						i === j ||
						Math.hypot(za[2 * i] - za[2 * j], za[2 * i + 1] - za[2 * j + 1]) < options.minSep
					) {
						rejected = true;
					}
				}
			}
			if (tries >= 20) {
				ok = false;
				break;
			}
			chosen[k] = i;
		}
		if (!ok) continue;
		const hyp = fitH({ za, zb, w: ones, idx: chosen, n: 4 });
		if (!hyp) continue;
		if (Math.abs(hyp[6]) > 0.01 || Math.abs(hyp[7]) > 0.01) continue;
		let score = 0;
		for (let k = 0; k < n; k++) {
			if (reprojectionError({ h: hyp, ax: za[2 * k], ay: za[2 * k + 1], bx: zb[2 * k], by: zb[2 * k + 1] }) < options.tau) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			best = hyp;
		}
	}
	return best;
}

export interface HomographyRefinement {
	h: Float64Array;
	nin: number;
	/** Sum of squared residuals of the final inliers. */
	rss: number;
}

/**
 * The `refineSim` loop for a homography: Tukey cutoff from the median
 * residual (at least 8 residuals inside the window, 8 inliers to refit),
 * biweights as weights. Null when no round was accepted.
 */
export function refineH({
	za,
	zb,
	n,
	start,
	options,
	scratch,
}: {
	za: ArrayLike<number>;
	zb: ArrayLike<number>;
	n: number;
	start: Float64Array;
	options: RefineOptions;
	scratch: RefineScratch;
}): HomographyRefinement | null {
	const { residuals, refinedWeights, workIdx, tmp, inliers } = scratch;
	const minInliers = Math.max(8, options.minInl);
	let h = start;
	let nin = 0;
	let rss = 0;
	for (let round = 0; round < options.irls; round++) {
		for (let k = 0; k < n; k++) {
			residuals[k] = reprojectionError({ h, ax: za[2 * k], ay: za[2 * k + 1], bx: zb[2 * k], by: zb[2 * k + 1] });
		}
		const c = tukeyCutoff({
			residuals,
			n,
			window: options.scaleWin,
			minCount: 8,
			sMin: options.sMin,
			sMax: options.sMax,
			cFac: options.cFac,
			scratch: tmp,
		});
		if (c < 0) break;
		let count = 0;
		let roundRss = 0;
		for (let k = 0; k < n; k++) {
			if (residuals[k] < c) {
				const u = 1 - (residuals[k] / c) * (residuals[k] / c);
				refinedWeights[k] = u * u;
				workIdx[count++] = k;
				roundRss += residuals[k] * residuals[k];
			} else {
				refinedWeights[k] = 0;
			}
		}
		if (count < minInliers) break;
		const refit = fitH({ za, zb, w: refinedWeights, idx: workIdx, n: count });
		if (!refit) break;
		h = refit;
		nin = count;
		rss = roundRss;
		for (let q = 0; q < count; q++) inliers[q] = workIdx[q];
	}
	if (nin < minInliers) return null;
	return { h, nin, rss };
}
