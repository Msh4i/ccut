import type { EffectDefinition } from "@/effects/types";
import type { ParamDefinition } from "@/params";
import { parseClampedNumberParam } from "./time-based-effect-utils";

/** Shared with Strobe: both blend toward a flat colour, only the timing differs. */
export const FLASH_SHADER = "flash";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 80;
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_DEFAULT = 1;

// At speed 1, ~5% of the flash is left after 0.25s (exp(-12 * 0.25) =~
// 0.05). A one-shot decay is not periodic, so there is no Nyquist limit to
// respect here.
const DECAY_PER_SECOND = 12;

export const FLASH_COLOR_PARAM: ParamDefinition = {
	key: "color",
	label: "Color",
	type: "select",
	default: "white",
	options: [
		{ value: "white", label: "White" },
		{ value: "black", label: "Black" },
	],
};

/** 1 for a white flash, 0 for a black one (the shader's `extra.y`). */
export function flashWhiteness({
	effectParams,
}: {
	effectParams: Record<string, unknown>;
}): number {
	return effectParams.color === "black" ? 0 : 1;
}

/** Blend amount toward the flash colour: full at the start, then decaying. */
export function computeFlashAmount({
	intensity,
	speed,
	localTimeSeconds,
}: {
	intensity: number;
	speed: number;
	localTimeSeconds: number;
}): number {
	return (
		(intensity / 100) *
		Math.exp(-DECAY_PER_SECOND * speed * Math.max(localTimeSeconds, 0))
	);
}

export const flashEffectDefinition: EffectDefinition = {
	type: "flash",
	name: "Flash",
	keywords: ["flash", "white", "black", "transition", "impact"],
	// Grid thumbnail: part-way into the fade, so the picture shows through the flash.
	previewTimeSeconds: 0.08,
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
					u_amount: computeFlashAmount({
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
