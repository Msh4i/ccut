import { describe, expect, test } from "bun:test";
import {
	MIN_FRAME_SCALE,
	needsLargerDraw,
	normalizeScale,
	scaledFrameSize,
} from "../frame-scale";

describe("normalizeScale", () => {
	test("a scale in range is kept", () => {
		expect(normalizeScale(1)).toBe(1);
		expect(normalizeScale(0.25)).toBe(0.25);
		expect(normalizeScale(MIN_FRAME_SCALE)).toBe(MIN_FRAME_SCALE);
	});

	test("more than full size is full size (a frame is never upscaled)", () => {
		expect(normalizeScale(2)).toBe(1);
		expect(normalizeScale(8)).toBe(1);
	});

	test("below the floor is the floor", () => {
		expect(normalizeScale(0.001)).toBe(MIN_FRAME_SCALE);
	});

	test("not told (NaN, 0, negative, infinite) is full size", () => {
		for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(normalizeScale(bad)).toBe(1);
		}
	});
});

describe("scaledFrameSize", () => {
	test("scale 1 is exactly the display size", () => {
		expect(scaledFrameSize({ width: 1920, height: 1080, scale: 1 })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(scaledFrameSize({ width: 1281, height: 721, scale: 1 })).toEqual({
			width: 1281,
			height: 721,
		});
	});

	test("the owner's case: 1920x1080 at 0.25 is 480x270", () => {
		expect(scaledFrameSize({ width: 1920, height: 1080, scale: 0.25 })).toEqual({
			width: 480,
			height: 270,
		});
	});

	test("rounds to whole pixels and never gives an empty canvas", () => {
		expect(scaledFrameSize({ width: 1000, height: 563, scale: 0.25 })).toEqual({
			width: 250,
			height: 141,
		});
		expect(scaledFrameSize({ width: 4, height: 2, scale: MIN_FRAME_SCALE })).toEqual({
			width: 1,
			height: 1,
		});
	});

	test("a portrait (rotated) video scales the same way", () => {
		expect(scaledFrameSize({ width: 1080, height: 1920, scale: 0.5 })).toEqual({
			width: 540,
			height: 960,
		});
	});

	test("an unusable scale gives the display size", () => {
		expect(scaledFrameSize({ width: 1920, height: 1080, scale: Number.NaN })).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(scaledFrameSize({ width: 1920, height: 1080, scale: 0 })).toEqual({
			width: 1920,
			height: 1080,
		});
	});
});

describe("needsLargerDraw", () => {
	test("a frame drawn smaller than asked is drawn again for an exact request (tolerance 0)", () => {
		expect(needsLargerDraw({ drawnScale: 0.25, scale: 1, maxStaleSeconds: 0 })).toBe(true);
		expect(needsLargerDraw({ drawnScale: 0.25, scale: 0.5, maxStaleSeconds: 0 })).toBe(true);
	});

	test("while the preview plays (tolerance > 0) the smaller frame does", () => {
		expect(needsLargerDraw({ drawnScale: 0.25, scale: 1, maxStaleSeconds: 0.1 })).toBe(false);
		expect(needsLargerDraw({ drawnScale: 0.25, scale: 0.5, maxStaleSeconds: 1 / 60 })).toBe(false);
	});

	test("a frame at least as large as asked is never drawn again", () => {
		expect(needsLargerDraw({ drawnScale: 1, scale: 1, maxStaleSeconds: 0 })).toBe(false);
		expect(needsLargerDraw({ drawnScale: 0.5, scale: 0.25, maxStaleSeconds: 0 })).toBe(false);
	});
});
