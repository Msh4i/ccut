// Frame statistics for the playback harness (perf-two-clips.js). Pure: numbers in, numbers out.
// Times are milliseconds on one clock (the page's performance.now() for frames and long tasks).

const EPSILON = 1e-6;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Same rule as the playback HUD (apps/web/src/diagnostics/playback-hud/session.ts): sorted[min(n-1, floor(n*q))]. */
function percentile({ values, q }) {
	const sorted = values.filter(isNumber).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** The buckets of [startMs, endMs): { index, fromMs, toMs, fromS, toS, complete }; the last one may be partial. */
function bucketsOf({ startMs, endMs, bucketMs }) {
	if (!(endMs > startMs) || !(bucketMs > 0)) return [];
	const count = Math.ceil((endMs - startMs) / bucketMs - EPSILON);
	const out = [];
	for (let index = 0; index < count; index++) {
		const fromMs = startMs + index * bucketMs;
		const toMs = Math.min(fromMs + bucketMs, endMs);
		out.push({ index, fromMs, toMs, fromS: (index * bucketMs) / 1000, toS: (toMs - startMs) / 1000, complete: fromMs + bucketMs <= endMs + EPSILON });
	}
	return out;
}

const bucketIndexOf = ({ atMs, startMs, bucketMs }) => Math.floor((atMs - startMs) / bucketMs);

const intervalStats = (intervals) => ({
	intervalP50Ms: percentile({ values: intervals, q: 0.5 }),
	intervalP95Ms: percentile({ values: intervals, q: 0.95 }),
	intervalMaxMs: intervals.length > 0 ? intervals.reduce((max, value) => Math.max(max, value)) : null,
});

/**
 * Frame timestamps -> fps and frame intervals for the window [startMs, endMs), overall and per
 * bucket. Like the HUD: the first frame of the window has no interval; an interval belongs to the
 * bucket of the frame that ends it (a stall is counted where it becomes visible).
 */
function summarizeTimestamps({ timestamps, startMs, endMs, bucketMs }) {
	const buckets = bucketsOf({ startMs, endMs, bucketMs });
	if (buckets.length === 0) {
		return { frames: 0, seconds: 0, fps: null, intervalP50Ms: null, intervalP95Ms: null, intervalMaxMs: null, buckets: [] };
	}
	const frames = timestamps.filter((t) => isNumber(t) && t >= startMs && t < endMs).sort((a, b) => a - b);
	const perBucket = buckets.map(() => ({ frames: 0, intervals: [] }));
	const intervals = [];
	for (let i = 0; i < frames.length; i++) {
		const slot = perBucket[bucketIndexOf({ atMs: frames[i], startMs, bucketMs })];
		slot.frames += 1;
		if (i > 0) {
			const interval = frames[i] - frames[i - 1];
			slot.intervals.push(interval);
			intervals.push(interval);
		}
	}
	const seconds = (endMs - startMs) / 1000;
	return {
		frames: frames.length,
		seconds,
		fps: frames.length / seconds,
		...intervalStats(intervals),
		buckets: buckets.map((bucket, index) => ({
			fromS: bucket.fromS,
			toS: bucket.toS,
			complete: bucket.complete,
			frames: perBucket[index].frames,
			fps: perBucket[index].frames / ((bucket.toMs - bucket.fromMs) / 1000),
			...intervalStats(perBucket[index].intervals),
		})),
	};
}

/** Long tasks ({ startMs, durationMs }) that start inside the window: count, total, longest, per bucket. */
function summarizeLongTasks({ tasks, startMs, endMs, bucketMs }) {
	const buckets = bucketsOf({ startMs, endMs, bucketMs });
	const perBucket = buckets.map((bucket) => ({ fromS: bucket.fromS, toS: bucket.toS, count: 0, totalMs: 0 }));
	let count = 0;
	let totalMs = 0;
	let maxMs = null;
	for (const task of tasks) {
		if (!task || !isNumber(task.startMs) || !isNumber(task.durationMs)) continue;
		if (task.startMs < startMs || task.startMs >= endMs) continue;
		const slot = perBucket[bucketIndexOf({ atMs: task.startMs, startMs, bucketMs })];
		slot.count += 1;
		slot.totalMs += task.durationMs;
		count += 1;
		totalMs += task.durationMs;
		maxMs = maxMs === null ? task.durationMs : Math.max(maxMs, task.durationMs);
	}
	return { count, totalMs, maxMs, buckets: perBucket };
}

/**
 * "No cliff after 5 s": the worst later COMPLETE bucket against the first one. cliff = worst <
 * ratio * first; null when there are not two complete buckets to compare.
 */
function detectCliff({ buckets, ratio }) {
	const complete = buckets.filter((bucket) => bucket.complete && isNumber(bucket.fps));
	const firstFps = complete.length > 0 ? complete[0].fps : null;
	const later = complete.slice(1);
	if (later.length === 0) return { firstFps, worstLaterFps: null, worstLaterFromS: null, cliff: null };
	const worst = later.reduce((low, bucket) => (bucket.fps < low.fps ? bucket : low));
	return { firstFps, worstLaterFps: worst.fps, worstLaterFromS: worst.fromS, cliff: worst.fps < firstFps * ratio - EPSILON };
}

/** first / last / min / max / mean / p95 of the numbers of a series (null entries skipped). */
function summarizeSeries(values) {
	const numbers = values.filter(isNumber);
	if (numbers.length === 0) return { first: null, last: null, min: null, max: null, mean: null, p95: null, n: 0 };
	return {
		first: numbers[0],
		last: numbers[numbers.length - 1],
		min: numbers.reduce((min, value) => Math.min(min, value)),
		max: numbers.reduce((max, value) => Math.max(max, value)),
		mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
		p95: percentile({ values: numbers, q: 0.95 }),
		n: numbers.length,
	};
}

module.exports = { bucketsOf, detectCliff, isNumber, percentile, summarizeLongTasks, summarizeSeries, summarizeTimestamps };
