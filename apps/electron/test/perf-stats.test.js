const { describe, expect, test } = require("bun:test");
const { detectCliff, percentile, summarizeLongTasks, summarizeSeries, summarizeTimestamps } = require("./perf/stats");

// Frame statistics of the playback harness (perf-two-clips.js): percentiles with the HUD's rule,
// fps and frame intervals per 5 s bucket, long tasks, the "cliff after 5 s".

// n frames at a fixed interval starting at `from`
const ticks = ({ from = 0, n, every }) => Array.from({ length: n }, (_, i) => from + i * every);

describe("percentile (nearest rank, the playback HUD's rule)", () => {
	test("sorted[min(n - 1, floor(n * q))] of a copy; the input is not reordered", () => {
		const values = [40, 10, 30, 20];
		expect(percentile({ values, q: 0.5 })).toBe(30);
		expect(percentile({ values, q: 0.95 })).toBe(40);
		expect(percentile({ values, q: 0 })).toBe(10);
		expect(percentile({ values, q: 1 })).toBe(40);
		expect(values).toEqual([40, 10, 30, 20]);
	});

	test("20 values: p95 is the 20th smallest (index 19), p50 the 11th", () => {
		const values = Array.from({ length: 20 }, (_, i) => i + 1);
		expect(percentile({ values, q: 0.95 })).toBe(20);
		expect(percentile({ values, q: 0.5 })).toBe(11);
	});

	test("empty is null; non-finite values are ignored", () => {
		expect(percentile({ values: [], q: 0.5 })).toBeNull();
		expect(percentile({ values: [Number.NaN, 5, Number.POSITIVE_INFINITY], q: 0.5 })).toBe(5);
	});

	test("the same answers as the HUD's own percentile (apps/web session.ts)", () => {
		const hud = require("../../web/src/diagnostics/playback-hud/session.ts");
		const values = [33.3, 16.7, 50, 16.6, 33.4, 66.7, 16.7, 100, 33.3, 16.8, 17, 35];
		for (const q of [0, 0.25, 0.5, 0.9, 0.95, 0.99, 1]) expect(percentile({ values, q })).toBe(hud.percentile({ values, q }));
	});
});

describe("summarizeTimestamps", () => {
	test("a steady 30 fps for 10 s: two complete 5 s buckets of 30 fps, intervals of 33.3 ms", () => {
		const summary = summarizeTimestamps({ timestamps: ticks({ from: 1000, n: 300, every: 1000 / 30 }), startMs: 1000, endMs: 11_000, bucketMs: 5000 });
		expect(summary.frames).toBe(300);
		expect(summary.seconds).toBe(10);
		expect(summary.fps).toBeCloseTo(30, 6);
		expect(summary.intervalP50Ms).toBeCloseTo(33.333, 2);
		expect(summary.intervalP95Ms).toBeCloseTo(33.333, 2);
		expect(summary.buckets.map((b) => [b.fromS, b.toS, b.complete, b.frames])).toEqual([
			[0, 5, true, 150],
			[5, 10, true, 150],
		]);
		expect(summary.buckets[0].fps).toBeCloseTo(30, 6);
	});

	test("only timestamps inside [start, end) count; the first frame of the window has no interval", () => {
		const summary = summarizeTimestamps({ timestamps: [0, 900, 1000, 1100, 1300, 2000, 2100], startMs: 1000, endMs: 2000, bucketMs: 1000 });
		expect(summary.frames).toBe(3);
		expect(summary.intervalMaxMs).toBe(200);
		expect(summary.intervalP50Ms).toBe(200);
		expect(summary.buckets).toHaveLength(1);
		expect(summary.buckets[0].intervalMaxMs).toBe(200);
	});

	test("an interval belongs to the bucket of the frame that ends it (a stall shows where the eye sees it)", () => {
		// frames every 100 ms, then a 700 ms gap that ends at 1300 ms (second bucket)
		const summary = summarizeTimestamps({ timestamps: [0, 100, 200, 300, 400, 500, 600, 1300, 1400, 1500], startMs: 0, endMs: 2000, bucketMs: 1000 });
		expect(summary.buckets[0].intervalMaxMs).toBe(100);
		expect(summary.buckets[1].intervalMaxMs).toBe(700);
		expect(summary.buckets[1].frames).toBe(3);
		expect(summary.intervalMaxMs).toBe(700);
	});

	test("a partial last bucket is marked incomplete and its fps uses the covered time", () => {
		const summary = summarizeTimestamps({ timestamps: ticks({ n: 60, every: 100 }), startMs: 0, endMs: 6000, bucketMs: 5000 });
		expect(summary.buckets.map((b) => [b.fromS, b.toS, b.complete, b.frames])).toEqual([
			[0, 5, true, 50],
			[5, 6, false, 10],
		]);
		expect(summary.buckets[1].fps).toBeCloseTo(10, 6);
	});

	test("unsorted input and non-numbers are handled; an empty window has no fps", () => {
		const summary = summarizeTimestamps({ timestamps: [400, "x", 100, null, 300, 200], startMs: 0, endMs: 1000, bucketMs: 1000 });
		expect(summary.frames).toBe(4);
		expect(summary.intervalP50Ms).toBe(100);
		expect(summary.intervalMaxMs).toBe(100);
		const empty = summarizeTimestamps({ timestamps: [5], startMs: 10, endMs: 10, bucketMs: 1000 });
		expect(empty).toEqual({ frames: 0, seconds: 0, fps: null, intervalP50Ms: null, intervalP95Ms: null, intervalMaxMs: null, buckets: [] });
	});

	test("a bucket without frames: 0 fps, null intervals", () => {
		const summary = summarizeTimestamps({ timestamps: [100, 200], startMs: 0, endMs: 2000, bucketMs: 1000 });
		expect(summary.buckets[1]).toEqual({ fromS: 1, toS: 2, complete: true, frames: 0, fps: 0, intervalP50Ms: null, intervalP95Ms: null, intervalMaxMs: null });
	});
});

describe("summarizeLongTasks", () => {
	test("count, total and longest inside the window, per bucket by start time", () => {
		const tasks = [
			{ startMs: 500, durationMs: 80 },
			{ startMs: 1200, durationMs: 60 },
			{ startMs: 1300, durationMs: 200 },
			{ startMs: 6200, durationMs: 55 },
			{ startMs: 9000, durationMs: 300 },
		];
		const summary = summarizeLongTasks({ tasks, startMs: 1000, endMs: 7000, bucketMs: 5000 });
		expect(summary).toEqual({
			count: 3,
			totalMs: 315,
			maxMs: 200,
			buckets: [
				{ fromS: 0, toS: 5, count: 2, totalMs: 260 },
				{ fromS: 5, toS: 6, count: 1, totalMs: 55 },
			],
		});
	});

	test("none: zeros, longest null", () => {
		expect(summarizeLongTasks({ tasks: [], startMs: 0, endMs: 1000, bucketMs: 1000 })).toEqual({ count: 0, totalMs: 0, maxMs: null, buckets: [{ fromS: 0, toS: 1, count: 0, totalMs: 0 }] });
	});
});

describe("detectCliff", () => {
	const bucket = (fromS, fps, complete = true) => ({ fromS, toS: fromS + 5, complete, fps });

	test("a later complete bucket below 90 % of the first is a cliff", () => {
		const result = detectCliff({ buckets: [bucket(0, 30), bucket(5, 29), bucket(10, 26.9), bucket(15, 28)], ratio: 0.9 });
		expect(result).toEqual({ firstFps: 30, worstLaterFps: 26.9, worstLaterFromS: 10, cliff: true });
	});

	test("exactly 90 % is not a cliff, also where 0.9 * first rounds up in floating point; incomplete buckets do not count", () => {
		expect(detectCliff({ buckets: [bucket(0, 30), bucket(5, 27), bucket(10, 5, false)], ratio: 0.9 }).cliff).toBe(false);
		expect(21 * 0.9).toBeGreaterThan(18.9);
		expect(detectCliff({ buckets: [bucket(0, 21), bucket(5, 18.9)], ratio: 0.9 }).cliff).toBe(false);
	});

	test("fewer than two complete buckets: cannot tell (null)", () => {
		expect(detectCliff({ buckets: [bucket(0, 30), bucket(5, 3, false)], ratio: 0.9 })).toEqual({ firstFps: 30, worstLaterFps: null, worstLaterFromS: null, cliff: null });
		expect(detectCliff({ buckets: [], ratio: 0.9 }).cliff).toBeNull();
	});
});

describe("summarizeSeries", () => {
	test("first, last, min, max, mean and p95 of a numeric series; nulls skipped", () => {
		expect(summarizeSeries([3, null, 1, 2, 10])).toEqual({ first: 3, last: 10, min: 1, max: 10, mean: 4, p95: 10, n: 4 });
		expect(summarizeSeries([])).toEqual({ first: null, last: null, min: null, max: null, mean: null, p95: null, n: 0 });
	});
});
