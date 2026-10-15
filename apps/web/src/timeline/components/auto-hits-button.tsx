"use client";

import { useState } from "react";
import { ArrowDown01Icon, AudioWave01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { STEM_LABELS, STEM_NAMES } from "@/services/stems/types";
import {
	MARKER_MODES,
	type MarkerMode,
	parseMarkerMode,
	parseStem,
} from "@/timeline/beats/stem-choice";
import type { StemName } from "@/services/stems/types";
import { useStemChoiceStore } from "@/timeline/beats/stem-choice-store";
import { useAutoHits } from "@/timeline/beats/use-beat-detection";
import { ToolbarButton } from "./toolbar-button";

const STEM_HINTS: Record<StemName, string> = {
	drums: "kick, snare, hi-hat",
	bass: "bass line",
	vocals: "the voice",
	other: "guitar, keys, synths",
};

/** The three choices most edits need; anything else is under Advanced. */
const PRESETS: ReadonlyArray<{ label: string; hint: string; stem: StemName; mode: MarkerMode }> = [
	{ label: "Drum hits", hint: "every kick, snare and hat", stem: "drums", mode: "hits" },
	{ label: "Steady beat", hint: "one tempo, evenly spaced", stem: "drums", mode: "beats" },
	{ label: "Song & vocals", hint: "the singer's accents", stem: "vocals", mode: "hits" },
];

const presetValue = ({ stem, mode }: { stem: StemName; mode: MarkerMode }) => `${stem}:${mode}`;

/**
 * The one Auto hits button. Left click runs it on the sticky choice; right click, the small
 * arrow beside it and the keyboard menu key open the menu that changes the choice. Upkeep
 * (clearing separated stems, removing the separator) lives in Settings.
 */
export function AutoHitsButton() {
	const autoHits = useAutoHits();
	const stem = useStemChoiceStore((store) => store.stem);
	const mode = useStemChoiceStore((store) => store.mode);
	const setStem = useStemChoiceStore((store) => store.setStem);
	const setMode = useStemChoiceStore((store) => store.setMode);
	const [open, setOpen] = useState(false);

	const current = presetValue({ stem, mode });
	const preset = PRESETS.find((option) => presetValue(option) === current);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<div
				className="flex items-center"
				onContextMenu={(event) => {
					event.preventDefault();
					setOpen(true);
				}}
			>
				<ToolbarButton
					icon={<HugeiconsIcon icon={AudioWave01Icon} />}
					isActive={autoHits.isActive}
					disabled={!autoHits.isAvailable}
					busy={autoHits.isRunning}
					label={autoHits.label}
					tooltip={autoHits.tooltip}
					onClick={() => void autoHits.toggle()}
				/>
				<DropdownMenuTrigger asChild>
					<Button
						variant="text"
						size="icon"
						className="h-8 w-6 rounded-sm"
						aria-label={`Choose what Auto hits marks (now: ${preset?.label ?? `${STEM_LABELS[stem]}, custom`})`}
					>
						<HugeiconsIcon icon={ArrowDown01Icon} className="size-3" />
					</Button>
				</DropdownMenuTrigger>
			</div>
			<DropdownMenuContent align="start">
				<DropdownMenuLabel>What to mark</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={preset ? current : ""}
					onValueChange={(value) => {
						const chosen = PRESETS.find((option) => presetValue(option) === value);
						if (!chosen) return;
						setStem(chosen.stem);
						setMode(chosen.mode);
					}}
				>
					{PRESETS.map((option) => (
						<DropdownMenuRadioItem key={presetValue(option)} value={presetValue(option)}>
							{option.label}
							<span className="text-muted-foreground ml-2 text-xs">{option.hint}</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						Advanced
						{!preset && (
							<span className="text-muted-foreground ml-2 text-xs">
								{STEM_LABELS[stem]}, {mode === "hits" ? "every hit" : "beat grid"}
							</span>
						)}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuLabel>Listen to</DropdownMenuLabel>
						<DropdownMenuRadioGroup value={stem} onValueChange={(value) => setStem(parseStem(value))}>
							{STEM_NAMES.map((name) => (
								<DropdownMenuRadioItem key={name} value={name}>
									{STEM_LABELS[name]}
									<span className="text-muted-foreground ml-2 text-xs">{STEM_HINTS[name]}</span>
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>Mark</DropdownMenuLabel>
						<DropdownMenuRadioGroup value={mode} onValueChange={(value) => setMode(parseMarkerMode(value))}>
							{MARKER_MODES.map(({ mode: option, label, hint }) => (
								<DropdownMenuRadioItem key={option} value={option}>
									{label}
									<span className="text-muted-foreground ml-2 text-xs">{hint}</span>
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							disabled={!autoHits.canPickOwnStem}
							onSelect={() => void autoHits.toggleWithOwnStem()}
						>
							Use my own stem file...
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
