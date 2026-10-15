import { describe, expect, test } from "bun:test";
import { buildGaussianBlurPasses } from "../blur";

// The compositor's blur shader takes 61 taps per pass per pixel whatever the
// sigma, so the number of passes is the cost: a sigma of 22 x 71 on a 1080x1920
// frame needed 8 passes (~45 ms of GPU time per frame on an iGPU). The taps are
// spaced `step` px apart; on a sharp input a spacing above 4 px shows as aliasing,
// but an input that was drawn k times smaller and stretched back (the blur
// background's backdrop) has no detail finer than k px, so there the spacing may
// grow to k px and the same Gaussian takes far fewer passes.

function sigmaOf(pass: { uniforms: Record<string, unknown> }): number {
	const sigma = pass.uniforms.u_sigma;
	if (typeof sigma !== "number") throw new Error("u_sigma is not a number");
	return sigma;
}

function stepOf(pass: { uniforms: Record<string, unknown> }): number {
	const step = pass.uniforms.u_step;
	if (typeof step !== "number") throw new Error("u_step is not a number");
	return step;
}

describe("buildGaussianBlurPasses", () => {
	test("no blur, no passes", () => {
		expect(buildGaussianBlurPasses({ sigmaX: 0, sigmaY: 0 })).toEqual([]);
		expect(
			buildGaussianBlurPasses({ sigmaX: 0, sigmaY: 0, sourceDownscale: 8 }),
		).toEqual([]);
	});

	test("a mild blur is one horizontal and one vertical pass at the asked sigma", () => {
		const passes = buildGaussianBlurPasses({ sigmaX: 2, sigmaY: 3 });
		expect(passes).toHaveLength(2);
		expect(passes[0].uniforms).toEqual({ u_sigma: 2, u_step: 1, u_direction: [1, 0] });
		expect(passes[1].uniforms).toEqual({ u_sigma: 3, u_step: 1, u_direction: [0, 1] });
	});

	test("a strong blur on a sharp input still takes four iterations for sigma 71", () => {
		const passes = buildGaussianBlurPasses({ sigmaX: 22.5, sigmaY: 71.1 });
		expect(passes).toHaveLength(8);
		expect(Math.max(...passes.map(stepOf))).toBeLessThanOrEqual(4);
	});

	test("an input drawn 8 times smaller needs two passes for the same sigma", () => {
		const passes = buildGaussianBlurPasses({
			sigmaX: 22.5,
			sigmaY: 71.1,
			sourceDownscale: 8,
		});
		expect(passes).toHaveLength(2);
		expect(sigmaOf(passes[0])).toBeCloseTo(22.5, 6);
		expect(sigmaOf(passes[1])).toBeCloseTo(71.1, 6);
		expect(stepOf(passes[1])).toBeCloseTo(7.11, 6);
	});

	test("a downscale of 4 or less changes nothing", () => {
		for (const sourceDownscale of [1, 2, 3, 4]) {
			expect(
				buildGaussianBlurPasses({ sigmaX: 22.5, sigmaY: 71.1, sourceDownscale }),
			).toEqual(buildGaussianBlurPasses({ sigmaX: 22.5, sigmaY: 71.1 }));
		}
	});

	test("the taps never end up further apart than the input's smallest detail", () => {
		for (const sourceDownscale of [1, 2, 4, 5, 6, 8]) {
			const limit = Math.max(4, sourceDownscale);
			// beyond eight iterations the steps grow, as they always did
			const reach = 10 * limit * Math.sqrt(8);
			for (let sigma = 0.5; sigma <= reach; sigma *= 1.37) {
				const passes = buildGaussianBlurPasses({
					sigmaX: sigma / 3,
					sigmaY: sigma,
					sourceDownscale,
				});
				for (const pass of passes) {
					expect(stepOf(pass)).toBeLessThanOrEqual(limit + 1e-9);
				}
			}
		}
	});

	test("the passes together blur by the asked sigma on each axis", () => {
		for (const sourceDownscale of [1, 3, 8]) {
			for (const sigma of [1, 5, 22.5, 71.1, 150]) {
				const passes = buildGaussianBlurPasses({
					sigmaX: sigma / 2,
					sigmaY: sigma,
					sourceDownscale,
				});
				let varianceX = 0;
				let varianceY = 0;
				for (const pass of passes) {
					const direction = pass.uniforms.u_direction;
					if (!Array.isArray(direction)) throw new Error("no direction");
					if (direction[0] === 1) varianceX += sigmaOf(pass) ** 2;
					else varianceY += sigmaOf(pass) ** 2;
				}
				expect(Math.sqrt(varianceX)).toBeCloseTo(sigma / 2, 6);
				expect(Math.sqrt(varianceY)).toBeCloseTo(sigma, 6);
			}
		}
	});

	test("the 61 taps still reach three sigma of every pass", () => {
		for (const sourceDownscale of [1, 8]) {
			const passes = buildGaussianBlurPasses({
				sigmaX: 22.5,
				sigmaY: 71.1,
				sourceDownscale,
			});
			for (const pass of passes) {
				expect(30 * stepOf(pass)).toBeGreaterThanOrEqual(3 * sigmaOf(pass) - 1e-9);
			}
		}
	});

	test("a downscale that is not a usable number is ignored", () => {
		const plain = buildGaussianBlurPasses({ sigmaX: 22.5, sigmaY: 71.1 });
		for (const sourceDownscale of [
			Number.NaN,
			0,
			-3,
			Number.NEGATIVE_INFINITY,
			Number.POSITIVE_INFINITY,
		]) {
			expect(
				buildGaussianBlurPasses({ sigmaX: 22.5, sigmaY: 71.1, sourceDownscale }),
			).toEqual(plain);
		}
	});
});
