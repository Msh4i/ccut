"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { PinIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { CHIP_COMPACT_SIZE } from "@/preview/pin-chip-placement";
import type { PinNoticeAction, PinView } from "@/tracking/camera/pin-view";
import type { PinMode } from "@/tracking/camera/types";
import { PinNotices } from "@/tracking/components/pin-notices";

export interface PinChipViewProps {
	view: PinView;
	/** One round button instead of the whole chip: where the preview has no room that keeps clear of the transform handles. */
	compact?: boolean;
	onStick: () => void;
	onCancel: () => void;
	onUnstick: () => void;
	onModeChange: ({ mode }: { mode: PinMode }) => void;
	onNoticeAction: ({ action }: { action: PinNoticeAction }) => void;
}

/** What the compact button does, by state: Cancel while analysing, Unstick when stuck, else Stick (or nothing when it cannot). */
function compactAction({
	view,
	onStick,
	onCancel,
	onUnstick,
}: Pick<PinChipViewProps, "view" | "onStick" | "onCancel" | "onUnstick">): { label: string; run: (() => void) | null } {
	if (view.progress) return { label: view.progress.cancelLabel, run: onCancel };
	if (view.stuck) return { label: "Unstick", run: onUnstick };
	if (view.state === "idle" || view.state === "stale") {
		return { label: view.stickLabel, run: view.canStick ? onStick : null };
	}
	return { label: view.stickLabel, run: null };
}

/**
 * The whole chip shrunk to one button. The state and the notices are in its
 * tooltip (one part to a line) for the mouse, and a warning dot on the button
 * says there is something to read. For a screen reader the notices and the
 * run's announcement are one polite live region that is never drawn (the
 * tooltip alone is not announced: a stick could end with no result said).
 */
function CompactPinChip({
	view,
	onStick,
	onCancel,
	onUnstick,
}: Pick<PinChipViewProps, "view" | "onStick" | "onCancel" | "onUnstick">) {
	const action = compactAction({ view, onStick, onCancel, onUnstick });
	const about = [
		view.progress?.label,
		view.stuck?.label,
		view.disabledReason,
		...view.notices.map((notice) => notice.text),
	].filter((text): text is string => Boolean(text));
	const spoken = [
		{ id: "announcement", text: view.announcement },
		...view.notices.map((notice) => ({ id: notice.id, text: notice.text })),
	].filter((line) => line.text !== "");
	return (
		<div
			className="bg-background/95 flex items-center justify-center rounded-lg border shadow-md"
			style={{ width: CHIP_COMPACT_SIZE, height: CHIP_COMPACT_SIZE }}
		>
			<Button
				variant="ghost"
				size="icon"
				aria-label={action.label}
				aria-disabled={action.run === null}
				// a tooltip's lines are separated by a newline: the texts end in a period of their own
				title={[action.label, ...about].join("\n")}
				className="relative aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
				onClick={() => action.run?.()}
			>
				<HugeiconsIcon icon={PinIcon} size={14} aria-hidden="true" />
				{view.notices.length > 0 ? (
					<span
						aria-hidden="true"
						data-notice-dot
						className="bg-caution ring-background pointer-events-none absolute top-0 right-0 size-2 rounded-full ring-1"
					/>
				) : null}
			</Button>
			<div role="status" aria-live="polite" className="sr-only">
				{spoken.map((line) => (
					<p key={line.id}>{line.text}</p>
				))}
			</div>
		</div>
	);
}

/**
 * The chip next to the selected element as plain markup of a {@link PinView}
 * (plan section d, states 1-5): the button, the progress with Cancel, the
 * stuck line with Unstick and the Follow choice, and the notices.
 */
export function PinChipView({
	view,
	compact = false,
	onStick,
	onCancel,
	onUnstick,
	onModeChange,
	onNoticeAction,
}: PinChipViewProps) {
	if (compact) {
		return <CompactPinChip view={view} onStick={onStick} onCancel={onCancel} onUnstick={onUnstick} />;
	}
	const isDisabledNoVideo = view.state === "disabled" && view.disabledReason !== null;
	return (
		<div className="bg-background/95 flex max-w-[320px] flex-col gap-1.5 rounded-lg border p-1.5 shadow-md">
			{view.progress ? (
				<div className="flex items-center gap-2">
					<div className="flex min-w-24 flex-1 flex-col gap-1">
						<Progress value={view.progress.percent} aria-label="Analysis progress" />
						<p className="text-xs">{view.progress.label}</p>
					</div>
					<Button variant="outline" size="sm" onClick={onCancel}>
						{view.progress.cancelLabel}
					</Button>
				</div>
			) : null}
			{view.state === "idle" || view.state === "stale" ? (
				<Button
					size="sm"
					aria-disabled={!view.canStick}
					className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
					onClick={() => {
						if (view.canStick) onStick();
					}}
				>
					<HugeiconsIcon icon={PinIcon} size={14} aria-hidden="true" />
					{view.stickLabel}
				</Button>
			) : null}
			{view.stuck ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<span role="status" aria-live="polite" className="px-1 text-xs font-medium">
						{view.stuck.label}
					</span>
					<Button variant="outline" size="sm" onClick={onUnstick}>
						Unstick
					</Button>
					<Select
						disabled={!view.canChangeMode}
						value={view.stuck.mode}
						onValueChange={(value) => {
							const option = view.followOptions.find((candidate) => candidate.mode === value);
							if (option) onModeChange({ mode: option.mode });
						}}
					>
						<SelectTrigger size="sm" className="h-7 w-auto gap-1 text-xs" aria-label="Follow">
							<span className="text-muted-foreground">Follow:</span>
							<SelectValue>{view.stuck.modeLabel}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{view.followOptions.map((option) => (
								<SelectItem key={option.mode} value={option.mode}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			{view.state === "stale" && view.canUnstick ? (
				<Button variant="outline" size="sm" onClick={onUnstick}>
					Unstick
				</Button>
			) : null}
			{isDisabledNoVideo ? (
				<div role="status" aria-live="polite" className="bg-caution/10 rounded-md px-2.5 py-1.5 text-xs">
					{view.disabledReason}
				</div>
			) : null}
			<p role="status" aria-live="polite" className="sr-only">
				{view.announcement}
			</p>
			<PinNotices
				notices={view.notices}
				onAction={onNoticeAction}
				actionsDisabled={!view.canChangeMode}
			/>
		</div>
	);
}
