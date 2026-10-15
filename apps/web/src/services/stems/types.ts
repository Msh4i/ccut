/** The four sources the separator (htdemucs) makes. Each one can be a marker source. */
export const STEM_NAMES = ["drums", "bass", "vocals", "other"] as const;
export type StemName = (typeof STEM_NAMES)[number];

export const STEM_LABELS: Record<StemName, string> = {
	drums: "Drums",
	bass: "Bass",
	vocals: "Vocals",
	other: "Other",
};

/** Part of every cache key: a stem made by another model is another stem. */
export const STEM_MODEL_ID = "htdemucs";
/** Stems are kept and analysed as mono at this rate, 16-bit. */
export const STEM_SAMPLE_RATE = 22050;
/** Longer audio is refused before anything is decoded or sent (CPU time grows with it). */
export const STEM_MAX_SECONDS = 15 * 60;
/** The rates the desktop bridge accepts; the separator resamples to 44.1 kHz itself. */
export const SEPARATION_SAMPLE_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000] as const;
/** At most this many bytes of PCM or stem per bridge call. */
export const STEM_CHUNK_BYTES = 8 * 1024 * 1024;

export type StemInstallCode =
	| "unsupported"
	| "pins-missing"
	| "consent-declined"
	| "busy"
	| "download-failed"
	| "verify-failed"
	| "install-failed"
	| "no-disk-space"
	| "bridge-failed";

export type StemBeginCode = "invalid" | "too-long" | "busy" | "engine-missing" | "bridge-failed";
export type StemJobCode = "engine-failed" | "timeout" | "invalid-output" | "out-of-memory";

export type StemsStatus = {
	supported: boolean;
	engine: "missing" | "installing" | "ready" | "broken";
	installSizeBytes: number | null;
	installPercent: number | null;
	modelId: string;
};

export type StemJobStatus =
	| { state: "receiving"; percent: number }
	| { state: "running"; percent: number }
	| { state: "done"; percent: number; samples: number }
	| { state: "failed"; percent: number; code: StemJobCode }
	| { state: "cancelled"; percent: number };

/** One stem, mono at `STEM_SAMPLE_RATE`. */
export type StemSamples = Int16Array;
export type StemSet = Record<StemName, StemSamples>;
