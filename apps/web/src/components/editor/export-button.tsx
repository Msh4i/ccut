"use client";

import { useEffect, useRef, useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, FolderOpen, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import { createCloseAutoFocusHandler } from "@/export/focus-return";
import { exportJobView, revealOutcomeMessage, type ExportJobView } from "@/export/job-view";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={cn(
					"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
					hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
				)}
				onClick={hasProject ? () => setIsExportDialogOpen(true) : undefined}
				disabled={!hasProject}
			>
				<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
					<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
					<span className="z-50 text-[0.875rem]">Export</span>
					<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
						<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
					</div>
				</div>
			</button>
			{hasProject && (
				<ExportDialog
					open={isExportDialogOpen}
					onOpenChange={setIsExportDialogOpen}
					getReturnFocusTarget={() => buttonRef.current}
				/>
			)}
		</>
	);
}

/**
 * The export window. While an export runs (or waits on a question) it is
 * modal and cannot be dismissed: Esc, a click outside and the close button do
 * nothing, only Cancel stops it (closing no longer cancels, export-v2 A4).
 */
function ExportDialog({
	open,
	onOpenChange,
	getReturnFocusTarget,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The Export button: the dialog has no trigger of its own, so focus goes back here when it closes. */
	getReturnFocusTarget: () => HTMLElement | null;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const view = exportJobView({ state: exportState });
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	// Set when "Show in folder" had nothing to show.
	const [revealMessage, setRevealMessage] = useState<string | null>(null);

	// Leaving the page while exporting asks first (the desktop app names the export).
	useEffect(() => {
		if (!exportState.isExporting) return;
		const guard = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [exportState.isExporting]);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			onOpenChange(true);
			return;
		}
		if (!view.canClose) return;
		editor.project.clearExportState();
		setRevealMessage(null);
		onOpenChange(false);
	};

	const handleReveal = async () => {
		const revealed = await editor.project.revealExportedFile();
		setRevealMessage(
			revealOutcomeMessage({
				revealed,
				displayName: exportState.result?.file?.displayName ?? "the file",
			}),
		);
	};

	const blockWhileRunning = (event: Event) => {
		if (!view.canClose) event.preventDefault();
	};

	const handleExport = async () => {
		if (!activeProject) return;
		setRevealMessage(null);

		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});

		if (result.success && result.buffer) {
			downloadBuffer({
				buffer: result.buffer,
				filename: `${activeProject.metadata.name}${getExportFileExtension({ format })}`,
				mimeType: getExportMimeType({ format }),
			});
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className={cn(
					"max-w-md",
					!view.canClose && "[&>button:last-child]:hidden",
				)}
				onEscapeKeyDown={blockWhileRunning}
				onPointerDownOutside={blockWhileRunning}
				onInteractOutside={blockWhileRunning}
				onCloseAutoFocus={createCloseAutoFocusHandler({
					target: getReturnFocusTarget,
				})}
			>
				<DialogHeader>
					<DialogTitle>
						{view.view === "running" || view.view === "question"
							? "Exporting project"
							: "Export project"}
					</DialogTitle>
					<DialogDescription className="sr-only">
						Export the project to a video file
					</DialogDescription>
				</DialogHeader>

				{view.view === "settings" && (
					<>
						<ExportSettings
							format={format}
							quality={quality}
							includeAudio={shouldIncludeAudio}
							onFormatChange={setFormat}
							onQualityChange={setQuality}
							onIncludeAudioChange={setShouldIncludeAudio}
						/>
						<DialogFooter>
							<Button onClick={handleExport} className="gap-2">
								<Download className="size-4" />
								Export
							</Button>
						</DialogFooter>
					</>
				)}

				{view.view === "running" && (
					<ExportRunningView
						view={view}
						onCancel={() => editor.project.cancelExport()}
					/>
				)}

				{view.view === "question" && (
					<>
						<DialogBody>
							<p className="text-sm" role="alert">
								{view.question}
							</p>
						</DialogBody>
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() =>
									editor.project.answerUnreadableAudio({ exportAnyway: false })
								}
							>
								Cancel
							</Button>
							<Button
								onClick={() =>
									editor.project.answerUnreadableAudio({ exportAnyway: true })
								}
							>
								Export anyway
							</Button>
						</DialogFooter>
					</>
				)}

				{view.view === "done" && (
					<ExportDoneView
						view={view}
						revealMessage={revealMessage}
						onReveal={handleReveal}
						onDone={() => handleOpenChange(false)}
					/>
				)}

				{view.view === "error" && (
					<ExportError
						error={view.error}
						onRetry={handleExport}
						onBack={() => editor.project.clearExportState()}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * Progress while an export runs. Cancel is shown while it can still stop the
 * export, and disabled ("Cancelling…") once it was pressed: the audio mix cannot be
 * interrupted, so the click would otherwise look dead for minutes. Once the file is
 * being finished there is nothing to cancel and no button.
 */
export function ExportRunningView({
	view,
	onCancel,
}: {
	view: Extract<ExportJobView, { view: "running" }>;
	onCancel: () => void;
}) {
	return (
		<>
			<DialogBody>
				<div className="flex flex-col gap-2">
					<span className="sr-only" role="status" aria-live="polite">
						{view.announce}
					</span>
					<div className="flex items-center justify-between text-sm">
						<span>{view.status}</span>
						{view.percent !== null && (
							<span className="text-muted-foreground">{view.percent}%</span>
						)}
					</div>
					<Progress
						value={view.percent}
						aria-label="Export progress"
						className={cn(view.percent === null && "animate-pulse")}
					/>
					{view.eta && (
						<p className="text-muted-foreground text-xs">{view.eta}</p>
					)}
				</div>
			</DialogBody>
			{view.cancel && (
				<DialogFooter>
					<Button
						variant="outline"
						disabled={view.cancel.disabled}
						onClick={onCancel}
					>
						{view.cancel.label}
					</Button>
				</DialogFooter>
			)}
		</>
	);
}

/** The finished export: what was saved, "Show in folder", and why that may not work. */
export function ExportDoneView({
	view,
	revealMessage,
	onReveal,
	onDone,
}: {
	view: Extract<ExportJobView, { view: "done" }>;
	revealMessage: string | null;
	onReveal: () => void;
	onDone: () => void;
}) {
	return (
		<>
			<DialogBody>
				<p className="text-sm" role="status">
					{view.message}
				</p>
				{revealMessage && (
					<p className="text-muted-foreground text-xs" role="status">
						{revealMessage}
					</p>
				)}
			</DialogBody>
			<DialogFooter>
				{view.canReveal && (
					<Button variant="outline" className="gap-2" onClick={onReveal}>
						<FolderOpen className="size-4" />
						Show in folder
					</Button>
				)}
				<Button onClick={onDone}>Done</Button>
			</DialogFooter>
		</>
	);
}

function ExportSettings({
	format,
	quality,
	includeAudio,
	onFormatChange,
	onQualityChange,
	onIncludeAudioChange,
}: {
	format: ExportFormat;
	quality: ExportQuality;
	includeAudio: boolean;
	onFormatChange: (format: ExportFormat) => void;
	onQualityChange: (quality: ExportQuality) => void;
	onIncludeAudioChange: (includeAudio: boolean) => void;
}) {
	return (
		<div className="flex flex-col">
			<Section collapsible defaultOpen={false} showTopBorder={false}>
				<SectionHeader>
					<SectionTitle>Format</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<RadioGroup
						value={format}
						onValueChange={(value) => {
							if (isExportFormat(value)) {
								onFormatChange(value);
							}
						}}
					>
						<div className="flex items-center space-x-2">
							<RadioGroupItem value="mp4" id="mp4" />
							<Label htmlFor="mp4">MP4 (H.264) - Better compatibility</Label>
						</div>
						<div className="flex items-center space-x-2">
							<RadioGroupItem value="webm" id="webm" />
							<Label htmlFor="webm">WebM (VP9) - Smaller file size</Label>
						</div>
					</RadioGroup>
				</SectionContent>
			</Section>

			<Section collapsible defaultOpen={false}>
				<SectionHeader>
					<SectionTitle>Quality</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<RadioGroup
						value={quality}
						onValueChange={(value) => {
							if (isExportQuality(value)) {
								onQualityChange(value);
							}
						}}
					>
						<div className="flex items-center space-x-2">
							<RadioGroupItem value="low" id="low" />
							<Label htmlFor="low">Low - Smallest file size</Label>
						</div>
						<div className="flex items-center space-x-2">
							<RadioGroupItem value="medium" id="medium" />
							<Label htmlFor="medium">Medium - Balanced</Label>
						</div>
						<div className="flex items-center space-x-2">
							<RadioGroupItem value="high" id="high" />
							<Label htmlFor="high">High - Recommended</Label>
						</div>
						<div className="flex items-center space-x-2">
							<RadioGroupItem value="very_high" id="very_high" />
							<Label htmlFor="very_high">Very high - Largest file size</Label>
						</div>
					</RadioGroup>
				</SectionContent>
			</Section>

			<Section collapsible defaultOpen={false}>
				<SectionHeader>
					<SectionTitle>Audio</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<div className="flex items-center space-x-2">
						<Checkbox
							id="include-audio"
							checked={includeAudio}
							onCheckedChange={(checked) => onIncludeAudioChange(!!checked)}
						/>
						<Label htmlFor="include-audio">Include audio in export</Label>
					</div>
				</SectionContent>
			</Section>
		</div>
	);
}

function ExportError({
	error,
	onRetry,
	onBack,
}: {
	error: string;
	onRetry: () => void;
	onBack: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-6">
			<div className="flex flex-col gap-1.5" role="alert">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs break-words">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>

			<Button
				variant="outline"
				size="sm"
				className="h-8 w-full text-xs"
				onClick={onBack}
			>
				Back to export settings
			</Button>
		</div>
	);
}
