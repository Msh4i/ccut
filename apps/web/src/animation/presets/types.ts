import type { RevealUnit } from "@/text/reveal";
import type { MediaTime } from "@/wasm";

export type PresetAnimationId =
	| "fade"
	| "slide-left"
	| "slide-right"
	| "slide-up"
	| "slide-down"
	| "zoom"
	| "pop"
	| "typewriter"
	| "word-reveal";

export type PresetPhase = "in" | "out";

export interface PresetAnimation {
	id: PresetAnimationId;
	/** The requested length. It is squeezed at resolve time, never rewritten. */
	duration: MediaTime;
}

export interface PresetAnimations {
	in?: PresetAnimation;
	out?: PresetAnimation;
}

export interface PresetBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** What a preset needs to know about the clip it is moving. All values in canvas pixels. */
export interface PresetContext {
	canvasWidth: number;
	canvasHeight: number;
	/** Clip origin, measured from the canvas center. */
	position: { x: number; y: number };
	/** Extent of the clip's scaled and rotated box around `position`. */
	bounds: PresetBounds;
}

/** Fraction of a text (in graphemes or words) that is visible. */
export interface PresetReveal {
	unit: RevealUnit;
	fraction: number;
}

/** What a preset changes at one instant. A missing field changes nothing. */
export interface PresetDelta {
	/** Multiplies the opacity. */
	opacity?: number;
	/** Multiplies both scale axes. */
	scale?: number;
	/** Added to the position. */
	x?: number;
	y?: number;
	reveal?: PresetReveal;
}
