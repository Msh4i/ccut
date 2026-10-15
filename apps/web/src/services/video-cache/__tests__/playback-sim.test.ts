import { describe, expect, test } from "bun:test";
import { type PlaybackScenario, runPlaybackScenario } from "../sim/playback-sim";

// Playback of one video drawn twice per frame (blur backdrop + video), on a
// virtual clock (sim/playback-sim.ts). The draws keep pace with the 30 fps
// video for two seconds at a time, then one draw takes 150 ms longer: the case
// where the old cache's stale decoder position restarted the decoder.
const SCENARIO: PlaybackScenario = {
	name: "v30 gop1s dec6 gpu25",
	seconds: 8,
	projectFps: 60,
	videoFps: 30,
	keyframeSeconds: 1,
	decodeMs: 6,
	startupMs: 20,
	renderMs: 25,
	slowEverySeconds: 2.5,
	slowExtraMs: 150,
	maxStaleSeconds: 0.09,
	canvasDrawGpuMs: 0,
	uploadCopyGpuMs: 0,
};

describe("playback simulation", () => {
	test("the model reproduces the old cache's problems (it is not vacuous)", async () => {
		const before = await runPlaybackScenario({ scenario: SCENARIO, cache: "before" });
		expect(before.restarts).toBeGreaterThan(1);
		expect(before.mismatched).toBeGreaterThan(0);
		expect(before.canvasDraws).toBeGreaterThan(before.draws);
	});

	test("the new cache: one decoder start, backdrop and video in step, one canvas draw per shown frame", async () => {
		const after = await runPlaybackScenario({ scenario: SCENARIO, cache: "after" });
		expect(after.restarts).toBe(1);
		expect(after.mismatched).toBe(0);
		expect(after.overwritten).toBe(0);
		expect(after.canvasDraws).toBeLessThanOrEqual(after.draws);
		// only the first frame waits for the decoder
		expect(after.waitMaxMs).toBeLessThanOrEqual(SCENARIO.startupMs + SCENARIO.decodeMs + 1e-6);
		// a shown frame is never older than the tolerance plus one frame
		expect(after.lagMaxMs).toBeLessThanOrEqual(
			(SCENARIO.maxStaleSeconds + 1 / SCENARIO.videoFps) * 1000 + 1e-6,
		);
	});
});
