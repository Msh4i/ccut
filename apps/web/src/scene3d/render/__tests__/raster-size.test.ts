import { describe, expect, test } from "bun:test";
import {
	localRasterSize,
	MAX_LAYER_TEXTURE_SIZE,
	MAX_RASTER_SCALE,
	rasterScaleBucket,
} from "../raster-size";

describe("rasterScaleBucket", () => {
	test("rounds up to half-octave steps", () => {
		expect(rasterScaleBucket(1)).toBe(1);
		expect(rasterScaleBucket(1.2)).toBeCloseTo(Math.SQRT2, 12);
		expect(rasterScaleBucket(1.5)).toBeCloseTo(2, 12);
		expect(rasterScaleBucket(0.7)).toBeCloseTo(Math.SQRT1_2, 12);
		expect(rasterScaleBucket(0.5)).toBeCloseTo(0.5, 12);
	});

	test("is the same for every scale inside one bucket (no re-raster while it moves a little)", () => {
		const bucket = rasterScaleBucket(1.05);
		for (let s = 1.01; s <= 1.41; s += 0.01) {
			expect(rasterScaleBucket(s)).toBe(bucket);
		}
	});

	test("an unbounded on-screen size (a corner behind the camera) takes the largest scale", () => {
		expect(rasterScaleBucket(null)).toBe(MAX_RASTER_SCALE);
		expect(rasterScaleBucket(1e9)).toBe(MAX_RASTER_SCALE);
	});
});

describe("localRasterSize", () => {
	test("content size times the bucket, at least one pixel", () => {
		expect(localRasterSize({ contentWidth: 300, contentHeight: 80, pixelScale: 1 })).toEqual({
			width: 300,
			height: 80,
		});
		expect(localRasterSize({ contentWidth: 300, contentHeight: 80, pixelScale: 1.9 })).toEqual({
			width: 600,
			height: 160,
		});
		expect(localRasterSize({ contentWidth: 3, contentHeight: 1, pixelScale: 0.01 })).toEqual({
			width: 1,
			height: 1,
		});
	});

	test("never exceeds the largest texture side, keeping the aspect", () => {
		const size = localRasterSize({ contentWidth: 3000, contentHeight: 1000, pixelScale: null });
		expect(size.width).toBeLessThanOrEqual(MAX_LAYER_TEXTURE_SIZE);
		expect(size.height).toBeLessThanOrEqual(MAX_LAYER_TEXTURE_SIZE);
		expect(size.width / size.height).toBeCloseTo(3, 2);
	});
});
