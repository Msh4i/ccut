import type { ExportFormat, ExportQuality } from "./index";

export type AudioCodecChoice = "aac" | "opus";

/**
 * The only audio codec an MP4 may get is AAC, and WebM gets Opus. `null`
 * means "no audio for this container": an MP4 whose AAC encoder is not
 * available. It is never `"opus"` for an MP4: Opus in MP4 is the bug this
 * replaces (export-v2 A2/M3: many players, TVs and uploaders reject it).
 * Callers must surface `null` to the user, not drop the audio quietly.
 */
export function selectAudioCodec({
	container,
	aacAvailable,
}: {
	container: ExportFormat;
	aacAvailable: boolean;
}): AudioCodecChoice | null {
	if (container === "webm") {
		return "opus";
	}
	return aacAvailable ? "aac" : null;
}

/**
 * The AAC bitrates mediabunny's quality mapping can produce
 * (`Quality._toAudioBitrate`, `encode.ts`): it snaps to the nearest of these.
 */
export const AAC_VALID_BITRATES: readonly number[] = [96_000, 128_000, 160_000, 192_000];

// Same numbers mediabunny 1.41.0 derives from QUALITY_LOW/MEDIUM/HIGH/VERY_HIGH
// (a test compares them against its mapping, so an upgrade cannot change them
// silently). Written out so the AAC values are visibly inside AAC_VALID_BITRATES.
const AUDIO_BITRATES: Record<AudioCodecChoice, Record<ExportQuality, number>> = {
	aac: { low: 96_000, medium: 128_000, high: 192_000, very_high: 192_000 },
	opus: { low: 38_000, medium: 64_000, high: 128_000, very_high: 256_000 },
};

export function audioBitrateFor({
	codec,
	quality,
}: {
	codec: AudioCodecChoice;
	quality: ExportQuality;
}): number {
	return AUDIO_BITRATES[codec][quality];
}
