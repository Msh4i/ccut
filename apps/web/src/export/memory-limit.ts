import type { ExportFormat, ExportQuality } from "./index";
import { audioBitrateFor } from "./audio-codec";

/**
 * Largest export built in memory (no desktop file writer). mediabunny's
 * `BufferTarget` holds the media until `finalize` and then copies it into one
 * ArrayBuffer, capped at 4 GiB (export-v2 A1); downloading copies it once more.
 */
export const IN_MEMORY_EXPORT_LIMIT_BYTES = 3 * 2 ** 30;

const QUALITY_FACTORS: Record<ExportQuality, number> = { low: 0.6, medium: 1, high: 2, very_high: 4 };
const CODEC_FACTORS: Record<ExportFormat, number> = { mp4: 1, webm: 0.6 }; // avc, vp9

/**
 * The video bitrate mediabunny asks the encoder for (`Quality._toVideoBitrate`,
 * mediabunny 1.41.0; a test compares the two). Note it does not depend on fps.
 */
export function videoBitrateFor({
	format,
	quality,
	width,
	height,
}: {
	format: ExportFormat;
	quality: ExportQuality;
	width: number;
	height: number;
}): number {
	const scale = ((width * height) / (1920 * 1080)) ** 0.95;
	const bitrate = 3_000_000 * scale * CODEC_FACTORS[format] * QUALITY_FACTORS[quality];
	return Math.ceil(bitrate / 1000) * 1000;
}

/**
 * Rough size of the file: (video + audio bitrate) x duration. Software H.264
 * holds its target closely (export-v2 M2); VP9 usually stays below it, so this
 * errs on the large side. Only used for the in-memory limit and the main
 * process's free-space report, never shown as a promise.
 */
export function estimateExportBytes({
	format,
	quality,
	width,
	height,
	durationSeconds,
	includeAudio,
}: {
	format: ExportFormat;
	quality: ExportQuality;
	width: number;
	height: number;
	durationSeconds: number;
	includeAudio: boolean;
}): number {
	const video = videoBitrateFor({ format, quality, width, height });
	const audio = includeAudio ? audioBitrateFor({ codec: format === "mp4" ? "aac" : "opus", quality }) : 0;
	return Math.ceil(((video + audio) * Math.max(0, durationSeconds)) / 8);
}
