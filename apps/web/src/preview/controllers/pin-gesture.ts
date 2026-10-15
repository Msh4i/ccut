import { setChannel } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { Transform } from "@/rendering";
import { CAMERA_PIN_PATHS } from "@/tracking/camera/pin-animations";

/** What the preview controllers need to know of "Stick to scene": which elements are stuck, and how to stick one again. */
export interface PinOps {
	isPinned: ({ elementId }: { elementId: string }) => boolean;
	/** Sticks the element again from the same analysis; `look` is its transform as the user left it. */
	repin: ({ elementId, look }: { elementId: string; look: Transform }) => void;
}

/** The five channels a camera pin writes. */
export const PIN_PROPERTY_PATHS = Object.values(CAMERA_PIN_PATHS);

/** The animations without the pin's five channels (the preview of a gesture on a stuck element). */
export function withoutPinChannels({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	return PIN_PROPERTY_PATHS.reduce<ElementAnimations | undefined>(
		(current, propertyPath) =>
			setChannel({ animations: current, propertyPath, channel: undefined }),
		animations,
	);
}

export interface PinGesturePlan {
	isPinned: boolean;
	/** What to preview as the element's animations while the gesture runs. */
	animationsWithoutPin: ElementAnimations | undefined;
}

/**
 * A stuck element is dragged, scaled or turned with its channels lifted, so it
 * follows the cursor (while the keys are there the preview ignores the base
 * values, and the scale handles used to delete them). Any other element's
 * animations are returned untouched.
 */
export function planPinGesture({
	animations,
	isPinned,
}: {
	animations: ElementAnimations | undefined;
	isPinned: boolean;
}): PinGesturePlan {
	return {
		isPinned,
		animationsWithoutPin: isPinned ? withoutPinChannels({ animations }) : animations,
	};
}

export type PinReleasePlan = "commit" | "repin" | "restore-commit-repin";

/**
 * On release: `commit` (nothing dragged is stuck: as ever), `repin` (all of it
 * is: the preview is dropped and the keys are written again from the same
 * analysis, one undo step) or `restore-commit-repin` (a mix: the stuck ones go
 * back to how they were so the commit leaves them alone, then they are stuck again).
 */
export function planPinRelease({
	total,
	pinned,
}: {
	total: number;
	pinned: number;
}): PinReleasePlan {
	if (pinned === 0) return "commit";
	if (pinned >= total) return "repin";
	return "restore-commit-repin";
}
