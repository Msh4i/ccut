import type { EffectDefinition } from "@/effects/types";
import {
	assertNyquistSafe,
	parseClampedNumberParam,
} from "./time-based-effect-utils";

export const SHAKE_SHADER = "shake";

const INTENSITY_MIN = 0;
const INTENSITY_MAX = 100;
const INTENSITY_DEFAULT = 50;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const SPEED_DEFAULT = 1;

// At 1080p and intensity 100 the offset amplitude is ~0.03 * 1080 =~ 32px,
// which keeps the edge band the shader has to stretch (see shake.wgsl) modest.
const MAX_AMPLITUDE_FRACTION = 0.03;

// Four sine terms at BASE_FREQUENCY_HZ * {1, X_SECONDARY, Y_PRIMARY, Y_SECONDARY}
// give x and y different, decorrelated motion instead of a single clean
// circle. The phases below are arbitrary (just enough to desync the terms)
// and have no other meaning.
const BASE_FREQUENCY_HZ = 3;
const X_SECONDARY_MULTIPLIER = 1.35;
const Y_PRIMARY_MULTIPLIER = 0.82;
const Y_SECONDARY_MULTIPLIER = 1.55; // the highest of the four — sets the worst case below
const PHASE_X_SECONDARY = 1.3;
const PHASE_Y_PRIMARY = 0.7;
const PHASE_Y_SECONDARY = 2.1;

// The highest frequency any term can reach is BASE_FREQUENCY_HZ *
// Y_SECONDARY_MULTIPLIER * SPEED_MAX = 3 * 1.55 * 2 = 9.3 Hz. That has to
// stay under the Nyquist limit of the slowest export frame rate we support
// (24 fps -> 12 Hz) with real margin: sampling close to Nyquist aliases the
// motion down to near-zero (half the amplitude survives at ~10/12 of
// Nyquist, see the worked table in the round18 code review). 9.3 Hz is ~78%
// of 12 Hz, which measured clean in that review's simulation at 24, 25 and
// 30 fps. Raising SPEED_MAX, BASE_FREQUENCY_HZ or any multiplier must keep
// this product under control, or Speed will stop visibly doing anything at
// some slider positions.
assertNyquistSafe({
	effectName: "shake",
	worstCaseHz: BASE_FREQUENCY_HZ * Y_SECONDARY_MULTIPLIER * SPEED_MAX,
});

// A new effect-track or clip instance starts its offset ramped in from zero
// over this many seconds (or half the instance's duration, if shorter),
// instead of jumping straight to wherever the waveform happens to be at
// t=0.
const RAMP_IN_SECONDS = 0.15;

function rampInFactor({
	localTimeSeconds,
	durationSeconds,
}: {
	localTimeSeconds: number;
	durationSeconds: number;
}): number {
	const rampSeconds = Math.min(RAMP_IN_SECONDS, durationSeconds / 2);
	if (rampSeconds <= 0) return 1;
	const t = Math.min(Math.max(localTimeSeconds / rampSeconds, 0), 1);
	return t * t * (3 - 2 * t);
}

/**
 * Deterministic multi-frequency jitter: the same (intensity, speed,
 * localTimeSeconds, durationSeconds) always produces the same offset, so
 * preview and export agree frame for frame and re-exporting the same
 * project is reproducible.
 */
export function computeShakeOffsetPx({
	intensity,
	speed,
	localTimeSeconds,
	durationSeconds,
	referenceSize,
}: {
	intensity: number;
	speed: number;
	localTimeSeconds: number;
	durationSeconds: number;
	referenceSize: number;
}): { x: number; y: number } {
	const amplitude =
		(intensity / 100) *
		MAX_AMPLITUDE_FRACTION *
		referenceSize *
		rampInFactor({ localTimeSeconds, durationSeconds });
	const t = localTimeSeconds * speed;
	const x =
		amplitude *
		(0.6 * Math.sin(2 * Math.PI * BASE_FREQUENCY_HZ * t) +
			0.4 *
				Math.sin(
					2 * Math.PI * BASE_FREQUENCY_HZ * X_SECONDARY_MULTIPLIER * t +
						PHASE_X_SECONDARY,
				));
	const y =
		amplitude *
		(0.6 *
			Math.cos(
				2 * Math.PI * BASE_FREQUENCY_HZ * Y_PRIMARY_MULTIPLIER * t +
					PHASE_Y_PRIMARY,
			) +
			0.4 *
				Math.sin(
					2 * Math.PI * BASE_FREQUENCY_HZ * Y_SECONDARY_MULTIPLIER * t +
						PHASE_Y_SECONDARY,
				));
	return { x, y };
}

export const shakeEffectDefinition: EffectDefinition = {
	type: "shake",
	name: "Shake",
	keywords: ["shake", "jitter", "camera", "handheld"],
	// Grid thumbnail: past the start-of-effect ramp, mid-jitter.
	previewTimeSeconds: 0.4,
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
				shader: SHAKE_SHADER,
				uniforms: ({
					effectParams,
					width,
					height,
					localTimeSeconds,
					durationSeconds,
				}) => {
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
					const { x, y } = computeShakeOffsetPx({
						intensity,
						speed,
						localTimeSeconds,
						durationSeconds,
						referenceSize: Math.min(width, height),
					});
					return { u_offset: [x, y] };
				},
			},
		],
	},
};
