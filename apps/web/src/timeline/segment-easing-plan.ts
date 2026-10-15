import { getEditableScalarChannels } from "@/animation/graph-channels";
import {
	getSegmentEasingPatch,
	type SegmentShape,
} from "@/animation/segment-easing";
import type {
	ScalarCurveKeyframePatch,
	SelectedKeyframeRef,
} from "@/animation/types";
import type { TimelineElement } from "@/timeline/types";

export interface CurvePatchEntry extends SelectedKeyframeRef {
	componentKey: string;
	patch: ScalarCurveKeyframePatch;
}

/**
 * The curve patches that give the segment leaving each keyframe the wanted
 * easing. Both ends of the segment are written (the left key's shape and
 * handle, the right key's incoming handle), so the result is the same curve the
 * graph editor shows. A keyframe that is the last of its channel has no
 * segment and is skipped; so is a path the clip no longer has.
 */
export function planSegmentEasing({
	element,
	keyframes,
	easing,
}: {
	element: TimelineElement;
	keyframes: SelectedKeyframeRef[];
	easing: SegmentShape;
}): CurvePatchEntry[] {
	const entries: CurvePatchEntry[] = [];
	for (const ref of keyframes) {
		const editable = getEditableScalarChannels({
			animations: element.animations,
			propertyPath: ref.propertyPath,
		});
		for (const { componentKey, channel } of editable?.channels ?? []) {
			const index = channel.keys.findIndex((key) => key.id === ref.keyframeId);
			const leftKey = channel.keys[index];
			const rightKey = channel.keys[index + 1];
			if (index < 0 || !rightKey) {
				continue;
			}
			const patch = getSegmentEasingPatch({ leftKey, rightKey, easing });
			if (!patch) {
				continue;
			}
			const isCurve = patch.segmentToNext === "bezier";
			entries.push({
				...ref,
				componentKey,
				keyframeId: leftKey.id,
				patch: {
					segmentToNext: patch.segmentToNext,
					rightHandle: patch.rightHandle ?? null,
					tangentMode: isCurve ? "broken" : leftKey.tangentMode,
				},
			});
			entries.push({
				...ref,
				componentKey,
				keyframeId: rightKey.id,
				patch: {
					leftHandle: patch.nextLeftHandle ?? null,
					tangentMode: isCurve ? "broken" : rightKey.tangentMode,
				},
			});
		}
	}
	return entries;
}

/**
 * The keyframes plus the key that follows each in its channel: the selection
 * the graph editor needs to edit the segment a diamond starts.
 */
export function getSegmentPairRefs({
	element,
	keyframes,
}: {
	element: TimelineElement;
	keyframes: SelectedKeyframeRef[];
}): SelectedKeyframeRef[] {
	const refs: SelectedKeyframeRef[] = [];
	for (const ref of keyframes) {
		refs.push(ref);
		const editable = getEditableScalarChannels({
			animations: element.animations,
			propertyPath: ref.propertyPath,
		});
		for (const { channel } of editable?.channels ?? []) {
			const index = channel.keys.findIndex((key) => key.id === ref.keyframeId);
			const next = channel.keys[index + 1];
			if (index >= 0 && next) {
				refs.push({ ...ref, keyframeId: next.id });
			}
		}
	}
	return refs;
}
