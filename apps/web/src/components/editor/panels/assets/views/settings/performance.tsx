"use client";

import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	PERFORMANCE_MODE_OPTIONS,
	type PerformanceMode,
} from "@/services/video-cache/performance-mode";
import { usePerformanceStore } from "@/services/video-cache/performance-store";
import {
	LEVER_OPTIONS,
	type LeverKey,
	type PlaybackLevers,
} from "@/services/playback-levers/levers";
import { usePlaybackLeversStore } from "@/services/playback-levers/store";
import { cn } from "@/utils/ui";

/** The "Performance" setting: how much memory playback may use (app-wide). */
export function PerformanceModeView({
	mode,
	onSelect,
}: {
	mode: PerformanceMode;
	onSelect: (mode: PerformanceMode) => void;
}) {
	return (
		<Section showTopBorder={false}>
			<SectionHeader>
				<SectionTitle className="flex-1">Performance</SectionTitle>
			</SectionHeader>
			<SectionContent className="px-2 flex flex-col gap-1 pb-2">
				{PERFORMANCE_MODE_OPTIONS.map((option) => {
					const isSelected = option.mode === mode;
					return (
						<Button
							key={option.mode}
							variant={isSelected ? "secondary" : "ghost"}
							aria-pressed={isSelected}
							className={cn(
								"px-2 py-1.5 flex flex-col items-start h-fit w-full whitespace-normal text-left",
								!isSelected && "border border-transparent opacity-75!",
							)}
							onClick={() => onSelect(option.mode)}
						>
							<span className="text-sm">{option.label}</span>
							<span className="text-xs text-muted-foreground font-normal">
								{option.description}
							</span>
						</Button>
					);
				})}
				<p className="px-2 text-xs text-muted-foreground">
					Applies to every project.
				</p>
			</SectionContent>
		</Section>
	);
}

/** The experimental playback levers (docs/ccut/playback-p5-design.md), all off by default. */
export function ExperimentalLeversView({
	levers,
	onChange,
}: {
	levers: PlaybackLevers;
	onChange: (params: { key: LeverKey; on: boolean }) => void;
}) {
	return (
		<Section showTopBorder={false}>
			<SectionHeader>
				<SectionTitle className="flex-1">Experimental (off by default)</SectionTitle>
			</SectionHeader>
			<SectionContent className="px-2 flex flex-col gap-2 pb-2">
				{LEVER_OPTIONS.map((option) => {
					const id = `playback-lever-${option.key}`;
					return (
						<div key={option.key} className="px-2 flex flex-col gap-0.5">
							<div className="flex items-center justify-between gap-2">
								<Label htmlFor={id} className="text-sm font-normal">
									{option.label}
								</Label>
								<Switch
									id={id}
									checked={levers[option.key]}
									onCheckedChange={(on) => onChange({ key: option.key, on })}
								/>
							</div>
							<span className="text-xs text-muted-foreground">{option.description}</span>
						</div>
					);
				})}
			</SectionContent>
		</Section>
	);
}

export function PerformanceSettings() {
	const mode = usePerformanceStore((state) => state.mode);
	const setMode = usePerformanceStore((state) => state.setMode);
	const levers = usePlaybackLeversStore((state) => state.levers);
	const setLever = usePlaybackLeversStore((state) => state.setLever);
	return (
		<>
			<PerformanceModeView mode={mode} onSelect={setMode} />
			<ExperimentalLeversView levers={levers} onChange={setLever} />
		</>
	);
}
