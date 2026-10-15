import { describe, expect, test } from "bun:test";
import { EXPORT_QUALITY_VALUES } from "@/export";
import { AAC_VALID_BITRATES } from "@/export/audio-codec";
import { AAC_PRIMING_SAMPLES, AUDIO_SLICE_SECONDS } from "@/export/audio-slices";
import {
	createAacUnavailableError,
	isExportError,
} from "@/export/errors";
import {
	FakeAudioBuffer,
	createFilledBuffer,
} from "@/export/__tests__/fake-audio-buffer";
import type { AacEncoderParams } from "../aac-encoder";
import {
	assertAudioReadable,
	createAudioFeeder,
	preflightAudio,
	prepareAudioTrack,
} from "../audio-track";

function createBuffer(init: AudioBufferOptions): AudioBuffer {
	return new FakeAudioBuffer(init);
}

function createMix({ length = 44100, numberOfChannels = 2, sampleRate = 44100 } = {}) {
	return createFilledBuffer({
		length,
		numberOfChannels,
		sampleRate,
		value: ({ channel, frame }) => Math.fround(frame * 0.5 + channel * 100_000),
	});
}

function createEnsure() {
	const calls: AacEncoderParams[] = [];
	const ensureAac = async (params: AacEncoderParams) => {
		calls.push(params);
	};
	return { ensureAac, calls };
}

async function rejection({ promise }: { promise: Promise<unknown> }): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

describe("prepareAudioTrack, MP4", () => {
	test("is AAC, asks the encoder gate for exactly the mix's rate, channels and AAC bitrate, and starts at sample 1024 of the untouched mix", async () => {
		const { ensureAac, calls } = createEnsure();
		const mix = createMix({ length: 5000, sampleRate: 48000, numberOfChannels: 1 });

		const plan = await prepareAudioTrack({ format: "mp4", quality: "high", audioBuffer: mix, ensureAac });

		expect(calls).toEqual([{ sampleRate: 48000, numberOfChannels: 1, bitrate: 192_000 }]);
		expect(plan.codec).toBe("aac");
		expect(plan.bitrate).toBe(192_000);
		expect(plan.startSample).toBe(AAC_PRIMING_SAMPLES);
		expect(plan.buffer).toBe(mix);
	});

	test("every quality gives a bitrate AAC accepts, and never anything but AAC", async () => {
		for (const quality of EXPORT_QUALITY_VALUES) {
			const { ensureAac } = createEnsure();
			const plan = await prepareAudioTrack({ format: "mp4", quality, audioBuffer: createMix(), ensureAac });
			expect(plan.codec).toBe("aac");
			expect(AAC_VALID_BITRATES.includes(plan.bitrate)).toBe(true);
		}
	});

	test("AAC failing to start rejects with the coded AAC_UNAVAILABLE error: the MP4 gets neither Opus nor silent no-audio", async () => {
		const failure = createAacUnavailableError({ stage: "trial encode", cause: new Error("worker blocked") });

		const error = await rejection({
			promise: prepareAudioTrack({
				format: "mp4",
				quality: "high",
				audioBuffer: createMix(),
				ensureAac: async () => {
					throw failure;
				},
			}),
		});

		expect(error).toBe(failure);
	});

	test("a failure that is not already an ExportError is still reported as AAC_UNAVAILABLE, with the cause kept", async () => {
		const cause = new Error("boom");

		const error = await rejection({
			promise: prepareAudioTrack({
				format: "mp4",
				quality: "low",
				audioBuffer: createMix(),
				ensureAac: async () => {
					throw cause;
				},
			}),
		});

		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("AAC_UNAVAILABLE");
		expect(error.cause).toBe(cause);
		expect(error.message).toContain("WebM (Opus audio)");
	});

	test("a mix of 1024 samples or fewer is all priming: AUDIO_TOO_SHORT, not a silent file without audio", async () => {
		for (const length of [1, 735, AAC_PRIMING_SAMPLES]) {
			const { ensureAac } = createEnsure();

			const error = await rejection({
				promise: prepareAudioTrack({
					format: "mp4",
					quality: "high",
					audioBuffer: createMix({ length }),
					ensureAac,
				}),
			});

			if (!isExportError(error)) throw new Error("expected an ExportError");
			expect(error.code).toBe("AUDIO_TOO_SHORT");
			expect(error.detail).toBe(`${length} samples at 44100 Hz`);
		}
	});

	test("1025 samples is the shortest mix that can be encoded: one sample after the priming", async () => {
		const { ensureAac } = createEnsure();
		const plan = await prepareAudioTrack({
			format: "mp4",
			quality: "high",
			audioBuffer: createMix({ length: AAC_PRIMING_SAMPLES + 1 }),
			ensureAac,
		});
		expect(plan.startSample).toBe(AAC_PRIMING_SAMPLES);
	});
});

describe("prepareAudioTrack, WebM", () => {
	test("is Opus from sample 0 of the untouched mix, and never loads the AAC encoder", async () => {
		const { ensureAac, calls } = createEnsure();
		const mix = createMix({ length: 3000 });

		const plan = await prepareAudioTrack({ format: "webm", quality: "high", audioBuffer: mix, ensureAac });

		expect(plan).toEqual({ codec: "opus", bitrate: 128_000, buffer: mix, startSample: 0 });
		expect(plan.buffer).toBe(mix);
		expect(calls).toEqual([]);
	});

	test("a failing AAC gate and a very short mix do not matter to WebM", async () => {
		const plan = await prepareAudioTrack({
			format: "webm",
			quality: "low",
			audioBuffer: createMix({ length: 10 }),
			ensureAac: async () => {
				throw new Error("must not be called");
			},
		});

		expect(plan.codec).toBe("opus");
		expect(plan.startSample).toBe(0);
	});
});

/** A source that records a copy of every slice it is given, like an encoder would consume them. */
function createRecordingSource({ failOnCall }: { failOnCall?: number } = {}) {
	const added: Float32Array[][] = [];
	const source = {
		add: async (buffer: AudioBuffer) => {
			if (failOnCall === added.length + 1) throw new Error("encoder blew up");
			added.push(
				Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice()),
			);
		},
	};
	return { source, added };
}

function concatenate({ added, channel }: { added: Float32Array[][]; channel: number }): number[] {
	return added.flatMap((slice) => [...slice[channel]]);
}

function feederFor({
	mix,
	startSample,
	sliceSeconds,
	isCancelled = () => false,
	source,
}: {
	mix: AudioBuffer;
	startSample: number;
	sliceSeconds?: number;
	isCancelled?: () => boolean;
	source: { add: (buffer: AudioBuffer) => Promise<void> };
}) {
	return createAudioFeeder({ source, buffer: mix, startSample, sliceSeconds, isCancelled, createBuffer });
}

describe("createAudioFeeder, all of it", () => {
	test("adds every sample from startSample on, once and in order: slices touch, none is skipped or repeated", async () => {
		const mix = createMix({ length: 12 * 44100 + 777, numberOfChannels: 2 });
		const { source, added } = createRecordingSource();

		const outcome = await feederFor({ mix, startSample: AAC_PRIMING_SAMPLES, source }).feedRest();

		expect(outcome).toBe("done");
		expect(added.length).toBe(Math.ceil((mix.length - AAC_PRIMING_SAMPLES) / (AUDIO_SLICE_SECONDS * 44100)));
		for (let channel = 0; channel < 2; channel++) {
			expect(concatenate({ added, channel })).toEqual([...mix.getChannelData(channel).subarray(AAC_PRIMING_SAMPLES)]);
		}
	});

	test("the first sample the encoder sees is sample 1024 of the mix, and sample 0..1023 never reach it", async () => {
		const mix = createMix({ length: 5000, numberOfChannels: 1 });
		const { source, added } = createRecordingSource();

		await feederFor({ mix, startSample: AAC_PRIMING_SAMPLES, source }).feedRest();

		const input = mix.getChannelData(0);
		expect(added[0][0][0]).toBe(input[AAC_PRIMING_SAMPLES]);
		expect(added.flatMap((slice) => [...slice[0]])).toHaveLength(5000 - AAC_PRIMING_SAMPLES);
		expect(added.flatMap((slice) => [...slice[0]]).includes(input[AAC_PRIMING_SAMPLES - 1])).toBe(false);
	});

	test("startSample 0 (Opus) adds the whole mix", async () => {
		const mix = createMix({ length: 3000, numberOfChannels: 2 });
		const { source, added } = createRecordingSource();

		await feederFor({ mix, startSample: 0, source }).feedRest();

		expect(concatenate({ added, channel: 1 })).toEqual([...mix.getChannelData(1)]);
	});

	test("a slice is at most AUDIO_SLICE_SECONDS (1 s) long, and by default that is what is used", async () => {
		const sampleRate = 44100;
		const mix = createMix({ length: Math.round(2.5 * sampleRate), numberOfChannels: 1, sampleRate });
		const { source, added } = createRecordingSource();

		await feederFor({ mix, startSample: 0, source }).feedRest();

		expect(AUDIO_SLICE_SECONDS).toBe(1);
		expect(added.map((slice) => slice[0].length)).toEqual([sampleRate, sampleRate, Math.round(0.5 * sampleRate)]);
	});

	test("cancelling is checked before every slice: stops between slices, adds nothing more, and says so", async () => {
		const mix = createMix({ length: 4 * 441, numberOfChannels: 1 });
		const { source, added } = createRecordingSource();
		const checks: number[] = [];

		const outcome = await feederFor({
			mix,
			startSample: 0,
			sliceSeconds: 0.01,
			source,
			isCancelled: () => {
				checks.push(added.length);
				return added.length === 2;
			},
		}).feedRest();

		expect(outcome).toBe("cancelled");
		expect(added).toHaveLength(2);
		expect(checks).toEqual([0, 1, 2]);
	});

	test("cancelled before the first slice: nothing is added", async () => {
		const { source, added } = createRecordingSource();

		const outcome = await feederFor({ mix: createMix({ length: 5000 }), startSample: 0, source, isCancelled: () => true }).feedRest();

		expect(outcome).toBe("cancelled");
		expect(added).toEqual([]);
	});

	test("an encoder error stops the loop and reaches the caller: nothing is swallowed, no later slice is added", async () => {
		const { source, added } = createRecordingSource({ failOnCall: 2 });

		const error = await rejection({
			promise: feederFor({
				mix: createMix({ length: 1000, numberOfChannels: 1, sampleRate: 1000 }),
				startSample: 0,
				sliceSeconds: 0.25,
				source,
			}).feedRest(),
		});

		expect(error instanceof Error && error.message).toBe("encoder blew up");
		expect(added).toHaveLength(1);
	});

	test("a start at or past the end leaves nothing to add: done at once, no slice", async () => {
		const { source, added } = createRecordingSource();

		const outcome = await feederFor({ mix: createMix({ length: 2000 }), startSample: 2000, source }).feedRest();

		expect(outcome).toBe("done");
		expect(added).toEqual([]);
	});
});

describe("createAudioFeeder, interleaved with the video", () => {
	test("feedUntil adds exactly the slices that start before that time of the output, counted from startSample", async () => {
		// 1000 Hz, slices of 250 samples from sample 24: they start at 0, 0.25, 0.5, 0.75 s of the output.
		const mix = createMix({ length: 1024, numberOfChannels: 1, sampleRate: 1000 });
		const { source, added } = createRecordingSource();
		const feeder = feederFor({ mix, startSample: 24, sliceSeconds: 0.25, source });

		await feeder.feedUntil({ seconds: 0 });
		expect(added).toHaveLength(0);
		await feeder.feedUntil({ seconds: 0.001 });
		expect(added).toHaveLength(1);
		await feeder.feedUntil({ seconds: 0.25 });
		expect(added).toHaveLength(1);
		await feeder.feedUntil({ seconds: 0.6 });
		expect(added).toHaveLength(3);
		await feeder.feedUntil({ seconds: 0.1 }); // never goes back, never repeats
		expect(added).toHaveLength(3);
		await feeder.feedRest();
		expect(added).toHaveLength(4);
		expect(concatenate({ added, channel: 0 })).toEqual([...mix.getChannelData(0).subarray(24)]);
	});

	test("driven frame by frame, the audio is never more than one slice ahead of the video", async () => {
		const sampleRate = 8000;
		const mix = createMix({ length: 10 * sampleRate + AAC_PRIMING_SAMPLES, numberOfChannels: 1, sampleRate });
		const { source, added } = createRecordingSource();
		const feeder = feederFor({ mix, startSample: AAC_PRIMING_SAMPLES, source });
		const fps = 30;
		for (let frame = 0; frame < 10 * fps; frame++) {
			const seconds = frame / fps;
			await feeder.feedUntil({ seconds });
			const audioSeconds = added.reduce((sum, slice) => sum + slice[0].length, 0) / sampleRate;
			expect(audioSeconds).toBeLessThanOrEqual(seconds + AUDIO_SLICE_SECONDS);
			expect(audioSeconds).toBeGreaterThanOrEqual(seconds);
		}
	});
});

describe("preflightAudio", () => {
	const mp4 = { format: "mp4", quality: "high", includeAudio: true, hasAudio: true, sampleRate: 44100, numberOfChannels: 2 } as const;

	test("starts the AAC encoder, with the export's rate, channels and AAC bitrate, before any audio is mixed", async () => {
		const { ensureAac, calls } = createEnsure();

		await preflightAudio({ ...mp4, ensureAac });

		expect(calls).toEqual([{ sampleRate: 44100, numberOfChannels: 2, bitrate: 192_000 }]);
	});

	test("does nothing when it would not be used: WebM, audio off, or a timeline without audible audio", async () => {
		for (const override of [{ format: "webm" }, { includeAudio: false }, { hasAudio: false }] as const) {
			const { ensureAac, calls } = createEnsure();
			await preflightAudio({ ...mp4, ...override, ensureAac });
			expect(calls).toEqual([]);
		}
	});

	test("an AAC encoder that cannot start stops the export at once with AAC_UNAVAILABLE", async () => {
		const failure = createAacUnavailableError({ stage: "trial encode" });
		const error = await rejection({
			promise: preflightAudio({
				...mp4,
				ensureAac: async () => {
					throw failure;
				},
			}),
		});
		expect(error).toBe(failure);
	});

	test("a failure that is not an ExportError is wrapped as AAC_UNAVAILABLE with its cause", async () => {
		const cause = new Error("raw");
		const error = await rejection({
			promise: preflightAudio({
				...mp4,
				ensureAac: async () => {
					throw cause;
				},
			}),
		});
		if (!isExportError(error)) throw new Error("expected an ExportError");
		expect(error.code).toBe("AAC_UNAVAILABLE");
		expect(error.cause).toBe(cause);
	});
});

describe("assertAudioReadable", () => {
	const buffer = createMix({ length: 2000 });

	test("passes when every clip was read", () => {
		expect(() => assertAudioReadable({ mix: { buffer, skipped: [] }, hasAudio: true })).not.toThrow();
	});

	test("passes when the timeline has no audible audio, with or without a buffer", () => {
		expect(() => assertAudioReadable({ mix: { buffer: null, skipped: [] }, hasAudio: false })).not.toThrow();
		expect(() => assertAudioReadable({ mix: { buffer, skipped: [] }, hasAudio: false })).not.toThrow();
	});

	test("a clip that could not be read stops the export with AUDIO_UNREADABLE naming it, even when other clips were mixed", () => {
		let thrown: unknown;
		try {
			assertAudioReadable({
				mix: { buffer, skipped: [{ name: "voice.mp3", reason: "Unable to decode audio data" }] },
				hasAudio: true,
			});
		} catch (error) {
			thrown = error;
		}

		if (!isExportError(thrown)) throw new Error("expected an ExportError");
		expect(thrown.code).toBe("AUDIO_UNREADABLE");
		expect(thrown.message).toContain('"voice.mp3"');
		expect(thrown.detail).toBe("voice.mp3: Unable to decode audio data");
	});

	test("an audible timeline that produced no buffer at all is AUDIO_UNREADABLE too, even with nothing named", () => {
		let thrown: unknown;
		try {
			assertAudioReadable({ mix: { buffer: null, skipped: [] }, hasAudio: true });
		} catch (error) {
			thrown = error;
		}

		if (!isExportError(thrown)) throw new Error("expected an ExportError");
		expect(thrown.code).toBe("AUDIO_UNREADABLE");
		expect(thrown.detail).toBe("the audio mix is empty");
	});

	test("clips named as skipped stop the export even when the timeline looks silent", () => {
		expect(() =>
			assertAudioReadable({ mix: { buffer: null, skipped: [{ name: "x", reason: "y" }] }, hasAudio: false }),
		).toThrow();
	});
});
