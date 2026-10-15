import type { EffectDefinition } from "@/effects/types";
import { parseClampedNumberParam } from "./time-based-effect-utils";

export const LIGHT_LEAK_SHADER = "light-leak";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 50;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_DEFAULT = 1;

// How much the leak adds at its centre at intensity 100 (on a 0..1 scale,
// tinted warm — see LEAK_COLOR in light_leak.wgsl).
const MAX_STRENGTH = 0.8;

// One full sweep across the frame every 4 s at speed 1. The sweep is a
// straight drift, not an oscillation, so it has no Nyquist limit: at
// SPEED_MAX the centre still moves only ~0.07 of the frame per 24 fps frame.
const SWEEPS_PER_SECOND = 0.25;

/**
 * Must equal LEAK_RADIUS in light_leak.wgsl (a test checks this). The sweep
 * starts and ends a full radius outside the frame, so at the moment it wraps
 * from its end back to its start no pixel is lit by either position — the
 * restart is invisible — and the very first frame of the effect is clean.
 */
export const LIGHT_LEAK_RADIUS = 0.6;

/** Leak centre in UV space (0..1 is on-screen), drifting top-left to bottom-right. */
export function computeLightLeakCenter({
	speed,
	localTimeSeconds,
}: {
	speed: number;
	localTimeSeconds: number;
}): [number, number] {
	const progress =
		(Math.max(localTimeSeconds, 0) * speed * SWEEPS_PER_SECOND) % 1;
	const x = -LIGHT_LEAK_RADIUS + progress * (1 + 2 * LIGHT_LEAK_RADIUS);
	const y = 0.25 + 0.5 * progress;
	return [x, y];
}

export function computeLightLeakStrength({
	intensity,
}: {
	intensity: number;
}): number {
	return (intensity / 100) * MAX_STRENGTH;
}

export const lightLeakEffectDefinition: EffectDefinition = {
	type: "light-leak",
	name: "Light leak",
	keywords: ["light", "leak", "flare", "warm", "film", "glow"],
	// Grid thumbnail: half-way through the sweep, centred in the frame.
	previewTimeSeconds: 2,
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
				shader: LIGHT_LEAK_SHADER,
				uniforms: ({ effectParams, localTimeSeconds }) => ({
					u_center: computeLightLeakCenter({
						speed: parseClampedNumberParam({
							effectParams,
							key: "speed",
							fallback: SPEED_DEFAULT,
							min: SPEED_MIN,
							max: SPEED_MAX,
						}),
						localTimeSeconds,
					}),
					u_intensity: computeLightLeakStrength({
						intensity: parseClampedNumberParam({
							effectParams,
							key: "intensity",
							fallback: INTENSITY_DEFAULT,
							min: INTENSITY_MIN,
							max: INTENSITY_MAX,
						}),
					}),
				}),
			},
		],
	},
};
