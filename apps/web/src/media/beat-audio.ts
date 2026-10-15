import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { createAudioContext } from "@/media/audio";
import type { MediaAsset } from "@/media/types";
import { isAbortError } from "@/services/beat-detection/abort";
import type { AudioElement, VideoElement } from "@/timeline";

export const BEAT_ANALYSIS_SAMPLE_RATE = 22050;
export const BEAT_MAX_DURATION_SECONDS = 30 * 60;
export const BEAT_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const BEAT_MAX_LIBRARY_BYTES = 100 * 1024 * 1024;
/** Mono samples kept in memory: 30 min at the analysis rate is about 160 MB. */
const BEAT_MAX_DECODED_BYTES = 200 * 1024 * 1024;

/**
 * A stem (drums, bass...) of a clip's audio is the same length as that audio and
 * starts at the same moment; an mp3 decoder may add or drop a few tens of
 * milliseconds at either end, a longer difference means a different file.
 */
export const STEM_DURATION_TOLERANCE_SECONDS = 0.15;

export type BeatAudioResult =
	/** `offsetSeconds`: where in the source the samples start (0 when absent). */
	| { ok: true; samples: Float32Array; sampleRate: number; offsetSeconds?: number }
	| { ok: false; reason: "too-long" | "too-large" | "unreadable" };

/** What a stem check can add to a decode failure. */
export type StemAudioResult =
	| BeatAudioResult
	| { ok: false; reason: "stem-mismatch" };

type MonoSourceChunk = Pick<
	AudioBuffer,
	"numberOfChannels" | "length" | "sampleRate" | "getChannelData"
>;

export function mixToMono({
	buffer,
}: {
	buffer: Pick<AudioBuffer, "numberOfChannels" | "length" | "getChannelData">;
}): Float32Array {
	const mono = new Float32Array(buffer.length);
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < mono.length; i++) {
			const value = data[i];
			// One NaN would poison every later result of the analysis.
			mono[i] += Number.isFinite(value) ? value : 0;
		}
	}
	const scale = 1 / buffer.numberOfChannels;
	for (let i = 0; i < mono.length; i++) mono[i] *= scale;
	return mono;
}

/**
 * Streaming box-filter (area average) decimation by a ratio >= 1, so a long
 * file can be brought down to the analysis rate chunk by chunk.
 */
export function createDecimator({
	ratio,
}: {
	ratio: number;
}): (chunk: Float32Array) => Float32Array {
	let accumulated = 0;
	let filled = 0;
	return (chunk) => {
		const out = new Float32Array(Math.ceil((chunk.length + filled) / ratio) + 2);
		let count = 0;
		for (let i = 0; i < chunk.length; i++) {
			const value = chunk[i];
			let weight = 1;
			while (weight > 0) {
				const room = ratio - filled;
				if (weight < room) {
					accumulated += value * weight;
					filled += weight;
					weight = 0;
				} else {
					accumulated += value * room;
					out[count++] = accumulated / ratio;
					weight -= room;
					accumulated = 0;
					filled = 0;
				}
			}
		}
		return out.subarray(0, count);
	};
}

/**
 * Drains decoded audio into one mono array at the analysis rate, holding
 * neither all channels nor the native rate, and stops reading the source the
 * moment the duration or memory budget is exceeded.
 */
export async function collectMono({
	chunks,
	maxSeconds,
	maxBytes,
	signal,
}: {
	chunks: AsyncIterable<MonoSourceChunk>;
	maxSeconds: number;
	maxBytes: number;
	signal?: AbortSignal;
}): Promise<
	{ ok: true; samples: Float32Array; sampleRate: number } | { ok: false; reason: "too-long" }
> {
	const parts: Float32Array[] = [];
	let sampleRate = 0;
	let decimate: ((chunk: Float32Array) => Float32Array) | null = null;
	let seconds = 0;
	let total = 0;

	for await (const chunk of chunks) {
		signal?.throwIfAborted();
		if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0) {
			throw new Error(`Invalid sample rate: ${chunk.sampleRate}`);
		}
		if (sampleRate === 0) {
			if (chunk.sampleRate > BEAT_ANALYSIS_SAMPLE_RATE) {
				sampleRate = BEAT_ANALYSIS_SAMPLE_RATE;
				decimate = createDecimator({
					ratio: chunk.sampleRate / BEAT_ANALYSIS_SAMPLE_RATE,
				});
			} else {
				sampleRate = chunk.sampleRate;
			}
		}

		seconds += chunk.length / chunk.sampleRate;
		if (seconds > maxSeconds) {
			return { ok: false, reason: "too-long" };
		}
		const mono = mixToMono({ buffer: chunk });
		const part = decimate ? decimate(mono) : mono;
		total += part.length;
		if (total * Float32Array.BYTES_PER_ELEMENT > maxBytes) {
			return { ok: false, reason: "too-long" };
		}
		parts.push(part);
	}

	const samples = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		samples.set(part, offset);
		offset += part.length;
	}
	return { ok: true, samples, sampleRate: sampleRate || BEAT_ANALYSIS_SAMPLE_RATE };
}

/**
 * Decodes the whole source media of a clip (beats are stored in source time,
 * so trimming is ignored) to mono at the analysis rate. Every input is bounded
 * before or while it is read: declared duration, file size, download size,
 * and the decoded length. Rejects with an `AbortError` when `signal` aborts.
 */
export async function decodeElementForBeats({
	element,
	mediaAsset,
	signal,
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
	signal?: AbortSignal;
}): Promise<BeatAudioResult> {
	signal?.throwIfAborted();

	// File-declared, so only an early out: the caps below are what protect us.
	const declared = mediaAsset?.duration;
	if (declared !== undefined) {
		if (!Number.isFinite(declared) || declared <= 0) {
			return { ok: false, reason: "unreadable" };
		}
		if (declared > BEAT_MAX_DURATION_SECONDS) {
			return { ok: false, reason: "too-long" };
		}
	}

	try {
		const result = await decodeSource({ element, mediaAsset, signal });
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		if (isAbortError(error)) throw error;
		console.warn("Failed to decode audio for beat detection:", error);
		return { ok: false, reason: "unreadable" };
	}
}

/**
 * The length of an audio file in seconds, from its container, without decoding it (a decode
 * of a very long file is what the caps must stop). Null when the file cannot be read.
 */
export async function probeAudioFileSeconds({ file }: { file: File }): Promise<number | null> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const seconds = await input.computeDuration();
		return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
	} catch (error) {
		console.warn("Failed to read the length of an audio file:", error);
		return null;
	} finally {
		input.dispose();
	}
}

export function stemMatchesSource({
	stemSeconds,
	sourceSeconds,
}: {
	stemSeconds: number;
	sourceSeconds: number;
}): boolean {
	return (
		Number.isFinite(stemSeconds) &&
		Number.isFinite(sourceSeconds) &&
		Math.abs(stemSeconds - sourceSeconds) <= STEM_DURATION_TOLERANCE_SECONDS
	);
}

/**
 * Decodes an audio file the user picked (a stem of a clip's audio) to mono at
 * the analysis rate, under the same size, duration and memory caps as a clip.
 * The caller checks that it belongs to the clip (`stemMatchesSource`).
 */
export async function decodeStemFileForBeats({
	file,
	signal,
}: {
	file: File;
	signal?: AbortSignal;
}): Promise<BeatAudioResult> {
	signal?.throwIfAborted();
	if (file.size > BEAT_MAX_FILE_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	try {
		const bytes = await file.arrayBuffer();
		signal?.throwIfAborted();
		const result = await monoFromBuffer({ buffer: await decodeBytes({ bytes }), signal });
		signal?.throwIfAborted();
		return result;
	} catch (error) {
		if (isAbortError(error)) throw error;
		console.warn("Failed to decode the stem file for beat detection:", error);
		return { ok: false, reason: "unreadable" };
	}
}

async function decodeSource({
	element,
	mediaAsset,
	signal,
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
	signal?: AbortSignal;
}): Promise<BeatAudioResult> {
	if (element.type === "audio" && element.sourceType === "library") {
		if (element.buffer) {
			return monoFromBuffer({ buffer: element.buffer, signal });
		}
		const download = await fetchLibraryBytes({ url: element.sourceUrl, signal });
		if (!download.ok) {
			return download;
		}
		return monoFromBuffer({ buffer: await decodeBytes({ bytes: download.bytes }), signal });
	}

	if (!mediaAsset) {
		return { ok: false, reason: "unreadable" };
	}
	if (mediaAsset.type === "audio") {
		if (mediaAsset.file.size > BEAT_MAX_FILE_BYTES) {
			return { ok: false, reason: "too-large" };
		}
		const bytes = await mediaAsset.file.arrayBuffer();
		return monoFromBuffer({ buffer: await decodeBytes({ bytes }), signal });
	}
	return decodeMediaStream({ file: mediaAsset.file, signal });
}

async function* singleChunk(buffer: MonoSourceChunk) {
	yield buffer;
}

async function monoFromBuffer({
	buffer,
	signal,
}: {
	buffer: MonoSourceChunk;
	signal?: AbortSignal;
}): Promise<BeatAudioResult> {
	return collectMono({
		chunks: singleChunk(buffer),
		maxSeconds: BEAT_MAX_DURATION_SECONDS,
		maxBytes: BEAT_MAX_DECODED_BYTES,
		signal,
	});
}

export async function decodeBytes({
	bytes,
	sampleRate = BEAT_ANALYSIS_SAMPLE_RATE,
}: {
	bytes: ArrayBuffer;
	sampleRate?: number;
}): Promise<AudioBuffer> {
	const audioContext = createAudioContext({ sampleRate });
	try {
		return await audioContext.decodeAudioData(bytes);
	} finally {
		void audioContext.close();
	}
}

/** Video (and any container mediabunny reads): streamed, never fully buffered. */
async function decodeMediaStream({
	file,
	signal,
}: {
	file: File;
	signal?: AbortSignal;
}): Promise<BeatAudioResult> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			return { ok: false, reason: "unreadable" };
		}
		const sink = new AudioBufferSink(audioTrack);
		async function* buffers() {
			// One second past the cap is enough to know the track is too long.
			for await (const { buffer } of sink.buffers(0, BEAT_MAX_DURATION_SECONDS + 1)) {
				yield buffer;
			}
		}
		return await collectMono({
			chunks: buffers(),
			maxSeconds: BEAT_MAX_DURATION_SECONDS,
			maxBytes: BEAT_MAX_DECODED_BYTES,
			signal,
		});
	} finally {
		input.dispose();
	}
}

export async function fetchLibraryBytes({
	url,
	signal,
}: {
	url: string;
	signal?: AbortSignal;
}): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; reason: "too-large" }> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") {
		throw new Error(`Library audio must be served over https: ${parsed.protocol}`);
	}
	const response = await fetch(parsed, { signal });
	if (!response.ok) {
		throw new Error(`Library audio fetch failed: ${response.status}`);
	}
	if (Number(response.headers.get("content-length")) > BEAT_MAX_LIBRARY_BYTES) {
		await response.body?.cancel();
		return { ok: false, reason: "too-large" };
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error("Library audio response has no body");
	}
	const pieces: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > BEAT_MAX_LIBRARY_BYTES) {
			await reader.cancel();
			return { ok: false, reason: "too-large" };
		}
		pieces.push(value);
	}

	const bytes = new Uint8Array(received);
	let offset = 0;
	for (const piece of pieces) {
		bytes.set(piece, offset);
		offset += piece.byteLength;
	}
	return { ok: true, bytes: bytes.buffer };
}
