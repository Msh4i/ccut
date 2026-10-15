"use client";

import { resolveAnimationPathValueAtTime } from "@/animation";
import { useEditor } from "@/editor/use-editor";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { ParamValue, ParamValues } from "@/params";
import {
	getElementParams,
	readElementParamValue,
	writeElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import type { TimelineElement } from "@/timeline";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import type { MediaTime } from "@/wasm";

export function ElementParamsTab({
	element,
	trackId,
	paramKeys,
	sectionKey,
}: {
	element: TimelineElement;
	trackId: string;
	paramKeys?: readonly string[];
	sectionKey: string;
}) {
	return (
		<Section sectionKey={`${element.id}:${sectionKey}`}>
			<SectionContent className="pt-4">
				<ElementParamFields
					element={element}
					trackId={trackId}
					paramKeys={paramKeys}
				/>
			</SectionContent>
		</Section>
	);
}

/** The fields of a clip's params (keyframe diamonds included), without a section around them. */
export function ElementParamFields({
	element,
	trackId,
	paramKeys,
}: {
	element: TimelineElement;
	trackId: string;
	paramKeys?: readonly string[];
}) {
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const { renderElement } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});
	const allParams = getElementParams({ element });
	const params = allParams.filter(
		(param) => !paramKeys || paramKeys.includes(param.key),
	);
	// Every param's value, so a field can depend on one that is not shown (a section's switch).
	const baseValues = buildValues({ element: renderElement, params: allParams });

	return (
		<SectionFields>
			{params
				.filter((param) => isVisible({ param, values: baseValues }))
				.map((param) => (
					<ElementParamField
						key={param.key}
						element={renderElement}
						trackId={trackId}
						param={param}
						baseValue={baseValues[param.key] ?? param.default}
						localTime={localTime}
						isPlayheadWithinElementRange={isPlayheadWithinElementRange}
					/>
				))}
		</SectionFields>
	);
}

function ElementParamField({
	element,
	trackId,
	param,
	baseValue,
	localTime,
	isPlayheadWithinElementRange,
}: {
	element: TimelineElement;
	trackId: string;
	param: ElementParamDefinition;
	baseValue: ParamValue;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
}) {
	const canvasWidth = useEditor(
		(e) => e.project.getActive().settings.canvasSize.width,
	);
	const canvasHeight = useEditor(
		(e) => e.project.getActive().settings.canvasSize.height,
	);
	const resolvedValue = resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		fallbackValue: baseValue,
	});
	const animatedParam = useKeyframedParamProperty({
		param,
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) =>
			writeElementParamValue({ element, param, value }),
	});

	return (
		<PropertyParamField
			param={withCanvasPositionRange({ param, canvasWidth, canvasHeight })}
			value={resolvedValue}
			onPreview={animatedParam.onPreview}
			onCommit={animatedParam.onCommit}
			keyframe={
				param.keyframable === false
					? undefined
					: {
							isActive: animatedParam.isKeyframedAtTime,
							isDisabled: !isPlayheadWithinElementRange,
							onToggle: animatedParam.toggleKeyframe,
				onCurveMenu: animatedParam.openCurveMenu,
						}
			}
		/>
	);
}

/** The position bar spans one canvas to each side of the center. */
function withCanvasPositionRange({
	param,
	canvasWidth,
	canvasHeight,
}: {
	param: ElementParamDefinition;
	canvasWidth: number;
	canvasHeight: number;
}): ElementParamDefinition {
	if (param.type !== "number") return param;
	if (param.key === "transform.positionX") {
		return { ...param, slider: { min: -canvasWidth, max: canvasWidth } };
	}
	if (param.key === "transform.positionY") {
		return { ...param, slider: { min: -canvasHeight, max: canvasHeight } };
	}
	return param;
}

function buildValues({
	element,
	params,
}: {
	element: TimelineElement;
	params: readonly ElementParamDefinition[];
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

function isVisible({
	param,
	values,
}: {
	param: ElementParamDefinition;
	values: ParamValues;
}): boolean {
	return (param.dependencies ?? []).every((dependency) =>
		areParamValuesEqual({
			left: values[dependency.param],
			right: dependency.equals,
		}),
	);
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValue | undefined;
	right: ParamValue;
}): boolean {
	return left === right;
}
