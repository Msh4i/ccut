import type { EffectDefinition } from "@/effects/types";
import {
	assertNyquistSafe,
	parseClampedNumberParam,
} from "./time-based-effect-utils";

export const VIGNETTE_PULSE_SHADER = "vignette-pulse";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 60;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_DEFAULT = 1;

// Pulses per second at speed 1.
const BASE_FREQUENCY_HZ = 0.8;

assertNyquistSafe({
	effectName: "vignette pulse",
	worstCaseHz: BASE_FREQUENCY_HZ * SPEED_MAX,
});

/** Vignette strength (0..1): 0 at the start, then pulsing up to intensity. */
export function computeVignettePulseAmount({
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
	return (intensity / 100) * (0.5 - 0.5 * Math.cos(phase));
}

export const vignettePulseEffectDefinition: EffectDefinition = {
	type: "vignette-pulse",
	name: "Vignette pulse",
	keywords: ["vignette", "pulse", "heartbeat", "dark", "edges"],
	// Grid thumbnail: the first pulse at its darkest.
	previewTimeSeconds: 0.625,
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
		passes: [
			{
				shader: VIGNETTE_PULSE_SHADER,
				uniforms: ({ effectParams, localTimeSeconds }) => ({
					u_amount: computeVignettePulseAmount({
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
					}),
				}),
			},
		],
	},
};
