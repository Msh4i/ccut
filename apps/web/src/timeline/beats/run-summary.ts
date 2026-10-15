export type BeatFailureReason =
	| "silent"
	| "too-short"
	| "no-beat"
	| "unreadable"
	| "too-long"
	| "too-large"
	| "stem-mismatch"
	| "stems-unavailable"
	| "stems-declined"
	| "stems-pins-missing"
	| "stems-install-failed"
	| "stems-busy"
	| "stems-too-long"
	| "stems-no-disk-space"
	| "stems-out-of-memory"
	| "separation-failed"
	| "failed";

const FAILURE_MESSAGES: Record<BeatFailureReason, string> = {
	"no-beat": "No clear beat found",
	silent: "No audio signal",
	"too-short": "Audio is too short to find a beat",
	unreadable: "Couldn't read audio",
	"too-long": "Audio longer than 30 min",
	"too-large": "Audio file too large",
	"stem-mismatch": "That file is not a stem of this clip's audio (it must be the same length and start at the same moment)",
	"stems-unavailable": "Separating stems is not available here (it needs the Ccut desktop app on Linux)",
	"stems-too-long": "Audio longer than 15 min cannot be separated into stems",
	"stems-no-disk-space": "Not enough free disk space to install the stem separator (it needs about 1.2 GB)",
	"stems-out-of-memory": "Separating the stems needs more memory than is free: close other apps or use a shorter clip",
	"stems-declined": "Stem separation was not installed",
	"stems-pins-missing": "This build cannot install the stem separator yet (its checksums are not filled in)",
	"stems-install-failed": "Installing the stem separator failed",
	"stems-busy": "Another stem separation is running, try again when it is done",
	"separation-failed": "Separating the stems failed",
	failed: "Beat detection failed",
};

type FoundSource = {
	ok: true;
	beatCount: number;
	/** Absent for hits: they have no tempo. */
	bpm?: number;
	clipCount: number;
};
type FailedSource = {
	ok: false;
	reason: BeatFailureReason;
	clipCount: number;
};
export type BeatSourceOutcome = FoundSource | FailedSource;

/** One toast for a whole run: `sources` is never empty. */
export function summarizeBeatRun({ sources }: { sources: BeatSourceOutcome[] }): {
	type: "success" | "warning" | "error";
	message: string;
} {
	const found = sources.filter((source): source is FoundSource => source.ok);
	const failed = sources.filter((source): source is FailedSource => !source.ok);
	const clips = (list: BeatSourceOutcome[]) =>
		list.reduce((sum, source) => sum + source.clipCount, 0);

	if (found.length === 0) {
		return { type: "error", message: FAILURE_MESSAGES[failed[0].reason] };
	}
	if (failed.length > 0) {
		return {
			type: "warning",
			message: `Found beats in ${clips(found)} of ${clips(sources)} clips`,
		};
	}
	if (found.length === 1) {
		const [{ beatCount, bpm }] = found;
		return {
			type: "success",
			message:
				bpm === undefined
					? `Found ${beatCount} hits`
					: `Found ${beatCount} beats (≈${Math.round(bpm)} BPM)`,
		};
	}
	return { type: "success", message: `Found beats in ${clips(found)} clips` };
}
