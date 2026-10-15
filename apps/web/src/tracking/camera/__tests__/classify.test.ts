import { describe, expect, test } from "bun:test";
import {
	cameraQualityStats,
	classifyPin,
	hasLowQualityResidual,
	perspectiveSuspected,
	qualityNotices,
	residualQuality,
} from "../classify";
import { createRng, gaussianSample } from "../random";
import { solvePin } from "../solve-pin";
import type { FeatureTracks, PinSolution } from "../types";
import {
	buildTracks,
	FRAME_H,
	FRAME_W,
	scatterPoints,
	type Point,
	type TrackSpec,
} from "./camera-fixtures";

const C: Point = { x: FRAME_W / 2, y: FRAME_H / 2 };

function still(): ({ t, p0 }: { t: number; p0: Point }) => Point {
	return ({ p0 }) => p0;
}

function trackSet({
	frameCount,
	points,
	motion,
	noise = 0,
	seed = 1,
	start = 0,
	end = frameCount - 1,
}: {
	frameCount: number;
	points: Point[];
	motion: ({ t, p0 }: { t: number; p0: Point }) => Point;
	noise?: number;
	seed?: number;
	start?: number;
	end?: number;
}): TrackSpec[] {
	const random = createRng({ seed });
	return points.map((p0) => ({
		start,
		end: Math.min(end, frameCount - 1),
		positionAt: (t) => {
			const p = motion({ t, p0 });
			return {
				x: p.x + (noise ? noise * gaussianSample({ random }) : 0),
				y: p.y + (noise ? noise * gaussianSample({ random }) : 0),
			};
		},
	}));
}

function sceneSolution({ tracks, f0 = 0 }: { tracks: FeatureTracks; f0?: number }) {
	return solvePin({ tracks, f0, model: "S", mode: "scene" });
}

/** The whole frame drifts linearly from nothing to the given totals over the clip. */
function drift({
	frameCount,
	shift = 0,
	scale = 0,
	rotationDeg = 0,
}: {
	frameCount: number;
	shift?: number;
	scale?: number;
	rotationDeg?: number;
}): ({ t, p0 }: { t: number; p0: Point }) => Point {
	return ({ t, p0 }) => {
		const u = t / (frameCount - 1);
		const s = 1 + scale * u;
		const th = (rotationDeg * u * Math.PI) / 180;
		const dx = p0.x - C.x;
		const dy = p0.y - C.y;
		return {
			x: C.x + s * (Math.cos(th) * dx - Math.sin(th) * dy) + shift * u,
			y: C.y + s * (Math.sin(th) * dx + Math.cos(th) * dy),
		};
	};
}

describe("classifyPin", () => {
	const frameCount = 70;
	const pin: Point = { x: 300, y: 100 };

	function scene({
		objectSpeed,
		objectStart = 0,
		objectLife = frameCount - 1,
		objectCount = 6,
	}: {
		objectSpeed: number;
		objectStart?: number;
		objectLife?: number;
		objectCount?: number;
	}) {
		const bg = scatterPoints({ count: 70, seed: 5 }).filter(
			(p) => Math.hypot(p.x - pin.x, p.y - pin.y) > 70,
		);
		const near = scatterPoints({ count: objectCount, seed: 6, margin: 0 }).map((p) => ({
			x: pin.x + ((p.x % 40) - 20),
			y: pin.y + ((p.y % 40) - 20),
		}));
		return buildTracks({
			frameCount,
			specs: [
				...trackSet({ frameCount, points: bg, motion: still() }),
				...trackSet({
					frameCount,
					points: near,
					motion: ({ t, p0 }) => ({ x: p0.x + objectSpeed * t, y: p0.y }),
					start: objectStart,
					end: objectLife,
				}),
			],
		});
	}

	function classify({
		tracks,
		at = pin,
		f0 = 20,
		options,
	}: {
		tracks: FeatureTracks;
		at?: Point;
		f0?: number;
		options?: Parameters<typeof classifyPin>[0]["options"];
	}) {
		return classifyPin({ tracks, solution: sceneSolution({ tracks, f0 }), pin: at, options });
	}

	test("a pin on something that moves against the scene is an object", () => {
		const result = classify({ tracks: scene({ objectSpeed: 0.3 }) });
		expect(result.isObject).toBe(true);
		expect(result.velocity).toBeCloseTo(0.3, 2);
		expect(result.n).toBe(5);
	});

	test("a pin on the background is not", () => {
		const result = classify({ tracks: scene({ objectSpeed: 0.3 }), at: { x: 90, y: 200 } });
		expect(result.isObject).toBe(false);
		expect(result.velocity).toBeLessThan(0.01);
		expect(result.n).toBeGreaterThanOrEqual(3);
	});

	test("drift slower than a tenth of a pixel per frame is not an object", () => {
		expect(classify({ tracks: scene({ objectSpeed: 0.06 }) }).isObject).toBe(false);
		expect(classify({ tracks: scene({ objectSpeed: 0.14 }) }).isObject).toBe(true);
	});

	test("the speed threshold can be moved", () => {
		const tracks = scene({ objectSpeed: 0.3 });
		expect(classify({ tracks, options: { speedThreshold: 0.4 } }).isObject).toBe(false);
		expect(classify({ tracks, options: { speedThreshold: 0.05 } }).isObject).toBe(true);
	});

	test("stays quiet with fewer than three features near the pin", () => {
		const result = classify({ tracks: scene({ objectSpeed: 0.3, objectCount: 2 }) });
		expect(result.isObject).toBe(false);
		expect(result.velocity).toBe(0);
		expect(result.n).toBeLessThan(3);
	});

	test("ignores features that did not live ten frames from the pin frame", () => {
		// alive on frames 15..27: 7 frames ahead of the pin frame 20, 5 behind it
		const result = classify({
			tracks: scene({ objectSpeed: 0.3, objectStart: 15, objectLife: 27 }),
		});
		expect(result.isObject).toBe(false);
		expect(result.n).toBeLessThan(3);
	});

	test("reads a pin at the end of the clip backwards", () => {
		const result = classify({ tracks: scene({ objectSpeed: 0.3 }), f0: frameCount - 1 });
		expect(result.isObject).toBe(true);
		expect(result.velocity).toBeCloseTo(0.3, 2);
	});

	test("needs the scene solution to be a scene solution of the same clip", () => {
		const tracks = scene({ objectSpeed: 0.3 });
		const wrongFrames = sceneSolution({ tracks: buildTracks({ frameCount: 20, specs: [] }), f0: 0 });
		expect(() => classifyPin({ tracks, solution: wrongFrames, pin })).toThrow();
	});
});

function solutionWithResiduals({ rms, nin = 50 }: { rms: number[]; nin?: number }): PinSolution {
	const frameCount = rms.length + 1;
	return {
		model: "S",
		mode: "scene",
		f0: 0,
		frameCount,
		range: { lo: 0, hi: frameCount - 1 },
		stride: 4,
		maps: new Float64Array(4 * frameCount),
		ok: Uint8Array.from({ length: frameCount }, () => 1),
		nin: Int32Array.from({ length: frameCount }, (_, t) => (t === 0 ? 0 : nin)),
		rms: Float64Array.from([0, ...rms]),
		hops: 0,
	};
}

describe("perspectiveSuspected", () => {
	test("looks at the 90th percentile of the residual rms of the solved frames", () => {
		const calm = [...Array(91).fill(0.3), ...Array(9).fill(0.9)];
		const bumpy = [...Array(89).fill(0.3), ...Array(11).fill(0.9)];
		const a = perspectiveSuspected({ solution: solutionWithResiduals({ rms: calm }) });
		const b = perspectiveSuspected({ solution: solutionWithResiduals({ rms: bumpy }) });
		expect(a.suspected).toBe(false);
		expect(a.p90).toBeCloseTo(0.3, 6);
		expect(b.suspected).toBe(true);
		expect(b.p90).toBeCloseTo(0.9, 6);
	});

	test("the limit is 0.55 px", () => {
		const under = solutionWithResiduals({ rms: Array(40).fill(0.549) });
		const over = solutionWithResiduals({ rms: Array(40).fill(0.551) });
		expect(perspectiveSuspected({ solution: under }).suspected).toBe(false);
		expect(perspectiveSuspected({ solution: over }).suspected).toBe(true);
		expect(perspectiveSuspected({ solution: over, threshold: 0.6 }).suspected).toBe(false);
	});

	test("held frames and the pin frame do not count", () => {
		const solution = solutionWithResiduals({ rms: Array(40).fill(0.2) });
		for (let t = 20; t < 41; t++) {
			solution.ok[t] = 0;
			solution.rms[t] = 0;
			solution.nin[t] = 0;
		}
		const r = perspectiveSuspected({ solution });
		expect(r.p90).toBeCloseTo(0.2, 6);
		expect(r.suspected).toBe(false);
	});

	test("with nothing solved there is nothing to suspect", () => {
		const solution = solutionWithResiduals({ rms: [] });
		expect(perspectiveSuspected({ solution })).toEqual({ suspected: false, p90: 0 });
	});

	test("is a statement about the similarity fit only", () => {
		const tracks = buildTracks({ frameCount: 5, specs: [] });
		const h = solvePin({ tracks, f0: 0, model: "H", mode: "scene" });
		expect(() => perspectiveSuspected({ solution: h })).toThrow();
	});
});

describe("hasLowQualityResidual (the quality of the model that is written, whichever it is)", () => {
	const tracksOf = ({ frameCount }: { frameCount: number }) => buildTracks({ frameCount, specs: [] });

	test("the median residual against the 0.6 px line, for a similarity and a homography alike", () => {
		const calm = solutionWithResiduals({ rms: Array(40).fill(0.599) });
		const rough = solutionWithResiduals({ rms: Array(40).fill(0.601) });
		// "above 0.6": 0.6 itself is still fine
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: solutionWithResiduals({ rms: Array(40).fill(0.6) }) })).toBe(false);
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: calm })).toBe(false);
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: rough })).toBe(true);
		// the homography has 9 numbers per frame, but the residuals read the same way
		const homography: PinSolution = { ...rough, model: "H", stride: 9, maps: new Float64Array(9 * 41) };
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: homography })).toBe(true);
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: { ...calm, model: "H", stride: 9, maps: new Float64Array(9 * 41) } })).toBe(false);
	});

	test("it is the median, so a few bad frames do not make a clip low quality, and a bad half does", () => {
		const fewBad = solutionWithResiduals({ rms: [...Array(35).fill(0.2), ...Array(5).fill(2)] });
		const halfBad = solutionWithResiduals({ rms: [...Array(19).fill(0.2), ...Array(21).fill(2)] });
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: fewBad })).toBe(false);
		expect(hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution: halfBad })).toBe(true);
	});

	test("only the window counts, and nothing solved is not low quality", () => {
		const rms = [...Array(20).fill(0.2), ...Array(20).fill(2)];
		const solution = solutionWithResiduals({ rms });
		const tracks = tracksOf({ frameCount: 41 });
		expect(hasLowQualityResidual({ tracks, solution, window: { first: 1, last: 20 } })).toBe(false);
		expect(hasLowQualityResidual({ tracks, solution, window: { first: 21, last: 40 } })).toBe(true);
		const none = solutionWithResiduals({ rms: Array(40).fill(2) });
		none.ok.fill(0);
		expect(hasLowQualityResidual({ tracks, solution: none })).toBe(false);
	});

	test("it agrees with the notice qualityNotices gives for the similarity", () => {
		const tracks = buildTracks({
			frameCount: 60,
			specs: trackSet({ frameCount: 60, points: scatterPoints({ count: 70, seed: 11 }), motion: ({ t, p0 }) => ({ x: p0.x + 0.5 * t, y: p0.y }), noise: 0.8, seed: 4 }),
		});
		const solution = sceneSolution({ tracks });
		const warned = qualityNotices({ tracks, solution }).some((notice) => notice.kind === "low-quality");
		expect(warned).toBe(true);
		expect(hasLowQualityResidual({ tracks, solution })).toBe(warned);
	});

	test("a window that is not in the clip is refused, as for the notices", () => {
		const solution = solutionWithResiduals({ rms: Array(40).fill(0.2) });
		expect(() => hasLowQualityResidual({ tracks: tracksOf({ frameCount: 41 }), solution, window: { first: 5, last: 99 } })).toThrow(RangeError);
	});
});

describe("residualQuality (good, low, or no data: 'no data' must not pass for 'good')", () => {
	const tracks = buildTracks({ frameCount: 41, specs: [] });

	test("good and low follow the 0.6 px line, exactly like hasLowQualityResidual", () => {
		expect(residualQuality({ tracks, solution: solutionWithResiduals({ rms: Array(40).fill(0.6) }) })).toBe("good");
		expect(residualQuality({ tracks, solution: solutionWithResiduals({ rms: Array(40).fill(0.601) }) })).toBe("low");
	});

	test("a solution with nothing solved is 'unknown', not 'good' (a notice must not be dropped on no evidence)", () => {
		const none = solutionWithResiduals({ rms: Array(40).fill(0.1) });
		none.ok.fill(0);
		expect(residualQuality({ tracks, solution: none })).toBe("unknown");
		// the existing boolean keeps meaning "known to be low": unknown is not low either
		expect(hasLowQualityResidual({ tracks, solution: none })).toBe(false);
	});

	test("a window with no solved frame is 'unknown' even if other frames are solved", () => {
		const solution = solutionWithResiduals({ rms: Array(40).fill(0.1) });
		for (let t = 21; t <= 40; t++) solution.ok[t] = 0;
		expect(residualQuality({ tracks, solution, window: { first: 1, last: 20 } })).toBe("good");
		expect(residualQuality({ tracks, solution, window: { first: 21, last: 40 } })).toBe("unknown");
	});

	describe("a homography on few features over-fits: its low residual is not evidence of good quality", () => {
		const asHomography = (solution: PinSolution): PinSolution => ({
			...solution,
			model: "H",
			stride: 9,
			maps: new Float64Array(9 * solution.frameCount),
		});
		const homographyOf = ({ rms, nin }: { rms: number; nin: number }) =>
			asHomography(solutionWithResiduals({ rms: Array(40).fill(rms), nin }));

		test("a low residual from 10 inliers is 'unknown' (8 degrees of freedom fit 10 points almost exactly)", () => {
			const few = homographyOf({ rms: 0.3, nin: 10 });
			expect(residualQuality({ tracks, solution: few })).toBe("unknown");
			// unknown is not low either: the boolean keeps meaning "known to be low"
			expect(hasLowQualityResidual({ tracks, solution: few })).toBe(false);
		});

		test("the line is MIN_H_INLIERS_FOR_QUALITY = 20 median inliers: 19 is unknown, 20 and 40 are good", () => {
			expect(residualQuality({ tracks, solution: homographyOf({ rms: 0.3, nin: 19 }) })).toBe("unknown");
			expect(residualQuality({ tracks, solution: homographyOf({ rms: 0.3, nin: 20 }) })).toBe("good");
			expect(residualQuality({ tracks, solution: homographyOf({ rms: 0.3, nin: 40 }) })).toBe("good");
		});

		test("a residual that is high even with the over-fit stays 'low': the noise is at least that large", () => {
			expect(residualQuality({ tracks, solution: homographyOf({ rms: 0.9, nin: 10 }) })).toBe("low");
			expect(residualQuality({ tracks, solution: homographyOf({ rms: 0.9, nin: 40 }) })).toBe("low");
		});

		test("a similarity is not subject to the rule: it has 4 degrees of freedom and keeps its verdict on few inliers", () => {
			expect(residualQuality({ tracks, solution: solutionWithResiduals({ rms: Array(40).fill(0.3), nin: 3 }) })).toBe("good");
			expect(residualQuality({ tracks, solution: solutionWithResiduals({ rms: Array(40).fill(0.9), nin: 3 }) })).toBe("low");
		});

		test("it is the median inlier count of the window's solved frames: a few thin frames do not decide", () => {
			const mostlyDense = homographyOf({ rms: 0.3, nin: 40 });
			for (let t = 36; t <= 40; t++) mostlyDense.nin[t] = 8;
			expect(residualQuality({ tracks, solution: mostlyDense })).toBe("good");
			const mostlyThin = homographyOf({ rms: 0.3, nin: 8 });
			for (let t = 36; t <= 40; t++) mostlyThin.nin[t] = 40;
			expect(residualQuality({ tracks, solution: mostlyThin })).toBe("unknown");
		});

		test("only the window counts, and frames that were not solved have no inlier count to speak of", () => {
			const solution = homographyOf({ rms: 0.3, nin: 40 });
			for (let t = 21; t <= 40; t++) solution.nin[t] = 8;
			expect(residualQuality({ tracks, solution, window: { first: 1, last: 20 } })).toBe("good");
			expect(residualQuality({ tracks, solution, window: { first: 21, last: 40 } })).toBe("unknown");
			// unsolved frames carry nin 0: they must not drag a dense window's median down
			const gaps = homographyOf({ rms: 0.3, nin: 40 });
			for (let t = 1; t <= 40; t += 2) {
				gaps.ok[t] = 0;
				gaps.nin[t] = 0;
			}
			expect(residualQuality({ tracks, solution: gaps })).toBe("good");
		});
	});
});

describe("camera quality", () => {
	const frameCount = 60;
	const points = scatterPoints({ count: 70, seed: 11 });

	function notices({
		motion,
		noise = 0.03,
		pointsUsed = points,
		cuts,
		classification,
		f0 = 0,
		window,
	}: {
		motion: ({ t, p0 }: { t: number; p0: Point }) => Point;
		noise?: number;
		pointsUsed?: Point[];
		cuts?: number[];
		classification?: Parameters<typeof qualityNotices>[0]["classification"];
		f0?: number;
		window?: { first: number; last: number };
	}) {
		const tracks = buildTracks({
			frameCount,
			cuts,
			specs: trackSet({ frameCount, points: pointsUsed, motion, noise, seed: 4 }),
		});
		const solution = sceneSolution({ tracks, f0 });
		const list = qualityNotices({ tracks, solution, classification, window });
		return {
			list,
			kinds: list.map((n) => n.kind),
			stats: cameraQualityStats({ tracks, solution, window }),
		};
	}

	/** Features alive in the given spans only (a gap in between: no track links the two sides). */
	function gapNotices({
		spans,
		f0,
		window,
	}: {
		spans: [number, number][];
		f0: number;
		window?: { first: number; last: number };
	}) {
		const specs = spans.flatMap(([start, end], k) =>
			trackSet({
				frameCount,
				points: scatterPoints({ count: 70, seed: 20 + k }),
				motion: MOVING,
				noise: 0.03,
				seed: 30 + k,
				start,
				end,
			}),
		);
		const tracks = buildTracks({ frameCount, specs });
		const solution = sceneSolution({ tracks, f0 });
		return {
			list: qualityNotices({ tracks, solution, window }),
			stats: cameraQualityStats({ tracks, solution, window }),
		};
	}

	const MOVING = drift({ frameCount, shift: 40, scale: 0.08, rotationDeg: 3 });

	test("a sharp clip with a moving camera has nothing to report", () => {
		const { list, stats } = notices({ motion: MOVING });
		expect(list).toEqual([]);
		expect(stats.medianLive).toBe(70);
		expect(stats.solvedFraction).toBe(1);
		expect(stats.medianResidual).toBeLessThan(0.15);
	});

	test("too few features: no-texture, and nothing else is said about a solution that means nothing", () => {
		const { list, stats } = notices({ motion: still(), pointsUsed: points.slice(0, 6) });
		expect(stats.medianLive).toBe(6);
		expect(list).toEqual([{ kind: "no-texture" }]);
	});

	test("no-texture is about the features only: plenty of them that cannot be solved are a loss, not a lack of texture", () => {
		const bunched = points.map((p) => ({ x: 100 + (p.x % 20), y: 80 + (p.y % 20) }));
		const { list, stats } = notices({ motion: MOVING, pointsUsed: bunched });
		expect(stats.medianLive).toBe(70);
		expect(stats.solvedFraction).toBeLessThan(0.5);
		expect(list).toEqual([{ kind: "lost", frame: 1 }]);
	});

	test("a camera that does not move: no-motion", () => {
		const { kinds, stats } = notices({ motion: still() });
		expect(kinds).toEqual(["no-motion"]);
		expect(stats.maxShift).toBeLessThan(0.2);
	});

	test("no-motion needs shift under 1.5 px, scale under 0.5 percent and rotation under 0.3 degrees", () => {
		const quiet = (extra: { shift?: number; scale?: number; rotationDeg?: number }) =>
			notices({ motion: drift({ frameCount, ...extra }) }).kinds;
		expect(quiet({ shift: 1.0, scale: 0.003, rotationDeg: 0.2 })).toEqual(["no-motion"]);
		expect(quiet({ shift: 2.5 })).toEqual([]);
		expect(quiet({ scale: 0.012 })).toEqual([]);
		expect(quiet({ rotationDeg: 0.6 })).toEqual([]);
	});

	test("the picture centre is ((w - 1) / 2, (h - 1) / 2): a zoom about it moves nothing", () => {
		// 1.3x about the geometric centre of a 480 x 270 frame, in pixel index coordinates
		const zoom = ({ t, p0 }: { t: number; p0: Point }): Point => {
			const k = 1 + (0.3 * t) / (frameCount - 1);
			return { x: 239.5 + k * (p0.x - 239.5), y: 134.5 + k * (p0.y - 134.5) };
		};
		const { stats, kinds } = notices({ motion: zoom });
		expect(stats.maxScaleDeviation).toBeGreaterThan(0.25);
		// the other convention (w / 2, h / 2) would put it at 0.2 px
		expect(stats.maxShift).toBeLessThan(0.05);
		expect(kinds).toEqual([]);
	});

	test("noisy tracks (a heavily compressed clip) warn low-quality, clean ones do not", () => {
		expect(notices({ motion: MOVING, noise: 0.8 }).kinds).toEqual(["low-quality"]);
		expect(notices({ motion: MOVING, noise: 0.8 }).stats.medianResidual).toBeGreaterThan(0.6);
		expect(notices({ motion: MOVING, noise: 0.15 }).kinds).toEqual([]);
	});

	test("a short scene between cuts is judged on its own frames, not on the whole clip", () => {
		// the pin's scene is frames 0-19 of 60: solving all of them is a full success
		const first = trackSet({ frameCount, points, motion: MOVING, noise: 0.03, seed: 4, end: 19 });
		const second = trackSet({
			frameCount,
			points: scatterPoints({ count: 70, seed: 12 }),
			motion: MOVING,
			noise: 0.03,
			seed: 5,
			start: 20,
		});
		const tracks = buildTracks({ frameCount, cuts: [20], specs: [...first, ...second] });
		const solution = sceneSolution({ tracks, f0: 5 });
		const stats = cameraQualityStats({ tracks, solution });
		expect(stats.solvedFraction).toBe(1);
		expect(stats.medianLive).toBe(70);
		expect(qualityNotices({ tracks, solution })).toEqual([{ kind: "cut", frame: 20 }]);
	});

	describe("cuts", () => {
		test("a cut that ends the pin's scene is reported with its frame", () => {
			expect(notices({ motion: MOVING, cuts: [40] }).list).toEqual([{ kind: "cut", frame: 40 }]);
		});

		test("so is one that starts it, but only when the window reaches back before it", () => {
			const both = notices({ motion: MOVING, cuts: [20], f0: 40 });
			expect(both.list).toEqual([{ kind: "cut", frame: 20 }]);
			const after = notices({ motion: MOVING, cuts: [20], f0: 40, window: { first: 25, last: 59 } });
			expect(after.list).toEqual([]);
		});

		test("a cut that does not bound the pin's scene is none of its business", () => {
			// scene of frame 30 is 20..44; the cut at 55 ends a later scene
			const { list } = notices({ motion: MOVING, cuts: [20, 45, 55], f0: 30 });
			expect(list).toEqual([
				{ kind: "cut", frame: 20 },
				{ kind: "cut", frame: 45 },
			]);
		});

		test("a window that ends before the cut does not see it", () => {
			const { list } = notices({ motion: MOVING, cuts: [40], window: { first: 0, last: 30 } });
			expect(list).toEqual([]);
		});
	});

	describe("lost frames", () => {
		test("a gap with no way across is reported at its first frame, and is not a lack of texture", () => {
			const { list, stats } = gapNotices({
				spans: [
					[0, 29],
					[33, 59],
				],
				f0: 5,
			});
			expect(list).toEqual([{ kind: "lost", frame: 30 }]);
			// frames 30-33 are held, the rest solved (frames after the gap count as solved)
			expect(stats.solvedFraction).toBeCloseTo(56 / 60, 6);
			expect(stats.medianLive).toBe(70);
		});

		test("with two gaps the one nearest the pin frame is the one named", () => {
			const spans: [number, number][] = [
				[0, 19],
				[22, 39],
				[42, 59],
			];
			// frames 20-22 and 40-42 are lost going forward; going backward the lost ones are 39-41 and 19-21
			expect(gapNotices({ spans, f0: 5 }).list).toEqual([{ kind: "lost", frame: 20 }]);
			expect(gapNotices({ spans, f0: 45 }).list).toEqual([{ kind: "lost", frame: 41 }]);
			// from the middle scene the loss behind (frame 21, 9 away) is nearer than the one ahead (frame 40, 10 away)
			expect(gapNotices({ spans, f0: 30 }).list).toEqual([{ kind: "lost", frame: 21 }]);
		});

		test("the window limits where a loss counts", () => {
			const spans: [number, number][] = [
				[0, 29],
				[33, 59],
			];
			expect(gapNotices({ spans, f0: 5, window: { first: 0, last: 25 } }).list).toEqual([]);
			expect(gapNotices({ spans, f0: 40, window: { first: 35, last: 59 } }).list).toEqual([]);
		});
	});

	describe("the window", () => {
		test("statistics and notices follow the frames the element is on, not the whole clip", () => {
			// the camera moves until frame 29 and then stands still
			const stops = ({ t, p0 }: { t: number; p0: Point }) => MOVING({ t: Math.min(t, 29), p0 });
			expect(notices({ motion: stops }).kinds).toEqual([]);
			const late = notices({ motion: stops, window: { first: 32, last: 59 } });
			expect(late.kinds).toEqual(["no-motion"]);
			expect(late.stats.maxShift).toBeLessThan(0.2);
		});

		test("a window outside the solution is an error", () => {
			for (const window of [
				{ first: -1, last: 10 },
				{ first: 10, last: 60 },
				{ first: 30, last: 20 },
			]) {
				expect(() => notices({ motion: MOVING, window })).toThrow(RangeError);
			}
		});
	});

	test("an object under the pin is reported last", () => {
		const classification = { isObject: true, velocity: 0.3, n: 5 };
		expect(notices({ motion: MOVING, classification }).kinds).toEqual(["object"]);
		expect(
			notices({ motion: MOVING, noise: 0.8, cuts: [40], classification }).kinds,
		).toEqual(["cut", "low-quality", "object"]);
		expect(
			notices({ motion: MOVING, classification: { isObject: false, velocity: 0, n: 5 } }).kinds,
		).toEqual([]);
	});

	test("only a similarity scene solution can be judged", () => {
		const tracks = buildTracks({ frameCount: 5, specs: [] });
		const h = solvePin({ tracks, f0: 0, model: "H", mode: "scene" });
		expect(() => qualityNotices({ tracks, solution: h })).toThrow();
		expect(() => cameraQualityStats({ tracks, solution: h })).toThrow();
	});
});
