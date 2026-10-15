import { getCurveHandlesForNormalizedCubicBezier } from "@/animation/curve-bridge";
import type {
	NormalizedCubicBezier,
	ScalarAnimationKey,
	ScalarSegmentType,
} from "@/animation/types";

/**
 * The segment shapes a CapCut-style easing menu offers. `hold` keeps the value
 * of the left key until the right key; the others are the usual CSS curves.
 */
export type SegmentEasingId =
	| "linear"
	| "ease-in"
	| "ease-out"
	| "ease-in-out"
	| "hold";

export const SEGMENT_EASING_IDS: readonly SegmentEasingId[] = [
	"linear",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"hold",
];

/** CSS `ease-in`, `ease-out` and `ease-in-out`, in the editor's normalized form. */
export const SEGMENT_EASING_CURVES: Record<
	Exclude<SegmentEasingId, "linear" | "hold">,
	NormalizedCubicBezier
> = {
	"ease-in": [0.42, 0, 1, 1],
	"ease-out": [0, 0, 0.58, 1],
	"ease-in-out": [0.42, 0, 0.58, 1],
};

/** A segment shape: one of the named easings, or any curve from the graph editor's presets. */
export type SegmentShape = SegmentEasingId | NormalizedCubicBezier;

const MATCH_TOLERANCE = 0.02;

/** What to write on the left key of a segment to give it `easing`. */
export interface SegmentEasingPatch {
	segmentToNext: ScalarSegmentType;
	rightHandle?: ScalarAnimationKey["rightHandle"] | null;
	/** The handle the right key gets for this segment. */
	nextLeftHandle?: ScalarAnimationKey["leftHandle"] | null;
}

/**
 * The patch that gives the segment between two keys the wanted easing, or
 * null when it cannot be expressed (two keys on the same tick). A segment whose
 * two keys hold the same value is the same line for every easing, so it is
 * written as linear.
 */
export function getSegmentEasingPatch({
	leftKey,
	rightKey,
	easing,
}: {
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
	easing: SegmentShape;
}): SegmentEasingPatch | null {
	if (rightKey.time <= leftKey.time) {
		return null;
	}
	if (easing === "hold") {
		return {
			segmentToNext: "step",
			rightHandle: null,
			nextLeftHandle: null,
		};
	}
	if (easing === "linear" || leftKey.value === rightKey.value) {
		return {
			segmentToNext: "linear",
			rightHandle: null,
			nextLeftHandle: null,
		};
	}
	const handles = getCurveHandlesForNormalizedCubicBezier({
		leftKey,
		rightKey,
		cubicBezier:
			typeof easing === "string" ? SEGMENT_EASING_CURVES[easing] : easing,
	});
	if (!handles) {
		return null;
	}
	return {
		segmentToNext: "bezier",
		rightHandle: handles.rightHandle,
		nextLeftHandle: handles.leftHandle,
	};
}

/**
 * Which menu entry a segment is, or "custom" when it was shaped by hand in the
 * graph editor.
 */
export function detectSegmentEasing({
	leftKey,
	rightKey,
}: {
	leftKey: ScalarAnimationKey;
	rightKey: ScalarAnimationKey;
}): SegmentEasingId | "custom" {
	if (leftKey.segmentToNext === "step") {
		return "hold";
	}
	if (leftKey.segmentToNext === "linear") {
		return "linear";
	}
	for (const id of SEGMENT_EASING_IDS) {
		if (id === "linear" || id === "hold") {
			continue;
		}
		const patch = getSegmentEasingPatch({ leftKey, rightKey, easing: id });
		if (
			patch?.segmentToNext === "bezier" &&
			patch.rightHandle &&
			patch.nextLeftHandle &&
			leftKey.rightHandle &&
			rightKey.leftHandle &&
			Math.abs(patch.rightHandle.dt - leftKey.rightHandle.dt) <=
				MATCH_TOLERANCE * (rightKey.time - leftKey.time) &&
			Math.abs(patch.rightHandle.dv - leftKey.rightHandle.dv) <=
				MATCH_TOLERANCE * Math.abs(rightKey.value - leftKey.value) &&
			Math.abs(patch.nextLeftHandle.dt - rightKey.leftHandle.dt) <=
				MATCH_TOLERANCE * (rightKey.time - leftKey.time) &&
			Math.abs(patch.nextLeftHandle.dv - rightKey.leftHandle.dv) <=
				MATCH_TOLERANCE * Math.abs(rightKey.value - leftKey.value)
		) {
			return id;
		}
	}
	return "custom";
}
