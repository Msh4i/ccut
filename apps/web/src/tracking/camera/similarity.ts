import { tukeyCutoff } from "./robust";

/**
 * A similarity (translate, scale, rotate) as a complex map `z' = a z + b`,
 * `z = x + i y`: `a = ar + i ai`, `b = br + i bi`.
 */
export interface Similarity {
	ar: number;
	ai: number;
	br: number;
	bi: number;
}

export const IDENTITY_SIM: Similarity = { ar: 1, ai: 0, br: 0, bi: 0 };

export function applySim({
	map,
	x,
	y,
}: {
	map: Similarity;
	x: number;
	y: number;
}): { x: number; y: number } {
	return {
		x: map.ar * x - map.ai * y + map.br,
		y: map.ar * y + map.ai * x + map.bi,
	};
}

/** The map that applies `inner` first, then `outer`. */
export function composeSim({
	outer,
	inner,
}: {
	outer: Similarity;
	inner: Similarity;
}): Similarity {
	return {
		ar: outer.ar * inner.ar - outer.ai * inner.ai,
		ai: outer.ar * inner.ai + outer.ai * inner.ar,
		br: outer.ar * inner.br - outer.ai * inner.bi + outer.br,
		bi: outer.ar * inner.bi + outer.ai * inner.br + outer.bi,
	};
}

/**
 * Weighted least-squares similarity from point pairs. `za` / `zb` hold
 * interleaved `x, y`; `idx[0..n)` lists which pairs to use and `w[i]` is the
 * weight of pair `i`. Null when the pairs cannot fix a similarity (no weight,
 * or all on one point).
 */
export function fitSim({
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
}): Similarity | null {
	let sw = 0;
	let acx = 0;
	let acy = 0;
	let bcx = 0;
	let bcy = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const ww = w[i];
		sw += ww;
		acx += ww * za[2 * i];
		acy += ww * za[2 * i + 1];
		bcx += ww * zb[2 * i];
		bcy += ww * zb[2 * i + 1];
	}
	if (sw <= 1e-9) return null;
	acx /= sw;
	acy /= sw;
	bcx /= sw;
	bcy /= sw;
	let nr = 0;
	let ni = 0;
	let de = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const ww = w[i];
		const px = za[2 * i] - acx;
		const py = za[2 * i + 1] - acy;
		const qx = zb[2 * i] - bcx;
		const qy = zb[2 * i + 1] - bcy;
		// conj(p) * q
		nr += ww * (px * qx + py * qy);
		ni += ww * (px * qy - py * qx);
		de += ww * (px * px + py * py);
	}
	if (de < 1e-9) return null;
	const ar = nr / de;
	const ai = ni / de;
	return {
		ar,
		ai,
		br: bcx - (ar * acx - ai * acy),
		bi: bcy - (ar * acy + ai * acx),
	};
}

/**
 * RANSAC with two-point hypotheses. Points are drawn in proportion to
 * `weights` (a zero weight is never drawn), a hypothesis needs its two points
 * `minSep` apart and a scale between 0.5 and 2, and scores the weight of the
 * pairs it explains within `tau` pixels. Returns the best hypothesis, or null
 * when no hypothesis could be formed.
 */
export function ransacSim({
	za,
	zb,
	n,
	weights,
	options,
	random,
}: {
	za: ArrayLike<number>;
	zb: ArrayLike<number>;
	n: number;
	weights: ArrayLike<number>;
	options: { hyp: number; tau: number; minSep: number };
	random: () => number;
}): Similarity | null {
	const cum = new Float64Array(n);
	let total = 0;
	for (let i = 0; i < n; i++) {
		total += weights[i];
		cum[i] = total;
	}
	if (total < 1e-6) return null;
	const pick = () => {
		const r = random() * total;
		let lo = 0;
		let hi = n - 1;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (cum[m] < r) lo = m + 1;
			else hi = m;
		}
		return lo;
	};
	const tau2 = options.tau * options.tau;
	const minSep2 = options.minSep * options.minSep;
	let best: Similarity | null = null;
	let bestScore = -1;
	for (let h = 0; h < options.hyp; h++) {
		const i = pick();
		const j = pick();
		if (i === j) continue;
		const dx = za[2 * i] - za[2 * j];
		const dy = za[2 * i + 1] - za[2 * j + 1];
		const dd = dx * dx + dy * dy;
		if (dd < minSep2) continue;
		const ex = zb[2 * i] - zb[2 * j];
		const ey = zb[2 * i + 1] - zb[2 * j + 1];
		// a = (zb_i - zb_j) / (za_i - za_j)
		const ar = (ex * dx + ey * dy) / dd;
		const ai = (ey * dx - ex * dy) / dd;
		const scale = Math.hypot(ar, ai);
		if (scale < 0.5 || scale > 2) continue;
		const br = zb[2 * i] - (ar * za[2 * i] - ai * za[2 * i + 1]);
		const bi = zb[2 * i + 1] - (ar * za[2 * i + 1] + ai * za[2 * i]);
		let score = 0;
		for (let k = 0; k < n; k++) {
			if (weights[k] === 0) continue;
			const px = ar * za[2 * k] - ai * za[2 * k + 1] + br - zb[2 * k];
			const py = ar * za[2 * k + 1] + ai * za[2 * k] + bi - zb[2 * k + 1];
			if (px * px + py * py < tau2) score += weights[k];
		}
		if (score > bestScore) {
			bestScore = score;
			best = { ar, ai, br, bi };
		}
	}
	return best;
}

/** Working memory of `refineSim` / `refineH`, `n` entries each. */
export interface RefineScratch {
	residuals: Float64Array;
	refinedWeights: Float64Array;
	workIdx: Int32Array;
	tmp: Float64Array;
	/** The inliers of the last accepted round, `nin` entries. */
	inliers: Int32Array;
}

export function createRefineScratch({ n }: { n: number }): RefineScratch {
	return {
		residuals: new Float64Array(n),
		refinedWeights: new Float64Array(n),
		workIdx: new Int32Array(n),
		tmp: new Float64Array(n),
		inliers: new Int32Array(n),
	};
}

export interface RefineOptions {
	/** Rounds of reweighting. */
	irls: number;
	/** Residuals above this (px) do not take part in the scale estimate. */
	scaleWin: number;
	sMin: number;
	sMax: number;
	cFac: number;
	minInl: number;
}

export interface SimilarityRefinement {
	model: Similarity;
	/** Pairs inside the final Tukey cutoff. */
	nin: number;
	/** Their summed weight, and the weighted sum of their squared residuals. */
	mass: number;
	rss: number;
}

/**
 * Iteratively reweighted least squares from a RANSAC start: every round sets
 * the Tukey cutoff from the median residual, drops what lies beyond it and
 * refits with biweights times the pair's own weight. No hard inlier cut. Null
 * when fewer than two pairs survive the first round.
 */
export function refineSim({
	za,
	zb,
	n,
	weights,
	start,
	options,
	scratch,
}: {
	za: ArrayLike<number>;
	zb: ArrayLike<number>;
	n: number;
	weights: ArrayLike<number>;
	start: Similarity;
	options: RefineOptions;
	scratch: RefineScratch;
}): SimilarityRefinement | null {
	const { residuals, refinedWeights, workIdx, tmp, inliers } = scratch;
	let model = start;
	let nin = 0;
	let mass = 0;
	let rss = 0;
	for (let round = 0; round < options.irls; round++) {
		for (let k = 0; k < n; k++) {
			if (weights[k] === 0) {
				residuals[k] = 1e9;
				continue;
			}
			const px = model.ar * za[2 * k] - model.ai * za[2 * k + 1] + model.br - zb[2 * k];
			const py = model.ar * za[2 * k + 1] + model.ai * za[2 * k] + model.bi - zb[2 * k + 1];
			residuals[k] = Math.sqrt(px * px + py * py);
		}
		const c = tukeyCutoff({
			residuals,
			n,
			window: options.scaleWin,
			minCount: 3,
			sMin: options.sMin,
			sMax: options.sMax,
			cFac: options.cFac,
			scratch: tmp,
		});
		if (c < 0) break;
		let count = 0;
		let roundMass = 0;
		let roundRss = 0;
		for (let k = 0; k < n; k++) {
			if (residuals[k] < c) {
				const u = 1 - (residuals[k] / c) * (residuals[k] / c);
				refinedWeights[k] = weights[k] * u * u;
				workIdx[count++] = k;
				roundMass += weights[k];
				roundRss += weights[k] * residuals[k] * residuals[k];
			} else {
				refinedWeights[k] = 0;
			}
		}
		if (count < Math.max(3, options.minInl)) break;
		const refit = fitSim({ za, zb, w: refinedWeights, idx: workIdx, n: count });
		if (!refit) break;
		model = refit;
		nin = count;
		mass = roundMass;
		rss = roundRss;
		for (let q = 0; q < count; q++) inliers[q] = workIdx[q];
	}
	if (nin < 2) return null;
	return { model, nin, mass, rss };
}
