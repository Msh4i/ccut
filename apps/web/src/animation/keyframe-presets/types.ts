import type { SegmentEasingId } from "@/animation/segment-easing";

export type KeyframePresetId =
	| "zoom-in"
	| "zoom-out"
	| "pulse"
	| "shake"
	| "float"
	| "swing"
	| "pan-left"
	| "pan-right"
	| "pan-up"
	| "pan-down"
	| "volume-fade-in"
	| "volume-fade-out"
	| "volume-duck"
	| "volume-swell";

/** Where the preset's range sits on the clip. */
export type KeyframePresetPlacement = "start" | "playhead" | "end";

export type KeyframePresetGroup = "visual" | "audio";

/** One key of a preset: `at` is the fraction (0 to 1) of the preset's range. */
export interface PresetKeyPlan {
	at: number;
	value: number;
	/** The shape of the segment that leaves this key. Ignored on the last key. */
	easing: SegmentEasingId;
}

/** Keys per animation path. */
export type KeyframePresetPlan = Record<string, PresetKeyPlan[]>;

export interface KeyframePresetInput {
	/**
	 * The value of each path the preset writes, as it is where the range
	 * starts (keyframes or the fixed value). Keys are built around it.
	 */
	base: Readonly<Record<string, number>>;
	/** Canvas size in pixels; position moves are fractions of it. */
	canvas: { width: number; height: number };
	/** The length of the range in seconds. */
	seconds: number;
}

export interface KeyframePresetDefinition {
	id: KeyframePresetId;
	label: string;
	description: string;
	group: KeyframePresetGroup;
	/** The animation paths the preset writes. All of them must exist on a clip for the preset to apply. */
	paths: readonly string[];
	defaultSeconds: number;
	defaultPlacement: KeyframePresetPlacement;
	plan: (input: KeyframePresetInput) => KeyframePresetPlan;
}

/** The inclusive stretch of a clip a preset owns, in ticks from the clip's start. */
export interface KeyframePresetRange {
	start: number;
	end: number;
}

/** The limits a path's values are held to (the param's own min and max). */
export interface PathLimits {
	min?: number;
	max?: number;
}
