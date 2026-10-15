import type { ExportFormat, ExportQuality } from "@/export";
import {
	audioBitrateFor,
	selectAudioCodec,
	type AudioCodecChoice,
} from "@/export/audio-codec";
import {
	AAC_PRIMING_SAMPLES,
	AUDIO_SLICE_SECONDS,
	planAudioSlices,
	sliceBuffer,
} from "@/export/audio-slices";
import {
	createAacUnavailableError,
	createAudioTooShortError,
	createAudioUnreadableError,
	isExportError,
	type UnreadableAudio,
} from "@/export/errors";
import { ensureAacEncoder, type AacEncoderParams } from "./aac-encoder";

export type AudioTrackPlan = {
	codec: AudioCodecChoice;
	bitrate: number;
	/** The whole mix, as mixed. It is never copied as a whole: `addAudioInSlices` copies one slice at a time. */
	buffer: AudioBuffer;
	/** First sample to encode: the AAC priming offset for AAC, 0 for Opus. */
	startSample: number;
};

/**
 * Starts the AAC encoder, or throws `ExportError` `AAC_UNAVAILABLE`. An error
 * that is not already one is wrapped, with the original as its `cause`.
 */
async function startAacOrThrow({
	ensureAac,
	params,
}: {
	ensureAac: (params: AacEncoderParams) => Promise<void>;
	params: AacEncoderParams;
}): Promise<void> {
	try {
		await ensureAac(params);
	} catch (error) {
		throw isExportError(error)
			? error
			: createAacUnavailableError({ stage: "starting the encoder", cause: error });
	}
}

/**
 * Decides how the mixed audio goes into the file, before the `Output` exists.
 *
 * - MP4: AAC through the wasm encoder, started (and trial-encoded) here. If it
 *   cannot start this throws `ExportError` `AAC_UNAVAILABLE`: the export stops
 *   with a message, it neither falls back to Opus (which an MP4 must never get)
 *   nor quietly writes a file without the audio the user asked for. Encoding
 *   starts at sample `AAC_PRIMING_SAMPLES`, so a mix that is not longer than
 *   that has nothing to encode and throws `AUDIO_TOO_SHORT`.
 * - WebM: Opus from sample 0. The AAC encoder is not loaded.
 */
export async function prepareAudioTrack({
	format,
	quality,
	audioBuffer,
	ensureAac = ensureAacEncoder,
}: {
	format: ExportFormat;
	quality: ExportQuality;
	audioBuffer: AudioBuffer;
	ensureAac?: (params: AacEncoderParams) => Promise<void>;
}): Promise<AudioTrackPlan> {
	let aacAvailable = false;
	let aacFailure: unknown;
	if (format === "mp4") {
		try {
			await startAacOrThrow({
				ensureAac,
				params: {
					sampleRate: audioBuffer.sampleRate,
					numberOfChannels: audioBuffer.numberOfChannels,
					bitrate: audioBitrateFor({ codec: "aac", quality }),
				},
			});
			aacAvailable = true;
		} catch (error) {
			aacFailure = error;
		}
	}

	const codec = selectAudioCodec({ container: format, aacAvailable });
	if (codec === null) {
		throw aacFailure;
	}

	const startSample = codec === "aac" ? AAC_PRIMING_SAMPLES : 0;
	if (startSample >= audioBuffer.length) {
		throw createAudioTooShortError({
			samples: audioBuffer.length,
			sampleRate: audioBuffer.sampleRate,
		});
	}
	return { codec, bitrate: audioBitrateFor({ codec, quality }), buffer: audioBuffer, startSample };
}

/**
 * Starts the AAC encoder before the audio is mixed, so that an encoder that
 * cannot start stops the export at once and not after minutes of mixing. Does
 * nothing when the encoder would not be used (WebM, audio off, no audible
 * audio). `prepareAudioTrack` still checks again when the audio is encoded.
 */
export async function preflightAudio({
	format,
	quality,
	includeAudio,
	hasAudio,
	sampleRate,
	numberOfChannels,
	ensureAac = ensureAacEncoder,
}: {
	format: ExportFormat;
	quality: ExportQuality;
	includeAudio: boolean;
	hasAudio: boolean;
	sampleRate: number;
	numberOfChannels: number;
	ensureAac?: (params: AacEncoderParams) => Promise<void>;
}): Promise<void> {
	if (!includeAudio || !hasAudio || format !== "mp4") {
		return;
	}
	await startAacOrThrow({
		ensureAac,
		params: { sampleRate, numberOfChannels, bitrate: audioBitrateFor({ codec: "aac", quality }) },
	});
}

/**
 * The export stops, with `AUDIO_UNREADABLE`, when audio the user asked for
 * could not be read: any clip that was skipped, or an audible timeline that
 * produced no mix at all. Writing the file anyway would leave those clips
 * silent without a word.
 */
export function assertAudioReadable({
	mix,
	hasAudio,
}: {
	mix: { buffer: AudioBuffer | null; skipped: readonly UnreadableAudio[] };
	hasAudio: boolean;
}): void {
	if (mix.skipped.length > 0 || (hasAudio && !mix.buffer)) {
		throw createAudioUnreadableError({ skipped: mix.skipped });
	}
}

export type AudioFeeder = {
	/**
	 * Adds the slices that start before `seconds` of the output (0 = the first
	 * sample encoded), in order, each once. `"cancelled"` as soon as `isCancelled`
	 * is true before a slice; nothing more is added then.
	 */
	feedUntil: (args: { seconds: number }) => Promise<"done" | "cancelled">;
	/** Adds everything that is left. */
	feedRest: () => Promise<"done" | "cancelled">;
};

/**
 * Feeds `buffer` from `startSample` to `source` in consecutive slices of at most
 * `sliceSeconds`, as the video catches up: the export calls `feedUntil` before
 * each frame, so audio and video reach the muxer interleaved (no run longer than
 * about a slice) and only one slice is ever copied. Slices touch, so the encoder
 * hears one stream. An error from `source.add` is not caught.
 */
export function createAudioFeeder({
	source,
	buffer,
	startSample,
	isCancelled,
	sliceSeconds = AUDIO_SLICE_SECONDS,
	createBuffer,
}: {
	source: { add: (buffer: AudioBuffer) => Promise<void> };
	buffer: AudioBuffer;
	startSample: number;
	isCancelled: () => boolean;
	sliceSeconds?: number;
	createBuffer?: (init: AudioBufferOptions) => AudioBuffer;
}): AudioFeeder {
	const slices = planAudioSlices({
		startSample,
		endSample: buffer.length,
		sampleRate: buffer.sampleRate,
		maxSliceSeconds: sliceSeconds,
	});
	let next = 0;

	const feedUntil = async ({ seconds }: { seconds: number }): Promise<"done" | "cancelled"> => {
		for (; next < slices.length; next++) {
			const { startSample: sliceStart, endSample: sliceEnd } = slices[next];
			if ((sliceStart - startSample) / buffer.sampleRate >= seconds) {
				return "done";
			}
			if (isCancelled()) {
				return "cancelled";
			}
			await source.add(sliceBuffer({ buffer, startSample: sliceStart, endSample: sliceEnd, createBuffer }));
		}
		return "done";
	};

	return { feedUntil, feedRest: () => feedUntil({ seconds: Number.POSITIVE_INFINITY }) };
}
