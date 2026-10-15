import { describe, expect, test } from "bun:test";
import { type CacheMemorySnapshot, formatCacheMemoryLine } from "../cache-memory";

const MiB = 1024 ** 2;

function snapshot(overrides: Partial<CacheMemorySnapshot> = {}): CacheMemorySnapshot {
	return {
		atMs: 10_000,
		mode: "balanced",
		reason: "reading",
		budgetBytes: 1536 * MiB,
		usedBytes: 812.4 * MiB,
		lruBytes: 640 * MiB,
		lruFrames: 77,
		lruHits: 120,
		streams: 2,
		restarts: 5,
		readAheadBytes: 25 * MiB,
		decoderQueueBytes: 25 * MiB,
		keptDecodedBytes: 6 * MiB,
		borrows: 10,
		redraws: 3,
		availableBytes: 4500 * MiB,
		appBytes: 2100 * MiB,
		...overrides,
	};
}

describe("formatCacheMemoryLine", () => {
	test("budget, used, kept frames, decoded frames, LRU hits, streams, restarts and borrowed requests per second, redraws", () => {
		const line = formatCacheMemoryLine({
			current: snapshot(),
			previous: snapshot({ atMs: 8_000, lruHits: 60, restarts: 4, borrows: 8 }),
		});
		expect(line).toBe(
			"cache: budget 1536 MB (balanced, reading) | used 812 MB (kept 640 MB, 77 frames; decoded 56 MB) | LRU hits 120 (30.0/s) | streams 2 | restarts 0.5/s | borrowed 1.0/s | redraws 3 | available 4500 MB | app 2100 MB",
		);
	});

	test("without an earlier sample the rates are unknown; without readings so are available and app", () => {
		const line = formatCacheMemoryLine({
			current: snapshot({ availableBytes: null, appBytes: null, reason: "start" }),
			previous: null,
		});
		expect(line).toContain("LRU hits 120 (-/s)");
		expect(line).toContain("restarts -/s");
		expect(line).toContain("borrowed -/s");
		expect(line).toContain("available - MB");
		expect(line).toContain("app - MB");
		expect(line).toContain("(balanced, start)");
	});

	test("a sample taken at the same moment (or a counter reset by a new session) gives no rate", () => {
		expect(
			formatCacheMemoryLine({ current: snapshot(), previous: snapshot() }),
		).toContain("restarts -/s");
		expect(
			formatCacheMemoryLine({ current: snapshot(), previous: snapshot({ atMs: 9_000, restarts: 9 }) }),
		).toContain("restarts -/s");
	});
});
