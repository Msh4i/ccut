import type { ExportState } from "./index";
import type { UnreadableAudio } from "./errors";

export const IDLE_EXPORT_STATE: ExportState = {
	isExporting: false,
	progress: 0,
	phase: null,
	framesDone: 0,
	frameCount: 0,
	etaSeconds: null,
	audioQuestion: null,
	cancelling: false,
	result: null,
};

/** The Cancel button of the running view; `null` where there is nothing left to cancel. */
export type ExportCancelControl = { label: "Cancel" | "Cancelling…"; disabled: boolean };

/** What the export window shows. Only "settings", "done" and "error" may be closed. */
export type ExportJobView =
	| { view: "settings"; canClose: true }
	| {
			view: "running";
			canClose: false;
			/** Changes with each frame: shown, not announced. */
			status: string;
			/** Changes only with the phase: what a screen reader announces. */
			announce: string;
			percent: number | null;
			eta: string | null;
			cancel: ExportCancelControl | null;
	  }
	| { view: "question"; canClose: false; question: string }
	| { view: "done"; canClose: true; message: string; canReveal: boolean }
	| { view: "error"; canClose: true; error: string };

export function formatEta({ seconds }: { seconds: number }): string {
	if (seconds <= 0) return "Almost done";
	if (seconds < 50) return `About ${Math.max(5, Math.ceil(seconds / 5) * 5)} s left`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `About ${minutes} min left`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes - hours * 60;
	return rest === 0 ? `About ${hours} h left` : `About ${hours} h ${rest} min left`;
}

export function formatFileSize({ bytes }: { bytes: number }): string {
	if (bytes < 1000) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1000;
	let unit = 0;
	for (; value >= 1000 && unit < units.length - 1; unit++) value /= 1000;
	return `${value.toFixed(1)} ${units[unit]}`;
}

/** The question asked before exporting with clips whose audio could not be read (export-v2 A10). */
export function unreadableAudioQuestion({
	skipped,
	allUnreadable,
}: {
	skipped: readonly UnreadableAudio[];
	allUnreadable: boolean;
}): string {
	const names = [...new Set(skipped.map(({ name }) => name))];
	if (names.length === 0 || allUnreadable) {
		return "None of the project's audio could be read. The exported file will have no sound.";
	}
	if (names.length === 1) {
		return `The audio of "${names[0]}" could not be read. It will be silent in the exported file.`;
	}
	const shown = names.slice(0, 5).map((name) => `"${name}"`).join(", ");
	const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
	return `The audio of ${names.length} clips (${shown}${more}) could not be read. They will be silent in the exported file.`;
}

const PHASE_STATUS = {
	// No phase yet: the native save dialog is open (the first phase starts once it is answered).
	waitingForLocation: "Waiting for the save location…",
	preparing: "Preparing fonts, stickers and audio…",
	finalizing: "Finishing the file…",
	cancelling: "Stopping the export…",
} as const;

/** Shown when "Show in folder" had nothing to show (a finished export is remembered for an hour). */
export function revealOutcomeMessage({ revealed, displayName }: { revealed: boolean; displayName: string }): string | null {
	if (revealed) return null;
	return `Could not open the folder for "${displayName}" any more. Finished exports can be shown for an hour; look for the file in the folder you saved it to.`;
}

function runningStatus({ phase }: { phase: ExportState["phase"] }): string {
	if (phase === "finalizing") return PHASE_STATUS.finalizing;
	return phase === null ? PHASE_STATUS.waitingForLocation : PHASE_STATUS.preparing;
}

export function exportJobView({ state }: { state: ExportState }): ExportJobView {
	if (state.audioQuestion) {
		return { view: "question", canClose: false, question: unreadableAudioQuestion(state.audioQuestion) };
	}
	if (state.isExporting) {
		// Finalizing cannot be cancelled: the file is closed, checked and renamed, and the exporter
		// no longer looks at the cancel signal. A Cancel pressed that late changes nothing here.
		const stoppable = state.phase !== "finalizing";
		const cancelling = state.cancelling && stoppable;
		const cancel: ExportCancelControl | null = !stoppable
			? null
			: cancelling
				? { label: "Cancelling…", disabled: true }
				: { label: "Cancel", disabled: false };
		if (state.phase === "encoding" && state.frameCount > 0) {
			return {
				view: "running",
				canClose: false,
				status: cancelling ? PHASE_STATUS.cancelling : `Encoding frame ${state.framesDone} of ${state.frameCount}`,
				announce: cancelling ? "Cancelling" : "Encoding",
				percent: Math.round((state.framesDone / state.frameCount) * 100),
				eta: cancelling ? null : state.etaSeconds === null ? "Estimating time left…" : formatEta({ seconds: state.etaSeconds }),
				cancel,
			};
		}
		const status = cancelling ? PHASE_STATUS.cancelling : runningStatus({ phase: state.phase });
		return {
			view: "running",
			canClose: false,
			status,
			announce: cancelling ? "Cancelling" : status,
			percent: null,
			eta: null,
			cancel,
		};
	}
	const result = state.result;
	if (!result || result.cancelled) return { view: "settings", canClose: true };
	if (!result.success) return { view: "error", canClose: true, error: result.error || "Unknown error occurred" };
	if (result.file) {
		return {
			view: "done",
			canClose: true,
			message: `Saved ${result.file.displayName} (${formatFileSize({ bytes: result.file.bytes })})`,
			canReveal: true,
		};
	}
	return {
		view: "done",
		canClose: true,
		message: `Downloaded (${formatFileSize({ bytes: result.buffer?.byteLength ?? 0 })})`,
		canReveal: false,
	};
}
