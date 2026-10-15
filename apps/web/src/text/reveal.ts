import { clamp } from "@/utils/math";

export type RevealUnit = "grapheme" | "word";

function createSegmenter({ unit }: { unit: RevealUnit }): Intl.Segmenter | null {
	return typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: unit })
		: null;
}

/** UTF-16 offset at which each unit of `line` ends. */
function getUnitEnds({
	line,
	unit,
	segmenter,
}: {
	line: string;
	unit: RevealUnit;
	segmenter: Intl.Segmenter | null;
}): number[] {
	const ends: number[] = [];

	if (unit === "grapheme") {
		if (segmenter) {
			for (const { segment, index } of segmenter.segment(line)) {
				ends.push(index + segment.length);
			}
		} else {
			// Code points: close enough for plain text, but splits an emoji with a skin tone.
			let end = 0;
			for (const char of line) {
				end += char.length;
				ends.push(end);
			}
		}
		return ends;
	}

	if (segmenter) {
		for (const { segment, index, isWordLike } of segmenter.segment(line)) {
			const end = index + segment.length;
			if (isWordLike) {
				ends.push(end);
			} else if (
				/\S/.test(segment) &&
				ends.length > 0 &&
				ends[ends.length - 1] === index
			) {
				// Punctuation right after a word belongs to that word.
				ends[ends.length - 1] = end;
			}
		}
		return ends;
	}

	for (const match of line.matchAll(/\S+/g)) {
		ends.push(match.index + match[0].length);
	}
	return ends;
}

/**
 * For a typewriter-style reveal: how many UTF-16 units of each line to draw
 * when `fraction` (0..1) of all the characters or words of the text are
 * visible. Lines fill in order. Splitting is by grapheme cluster or word, so a
 * character is never cut in the middle.
 */
export function getVisibleLengths({
	lines,
	unit,
	fraction,
}: {
	lines: string[];
	unit: RevealUnit;
	fraction: number;
}): number[] {
	const segmenter = createSegmenter({ unit });
	const unitEnds = lines.map((line) => getUnitEnds({ line, unit, segmenter }));
	const total = unitEnds.reduce((sum, ends) => sum + ends.length, 0);
	const safeFraction = Number.isNaN(fraction)
		? 0
		: clamp({ value: fraction, min: 0, max: 1 });
	// Fully revealed means the whole text, even parts that hold no unit (a line
	// of only an emoji, in word mode).
	if (safeFraction >= 1) {
		return lines.map((line) => line.length);
	}
	// The small bias keeps a due unit from being lost to float error (0.29 * 100).
	let remaining = Math.floor(safeFraction * total + 1e-9);

	return lines.map((line, index) => {
		const ends = unitEnds[index];
		const shown = Math.min(ends.length, remaining);
		remaining -= shown;
		if (shown === 0) return 0;
		return shown === ends.length ? line.length : ends[shown - 1];
	});
}
