"use client";

import { useState } from "react";
import { toast } from "sonner";
import { NumberField } from "@/components/ui/number-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	KEYFRAME_PRESET_DEFINITIONS,
	resolveKeyframePresetRequest,
	type KeyframePresetDefinition,
	type KeyframePresetGroup,
	type KeyframePresetId,
	type PlacementChoice,
} from "@/animation/keyframe-presets";
import { useEditor } from "@/editor/use-editor";
import type { KeyframeTarget } from "@/timeline/playhead-keyframes";
import { elementSupportsKeyframePreset } from "@/timeline/keyframe-preset";

const GROUPS: { group: KeyframePresetGroup; title: string }[] = [
	{ group: "visual", title: "Motion" },
	{ group: "audio", title: "Volume" },
];

const SEGMENT_ITEM =
	"h-7 min-w-0 flex-1 rounded-sm px-2 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs";

const PLACEMENTS: { value: PlacementChoice; label: string; title: string }[] = [
	{ value: "auto", label: "Auto", title: "Where the preset usually goes" },
	{ value: "start", label: "Start", title: "From the start of the clip" },
	{ value: "playhead", label: "Playhead", title: "From the playhead" },
	{ value: "end", label: "End", title: "Ending at the end of the clip" },
];

/**
 * Ready-made keyframe animations. A click writes ordinary, editable keyframes
 * on the clip (one undo step); the diamonds then show in the timeline and the
 * graph editor like any others. Different from the In / Out animations of the
 * Animation tab, which are not keyframes.
 */
export function KeyframePresetsTab({
	targets,
}: {
	targets: readonly KeyframeTarget[];
}) {
	const editor = useEditor();
	const scopeKey = targets.length === 1 ? targets[0].element.id : "multi";
	const [placement, setPlacement] = useState<PlacementChoice>("auto");
	const [lengthText, setLengthText] = useState("");

	const apply = (definition: KeyframePresetDefinition) => {
		const request = resolveKeyframePresetRequest({
			definition,
			placement,
			lengthText,
		});
		if (!request) {
			toast.error("The length must be a number of seconds.");
			return;
		}
		try {
			const count = editor.timeline.applyKeyframePreset({
				targets: targets.map(({ trackId, element }) => ({
					trackId,
					elementId: element.id,
				})),
				presetId: definition.id,
				...request,
			});
			if (count < targets.length) {
				toast.info(
					`Applied to ${count} of ${targets.length} clips; the others cannot take it.`,
				);
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "The preset could not be applied.",
			);
		}
	};

	return (
		<>
			<Section sectionKey={`${scopeKey}:kf-presets-options`}>
				<SectionContent className="pt-4">
					<SectionFields>
						<SectionField label="Where">
							<ToggleGroup
								type="single"
								aria-label="Where the keyframes go"
								value={placement}
								onValueChange={(value) => {
									const choice = PLACEMENTS.find((option) => option.value === value);
									if (choice) setPlacement(choice.value);
								}}
								className="bg-foreground/5 gap-1 rounded-md p-1"
							>
								{PLACEMENTS.map((option) => (
									<ToggleGroupItem
										key={option.value}
										value={option.value}
										title={option.title}
										className={SEGMENT_ITEM}
									>
										{option.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</SectionField>
						<SectionField label="Length (seconds)">
							<NumberField
								aria-label="Length in seconds"
								value={lengthText}
								placeholder="Auto"
								onChange={(event) => setLengthText(event.target.value)}
							/>
						</SectionField>
					</SectionFields>
				</SectionContent>
			</Section>
			{GROUPS.map(({ group, title }) => {
				const presets = KEYFRAME_PRESET_DEFINITIONS.filter(
					(definition) =>
						definition.group === group &&
						targets.some(({ element }) =>
							elementSupportsKeyframePreset({ element, definition }),
						),
				);
				if (presets.length === 0) return null;
				return (
					<Section
						key={group}
						collapsible
						sectionKey={`${scopeKey}:kf-presets-${group}`}
					>
						<SectionHeader>
							<SectionTitle>{title}</SectionTitle>
						</SectionHeader>
						<SectionContent>
							<div className="grid grid-cols-3 gap-1.5">
								{presets.map((definition) => (
									<PresetTile
										key={definition.id}
										definition={definition}
										onSelect={() => apply(definition)}
									/>
								))}
							</div>
						</SectionContent>
					</Section>
				);
			})}
		</>
	);
}

/** The motion each visual preset plays in its tile, and where its ghost (the end pose) sits. */
const MOTION_PREVIEWS: Partial<Record<KeyframePresetId, { animation: string; ghost: string }>> = {
	"zoom-in": { animation: "kf-zoom-in", ghost: "scale(1.05)" },
	"zoom-out": { animation: "kf-zoom-out", ghost: "scale(0.8)" },
	pulse: { animation: "kf-pulse", ghost: "scale(1)" },
	shake: { animation: "kf-shake", ghost: "translateX(3px)" },
	float: { animation: "kf-float", ghost: "translateY(-3px)" },
	swing: { animation: "kf-swing", ghost: "rotate(9deg)" },
	"pan-left": { animation: "kf-pan-left", ghost: "translateX(-6px)" },
	"pan-right": { animation: "kf-pan-right", ghost: "translateX(6px)" },
	"pan-up": { animation: "kf-pan-up", ghost: "translateY(-4px)" },
	"pan-down": { animation: "kf-pan-down", ghost: "translateY(4px)" },
};

/** The volume over time each audio preset draws (x 0..40 = time, y 2..20 = quiet to loud). */
const VOLUME_ENVELOPES: Partial<Record<KeyframePresetId, string>> = {
	"volume-fade-in": "M2 20 L18 4 L38 4",
	"volume-fade-out": "M2 4 L22 4 L38 20",
	"volume-duck": "M2 4 L10 4 L14 14 L26 14 L30 4 L38 4",
	"volume-swell": "M2 14 L12 14 L24 4 L38 4",
};

function PresetTile({
	definition,
	onSelect,
}: {
	definition: KeyframePresetDefinition;
	onSelect: () => void;
}) {
	const motion = MOTION_PREVIEWS[definition.id];
	const envelope = VOLUME_ENVELOPES[definition.id];
	return (
		<button
			type="button"
			title={definition.description}
			onClick={onSelect}
			className="group flex cursor-pointer flex-col items-center gap-1 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
		>
			<span className="bg-foreground/5 group-hover:bg-foreground/10 relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md transition-colors">
				{motion ? (
					<>
						<span
							aria-hidden
							className="border-foreground/25 absolute h-[44%] w-[40%] rounded-[3px] border border-dashed"
							style={{ transform: motion.ghost }}
						/>
						<span
							aria-hidden
							className="kf-preview bg-primary/35 border-primary relative h-[44%] w-[40%] rounded-[3px] border"
							style={{ ["--kf-animation" as string]: motion.animation }}
						/>
					</>
				) : envelope ? (
					<svg viewBox="0 0 40 24" className="text-foreground/70 group-hover:text-primary h-[60%] w-[70%] transition-colors" aria-hidden>
						<path d={envelope} fill="none" className="stroke-current" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				) : null}
			</span>
			<span className="text-muted-foreground group-hover:text-foreground w-full truncate text-center text-[11px] leading-tight transition-colors">
				{definition.label}
			</span>
		</button>
	);
}
