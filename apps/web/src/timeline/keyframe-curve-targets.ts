import { getKeyframeAtTime } from "@/animation";
import { getEditableScalarChannels } from "@/animation/graph-channels";
import type {
	ElementAnimations,
	SelectedKeyframeRef,
} from "@/animation/types";

function getChannelKeys({
	animations,
	propertyPath,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: string;
}) {
	return (
		getEditableScalarChannels({
			animations,
			propertyPath,
		})?.channels[0]?.channel.keys ?? []
	);
}

/**
 * The keyframes a curve menu opened at a time works on, one per property: the
 * key at `localTime`, or else the key that starts the segment `localTime` is
 * in. A property with no key there and no segment around it is left out.
 */
export function findCurveKeyframesAtTime({
	trackId,
	elementId,
	animations,
	paths,
	localTime,
}: {
	trackId: string;
	elementId: string;
	animations: ElementAnimations | undefined;
	paths: readonly string[];
	localTime: number;
}): SelectedKeyframeRef[] {
	const refs: SelectedKeyframeRef[] = [];
	for (const propertyPath of paths) {
		const at = getKeyframeAtTime({
			animations,
			propertyPath,
			time: localTime,
		});
		if (at) {
			refs.push({ trackId, elementId, propertyPath, keyframeId: at.id });
			continue;
		}
		const keys = getChannelKeys({ animations, propertyPath });
		const index = keys.findIndex(
			(key, i) => key.time < localTime && (keys[i + 1]?.time ?? -Infinity) > localTime,
		);
		if (index >= 0) {
			refs.push({
				trackId,
				elementId,
				propertyPath,
				keyframeId: keys[index].id,
			});
		}
	}
	return refs;
}

/**
 * A curve shapes the segment that leaves a key. The last key of a property has
 * none, so it stands for the segment that arrives at it instead: the menu then
 * works on every diamond that has a neighbour.
 */
export function toSegmentStartKeyframes({
	animations,
	keyframes,
}: {
	animations: ElementAnimations | undefined;
	keyframes: readonly SelectedKeyframeRef[];
}): SelectedKeyframeRef[] {
	const seen = new Set<string>();
	const refs: SelectedKeyframeRef[] = [];
	for (const ref of keyframes) {
		const keys = getChannelKeys({ animations, propertyPath: ref.propertyPath });
		const index = keys.findIndex((key) => key.id === ref.keyframeId);
		const keyframeId =
			index > 0 && index === keys.length - 1 ? keys[index - 1].id : ref.keyframeId;
		const id = `${ref.propertyPath}:${keyframeId}`;
		if (!seen.has(id)) {
			seen.add(id);
			refs.push({ ...ref, keyframeId });
		}
	}
	return refs;
}
