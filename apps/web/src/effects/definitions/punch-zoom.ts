import type { EffectDefinition } from "@/effects/types";
import { parseClampedNumberParam } from "./time-based-effect-utils";

export const PUNCH_ZOOM_SHADER = "punch-zoom";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 50;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_DEFAULT = 1;

// At intensity 100 the frame starts zoomed 1.5x and settles back to 1x.
const MAX_PUNCH = 0.5;
// At speed 1 the punch has decayed to ~5% of its peak after 0.5s
// (exp(-6 * 0.5) =~ 0.05). A one-shot decay is not periodic, so unlike the
// oscillating effects there is no Nyquist limit to respect here.
const DECAY_PER_SECOND = 6;

/** Zoom scale (>= 1) at this moment: full punch at the start, decaying to 1. */
export function computePunchZoomScale({
	intensity,
	speed,
	localTimeSeconds,
}: {
	intensity: number;
	speed: number;
	localTimeSeconds: number;
}): number {
	const punch = (intensity / 100) * MAX_PUNCH;
	return (
		1 + punch * Math.exp(-DECAY_PER_SECOND * speed * Math.max(localTimeSeconds, 0))
	);
}

export const punchZoomEffectDefinition: EffectDefinition = {
	type: "punch-zoom",
	name: "Punch zoom",
	keywords: ["zoom", "punch", "impact", "beat"],
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
				shader: PUNCH_ZOOM_SHADER,
				uniforms: ({ effectParams, localTimeSeconds }) => ({
					u_scale: computePunchZoomScale({
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
