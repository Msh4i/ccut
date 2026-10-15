"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { LinkImportBridge } from "@/media/link-import/bridge";
import { messageFor } from "@/media/link-import/messages";
import {
	acknowledgeNotice,
	hasAcknowledgedNotice,
} from "@/media/link-import/notice";
import {
	type LinkImportOutcome,
	runLinkImport,
	runUpdateThenImport,
} from "@/media/link-import/run";
import {
	SESSION_TEMP_NAMES,
	sweepTempFilesOnce,
} from "@/media/link-import/session";
import {
	type DialogAction,
	type DialogState,
	INITIAL_DIALOG_STATE,
	canCancel,
	canUpdateAndRetry,
	jobPercent,
	jobStageLine,
	jobStatusLine,
	outcomeLines,
	reduceLinkImport,
} from "@/media/link-import/state";
import { createOpfsTempStorage } from "@/media/link-import/transfer";
import type {
	LinkImportErrorCode,
	LinkImportMode,
	LinkImportQuality,
	LinkImportRequest,
} from "@/media/link-import/types";
import { storageService } from "@/services/storage/service";
import { cn } from "@/utils/ui";

// "Import from link" (desktop only). The decisions live in @/media/link-import (state machine,
// flow, bridge checks); this file renders the states and wires the real dependencies.

function browserStorage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

const tempStorage = () =>
	createOpfsTempStorage({ getRoot: () => navigator.storage.getDirectory() });

/** The "yt-dlp X available: Update" line of the form: what the page knows about an update. */
export type UpdateView =
	| { kind: "none" }
	| { kind: "available"; version: string }
	| { kind: "working" }
	| { kind: "done"; version: string }
	| { kind: "failed"; code: LinkImportErrorCode };

const isQuality = (value: string): value is LinkImportQuality =>
	value === "best" || value === "1080" || value === "720";

export function LinkImportFormView({
	url,
	mode,
	quality,
	error,
	onUrlChange,
	onModeChange,
	onQualityChange,
	onSubmit,
	onClose,
	update = { kind: "none" },
	onUpdate,
}: {
	url: string;
	mode: LinkImportMode;
	quality: LinkImportQuality;
	error: LinkImportErrorCode | null;
	onUrlChange: (url: string) => void;
	onModeChange: (mode: LinkImportMode) => void;
	onQualityChange: (quality: LinkImportQuality) => void;
	onSubmit: () => void;
	onClose: () => void;
	update?: UpdateView;
	onUpdate?: () => void;
}) {
	const id = useId();
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (url.trim() !== "") onSubmit();
			}}
		>
			<DialogBody>
				<div className="flex flex-col gap-2">
					<Label htmlFor={`${id}-url`}>YouTube or TikTok link</Label>
					<Input
						id={`${id}-url`}
						type="url"
						inputMode="url"
						autoComplete="off"
						spellCheck={false}
						placeholder="https://www.youtube.com/watch?v=…"
						value={url}
						onChange={(event) => onUrlChange(event.target.value)}
						aria-invalid={error !== null}
					/>
					{error && (
						<p className="text-destructive text-sm" role="alert">
							{messageFor({ code: error })}
						</p>
					)}
				</div>
				<div className="flex flex-col gap-2">
					<Label id={`${id}-mode`}>Import as</Label>
					<RadioGroup
						aria-labelledby={`${id}-mode`}
						value={mode}
						onValueChange={(value) => onModeChange(value === "audio" ? "audio" : "video")}
						className="flex gap-4"
					>
						<div className="flex items-center gap-2">
							<RadioGroupItem value="video" id={`${id}-video`} />
							<Label htmlFor={`${id}-video`}>Video</Label>
						</div>
						<div className="flex items-center gap-2">
							<RadioGroupItem value="audio" id={`${id}-audio`} />
							<Label htmlFor={`${id}-audio`}>Audio only</Label>
						</div>
					</RadioGroup>
				</div>
				{mode === "video" && (
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-quality`}>Quality</Label>
						<Select
							value={quality}
							onValueChange={(value) => {
								if (isQuality(value)) onQualityChange(value);
							}}
						>
							<SelectTrigger id={`${id}-quality`} className="w-40">
								<SelectValue />
							</SelectTrigger>
							{/* Above the dialog (z-250): the list is portaled to the body. */}
							<SelectContent className="z-300">
								<SelectItem value="best">Best</SelectItem>
								<SelectItem value="1080">Up to 1080p</SelectItem>
								<SelectItem value="720">Up to 720p</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							YouTube videos are downloaded as separate H.264 video and AAC
							audio and combined into one MP4 (H.264 goes up to 1080p). TikTok
							videos come as one file. If a video has no such streams, the best
							single file is used; the resolution you get is shown at the end.
						</p>
					</div>
				)}
				<UpdateLine update={update} onUpdate={onUpdate} />
			</DialogBody>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={url.trim() === ""}>
					Import
				</Button>
			</DialogFooter>
		</form>
	);
}

function UpdateLine({
	update,
	onUpdate,
}: {
	update: UpdateView;
	onUpdate?: () => void;
}) {
	switch (update.kind) {
		case "available":
			return (
				<p className="text-muted-foreground text-xs">
					yt-dlp {update.version} available:{" "}
					<Button
						type="button"
						variant="link"
						className="text-xs"
						onClick={onUpdate}
					>
						Update
					</Button>
				</p>
			);
		case "working":
			return (
				<p className="text-muted-foreground text-xs" role="status">
					Updating yt-dlp: waiting for your answer in the update window…
				</p>
			);
		case "done":
			return (
				<p className="text-muted-foreground text-xs" role="status">
					yt-dlp updated to {update.version}.
				</p>
			);
		case "failed":
			return (
				<p className="text-destructive text-xs" role="alert">
					{messageFor({ code: update.code })}
				</p>
			);
		default:
			return null;
	}
}

export function LinkImportNoticeView({
	onAcknowledge,
	onBack,
}: {
	onAcknowledge: () => void;
	onBack: () => void;
}) {
	return (
		<>
			<DialogBody>
				<p className="text-sm">
					Only download content you have the right to use. The platform&apos;s
					terms may forbid downloading.
				</p>
				<p className="text-muted-foreground text-xs">
					This notice is shown once.
				</p>
			</DialogBody>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onBack}>
					Back
				</Button>
				<Button type="button" onClick={onAcknowledge}>
					I understand, continue
				</Button>
			</DialogFooter>
		</>
	);
}

export function LinkImportRunningView({
	state,
	onCancel,
}: {
	state: Extract<DialogState, { step: "running" }>;
	onCancel: () => void;
}) {
	const percent = jobPercent({ job: state.job });
	const line = state.cancelling ? "Stopping…" : jobStatusLine({ job: state.job });
	return (
		<>
			<DialogBody>
				<p className="text-sm" aria-hidden="true">
					{line}
				</p>
				{/* The stage only, polite: it changes on a stage change, not on every percent. */}
				<p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
					{jobStageLine({ job: state.job, cancelling: state.cancelling })}
				</p>
				<Progress
					value={percent ?? 100}
					aria-label="Import progress"
					className={cn(percent === null && "animate-pulse")}
				/>
			</DialogBody>
			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={!canCancel({ state })}
				>
					{state.cancelling ? "Cancelling…" : "Cancel"}
				</Button>
			</DialogFooter>
		</>
	);
}

export function LinkImportFinishedView({
	outcome,
	onBack,
	onClose,
	onUpdateAndRetry,
}: {
	outcome: LinkImportOutcome;
	onBack: () => void;
	onClose: () => void;
	/** Set only when the failure is a broken extractor of Ccut's own yt-dlp (canUpdateAndRetry). */
	onUpdateAndRetry?: () => void;
}) {
	return (
		<>
			<DialogBody
				// An error is announced at once; a result or a cancellation politely.
				role={outcome.kind === "error" ? "alert" : "status"}
				aria-live={outcome.kind === "error" ? "assertive" : "polite"}
				aria-atomic="true"
			>
				{outcomeLines({ outcome }).map((line, index) => (
					<p
						key={line}
						className={cn(
							"text-sm",
							index > 0 && "text-muted-foreground",
							outcome.kind === "error" && index === 0 && "text-destructive",
						)}
					>
						{line}
					</p>
				))}
			</DialogBody>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onBack}>
					{outcome.kind === "error" ? "Try again" : "Import another"}
				</Button>
				{onUpdateAndRetry && (
					<Button type="button" variant="secondary" onClick={onUpdateAndRetry}>
						Update yt-dlp and retry
					</Button>
				)}
				<Button type="button" onClick={onClose}>
					Close
				</Button>
			</DialogFooter>
		</>
	);
}

export function LinkImportDialog({
	open,
	onOpenChange,
	bridge,
	importFile,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	bridge: LinkImportBridge;
	/** The editor's import pipeline; true when an asset was added for this File. */
	importFile: (file: File) => Promise<boolean>;
}) {
	const [state, dispatch] = useReducer(
		(current: DialogState, action: DialogAction) =>
			reduceLinkImport({ state: current, action }),
		INITIAL_DIALOG_STATE,
	);
	const [url, setUrl] = useState("");
	const [mode, setMode] = useState<LinkImportMode>("video");
	const [quality, setQuality] = useState<LinkImportQuality>("best");
	const controllerRef = useRef<AbortController | null>(null);
	const [update, setUpdate] = useState<UpdateView>({ kind: "none" });

	// Temporary files of earlier sessions (their assets now load from the project) go once.
	useEffect(() => {
		void sweepTempFilesOnce({ storage: tempStorage() }).catch(() => 0);
	}, []);

	// Opening the dialog asks the main process whether Ccut's own yt-dlp has a newer release (it
	// queries at most once a day and says nothing when a yt-dlp on PATH is in use). Only a version
	// tag comes back; nothing is downloaded until the user clicks Update.
	useEffect(() => {
		if (!open) return;
		let current = true;
		void bridge.checkUpdate().then((version) => {
			if (current && version) setUpdate({ kind: "available", version });
		});
		return () => {
			current = false;
		};
	}, [open, bridge]);

	const runUpdate = () => {
		setUpdate({ kind: "working" });
		void bridge.updateTool().then((result) =>
			setUpdate(
				result.ok
					? { kind: "done", version: result.version }
					: { kind: "failed", code: result.code },
			),
		);
	};

	// Leaving the editor (unmount) stops a running import.
	useEffect(
		() => () => {
			controllerRef.current?.abort();
		},
		[],
	);

	const begin = ({
		request,
		retried,
	}: {
		request: LinkImportRequest;
		retried: boolean;
	}) => {
		const controller = new AbortController();
		controllerRef.current = controller;
		// A retry updates once, then runs the same request once (run.ts); it never repeats itself.
		void (retried ? runUpdateThenImport : runLinkImport)({
			request,
			signal: controller.signal,
			onView: (view) => dispatch({ type: "job", view }),
			deps: {
				bridge,
				storage: tempStorage(),
				importFile,
				canStore: async (bytes) =>
					(await storageService.canStoreFile({ size: bytes })).canStore,
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				randomHex: () => crypto.randomUUID().replace(/-/g, ""),
				keepNames: SESSION_TEMP_NAMES,
			},
		})
			.catch((): LinkImportOutcome => ({ kind: "error", code: "unknown" }))
			.then((outcome) => {
				if (controllerRef.current === controller) controllerRef.current = null;
				dispatch({ type: "finished", outcome });
			});
	};

	// The reducer is pure: the next state tells whether this action starts a job.
	const act = (action: DialogAction) => {
		const next = reduceLinkImport({ state, action });
		dispatch(action);
		if (next.step === "running" && state.step !== "running") {
			begin({ request: next.request, retried: next.retried });
		}
	};

	const cancel = () => {
		controllerRef.current?.abort();
		dispatch({ type: "cancel" });
	};

	const handleOpenChange = (nextOpen: boolean) => {
		// Closing the window while it runs cancels the import.
		if (!nextOpen && state.step === "running") cancel();
		if (!nextOpen && state.step !== "running") dispatch({ type: "back" });
		onOpenChange(nextOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				// A stray click on the backdrop must not cancel a long download;
				// the close button and Escape still do.
				onInteractOutside={(event) => {
					if (state.step === "running") event.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>Import from link</DialogTitle>
					<DialogDescription>
						Paste a YouTube or TikTok link. The video, or only its audio, is
						downloaded and added to this project.
					</DialogDescription>
				</DialogHeader>
				{state.step === "form" && (
					<LinkImportFormView
						url={url}
						mode={mode}
						quality={quality}
						error={state.error}
						onUrlChange={setUrl}
						onModeChange={setMode}
						onQualityChange={setQuality}
						onSubmit={() =>
							act({
								type: "submit",
								input: url,
								mode,
								quality,
								noticeAcknowledged: hasAcknowledgedNotice({
									storage: browserStorage(),
								}),
							})
						}
						onClose={() => handleOpenChange(false)}
						update={update}
						onUpdate={runUpdate}
					/>
				)}
				{state.step === "notice" && (
					<LinkImportNoticeView
						onAcknowledge={() => {
							acknowledgeNotice({ storage: browserStorage() });
							act({ type: "acknowledge-notice" });
						}}
						onBack={() => act({ type: "back" })}
					/>
				)}
				{state.step === "running" && (
					<LinkImportRunningView state={state} onCancel={cancel} />
				)}
				{state.step === "finished" && (
					<LinkImportFinishedView
						outcome={state.outcome}
						onBack={() => act({ type: "back" })}
						onClose={() => handleOpenChange(false)}
						onUpdateAndRetry={
							canUpdateAndRetry({ state })
								? () => act({ type: "update-and-retry" })
								: undefined
						}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
