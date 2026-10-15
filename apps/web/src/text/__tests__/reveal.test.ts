import { describe, expect, test } from "bun:test";
import { getVisibleLengths } from "@/text/reveal";

function grapheme({ lines, fraction }: { lines: string[]; fraction: number }) {
	return getVisibleLengths({ lines, unit: "grapheme", fraction });
}

function word({ lines, fraction }: { lines: string[]; fraction: number }) {
	return getVisibleLengths({ lines, unit: "word", fraction });
}

// "e" + combining acute (2 UTF-16 units) and thumbs-up + skin tone (4 units).
const ACCENTED = "é";
const THUMBS_UP = "\u{1F44D}\u{1F3FD}";

describe("grapheme reveal", () => {
	test("an accented letter and an emoji with a skin tone each count as one character", () => {
		const lines = [`${ACCENTED}${THUMBS_UP}x`];
		expect(grapheme({ lines, fraction: 1 / 3 })).toEqual([2]);
		expect(grapheme({ lines, fraction: 2 / 3 })).toEqual([6]);
		expect(grapheme({ lines, fraction: 1 })).toEqual([7]);
	});

	test("a precomposed accented letter counts as one", () => {
		expect(grapheme({ lines: ["éa"], fraction: 0.5 })).toEqual([1]);
	});

	test("fraction 0 shows nothing and fraction 1 shows everything", () => {
		const lines = ["Merhaba dünya", "", "İyi"];
		expect(grapheme({ lines, fraction: 0 })).toEqual([0, 0, 0]);
		expect(grapheme({ lines, fraction: 1 })).toEqual([13, 0, 3]);
	});

	test("fills the lines in order", () => {
		const lines = ["ab", "cd"];
		expect(grapheme({ lines, fraction: 0.25 })).toEqual([1, 0]);
		expect(grapheme({ lines, fraction: 0.5 })).toEqual([2, 0]);
		expect(grapheme({ lines, fraction: 0.75 })).toEqual([2, 1]);
	});

	test("spaces are characters too", () => {
		expect(grapheme({ lines: ["a b"], fraction: 2 / 3 })).toEqual([2]);
	});

	test("a character that is due is not lost to float error", () => {
		// 0.29 * 100 is 28.999999999999996 in floats, but 29 characters are due.
		const lines = ["a".repeat(100)];
		expect(grapheme({ lines, fraction: 0.29 })).toEqual([29]);
		expect(grapheme({ lines, fraction: 0.58 })).toEqual([58]);
	});
});

describe("word reveal", () => {
	test('"Merhaba dünya\\nİyi" has three words, revealed across both lines', () => {
		const lines = ["Merhaba dünya", "İyi"];
		expect(word({ lines, fraction: 0 })).toEqual([0, 0]);
		expect(word({ lines, fraction: 1 / 3 })).toEqual([7, 0]);
		expect(word({ lines, fraction: 2 / 3 })).toEqual([13, 0]);
		expect(word({ lines, fraction: 1 })).toEqual([13, 3]);
	});

	test("punctuation travels with the word before it", () => {
		expect(word({ lines: ["Hello, world!"], fraction: 0.5 })).toEqual([6]);
		expect(word({ lines: ["Hello, world!"], fraction: 1 })).toEqual([13]);
	});

	test("extra spaces do not count as words", () => {
		expect(word({ lines: ["  a   b "], fraction: 0.5 })).toEqual([3]);
		expect(word({ lines: ["  a   b "], fraction: 1 })).toEqual([8]);
	});

	test("a text with no words still shows in full at fraction 1", () => {
		expect(word({ lines: ["\u{1F44D}"], fraction: 0 })).toEqual([0]);
		expect(word({ lines: ["\u{1F44D}"], fraction: 1 })).toEqual([2]);
	});
});

describe("edge cases", () => {
	test("no lines and empty lines", () => {
		expect(grapheme({ lines: [], fraction: 0.5 })).toEqual([]);
		expect(grapheme({ lines: [""], fraction: 0.5 })).toEqual([0]);
		expect(word({ lines: [""], fraction: 1 })).toEqual([0]);
	});

	test("a fraction outside 0..1, or not a number, is clamped", () => {
		expect(grapheme({ lines: ["abc"], fraction: -1 })).toEqual([0]);
		expect(grapheme({ lines: ["abc"], fraction: 5 })).toEqual([3]);
		expect(grapheme({ lines: ["abc"], fraction: Number.NaN })).toEqual([0]);
	});

	test("never reveals more than the line holds, at any fraction", () => {
		const lines = ["Merhaba dünya", "İyi", `${ACCENTED}${THUMBS_UP}`];
		for (let step = 0; step <= 100; step += 1) {
			for (const unit of ["grapheme", "word"] as const) {
				const lengths = getVisibleLengths({ lines, unit, fraction: step / 100 });
				expect(lengths).toHaveLength(lines.length);
				lengths.forEach((length, index) => {
					expect(length).toBeGreaterThanOrEqual(0);
					expect(length).toBeLessThanOrEqual(lines[index].length);
				});
			}
		}
	});

	test("without Intl.Segmenter the fallback gives the same counts for plain ASCII", () => {
		const lines = ["Hello, brave", "new world"];
		const fractions = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
		const run = () =>
			fractions.map((fraction) => [
				grapheme({ lines, fraction }),
				word({ lines, fraction }),
			]);
		const withSegmenter = run();

		const original = Reflect.get(Intl, "Segmenter");
		Reflect.set(Intl, "Segmenter", undefined);
		try {
			expect(run()).toEqual(withSegmenter);
		} finally {
			Reflect.set(Intl, "Segmenter", original);
		}
		expect(typeof Intl.Segmenter).toBe("function");
	});
});
