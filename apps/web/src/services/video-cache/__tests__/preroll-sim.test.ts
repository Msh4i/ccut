import { describe, expect, test } from "bun:test";
import { planPreroll } from "../preroll-plan";
import {
	type InteractiveScenario,
	firstPictureLags,
	runInteractiveScenario,
	sparseCutLayers,
} from "../sim/interactive-sim";

// The owner's cut project on a virtual clock: 16 clips of 0.4-1.3 s from two long files with a key
// frame only every 6 s, each starting mid-GOP, played from the start. The decoder must run from the
// previous key frame (up to 360 frames) before a new clip has a picture; without pre-roll that
// starts when the playhead reaches the cut, with it a few boundaries earlier.

const PLAY_AT = 100;

function scenario(extra: Partial<InteractiveScenario>): InteractiveScenario {
	const layers = sparseCutLayers();
	const end = layers.reduce((sum, layer) => sum + layer.duration, 0);
	return {
		layers,
		ops: [{ at: PLAY_AT, op: "play" }],
		endMs: Math.round(end * 1000) + 2500,
		projectFps: 60,
		videoFps: 60,
		keyframeSeconds: 6,
		decodeMs: 4,
		startupMs: 20,
		renderMs: 25,
		maxStaleSeconds: 0.09,
		// the owner's machine (room for streams) and the app's start gate: the playhead starts once clip 0 has its picture
		roomy: true,
		startGate: true,
		...extra,
	};
}

const summary = (lags: Array<number | null>) => {
	const shown = lags.filter((lag): lag is number => lag !== null);
	return { missing: lags.length - shown.length, worst: Math.max(...shown), mean: shown.reduce((a, b) => a + b, 0) / Math.max(1, shown.length) };
};

describe("pre-roll across cuts, sparse key frames", () => {
	test("without pre-roll the new clip's picture is late at the cuts (the owner's 0.15-0.55 s)", async () => {
		const s = scenario({});
		const result = await runInteractiveScenario({ scenario: s });
		const { missing, worst, mean } = summary(firstPictureLags({ result, layers: s.layers, playAtMs: result.playheadStartedAt[0] ?? PLAY_AT, maxStaleSeconds: s.maxStaleSeconds }));
		expect(missing).toBe(0);
		expect(worst).toBeGreaterThan(100);
		expect(mean).toBeGreaterThan(50);
	});

	test("with pre-roll every clip's picture is there within 100 ms of its boundary", async () => {
		const s = scenario({ preroll: true });
		const result = await runInteractiveScenario({ scenario: s });
		const lags = firstPictureLags({ result, layers: s.layers, playAtMs: result.playheadStartedAt[0] ?? PLAY_AT, maxStaleSeconds: s.maxStaleSeconds });
		const { missing, worst } = summary(lags);
		expect(missing).toBe(0);
		expect(worst).toBeLessThan(100);
	});

	test("pausing releases the streams opened ahead: only the next clip stays", async () => {
		const ops: InteractiveScenario["ops"] = [{ at: PLAY_AT, op: "play" }, { at: 3000, op: "pause" }];
		const without = await runInteractiveScenario({ scenario: scenario({ ops, endMs: 5000 }) });
		const withPreroll = await runInteractiveScenario({ scenario: scenario({ preroll: true, ops, endMs: 5000 }) });
		// what the player had open anyway, plus at most the one clip pre-rolled at rest
		expect(withPreroll.openStreamsAtEnd).toBeLessThanOrEqual(without.openStreamsAtEnd + 1);
	});

	test("with software decoding (12 ms a frame) pre-roll still removes most of the lag; the first cuts after Space are limited by physics", async () => {
		const base = scenario({ decodeMs: 12 });
		const withPreroll = scenario({ decodeMs: 12, preroll: true });
		const [a, b] = await Promise.all([runInteractiveScenario({ scenario: base }), runInteractiveScenario({ scenario: withPreroll })]);
		const lagsOf = ({ s, r }: { s: InteractiveScenario; r: typeof a }) => firstPictureLags({ result: r, layers: s.layers, playAtMs: r.playheadStartedAt[0] ?? PLAY_AT, maxStaleSeconds: s.maxStaleSeconds });
		const late = (lags: Array<number | null>) => lags.filter((lag) => lag === null || lag > 100).length;
		expect(late(lagsOf({ s: withPreroll, r: b }))).toBeLessThan(late(lagsOf({ s: base, r: a })) / 2);
	});
});

describe("planPreroll", () => {
	const clips = [0, 1, 2, 3, 4, 5].map((index) => ({ key: `c${index}`, mediaId: "m", start: index, sourceStart: index * 10 }));
	test("the next clips that start within the horizon, nearest first, at most four; none already started", () => {
		expect(planPreroll({ clips, time: 0.4 }).map((clip) => clip.key)).toEqual(["c1", "c2", "c3", "c4"]);
		expect(planPreroll({ clips, time: 4.2 }).map((clip) => clip.key)).toEqual(["c5"]);
		expect(planPreroll({ clips, time: 0.4, horizonSeconds: 1, maxClips: 5 }).map((clip) => clip.key)).toEqual(["c1"]);
		expect(planPreroll({ clips, time: 9 })).toEqual([]);
	});
});
