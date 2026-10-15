import type { EffectDefinition } from "@/effects/types";
import {
	assertNyquistSafe,
	parseClampedNumberParam,
} from "./time-based-effect-utils";

export const ROTATE_WOBBLE_SHADER = "rotate-wobble";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 50;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_DEFAULT = 1;

// At intensity 100 the frame swings up to +/-8 degrees.
const MAX_ANGLE_DEGREES = 8;

// Two sine terms (the second 1.4x faster) so the swing is not a perfectly
// regular pendulum. Both start at 0, so the first frame is unrotated.
const BASE_FREQUENCY_HZ = 1.2;
const SECONDARY_MULTIPLIER = 1.4;

assertNyquistSafe({
	effectName: "rotate wobble",
	worstCaseHz: BASE_FREQUENCY_HZ * SECONDARY_MULTIPLIER * SPEED_MAX,
});

export function maxWobbleAngleRadians({
	intensity,
}: {
	intensity: number;
}): number {
	return (intensity / 100) * MAX_ANGLE_DEGREES * (Math.PI / 180);
}

/** Rotation in radians at this moment, within +/- maxWobbleAngleRadians. */
export function computeRotateWobbleAngle({
	intensity,
	speed,
	localTimeSeconds,
}: {
	intensity: number;
	speed: number;
	localTimeSeconds: number;
}): number {
	const t = Math.max(localTimeSeconds, 0) * speed;
	return (
		maxWobbleAngleRadians({ intensity }) *
		(0.7 * Math.sin(2 * Math.PI * BASE_FREQUENCY_HZ * t) +
			0.3 * Math.sin(2 * Math.PI * BASE_FREQUENCY_HZ * SECONDARY_MULTIPLIER * t))
	);
}

/**
 * Smallest constant zoom that keeps a width x height frame covering itself
 * while rotated by up to `maxAngleRadians`, so no corner ever shows through.
 * A frame corner rotated by theta stays inside the zoomed frame on both axes
 * when zoom >= cos(theta) + (long side / short side) * sin(theta).
 */
export function computeCoverScale({
	maxAngleRadians,
	width,
	height,
}: {
	maxAngleRadians: number;
	width: number;
	height: number;
}): number {
	// A clip scaled to nothing has no frame to cover (and would divide by 0).
	if (!(width > 0 && height > 0)) return 1;
	const theta = Math.abs(maxAngleRadians);
	const elongation = Math.max(width / height, height / width);
	return Math.cos(theta) + elongation * Math.sin(theta);
}

export const rotateWobbleEffectDefinition: EffectDefinition = {
	type: "rotate-wobble",
	name: "Rotate wobble",
	keywords: ["rotate", "wobble", "swing", "tilt", "sway"],
	// Grid thumbnail: near the first swing's widest angle.
	previewTimeSeconds: 0.2,
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
				shader: ROTATE_WOBBLE_SHADER,
				uniforms: ({ effectParams, width, height, localTimeSeconds }) => {
					const intensity = parseClampedNumberParam({
						effectParams,
						key: "intensity",
						fallback: INTENSITY_DEFAULT,
						min: INTENSITY_MIN,
						max: INTENSITY_MAX,
					});
					const speed = parseClampedNumberParam({
						effectParams,
						key: "speed",
						fallback: SPEED_DEFAULT,
						min: SPEED_MIN,
						max: SPEED_MAX,
					});
					return {
						u_angle: computeRotateWobbleAngle({
							intensity,
							speed,
							localTimeSeconds,
						}),
						u_cover_scale: computeCoverScale({
							maxAngleRadians: maxWobbleAngleRadians({ intensity }),
							width,
							height,
						}),
					};
				},
			},
		],
	},
};
