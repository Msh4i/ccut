/**
 * Codes of the export errors the UI can tell apart. Each export slice adds the
 * codes it actually throws (export-v2 plan, section P4); none is listed ahead
 * of its use.
 */
export const EXPORT_ERROR_CODES = [
	"AAC_UNAVAILABLE",
	"AUDIO_UNREADABLE",
	"AUDIO_TOO_SHORT",
	"EXPORT_BUSY",
	"DISK_FULL",
	"WRITE_FAILED",
	"VERIFY_FAILED",
	"SESSION_EXPIRED",
	"NAME_TOO_LONG",
	"TOO_LARGE_FOR_MEMORY",
] as const;

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

export class ExportError extends Error {
	readonly code: ExportErrorCode;
	/** Technical reason, for the copyable error text. */
	readonly detail: string;

	constructor({
		code,
		message,
		detail,
		cause,
	}: {
		code: ExportErrorCode;
		message: string;
		detail: string;
		cause?: unknown;
	}) {
		super(message, { cause });
		this.name = "ExportError";
		this.code = code;
		this.detail = detail;
	}
}

export function isExportError(value: unknown): value is ExportError {
	return value instanceof ExportError;
}

function describeCause({ cause }: { cause: unknown }): string {
	if (cause instanceof Error) {
		return cause.message || cause.name;
	}
	return String(cause);
}

/**
 * The AAC encoder could not be loaded, registered or used. The message tells
 * the user what to do instead; `stage` says where it failed.
 */
export function createAacUnavailableError({
	stage,
	cause,
}: {
	stage: string;
	cause?: unknown;
}): ExportError {
	const reason = cause === undefined ? stage : `${stage}: ${describeCause({ cause })}`;
	return new ExportError({
		code: "AAC_UNAVAILABLE",
		message:
			"The AAC audio encoder could not start, so the MP4 was not exported. " +
			'Export as WebM (Opus audio), or turn off "Include audio" and export again. ' +
			`Details: AAC_UNAVAILABLE, ${reason}`,
		detail: reason,
		cause,
	});
}

/** A timeline clip whose audio could not be decoded, and why. */
export type UnreadableAudio = { name: string; reason: string };

/** Longest list of clip names in the error message; the rest is counted. */
const MAX_NAMES_IN_ERROR = 5;

/**
 * Audio the user asked for ("Include audio") could not be read. The export
 * stops: writing the file anyway would leave those clips silent without a word.
 * With `skipped` empty the whole mix is empty although the timeline has audio.
 */
export function createAudioUnreadableError({
	skipped,
}: {
	skipped: readonly UnreadableAudio[];
}): ExportError {
	if (skipped.length === 0) {
		return new ExportError({
			code: "AUDIO_UNREADABLE",
			message:
				"None of the project's audio could be read, so the exported file would have no sound. " +
				'Remove or re-add the audio clips, or turn off "Include audio" and export again. ' +
				"Details: AUDIO_UNREADABLE, the audio mix is empty",
			detail: "the audio mix is empty",
		});
	}

	const names = [...new Set(skipped.map(({ name }) => name))];
	const shown = names
		.slice(0, MAX_NAMES_IN_ERROR)
		.map((name) => `"${name}"`)
		.join(", ");
	const hidden = names.length - MAX_NAMES_IN_ERROR;
	const list = hidden > 0 ? `${shown} and ${hidden} more` : shown;
	const detail = skipped.map(({ name, reason }) => `${name}: ${reason}`).join("; ");

	return new ExportError({
		code: "AUDIO_UNREADABLE",
		message:
			`Audio of ${list} could not be read, so it would be silent in the exported file. ` +
			`Remove or re-add ${names.length === 1 ? "it" : "them"}, or turn off "Include audio" and export again. ` +
			`Details: AUDIO_UNREADABLE, ${detail}`,
		detail,
	});
}

/**
 * An AAC track needs more than one AAC frame of audio: the first 1024 samples
 * are the encoder's priming and are not encoded (see `AAC_PRIMING_SAMPLES`).
 */
export function createAudioTooShortError({
	samples,
	sampleRate,
}: {
	samples: number;
	sampleRate: number;
}): ExportError {
	const detail = `${samples} samples at ${sampleRate} Hz`;
	return new ExportError({
		code: "AUDIO_TOO_SHORT",
		message:
			"The audio is no longer than one AAC frame (1024 samples, 23 ms), too short to encode as AAC, so the MP4 was not exported. " +
			'Lengthen the project or turn off "Include audio". ' +
			`Details: AUDIO_TOO_SHORT, ${detail}`,
		detail,
	});
}

/** Errors of the export-to-disk path (desktop app): what the user reads for each. */
const FILE_ERROR_MESSAGES = {
	EXPORT_BUSY: "Another export is already running or its save dialog is open. Wait for it to finish, then export again.",
	DISK_FULL: "The disk is full, so the video could not be saved. Nothing was left behind. Free some space or pick another drive, then export again.",
	WRITE_FAILED: "The video file could not be written. Nothing was left behind. Pick another folder, then export again.",
	VERIFY_FAILED: "The exported file did not check out as a complete video, so it was deleted. Export again.",
	SESSION_EXPIRED: "The export session expired or was closed. Start the export again.",
	NAME_TOO_LONG: "The file name is too long for this system. Pick a shorter name, then export again.",
} as const;

export type FileErrorCode = keyof typeof FILE_ERROR_MESSAGES;

export function createFileErrorFor({
	code,
	detail,
	cause,
}: {
	code: FileErrorCode;
	detail: string;
	cause?: unknown;
}): ExportError {
	return new ExportError({
		code,
		message: `${FILE_ERROR_MESSAGES[code]} Details: ${code}${detail ? `, ${detail}` : ""}`,
		detail,
		cause,
	});
}

const GIB = 2 ** 30;

/**
 * Without the desktop app's file writer the whole file is built in memory, which
 * fails (or crashes the tab) somewhere below 4 GiB. Refused before any work starts.
 */
export function createTooLargeForMemoryError({
	estimatedBytes,
	limitBytes,
}: {
	estimatedBytes: number;
	limitBytes: number;
}): ExportError {
	const estimate = `${(estimatedBytes / GIB).toFixed(1)} GiB`;
	const limit = `${(limitBytes / GIB).toFixed(1)} GiB`;
	const detail = `estimated ${estimate}, in-memory limit ${limit}`;
	return new ExportError({
		code: "TOO_LARGE_FOR_MEMORY",
		message:
			`This export would be about ${estimate}, more than the ${limit} a browser can build in memory. ` +
			"Use the Ccut desktop app, which writes straight to disk, or lower the quality or the length. " +
			`Details: TOO_LARGE_FOR_MEMORY, ${detail}`,
		detail,
	});
}
