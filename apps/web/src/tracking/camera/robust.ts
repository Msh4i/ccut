/** 1.1774 = sqrt(2 ln 2): turns a median absolute deviation into a Gaussian sigma. */
const MEDIAN_TO_SIGMA = 1.1774;

/**
 * Cutoff `c` of the Tukey biweight for a set of residuals: `cFac` times a robust
 * sigma taken from the median of the residuals inside `window`, kept between
 * `sMin` and `sMax` (the floor stops a perfect fit from rejecting everything,
 * the ceiling stops a bad one from accepting everything).
 *
 * Only the first `n` residuals count, and only those below `window`. Returns -1
 * when fewer than `minCount` of them qualify. `scratch` needs room for `n`
 * values; `residuals` is not changed.
 */
export function tukeyCutoff({
	residuals,
	n,
	window,
	minCount,
	sMin,
	sMax,
	cFac,
	scratch,
}: {
	residuals: ArrayLike<number>;
	n: number;
	window: number;
	minCount: number;
	sMin: number;
	sMax: number;
	cFac: number;
	scratch: Float64Array;
}): number {
	let count = 0;
	for (let k = 0; k < n; k++) {
		if (residuals[k] < window) scratch[count++] = residuals[k];
	}
	if (count === 0 || count < minCount) return -1;
	const sorted = scratch.subarray(0, count).sort();
	return cFac * Math.min(sMax, Math.max(sMin, sorted[count >> 1] / MEDIAN_TO_SIGMA));
}
