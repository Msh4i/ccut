/**
 * The wasm AAC encoder (FFmpeg's `aac`) has an encoder delay of one AAC frame:
 * its first output frame stands for the 1024 samples *before* the first input
 * sample. mediabunny writes no edit list (`elst`) into the MP4, so a decoder
 * plays those 1024 samples as leading audio and everything arrives 23.2 ms late
 * at 44.1 kHz (export-v2 M5: measured 2.0232 s for an event at 2.0000 s).
 *
 * The fix is to start encoding at sample 1024 of the mix (the first slice's
 * start offset, see `addAudioInSlices`): the decoder's priming then fills the
 * gap and input sample `n` comes out at output sample `n` again. The first 1024
 * samples (23.2 ms) are not in the file.
 *
 * Length: the encoder pads the last frame and flushes one more, so the audio
 * track is `ceil(N / 1024) * 1024` samples long for a mix of `N` samples. That
 * is 0 to 23.2 ms longer than the video; without the offset it ran 1024 samples
 * (23.2 ms) longer still.
 */
export const AAC_PRIMING_SAMPLES = 1024;

/**
 * Longest stretch of audio handed to the encoder in one call. The audio goes in
 * between the video frames, never more than this far ahead of them, so the file
 * alternates audio and video in runs of at most about this length (export-v2 A3/M4:
 * all audio first, then all video, was bad for progressive playback and upload).
 * It is also the latency of cancelling while audio is encoded.
 */
export const AUDIO_SLICE_SECONDS = 1;

/** Samples in one AAC frame (AAC-LC). */
const AAC_FRAME_SAMPLES = 1024;

/**
 * Upper bound of the AAC packets an encoder makes from `samples` input samples,
 * for the MP4 `fastStart: "reserve"` moov space (mediabunny fails at the end if
 * a track has more packets than declared, export-v2 R3): every started frame,
 * one flushed frame for the priming, and 8 spare.
 */
export function aacMaxPacketCount({ samples }: { samples: number }): number {
	if (!Number.isSafeInteger(samples) || samples < 0) {
		throw new RangeError(`samples must be a non-negative integer, got ${samples}`);
	}
	return Math.ceil((samples + AAC_FRAME_SAMPLES) / AAC_FRAME_SAMPLES) + 8;
}

export type SampleRange = { startSample: number; endSample: number };

function assertSampleRange({ startSample, endSample }: SampleRange): void {
	if (!Number.isInteger(startSample) || !Number.isInteger(endSample) || startSample < 0) {
		throw new RangeError(
			`sample range must be non-negative integers, got [${startSample}, ${endSample})`,
		);
	}
}

/**
 * Splits `[startSample, endSample)` into consecutive slices of at most
 * `maxSliceSeconds` each: no gaps, no overlaps, none empty. An empty or
 * inverted range has no slices.
 */
export function planAudioSlices({
	startSample,
	endSample,
	sampleRate,
	maxSliceSeconds,
}: SampleRange & { sampleRate: number; maxSliceSeconds: number }): SampleRange[] {
	assertSampleRange({ startSample, endSample });
	const sliceSamples = Math.floor(maxSliceSeconds * sampleRate);
	if (!(sliceSamples >= 1)) {
		throw new RangeError(
			`a slice must hold at least one sample, got ${maxSliceSeconds} s at ${sampleRate} Hz`,
		);
	}

	const slices: SampleRange[] = [];
	for (let start = startSample; start < endSample; start += sliceSamples) {
		slices.push({ startSample: start, endSample: Math.min(start + sliceSamples, endSample) });
	}
	return slices;
}

/**
 * A new buffer holding samples `[startSample, endSample)` of every channel of
 * `buffer`. The input is not modified. `createBuffer` defaults to the
 * `AudioBuffer` constructor and exists so tests can run without Web Audio.
 */
export function sliceBuffer({
	buffer,
	startSample,
	endSample,
	createBuffer = (init) => new AudioBuffer(init),
}: SampleRange & {
	buffer: AudioBuffer;
	createBuffer?: (init: AudioBufferOptions) => AudioBuffer;
}): AudioBuffer {
	assertSampleRange({ startSample, endSample });
	if (endSample <= startSample || endSample > buffer.length) {
		throw new RangeError(
			`slice [${startSample}, ${endSample}) is empty or outside a buffer of ${buffer.length} samples`,
		);
	}

	const slice = createBuffer({
		length: endSample - startSample,
		numberOfChannels: buffer.numberOfChannels,
		sampleRate: buffer.sampleRate,
	});
	for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
		slice.copyToChannel(buffer.getChannelData(channel).subarray(startSample, endSample), channel);
	}
	return slice;
}
