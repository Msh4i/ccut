const { describe, expect, test } = require("bun:test");
const { parseHudDump, parseHudRow, summarizeHudRows } = require("./perf/hud");
// The real formatter of the playback HUD: if its text changes, these tests say so.
const hud = require("../../web/src/diagnostics/playback-hud/session.ts");

// __playbackHudDump() text -> rows (the harness reads it after Pause).

const counters = (overrides = {}) => ({ hits: 0, readAheadHits: 0, lruHits: 0, advances: 0, restarts: 0, stalePresents: 0, draws: 0, skipped: 0, errors: 0, waitMs: 0, ...overrides });
const probe = ({ atMs, cache = counters(), uploads = 0, pixels = 0 }) => ({ atMs, cache, uploads: { uploads, uploadedPixels: pixels } });

/** A real PlaybackSession: 12 s at 30 fps, a 200 ms stall at 6 s, one decoder restart, two long tasks. */
function recordedDump() {
	const session = new hud.PlaybackSession({ startMs: 1000 });
	let at = 1000;
	let totals = counters();
	let uploads = 0;
	for (let frame = 0; frame < 340; frame++) {
		const before = probe({ atMs: at, cache: totals, uploads, pixels: uploads * 2_073_600 });
		at += frame === 180 ? 200 : 1000 / 30;
		totals = counters({ ...totals, hits: totals.hits + 1, draws: totals.draws + 1, waitMs: totals.waitMs + (frame === 180 ? 150 : 1), restarts: totals.restarts + (frame === 180 ? 1 : 0), advances: totals.advances + (frame % 10 === 0 ? 1 : 0) });
		uploads += 1;
		session.addFrame(hud.frameSampleFromProbes({ before: { ...before, atMs: at - 12 }, after: probe({ atMs: at, cache: totals, uploads, pixels: uploads * 2_073_600 }), effectPasses: 2 }));
	}
	session.addLongTask({ startMs: 7100, durationMs: 180 });
	session.addLongTask({ startMs: 7400, durationMs: 60 });
	session.addHeap({ atMs: 2000, usedBytes: 50 * 1024 * 1024 });
	return { text: hud.formatSummary({ session, nowMs: 13_000, lastRenderError: null, gpuErrors: null }), session };
}

describe("parseHudDump", () => {
	test("the real HUD text: header, every 5 s row and every 1 s row, numbers equal to the HUD's own rows", () => {
		const { text, session } = recordedDump();
		const parsed = parseHudDump(text);
		expect(parsed.elapsedS).toBe(12);
		expect(parsed.frames).toBe(340);
		expect(parsed.notStored).toBe(0);
		const truth5 = session.rows({ bucketSeconds: 5, nowMs: 13_000 });
		expect(parsed.rows5s).toHaveLength(truth5.length);
		expect(parsed.rows1s).toHaveLength(session.rows({ bucketSeconds: 1, nowMs: 13_000 }).length);
		for (let i = 0; i < truth5.length; i++) {
			const row = parsed.rows5s[i];
			const truth = truth5[i];
			expect([row.fromS, row.toS]).toEqual([truth.fromS, truth.toS]);
			expect(row.fps).toBeCloseTo(truth.fps, 1);
			expect(row.intervalP95Ms).toBe(Math.round(truth.intervalP95Ms));
			expect(row.intervalMaxMs).toBe(Math.round(truth.intervalMaxMs));
			expect(row.restarts).toBe(truth.restarts);
			expect(row.waits).toBe(truth.advances);
			expect(row.decodeWaitMs).toBe(Math.round(truth.decodeWaitMs));
			expect(row.uploads).toBe(truth.uploads);
			expect(row.longTasks).toBe(truth.longTasks);
			expect(row.longTaskMs).toBe(Math.round(truth.longTaskMs));
		}
		expect(parsed.rows5s[1]).toMatchObject({ fromS: 5, toS: 10, restarts: 1, intervalMaxMs: 200, longTasks: 2, longTaskMs: 240 });
		expect(parsed.rows5s[0].heapMB).toBe(50);
	});

	test("'-' columns are null", () => {
		const row = parseHudRow("  10-15 s |   0.0 fps | int -/-/- ms | draw -/-/- ms | decode wait 0/0 ms | restarts 0 | waits 0 | stale 0 | skipped 0 | uploads 0 (0.0 MP) | long tasks 0/0 ms | heap - MB");
		expect(row).toMatchObject({ fromS: 10, toS: 15, fps: 0, intervalP50Ms: null, intervalP95Ms: null, intervalMaxMs: null, drawP50Ms: null, heapMB: null });
	});

	test("an unknown extra column (a later HUD) is kept as a number, not an error; a missing one is null", () => {
		const row = parseHudRow("    0-5 s |  30.0 fps | int 33/34/40 ms | hits 140 | restarts 2");
		expect(row).toMatchObject({ fromS: 0, toS: 5, fps: 30, intervalP95Ms: 34, restarts: 2, waits: null, uploads: null, extra: { hits: 140 } });
	});

	test("a line that is not a row (legend, stray text inside a section) is skipped", () => {
		expect(parseHudRow("columns: fps | interval between draws p50/p95/max")).toBeNull();
		const parsed = parseHudDump(["Ccut playback HUD: 5.0 s since play, 150 frames (0 not stored)", "per 5 s since play:", "    0-5 s |  30.0 fps", "stray | text", "", "per second:"].join("\n"));
		expect(parsed.rows5s).toHaveLength(1);
	});

	test("not a HUD table (the 'no playback recorded yet' answer, null, garbage) is null", () => {
		expect(parseHudDump("Ccut playback HUD: no playback recorded yet (press Play with the HUD on).")).toBeNull();
		expect(parseHudDump(null)).toBeNull();
		expect(parseHudDump("")).toBeNull();
		expect(parseHudDump(42)).toBeNull();
	});
});

describe("summarizeHudRows", () => {
	test("totals over the rows and per-second rates over the HUD's elapsed time", () => {
		const { text } = recordedDump();
		const parsed = parseHudDump(text);
		const summary = summarizeHudRows({ rows: parsed.rows5s, elapsedS: parsed.elapsedS });
		expect(summary.restarts).toBe(1);
		expect(summary.restartsPerSecond).toBeCloseTo(1 / 12, 6);
		expect(summary.waits).toBe(34);
		expect(summary.longTasks).toBe(2);
		expect(summary.uploads).toBe(340);
		expect(summary.minFps).toBeGreaterThan(0);
	});

	test("minFps ignores the partial last row (it may cover a fraction of a second)", () => {
		const row = (fromS, fps) => ({ fromS, toS: fromS + 5, fps, restarts: 0 });
		expect(summarizeHudRows({ rows: [row(0, 30), row(5, 28), row(10, 3)], elapsedS: 10.5 }).minFps).toBe(28);
	});

	test("no rows: zeros and null rates", () => {
		expect(summarizeHudRows({ rows: [], elapsedS: 0 })).toEqual({ restarts: 0, restartsPerSecond: null, waits: 0, stale: 0, skipped: 0, decodeWaitMs: 0, uploads: 0, longTasks: 0, longTaskMs: 0, minFps: null });
	});
});
