import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	effectsRegistry,
	registerDefaultEffects,
	resolveEffectPasses,
} from "@/effects";
import { buildDefaultParamValues } from "@/params/registry";
import { EFFECT_PREVIEW_LOOP_SECONDS } from "@/services/renderer/effect-preview";
import { intensityToSigma } from "../blur";
import { blurPulseEffectDefinition, computeBlurPulseIntensity } from "../blur-pulse";
import {
	computeFilmGrainAmount,
	computeFilmGrainSeed,
	filmGrainEffectDefinition,
} from "../film-grain";
import {
	computeFlashAmount,
	flashEffectDefinition,
	flashWhiteness,
} from "../flash";
import { computeGlitchOffsets, glitchEffectDefinition } from "../glitch";
import {
	computeLightLeakCenter,
	LIGHT_LEAK_RADIUS,
	lightLeakEffectDefinition,
} from "../light-leak";
import { computePunchZoomScale, punchZoomEffectDefinition } from "../punch-zoom";
import {
	computeCoverScale,
	computeRotateWobbleAngle,
	maxWobbleAngleRadians,
	rotateWobbleEffectDefinition,
} from "../rotate-wobble";
import { computeStrobeAmount, strobeEffectDefinition } from "../strobe";
import {
	computeVignettePulseAmount,
	vignettePulseEffectDefinition,
} from "../vignette-pulse";

const REPO_ROOT = join(import.meta.dir, "../../../../../..");
const EFFECTS_CRATE = join(REPO_ROOT, "rust/crates/effects/src");

const TIME_BASED_EFFECTS = [
	"shake",
	"punch-zoom",
	"flash",
	"strobe",
	"glitch",
	"blur-pulse",
	"vignette-pulse",
	"film-grain",
	"light-leak",
	"rotate-wobble",
];

/**
 * Mean |value(frame) - value(frame - 1)| over `seconds` of 24 fps export —
 * how much a scalar uniform visibly changes from one exported frame to the
 * next.
 */
function meanDeltaPerFrameAt24fps(sample: (seconds: number) => number): number {
	const fps = 24;
	const frameCount = 8 * fps;
	let total = 0;
	let previous = sample(0);
	for (let frame = 1; frame <= frameCount; frame++) {
		const current = sample(frame / fps);
		total += Math.abs(current - previous);
		previous = current;
	}
	return total / frameCount;
}

/**
 * The aliasing signature from round18's review: across the Speed range,
 * frame-to-frame motion has a sharp trough at some slider position while
 * its neighbours are fine. Samples a little past both ends of the slider so
 * its own boundary values have neighbours on both sides.
 */
function expectNoAliasingDip({
	speedMin,
	speedMax,
	minimumMeanDelta,
	valueAt,
}: {
	speedMin: number;
	speedMax: number;
	minimumMeanDelta: number;
	valueAt: (args: { speed: number; seconds: number }) => number;
}): void {
	const step = (speedMax - speedMin) / 30;
	const speeds: number[] = [];
	for (let i = -2; i <= 32; i++) speeds.push(speedMin + i * step);
	const deltas = speeds.map((speed) =>
		meanDeltaPerFrameAt24fps((seconds) => valueAt({ speed, seconds })),
	);
	for (const delta of deltas) {
		expect(delta).toBeGreaterThan(minimumMeanDelta);
	}
	for (let i = 1; i < deltas.length - 1; i++) {
		expect(deltas[i]).toBeGreaterThan(
			(1 / 3) * Math.min(deltas[i - 1], deltas[i + 1]),
		);
	}
}

describe("registry", () => {
	test("every effect is registered once, Blur first, in grid order", () => {
		registerDefaultEffects();
		const types = effectsRegistry
			.getAll()
			.filter((definition) => definition.category !== "filter")
			.map((definition) => definition.type);
		expect(types).toEqual(["blur", ...TIME_BASED_EFFECTS]);
	});

	test("every time-based effect has an Intensity and a Speed slider", () => {
		registerDefaultEffects();
		for (const type of TIME_BASED_EFFECTS) {
			const keys = effectsRegistry.get(type).params.map((param) => param.key);
			expect(keys).toContain("intensity");
			expect(keys).toContain("speed");
		}
	});

	test("each grid thumbnail is a moment where the effect is visibly on", () => {
		registerDefaultEffects();
		const num = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
		const vec = (value: unknown) => (Array.isArray(value) ? value : []);
		// What "visibly on" means for each effect, at default settings on a
		// 1920 x 1080 clip (the thumbnail is the same picture, scaled down).
		const isOn: Record<string, (passes: { uniforms: Record<string, unknown> }[]) => boolean> = {
			shake: ([pass]) => Math.hypot(...vec(pass.uniforms.u_offset)) > 0.2 * 0.5 * 0.03 * 1080,
			"punch-zoom": ([pass]) => num(pass.uniforms.u_scale) > 1.05,
			flash: ([pass]) => num(pass.uniforms.u_amount) > 0.2,
			strobe: ([pass]) => num(pass.uniforms.u_amount) > 0.2,
			glitch: ([pass]) => vec(pass.uniforms.u_red_offset)[0] !== 0,
			"blur-pulse": (passes) => passes.length > 0,
			"vignette-pulse": ([pass]) => num(pass.uniforms.u_amount) > 0.2,
			"film-grain": ([pass]) => num(pass.uniforms.u_amount) > 0,
			"light-leak": ([pass]) => {
				const [x, y] = vec(pass.uniforms.u_center);
				return x > 0 && x < 1 && y > 0 && y < 1 && num(pass.uniforms.u_intensity) > 0.2;
			},
			"rotate-wobble": ([pass]) =>
				Math.abs(num(pass.uniforms.u_angle)) >
				0.5 * maxWobbleAngleRadians({ intensity: 50 }),
		};
		for (const type of TIME_BASED_EFFECTS) {
			const definition = effectsRegistry.get(type);
			const passes = resolveEffectPasses({
				definition,
				effectParams: buildDefaultParamValues(definition.params),
				width: 1920,
				height: 1080,
				localTimeSeconds: definition.previewTimeSeconds ?? 0,
				durationSeconds: EFFECT_PREVIEW_LOOP_SECONDS,
			});
			if (!isOn[type](passes)) throw new Error(`${type}: the grid thumbnail shows the effect at rest`);
		}
	});

	test("defaults give finite uniforms at any time, for a clip and a zero-size clip", () => {
		registerDefaultEffects();
		for (const type of TIME_BASED_EFFECTS) {
			const definition = effectsRegistry.get(type);
			for (const [width, height] of [
				[1920, 1080],
				[0, 0],
			]) {
				for (const localTimeSeconds of [0, 0.37, 1, 4.2, 61]) {
					const passes = resolveEffectPasses({
						definition,
						effectParams: buildDefaultParamValues(definition.params),
						width,
						height,
						localTimeSeconds,
						durationSeconds: 5,
					});
					for (const pass of passes) {
						for (const value of Object.values(pass.uniforms).flat()) {
							expect(Number.isFinite(value)).toBe(true);
						}
					}
				}
			}
		}
	});
});

// TypeScript and Rust agree on these only by string. A shader id or a
// uniform name spelled differently on the two sides type-checks and
// compiles, then fails every frame at runtime (UnknownEffectShader /
// MissingUniform) — which nothing short of a real GPU run would show. So
// read the Rust side and compare.
describe("the TypeScript <-> Rust contract", () => {
	const rust = readFileSync(join(EFFECTS_CRATE, "pipeline.rs"), "utf8");
	const idByConst = new Map(
		[...rust.matchAll(/const (\w+_SHADER_ID): &str = "([^"]+)";/g)].map(
			(match) => [match[1], match[2]],
		),
	);
	const packFnById = new Map(
		[...rust.matchAll(/EffectShader \{\s*id: (\w+),[\s\S]*?pack: (\w+),\s*\}/g)].map(
			(match) => [idByConst.get(match[1]), match[2]],
		),
	);
	function uniformsAcceptedBy(packFn: string): string[] {
		const body = rust.match(
			new RegExp(
				`fn ${packFn}\\([\\s\\S]*?reject_unsupported_uniforms\\(\\s*pass,\\s*&\\[([^\\]]*)\\]`,
			),
		);
		if (!body) throw new Error(`no allowlist found for ${packFn}`);
		return [...body[1].matchAll(/"(\w+)"/g)].map((match) => match[1]).sort();
	}

	test("the Rust table was actually found (guards the parsing above)", () => {
		expect(packFnById.size).toBeGreaterThanOrEqual(9);
	});

	test("every pass an effect emits names a Rust shader and sends exactly its uniforms", () => {
		registerDefaultEffects();
		let checkedPasses = 0;
		for (const definition of effectsRegistry.getAll()) {
			// 1 s in: blur-pulse is mid-breath, so it emits passes too.
			const passes = resolveEffectPasses({
				definition,
				effectParams: buildDefaultParamValues(definition.params),
				width: 1920,
				height: 1080,
				localTimeSeconds: 1,
				durationSeconds: 5,
			});
			for (const pass of passes) {
				const packFn = packFnById.get(pass.shader);
				if (!packFn) throw new Error(`${definition.type}: no Rust shader "${pass.shader}"`);
				expect(Object.keys(pass.uniforms).sort()).toEqual(uniformsAcceptedBy(packFn));
				checkedPasses++;
			}
		}
		expect(checkedPasses).toBeGreaterThanOrEqual(effectsRegistry.getAll().length);
	});

	test("the light leak's radius matches the shader's", () => {
		const wgsl = readFileSync(join(EFFECTS_CRATE, "shaders/light_leak.wgsl"), "utf8");
		const match = wgsl.match(/const LEAK_RADIUS: f32 = ([\d.]+);/);
		expect(match).not.toBeNull();
		expect(Number(match?.[1])).toBe(LIGHT_LEAK_RADIUS);
	});
});

describe("punch zoom", () => {
	test("hits full punch at the start and settles back to 1", () => {
		expect(computePunchZoomScale({ intensity: 100, speed: 1, localTimeSeconds: 0 })).toBe(1.5);
		expect(computePunchZoomScale({ intensity: 50, speed: 1, localTimeSeconds: 0 })).toBe(1.25);
		const settled = computePunchZoomScale({ intensity: 100, speed: 1, localTimeSeconds: 0.5 });
		expect(settled).toBeGreaterThan(1);
		expect(settled).toBeLessThan(1.03);
	});

	test("decays monotonically, and faster at a higher speed", () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let t = 0; t <= 2; t += 0.05) {
			const scale = computePunchZoomScale({ intensity: 80, speed: 1, localTimeSeconds: t });
			expect(scale).toBeLessThan(previous);
			expect(scale).toBeGreaterThanOrEqual(1);
			previous = scale;
		}
		const slow = computePunchZoomScale({ intensity: 80, speed: 1, localTimeSeconds: 0.2 });
		const fast = computePunchZoomScale({ intensity: 80, speed: 2, localTimeSeconds: 0.2 });
		expect(fast).toBeLessThan(slow);
	});

	test("its pass carries that scale", () => {
		const uniforms = punchZoomEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 60, speed: 1.5 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.1,
			durationSeconds: 2,
		});
		expect(uniforms).toEqual({
			u_scale: computePunchZoomScale({ intensity: 60, speed: 1.5, localTimeSeconds: 0.1 }),
		});
	});
});

describe("flash", () => {
	test("is at full intensity on the first frame and nearly gone after 0.25 s", () => {
		expect(computeFlashAmount({ intensity: 80, speed: 1, localTimeSeconds: 0 })).toBe(0.8);
		const later = computeFlashAmount({ intensity: 100, speed: 1, localTimeSeconds: 0.25 });
		expect(later).toBeGreaterThan(0);
		expect(later).toBeLessThan(0.06);
	});

	test("white by default, black when asked", () => {
		expect(flashWhiteness({ effectParams: {} })).toBe(1);
		expect(flashWhiteness({ effectParams: { color: "white" } })).toBe(1);
		expect(flashWhiteness({ effectParams: { color: "black" } })).toBe(0);
	});

	test("its pass carries the amount and the colour", () => {
		const uniforms = flashEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 100, speed: 1, color: "black" },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0,
			durationSeconds: 2,
		});
		expect(uniforms).toEqual({ u_amount: 1, u_whiteness: 0 });
	});
});

describe("strobe", () => {
	test("starts dark, flashes to full intensity half a period in, and repeats", () => {
		expect(computeStrobeAmount({ intensity: 100, speed: 1, localTimeSeconds: 0 })).toBe(0);
		// 2 flashes per second at speed 1: peaks at 0.25 s, 0.75 s, ...
		expect(computeStrobeAmount({ intensity: 100, speed: 1, localTimeSeconds: 0.25 })).toBeCloseTo(1, 9);
		expect(computeStrobeAmount({ intensity: 100, speed: 1, localTimeSeconds: 0.5 })).toBeCloseTo(0, 9);
		expect(computeStrobeAmount({ intensity: 100, speed: 1, localTimeSeconds: 0.75 })).toBeCloseTo(1, 9);
	});

	test("no Speed position aliases the flashes away at 24 fps", () => {
		expectNoAliasingDip({
			speedMin: 0.25,
			speedMax: 2.25,
			minimumMeanDelta: 0.005,
			valueAt: ({ speed, seconds }) =>
				computeStrobeAmount({ intensity: 100, speed, localTimeSeconds: seconds }),
		});
	});

	test("shares the flash shader and its colour setting", () => {
		const uniforms = strobeEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 100, speed: 1, color: "white" },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.25,
			durationSeconds: 2,
		});
		expect(strobeEffectDefinition.renderer.passes[0].shader).toBe("flash");
		expect(uniforms.u_whiteness).toBe(1);
		expect(uniforms.u_amount).toBeCloseTo(1, 9);
	});
});

describe("glitch", () => {
	const at = (localTimeSeconds: number) =>
		computeGlitchOffsets({ intensity: 100, speed: 1, localTimeSeconds, referenceSize: 1080 });

	test("zero intensity never splits the channels", () => {
		for (let t = 0; t < 5; t += 0.03) {
			const { red, blue } = computeGlitchOffsets({
				intensity: 0,
				speed: 1,
				localTimeSeconds: t,
				referenceSize: 1080,
			});
			for (const value of [...red, ...blue]) expect(value).toBeCloseTo(0, 12);
		}
	});

	test("glitches in some windows and not others, holding each window's offset", () => {
		let glitching = 0;
		const windows = 80; // 10 s at 8 windows per second
		for (let window = 0; window < windows; window++) {
			const start = at(window / 8 + 0.001);
			const end = at(window / 8 + 0.12);
			expect(end).toEqual(start);
			if (start.red[0] !== 0) glitching++;
		}
		expect(glitching).toBeGreaterThan(windows * 0.3);
		expect(glitching).toBeLessThan(windows * 0.7);
	});

	test("red and blue split in opposite directions, within the amplitude budget", () => {
		const budget = 0.02 * 1080;
		for (let t = 0; t < 10; t += 0.0625) {
			const { red, blue } = at(t);
			expect(blue[0]).toBeCloseTo(-red[0], 12);
			expect(blue[1]).toBeCloseTo(-red[1], 12);
			expect(Math.abs(red[0])).toBeLessThanOrEqual(budget + 1e-9);
			expect(Math.abs(red[1])).toBeLessThanOrEqual(0.15 * budget + 1e-9);
		}
	});

	test("the same moment always glitches the same way", () => {
		expect(at(3.21)).toEqual(at(3.21));
	});

	test("its pass carries both offsets", () => {
		const uniforms = glitchEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 100, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 3.21,
			durationSeconds: 5,
		});
		const expected = at(3.21);
		expect(uniforms).toEqual({ u_red_offset: expected.red, u_blue_offset: expected.blue });
	});
});

describe("blur pulse", () => {
	test("is sharp (no passes at all) on the first frame", () => {
		const passes = blurPulseEffectDefinition.renderer.buildPasses?.({
			effectParams: { intensity: 100, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0,
			durationSeconds: 5,
		});
		expect(passes).toEqual([]);
	});

	test("reaches the Blur effect's own sigma for that intensity mid-breath", () => {
		// 0.5 breaths per second at speed 1: fully blurred at 1 s.
		expect(computeBlurPulseIntensity({ intensity: 40, speed: 1, localTimeSeconds: 1 })).toBeCloseTo(40, 9);
		const passes = blurPulseEffectDefinition.renderer.buildPasses?.({
			effectParams: { intensity: 40, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 1,
			durationSeconds: 5,
		});
		expect(passes?.[0].shader).toBe("gaussian-blur");
		expect(passes?.[0].uniforms.u_sigma).toBeCloseTo(
			intensityToSigma({ intensity: 40, resolution: 1920, reference: 1920 }),
			9,
		);
	});

	test("no Speed position aliases the breathing away at 24 fps", () => {
		expectNoAliasingDip({
			speedMin: 0.25,
			speedMax: 3,
			minimumMeanDelta: 0.05,
			valueAt: ({ speed, seconds }) =>
				computeBlurPulseIntensity({ intensity: 100, speed, localTimeSeconds: seconds }),
		});
	});
});

describe("vignette pulse", () => {
	test("starts with no vignette and peaks at full intensity half a period in", () => {
		expect(computeVignettePulseAmount({ intensity: 60, speed: 1, localTimeSeconds: 0 })).toBe(0);
		// 0.8 pulses per second at speed 1: peak at 0.625 s.
		expect(
			computeVignettePulseAmount({ intensity: 60, speed: 1, localTimeSeconds: 0.625 }),
		).toBeCloseTo(0.6, 9);
	});

	test("no Speed position aliases the pulse away at 24 fps", () => {
		expectNoAliasingDip({
			speedMin: 0.25,
			speedMax: 3,
			minimumMeanDelta: 0.001,
			valueAt: ({ speed, seconds }) =>
				computeVignettePulseAmount({ intensity: 100, speed, localTimeSeconds: seconds }),
		});
	});

	test("its pass carries the amount", () => {
		const uniforms = vignettePulseEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 60, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.625,
			durationSeconds: 5,
		});
		expect(uniforms.u_amount).toBeCloseTo(0.6, 9);
	});
});

describe("film grain", () => {
	test("holds one pattern for a moment, then steps to the next", () => {
		// 12 patterns per second at speed 1.
		const first = computeFilmGrainSeed({ speed: 1, localTimeSeconds: 0.01 });
		expect(computeFilmGrainSeed({ speed: 1, localTimeSeconds: 0.08 })).toBe(first);
		expect(computeFilmGrainSeed({ speed: 1, localTimeSeconds: 0.09 })).not.toBe(first);
		expect(computeFilmGrainSeed({ speed: 2, localTimeSeconds: 0.05 })).not.toBe(first);
	});

	test("the seed stays a small whole number however long the clip is", () => {
		for (const t of [0, 1.5, 83.99, 600, 3600]) {
			const seed = computeFilmGrainSeed({ speed: 2, localTimeSeconds: t });
			expect(Number.isInteger(seed)).toBe(true);
			expect(seed).toBeGreaterThanOrEqual(0);
			expect(seed).toBeLessThan(1009);
		}
	});

	test("intensity maps to grain amount", () => {
		expect(computeFilmGrainAmount({ intensity: 100 })).toBeCloseTo(0.2, 12);
		expect(computeFilmGrainAmount({ intensity: 40 })).toBeCloseTo(0.08, 12);
		const uniforms = filmGrainEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 40, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.5,
			durationSeconds: 5,
		});
		expect(uniforms).toEqual({ u_seed: 6, u_amount: computeFilmGrainAmount({ intensity: 40 }) });
	});
});

describe("light leak", () => {
	// The most light any on-screen pixel gets, mirroring light_leak.wgsl:
	// strength = clamp(1 - dist / radius, 0, 1)^2 * intensity, largest at the
	// on-screen point nearest the centre. Intensity 100 -> 0.8.
	const brightestPixel = ([x, y]: [number, number]) => {
		const nearestX = Math.min(Math.max(x, 0), 1);
		const nearestY = Math.min(Math.max(y, 0), 1);
		const dist = Math.hypot(x - nearestX, y - nearestY);
		const falloff = Math.min(Math.max(1 - dist / LIGHT_LEAK_RADIUS, 0), 1);
		return falloff * falloff * 0.8;
	};
	// Below one step of an 8-bit channel: no exported pixel can show it.
	const INVISIBLE = 1 / 255;

	test("starts fully outside the frame, so the first frame is clean", () => {
		expect(brightestPixel(computeLightLeakCenter({ speed: 1, localTimeSeconds: 0 }))).toBe(0);
	});

	test("sweeps left to right across the frame, then restarts where no one can see", () => {
		let previousX = Number.NEGATIVE_INFINITY;
		for (let t = 0; t < 3.99; t += 0.05) {
			const [x] = computeLightLeakCenter({ speed: 1, localTimeSeconds: t });
			expect(x).toBeGreaterThan(previousX);
			previousX = x;
		}
		expect(
			brightestPixel(computeLightLeakCenter({ speed: 1, localTimeSeconds: 2 })),
		).toBeGreaterThan(0.5);
		// The light fades to nothing before the 4 s wrap and starts from
		// nothing after it, so the jump of the centre is never visible.
		for (const t of [3.95, 3.9999, 4, 4.0001, 4.05]) {
			expect(
				brightestPixel(computeLightLeakCenter({ speed: 1, localTimeSeconds: t })),
			).toBeLessThan(INVISIBLE);
		}
	});

	test("its pass carries the centre and the strength", () => {
		const uniforms = lightLeakEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 50, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 2,
			durationSeconds: 5,
		});
		expect(uniforms).toEqual({
			u_center: computeLightLeakCenter({ speed: 1, localTimeSeconds: 2 }),
			u_intensity: 0.4,
		});
	});
});

describe("rotate wobble", () => {
	test("starts level and never exceeds its maximum angle", () => {
		expect(computeRotateWobbleAngle({ intensity: 100, speed: 1, localTimeSeconds: 0 })).toBe(0);
		const max = maxWobbleAngleRadians({ intensity: 100 });
		expect(max).toBeCloseTo((8 * Math.PI) / 180, 12);
		for (let t = 0; t < 10; t += 0.01) {
			const angle = computeRotateWobbleAngle({ intensity: 100, speed: 3, localTimeSeconds: t });
			expect(Math.abs(angle)).toBeLessThanOrEqual(max + 1e-12);
		}
	});

	test("the cover zoom keeps every corner on the picture at every angle it can reach", () => {
		// Mirror of the sampling math in rotate_wobble.wgsl.
		const sampleUv = ({
			uv,
			angle,
			scale,
			aspect,
		}: {
			uv: [number, number];
			angle: number;
			scale: number;
			aspect: number;
		}) => {
			const cx = ((uv[0] - 0.5) * aspect) / scale;
			const cy = (uv[1] - 0.5) / scale;
			const rx = cx * Math.cos(angle) - cy * Math.sin(angle);
			const ry = cx * Math.sin(angle) + cy * Math.cos(angle);
			return [rx / aspect + 0.5, ry + 0.5];
		};
		const corners: [number, number][] = [
			[0, 0],
			[0, 1],
			[1, 0],
			[1, 1],
		];
		for (const [width, height] of [
			[1920, 1080],
			[1080, 1920],
			[1000, 1000],
		]) {
			const max = maxWobbleAngleRadians({ intensity: 100 });
			const scale = computeCoverScale({ maxAngleRadians: max, width, height });
			expect(scale).toBeGreaterThan(1);
			for (let angle = -max; angle <= max + 1e-12; angle += max / 20) {
				for (const corner of corners) {
					const [u, v] = sampleUv({ uv: corner, angle, scale, aspect: width / height });
					expect(u).toBeGreaterThanOrEqual(-1e-9);
					expect(u).toBeLessThanOrEqual(1 + 1e-9);
					expect(v).toBeGreaterThanOrEqual(-1e-9);
					expect(v).toBeLessThanOrEqual(1 + 1e-9);
				}
			}
		}
	});

	test("a clip scaled to nothing gets no zoom instead of dividing by zero", () => {
		expect(computeCoverScale({ maxAngleRadians: 0.1, width: 0, height: 0 })).toBe(1);
	});

	test("no Speed position aliases the swing away at 24 fps", () => {
		expectNoAliasingDip({
			speedMin: 0.25,
			speedMax: 3,
			minimumMeanDelta: 1e-4,
			valueAt: ({ speed, seconds }) =>
				computeRotateWobbleAngle({ intensity: 100, speed, localTimeSeconds: seconds }),
		});
	});

	test("its pass carries the angle and the cover zoom", () => {
		const uniforms = rotateWobbleEffectDefinition.renderer.passes[0].uniforms({
			effectParams: { intensity: 50, speed: 1 },
			width: 1920,
			height: 1080,
			localTimeSeconds: 0.3,
			durationSeconds: 5,
		});
		expect(uniforms).toEqual({
			u_angle: computeRotateWobbleAngle({ intensity: 50, speed: 1, localTimeSeconds: 0.3 }),
			u_cover_scale: computeCoverScale({
				maxAngleRadians: maxWobbleAngleRadians({ intensity: 50 }),
				width: 1920,
				height: 1080,
			}),
		});
	});
});
