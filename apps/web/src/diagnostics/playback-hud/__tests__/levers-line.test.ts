import { describe, expect, test } from "bun:test";
import { DEFAULT_PLAYBACK_LEVERS } from "@/services/playback-levers/levers";
import { formatLeversLine } from "../levers-line";

describe("formatLeversLine", () => {
	test("all off", () => {
		expect(formatLeversLine({ levers: DEFAULT_PLAYBACK_LEVERS, display: { width: 1080, height: 1920, scale: 1 }, bitmap: { reused: 5, created: 1, staging: 0 } })).toBe(
			"levers: worker off | bitmap off | display off",
		);
	});

	test("all on: the display size of the last draw, n/a for what has no numbers yet", () => {
		const levers = { decodeWorker: true, bitmapUpload: true, displayResolution: true };
		expect(formatLeversLine({ levers, display: { width: 540, height: 960, scale: 0.5 }, bitmap: null })).toBe(
			"levers: worker on n/a | bitmap on n/a | display on 540x960 (x0.5)",
		);
		expect(formatLeversLine({ levers, display: { width: 382, height: 679, scale: Math.SQRT1_2 / 2 }, bitmap: null })).toBe(
			"levers: worker on n/a | bitmap on n/a | display on 382x679 (x0.354)",
		);
		expect(formatLeversLine({ levers, display: null, bitmap: null })).toBe("levers: worker on n/a | bitmap on n/a | display on n/a");
	});

	test("bitmap on: the upload counters", () => {
		const levers = { decodeWorker: false, bitmapUpload: true, displayResolution: false };
		expect(formatLeversLine({ levers, display: null, bitmap: { reused: 118, created: 3, staging: 0 } })).toBe(
			"levers: worker off | bitmap on reused 118 created 3 staging 0 | display off",
		);
	});

	test("decode workers: workers on of the most, streams that fell back, tripped for the session", () => {
		const levers = { ...DEFAULT_PLAYBACK_LEVERS, decodeWorker: true };
		const display = { width: 1080, height: 1920, scale: 1 };
		expect(formatLeversLine({ levers, display, bitmap: null, workers: { live: 2, cap: 4, fallbacks: 0, tripped: false } })).toBe(
			"levers: worker on 2/4 fallbacks 0 | bitmap off | display off",
		);
		expect(formatLeversLine({ levers, display, bitmap: null, workers: { live: 0, cap: 4, fallbacks: 3, tripped: true } })).toBe(
			"levers: worker tripped fallbacks 3 | bitmap off | display off",
		);
		// the lever off says so whatever the pool did earlier in the session
		expect(
			formatLeversLine({
				levers: DEFAULT_PLAYBACK_LEVERS,
				display,
				bitmap: null,
				workers: { live: 2, cap: 4, fallbacks: 1, tripped: false },
			}),
		).toBe("levers: worker off | bitmap off | display off");
	});
});
