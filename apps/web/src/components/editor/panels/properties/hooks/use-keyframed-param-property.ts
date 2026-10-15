"use client";

import { toast } from "sonner";
import { getEditableScalarChannels } from "@/animation/graph-channels";
import { useEditor } from "@/editor/use-editor";
import {
	findCurveKeyframesAtTime,
	toSegmentStartKeyframes,
} from "@/timeline/keyframe-curve-targets";
import { useKeyframeCurveMenuStore } from "@/timeline/keyframe-curve-menu-store";
import {
	buildGraphicParamPath,
	getKeyframeAtTime,
	hasKeyframesForPath,
	upsertPathKeyframe,
} from "@/animation";
import type {
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import {
	coerceParamValue,
	getParamChannelLayout,
	type ParamDefinition,
} from "@/params";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface KeyframedParamPropertyResult {
	hasAnimatedKeyframes: boolean;
	isKeyframedAtTime: boolean;
	keyframeIdAtTime: string | null;
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
	toggleKeyframe: () => void;
	/** Right click on the diamond: the curve menu for this property's keyframe at the playhead. */
	/** Undefined for a param whose keys have no curve (colour, on/off, text). */
	openCurveMenu?: (event: React.MouseEvent) => void;
}

export function useKeyframedParamProperty({
	param,
	trackId,
	elementId,
	animations,
	propertyPath,
	localTime,
	isPlayheadWithinElementRange,
	resolvedValue,
	buildBaseUpdates,
}: {
	param: ParamDefinition;
	trackId: string;
	elementId: string;
	animations: ElementAnimations | undefined;
	propertyPath?: AnimationPath;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	resolvedValue: number | string | boolean;
	buildBaseUpdates: ({
		value,
	}: {
		value: number | string | boolean;
	}) => Partial<TimelineElement>;
}): KeyframedParamPropertyResult {
	const editor = useEditor();
	const resolvedPropertyPath =
		propertyPath ?? buildGraphicParamPath({ paramKey: param.key });
	const hasAnimatedKeyframes = hasKeyframesForPath({
		animations,
		propertyPath: resolvedPropertyPath,
	});
	const keyframeAtTime = isPlayheadWithinElementRange
		? getKeyframeAtTime({
				animations,
				propertyPath: resolvedPropertyPath,
				time: localTime,
			})
		: null;
	const keyframeIdAtTime = keyframeAtTime?.id ?? null;
	const isKeyframedAtTime = keyframeAtTime !== null;
	const shouldUseAnimatedChannel =
		hasAnimatedKeyframes && isPlayheadWithinElementRange;

	const previewValue: KeyframedParamPropertyResult["onPreview"] = (value) => {
		if (shouldUseAnimatedChannel) {
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId,
						updates: {
							animations: upsertPathKeyframe({
								animations,
								propertyPath: resolvedPropertyPath,
								time: localTime,
								value,
								channelLayout: getParamChannelLayout({ param }),
								coerceValue: ({ value: nextValue }) =>
									coerceParamValue({
										param,
										value: nextValue,
									}),
							}),
						},
					},
				],
			});
			return;
		}

		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId,
					updates: buildBaseUpdates({ value }),
				},
			],
		});
	};

	const toggleKeyframe = () => {
		if (!isPlayheadWithinElementRange) {
			return;
		}

		if (keyframeIdAtTime) {
			editor.timeline.removeKeyframes({
				keyframes: [
					{
						trackId,
						elementId,
						propertyPath: resolvedPropertyPath,
						keyframeId: keyframeIdAtTime,
					},
				],
			});
			return;
		}

		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId,
					elementId,
					propertyPath: resolvedPropertyPath,
					time: localTime,
					value: resolvedValue,
				},
			],
		});
	};

	const hasCurveChannels =
		(getEditableScalarChannels({ animations, propertyPath: resolvedPropertyPath })
			?.channels.length ?? 0) > 0;
	const openCurveMenu = (event: React.MouseEvent) => {
		event.preventDefault();
		const keyframes = isPlayheadWithinElementRange
			? toSegmentStartKeyframes({
					animations,
					keyframes: findCurveKeyframesAtTime({
						trackId,
						elementId,
						animations,
						paths: [resolvedPropertyPath],
						localTime,
					}),
				})
			: [];
		if (keyframes.length === 0) {
			toast.info(
				"No keyframe here. Add two keyframes, then right-click to pick the curve between them.",
			);
			return;
		}
		useKeyframeCurveMenuStore.getState().open({
			x: event.clientX,
			y: event.clientY,
			trackId,
			elementId,
			keyframes,
		});
	};

	return {
		openCurveMenu: hasCurveChannels ? openCurveMenu : undefined,
		hasAnimatedKeyframes,
		isKeyframedAtTime,
		keyframeIdAtTime,
		onPreview: previewValue,
		onCommit: () => editor.timeline.commitPreview(),
		toggleKeyframe,
	};
}
