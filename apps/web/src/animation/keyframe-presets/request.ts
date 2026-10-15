import { MIN_KEYFRAME_PRESET_SECONDS } from "./definitions";
import type { KeyframePresetDefinition, KeyframePresetPlacement } from "./types";

export type PlacementChoice = KeyframePresetPlacement | "auto";

const MAX_KEYFRAME_PRESET_SECONDS = 600;

/**
 * What a click on a preset asks for: the placement and the length the user
 * chose, or the preset's own when they left them on "auto" / empty. Returns
 * null for a length that is not a number.
 */
export function resolveKeyframePresetRequest({
	definition,
	placement,
	lengthText,
}: {
	definition: KeyframePresetDefinition;
	placement: PlacementChoice;
	lengthText: string;
}): { placement: KeyframePresetPlacement; seconds: number } | null {
	const trimmed = lengthText.trim();
	let seconds = definition.defaultSeconds;
	if (trimmed !== "") {
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed)) {
			return null;
		}
		seconds = Math.min(
			MAX_KEYFRAME_PRESET_SECONDS,
			Math.max(MIN_KEYFRAME_PRESET_SECONDS, parsed),
		);
	}
	return {
		placement: placement === "auto" ? definition.defaultPlacement : placement,
		seconds,
	};
}
