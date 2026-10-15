import { describe, expect, test } from "bun:test";
import {
	AAC_PRIMING_SAMPLES,
	AUDIO_SLICE_SECONDS,
	aacMaxPacketCount,
	planAudioSlices,
	sliceBuffer,
} from "../audio-slices";
import { FakeAudioBuffer, createFilledBuffer } from "./fake-audio-buffer";

function createBuffer(init: AudioBufferOptions): AudioBuffer {
	return new FakeAudioBuffer(init);
}

describe("AAC_PRIMING_SAMPLES", () => {
	test("is one AAC frame, the delay measured for the wasm encoder (export-v2 M5)", () => {
		expect(AAC_PRIMING_SAMPLES).toBe(1024);
	});
});

describe("AUDIO_SLICE_SECONDS", () => {
	test("is at most 5 s: cancel and progress are checked between slices, so this is their latency", () => {
		expect(AUDIO_SLICE_SECONDS).toBeGreaterThan(0);
		expect(AUDIO_SLICE_SECONDS).toBeLessThanOrEqual(5);
	});
});

describe("planAudioSlices", () => {
	test("covers [start, end) with consecutive slices: no gap, no overlap, none empty, none longer than the maximum", () => {
		const plan = planAudioSlices({ startSample: 1024, endSample: 12 * 44100, sampleRate: 44100, maxSliceSeconds: 5 });

		expect(plan[0]?.startSample).toBe(1024);
		expect(plan.at(-1)?.endSample).toBe(12 * 44100);
		for (let index = 0; index < plan.length; index++) {
			const { startSample, endSample } = plan[index];
			expect(endSample).toBeGreaterThan(startSample);
			expect(endSample - startSample).toBeLessThanOrEqual(5 * 44100);
			if (index > 0) {
				expect(startSample).toBe(plan[index - 1].endSample);
			}
		}
		expect(plan.map(({ startSample, endSample }) => endSample - startSample)).toEqual([
			5 * 44100,
			5 * 44100,
			2 * 44100 - 1024,
		]);
	});

	test("a range shorter than one slice is one slice; an exact multiple has no empty tail", () => {
		expect(planAudioSlices({ startSample: 0, endSample: 100, sampleRate: 44100, maxSliceSeconds: 5 })).toEqual([
			{ startSample: 0, endSample: 100 },
		]);
		expect(planAudioSlices({ startSample: 0, endSample: 10 * 44100, sampleRate: 44100, maxSliceSeconds: 5 })).toEqual([
			{ startSample: 0, endSample: 5 * 44100 },
			{ startSample: 5 * 44100, endSample: 10 * 44100 },
		]);
	});

	test("an empty or inverted range has no slices", () => {
		expect(planAudioSlices({ startSample: 10, endSample: 10, sampleRate: 44100, maxSliceSeconds: 5 })).toEqual([]);
		expect(planAudioSlices({ startSample: 11, endSample: 10, sampleRate: 44100, maxSliceSeconds: 5 })).toEqual([]);
	});

	test("a ten-minute mix is 120 slices of 5 s, so the first cancel check comes after at most 5 s of audio", () => {
		const plan = planAudioSlices({
			startSample: 1024,
			endSample: 600 * 44100,
			sampleRate: 44100,
			maxSliceSeconds: AUDIO_SLICE_SECONDS,
		});
		expect(plan).toHaveLength(Math.ceil((600 * 44100 - 1024) / (AUDIO_SLICE_SECONDS * 44100)));
		expect(plan.every(({ startSample, endSample }) => endSample - startSample <= AUDIO_SLICE_SECONDS * 44100)).toBe(true);
	});

	test("a slice length that is not a whole number of samples is rounded down, never up", () => {
		const plan = planAudioSlices({ startSample: 0, endSample: 1000, sampleRate: 22050, maxSliceSeconds: 0.0123 });
		const longest = Math.max(...plan.map(({ startSample, endSample }) => endSample - startSample));
		expect(longest).toBe(Math.floor(0.0123 * 22050));
		expect(plan.at(-1)?.endSample).toBe(1000);
	});

	test("invalid input is a programming error: fractional or negative samples, no sample rate, no slice length", () => {
		const valid = { startSample: 0, endSample: 100, sampleRate: 44100, maxSliceSeconds: 5 };
		for (const bad of [
			{ ...valid, startSample: -1 },
			{ ...valid, startSample: 0.5 },
			{ ...valid, endSample: 100.5 },
			{ ...valid, sampleRate: 0 },
			{ ...valid, maxSliceSeconds: 0 },
			{ ...valid, maxSliceSeconds: Number.NaN },
			{ ...valid, maxSliceSeconds: 1e-9 },
		]) {
			expect(() => planAudioSlices(bad)).toThrow(RangeError);
		}
	});
});

describe("sliceBuffer", () => {
	test("copies samples [start, end) of every channel: output sample j is input sample j + start", () => {
		const source = createFilledBuffer({
			length: 5000,
			numberOfChannels: 2,
			sampleRate: 44100,
			value: ({ channel, frame }) => Math.fround(frame * 0.25 + channel * 10000),
		});

		const slice = sliceBuffer({ buffer: source, startSample: 1024, endSample: 4000, createBuffer });

		expect(slice.length).toBe(4000 - 1024);
		for (let channel = 0; channel < 2; channel++) {
			const input = source.getChannelData(channel);
			const output = slice.getChannelData(channel);
			for (const frame of [0, 1, 1023, 1024, 2000, 2975]) {
				expect(output[frame]).toBe(input[frame + 1024]);
			}
			expect(output[slice.length - 1]).toBe(input[3999]);
		}
	});

	test("keeps sample rate and channel count", () => {
		for (const [numberOfChannels, sampleRate] of [
			[1, 44100],
			[2, 48000],
			[6, 44100],
		] as const) {
			const source = new FakeAudioBuffer({ length: 4096, numberOfChannels, sampleRate });
			const slice = sliceBuffer({ buffer: source, startSample: 100, endSample: 200, createBuffer });
			expect(slice.numberOfChannels).toBe(numberOfChannels);
			expect(slice.sampleRate).toBe(sampleRate);
		}
	});

	test("is a copy: writing to the slice does not touch the source, and the source is not modified", () => {
		const source = createFilledBuffer({
			length: 3000,
			numberOfChannels: 1,
			sampleRate: 44100,
			value: ({ frame }) => Math.fround(frame),
		});
		const before = source.getChannelData(0).slice();

		const slice = sliceBuffer({ buffer: source, startSample: 10, endSample: 20, createBuffer });
		slice.getChannelData(0).fill(-1);

		expect(source.getChannelData(0)).toEqual(before);
	});

	test("the very last sample and a one-sample slice work; an empty or out-of-range slice is a RangeError", () => {
		const source = createFilledBuffer({
			length: 100,
			numberOfChannels: 1,
			sampleRate: 44100,
			value: ({ frame }) => Math.fround(frame + 0.5),
		});

		const last = sliceBuffer({ buffer: source, startSample: 99, endSample: 100, createBuffer });
		expect(last.length).toBe(1);
		expect(last.getChannelData(0)[0]).toBe(Math.fround(99.5));

		for (const [startSample, endSample] of [
			[10, 10],
			[11, 10],
			[-1, 10],
			[0, 101],
			[0.5, 10],
			[0, 10.5],
		]) {
			expect(() => sliceBuffer({ buffer: source, startSample, endSample, createBuffer })).toThrow(RangeError);
		}
	});
});

describe("aacMaxPacketCount", () => {
	test("every started AAC frame, one for the priming flush, and 8 spare", () => {
		expect(aacMaxPacketCount({ samples: 0 })).toBe(1 + 8);
		expect(aacMaxPacketCount({ samples: 1 })).toBe(2 + 8);
		expect(aacMaxPacketCount({ samples: 1024 })).toBe(2 + 8);
		expect(aacMaxPacketCount({ samples: 1025 })).toBe(3 + 8);
		// export-v2 M5: 6 s at 44.1 kHz gave 260 real packets.
		expect(aacMaxPacketCount({ samples: 6 * 44100 })).toBeGreaterThanOrEqual(260);
	});

	test("refuses what cannot be a sample count", () => {
		for (const samples of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => aacMaxPacketCount({ samples })).toThrow(RangeError);
		}
	});
});
