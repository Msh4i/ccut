import { describe, expect, test } from "bun:test";
import {
	AnalysisCache,
	analysisBytes,
	analysisSourceWindow,
	coversWindow,
	DEFAULT_CACHE_BUDGET_BYTES,
} from "../analysis-cache";
import { fakeAnalysis, fakeTracksBytes } from "./analysis-fixtures";

/** 30 frames at 30 fps, rate 1, from source second 2: frames at 2 .. 2 + 29/30. */
const TEN_SECONDS = { sourceStart: 2, frameCount: 300 };

describe("analysisBytes", () => {
	test("sums the typed arrays of the tracks", () => {
		const analysis = fakeAnalysis({ frameCount: 10, trackCount: 7, floats: 40 });
		expect(analysisBytes({ analysis })).toBe(
			fakeTracksBytes({ frameCount: 10, trackCount: 7, floats: 40 }),
		);
	});

	test("a longer clip costs more bytes", () => {
		const short = analysisBytes({ analysis: fakeAnalysis({ frameCount: 10, floats: 100 }) });
		const long = analysisBytes({ analysis: fakeAnalysis({ frameCount: 100, floats: 1000 }) });
		expect(long).toBeGreaterThan(short);
	});
});

describe("analysisSourceWindow / coversWindow", () => {
	test("the window spans the first to the last frame in source seconds, rate included", () => {
		const analysis = fakeAnalysis({ sourceStart: 2, rate0: 2, fps: 30, frameCount: 31 });
		const window = analysisSourceWindow({ analysis });
		expect(window.start).toBe(2);
		// 30 steps of 2 / 30 s
		expect(window.end).toBeCloseTo(4, 9);
	});

	test("covers a window inside it, with half a frame of slack, and not one that pokes out", () => {
		const analysis = fakeAnalysis({ ...TEN_SECONDS });
		const step = 1 / 30;
		expect(coversWindow({ analysis, window: { start: 2, end: 2 + 299 * step } })).toBe(true);
		expect(coversWindow({ analysis, window: { start: 3, end: 5 } })).toBe(true);
		// the last sample is at 2 + 299/30; a window ending at the clip's true end (2 + 300/30) is covered
		expect(coversWindow({ analysis, window: { start: 2, end: 12 } })).toBe(true);
		expect(coversWindow({ analysis, window: { start: 2 - 0.4 * step, end: 5 } })).toBe(true);
		expect(coversWindow({ analysis, window: { start: 2 - 0.6 * step, end: 5 } })).toBe(false);
		expect(coversWindow({ analysis, window: { start: 2, end: 12 + 0.6 * step } })).toBe(false);
		expect(coversWindow({ analysis, window: { start: 1, end: 3 } })).toBe(false);
		expect(coversWindow({ analysis, window: { start: 11, end: 14 } })).toBe(false);
	});
});

describe("AnalysisCache", () => {
	test("getCached is synchronous and empty at first", () => {
		const cache = new AnalysisCache();
		const got = cache.getCached({ hostElementId: "host-1", mediaId: "media-1", window: { start: 2, end: 3 } });
		expect(got).toBeNull();
		expect(got).not.toBeInstanceOf(Promise);
		expect(cache.size).toBe(0);
		expect(cache.bytes).toBe(0);
	});

	test("serves an analysis that covers the window, for the same host and media only", () => {
		const cache = new AnalysisCache();
		const analysis = fakeAnalysis({ ...TEN_SECONDS });
		cache.put({ analysis });

		const hit = cache.getCached({ hostElementId: "host-1", mediaId: "media-1", window: { start: 3, end: 5 } });
		expect(hit).toBe(analysis);
		expect(
			cache.getCached({ hostElementId: "host-1", mediaId: "media-1", window: { start: 1, end: 5 } }),
		).toBeNull();
		expect(
			cache.getCached({ hostElementId: "host-1", mediaId: "media-1", window: { start: 3, end: 13 } }),
		).toBeNull();
		expect(
			cache.getCached({ hostElementId: "host-2", mediaId: "media-1", window: { start: 3, end: 5 } }),
		).toBeNull();
		expect(
			cache.getCached({ hostElementId: "host-1", mediaId: "media-2", window: { start: 3, end: 5 } }),
		).toBeNull();
	});

	test("two windows of the same host live side by side, each answers its own stretch", () => {
		const cache = new AnalysisCache();
		const head = fakeAnalysis({ id: "head", sourceStart: 0, frameCount: 60 });
		const tail = fakeAnalysis({ id: "tail", sourceStart: 20, frameCount: 60 });
		cache.put({ analysis: head });
		cache.put({ analysis: tail });
		const at = ({ start, end }: { start: number; end: number }) =>
			cache.getCached({ hostElementId: "host-1", mediaId: "media-1", window: { start, end } });
		expect(at({ start: 0.5, end: 1.5 })?.id).toBe("head");
		expect(at({ start: 20.5, end: 21.5 })?.id).toBe("tail");
		expect(at({ start: 1, end: 21 })).toBeNull();
		expect(cache.size).toBe(2);
	});

	test("byId finds an analysis by its id", () => {
		const cache = new AnalysisCache();
		const analysis = fakeAnalysis({ id: "a-7" });
		cache.put({ analysis });
		expect(cache.byId({ analysisId: "a-7" })).toBe(analysis);
		expect(cache.byId({ analysisId: "a-8" })).toBeNull();
	});

	test("refuses a cancelled analysis: partial tracks are never cached", () => {
		const cache = new AnalysisCache();
		expect(() => cache.put({ analysis: fakeAnalysis({ status: "cancelled" }) })).toThrow(
			/complete/,
		);
		expect(cache.size).toBe(0);
	});

	test("the default budget is 64 MB", () => {
		expect(DEFAULT_CACHE_BUDGET_BYTES).toBe(64 * 1024 * 1024);
	});

	test("evicts the least recently used entries by bytes, not by count", () => {
		// each entry: 10 frames, 100 floats
		const bytesEach = fakeTracksBytes({ frameCount: 10, floats: 100 });
		const cache = new AnalysisCache({ budgetBytes: 3 * bytesEach + 1 });
		const entry = (id: string) => fakeAnalysis({ id, hostElementId: id, frameCount: 10, floats: 100 });
		cache.put({ analysis: entry("a") });
		cache.put({ analysis: entry("b") });
		cache.put({ analysis: entry("c") });
		expect(cache.size).toBe(3);
		expect(cache.bytes).toBe(3 * bytesEach);

		// a is the oldest, but touching it makes b the one to go
		expect(cache.byId({ analysisId: "a" })).not.toBeNull();
		cache.put({ analysis: entry("d") });
		expect(cache.size).toBe(3);
		expect(cache.byId({ analysisId: "b" })).toBeNull();
		expect(cache.byId({ analysisId: "a" })).not.toBeNull();
		expect(cache.byId({ analysisId: "c" })).not.toBeNull();
		expect(cache.byId({ analysisId: "d" })).not.toBeNull();
		expect(cache.bytes).toBeLessThanOrEqual(3 * bytesEach + 1);

		// a big entry pushes out as many small ones as its bytes need: count alone would keep three
		const big = fakeAnalysis({ id: "big", hostElementId: "big", frameCount: 10, floats: 150 });
		cache.put({ analysis: big });
		expect(cache.bytes).toBeLessThanOrEqual(3 * bytesEach + 1);
		expect(cache.size).toBe(2);
		expect(cache.byId({ analysisId: "big" })).not.toBeNull();
		expect(cache.byId({ analysisId: "d" })).not.toBeNull();
	});

	test("getCached counts as a use for the eviction order", () => {
		const bytesEach = fakeTracksBytes({ frameCount: 10, floats: 100 });
		const cache = new AnalysisCache({ budgetBytes: 2 * bytesEach });
		cache.put({ analysis: fakeAnalysis({ id: "a", hostElementId: "h-a", frameCount: 10, floats: 100 }) });
		cache.put({ analysis: fakeAnalysis({ id: "b", hostElementId: "h-b", frameCount: 10, floats: 100 }) });
		expect(
			cache.getCached({ hostElementId: "h-a", mediaId: "media-1", window: { start: 0, end: 0.2 } })?.id,
		).toBe("a");
		cache.put({ analysis: fakeAnalysis({ id: "c", hostElementId: "h-c", frameCount: 10, floats: 100 }) });
		expect(cache.byId({ analysisId: "b" })).toBeNull();
		expect(cache.byId({ analysisId: "a" })).not.toBeNull();
	});

	test("an analysis above the whole budget is kept on its own", () => {
		const cache = new AnalysisCache({ budgetBytes: 100 });
		cache.put({ analysis: fakeAnalysis({ id: "small", hostElementId: "s", frameCount: 2 }) });
		const huge = fakeAnalysis({ id: "huge", hostElementId: "h", frameCount: 10, floats: 100 });
		cache.put({ analysis: huge });
		expect(cache.size).toBe(1);
		expect(cache.byId({ analysisId: "huge" })).toBe(huge);
	});

	test("putting the same id again replaces the entry and its bytes", () => {
		const cache = new AnalysisCache();
		cache.put({ analysis: fakeAnalysis({ id: "a", frameCount: 10, floats: 100 }) });
		const again = fakeAnalysis({ id: "a", frameCount: 10, floats: 10 });
		cache.put({ analysis: again });
		expect(cache.size).toBe(1);
		expect(cache.bytes).toBe(fakeTracksBytes({ frameCount: 10, floats: 10 }));
		expect(cache.byId({ analysisId: "a" })).toBe(again);
	});

	test("invalidateHost drops that host's analyses only", () => {
		const cache = new AnalysisCache();
		cache.put({ analysis: fakeAnalysis({ id: "a1", hostElementId: "h-a", sourceStart: 0 }) });
		cache.put({ analysis: fakeAnalysis({ id: "a2", hostElementId: "h-a", sourceStart: 50 }) });
		cache.put({ analysis: fakeAnalysis({ id: "b", hostElementId: "h-b" }) });
		cache.invalidateHost({ hostElementId: "h-a" });
		expect(cache.size).toBe(1);
		expect(cache.byId({ analysisId: "b" })).not.toBeNull();
		expect(cache.bytes).toBe(analysisBytes({ analysis: fakeAnalysis({ id: "b" }) }));
	});

	test("prune drops a deleted host and a host whose media changed, keeps a moved, trimmed or retimed one", () => {
		const cache = new AnalysisCache();
		cache.put({ analysis: fakeAnalysis({ id: "gone", hostElementId: "h-gone" }) });
		cache.put({ analysis: fakeAnalysis({ id: "swapped", hostElementId: "h-swapped", mediaId: "media-1" }) });
		cache.put({ analysis: fakeAnalysis({ id: "kept", hostElementId: "h-kept" }) });
		// the host clip, as it is now: moved/trimmed/retimed hosts still answer with their media
		cache.prune({
			mediaIdOf: ({ hostElementId }) => {
				if (hostElementId === "h-gone") return null;
				if (hostElementId === "h-swapped") return "media-2";
				return "media-1";
			},
		});
		expect(cache.size).toBe(1);
		expect(cache.byId({ analysisId: "kept" })).not.toBeNull();
	});

	test("clear empties everything (the project changed)", () => {
		const cache = new AnalysisCache();
		cache.put({ analysis: fakeAnalysis({ id: "a" }) });
		cache.put({ analysis: fakeAnalysis({ id: "b", hostElementId: "h-b" }) });
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.bytes).toBe(0);
		expect(cache.byId({ analysisId: "a" })).toBeNull();
	});
});
