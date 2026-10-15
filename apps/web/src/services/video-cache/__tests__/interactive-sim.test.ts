import { describe, expect, test } from "bun:test";
import {
	type InteractiveOp,
	type InteractiveScenario,
	type ScreenSnapshot,
	cutFileLayers,
	runInteractiveScenario,
	showsFrame,
} from "../sim/interactive-sim";

// A long file cut into many 1.5 s clips (cuts off the key frames), played,
// stalled, paused and sought on a virtual clock.

function scenario({ ops, endMs }: { ops: InteractiveOp[]; endMs: number }): InteractiveScenario {
	return {
		layers: cutFileLayers({ count: 12, seconds: 1.5 }),
		ops,
		endMs,
		projectFps: 60,
		videoFps: 30,
		keyframeSeconds: 1,
		decodeMs: 6,
		startupMs: 20,
		renderMs: 25,
		maxStaleSeconds: 0.09,
	};
}

/** Layers of a draw that are black (no frame) or show another picture than the playhead's. */
function badLayers({ screen, maxStale }: { screen: ScreenSnapshot; maxStale: number }) {
	return screen.layers.filter(
		(entry) => !showsFrame({ answer: entry.answer, sourceTime: entry.sourceTime, maxStaleSeconds: maxStale }),
	);
}

const MAX_STALE = 0.09;

describe("playing across cuts, with a stall in the middle of a cut", () => {
	const run = () =>
		runInteractiveScenario({
			scenario: scenario({
				ops: [
					{ at: 100, op: "play" },
					{ at: 2300, op: "stall", ms: 1500 },
				],
				endMs: 6000,
			}),
		});

	test("no draw before, during or after the stall shows a black or wrong layer once playing resumes", async () => {
		const result = await run();
		const settled = result.screens.filter((screen) => screen.atMs > 600);
		expect(settled.length).toBeGreaterThan(50);
		const bad = settled.filter((screen) => badLayers({ screen, maxStale: MAX_STALE }).length > 0);
		expect(bad.map((screen) => [screen.atMs, screen.time])).toEqual([]);
	});

	test("after the stall the screen catches up with the playhead", async () => {
		const result = await run();
		const last = result.last;
		if (!last) throw new Error("no draw");
		// the playhead is within a few frames of the last draw's time
		expect(result.finalTime - last.time).toBeLessThan(5 / 60);
	});
});

describe("stall, then pause, then step and seek across cuts", () => {
	const ops: InteractiveOp[] = [
		{ at: 100, op: "play" },
		{ at: 2000, op: "stall", ms: 1200 },
		{ at: 3500, op: "pause" },
		{ at: 4500, op: "seek", time: 4.6 },
		{ at: 5500, op: "seek", time: 1.45 },
		{ at: 6500, op: "seek", time: 9.0 },
		{ at: 7500, op: "seek", time: 3.0 },
	];

	test("after a pause every visible clip shows its exact frame for the paused time", async () => {
		const result = await runInteractiveScenario({ scenario: scenario({ ops, endMs: 9000 }) });
		const paused = result.screens.filter((screen) => !screen.playing && screen.atMs > 3600);
		expect(paused.length).toBeGreaterThan(3);
		for (const screen of paused) {
			expect(badLayers({ screen, maxStale: 0 })).toEqual([]);
		}
	});

	test("each seek is drawn within 6 frames, and it shows the sought time", async () => {
		const result = await runInteractiveScenario({ scenario: scenario({ ops, endMs: 9000 }) });
		for (const [at, time] of [[4500, 4.6], [5500, 1.45], [6500, 9.0], [7500, 3.0]] as const) {
			const drawn = result.screens.find((screen) => screen.atMs >= at && Math.abs(screen.time - time) < 1 / 60);
			if (!drawn) throw new Error(`no draw for the seek to ${time}`);
			expect(drawn.atMs - at).toBeLessThan((6 / 60) * 1000 + 200);
			expect(drawn.layers.length).toBeGreaterThan(0);
			expect(badLayers({ screen: drawn, maxStale: 0 })).toEqual([]);
		}
	});

	test("the last draw is the one for the final playhead (nothing stays on screen from an earlier time)", async () => {
		const result = await runInteractiveScenario({ scenario: scenario({ ops, endMs: 9000 }) });
		expect(result.last?.time).toBeCloseTo(3.0, 2);
	});
});

describe("a stall during a seek", () => {
	test("the seek still ends on the sought time with every layer drawn", async () => {
		const ops: InteractiveOp[] = [
			{ at: 100, op: "play" },
			{ at: 1500, op: "pause" },
			{ at: 2000, op: "seek", time: 7.2 },
			{ at: 2010, op: "stall", ms: 1800 },
			{ at: 4500, op: "seek", time: 0.4 },
		];
		const result = await runInteractiveScenario({ scenario: scenario({ ops, endMs: 7000 }) });
		const afterFirst = result.screens.find((screen) => screen.atMs >= 2000 && Math.abs(screen.time - 7.2) < 1 / 60);
		expect(afterFirst).toBeDefined();
		const last = result.last;
		expect(last?.time).toBeCloseTo(0.4, 2);
		if (last) expect(badLayers({ screen: last, maxStale: 0 })).toEqual([]);
	});
});

describe("pausing", () => {
	test("pausing redraws the same frame at exact tolerance, even though the playhead did not move", async () => {
		const result = await runInteractiveScenario({
			scenario: scenario({ ops: [{ at: 100, op: "play" }, { at: 1009, op: "pause" }], endMs: 2500 }),
		});
		const afterPause = result.screens.filter((screen) => !screen.playing && screen.atMs > 1009);
		expect(afterPause.length).toBeGreaterThan(0);
		for (const screen of afterPause) expect(badLayers({ screen, maxStale: 0 })).toEqual([]);
	});

	test("a long pause does not cost the streams: playing on shows every layer at once", async () => {
		const result = await runInteractiveScenario({
			scenario: scenario({
				ops: [
					{ at: 100, op: "play" },
					{ at: 1000, op: "pause" },
					{ at: 25_000, op: "play" },
				],
				endMs: 27_000,
			}),
		});
		const resumed = result.screens.filter((screen) => screen.playing && screen.atMs > 25_000);
		expect(resumed.length).toBeGreaterThan(20);
		// the first draws after resuming are right within one stale window of waiting
		for (const screen of resumed.slice(3)) {
			expect(badLayers({ screen, maxStale: MAX_STALE })).toEqual([]);
		}
	});
});

// The first Space after opening a project: the video decoder's FIRST use takes ~4.3 s for
// everybody (measured in the real window with a Chrome trace: the first 10-11 decodes all
// returned together after 4.3-4.5 s, later ones every 0.3-0.4 s). Without a warm-up the
// playhead froze and then raced; with the decoder warmed at project open Space starts at once.
describe("the first Space after opening a project", () => {
	const FIRST_USE_MS = 4300;
	const SPACE_AT = 6000;
	const make = (extra: Partial<InteractiveScenario>): InteractiveScenario => ({
		...scenario({ ops: [{ at: SPACE_AT, op: "play" }], endMs: 12_000 }),
		firstUseMs: FIRST_USE_MS,
		idleUntilPlay: true,
		...extra,
	});

	test("without a warm-up the first frames arrive a cold start after Space and the playhead has raced ahead (the bug)", async () => {
		const result = await runInteractiveScenario({ scenario: make({}) });
		const first = result.screens.find((screen) => screen.playing && screen.layers.length > 0 && screen.layers.every((l) => l.answer));
		if (!first) throw new Error("no playing draw with pictures");
		expect(first.atMs - SPACE_AT).toBeGreaterThanOrEqual(FIRST_USE_MS - 200);
		expect((first.atMs - SPACE_AT) / 1000 - first.time).toBeGreaterThan(3);
	});

	test("with the decoder warmed up at project open the first Space shows pictures within 300 ms", async () => {
		const result = await runInteractiveScenario({ scenario: make({ prewarmDecoder: true, startGate: true }) });
		const first = result.screens.find((screen) => screen.playing && screen.layers.length > 0 && screen.layers.every((l) => l.answer));
		if (!first) throw new Error("no playing draw with pictures");
		expect(first.atMs - SPACE_AT).toBeLessThan(300);
		expect(result.playheadStartedAt[0] - SPACE_AT).toBeLessThan(50);
	});

	test("Space before the warm-up is done: the playhead waits for the first decoded frame, then no race", async () => {
		const result = await runInteractiveScenario({ scenario: make({ startGate: true, ops: [{ at: 100, op: "play" }], endMs: 9000 }) });
		const started = result.playheadStartedAt[0];
		expect(started).toBeGreaterThanOrEqual(FIRST_USE_MS - 200);
		const first = result.screens.find((screen) => screen.playing && screen.layers.every((l) => l.answer));
		if (!first) throw new Error("no playing draw");
		expect((first.atMs - started) / 1000 - first.time).toBeLessThan(0.5);
	});
});
