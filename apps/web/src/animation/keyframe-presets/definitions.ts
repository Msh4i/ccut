import { VOLUME_DB_MIN } from "@/timeline/audio-constants";
import type {
	KeyframePresetDefinition,
	KeyframePresetId,
	KeyframePresetInput,
	KeyframePresetPlan,
	PresetKeyPlan,
} from "./types";

export const MIN_KEYFRAME_PRESET_SECONDS = 0.1;

const POSITION_X = "transform.positionX";
const POSITION_Y = "transform.positionY";
const SCALE_X = "transform.scaleX";
const SCALE_Y = "transform.scaleY";
const ROTATE = "transform.rotate";
const VOLUME = "volume";

/** How far a zoom goes, as a multiple of the starting scale. */
const ZOOM_FACTOR = 1.3;
const PULSE_FACTOR = 1.2;
const SWING_DEGREES = 8;
const PAN_FRACTION = 0.1;
const FLOAT_Y_FRACTION = 0.03;
const FLOAT_X_FRACTION = 0.01;
const SHAKE_FRACTION = 0.015;
const SHAKE_KEYS_PER_SECOND = 14;
const SHAKE_MIN_KEYS = 6;
const SHAKE_MAX_KEYS = 30;
const DUCK_DB = -12;
const SWELL_DB = -18;

function baseOf({
	input,
	path,
}: {
	input: KeyframePresetInput;
	path: string;
}): number {
	return input.base[path] ?? 0;
}

function scaleBoth({
	input,
	keys,
}: {
	input: KeyframePresetInput;
	keys: Array<{ at: number; factor: number; easing: PresetKeyPlan["easing"] }>;
}): KeyframePresetPlan {
	const build = (path: string): PresetKeyPlan[] =>
		keys.map(({ at, factor, easing }) => ({
			at,
			value: baseOf({ input, path }) * factor,
			easing,
		}));
	return { [SCALE_X]: build(SCALE_X), [SCALE_Y]: build(SCALE_Y) };
}

function pan({
	id,
	label,
	description,
	path,
	sign,
	span,
}: {
	id: KeyframePresetId;
	label: string;
	description: string;
	path: typeof POSITION_X | typeof POSITION_Y;
	sign: 1 | -1;
	span: "width" | "height";
}): KeyframePresetDefinition {
	return {
		id,
		label,
		description,
		group: "visual",
		paths: [path],
		defaultSeconds: 3,
		defaultPlacement: "start",
		plan: (input) => {
			const from = baseOf({ input, path });
			return {
				[path]: [
					{ at: 0, value: from, easing: "ease-in-out" },
					{
						at: 1,
						value: from + sign * PAN_FRACTION * input.canvas[span],
						easing: "linear",
					},
				],
			};
		},
	};
}

function shakePlan(input: KeyframePresetInput): KeyframePresetPlan {
	const count = Math.min(
		SHAKE_MAX_KEYS,
		Math.max(
			SHAKE_MIN_KEYS,
			Math.round(input.seconds * SHAKE_KEYS_PER_SECOND),
		),
	);
	const baseX = baseOf({ input, path: POSITION_X });
	const baseY = baseOf({ input, path: POSITION_Y });
	const ampX = SHAKE_FRACTION * input.canvas.width;
	const ampY = 0.6 * SHAKE_FRACTION * input.canvas.height;
	const x: PresetKeyPlan[] = [];
	const y: PresetKeyPlan[] = [];
	for (let index = 0; index <= count; index++) {
		const at = index / count;
		const decay = 1 - at;
		const last = index === count;
		x.push({
			at,
			value: last ? baseX : baseX + (index % 2 === 0 ? -1 : 1) * ampX * decay,
			easing: "linear",
		});
		y.push({
			at,
			value: last
				? baseY
				: baseY + (Math.floor(index / 2) % 2 === 0 ? 1 : -1) * ampY * decay,
			easing: "linear",
		});
	}
	return { [POSITION_X]: x, [POSITION_Y]: y };
}

export const KEYFRAME_PRESET_DEFINITIONS: readonly KeyframePresetDefinition[] = [
	{
		id: "zoom-in",
		label: "Zoom in",
		description: "Grows to 130% of the current size.",
		group: "visual",
		paths: [SCALE_X, SCALE_Y],
		defaultSeconds: 3,
		defaultPlacement: "start",
		plan: (input) =>
			scaleBoth({
				input,
				keys: [
					{ at: 0, factor: 1, easing: "ease-in-out" },
					{ at: 1, factor: ZOOM_FACTOR, easing: "linear" },
				],
			}),
	},
	{
		id: "zoom-out",
		label: "Zoom out",
		description: "Starts at 130% of the current size and settles back.",
		group: "visual",
		paths: [SCALE_X, SCALE_Y],
		defaultSeconds: 3,
		defaultPlacement: "start",
		plan: (input) =>
			scaleBoth({
				input,
				keys: [
					{ at: 0, factor: ZOOM_FACTOR, easing: "ease-in-out" },
					{ at: 1, factor: 1, easing: "linear" },
				],
			}),
	},
	{
		id: "pulse",
		label: "Pulse",
		description: "A quick pop to 120% and back, made for a beat.",
		group: "visual",
		paths: [SCALE_X, SCALE_Y],
		defaultSeconds: 0.4,
		defaultPlacement: "playhead",
		plan: (input) =>
			scaleBoth({
				input,
				keys: [
					{ at: 0, factor: 1, easing: "ease-out" },
					{ at: 0.3, factor: PULSE_FACTOR, easing: "ease-in-out" },
					{ at: 1, factor: 1, easing: "linear" },
				],
			}),
	},
	{
		id: "shake",
		label: "Shake",
		description: "A fading jitter in position.",
		group: "visual",
		paths: [POSITION_X, POSITION_Y],
		defaultSeconds: 0.6,
		defaultPlacement: "playhead",
		plan: shakePlan,
	},
	{
		id: "float",
		label: "Float",
		description: "A slow drift up and back.",
		group: "visual",
		paths: [POSITION_X, POSITION_Y],
		defaultSeconds: 4,
		defaultPlacement: "start",
		plan: (input) => {
			const baseX = baseOf({ input, path: POSITION_X });
			const baseY = baseOf({ input, path: POSITION_Y });
			return {
				[POSITION_X]: [
					{ at: 0, value: baseX, easing: "ease-in-out" },
					{
						at: 0.5,
						value: baseX + FLOAT_X_FRACTION * input.canvas.width,
						easing: "ease-in-out",
					},
					{ at: 1, value: baseX, easing: "linear" },
				],
				[POSITION_Y]: [
					{ at: 0, value: baseY, easing: "ease-in-out" },
					{
						at: 0.5,
						value: baseY - FLOAT_Y_FRACTION * input.canvas.height,
						easing: "ease-in-out",
					},
					{ at: 1, value: baseY, easing: "linear" },
				],
			};
		},
	},
	{
		id: "swing",
		label: "Swing",
		description: "Rocks 8 degrees to each side.",
		group: "visual",
		paths: [ROTATE],
		defaultSeconds: 1.2,
		defaultPlacement: "playhead",
		plan: (input) => {
			const base = baseOf({ input, path: ROTATE });
			return {
				[ROTATE]: [
					{ at: 0, value: base, easing: "ease-in-out" },
					{ at: 0.25, value: base + SWING_DEGREES, easing: "ease-in-out" },
					{ at: 0.75, value: base - SWING_DEGREES, easing: "ease-in-out" },
					{ at: 1, value: base, easing: "linear" },
				],
			};
		},
	},
	pan({
		id: "pan-left",
		label: "Pan left",
		description: "Slides left by 10% of the canvas width.",
		path: POSITION_X,
		sign: -1,
		span: "width",
	}),
	pan({
		id: "pan-right",
		label: "Pan right",
		description: "Slides right by 10% of the canvas width.",
		path: POSITION_X,
		sign: 1,
		span: "width",
	}),
	pan({
		id: "pan-up",
		label: "Pan up",
		description: "Slides up by 10% of the canvas height.",
		path: POSITION_Y,
		sign: -1,
		span: "height",
	}),
	pan({
		id: "pan-down",
		label: "Pan down",
		description: "Slides down by 10% of the canvas height.",
		path: POSITION_Y,
		sign: 1,
		span: "height",
	}),
	{
		id: "volume-fade-in",
		label: "Fade in",
		description: "Rises from silence to the current volume.",
		group: "audio",
		paths: [VOLUME],
		defaultSeconds: 1,
		defaultPlacement: "start",
		plan: (input) => ({
			[VOLUME]: [
				{ at: 0, value: VOLUME_DB_MIN, easing: "linear" },
				{ at: 1, value: baseOf({ input, path: VOLUME }), easing: "linear" },
			],
		}),
	},
	{
		id: "volume-fade-out",
		label: "Fade out",
		description: "Falls from the current volume to silence.",
		group: "audio",
		paths: [VOLUME],
		defaultSeconds: 1,
		defaultPlacement: "end",
		plan: (input) => ({
			[VOLUME]: [
				{ at: 0, value: baseOf({ input, path: VOLUME }), easing: "linear" },
				{ at: 1, value: VOLUME_DB_MIN, easing: "linear" },
			],
		}),
	},
	{
		id: "volume-duck",
		label: "Duck",
		description: "Dips by 12 dB in the middle (for a voice over).",
		group: "audio",
		paths: [VOLUME],
		defaultSeconds: 4,
		defaultPlacement: "playhead",
		plan: (input) => {
			const base = baseOf({ input, path: VOLUME });
			return {
				[VOLUME]: [
					{ at: 0, value: base, easing: "ease-in-out" },
					{ at: 0.2, value: base + DUCK_DB, easing: "linear" },
					{ at: 0.8, value: base + DUCK_DB, easing: "ease-in-out" },
					{ at: 1, value: base, easing: "linear" },
				],
			};
		},
	},
	{
		id: "volume-swell",
		label: "Swell",
		description: "Starts 18 dB quieter, rises to the current volume, falls again.",
		group: "audio",
		paths: [VOLUME],
		defaultSeconds: 4,
		defaultPlacement: "playhead",
		plan: (input) => {
			const base = baseOf({ input, path: VOLUME });
			return {
				[VOLUME]: [
					{ at: 0, value: base + SWELL_DB, easing: "ease-in-out" },
					{ at: 0.5, value: base, easing: "ease-in-out" },
					{ at: 1, value: base + SWELL_DB, easing: "linear" },
				],
			};
		},
	},
];

export function getKeyframePresetDefinition({
	id,
}: {
	id: KeyframePresetId;
}): KeyframePresetDefinition {
	const definition = KEYFRAME_PRESET_DEFINITIONS.find(
		(candidate) => candidate.id === id,
	);
	if (!definition) {
		throw new Error(`Unknown keyframe preset "${id}".`);
	}
	return definition;
}
