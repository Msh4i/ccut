// "Import from link" (desktop only): the shapes the page and the desktop bridge
// (window.ccutLinkImport, apps/electron/link-import-ipc.js) agree on.

export type LinkImportMode = "video" | "audio";
export type LinkImportQuality = "best" | "1080" | "720";

export interface LinkImportRequest {
	url: string;
	mode: LinkImportMode;
	quality: LinkImportQuality;
}

/** Codes `start` answers with (no job was created). */
export const START_ERROR_CODES = [
	"invalid",
	"url-refused",
	"playlist-refused",
	"busy",
] as const;

/** Codes a job ends with (status "failed"). */
export const JOB_ERROR_CODES = [
	"tool-missing",
	"consent-declined",
	"tool-download-failed",
	"tool-verify-failed",
	"tool-signature-failed",
	"tool-outdated",
	/** yt-dlp's extractor broke (the site changed): Ccut's own copy can be updated. */
	"extractor-failed",
	/** The same on a yt-dlp the user installed: Ccut never changes that one. */
	"path-tool-stale",
	"private",
	"login-required",
	"geo-blocked",
	"rate-limited",
	"unavailable",
	"too-large",
	"network",
	"unsupported",
	"no-compatible-format",
	"timeout",
	"bad-output",
	"unknown",
] as const;

/** Codes of the page's own steps (bridge, storage, transfer, import pipeline). */
export const CLIENT_ERROR_CODES = [
	"bridge-failed",
	"storage-full",
	"transfer-failed",
	"import-failed",
] as const;

/** Codes the "Update yt-dlp" call answers with (besides "bridge-failed"). */
export const UPDATE_ERROR_CODES = [
	"tool-missing",
	"consent-declined",
	"tool-download-failed",
	"tool-verify-failed",
	"tool-signature-failed",
	"busy",
	"up-to-date",
] as const;

export const ALL_ERROR_CODES = [
	...START_ERROR_CODES,
	...JOB_ERROR_CODES,
	...CLIENT_ERROR_CODES,
	"up-to-date",
] as const;

export type StartErrorCode = (typeof START_ERROR_CODES)[number];
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];
export type LinkImportErrorCode = (typeof ALL_ERROR_CODES)[number];

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

/** A yt-dlp release tag as the main process reports it, e.g. "2026.09.01" (see isReleaseTag). */
export type UpdateResult =
	| { ok: true; version: string }
	| { ok: false; code: UpdateErrorCode | "bridge-failed" };

export type PreparingStep = "tool-check" | "consent" | "tool-download";

export interface LinkProgress {
	downloadedBytes: number;
	totalBytes: number | null;
	/** Bytes per second. */
	speed: number | null;
	/** Seconds. */
	eta: number | null;
}

export interface LinkFileInfo {
	size: number;
	ext: string;
	mime: string;
	title: string;
	width: number | null;
	height: number | null;
	duration: number | null;
	vcodec: string | null;
	/** True when the main process combined a video-only and an audio-only download into it. */
	combined: boolean;
	/** True when combining was attempted (a YouTube video), whether or not it worked. */
	combineTried: boolean;
}

export type LinkJobStatus =
	| { state: "preparing"; step: PreparingStep }
	| { state: "downloading"; progress: LinkProgress | null }
	/** Combining the two downloads into one MP4; `fraction` is 0..1 when known. */
	| { state: "processing"; fraction: number | null }
	| { state: "ready"; progress: LinkProgress | null; file: LinkFileInfo }
	| { state: "failed"; code: JobErrorCode }
	| { state: "cancelled" };

export type StartResult =
	| { ok: true; token: string }
	| { ok: false; code: StartErrorCode | "bridge-failed" };
