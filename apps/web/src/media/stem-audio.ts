import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import {
	BEAT_MAX_FILE_BYTES,
	decodeBytes,
	fetchLibraryBytes,
} from "@/media/beat-audio";
import type { MediaAsset } from "@/media/types";
import { isAbortError } from "@/services/beat-detection/abort";
import { SEPARATION_SAMPLE_RATES, STEM_MAX_SECONDS } from "@/services/stems/types";
import type { AudioElement, VideoElement } from "@/timeline";

/** Decoded audio ready for the separator: interleaved stereo, 16-bit, at the clip's own rate. */
export type SeparationAudioResult =
	| { ok: true; samples: Int16Array; sampleRate: number; frames: number }
	| { ok: false; reason: "too-long" | "too-large" | "unreadable" };

type StereoChunk = Pick<AudioBuffer, "numberOfChannels" | "length" | "sampleRate" | "getChannelData">;

const DECODE_RATE = 44100;

function toInt16(value: number): number {
	// One NaN would poison the whole separation.
	if (!Number.isFinite(value)) return 0;
	return Math.round(Math.max(-1, Math.min(1, value)) * 32767);
}

/**
 * Drains decoded audio into one interleaved stereo Int16 array. A mono source is doubled, a
 * source with more than two channels keeps its first two. Stops reading the moment the length
 * cap is passed. A rate the separator does not take, or a rate that changes, is unreadable.
 */
export async function collectStereoInt16({
	chunks,
	maxSeconds,
	signal,
}: {
	chunks: AsyncIterable<StereoChunk>;
	maxSeconds: number;
	signal?: AbortSignal;
}): Promise<SeparationAudioResult> {
	const parts: Int16Array[] = [];
	let sampleRate = 0;
	let frames = 0;
	for await (const chunk of chunks) {
		signal?.throwIfAborted();
		if (!SEPARATION_SAMPLE_RATES.some((rate) => rate === chunk.sampleRate)) {
			return { ok: false, reason: "unreadable" };
		}
		if (sampleRate === 0) sampleRate = chunk.sampleRate;
		if (chunk.sampleRate !== sampleRate || chunk.numberOfChannels < 1) {
			return { ok: false, reason: "unreadable" };
		}
		frames += chunk.length;
		if (frames / sampleRate > maxSeconds) {
			return { ok: false, reason: "too-long" };
		}
		const left = chunk.getChannelData(0);
		const right = chunk.numberOfChannels > 1 ? chunk.getChannelData(1) : left;
		const part = new Int16Array(chunk.length * 2);
		for (let i = 0; i < chunk.length; i++) {
			part[2 * i] = toInt16(left[i]);
			part[2 * i + 1] = toInt16(right[i]);
		}
		parts.push(part);
	}
	if (frames === 0) {
		return { ok: false, reason: "unreadable" };
	}
	// One chunk (a whole decoded file) is already the array: no second copy of it.
	if (parts.length === 1) {
		return { ok: true, samples: parts[0], sampleRate, frames };
	}
	const samples = new Int16Array(frames * 2);
	let offset = 0;
	for (const part of parts) {
		samples.set(part, offset);
		offset += part.length;
	}
	return { ok: true, samples, sampleRate, frames };
}

async function* single(chunk: StereoChunk) {
	yield chunk;
}

/**
 * Decodes the whole source media of a clip for separation (stems, like beats, are in source
 * time, so trimming is ignored). Bounded like the beat decode: declared duration, file size,
 * decoded length. Rejects with an `AbortError` when `signal` aborts.
 */
export async function decodeElementForSeparation({
	element,
	mediaAsset,
	signal,
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
	signal?: AbortSignal;
}): Promise<SeparationAudioResult> {
	signal?.throwIfAborted();
	const declared = mediaAsset?.duration;
	if (declared !== undefined) {
		if (!Number.isFinite(declared) || declared <= 0) {
			return { ok: false, reason: "unreadable" };
		}
		if (declared > STEM_MAX_SECONDS) {
			return { ok: false, reason: "too-long" };
		}
	}
	try {
		const result = await decode({ element, mediaAsset, signal });
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		if (isAbortError(error)) throw error;
		console.warn("Failed to decode audio for stem separation:", error);
		return { ok: false, reason: "unreadable" };
	}
}

async function decode({
	element,
	mediaAsset,
	signal,
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
	signal?: AbortSignal;
}): Promise<SeparationAudioResult> {
	const fromBuffer = (buffer: StereoChunk) =>
		collectStereoInt16({ chunks: single(buffer), maxSeconds: STEM_MAX_SECONDS, signal });

	if (element.type === "audio" && element.sourceType === "library") {
		if (element.buffer) return fromBuffer(element.buffer);
		const download = await fetchLibraryBytes({ url: element.sourceUrl, signal });
		if (!download.ok) return download;
		return fromBuffer(await decodeBytes({ bytes: download.bytes, sampleRate: DECODE_RATE }));
	}
	if (!mediaAsset) {
		return { ok: false, reason: "unreadable" };
	}
	if (mediaAsset.type === "audio") {
		if (mediaAsset.file.size > BEAT_MAX_FILE_BYTES) {
			return { ok: false, reason: "too-large" };
		}
		const bytes = await mediaAsset.file.arrayBuffer();
		return fromBuffer(await decodeBytes({ bytes, sampleRate: DECODE_RATE }));
	}

	const input = new Input({ source: new BlobSource(mediaAsset.file), formats: ALL_FORMATS });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return { ok: false, reason: "unreadable" };
		const sink = new AudioBufferSink(audioTrack);
		async function* buffers() {
			// One second past the cap is enough to know the track is too long.
			for await (const { buffer } of sink.buffers(0, STEM_MAX_SECONDS + 1)) {
				yield buffer;
			}
		}
		return await collectStereoInt16({ chunks: buffers(), maxSeconds: STEM_MAX_SECONDS, signal });
	} finally {
		input.dispose();
	}
}
