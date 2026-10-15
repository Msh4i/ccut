import type { EffectDefinition } from "@/effects/types";
import { FLASH_COLOR_PARAM, FLASH_SHADER, flashWhiteness } from "./flash";
import {
	assertNyquistSafe,
	parseClampedNumberParam,
} from "./time-based-effect-utils";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 70;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2.25;
const SPEED_DEFAULT = 1;

// Flashes per second at speed 1.
const BASE_FREQUENCY_HZ = 2;

// Each flash is (0.5 - 0.5 cos)^2 rather than a plain sine so it reads as a
// short flash, not a slow fade — but squaring adds a second harmonic at
// twice the flash rate, so it is that 2x frequency (2 * 2 * 2.25 = 9 Hz at
// SPEED_MAX) that has to stay clear of the 24 fps Nyquist limit.
assertNyquistSafe({
	effectName: "strobe",
	worstCaseHz: 2 * BASE_FREQUENCY_HZ * SPEED_MAX,
});

/** Blend amount toward the flash colour; 0 at the start, then pulsing. */
export function computeStrobeAmount({
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
	const pulse = 0.5 - 0.5 * Math.cos(phase);
	return (intensity / 100) * pulse * pulse;
}

export const strobeEffectDefinition: EffectDefinition = {
	type: "strobe",
	name: "Strobe",
	keywords: ["strobe", "flicker", "flash", "party"],
	// Grid thumbnail: the first flash at its brightest.
	previewTimeSeconds: 0.25,
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
		FLASH_COLOR_PARAM,
	],
	renderer: {
		passes: [
			{
				shader: FLASH_SHADER,
				uniforms: ({ effectParams, localTimeSeconds }) => ({
					u_amount: computeStrobeAmount({
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
					u_whiteness: flashWhiteness({ effectParams }),
				}),
			},
		],
	},
};
