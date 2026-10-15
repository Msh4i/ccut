"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import type { PinMode } from "../camera/types";
import type { PinNoticeAction, PinView } from "../camera/pin-view";
import { PinNotices } from "./pin-notices";

const DESCRIPTION =
	"Follows the video under this clip so it looks glued to the scene: it moves, zooms and rotates with the camera.";

export interface CameraPinSectionViewProps {
	elementId: string;
	view: PinView;
	onStick: () => void;
	onCancel: () => void;
	onUnstick: () => void;
	onModeChange: ({ mode }: { mode: PinMode }) => void;
	onNoticeAction: ({ action }: { action: PinNoticeAction }) => void;
}

/** The section as plain markup of a {@link PinView}: no store, no editor. */
export function CameraPinSectionView({
	elementId,
	view,
	onStick,
	onCancel,
	onUnstick,
	onModeChange,
	onNoticeAction,
}: CameraPinSectionViewProps) {
	const reasonId = useId();
	const followId = useId();
	const isAnalysing = view.state === "analysing";
	const showStick = !isAnalysing && view.state !== "stuck";

	return (
		<Section sectionKey={`${elementId}:tracking-stick`}>
			<SectionHeader>
				<SectionTitle>Stick to scene</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<p className="text-muted-foreground text-sm">{DESCRIPTION}</p>
					{showStick ? (
						<Button
							aria-disabled={!view.canStick}
							aria-describedby={view.disabledReason ? reasonId : undefined}
							className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
							onClick={() => {
								if (view.canStick) onStick();
							}}
						>
							{view.stickLabel}
						</Button>
					) : null}
					{showStick && view.disabledReason ? (
						<p id={reasonId} className="text-muted-foreground text-sm">
							{view.disabledReason}
						</p>
					) : null}
					{view.progress ? (
						<div className="flex flex-col gap-1.5">
							<Progress value={view.progress.percent} aria-label="Analysis progress" />
							<div className="flex items-center justify-between gap-2">
								<p className="text-sm">{view.progress.label}</p>
								<Button variant="outline" size="sm" onClick={onCancel}>
									{view.progress.cancelLabel}
								</Button>
							</div>
						</div>
					) : null}
					{view.stuck ? (
						<>
							<p role="status" aria-live="polite" className="text-sm">
								{view.stuck.summary}
							</p>
							<div className="flex flex-col gap-2">
								<Label id={followId}>Follow</Label>
								<RadioGroup
									aria-labelledby={followId}
									disabled={!view.canChangeMode}
									value={view.stuck.mode}
									onValueChange={(value) => {
										const option = view.followOptions.find((candidate) => candidate.mode === value);
										if (option) onModeChange({ mode: option.mode });
									}}
									className="flex gap-4"
								>
									{view.followOptions.map((option) => (
										<div key={option.mode} className="flex items-center gap-2">
											<RadioGroupItem value={option.mode} id={`${followId}-${option.mode}`} />
											<Label htmlFor={`${followId}-${option.mode}`}>{option.label}</Label>
										</div>
									))}
								</RadioGroup>
							</div>
						</>
					) : null}
					{view.canUnstick ? (
						<Button variant="outline" onClick={onUnstick}>
							Unstick
						</Button>
					) : null}
					<p role="status" aria-live="polite" className="sr-only">
						{view.announcement}
					</p>
					<PinNotices
						notices={view.notices}
						onAction={onNoticeAction}
						actionsDisabled={!view.canChangeMode}
					/>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
