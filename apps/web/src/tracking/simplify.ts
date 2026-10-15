/**
 * Ramer-Douglas-Peucker over samples whose error is measured by `error`: the
 * deviation of sample `index` from the straight line, in time, between the two
 * kept samples `lo` and `hi` around it. That is exactly what a linear keyframe
 * pair plays back, so every original sample ends up within `epsilon` of the
 * result. Returns the ascending indices to keep; the first and last are always
 * kept.
 */
function simplifyBy({
	count,
	epsilon,
	error,
	pinned = [],
}: {
	count: number;
	epsilon: number;
	error: ({ index, lo, hi }: { index: number; lo: number; hi: number }) => number;
	/** Samples that are kept whatever their error. */
	pinned?: ArrayLike<number>;
}): number[] {
	if (count <= 2) {
		return Array.from({ length: count }, (_, index) => index);
	}

	const keep = new Uint8Array(count);
	keep[0] = 1;
	keep[count - 1] = 1;
	for (let i = 0; i < pinned.length; i++) {
		const index = pinned[i];
		if (Number.isInteger(index) && index > 0 && index < count - 1) keep[index] = 1;
	}
	// each stretch between two kept samples is simplified on its own
	const ranges: number[] = [];
	let from = 0;
	for (let i = 1; i < count; i++) {
		if (!keep[i]) continue;
		ranges.push(from, i);
		from = i;
	}

	for (;;) {
		const hi = ranges.pop();
		const lo = ranges.pop();
		if (hi === undefined || lo === undefined) break;
		if (hi - lo < 2) continue;

		let worstIndex = -1;
		let worstError = epsilon;
		for (let i = lo + 1; i < hi; i++) {
			const deviation = error({ index: i, lo, hi });
			if (deviation > worstError) {
				worstError = deviation;
				worstIndex = i;
			}
		}

		if (worstIndex >= 0) {
			keep[worstIndex] = 1;
			ranges.push(lo, worstIndex, worstIndex, hi);
		}
	}

	const kept: number[] = [];
	for (let i = 0; i < count; i++) {
		if (keep[i]) kept.push(i);
	}
	return kept;
}

/**
 * Ramer-Douglas-Peucker for one channel: the keys a linear keyframe channel needs
 * so that every sample is within `epsilon` of what it plays back. With
 * `relative`, the error is a share of the sample's own size (`|dev| / |value|`),
 * which is what a scale wants: 0.1 on a scale of 1 matters, on a scale of 10
 * it does not. `pinned` samples are kept as keys too, which splits the series
 * there: the stretches between are simplified on their own.
 */
export function simplifySeries({
	times,
	values,
	epsilon,
	relative = false,
	pinned,
}: {
	times: ArrayLike<number>;
	values: ArrayLike<number>;
	epsilon: number;
	relative?: boolean;
	/** Indices of samples that stay whatever their error (the ends always do). */
	pinned?: ArrayLike<number>;
}): number[] {
	return simplifyBy({
		count: times.length,
		epsilon,
		pinned,
		error: ({ index, lo, hi }) => {
			const span = times[hi] - times[lo];
			const f = span > 0 ? (times[index] - times[lo]) / span : 0;
			const deviation = Math.abs(values[lo] + (values[hi] - values[lo]) * f - values[index]);
			return relative ? deviation / Math.max(Math.abs(values[index]), 1e-12) : deviation;
		},
	});
}
