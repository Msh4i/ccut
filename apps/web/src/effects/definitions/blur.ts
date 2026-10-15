import type { EffectDefinition, EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";

export const GAUSSIAN_BLUR_SHADER = "gaussian-blur";

const MAX_SINGLE_PASS_SIGMA = 10;
const MAX_STEP = 4;
const MAX_ITERATIONS = 8;
/** Below this an axis is not blurred at all (and gets no pass). */
const MIN_SIGMA = 0.001;
/**
 * Far beyond any frame (8K is 7680 px wide), where every pixel already sees the
 * whole picture. Keeps the shader's f32 maths (tap offset squared over twice
 * sigma squared) away from overflow, which would make the weights NaN.
 */
export const MAX_BLUR_SIGMA = 10_000;

/**
 * The sigma an axis is blurred by: 0 (no pass for that axis) when it is too
 * small, negative or not a number. A pass with a sigma of 0 or NaN would make
 * the shader divide 0 by 0 for its centre tap and turn the layer into NaN.
 */
function usableSigma(sigma: number): number {
	if (!Number.isFinite(sigma) || sigma < MIN_SIGMA) return 0;
	return Math.min(sigma, MAX_BLUR_SIGMA);
}

/**
 * Tap spacing of one pass with this sigma: one tap per pixel up to
 * MAX_SINGLE_PASS_SIGMA, then spread so the 61 taps still span the Gaussian.
 */
export function blurPassStep(sigma: number): number {
	return Math.max(1, sigma / MAX_SINGLE_PASS_SIGMA);
}

/**
 * The shader takes 61 taps per pass per pixel whatever the sigma, so the pass
 * count is the cost. The taps sit `step` px apart (at most MAX_STEP, which keeps
 * a sharp input from aliasing). `sourceDownscale` says the input was drawn that
 * many times smaller and stretched back, so it has no detail finer than that
 * many px and the taps may be spaced that far apart: a strong blur then takes
 * far fewer passes for the same Gaussian.
 */
export function buildGaussianBlurPasses({
	sigmaX,
	sigmaY,
	sourceDownscale = 1,
}: {
	sigmaX: number;
	sigmaY: number;
	sourceDownscale?: number;
}): EffectPass[] {
	const usableX = usableSigma(sigmaX);
	const usableY = usableSigma(sigmaY);
	const maxSigma = Math.max(usableX, usableY);
	if (maxSigma === 0) return [];

	const maxStep = Number.isFinite(sourceDownscale)
		? Math.max(MAX_STEP, sourceDownscale)
		: MAX_STEP;
	const maxEffectiveSigma = MAX_SINGLE_PASS_SIGMA * maxStep;
	const iterations = Math.min(
		MAX_ITERATIONS,
		Math.max(
			1,
			Math.ceil((maxSigma * maxSigma) / (maxEffectiveSigma * maxEffectiveSigma)),
		),
	);
	const perPassSigmaX = usableX / Math.sqrt(iterations);
	const perPassSigmaY = usableY / Math.sqrt(iterations);
	const stepX = blurPassStep(perPassSigmaX);
	const stepY = blurPassStep(perPassSigmaY);

	const passes: EffectPass[] = [];
	for (let i = 0; i < iterations; i++) {
		if (usableX > 0) {
			passes.push({
				shader: GAUSSIAN_BLUR_SHADER,
				uniforms: {
					u_sigma: perPassSigmaX,
					u_step: stepX,
					u_direction: [1, 0],
				},
			});
		}
		if (usableY > 0) {
			passes.push({
				shader: GAUSSIAN_BLUR_SHADER,
				uniforms: {
					u_sigma: perPassSigmaY,
					u_step: stepY,
					u_direction: [0, 1],
				},
			});
		}
	}
	return passes;
}

export const INTENSITY_TO_SIGMA_DIVISOR = 5;

export function intensityToSigma({ intensity, resolution, reference }: { intensity: number; resolution: number; reference: number }): number {
	return (intensity / INTENSITY_TO_SIGMA_DIVISOR) * (resolution / reference);
}

/**
 * The intensity param: a number, or a number in a string (old project files
 * hold that). Anything else is NaN. Whatever the sigma becomes from it or from
 * the clip's size (NaN, negative, infinite: a project file, a bezier keyframe
 * overshooting below 0, a clip scaled to 0) is made safe by `usableSigma`.
 */
function readIntensity(effectParams: ParamValues): number {
	const raw = effectParams.intensity;
	if (typeof raw === "number") return raw;
	return typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
}

/** Sigma of one fixed pass template: never 0 or NaN (see usableSigma). */
function templateSigma(sigma: number): number {
	return Math.max(usableSigma(sigma), MIN_SIGMA);
}

export const blurEffectDefinition: EffectDefinition = {
	type: "blur",
	name: "Blur",
	keywords: ["blur", "soft", "defocus"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 15,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		passes: [
			{
				shader: GAUSSIAN_BLUR_SHADER,
				uniforms: ({ effectParams, width }) => ({
					u_sigma: templateSigma(intensityToSigma({ intensity: readIntensity(effectParams), resolution: width, reference: 1920 })),
					u_step: 1,
					u_direction: [1, 0],
				}),
			},
			{
				shader: GAUSSIAN_BLUR_SHADER,
				uniforms: ({ effectParams, height }) => ({
					u_sigma: templateSigma(intensityToSigma({ intensity: readIntensity(effectParams), resolution: height, reference: 1080 })),
					u_step: 1,
					u_direction: [0, 1],
				}),
			},
		],
		buildPasses: ({ effectParams, width, height }) => {
			const intensity = readIntensity(effectParams);
			return buildGaussianBlurPasses({
				sigmaX: intensityToSigma({ intensity, resolution: width, reference: 1920 }),
				sigmaY: intensityToSigma({ intensity, resolution: height, reference: 1080 }),
			});
		},
	},
};
