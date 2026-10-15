import { describe, expect, test } from "bun:test";
import { resolveEffectPasses } from "@/effects";
import type { EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";
import {
	MAX_BLUR_SIGMA,
	blurEffectDefinition,
	buildGaussianBlurPasses,
} from "../blur";

// The blur's passes reach the GPU as f32 uniforms. A pass with a sigma of 0 or
// NaN makes the shader divide 0 by 0 for its centre tap, so the whole layer
// turns into NaN pixels; a pass list that is empty used to fail the whole
// frame in the compositor. Project files, keyframes (a bezier can overshoot
// below 0) and a clip scaled to 0 can all hand the blur such values.

function passesFor({
	effectParams,
	width = 1920,
	height = 1080,
}: {
	effectParams: ParamValues;
	width?: number;
	height?: number;
}): EffectPass[] {
	return resolveEffectPasses({
		definition: blurEffectDefinition,
		effectParams,
		width,
		height,
		localTimeSeconds: 0,
		durationSeconds: 0,
	});
}

function directionOf(pass: EffectPass): string {
	const direction = pass.uniforms.u_direction;
	if (!Array.isArray(direction)) throw new Error("no direction");
	return direction[0] === 1 ? "x" : "y";
}

function expectUsablePass(pass: EffectPass) {
	const { u_sigma: sigma, u_step: step } = pass.uniforms;
	if (typeof sigma !== "number" || typeof step !== "number") {
		throw new Error("u_sigma and u_step must be numbers");
	}
	expect(Number.isFinite(sigma)).toBe(true);
	expect(sigma).toBeGreaterThan(0);
	expect(sigma).toBeLessThanOrEqual(MAX_BLUR_SIGMA);
	expect(Number.isFinite(step)).toBe(true);
	expect(step).toBeGreaterThanOrEqual(1);
}

describe("blur intensity that is not a usable number", () => {
	const unusable: Array<[string, ParamValues]> = [
		["0", { intensity: 0 }],
		["missing", {}],
		["NaN", { intensity: Number.NaN }],
		["negative", { intensity: -20 }],
		["+Infinity", { intensity: Number.POSITIVE_INFINITY }],
		["-Infinity", { intensity: Number.NEGATIVE_INFINITY }],
		["a word", { intensity: "strong" }],
		["an empty string", { intensity: "" }],
		["a boolean", { intensity: true }],
	];

	for (const [label, effectParams] of unusable) {
		test(`${label}: no passes at all`, () => {
			expect(passesFor({ effectParams })).toEqual([]);
		});
	}

	test("a number in a string still blurs like the number (old project files)", () => {
		expect(passesFor({ effectParams: { intensity: "50" } })).toEqual(
			passesFor({ effectParams: { intensity: 50 } }),
		);
	});
});

describe("blur on a clip box with a zero or unusable side", () => {
	test("0 x 0: no passes", () => {
		expect(passesFor({ effectParams: { intensity: 50 }, width: 0, height: 0 })).toEqual([]);
	});

	test("0 x N blurs only vertically, N x 0 only horizontally", () => {
		const tall = passesFor({ effectParams: { intensity: 50 }, width: 0, height: 1080 });
		expect(tall.length).toBeGreaterThan(0);
		expect(tall.map(directionOf)).toEqual(tall.map(() => "y"));

		const wide = passesFor({ effectParams: { intensity: 50 }, width: 1920, height: 0 });
		expect(wide.length).toBeGreaterThan(0);
		expect(wide.map(directionOf)).toEqual(wide.map(() => "x"));
	});

	test("a side that is NaN, negative or infinite counts as 0", () => {
		for (const bad of [Number.NaN, -1080, Number.POSITIVE_INFINITY]) {
			const passes = passesFor({ effectParams: { intensity: 50 }, width: bad, height: 1080 });
			expect(passes.length).toBeGreaterThan(0);
			expect(passes.map(directionOf)).toEqual(passes.map(() => "y"));
		}
	});
});

describe("every blur pass is usable by the shader", () => {
	test("no zero, NaN or infinite sigma or step for any intensity and box", () => {
		const intensities: unknown[] = [
			0, 1e-9, 0.001, 0.5, 1, 15, 100, 1e6, 1e30, Number.MAX_VALUE,
			Number.NaN, Number.POSITIVE_INFINITY, -1, "15", "x",
		];
		const sides = [0, 1, 7, 1080, 1920, 3840, Number.NaN, Number.POSITIVE_INFINITY, -5];
		let checked = 0;
		for (const intensity of intensities) {
			for (const width of sides) {
				for (const height of sides) {
					const effectParams: ParamValues =
						typeof intensity === "number" || typeof intensity === "string"
							? { intensity }
							: {};
					for (const pass of passesFor({ effectParams, width, height })) {
						expectUsablePass(pass);
						checked += 1;
					}
				}
			}
		}
		// The grid is not vacuous: the usable combinations do produce passes.
		expect(checked).toBeGreaterThan(100);
	});

	test("a huge intensity is capped, so the shader's f32 maths cannot overflow", () => {
		const passes = passesFor({ effectParams: { intensity: 1e30 } });
		expect(passes.length).toBeGreaterThan(0);
		let variance = 0;
		for (const pass of passes) {
			expectUsablePass(pass);
			if (directionOf(pass) === "x") {
				const sigma = pass.uniforms.u_sigma;
				if (typeof sigma === "number") variance += sigma * sigma;
			}
		}
		expect(Math.sqrt(variance)).toBeCloseTo(MAX_BLUR_SIGMA, 6);
	});

	test("the per-pass templates (used when a definition has no buildPasses) are never NaN either", () => {
		const cases: ParamValues[] = [{ intensity: Number.NaN }, {}, { intensity: -3 }];
		for (const effectParams of cases) {
			for (const template of blurEffectDefinition.renderer.passes) {
				const uniforms = template.uniforms({
					effectParams,
					width: 1920,
					height: 1080,
					localTimeSeconds: 0,
					durationSeconds: 0,
				});
				for (const value of Object.values(uniforms)) {
					const numbers = Array.isArray(value) ? value : [value];
					for (const number of numbers) {
						expect(Number.isFinite(number)).toBe(true);
					}
				}
			}
		}
	});
});

describe("buildGaussianBlurPasses per axis", () => {
	test("an axis without blur gets no pass (its sigma 0 would be 0/0 in the shader)", () => {
		const passes = buildGaussianBlurPasses({ sigmaX: 0, sigmaY: 5 });
		expect(passes).toEqual([
			{
				shader: "gaussian-blur",
				uniforms: { u_sigma: 5, u_step: 1, u_direction: [0, 1] },
			},
		]);
		expect(buildGaussianBlurPasses({ sigmaX: 5, sigmaY: Number.NaN }).map(directionOf)).toEqual(["x"]);
		expect(buildGaussianBlurPasses({ sigmaX: -4, sigmaY: 3 }).map(directionOf)).toEqual(["y"]);
	});

	test("a sigma below 0.001 px is no blur: no pass for that axis", () => {
		expect(buildGaussianBlurPasses({ sigmaX: 0.0009, sigmaY: 0.0009 })).toEqual([]);
		expect(
			buildGaussianBlurPasses({ sigmaX: 0.0009, sigmaY: 2 }).map(directionOf),
		).toEqual(["y"]);
	});

	test("the iteration count follows the stronger usable axis", () => {
		// sigma 71 on y needs 4 iterations at step 4; x has none.
		const passes = buildGaussianBlurPasses({ sigmaX: 0, sigmaY: 71.1 });
		expect(passes).toHaveLength(4);
		expect(passes.map(directionOf)).toEqual(["y", "y", "y", "y"]);
	});
});
