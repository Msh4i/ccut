import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";
import type { UnreadableAudio } from "./errors";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
}

export interface ExportResult {
	success: boolean;
	/** The file's bytes, when it was built in memory (browser). */
	buffer?: ArrayBuffer;
	/** The file the desktop app wrote; `revealToken` lets it be shown in its folder. */
	file?: { displayName: string; bytes: number; revealToken: string };
	error?: string;
	cancelled?: boolean;
}

/** preparing: fonts, stickers, audio mix; encoding: the frames; finalizing: finalize, check, rename. */
export type ExportPhase = "preparing" | "encoding" | "finalizing";

export interface ExportState {
	isExporting: boolean;
	/** Share of the frames encoded, 0..1. */
	progress: number;
	phase: ExportPhase | null;
	framesDone: number;
	frameCount: number;
	/** Seconds left, or null while there is no honest estimate. */
	etaSeconds: number | null;
	/** Clips whose audio could not be read: the export waits for "Export anyway" or "Cancel". */
	audioQuestion: { skipped: UnreadableAudio[]; allUnreadable: boolean } | null;
	/** Cancel was pressed; the export stops at its next check (the audio mix cannot be interrupted, so this can take a while). */
	cancelling: boolean;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
