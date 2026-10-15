import { describe, expect, test } from "bun:test";
import {
	backdropDownscale,
	backdropTextureSize,
	MAX_BACKDROP_DOWNSCALE,
} from "../backdrop-scale";

// The blur background draws the backdrop into a canvas, uploads it as a texture
// and the GPU stretches it over the frame before the Gaussian blur runs at frame
// resolution. Uploading a full-frame canvas every video frame cost 70 ms on a
// 1080x1920 project, so the texture is drawn k times smaller. That resample adds
// about 0.4*k px of softness (measured on a sharp edge: bilinear draw into the
// small canvas plus the GPU bilinear stretch), which hides in a blur only when
// it is small against sigma: (0.4*k)^2 <= 0.2 * sigma^2.

const EXTRA_SOFTNESS_PER_STEP = 0.4;
const SOFTNESS_BUDGET = 0.2;

describe("backdropDownscale", () => {
	test("a weak blur is not downscaled", () => {
		expect(backdropDownscale({ sigmaX: 0, sigmaY: 0 })).toBe(1);
		expect(backdropDownscale({ sigmaX: 0.5, sigmaY: 0.5 })).toBe(1);
		expect(backdropDownscale({ sigmaX: 1, sigmaY: 1 })).toBe(1);
		expect(backdropDownscale({ sigmaX: 1.12, sigmaY: 3.56 })).toBe(1);
	});

	test("a strong blur reaches the cap", () => {
		expect(backdropDownscale({ sigmaX: 22.5, sigmaY: 71.1 })).toBe(
			MAX_BACKDROP_DOWNSCALE,
		);
		expect(backdropDownscale({ sigmaX: 100, sigmaY: 100 })).toBe(8);
		expect(MAX_BACKDROP_DOWNSCALE).toBe(8);
	});

	test("the weakest axis decides, whichever axis it is", () => {
		expect(backdropDownscale({ sigmaX: 1, sigmaY: 50 })).toBe(1);
		expect(backdropDownscale({ sigmaX: 50, sigmaY: 1 })).toBe(1);
		expect(backdropDownscale({ sigmaX: 4, sigmaY: 30 })).toBe(4);
		expect(backdropDownscale({ sigmaX: 30, sigmaY: 4 })).toBe(4);
	});

	test("is an integer between 1 and the cap for any sigma", () => {
		for (let sigmaX = 0; sigmaX <= 60; sigmaX += 0.37) {
			for (let sigmaY = 0; sigmaY <= 60; sigmaY += 1.9) {
				const k = backdropDownscale({ sigmaX, sigmaY });
				expect(Number.isInteger(k)).toBe(true);
				expect(k).toBeGreaterThanOrEqual(1);
				expect(k).toBeLessThanOrEqual(MAX_BACKDROP_DOWNSCALE);
			}
		}
	});

	test("never shrinks when a sigma grows", () => {
		let previous = 1;
		for (let sigma = 0; sigma <= 30; sigma += 0.05) {
			const k = backdropDownscale({ sigmaX: sigma, sigmaY: sigma });
			expect(k).toBeGreaterThanOrEqual(previous);
			previous = k;
		}
		for (let other = 0; other <= 30; other += 3) {
			let previousX = 1;
			let previousY = 1;
			for (let sigma = 0; sigma <= 30; sigma += 0.1) {
				const kx = backdropDownscale({ sigmaX: sigma, sigmaY: other });
				const ky = backdropDownscale({ sigmaX: other, sigmaY: sigma });
				expect(kx).toBeGreaterThanOrEqual(previousX);
				expect(ky).toBeGreaterThanOrEqual(previousY);
				previousX = kx;
				previousY = ky;
			}
		}
	});

	test("keeps the extra softness inside the budget of the weakest axis", () => {
		for (let sigma = 0; sigma <= 40; sigma += 0.05) {
			const k = backdropDownscale({ sigmaX: sigma, sigmaY: sigma * 3 });
			if (k === 1) continue;
			expect((EXTRA_SOFTNESS_PER_STEP * k) ** 2).toBeLessThanOrEqual(
				SOFTNESS_BUDGET * sigma * sigma,
			);
		}
	});

	test("bad numbers leave the backdrop at full size", () => {
		expect(backdropDownscale({ sigmaX: Number.NaN, sigmaY: Number.NaN })).toBe(1);
		expect(backdropDownscale({ sigmaX: Number.NaN, sigmaY: 50 })).toBe(1);
		expect(backdropDownscale({ sigmaX: 50, sigmaY: Number.NaN })).toBe(1);
		expect(backdropDownscale({ sigmaX: -5, sigmaY: 50 })).toBe(1);
		expect(backdropDownscale({ sigmaX: -5, sigmaY: -5 })).toBe(1);
		expect(
			backdropDownscale({
				sigmaX: Number.NEGATIVE_INFINITY,
				sigmaY: Number.NEGATIVE_INFINITY,
			}),
		).toBe(1);
	});

	test("an infinite sigma is a strong blur, not a bad number", () => {
		expect(
			backdropDownscale({
				sigmaX: Number.POSITIVE_INFINITY,
				sigmaY: Number.POSITIVE_INFINITY,
			}),
		).toBe(8);
		expect(
			backdropDownscale({ sigmaX: Number.POSITIVE_INFINITY, sigmaY: 5 }),
		).toBe(5);
	});
});

describe("backdropTextureSize", () => {
	test("no downscale keeps the frame size", () => {
		expect(backdropTextureSize({ width: 1080, height: 1920, downscale: 1 })).toEqual({
			width: 1080,
			height: 1920,
		});
	});

	test("divides the frame size by the downscale, rounding up", () => {
		expect(backdropTextureSize({ width: 1080, height: 1920, downscale: 8 })).toEqual({
			width: 135,
			height: 240,
		});
		expect(backdropTextureSize({ width: 1081, height: 1921, downscale: 8 })).toEqual({
			width: 136,
			height: 241,
		});
	});

	test("is never empty", () => {
		expect(backdropTextureSize({ width: 3, height: 2, downscale: 8 })).toEqual({
			width: 1,
			height: 1,
		});
		// a canvas cannot be 0 px wide or tall
		expect(backdropTextureSize({ width: 0, height: 0, downscale: 4 })).toEqual({
			width: 1,
			height: 1,
		});
	});

	test("an unusable downscale means the frame size", () => {
		for (const downscale of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(backdropTextureSize({ width: 640, height: 360, downscale })).toEqual({
				width: 640,
				height: 360,
			});
		}
	});
});
