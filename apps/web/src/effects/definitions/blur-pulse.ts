import type { EffectDefinition } from "@/effects/types";
import { buildGaussianBlurPasses, intensityToSigma } from "./blur";
import {
	assertNyquistSafe,
	parseClampedNumberParam,
} from "./time-based-effect-utils";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 40;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_DEFAULT = 1;

// One full breath (sharp -> blurred -> sharp) every 2 s at speed 1.
const BASE_FREQUENCY_HZ = 0.5;

assertNyquistSafe({
	effectName: "blur pulse",
	worstCaseHz: BASE_FREQUENCY_HZ * SPEED_MAX,
});

/**
 * The Blur effect's own intensity scale, breathing between 0 (sharp, at the
 * start) and `intensity`.
 */
export function computeBlurPulseIntensity({
	intensity,
	speed,
	localTimeSeconds,
}: {
	intensity: number;
	speed: number;
	localTimeSeconds: number;
}): number {
	const phase =
		2 * Math.PI * BASE_FREQUENCY_HZ * speed * Math.max(localTimeSeconds, 0);
	return intensity * (0.5 - 0.5 * Math.cos(phase));
}

export const blurPulseEffectDefinition: EffectDefinition = {
	type: "blur-pulse",
	name: "Blur pulse",
	keywords: ["blur", "pulse", "breathe", "dreamy", "focus"],
	// Grid thumbnail: the middle of the first breath, fully blurred.
	previewTimeSeconds: 1,
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: INTENSITY_DEFAULT,
			min: INTENSITY_MIN,
			max: INTENSITY_MAX,
			step: 1,
		},
		{
			key: "speed",
			label: "Speed",
			type: "number",
			default: SPEED_DEFAULT,
			min: SPEED_MIN,
			max: SPEED_MAX,
			step: 0.05,
		},
	],
	renderer: {
		// Reuses the Blur effect's gaussian-blur shader; the pass count varies
		// with the current sigma (none at all while sharp), so buildPasses
		// always takes over and there is no static pass list.
		passes: [],
		buildPasses: ({ effectParams, width, height, localTimeSeconds }) => {
			const pulsed = computeBlurPulseIntensity({
				intensity: parseClampedNumberParam({
					effectParams,
					key: "intensity",
					fallback: INTENSITY_DEFAULT,
					min: INTENSITY_MIN,
					max: INTENSITY_MAX,
				}),
				speed: parseClampedNumberParam({
					effectParams,
					key: "speed",
					fallback: SPEED_DEFAULT,
					min: SPEED_MIN,
					max: SPEED_MAX,
				}),
				localTimeSeconds,
			});
			return buildGaussianBlurPasses({
				sigmaX: intensityToSigma({
					intensity: pulsed,
					resolution: width,
					reference: 1920,
				}),
				sigmaY: intensityToSigma({
					intensity: pulsed,
					resolution: height,
					reference: 1080,
				}),
			});
		},
	},
};
