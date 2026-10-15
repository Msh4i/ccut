/**
 * Hard footage the tracker must survive (plan table M4): fast pans, motion
 * blur, exposure jumps, things crossing the pin, sensor noise. Corner errors
 * are px@480; the limits are about twice the measured values.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { SequenceOptions } from "../camera-synth";
import { solvePin } from "../solve-pin";
import {
	analyse,
	evaluatePins,
	getWorld,
	releaseCaches,
	report,
	type Analysis,
	type PinSpec,
} from "./camera-fixtures";

afterAll(releaseCaches);

const mainWorld = () => getWorld({ key: "main", seed: 1 });

const CENTRE_PINS: PinSpec[] = [
	{ f0: 0, pin: { x: 240, y: 135 } },
	{ f0: 0, pin: { x: 120, y: 180 } },
];
const RIGHT_PINS: PinSpec[] = [
	{ f0: 0, pin: { x: 400, y: 135 } },
	{ f0: 0, pin: { x: 300, y: 80 } },
];

function worstOf({ analysis, pins }: { analysis: Analysis; pins: PinSpec[] }) {
	return evaluatePins({
		analysis,
		pins,
		solve: (spec) =>
			solvePin({ tracks: analysis.tracks, f0: spec.f0, model: "S", mode: "scene" }),
	});
}

function expectTracked({
	name,
	analysis,
	pins,
	limit,
	minRows = 80,
}: {
	name: string;
	analysis: Analysis;
	pins: PinSpec[];
	limit: number;
	/** Visible pin frames the numbers are taken over (a fast pan carries a pin out of sight quickly). */
	minRows?: number;
}) {
	const worst = worstOf({ analysis, pins });
	report({
		label: name,
		values: { rows: worst.rows, "corner max": worst.cornerMax, limit, cuts: analysis.tracks.cuts.length },
	});
	expect(worst.rows).toBeGreaterThan(minRows);
	expect(worst.solved / worst.rows).toBeGreaterThan(0.99);
	expect(worst.cornerMax).toBeLessThanOrEqual(limit);
	expect(analysis.tracks.cuts).toEqual([]);
	return worst;
}

describe("fast and blurred camera moves", () => {
	test("a pan of 32 px per frame (a fifteenth of the width every frame)", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "fastpan", frameCount: 45, seed: 5, extra: { speed: 32 } },
		});
		expectTracked({ name: "fast pan 32 px/frame", analysis, pins: RIGHT_PINS, limit: 0.6, minRows: 20 });
	});

	test("heavy motion blur: 20 px per frame at half shutter", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "fastpan", frameCount: 45, seed: 5, blur: 0.5, extra: { speed: 20 } },
		});
		expectTracked({ name: "blur 20 px/frame, shutter 0.5", analysis, pins: RIGHT_PINS, limit: 0.6, minRows: 20 });
	});
});

describe("exposure and things in the way", () => {
	test("a two-frame flash and a lasting brightness step", () => {
		const options: SequenceOptions = {
			kind: "hand",
			frameCount: 90,
			seed: 5,
			exposure: [
				{ t0: 55, t1: 90, gain: 1.25, offset: 15 },
				{ t0: 25, t1: 27, gain: 1.6, offset: 30 },
			],
		};
		const analysis = analyse({ world: mainWorld(), options });
		expectTracked({ name: "flash + exposure step", analysis, pins: CENTRE_PINS, limit: 0.6 });
		// the flash costs features on those two frames, not the whole clip
		const live = (f: number) => analysis.tracks.liveOffsets[f + 1] - analysis.tracks.liveOffsets[f];
		expect(live(26)).toBeGreaterThan(60);
		expect(live(70)).toBeGreaterThan(70);
	});

	test("a big object (r=70) drives across the pin", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: {
				kind: "hand",
				frameCount: 100,
				seed: 5,
				foregrounds: [{ x0: 20, y0: 135, vx: 3.2, vy: 0, radius: 70 }],
			},
		});
		expectTracked({ name: "r=70 object crosses the pin", analysis, pins: CENTRE_PINS, limit: 0.6 });
	});

	test("two moving objects (r=40 and r=60) with the camera moving too", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: {
				kind: "combo",
				frameCount: 120,
				seed: 11,
				foregrounds: [
					{ x0: 40, y0: 50, vx: 1.4, vy: 0.6, radius: 40 },
					{ x0: 440, y0: 220, vx: -1.2, vy: -0.5, radius: 60 },
				],
			},
		});
		expectTracked({
			name: "two objects r=40 + r=60",
			analysis,
			pins: [...CENTRE_PINS, { f0: 60, pin: { x: 300, y: 90 } }],
			limit: 0.6,
		});
	});
});

describe("sensor noise", () => {
	test("sigma 6 gray levels, more than twice the usual, is still followed", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "hand", frameCount: 120, seed: 5, noise: 6 },
		});
		expectTracked({ name: "noise sigma 6", analysis, pins: CENTRE_PINS, limit: 1.5 });
	});
});

describe("no scene cut is invented", () => {
	test("sigma 12 noise", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "hand", frameCount: 45, seed: 5, noise: 12 },
		});
		expect(analysis.tracks.cuts).toEqual([]);
	});

	test("almost no texture (a world with 12 percent of the detail)", () => {
		const world = getWorld({ key: "poor", seed: 3, texture: 0.12, shapes: 700 });
		const analysis = analyse({
			world,
			options: { kind: "hand", frameCount: 45, seed: 5 },
		});
		expect(analysis.tracks.cuts).toEqual([]);
	});
});
