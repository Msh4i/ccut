/**
 * Prints the before/after table of the playback simulation.
 *
 *   bun apps/web/src/services/video-cache/sim/run-playback-sim.ts
 *
 * All timings are assumptions (see the scenario fields), not measurements.
 */
import {
	type PlaybackScenario,
	RESULT_HEADER,
	formatResultRow,
	runPlaybackScenario,
} from "./playback-sim";

const BASE: Omit<PlaybackScenario, "name"> = {
	seconds: 30,
	projectFps: 60,
	videoFps: 30,
	keyframeSeconds: 1,
	decodeMs: 6,
	startupMs: 20,
	renderMs: 36,
	slowEverySeconds: 2,
	slowExtraMs: 150,
	maxStaleSeconds: 0.09,
	canvasDrawGpuMs: 0,
	uploadCopyGpuMs: 0,
};

const GPU_COSTS = { canvasDrawGpuMs: 3, uploadCopyGpuMs: 3 };

export const SCENARIOS: PlaybackScenario[] = [
	{ ...BASE, name: "v30 gop1s dec6 gpu36" },
	{ ...BASE, name: "v30 gop1s dec6 gpu36 no-slow", slowExtraMs: 0 },
	{ ...BASE, name: "v30 gop2s dec10 gpu36", keyframeSeconds: 2, decodeMs: 10 },
	{ ...BASE, name: "v30 gop1s dec6 gpu25", renderMs: 25 },
	{ ...BASE, name: "v30 gop2s dec10 gpu25", renderMs: 25, keyframeSeconds: 2, decodeMs: 10 },
	{ ...BASE, name: "v60 gop1s dec6 gpu36", videoFps: 60 },
	{ ...BASE, name: "v60 gop2s dec12 gpu36", videoFps: 60, keyframeSeconds: 2, decodeMs: 12 },
	{ ...BASE, name: "v24 gop2s dec8 gpu36", videoFps: 24, keyframeSeconds: 2, decodeMs: 8 },
	{ ...BASE, ...GPU_COSTS, name: "v30 gop1s dec6 gpu25 +gpu3/3", renderMs: 25 },
	{ ...BASE, ...GPU_COSTS, name: "v30 gop2s dec10 gpu25 +gpu3/3", renderMs: 25, keyframeSeconds: 2, decodeMs: 10 },
	{ ...BASE, ...GPU_COSTS, name: "v60 gop1s dec6 gpu25 +gpu3/3", renderMs: 25, videoFps: 60 },
	{ ...BASE, ...GPU_COSTS, name: "v60 gop2s dec12 gpu36 +gpu3/3", videoFps: 60, keyframeSeconds: 2, decodeMs: 12 },
];

async function main() {
	console.log(RESULT_HEADER);
	for (const scenario of SCENARIOS) {
		for (const cache of ["before", "after"] as const) {
			const result = await runPlaybackScenario({ scenario, cache });
			console.log(formatResultRow({ scenario, result }));
		}
	}
}

await main();
