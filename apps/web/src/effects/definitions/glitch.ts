import type { EffectDefinition } from "@/effects/types";
import {
	assertNyquistSafe,
	parseClampedNumberParam,
} from "./time-based-effect-utils";

export const GLITCH_SHADER = "glitch";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 50;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const SPEED_DEFAULT = 1;

// At intensity 100 a glitch pulls red and blue up to 2% of the frame's
// short side apart each (~22 px at 1080p).
const MAX_OFFSET_FRACTION = 0.02;

// Time is cut into windows (this many per second at speed 1). Each window
// either glitches, with its own offset, or stays clean — decided by a hash
// of the window's index, so the same moment always glitches the same way in
// preview and export.
const WINDOWS_PER_SECOND = 8;
const GLITCH_PROBABILITY = 0.5;

// A run of windows that switches R times per second alternates at up to
// R/2 Hz; at SPEED_MAX that is 8 Hz, so every window still lasts 1.5
// frames at 24 fps and none is skipped entirely.
assertNyquistSafe({
	effectName: "glitch",
	worstCaseHz: (WINDOWS_PER_SECOND * SPEED_MAX) / 2,
});

/**
 * Integer hash of `n` to [0, 1), built from the multiply/xor-shift steps of
 * MurmurHash3's `fmix32` finalizer (not fmix32 exactly). Pure 32-bit integer
 * math, so — unlike a Math.sin-based hash — it does not depend on how the JS
 * engine implements trigonometry.
 */
function hash01(n: number): number {
	let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	x ^= x >>> 16;
	return (x >>> 0) / 4294967296;
}

export function computeGlitchOffsets({
	intensity,
	speed,
	localTimeSeconds,
	referenceSize,
}: {
	intensity: number;
	speed: number;
	localTimeSeconds: number;
	referenceSize: number;
}): { red: [number, number]; blue: [number, number] } {
	const windowIndex = Math.floor(
		Math.max(localTimeSeconds, 0) * speed * WINDOWS_PER_SECOND,
	);
	const seed = windowIndex * 4;
	if (hash01(seed) >= GLITCH_PROBABILITY) {
		return { red: [0, 0], blue: [0, 0] };
	}
	const amplitude = (intensity / 100) * MAX_OFFSET_FRACTION * referenceSize;
	const magnitude = amplitude * (0.4 + 0.6 * hash01(seed + 1));
	const direction = hash01(seed + 2) < 0.5 ? -1 : 1;
	const vertical = amplitude * 0.15 * (hash01(seed + 3) * 2 - 1);
	return {
		red: [direction * magnitude, vertical],
		blue: [-direction * magnitude, -vertical],
	};
}

export const glitchEffectDefinition: EffectDefinition = {
	type: "glitch",
	name: "Glitch",
	keywords: ["glitch", "rgb", "split", "chromatic", "distortion"],
	// Grid thumbnail: inside the first window, which glitches (pinned by a test).
	previewTimeSeconds: 0.06,
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
				shader: GLITCH_SHADER,
				uniforms: ({ effectParams, width, height, localTimeSeconds }) => {
					const { red, blue } = computeGlitchOffsets({
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
						referenceSize: Math.min(width, height),
					});
					return { u_red_offset: red, u_blue_offset: blue };
				},
			},
		],
	},
};
