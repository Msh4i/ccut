/**
 * Speed guard, skipped unless `PERF=1` (timings on a loaded machine mean
 * nothing, and bun runs JavaScriptCore, not V8). The real figure is taken in
 * the Electron window in slice T2.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { generateSequence } from "../camera-synth";
import { solvePin } from "../solve-pin";
import { FeatureTracker } from "../tracker";
import type { TrackerTiming } from "../types";
import { FG_COMBO, getWorld, releaseCaches } from "./camera-fixtures";

afterAll(releaseCaches);

const perf = process.env.PERF === "1" ? test : test.skip;

describe("speed (PERF=1)", () => {
	perf("analysis runs at 120 frames per second or more at 480 x 270", () => {
		const sequence = generateSequence({
			world: getWorld({ key: "main", seed: 1 }),
			options: { kind: "combo", frameCount: 240, seed: 5, foregrounds: FG_COMBO },
		});
		let best = Infinity;
		let timing: TrackerTiming | null = null;
		for (let rep = 0; rep < 3; rep++) {
			const tracker = new FeatureTracker({ w: 480, h: 270, fps: 30 });
			const t0 = performance.now();
			for (const frame of sequence.frames) tracker.push(frame);
			best = Math.min(best, performance.now() - t0);
			tracker.finish();
			timing = tracker.timing;
		}
		const fps = (240 * 1000) / best;
		console.log(
			`analysis ${fps.toFixed(0)} frames/s (${(best / 240).toFixed(2)} ms/frame); last run stages: pyramid ${((timing?.pyramidMs ?? 0) / 240).toFixed(2)} track ${((timing?.trackMs ?? 0) / 240).toFixed(2)} detect ${((timing?.detectMs ?? 0) / 240).toFixed(2)} ms/frame`,
		);
		expect(fps).toBeGreaterThanOrEqual(120);
	});

	perf("a vertical 480 x 853 frame is analysed in 12 ms or less", () => {
		const sequence = generateSequence({
			world: getWorld({ key: "main", seed: 1 }),
			options: { kind: "rot", frameCount: 60, width: 480, height: 853, seed: 5, extra: { deg: 10 } },
		});
		let best = Infinity;
		for (let rep = 0; rep < 3; rep++) {
			const tracker = new FeatureTracker({ w: 480, h: 853, fps: 30 });
			const t0 = performance.now();
			for (const frame of sequence.frames) tracker.push(frame);
			best = Math.min(best, performance.now() - t0);
		}
		console.log(`480x853 analysis ${(best / 60).toFixed(2)} ms/frame`);
		expect(best / 60).toBeLessThanOrEqual(12);
	});

	perf("one pin solves at 5000 frames per second or more", () => {
		const sequence = generateSequence({
			world: getWorld({ key: "main", seed: 1 }),
			options: { kind: "combo", frameCount: 240, seed: 5, foregrounds: FG_COMBO },
		});
		const tracker = new FeatureTracker({ w: 480, h: 270, fps: 30 });
		for (const frame of sequence.frames) tracker.push(frame);
		const tracks = tracker.finish();
		let best = Infinity;
		for (let rep = 0; rep < 5; rep++) {
			const t0 = performance.now();
			solvePin({ tracks, f0: 0, model: "S", mode: "scene" });
			best = Math.min(best, performance.now() - t0);
		}
		console.log(`similarity solve ${(best / 240).toFixed(3)} ms/frame`);
		expect(240000 / best).toBeGreaterThanOrEqual(5000);
	});
});
