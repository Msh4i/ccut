"use client";

import { useMemo } from "react";
import { NumberField } from "@/components/ui/number-field";
import { SliderField } from "@/components/ui/slider-field";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	buildPresetAnimation,
	choosePreset,
	getEffectiveDurations,
	getPresetDefinition,
	getPresetRoom,
	getPresetsForElementType,
	setPresetPhase,
	type PresetAnimations,
	type PresetDefinition,
	type PresetPhase,
} from "@/animation/presets";
import { buildTileContent, type TileContent } from "@/animation/tiles/content";
import type { TilePlaybackHandle } from "@/animation/tiles/playback-handle";
import { useEditor } from "@/editor/use-editor";
import type { VisualElement } from "@/timeline";
import type { ElementType } from "@/timeline/types";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import {
	clamp,
	formatNumberForDisplay,
	getFractionDigitsForStep,
	isNearlyEqual,
	snapToStep,
} from "@/utils/math";
import { mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import { PauseTilesToggle } from "./pause-tiles-toggle";
import { PresetTileGrid, getTileId } from "./preset-tiles";
import { useTilePlayback } from "./use-tile-playback";

const DURATION_STEP = 0.1;
const DURATION_FRACTION_DIGITS = getFractionDigitsForStep({
	step: DURATION_STEP,
});

const PHASES: { phase: PresetPhase; title: string }[] = [
	{ phase: "in", title: "In" },
	{ phase: "out", title: "Out" },
];

function ticksToSeconds(ticks: number): number {
	return mediaTimeToSeconds({ time: roundMediaTime({ time: ticks }) });
}

export function AnimationTab({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement, previewUpdates, commit } =
		useElementPreview<VisualElement>({
			trackId,
			elementId: element.id,
			fallback: element,
		});
	const { presetAnimations, duration } = renderElement;
	const presets = getPresetsForElementType({ elementType: renderElement.type });
	const effective = getEffectiveDurations({ presetAnimations, duration });
	const mediaId =
		renderElement.type === "video" || renderElement.type === "image"
			? renderElement.mediaId
			: null;
	const mediaAsset = useEditor((e) =>
		mediaId === null
			? undefined
			: e.media.getAssets().find((asset) => asset.id === mediaId),
	);
	const tileContent = useMemo(
		() => buildTileContent({ element: renderElement, mediaAsset }),
		[renderElement, mediaAsset],
	);
	const playback = useTilePlayback({
		order: PHASES.flatMap(({ phase }) =>
			presets.map((definition) =>
				getTileId({ phase, presetId: definition.id }),
			),
		),
	});

	const commitPresetAnimations = (next: PresetAnimations | undefined) =>
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { presetAnimations: next },
				},
			],
		});

	const choose = ({
		phase,
		definition,
	}: {
		phase: PresetPhase;
		definition: PresetDefinition | undefined;
	}) => {
		const choice = choosePreset({
			presetAnimations,
			phase,
			definition,
			duration,
		});
		if (choice.changed) commitPresetAnimations(choice.presetAnimations);
	};

	const setSeconds = ({
		phase,
		seconds,
		isPreview,
	}: {
		phase: PresetPhase;
		seconds: number;
		isPreview: boolean;
	}) => {
		const current = presetAnimations?.[phase];
		if (!current) return;
		const next = setPresetPhase({
			presetAnimations,
			phase,
			animation: buildPresetAnimation({
				presetAnimations,
				phase,
				id: current.id,
				seconds,
				duration,
			}),
			duration,
		});
		if (isPreview) {
			previewUpdates({ presetAnimations: next });
		} else {
			commitPresetAnimations(next);
		}
	};

	return (
		<>
			<div className="flex px-4 pt-3">
				<PauseTilesToggle playback={playback} />
			</div>
			{PHASES.map(({ phase, title }) => {
				const animation = presetAnimations?.[phase];
				const selected = animation
					? getPresetDefinition(animation.id)
					: undefined;
				const room = getPresetRoom({ presetAnimations, phase, duration });
				return (
					<PhaseSection
						key={phase}
						sectionKey={`${element.id}:anim-${phase}`}
						title={title}
						phase={phase}
						elementType={renderElement.type}
						content={tileContent}
						presetAnimations={presetAnimations}
						clipDuration={duration}
						playback={playback}
						onChoose={(definition) => choose({ phase, definition })}
						duration={
							selected
								? {
										seconds: ticksToSeconds(effective[phase]),
										min: ticksToSeconds(room.min),
										max: ticksToSeconds(room.max),
										// A clip too short to hold both phases at the minimum length.
										isLocked: room.max <= room.min,
										defaultSeconds: selected.defaultSeconds,
										onPreview: (seconds) =>
											setSeconds({ phase, seconds, isPreview: true }),
										onCommit: commit,
										onReset: () =>
											setSeconds({
												phase,
												seconds: selected.defaultSeconds,
												isPreview: false,
											}),
									}
								: undefined
						}
					/>
				);
			})}
		</>
	);
}

type DurationControls = {
	seconds: number;
	min: number;
	max: number;
	isLocked: boolean;
	defaultSeconds: number;
	onPreview: (seconds: number) => void;
	onCommit: () => void;
	onReset: () => void;
};

export function PhaseSection({
	sectionKey,
	title,
	phase,
	elementType,
	content,
	presetAnimations,
	clipDuration,
	playback,
	onChoose,
	duration,
}: {
	sectionKey: string;
	title: string;
	phase: PresetPhase;
	elementType: ElementType;
	content: TileContent;
	presetAnimations: PresetAnimations | undefined;
	clipDuration: number;
	playback: TilePlaybackHandle | undefined;
	onChoose: (definition: PresetDefinition | undefined) => void;
	duration: DurationControls | undefined;
}) {
	return (
		<Section collapsible sectionKey={sectionKey}>
			<SectionHeader>
				<SectionTitle>{title}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<PresetTileGrid
						title={title}
						phase={phase}
						elementType={elementType}
						content={content}
						presetAnimations={presetAnimations}
						duration={clipDuration}
						playback={playback}
						onChoose={onChoose}
					/>
					{duration && (
						<SectionField label="Duration">
							{duration.isLocked ? (
								<LockedDuration
									label={`${title} duration`}
									seconds={duration.seconds}
								/>
							) : (
								<DurationField label={`${title} duration`} {...duration} />
							)}
						</SectionField>
					)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

/**
 * The clip is too short to hold both phases at the minimum length, so the
 * length cannot be edited. Shows the length that actually plays.
 */
function LockedDuration({
	label,
	seconds,
}: {
	label: string;
	seconds: number;
}) {
	return (
		<NumberField
			aria-label={label}
			value={formatNumberForDisplay({
				value: seconds,
				fractionDigits: DURATION_FRACTION_DIGITS,
			})}
			suffix="s"
			disabled
			readOnly
		/>
	);
}

function DurationField({
	label,
	seconds,
	min,
	max,
	defaultSeconds,
	onPreview,
	onCommit,
	onReset,
}: DurationControls & { label: string }) {
	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: seconds,
			fractionDigits: DURATION_FRACTION_DIGITS,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clamp({
				value: snapToStep({ value: parsed, step: DURATION_STEP }),
				min,
				max,
			});
		},
		onPreview,
		onCommit,
	});

	return (
		<SliderField
			value={seconds}
			slider={{ min, max }}
			step={DURATION_STEP}
			label={label}
			unit="seconds"
			onPreview={onPreview}
			onCommit={onCommit}
			onReset={onReset}
			fieldProps={{
				value: draft.displayValue,
				suffix: "s",
				onFocus: draft.onFocus,
				onChange: draft.onChange,
				onBlur: draft.onBlur,
				onReset,
				isDefault: isNearlyEqual({
					leftValue: seconds,
					rightValue: defaultSeconds,
					epsilon: 0.0005,
				}),
			}}
		/>
	);
}
