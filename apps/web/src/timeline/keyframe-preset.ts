import { TICKS_PER_SECOND } from "@/wasm";
import { resolveAnimationPathValueAtTime } from "@/animation";
import {
	applyKeyframePresetToAnimations,
	getKeyframePresetDefinition,
	resolveKeyframePresetRange,
	type KeyframePresetDefinition,
	type KeyframePresetId,
	type KeyframePresetPlacement,
	type KeyframePresetRange,
	type PathLimits,
} from "@/animation/keyframe-presets";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type { TimelineElement } from "@/timeline/types";

/** True when the clip has every property the preset writes (an image has no volume). */
export function elementSupportsKeyframePreset({
	element,
	definition,
}: {
	element: TimelineElement;
	definition: KeyframePresetDefinition;
}): boolean {
	return definition.paths.every(
		(path) => resolveAnimationTarget({ element, path }) !== null,
	);
}

/**
 * The element with the preset written into its animations, or null when the
 * clip lacks a property the preset needs or is too short for it. The values
 * the keys are built around are the ones at the start of the range, so a clip
 * that is already animated there gets the preset on top of its current look.
 */
export function applyKeyframePresetToElement({
	element,
	presetId,
	placement,
	seconds,
	playheadLocal,
	canvas,
}: {
	element: TimelineElement;
	presetId: KeyframePresetId;
	placement: KeyframePresetPlacement;
	seconds: number;
	/** The playhead in ticks from the clip's start. */
	playheadLocal: number;
	canvas: { width: number; height: number };
}): { element: TimelineElement; range: KeyframePresetRange } | null {
	const definition = getKeyframePresetDefinition({ id: presetId });
	if (!elementSupportsKeyframePreset({ element, definition })) {
		return null;
	}
	const range = resolveKeyframePresetRange({
		placement,
		playheadLocal,
		clipDuration: element.duration,
		requestedDuration: seconds * TICKS_PER_SECOND,
	});
	if (!range) {
		return null;
	}

	const base: Record<string, number> = {};
	const limits: Record<string, PathLimits> = {};
	for (const path of definition.paths) {
		const target = resolveAnimationTarget({ element, path });
		const fixed = target?.getBaseValue();
		if (typeof fixed !== "number") {
			return null;
		}
		base[path] = resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: path,
			localTime: range.start,
			fallbackValue: fixed,
		});
		limits[path] = target?.numericRanges?.value ?? {};
	}

	return {
		range,
		element: {
			...element,
			animations: applyKeyframePresetToAnimations({
				animations: element.animations,
				definition,
				range,
				canvas,
				base,
				limits,
			}),
		},
	};
}
