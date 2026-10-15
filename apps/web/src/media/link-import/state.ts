import { formatStorageBytes } from "@/services/storage/quota";
import { messageFor } from "./messages";
import type { LinkImportOutcome, LinkJobView } from "./run";
import type {
	LinkImportErrorCode,
	LinkImportMode,
	LinkImportQuality,
	LinkImportRequest,
	PreparingStep,
} from "./types";
import { prepareLinkUrl } from "./url";

// The "Import from link" dialog as a state machine:
//   form (idle; a refused link shows its code) -> notice (first time only) -> running
//   (starting, preparing, downloading, processing, transferring, importing) -> finished (done,
//   error, cancelled) -> form.
// Pure: the component only renders these states and dispatches these actions.

export type DialogState =
	| { step: "form"; error: LinkImportErrorCode | null }
	| { step: "notice"; request: LinkImportRequest }
	| {
			step: "running";
			request: LinkImportRequest;
			job: LinkJobView;
			cancelling: boolean;
			/** This run is the one automatic retry after "Update yt-dlp and retry". */
			retried: boolean;
	  }
	| {
			step: "finished";
			request: LinkImportRequest;
			outcome: LinkImportOutcome;
			/** The run that ended was already the retry: no second one is offered. */
			retried: boolean;
	  };

export type DialogAction =
	| {
			type: "submit";
			input: string;
			mode: LinkImportMode;
			quality: LinkImportQuality;
			noticeAcknowledged: boolean;
	  }
	| { type: "acknowledge-notice" }
	| { type: "back" }
	/** The user's click on "Update yt-dlp and retry". */
	| { type: "update-and-retry" }
	| { type: "job"; view: LinkJobView }
	| { type: "cancel" }
	| { type: "finished"; outcome: LinkImportOutcome };

export const INITIAL_DIALOG_STATE: DialogState = { step: "form", error: null };

const running = ({
	request,
	retried = false,
}: {
	request: LinkImportRequest;
	retried?: boolean;
}): DialogState => ({
	step: "running",
	request,
	job: retried ? { phase: "updating" } : { phase: "starting" },
	cancelling: false,
	retried,
});

/**
 * Whether the finished screen offers "Update yt-dlp and retry": the job failed because yt-dlp's
 * extractor broke while Ccut's own copy was in use (a yt-dlp on PATH gets a message instead,
 * "path-tool-stale"), and this was not itself the retry.
 */
export function canUpdateAndRetry({ state }: { state: DialogState }): boolean {
	return (
		state.step === "finished" &&
		!state.retried &&
		state.outcome.kind === "error" &&
		state.outcome.code === "extractor-failed"
	);
}

export function reduceLinkImport({
	state,
	action,
}: {
	state: DialogState;
	action: DialogAction;
}): DialogState {
	switch (action.type) {
		case "submit": {
			if (state.step !== "form") return state;
			const prepared = prepareLinkUrl({ input: action.input });
			if (!prepared.ok) return { step: "form", error: prepared.code };
			const request = { url: prepared.url, mode: action.mode, quality: action.quality };
			return action.noticeAcknowledged ? running({ request }) : { step: "notice", request };
		}
		case "acknowledge-notice":
			return state.step === "notice" ? running({ request: state.request }) : state;
		case "back":
			return state.step === "notice" || state.step === "finished"
				? INITIAL_DIALOG_STATE
				: state;
		case "update-and-retry":
			return state.step === "finished" && canUpdateAndRetry({ state })
				? running({ request: state.request, retried: true })
				: state;
		case "job":
			return state.step === "running" ? { ...state, job: action.view } : state;
		case "cancel":
			return state.step === "running" ? { ...state, cancelling: true } : state;
		case "finished":
			return state.step === "running"
				? { step: "finished", request: state.request, outcome: action.outcome, retried: state.retried }
				: state;
		default:
			return state;
	}
}

const PREPARING_LINES: Record<PreparingStep, string> = {
	"tool-check": "Looking for yt-dlp…",
	consent: "Waiting for your answer in the yt-dlp download window…",
	"tool-download": "Downloading and checking yt-dlp…",
};

const percentOf = ({ part, total }: { part: number; total: number }) =>
	Math.min(100, Math.round((part / total) * 100));

function formatEta({ seconds }: { seconds: number }): string {
	const whole = Math.max(0, Math.round(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const rest = String(whole % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${minutes}:${rest}`;
}

/** 0..100 where a total is known, else null (an indeterminate bar). */
export function jobPercent({ job }: { job: LinkJobView }): number | null {
	if (job.phase === "downloading") {
		const total = job.progress?.totalBytes;
		return job.progress && total ? percentOf({ part: job.progress.downloadedBytes, total }) : null;
	}
	if (job.phase === "processing") {
		return job.fraction === null ? null : percentOf({ part: job.fraction, total: 1 });
	}
	if (job.phase === "transferring") {
		return job.totalBytes > 0 ? percentOf({ part: job.transferredBytes, total: job.totalBytes }) : null;
	}
	return null;
}

export function jobStatusLine({ job }: { job: LinkJobView }): string {
	switch (job.phase) {
		case "starting":
			return "Starting…";
		case "updating":
			return "Updating yt-dlp: waiting for your answer in the update window, then downloading and checking it…";
		case "preparing":
			return PREPARING_LINES[job.step];
		case "downloading": {
			const { progress } = job;
			if (!progress) return "Downloading…";
			const parts: string[] = [];
			const percent = jobPercent({ job });
			parts.push(
				percent !== null && progress.totalBytes
					? `${percent}% of ${formatStorageBytes({ bytes: progress.totalBytes })}`
					: formatStorageBytes({ bytes: progress.downloadedBytes }),
			);
			if (progress.speed) parts.push(`${formatStorageBytes({ bytes: progress.speed })}/s`);
			if (progress.eta !== null && progress.totalBytes) {
				parts.push(`${formatEta({ seconds: progress.eta })} left`);
			}
			return `Downloading: ${parts.join(" · ")}`;
		}
		case "processing": {
			// The video-only and the audio download become one MP4 (no re-encoding).
			const percent = jobPercent({ job });
			return percent === null ? "Combining video and audio…" : `Combining video and audio: ${percent}%`;
		}
		case "transferring":
			return `Copying into Ccut: ${jobPercent({ job }) ?? 0}%`;
		case "importing":
			return `Adding “${job.fileName}” to the project…`;
		default:
			return "";
	}
}

/**
 * The text a screen reader hears while a job runs: the stage only, never the numbers. It changes
 * when the stage changes (starting, each preparing step, downloading, combining, copying, adding),
 * not on every progress tick, so a polite live region does not re-announce each percent.
 */
export function jobStageLine({ job, cancelling }: { job: LinkJobView; cancelling: boolean }): string {
	if (cancelling) return "Stopping…";
	switch (job.phase) {
		case "downloading":
			return "Downloading…";
		case "processing":
			return "Combining video and audio…";
		case "transferring":
			return "Copying into Ccut…";
		default:
			return jobStatusLine({ job });
	}
}

/** Cancel stops a running job until its file is being added to the project (that step is short and not stoppable). */
export function canCancel({ state }: { state: DialogState }): boolean {
	// The update is one call into the main process (its dialog and verified download): not stoppable from here.
	return (
		state.step === "running" &&
		!state.cancelling &&
		state.job.phase !== "importing" &&
		state.job.phase !== "updating"
	);
}

const QUALITY_HEIGHTS: Record<LinkImportQuality, number | null> = {
	best: null,
	1080: 1080,
	720: 720,
};

/** What the user is told at the end, including the resolution actually obtained. */
export function outcomeLines({ outcome }: { outcome: LinkImportOutcome }): string[] {
	if (outcome.kind === "cancelled") return ["Cancelled. Nothing was added."];
	if (outcome.kind === "error") return [messageFor({ code: outcome.code })];
	if (outcome.mode === "audio") return [`Added “${outcome.fileName}” (audio only).`];
	const { width, height } = outcome;
	if (width === null || height === null) return [`Added “${outcome.fileName}”.`];
	const lines = [`Added “${outcome.fileName}” (${width}×${height}).`];
	const asked = QUALITY_HEIGHTS[outcome.quality];
	// The quality limit is on the short side (a 1080x1920 portrait video is 1080p).
	const short = Math.min(width, height);
	if (asked !== null && short < asked) {
		lines.push(
			outcome.combined
				? `The best H.264 version of this video is ${short}p, lower than the ${asked}p you chose.`
				: outcome.combineTried
					? `Ccut could not combine separate video and audio for this link, so the best single file was used: ${short}p, lower than the ${asked}p you chose.`
					: `The best single-file version was ${short}p, lower than the ${asked}p you chose.`,
		);
	}
	return lines;
}
