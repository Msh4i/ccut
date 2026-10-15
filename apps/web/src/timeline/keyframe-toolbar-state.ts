import {
	findAdjacentKeyframeTimeAmong,
	getPlayheadKeyframeState,
	type KeyframeTarget,
} from "@/timeline/playhead-keyframes";

export interface KeyframeToolbarState {
	previous: { enabled: boolean; reason: string | null };
	toggle: { enabled: boolean; reason: string | null; isKeyed: boolean };
	next: { enabled: boolean; reason: string | null };
}

const NO_CLIP = "Select a clip first";
const OUTSIDE = "Move the playhead onto the selected clip";

/**
 * What the three keyframe buttons in the timeline toolbar can do: the diamond
 * works on the selected clips the playhead is inside (and is filled when all
 * of those have a key right there), previous / next need a keyframe on that
 * side. A disabled button carries the reason for its tooltip.
 */
export function getKeyframeToolbarState({
	targets,
	playhead,
}: {
	targets: readonly KeyframeTarget[];
	playhead: number;
}): KeyframeToolbarState {
	if (targets.length === 0) {
		return {
			previous: { enabled: false, reason: NO_CLIP },
			toggle: { enabled: false, reason: NO_CLIP, isKeyed: false },
			next: { enabled: false, reason: NO_CLIP },
		};
	}

	const { actionable, isKeyed } = getPlayheadKeyframeState({ targets, playhead });
	const hasBefore =
		findAdjacentKeyframeTimeAmong({ targets, playhead, direction: "previous" }) !==
		null;
	const hasAfter =
		findAdjacentKeyframeTimeAmong({ targets, playhead, direction: "next" }) !==
		null;
	return {
		previous: {
			enabled: hasBefore,
			reason: hasBefore ? null : "No earlier keyframe on the selected clip",
		},
		toggle: {
			enabled: actionable > 0,
			reason: actionable > 0 ? null : OUTSIDE,
			isKeyed,
		},
		next: {
			enabled: hasAfter,
			reason: hasAfter ? null : "No later keyframe on the selected clip",
		},
	};
}
