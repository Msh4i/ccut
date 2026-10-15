import type { AudioCodecChoice } from "./audio-codec";
import { AVC_MAX_BITRATE } from "./avc-level";
import type { ExportQuality } from "./index";

/**
 * Every number here is a starting value from the export-v2 plan (P3) that
 * must be measured on real encodes before it is trusted: the bits-per-pixel
 * table and fps exponent by SSIM on test content, the VP9 factor the same
 * way, the container overhead and the size-estimate error band against real
 * files (plan S4: "tahmini boyut gerçekle +/-%25"). Until then `status` stays
 * "UNCALIBRATED" and the UI must present sizes as estimates.
 */
export const CALIBRATION = Object.freeze({
	status: "UNCALIBRATED" as "UNCALIBRATED" | "CALIBRATED",
	/** H.264 bits per pixel per frame at the reference fps. */
	bppByQuality: Object.freeze({
		low: 0.06,
		medium: 0.09,
		high: 0.13,
		very_high: 0.2,
	}) satisfies Readonly<Record<ExportQuality, number>>,
	referenceFps: 30,
	/** bitrate scales with (fps / referenceFps) ^ fpsExponent. */
	fpsExponent: 0.75,
	/** VP9 needs fewer bits for the same quality than H.264. */
	vp9Factor: 0.6,
	/** Bytes the container adds on top of the elementary streams, as a fraction. */
	containerOverheadFraction: 0,
	/** Half-width of the size estimate band, as a fraction of the estimate. */
	sizeEstimateErrorFraction: 0.25,
});

export type VideoCodecChoice = "avc" | "vp9";

export type QualityChoice =
	| { kind: "preset"; quality: ExportQuality }
	| { kind: "custom"; mbps: number };

/** Custom bitrate field bounds in Mb/s; the top is H.264 level 5.2 High. */
export const CUSTOM_MBPS_LIMITS = Object.freeze({
	min: 0.5,
	max: AVC_MAX_BITRATE / 1_000_000,
});

export const AUDIO_BITRATE_CHOICES: Readonly<Record<AudioCodecChoice, readonly number[]>> = Object.freeze({
	aac: Object.freeze([128_000, 192_000, 256_000, 320_000]),
	opus: Object.freeze([96_000, 128_000, 160_000]),
});

const DEFAULT_AUDIO_BITRATE: Readonly<Record<AudioCodecChoice, number>> = Object.freeze({
	aac: 192_000,
	opus: 128_000,
});

export function defaultAudioBitrate({ codec }: { codec: AudioCodecChoice }): number {
	return DEFAULT_AUDIO_BITRATE[codec];
}

function assertPositive({ name, value }: { name: string; value: number }): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive number, got ${value}`);
	}
}

/** Video bitrate in bit/s (whole number). Custom values are not clamped: validate them first. */
export function computeVideoBitrate({
	width,
	height,
	fps,
	quality,
	codec,
}: {
	width: number;
	height: number;
	fps: number;
	quality: QualityChoice;
	codec: VideoCodecChoice;
}): number {
	assertPositive({ name: "width", value: width });
	assertPositive({ name: "height", value: height });
	assertPositive({ name: "fps", value: fps });
	if (quality.kind === "custom") {
		assertPositive({ name: "custom Mb/s", value: quality.mbps });
		return Math.round(quality.mbps * 1_000_000);
	}
	const bpp = CALIBRATION.bppByQuality[quality.quality];
	const fpsScale = (fps / CALIBRATION.referenceFps) ** CALIBRATION.fpsExponent;
	const codecFactor = codec === "vp9" ? CALIBRATION.vp9Factor : 1;
	return Math.round(width * height * CALIBRATION.referenceFps * bpp * fpsScale * codecFactor);
}

export interface FileSizeEstimate {
	bytes: number;
	/** Lower and upper end of the (uncalibrated) error band. */
	low: number;
	high: number;
}

export function estimateFileBytes({
	videoBitrate,
	audioBitrate,
	durationSeconds,
}: {
	videoBitrate: number;
	audioBitrate: number | null;
	durationSeconds: number;
}): FileSizeEstimate {
	for (const [name, value] of [
		["videoBitrate", videoBitrate],
		["audioBitrate", audioBitrate ?? 0],
		["durationSeconds", durationSeconds],
	] as const) {
		if (!Number.isFinite(value) || value < 0) {
			throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
		}
	}
	const raw = (((videoBitrate + (audioBitrate ?? 0)) * durationSeconds) / 8) * (1 + CALIBRATION.containerOverheadFraction);
	return {
		bytes: Math.round(raw),
		low: Math.round(raw * (1 - CALIBRATION.sizeEstimateErrorFraction)),
		high: Math.round(raw * (1 + CALIBRATION.sizeEstimateErrorFraction)),
	};
}
