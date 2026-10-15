/**
 * A frame where every feature is lost (a blurred or flashed frame, a dropped
 * frame) used to freeze the pin for the rest of the clip: no track links the
 * frames on either side, and a frame that was held could not serve as the next
 * anchor. The solver now bridges the gap with the held map and says so (`ok`
 * is 2 after it). The pin's scene and the frames asked for bound the solution
 * (`range`, `trackedRange`), and a homography map always has `h33 = 1`.
 */
import { describe, expect, test } from "bun:test";
import { hApply } from "../homography";
import { createRng } from "../random";
import { solvePin, trackedRange } from "../solve-pin";
import type { PinModel } from "../types";
import { buildTracks, scatterPoints, type Point } from "./camera-fixtures";
import {
	homographyOf,
	motionFor,
	sceneAt,
	solveWith,
	specsFor,
	staggeredLife,
	truthFor,
	whole,
	worstError,
} from "./track-scenes";

type Warp = (t: number) => number;

const identity: Warp = (t) => t;

/** The scene seen at clip frame `t` is the scene of path frame `warp(t)`. */
function warpedMotion({ model, warp }: { model: PinModel; warp: Warp }) {
	return model === "S"
		? ({ t, p0 }: { t: number; p0: Point }) => sceneAt({ t: warp(t), p0 })
		: ({ t, p0 }: { t: number; p0: Point }) =>
				hApply({ h: homographyOf({ t: warp(t) }), x: p0.x, y: p0.y });
}

function warpedTruth({ model, warp }: { model: PinModel; warp: Warp }) {
	const truth = truthFor(model);
	return ({ f0, t, q }: { f0: number; t: number; q: Point }) =>
		truth({ f0: warp(f0), t: warp(t), q });
}

/** Tracks that live in the given inclusive frame spans, none in between. */
function spansTracks({
	frameCount,
	spans,
	model,
	warp = identity,
	seed = 1,
}: {
	frameCount: number;
	spans: [number, number][];
	model: PinModel;
	warp?: Warp;
	seed?: number;
}) {
	const specs = spans.flatMap(([start, end], k) =>
		specsFor({
			points: scatterPoints({ count: 70, seed: seed + k }),
			life: () => ({ start, end }),
			motion: warpedMotion({ model, warp }),
			frameCount,
		}),
	);
	return buildTracks({ frameCount, specs });
}

/** The camera stands still on frames 49 to 52 (the gap is frames 50-52), so a bridge over it is exact. */
const STILL_OVER_GAP: Warp = (t) => (t <= 49 ? t : t <= 52 ? 49 : t - 3);

const states = ({ ok, from, to }: { ok: Uint8Array; from: number; to: number }) =>
	Array.from(ok.slice(from, to + 1));
const filled = ({ value, length }: { value: number; length: number }) =>
	Array.from({ length }, () => value);

describe("a gap in the tracks is bridged with the held map", () => {
	for (const model of ["S", "H"] as const) {
		test(`model ${model}: forward over frames with no tracks, exact when the camera stood still`, () => {
			const tracks = spansTracks({
				frameCount: 100,
				// no feature is alive on frames 50 and 51; the new ones are first seen on 52
				spans: [
					[0, 49],
					[52, 99],
				],
				model,
				warp: STILL_OVER_GAP,
			});
			const solution = solveWith({ tracks, f0: 10, model });
			expect(states({ ok: solution.ok, from: 0, to: 49 })).toEqual(filled({ value: 1, length: 50 }));
			// nothing links 49 to the features born on 52, so frames 50-52 stay held ...
			expect(states({ ok: solution.ok, from: 50, to: 52 })).toEqual([0, 0, 0]);
			for (const t of [50, 51, 52]) {
				expect(Array.from(solution.maps.subarray(solution.stride * t, solution.stride * (t + 1)))).toEqual(
					Array.from(solution.maps.subarray(solution.stride * 49, solution.stride * 50)),
				);
			}
			// ... and from 53 on the pin follows the scene again, marked as "after a gap"
			expect(states({ ok: solution.ok, from: 53, to: 99 })).toEqual(filled({ value: 2, length: 47 }));
			expect(worstError({ solution, truth: warpedTruth({ model, warp: STILL_OVER_GAP }) })).toBeLessThan(1e-3);
		});

		test(`model ${model}: backward over the same gap`, () => {
			const tracks = spansTracks({
				frameCount: 100,
				spans: [
					[0, 49],
					[52, 99],
				],
				model,
				warp: STILL_OVER_GAP,
			});
			const solution = solveWith({ tracks, f0: 80, model });
			expect(states({ ok: solution.ok, from: 52, to: 99 })).toEqual(filled({ value: 1, length: 48 }));
			expect(states({ ok: solution.ok, from: 49, to: 51 })).toEqual([0, 0, 0]);
			expect(states({ ok: solution.ok, from: 0, to: 48 })).toEqual(filled({ value: 2, length: 49 }));
			expect(worstError({ solution, truth: warpedTruth({ model, warp: STILL_OVER_GAP }) })).toBeLessThan(1e-3);
		});
	}

	test("two gaps in one clip are both bridged, and everything after the first stays marked", () => {
		const warp: Warp = (t) => (t <= 29 ? t : t <= 32 ? 29 : t <= 69 ? t - 3 : t <= 72 ? 66 : t - 6);
		const tracks = spansTracks({
			frameCount: 100,
			spans: [
				[0, 29],
				[32, 69],
				[72, 99],
			],
			model: "S",
			warp,
		});
		const solution = solveWith({ tracks, f0: 5 });
		expect(states({ ok: solution.ok, from: 0, to: 29 })).toEqual(filled({ value: 1, length: 30 }));
		expect(states({ ok: solution.ok, from: 30, to: 32 })).toEqual([0, 0, 0]);
		expect(states({ ok: solution.ok, from: 33, to: 69 })).toEqual(filled({ value: 2, length: 37 }));
		expect(states({ ok: solution.ok, from: 70, to: 72 })).toEqual([0, 0, 0]);
		expect(states({ ok: solution.ok, from: 73, to: 99 })).toEqual(filled({ value: 2, length: 27 }));
		expect(worstError({ solution, truth: warpedTruth({ model: "S", warp }) })).toBeLessThan(1e-3);
	});

	test("a camera that did move during the gap is off by that motion and no more", () => {
		const tracks = spansTracks({
			frameCount: 100,
			spans: [
				[0, 49],
				[52, 99],
			],
			model: "S",
		});
		const solution = solveWith({ tracks, f0: 10 });
		expect(states({ ok: solution.ok, from: 53, to: 99 })).toEqual(filled({ value: 2, length: 47 }));
		// the scene path moves about 1.3 px per frame at the corners, 4 frames missed (49 -> 53)
		const error = worstError({ solution, truth: truthFor("S") });
		expect(error).toBeGreaterThan(1);
		expect(error).toBeLessThan(8);
	});

	test("without a way back the pin stays held to the end, and the range says so", () => {
		const tracks = spansTracks({ frameCount: 100, spans: [[0, 60]], model: "S" });
		const solution = solveWith({ tracks, f0: 10 });
		expect(states({ ok: solution.ok, from: 0, to: 60 })).toEqual(filled({ value: 1, length: 61 }));
		expect(states({ ok: solution.ok, from: 61, to: 99 })).toEqual(filled({ value: 0, length: 39 }));
		expect(trackedRange({ tracks, solution })).toEqual({
			first: 0,
			last: 60,
			firstEndedBy: "clip",
			lastEndedBy: "lost",
		});
	});

	test("a gap inside the range does not end it", () => {
		const tracks = spansTracks({
			frameCount: 100,
			spans: [
				[0, 49],
				[52, 99],
			],
			model: "S",
		});
		const solution = solveWith({ tracks, f0: 10 });
		expect(trackedRange({ tracks, solution })).toEqual({
			first: 0,
			last: 99,
			firstEndedBy: "clip",
			lastEndedBy: "clip",
		});
	});
});

describe("frames where every feature is wrong at once (tracks that go on afterwards)", () => {
	/** Every feature is somewhere else (up to 150 px off, each its own way) on the given frames only. */
	function glitchedTracks({ badFrames, warp = identity }: { badFrames: number[]; warp?: Warp }) {
		const random = createRng({ seed: 77 });
		const offsets = new Map<number, Point[]>(
			badFrames.map((t) => [t, Array.from({ length: 80 }, () => ({ x: (random() - 0.5) * 300, y: (random() - 0.5) * 300 }))]),
		);
		const motion = warpedMotion({ model: "S", warp });
		const points = scatterPoints({ count: 80, seed: 5 });
		return buildTracks({
			frameCount: 100,
			specs: points.map((p0, i) => ({
				start: 0,
				end: 99,
				positionAt: (t) => {
					const p = motion({ t, p0 });
					const off = offsets.get(t)?.[i];
					return off ? { x: p.x + off.x, y: p.y + off.y } : p;
				},
			})),
		});
	}

	test("one bad frame costs that frame only: the chain stays unbroken and exact", () => {
		const tracks = glitchedTracks({ badFrames: [40] });
		const solution = solveWith({ tracks, f0: 10 });
		expect(solution.ok[40]).toBe(0);
		expect(states({ ok: solution.ok, from: 0, to: 39 })).toEqual(filled({ value: 1, length: 40 }));
		// the frames after it are NOT marked as bridged: the tracks span the bad frame
		expect(states({ ok: solution.ok, from: 41, to: 99 })).toEqual(filled({ value: 1, length: 59 }));
		expect(Array.from(solution.maps.subarray(4 * 40, 4 * 41))).toEqual(
			Array.from(solution.maps.subarray(4 * 39, 4 * 40)),
		);
		expect(worstError({ solution, truth: truthFor("S") })).toBeLessThan(1e-3);
	});

	test("two bad frames in a row are bridged, exactly when the camera stood still over them", () => {
		const warp: Warp = (t) => (t <= 39 ? t : t <= 42 ? 39 : t - 3);
		const tracks = glitchedTracks({ badFrames: [40, 41], warp });
		const solution = solveWith({ tracks, f0: 10 });
		expect(states({ ok: solution.ok, from: 0, to: 39 })).toEqual(filled({ value: 1, length: 40 }));
		expect(states({ ok: solution.ok, from: 40, to: 42 })).toEqual([0, 0, 0]);
		expect(states({ ok: solution.ok, from: 43, to: 99 })).toEqual(filled({ value: 2, length: 57 }));
		expect(worstError({ solution, truth: warpedTruth({ model: "S", warp }) })).toBeLessThan(1e-3);
	});
});

describe("the pin's scene and the range asked for bound the solution", () => {
	const tracks = () =>
		buildTracks({
			frameCount: 100,
			cuts: [50],
			specs: [
				...specsFor({
					points: scatterPoints({ count: 70, seed: 1 }),
					life: () => ({ start: 0, end: 49 }),
					motion: motionFor("S"),
					frameCount: 100,
				}),
				...specsFor({
					points: scatterPoints({ count: 70, seed: 2 }),
					life: () => ({ start: 50, end: 99 }),
					motion: motionFor("S"),
					frameCount: 100,
				}),
			],
		});

	test("with no range the solution covers the scene of the pin frame", () => {
		const t = tracks();
		expect(solveWith({ tracks: t, f0: 20 }).range).toEqual({ lo: 0, hi: 49 });
		expect(solveWith({ tracks: t, f0: 70 }).range).toEqual({ lo: 50, hi: 99 });
	});

	test("a range keeps the solver off the rest of the clip: those frames are held and cost nothing", () => {
		const t = tracks();
		const solution = solvePin({ tracks: t, f0: 30, model: "S", mode: "scene", range: { lo: 25, hi: 40 } });
		expect(solution.range).toEqual({ lo: 25, hi: 40 });
		expect(states({ ok: solution.ok, from: 25, to: 40 })).toEqual(filled({ value: 1, length: 16 }));
		expect(states({ ok: solution.ok, from: 0, to: 24 })).toEqual(filled({ value: 0, length: 25 }));
		expect(states({ ok: solution.ok, from: 41, to: 99 })).toEqual(filled({ value: 0, length: 59 }));
		// held beyond the range at the map of the range's end
		expect(Array.from(solution.maps.subarray(4 * 45, 4 * 45 + 4))).toEqual(
			Array.from(solution.maps.subarray(4 * 40, 4 * 40 + 4)),
		);
		expect(Array.from(solution.maps.subarray(4 * 10, 4 * 10 + 4))).toEqual(
			Array.from(solution.maps.subarray(4 * 25, 4 * 25 + 4)),
		);
	});

	test("a range is cut at the scene's edge as well", () => {
		const t = tracks();
		const solution = solvePin({ tracks: t, f0: 30, model: "S", mode: "scene", range: { lo: 10, hi: 80 } });
		expect(solution.range).toEqual({ lo: 10, hi: 49 });
	});

	test("a range must hold the pin frame and lie in the clip", () => {
		const t = tracks();
		for (const range of [
			{ lo: 31, hi: 40 },
			{ lo: 10, hi: 29 },
			{ lo: 40, hi: 10 },
			{ lo: -1, hi: 40 },
			{ lo: 10, hi: 100 },
			{ lo: 2.5, hi: 40 },
		]) {
			expect(() => solvePin({ tracks: t, f0: 30, model: "S", mode: "scene", range })).toThrow(RangeError);
		}
	});

	test("trackedRange reports what ended each side: the cut, the range, the clip", () => {
		const t = tracks();
		expect(trackedRange({ tracks: t, solution: solveWith({ tracks: t, f0: 20 }) })).toEqual({
			first: 0,
			last: 49,
			firstEndedBy: "clip",
			lastEndedBy: "cut",
		});
		expect(trackedRange({ tracks: t, solution: solveWith({ tracks: t, f0: 70 }) })).toEqual({
			first: 50,
			last: 99,
			firstEndedBy: "cut",
			lastEndedBy: "clip",
		});
		const limited = solvePin({ tracks: t, f0: 30, model: "S", mode: "scene", range: { lo: 25, hi: 40 } });
		expect(trackedRange({ tracks: t, solution: limited })).toEqual({
			first: 25,
			last: 40,
			firstEndedBy: "clip",
			lastEndedBy: "clip",
		});
	});

	test("trackedRange of a pin with nothing around it is the pin frame alone", () => {
		const empty = buildTracks({ frameCount: 20, specs: [] });
		const solution = solveWith({ tracks: empty, f0: 7 });
		expect(trackedRange({ tracks: empty, solution })).toEqual({
			first: 7,
			last: 7,
			firstEndedBy: "lost",
			lastEndedBy: "lost",
		});
	});

	test("trackedRange refuses a solution of another clip", () => {
		const t = tracks();
		const other = buildTracks({ frameCount: 20, specs: [] });
		expect(() => trackedRange({ tracks: other, solution: solveWith({ tracks: t, f0: 20 }) })).toThrow(RangeError);
	});
});

describe("homography maps are normalised", () => {
	test("h33 is exactly 1 on every frame, however many times the solver re-anchored", () => {
		const frameCount = 200;
		const count = 300;
		const tracks = buildTracks({
			frameCount,
			specs: specsFor({
				points: scatterPoints({ count, seed: 3 }),
				life: staggeredLife({ frameCount, count }),
				motion: motionFor("H"),
				frameCount,
			}),
		});
		const solution = solveWith({ tracks, f0: 0, model: "H" });
		expect(solution.hops).toBeGreaterThan(5);
		for (let t = 0; t < frameCount; t++) expect(solution.maps[9 * t + 8]).toBe(1);
	});

	test("also across a bridged gap, and on held frames", () => {
		const tracks = spansTracks({
			frameCount: 100,
			spans: [
				[0, 49],
				[52, 99],
			],
			model: "H",
			warp: STILL_OVER_GAP,
		});
		const solution = solveWith({ tracks, f0: 10, model: "H" });
		for (let t = 0; t < 100; t++) expect(solution.maps[9 * t + 8]).toBe(1);
	});
});

describe("a clip without a gap", () => {
	test("is solved exactly as before, every frame state 1", () => {
		const tracks = buildTracks({
			frameCount: 60,
			specs: specsFor({
				points: scatterPoints({ count: 60, seed: 9 }),
				life: whole(60),
				motion: motionFor("S"),
				frameCount: 60,
			}),
		});
		const solution = solveWith({ tracks, f0: 30 });
		expect(states({ ok: solution.ok, from: 0, to: 59 })).toEqual(filled({ value: 1, length: 60 }));
		expect(worstError({ solution, truth: truthFor("S") })).toBeLessThan(1e-3);
	});
});
