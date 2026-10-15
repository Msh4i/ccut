import { describe, expect, test } from "bun:test";
import {
	PlaybackSession,
	type HudCacheCounters,
	type HudFrameSample,
	formatSummary,
	frameSampleFromProbes,
	parseHudFlag,
	percentile,
} from "../session";

const NO_CACHE: HudCacheCounters = {
	hits: 0,
	readAheadHits: 0,
	advances: 0,
	restarts: 0,
	stalePresents: 0,
	draws: 0,
	skipped: 0,
	errors: 0,
	waitMs: 0,
};

function frame({
	atMs,
	renderMs = 10,
	decodeWaitMs = 0,
	uploads = 2,
	cache = {},
}: {
	atMs: number;
	renderMs?: number;
	decodeWaitMs?: number;
	uploads?: number;
	cache?: Partial<HudCacheCounters>;
}): HudFrameSample {
	return {
		atMs,
		renderMs,
		decodeWaitMs,
		uploads,
		uploadedPixels: uploads * 100,
		cache: { ...NO_CACHE, ...cache },
		effectPasses: 0,
	};
}

describe("percentile", () => {
	test("nearest rank on the sorted values, like render-perf", () => {
		expect(percentile({ values: [5, 1, 4, 2, 3], q: 0.5 })).toBe(3);
		expect(percentile({ values: [5, 1, 4, 2, 3], q: 0.95 })).toBe(5);
		expect(percentile({ values: [7], q: 0.95 })).toBe(7);
	});

	test("no values: null", () => {
		expect(percentile({ values: [], q: 0.5 })).toBeNull();
	});
});

describe("PlaybackSession buckets since play started", () => {
	test("fps per 5 s bucket shows a drop after the first five seconds", () => {
		const session = new PlaybackSession({ startMs: 1000 });
		// 0-5 s: a draw every 1000/60 ms; 5-10 s: a draw every 100 ms
		for (let i = 1; i <= 300; i++) session.addFrame(frame({ atMs: 1000 + (i * 1000) / 60 }));
		for (let i = 1; i <= 49; i++) session.addFrame(frame({ atMs: 6000 + i * 100 }));
		const rows = session.rows({ bucketSeconds: 5, nowMs: 11000 });
		expect(rows.map((row) => [row.fromS, row.toS])).toEqual([
			[0, 5],
			[5, 10],
		]);
		// the 300th draw lands exactly on 5 s: it opens the second bucket
		expect(rows[0].frames).toBe(299);
		expect(rows[0].fps).toBeCloseTo(59.8, 6);
		expect(rows[1].frames).toBe(50);
		expect(rows[1].fps).toBeCloseTo(10, 6);
		expect(rows[1].intervalP50Ms).toBeCloseTo(100, 6);
		expect(rows[0].intervalP95Ms).toBeCloseTo(1000 / 60, 6);
	});

	test("a frame interval belongs to the bucket of the frame that ends it", () => {
		const session = new PlaybackSession({ startMs: 0 });
		session.addFrame(frame({ atMs: 4900 }));
		session.addFrame(frame({ atMs: 5300 }));
		const rows = session.rows({ bucketSeconds: 5, nowMs: 6000 });
		expect(rows[0].intervalMaxMs).toBeNull();
		expect(rows[1].intervalMaxMs).toBeCloseTo(400, 6);
	});

	test("the last, partial bucket is divided by the time it covers", () => {
		const session = new PlaybackSession({ startMs: 0 });
		for (let i = 1; i <= 30; i++) session.addFrame(frame({ atMs: 5000 + i * 50 }));
		const rows = session.rows({ bucketSeconds: 5, nowMs: 6500 });
		expect(rows[1].frames).toBe(30);
		expect(rows[1].fps).toBeCloseTo(30 / 1.5, 6);
	});

	test("an empty bucket in the middle is reported with 0 fps", () => {
		const session = new PlaybackSession({ startMs: 0 });
		session.addFrame(frame({ atMs: 1000 }));
		session.addFrame(frame({ atMs: 11000 }));
		const rows = session.rows({ bucketSeconds: 5, nowMs: 12000 });
		expect(rows.map((row) => row.frames)).toEqual([1, 0, 1]);
		expect(rows[1].fps).toBe(0);
		expect(rows[2].intervalMaxMs).toBeCloseTo(10000, 6);
	});

	test("when draws stop, the buckets up to now still appear, with 0 fps", () => {
		const session = new PlaybackSession({ startMs: 0 });
		for (let i = 1; i <= 10; i++) session.addFrame(frame({ atMs: i * 100 }));
		const rows = session.rows({ bucketSeconds: 5, nowMs: 12000 });
		expect(rows.map((row) => row.frames)).toEqual([10, 0, 0]);
		expect(rows[2].fps).toBe(0);
	});

	test("decoder counters, decode waits, uploads, long tasks and heap add up per bucket", () => {
		const session = new PlaybackSession({ startMs: 0 });
		session.addFrame(
			frame({ atMs: 1000, decodeWaitMs: 30, uploads: 2, cache: { restarts: 1, advances: 1 } }),
		);
		session.addFrame(
			frame({ atMs: 2000, decodeWaitMs: 5, uploads: 1, cache: { stalePresents: 2, skipped: 3 } }),
		);
		session.addFrame(frame({ atMs: 6000, cache: { readAheadHits: 1, hits: 2 } }));
		session.addLongTask({ startMs: 1500, durationMs: 80 });
		session.addLongTask({ startMs: 1600, durationMs: 60 });
		session.addLongTask({ startMs: 7000, durationMs: 55 });
		session.addHeap({ atMs: 1000, usedBytes: 50 * 1024 * 1024 });
		session.addHeap({ atMs: 4000, usedBytes: 70 * 1024 * 1024 });
		const [first, second] = session.rows({ bucketSeconds: 5, nowMs: 8000 });
		expect(first.decodeWaitMs).toBe(35);
		expect(first.decodeWaitMaxMs).toBe(30);
		expect(first.restarts).toBe(1);
		expect(first.advances).toBe(1);
		expect(first.stalePresents).toBe(2);
		expect(first.skipped).toBe(3);
		expect(first.uploads).toBe(3);
		expect(first.longTasks).toBe(2);
		expect(first.longTaskMs).toBe(140);
		expect(first.heapMB).toBeCloseTo(70, 6);
		expect(second.hits).toBe(3);
		expect(second.longTasks).toBe(1);
		expect(second.heapMB).toBeNull();
	});

	test("memory is bounded: frames past the cap are counted, not stored", () => {
		const session = new PlaybackSession({ startMs: 0, maxFrames: 10 });
		for (let i = 1; i <= 25; i++) session.addFrame(frame({ atMs: i * 10 }));
		expect(session.storedFrames()).toBe(10);
		expect(session.droppedFrames()).toBe(15);
	});

	test("lastWindow covers the trailing second", () => {
		const session = new PlaybackSession({ startMs: 0 });
		for (let i = 1; i <= 100; i++) session.addFrame(frame({ atMs: i * 20 }));
		const window = session.lastWindow({ nowMs: 2000, windowMs: 1000 });
		expect(window.frames).toBe(50);
		expect(window.fps).toBeCloseTo(50, 6);
	});
});

describe("frameSampleFromProbes", () => {
	test("turns two probes around a draw into a frame sample", () => {
		const sample = frameSampleFromProbes({
			before: {
				atMs: 100,
				cache: { ...NO_CACHE, waitMs: 10, restarts: 1, draws: 5 },
				uploads: { uploads: 7, uploadedPixels: 700 },
			},
			after: {
				atMs: 140,
				cache: { ...NO_CACHE, waitMs: 25, restarts: 2, draws: 6 },
				uploads: { uploads: 9, uploadedPixels: 1100 },
			},
			effectPasses: 0,
		});
		expect(sample.atMs).toBe(140);
		expect(sample.renderMs).toBe(40);
		expect(sample.decodeWaitMs).toBe(15);
		expect(sample.uploads).toBe(2);
		expect(sample.uploadedPixels).toBe(400);
		expect(sample.cache.restarts).toBe(1);
		expect(sample.cache.draws).toBe(1);
	});
});

describe("formatSummary", () => {
	test("prints one line per bucket with the numbers the protocol asks for", () => {
		const session = new PlaybackSession({ startMs: 0 });
		for (let i = 1; i <= 120; i++) {
			session.addFrame(frame({ atMs: i * 50 - 25, cache: { restarts: i === 70 ? 1 : 0 } }));
		}
		const text = formatSummary({ session, nowMs: 6000, lastRenderError: null, gpuErrors: null });
		const lines = text.split("\n");
		expect(lines[0]).toContain("6.0 s since play");
		expect(lines[0]).toContain("120 frames");
		expect(text).toContain("fps");
		expect(text).toContain("restarts");
		const bucketLines = lines.filter((line) => /^\s*\d+-\d+ s/.test(line));
		expect(bucketLines).toHaveLength(2 + 6);
		expect(bucketLines[0]).toMatch(/^\s*0-5 s/);
	});
});

describe("parseHudFlag", () => {
	test("on by window flag or by localStorage ccut.playbackHud = 1", () => {
		expect(parseHudFlag({ windowFlag: true, storageValue: null })).toBe(true);
		expect(parseHudFlag({ windowFlag: undefined, storageValue: "1" })).toBe(true);
		expect(parseHudFlag({ windowFlag: undefined, storageValue: null })).toBe(false);
		expect(parseHudFlag({ windowFlag: undefined, storageValue: "0" })).toBe(false);
		expect(parseHudFlag({ windowFlag: false, storageValue: "true" })).toBe(false);
		expect(parseHudFlag({ windowFlag: "yes", storageValue: null })).toBe(false);
	});
});
