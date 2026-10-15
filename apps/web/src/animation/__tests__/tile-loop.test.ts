import { describe, expect, test } from "bun:test";
import { TILE_REST_MS, tileProgressAt } from "@/animation/tiles/loop";

const PLAY = 500;
const REST = 700;

function loopAt({ elapsedMs, phase }: { elapsedMs: number; phase: "in" | "out" }) {
	return tileProgressAt({ elapsedMs, playMs: PLAY, restMs: REST, phase, repeat: true });
}

describe("tileProgressAt: a loop plays the phase, then pauses at rest", () => {
	test("In plays 0 to 1 over the duration, then rests at 1", () => {
		expect(loopAt({ elapsedMs: 0, phase: "in" }).progress).toBe(0);
		expect(loopAt({ elapsedMs: 125, phase: "in" }).progress).toBe(0.25);
		expect(loopAt({ elapsedMs: 250, phase: "in" }).progress).toBe(0.5);
		expect(loopAt({ elapsedMs: 500, phase: "in" }).progress).toBe(1);
		expect(loopAt({ elapsedMs: 1199, phase: "in" }).progress).toBe(1);
	});

	test("Out plays 0 to 1 as well, then rests at 0, where an Out clip rests", () => {
		expect(loopAt({ elapsedMs: 0, phase: "out" }).progress).toBe(0);
		expect(loopAt({ elapsedMs: 250, phase: "out" }).progress).toBe(0.5);
		expect(loopAt({ elapsedMs: 499, phase: "out" }).progress).toBeCloseTo(0.998, 3);
		expect(loopAt({ elapsedMs: 500, phase: "out" }).progress).toBe(0);
		expect(loopAt({ elapsedMs: 1199, phase: "out" }).progress).toBe(0);
	});

	test("the next loop starts after duration + pause, and repeats the same way", () => {
		for (const phase of ["in", "out"] as const) {
			expect(loopAt({ elapsedMs: 1200, phase }).progress).toBe(0);
			expect(loopAt({ elapsedMs: 1200 + 250, phase }).progress).toBe(0.5);
			expect(loopAt({ elapsedMs: 3 * 1200 + 125, phase }).progress).toBe(0.25);
		}
	});

	test("a loop is never done", () => {
		for (const elapsedMs of [0, 499, 500, 5000, 1e9]) {
			expect(loopAt({ elapsedMs, phase: "in" }).isDone).toBe(false);
		}
	});

	test("any duration: 2 s is half way at 1 s", () => {
		expect(
			tileProgressAt({ elapsedMs: 1000, playMs: 2000, restMs: REST, phase: "in", repeat: true }).progress,
		).toBe(0.5);
	});

	test("the pause at rest is a short, positive time", () => {
		expect(TILE_REST_MS).toBeGreaterThan(0);
		expect(TILE_REST_MS).toBeLessThanOrEqual(1000);
	});
});

describe("tileProgressAt: played once (reduced motion, on hover or focus)", () => {
	test("plays 0 to 1 and is done at the end, without a pause", () => {
		const once = (elapsedMs: number) =>
			tileProgressAt({ elapsedMs, playMs: PLAY, restMs: REST, phase: "in", repeat: false });
		expect(once(0)).toEqual({ progress: 0, isDone: false });
		expect(once(250)).toEqual({ progress: 0.5, isDone: false });
		expect(once(500)).toEqual({ progress: 1, isDone: true });
		expect(once(5000)).toEqual({ progress: 1, isDone: true });
	});

	test("Out played once ends at its last frame", () => {
		expect(
			tileProgressAt({ elapsedMs: 600, playMs: PLAY, restMs: REST, phase: "out", repeat: false }),
		).toEqual({ progress: 1, isDone: true });
	});
});

describe("tileProgressAt never returns NaN", () => {
	const BAD = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

	test("a zero or broken duration shows the rest pose; once is done at once", () => {
		for (const playMs of BAD) {
			for (const repeat of [true, false]) {
				const atIn = tileProgressAt({ elapsedMs: 300, playMs, restMs: REST, phase: "in", repeat });
				const atOut = tileProgressAt({ elapsedMs: 300, playMs, restMs: REST, phase: "out", repeat });
				expect(atIn.progress).toBe(1);
				expect(atOut.progress).toBe(0);
				expect(atIn.isDone).toBe(!repeat);
			}
		}
	});

	test("a broken pause is no pause", () => {
		for (const restMs of BAD) {
			const at = tileProgressAt({ elapsedMs: 750, playMs: PLAY, restMs, phase: "in", repeat: true });
			expect(at.progress).toBe(0.5);
		}
	});

	test("a broken elapsed time is the start", () => {
		for (const elapsedMs of [-100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			for (const repeat of [true, false]) {
				const at = tileProgressAt({ elapsedMs, playMs: PLAY, restMs: REST, phase: "in", repeat });
				expect(at).toEqual({ progress: 0, isDone: false });
			}
		}
	});

	test("both broken at once", () => {
		const at = tileProgressAt({
			elapsedMs: Number.NaN,
			playMs: 0,
			restMs: Number.NaN,
			phase: "out",
			repeat: true,
		});
		expect(Number.isNaN(at.progress)).toBe(false);
	});
});
