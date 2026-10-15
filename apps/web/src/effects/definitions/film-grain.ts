import type { EffectDefinition } from "@/effects/types";
import { parseClampedNumberParam } from "./time-based-effect-utils";

export const FILM_GRAIN_SHADER = "film-grain";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 40;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const SPEED_DEFAULT = 1;

// At intensity 100 each pixel moves by up to +/-0.2 (on a 0..1 scale) —
// heavy; the default 40 (+/-0.08) reads as visible but not distracting.
const MAX_GRAIN = 0.2;

// New grain patterns per second at speed 1. At SPEED_MAX that is 24 per
// second — one per frame at the slowest export frame rate we support, so
// every step of the Speed slider still changes how often the grain moves
// (above 24/s a 24 fps export could not show the difference).
const REFRESHES_PER_SECOND = 12;

// The seed wraps around so it stays a small integer that an f32 holds
// exactly however long the clip is (the shader turns it into a u32).
const SEED_PERIOD = 1009;

/** Which grain pattern is showing: a whole number that steps over time. */
export function computeFilmGrainSeed({
	speed,
	localTimeSeconds,
}: {
	speed: number;
	localTimeSeconds: number;
}): number {
	const step = Math.floor(
		Math.max(localTimeSeconds, 0) * speed * REFRESHES_PER_SECOND,
	);
	return step % SEED_PERIOD;
}

export function computeFilmGrainAmount({
	intensity,
}: {
	intensity: number;
}): number {
	return (intensity / 100) * MAX_GRAIN;
}

export const filmGrainEffectDefinition: EffectDefinition = {
	type: "film-grain",
	name: "Film grain",
	keywords: ["grain", "film", "noise", "vintage", "analog"],
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
				shader: FILM_GRAIN_SHADER,
				uniforms: ({ effectParams, localTimeSeconds }) => ({
					u_seed: computeFilmGrainSeed({
						speed: parseClampedNumberParam({
							effectParams,
							key: "speed",
							fallback: SPEED_DEFAULT,
							min: SPEED_MIN,
							max: SPEED_MAX,
						}),
						localTimeSeconds,
					}),
					u_amount: computeFilmGrainAmount({
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
