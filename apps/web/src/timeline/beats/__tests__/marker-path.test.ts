import { describe, expect, test } from "bun:test";
import {
	BEAT_MARKER_MIN_SPACING_PX,
	buildBeatTickPath,
	getBeatMarkerPath,
	isBeatMarkerSpacingTooDense,
	nearestBeatIndex,
} from "@/timeline/beats/marker-path";

describe("getBeatMarkerPath", () => {
	test("draws one vertical tick per beat between top and bottom", () => {
		expect(
			getBeatMarkerPath({ positions: [10, 60, 110], top: 20, bottom: 30 }),
		).toBe("M10 20V30M60 20V30M110 20V30");
	});

	test("draws a lone beat", () => {
		expect(getBeatMarkerPath({ positions: [42], top: 0, bottom: 9 })).toBe(
			"M42 0V9",
		);
	});

	test("draws nothing without beats", () => {
		expect(getBeatMarkerPath({ positions: [], top: 0, bottom: 9 })).toBeNull();
	});

	test("snaps ticks to whole pixels so they are not anti-aliased into a blur", () => {
		expect(
			getBeatMarkerPath({ positions: [10.4, 50.6], top: 0, bottom: 9 }),
		).toBe("M10 0V9M51 0V9");
	});

	test("hides the ticks once the average spacing drops below the minimum", () => {
		const tooClose = Array.from(
			{ length: 100 },
			(_, i) => i * (BEAT_MARKER_MIN_SPACING_PX - 0.5),
		);
		expect(getBeatMarkerPath({ positions: tooClose, top: 0, bottom: 9 })).toBeNull();
	});

	test("keeps the ticks at exactly the minimum spacing", () => {
		const atLimit = Array.from(
			{ length: 100 },
			(_, i) => i * BEAT_MARKER_MIN_SPACING_PX,
		);
		expect(getBeatMarkerPath({ positions: atLimit, top: 0, bottom: 9 })).not.toBeNull();
	});

	test("judges density on the average, so one close pair does not hide the rest", () => {
		const positions = [0, 2, 100, 200, 300, 400];
		expect(getBeatMarkerPath({ positions, top: 0, bottom: 9 })).not.toBeNull();
	});
});

describe("isBeatMarkerSpacingTooDense", () => {
	test("is false for a lone beat or an empty list", () => {
		expect(isBeatMarkerSpacingTooDense({ firstPx: 5, lastPx: 5, count: 1 })).toBe(false);
		expect(isBeatMarkerSpacingTooDense({ firstPx: 0, lastPx: 0, count: 0 })).toBe(false);
	});

	test("compares the average gap with the minimum spacing", () => {
		const gaps = 99;
		expect(
			isBeatMarkerSpacingTooDense({
				firstPx: 10,
				lastPx: 10 + gaps * (BEAT_MARKER_MIN_SPACING_PX - 0.1),
				count: gaps + 1,
			}),
		).toBe(true);
		expect(
			isBeatMarkerSpacingTooDense({
				firstPx: 10,
				lastPx: 10 + gaps * BEAT_MARKER_MIN_SPACING_PX,
				count: gaps + 1,
			}),
		).toBe(false);
	});

	test("agrees with getBeatMarkerPath on when to hide", () => {
		for (const spacing of [1, 3.9, 4, 4.1, 30]) {
			const positions = Array.from({ length: 50 }, (_, i) => 7 + i * spacing);
			expect(getBeatMarkerPath({ positions, top: 0, bottom: 9 }) === null).toBe(
				isBeatMarkerSpacingTooDense({
					firstPx: positions[0],
					lastPx: positions[positions.length - 1],
					count: positions.length,
				}),
			);
		}
	});
});


describe("nearestBeatIndex", () => {
	const positions = [10, 60, 110, 160];

	test("finds the tick under the pointer", () => {
		expect(nearestBeatIndex({ positions, x: 60, radius: 6 })).toBe(1);
		expect(nearestBeatIndex({ positions, x: 63, radius: 6 })).toBe(1);
	});

	test("reaches the pixel the tick was drawn on", () => {
		// 59.6 is drawn at x = 60.
		expect(nearestBeatIndex({ positions: [59.6], x: 60, radius: 0 })).toBe(0);
	});

	test("is null between ticks, so the click reaches the clip", () => {
		expect(nearestBeatIndex({ positions, x: 85, radius: 6 })).toBeNull();
	});

	test("takes the closer of two ticks inside the radius", () => {
		expect(nearestBeatIndex({ positions: [100, 104], x: 103, radius: 6 })).toBe(1);
		expect(nearestBeatIndex({ positions: [100, 104], x: 101, radius: 6 })).toBe(0);
	});

	test("does not rely on the ticks being ascending (a reversed clip)", () => {
		expect(nearestBeatIndex({ positions: [160, 110, 60, 10], x: 112, radius: 6 })).toBe(1);
	});

	test("an empty clip has nothing to pick", () => {
		expect(nearestBeatIndex({ positions: [], x: 5, radius: 6 })).toBeNull();
	});
});

describe("buildBeatTickPath", () => {
	test("draws ticks that the density guard would hide", () => {
		// 100 ticks 2 px apart are a smear for the guard, but a few picked ones must show.
		const all = Array.from({ length: 100 }, (_, index) => index * 2);
		expect(getBeatMarkerPath({ positions: all, top: 0, bottom: 9 })).toBeNull();
		expect(buildBeatTickPath({ positions: all.slice(50, 53), top: 0, bottom: 9 })).toBe(
			"M100 0V9M102 0V9M104 0V9",
		);
	});

	test("snaps to whole pixels and draws nothing without ticks", () => {
		expect(buildBeatTickPath({ positions: [10.4, 50.6], top: 3, bottom: 9 })).toBe("M10 3V9M51 3V9");
		expect(buildBeatTickPath({ positions: [], top: 0, bottom: 9 })).toBeNull();
	});
});
