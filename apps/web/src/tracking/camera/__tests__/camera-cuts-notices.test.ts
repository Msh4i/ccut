/**
 * Scene cuts, and the plain-language notices the user gets when a clip cannot
 * be followed well (plan tables M4 rows "scene cut", "low texture", "static
 * camera", "H.264 compression").
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cameraQualityStats, qualityNotices } from "../classify";
import { solvePin, trackedRange } from "../solve-pin";
import {
	analyse,
	boxBlurInPlace,
	cachedAnalysis,
	evaluateSimilarity,
	degradeLikeLowBitrate,
	FRAME_H,
	FRAME_W,
	getWorld,
	releaseCaches,
	report,
	summarizeRows,
	type Analysis,
} from "./camera-fixtures";

afterAll(releaseCaches);

const mainWorld = () => getWorld({ key: "main", seed: 1 });

function noticesOf({ analysis, f0 = 0 }: { analysis: Analysis; f0?: number }) {
	const solution = solvePin({ tracks: analysis.tracks, f0, model: "S", mode: "scene" });
	const stats = cameraQualityStats({ tracks: analysis.tracks, solution });
	report({
		label: "quality stats",
		values: { ...stats, "frames": analysis.tracks.frameCount },
	});
	return { solution, notices: qualityNotices({ tracks: analysis.tracks, solution }) };
}

/** One hand-held clip that cuts to another world at frame 150, used by two tests. */
const cutAtHundredFifty = () =>
	cachedAnalysis({
		key: "cut-150",
		make: () =>
			analyse({
				world: mainWorld(),
				options: {
					kind: "hand",
					frameCount: 180,
					seed: 5,
					cutAt: 150,
					worldAfterCut: getWorld({ key: "w9", seed: 9 }),
				},
			}),
	});

describe("scene cuts", () => {
	test("a switch to another world at frame 150 is found at frame 150, and only there", () => {
		const analysis = cutAtHundredFifty();
		expect(analysis.tracks.cuts).toEqual([150]);
		const [{ frame, ncc }] = analysis.tracks.stats.cutNcc;
		report({ label: "cut at 150", values: { frame, ncc } });
		expect(frame).toBe(150);
		// the plan measured -0.04 at the cut and 0.97-1.0 everywhere else
		expect(ncc).toBeLessThan(0.45);
	});

	test("a cut during a pan is found as well", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: {
				kind: "pan",
				frameCount: 90,
				seed: 5,
				cutAt: 60,
				worldAfterCut: getWorld({ key: "w9", seed: 9 }),
			},
		});
		expect(analysis.tracks.cuts).toEqual([60]);
	});

	test("a pin solved from before the cut stops at it, and the user is told", () => {
		const analysis = cutAtHundredFifty();
		const { solution, notices } = noticesOf({ analysis, f0: 20 });
		expect(solution.ok.slice(0, 150).every((v) => v === 1)).toBe(true);
		expect(solution.ok.slice(150).every((v) => v === 0)).toBe(true);
		expect(notices).toEqual([{ kind: "cut", frame: 150 }]);
	});
});

describe("notices", () => {
	test("a world with 6 percent of the detail: no-texture", () => {
		const world = getWorld({ key: "bare", seed: 3, texture: 0.06, shapes: 700 });
		const analysis = analyse({ world, options: { kind: "hand", frameCount: 60, seed: 5 } });
		const { solution, notices } = noticesOf({ analysis });
		expect(notices).toEqual([{ kind: "no-texture" }]);
		// the plan: 9 features, nothing solved
		expect(solution.ok.reduce((a, v) => a + v, 0)).toBeLessThan(0.5 * 60);
	});

	test("a camera that does not move: no-motion", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "static", frameCount: 45, seed: 5 },
		});
		expect(noticesOf({ analysis }).notices).toEqual([{ kind: "no-motion" }]);
	});

	test("a heavily compressed clip (emulated CRF 38): low-quality", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "hand", frameCount: 60, seed: 5 },
			mapFrame: ({ data, index }) =>
				degradeLikeLowBitrate({ data, width: FRAME_W, height: FRAME_H, seed: 1000 + index }),
		});
		expect(noticesOf({ analysis }).notices).toEqual([{ kind: "low-quality" }]);
	});

	test("the same camera move on a clean clip has nothing to report", () => {
		const analysis = analyse({
			world: mainWorld(),
			options: { kind: "hand", frameCount: 60, seed: 5 },
		});
		expect(noticesOf({ analysis }).notices).toEqual([]);
	});
});

describe("a frame the camera could not focus", () => {
	/** A hand-held clip with box-blurred frames at 30 and 70: every feature is lost on each. */
	const blurred = () =>
		cachedAnalysis({
			key: "blurred-30-70",
			make: () =>
				analyse({
					world: mainWorld(),
					options: { kind: "hand", frameCount: 100, seed: 5 },
					mapFrame: ({ data, index }) => {
						if (index === 30 || index === 70) {
							boxBlurInPlace({ data, width: FRAME_W, height: FRAME_H, radius: 6 });
						}
					},
				}),
		});

	test("every feature dies on the blurred frame, and no scene cut is invented", () => {
		const { tracks } = blurred();
		expect(tracks.cuts).toEqual([]);
		const live = (f: number) => tracks.liveOffsets[f + 1] - tracks.liveOffsets[f];
		expect(live(29)).toBeGreaterThan(70);
		expect(live(30)).toBeLessThan(10);
	});

	test("the pin picks up again within three frames of each blurred frame, from the first pin frame onward", () => {
		const analysis = blurred();
		const solution = solvePin({ tracks: analysis.tracks, f0: 10, model: "S", mode: "scene" });
		const lost = Array.from(solution.ok).flatMap((v, t) => (v === 0 ? [t] : []));
		report({ label: "lost frames after two blurred frames", values: { frames: lost.join(",") } });
		for (const blur of [30, 70]) {
			expect(lost.filter((t) => t >= blur - 1 && t <= blur + 8).length).toBeGreaterThan(0);
			for (let t = blur + 4; t <= Math.min(99, blur + 12); t++) expect(solution.ok[t]).toBe(2);
		}
		// nothing else is lost, and frames before the first gap are solved by an unbroken chain
		expect(lost.length).toBeLessThanOrEqual(8);
		for (let t = 0; t < 30; t++) expect(solution.ok[t]).toBe(1);
		expect(solution.ok[99]).toBe(2);
		expect(trackedRange({ tracks: analysis.tracks, solution })).toMatchObject({ first: 0, last: 99 });
	});

	test("the same from a pin after both blurs, going backward", () => {
		const analysis = blurred();
		const solution = solvePin({ tracks: analysis.tracks, f0: 90, model: "S", mode: "scene" });
		for (let t = 71; t <= 99; t++) expect(solution.ok[t]).toBe(1);
		for (const blur of [70, 30]) {
			for (let t = blur - 12; t <= blur - 4; t++) expect(solution.ok[t]).toBe(2);
		}
		expect(solution.ok[0]).toBe(2);
		expect(Array.from(solution.ok).filter((v) => v === 0).length).toBeLessThanOrEqual(8);
	});

	test("between the blurs the chain is unbroken and as accurate as ever", () => {
		const analysis = blurred();
		const solution = solvePin({ tracks: analysis.tracks, f0: 50, model: "S", mode: "scene" });
		const rows = evaluateSimilarity({ solution, truth: analysis.truth, pin: { x: 240, y: 135 } });
		const between = summarizeRows({ rows: rows.filter((r) => r.t >= 31 && r.t <= 69) });
		// no gap between the blurs: the chain is unbroken and as accurate as ever
		expect(between.cornerMax).toBeLessThan(0.6);
		for (let t = 31; t <= 69; t++) expect(solution.ok[t]).toBe(1);
	});

	test("the notice names the first lost frame and it is not a lack of texture", () => {
		const { solution, notices } = noticesOf({ analysis: blurred(), f0: 10 });
		const first = Array.from(solution.ok).findIndex((v) => v === 0);
		expect(notices).toEqual([{ kind: "lost", frame: first }]);
		expect(first).toBeGreaterThanOrEqual(29);
		expect(first).toBeLessThanOrEqual(31);
	});
});
