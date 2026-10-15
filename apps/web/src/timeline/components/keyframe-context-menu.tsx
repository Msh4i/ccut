"use client";

import { Slot } from "radix-ui";
import type { SelectedKeyframeRef } from "@/animation/types";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { toSegmentStartKeyframes } from "@/timeline/keyframe-curve-targets";
import { useKeyframeCurveMenuStore } from "@/timeline/keyframe-curve-menu-store";
import type { TimelineElement } from "@/timeline/types";

/**
 * A right click on a keyframe diamond, in the clip header (one diamond can
 * stand for several properties) or in an expanded lane (one property), opens
 * the curve menu instead of the clip's own menu.
 */
export function KeyframeContextMenu({
	element,
	keyframes,
	children,
}: {
	element: TimelineElement;
	/** The keyframes the diamond stands for. */
	keyframes: SelectedKeyframeRef[];
	children: React.ReactElement;
}) {
	const { setKeyframeSelection } = useKeyframeSelection();
	const openMenu = useKeyframeCurveMenuStore((state) => state.open);
	const first = keyframes[0];

	return (
		<Slot.Slot
			onContextMenu={(event: React.MouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				if (!first) return;
				setKeyframeSelection({ keyframes });
				openMenu({
					x: event.clientX,
					y: event.clientY,
					trackId: first.trackId,
					elementId: element.id,
					keyframes: toSegmentStartKeyframes({ animations: element.animations, keyframes }),
				});
			}}
		>
			{children}
		</Slot.Slot>
	);
}
