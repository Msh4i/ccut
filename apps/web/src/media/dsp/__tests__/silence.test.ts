import { describe, expect, test } from "bun:test";
import {
	DEFAULT_RMS_WINDOW_MS,
	detectSilences,
	keepRanges,
	windowedRmsDb,
	type TimeRange,
} from "../silence";
import { addConstant, sine, silence, speechPattern } from "./signals";

const OPTIONS = {
	thresholdDb: -40,
	minSilenceMs: 300,
	minSpeechMs: 0,
	paddingMs: 0,
};

function expectRanges({
	actual,
	expected,
	tolerance = 0.021,
}: {
	actual: TimeRange[];
	expected: Array<[number, number]>;
	tolerance?: number;
}) {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((range, index) => {
		expect(Math.abs(range.start - expected[index][0])).toBeLessThanOrEqual(tolerance);
		expect(Math.abs(range.end - expected[index][1])).toBeLessThanOrEqual(tolerance);
	});
}

describe("windowedRmsDb", () => {
	test("a full-scale square wave is 0 dBFS, a full-scale sine -3.01 dBFS, digital silence -Infinity", () => {
		const sampleRate = 48_000;
		const square = new Float32Array(9600).map((_, i) => (i % 2 === 0 ? 1 : -1));
		expect(windowedRmsDb({ channels: [square], sampleRate })[0]).toBeCloseTo(0, 6);
		const db = windowedRmsDb({
			channels: [sine({ frequency: 1000, amplitude: 1, seconds: 0.2, sampleRate })],
			sampleRate,
		});
		// 20 ms windows hold exactly 20 periods of 1 kHz at 48 kHz.
		expect(db[0]).toBeCloseTo(-3.0103, 3);
		expect(windowedRmsDb({ channels: [silence({ seconds: 0.1, sampleRate })], sampleRate })[0]).toBe(
			Number.NEGATIVE_INFINITY,
		);
	});

	test("the window count covers a trailing partial window", () => {
		const sampleRate = 44_100;
		const windowSamples = (DEFAULT_RMS_WINDOW_MS / 1000) * sampleRate;
		const db = windowedRmsDb({
			channels: [new Float32Array(windowSamples * 3 + 10).map((_, i) => (i % 2 === 0 ? 0.5 : -0.5))],
			sampleRate,
		});
		expect(db.length).toBe(4);
		expect(db[3]).toBeCloseTo(20 * Math.log10(0.5), 5);
	});

	test("a DC offset alone does not count as signal", () => {
		const sampleRate = 48_000;
		const db = windowedRmsDb({
			channels: [silence({ seconds: 0.5, sampleRate, level: 0.3 })],
			sampleRate,
		});
		expect(db.every((value) => value < -100)).toBe(true);
	});

	test("an empty signal has no windows", () => {
		expect(windowedRmsDb({ channels: [new Float32Array(0)], sampleRate: 48_000 }).length).toBe(0);
	});
});

describe("detectSilences", () => {
	for (const sampleRate of [44_100, 48_000]) {
		test(`finds the quiet gaps of a tone pattern at ${sampleRate} Hz`, () => {
			const channel = speechPattern({
				sampleRate,
				pieces: [
					["tone", 1],
					["quiet", 1],
					["tone", 0.5],
					["quiet", 0.6],
					["tone", 0.4],
				],
			});
			const silences = detectSilences({ channels: [channel], sampleRate, ...OPTIONS });
			expectRanges({ actual: silences, expected: [[1, 2], [2.5, 3.1]] });
		});
	}

	test("all silence is one range covering the whole file", () => {
		const sampleRate = 48_000;
		const silences = detectSilences({
			channels: [silence({ seconds: 2, sampleRate })],
			sampleRate,
			...OPTIONS,
		});
		expect(silences).toEqual([{ start: 0, end: 2 }]);
	});

	test("no silence gives no range", () => {
		const sampleRate = 48_000;
		const silences = detectSilences({
			channels: [sine({ frequency: 440, amplitude: 0.5, seconds: 2, sampleRate })],
			sampleRate,
			...OPTIONS,
		});
		expect(silences).toEqual([]);
	});

	test("an empty signal gives no range", () => {
		expect(detectSilences({ channels: [new Float32Array(0)], sampleRate: 48_000, ...OPTIONS })).toEqual([]);
	});

	test("a signal shorter than one window is measured over its own length", () => {
		const sampleRate = 48_000;
		const quiet = silence({ seconds: 0.005, sampleRate });
		const loud = sine({ frequency: 1000, amplitude: 0.5, seconds: 0.005, sampleRate });
		const options = { ...OPTIONS, minSilenceMs: 1 };
		expect(detectSilences({ channels: [quiet], sampleRate, ...options })).toEqual([
			{ start: 0, end: 0.005 },
		]);
		expect(detectSilences({ channels: [loud], sampleRate, ...options })).toEqual([]);
	});

	test("a stereo file is silent only where both channels are", () => {
		const sampleRate = 48_000;
		const left = speechPattern({ sampleRate, pieces: [["tone", 1], ["quiet", 2]] });
		const right = speechPattern({
			sampleRate,
			pieces: [["quiet", 2], ["tone", 0.5], ["quiet", 0.5]],
		});
		const silences = detectSilences({ channels: [left, right], sampleRate, ...OPTIONS });
		expectRanges({ actual: silences, expected: [[1, 2], [2.5, 3]] });
	});

	test("a quiet but present channel keeps the window from being silent", () => {
		const sampleRate = 48_000;
		// About -38 dBFS RMS on the left only; averaging the channels would give -41.
		const left = sine({ frequency: 440, amplitude: 0.0178, seconds: 1, sampleRate });
		const right = silence({ seconds: 1, sampleRate });
		expect(detectSilences({ channels: [left, right], sampleRate, ...OPTIONS })).toEqual([]);
	});

	test("a DC offset does not hide silence", () => {
		const sampleRate = 48_000;
		const channel = addConstant({
			signal: speechPattern({ sampleRate, pieces: [["tone", 1], ["quiet", 1], ["tone", 1]] }),
			value: 0.25,
		});
		const silences = detectSilences({ channels: [channel], sampleRate, ...OPTIONS });
		expectRanges({ actual: silences, expected: [[1, 2]] });
	});

	test("a gap shorter than minSilenceMs is not silence", () => {
		const sampleRate = 48_000;
		const channel = speechPattern({
			sampleRate,
			pieces: [["tone", 1], ["quiet", 0.2], ["tone", 1], ["quiet", 0.5], ["tone", 1]],
		});
		const silences = detectSilences({ channels: [channel], sampleRate, ...OPTIONS });
		expectRanges({ actual: silences, expected: [[2.2, 2.7]] });
	});

	test("a click shorter than minSpeechMs inside a pause does not split it", () => {
		const sampleRate = 48_000;
		const channel = speechPattern({
			sampleRate,
			pieces: [["tone", 1], ["quiet", 0.5], ["tone", 0.04], ["quiet", 0.5], ["tone", 1]],
		});
		const split = detectSilences({ channels: [channel], sampleRate, ...OPTIONS });
		expect(split).toHaveLength(2);
		const merged = detectSilences({
			channels: [channel],
			sampleRate,
			...OPTIONS,
			minSpeechMs: 100,
		});
		expectRanges({ actual: merged, expected: [[1, 2.04]] });
	});

	test("the threshold decides what counts as quiet", () => {
		const sampleRate = 48_000;
		// RMS of a 0.005 amplitude sine is about -49 dBFS.
		const channel = sine({ frequency: 440, amplitude: 0.005, seconds: 1, sampleRate });
		expect(detectSilences({ channels: [channel], sampleRate, ...OPTIONS, thresholdDb: -40 })).toHaveLength(1);
		expect(detectSilences({ channels: [channel], sampleRate, ...OPTIONS, thresholdDb: -60 })).toEqual([]);
	});

	test("padding shrinks ranges next to speech but keeps the file edges", () => {
		const sampleRate = 48_000;
		const channel = speechPattern({
			sampleRate,
			pieces: [["quiet", 1], ["tone", 1], ["quiet", 1], ["tone", 1], ["quiet", 1]],
		});
		const silences = detectSilences({
			channels: [channel],
			sampleRate,
			...OPTIONS,
			paddingMs: 100,
		});
		expectRanges({ actual: silences, expected: [[0, 0.9], [2.1, 2.9], [4.1, 5]] });
		expect(silences[0].start).toBe(0);
		expect(silences[2].end).toBe(5);
	});

	test("large padding never makes ranges overlap, invert or leave [0, duration]", () => {
		const sampleRate = 48_000;
		const channel = speechPattern({
			sampleRate,
			pieces: [["quiet", 0.4], ["tone", 0.1], ["quiet", 0.35], ["tone", 0.1], ["quiet", 0.6]],
		});
		const duration = channel.length / sampleRate;
		for (const paddingMs of [0, 50, 150, 174, 175, 176, 300, 10_000]) {
			const silences = detectSilences({ channels: [channel], sampleRate, ...OPTIONS, paddingMs });
			let previousEnd = 0;
			for (const range of silences) {
				expect(range.start).toBeGreaterThanOrEqual(previousEnd);
				expect(range.end).toBeGreaterThan(range.start);
				expect(range.end).toBeLessThanOrEqual(duration);
				previousEnd = range.end;
			}
		}
	});

	test("rejects invalid options", () => {
		const channels = [new Float32Array(10)];
		expect(() => detectSilences({ channels, sampleRate: 0, ...OPTIONS })).toThrow(RangeError);
		expect(() => detectSilences({ channels, sampleRate: 48_000, ...OPTIONS, paddingMs: -1 })).toThrow(RangeError);
		expect(() => detectSilences({ channels: [], sampleRate: 48_000, ...OPTIONS })).toThrow(RangeError);
		expect(() =>
			detectSilences({
				channels: [new Float32Array(10), new Float32Array(9)],
				sampleRate: 48_000,
				...OPTIONS,
			}),
		).toThrow(RangeError);
	});
});

describe("keepRanges", () => {
	test("is the complement of the silences inside [0, duration]", () => {
		expect(
			keepRanges({
				silences: [
					{ start: 0, end: 1 },
					{ start: 2, end: 2.5 },
				],
				duration: 4,
			}),
		).toEqual([
			{ start: 1, end: 2 },
			{ start: 2.5, end: 4 },
		]);
	});

	test("no silence keeps everything, all silence keeps nothing", () => {
		expect(keepRanges({ silences: [], duration: 3 })).toEqual([{ start: 0, end: 3 }]);
		expect(keepRanges({ silences: [{ start: 0, end: 3 }], duration: 3 })).toEqual([]);
	});

	test("a silence inside another one does not move the cursor back", () => {
		expect(
			keepRanges({
				silences: [
					{ start: 1, end: 3 },
					{ start: 1.5, end: 2 },
				],
				duration: 4,
			}),
		).toEqual([
			{ start: 0, end: 1 },
			{ start: 3, end: 4 },
		]);
	});

	test("unsorted, overlapping or out-of-range silences are tolerated", () => {
		expect(
			keepRanges({
				silences: [
					{ start: 2, end: 5 },
					{ start: -1, end: 0.5 },
					{ start: 1.8, end: 2.2 },
				],
				duration: 4,
			}),
		).toEqual([{ start: 0.5, end: 1.8 }]);
	});
});
