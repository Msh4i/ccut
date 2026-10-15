import { describe, expect, test } from "bun:test";
import { hApply } from "../homography";
import { homographyAt, mapPoint, similarityAt, SOLVE_PRESETS, solvePin } from "../solve-pin";
import type { FeatureTracks } from "../types";
import { buildTracks, scatterPoints, type Point } from "./camera-fixtures";
import {
	allOk,
	CORNERS,
	motionFor,
	sceneAt,
	solveWith,
	specsFor,
	staggeredLife,
	truthFor,
	truthSimilarity,
	whole,
	worstError,
} from "./track-scenes";

describe("solvePin on exact tracks", () => {
	for (const model of ["S", "H"] as const) {
		test(`model ${model}: every frame is solved to a thousandth of a pixel`, () => {
			const frameCount = 100;
			const tracks = buildTracks({
				frameCount,
				specs: specsFor({
					points: scatterPoints({ count: 80, seed: 3 }),
					life: whole(frameCount),
					motion: motionFor(model),
					frameCount,
				}),
			});
			const solution = solveWith({ tracks, f0: 0, model });
			expect(solution.model).toBe(model);
			expect(solution.mode).toBe("scene");
			expect(solution.f0).toBe(0);
			expect(solution.frameCount).toBe(100);
			expect(solution.stride).toBe(model === "S" ? 4 : 9);
			expect(solution.maps.length).toBe(100 * solution.stride);
			expect(allOk(solution)).toBe(true);
			expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(1e-3);
			expect(Math.max(...solution.rms)).toBeLessThan(1e-3);
			expect(solution.nin[50]).toBeGreaterThanOrEqual(70);
		});

		test(`model ${model}: solving from the middle follows the clip both ways`, () => {
			const frameCount = 100;
			const tracks = buildTracks({
				frameCount,
				specs: specsFor({
					points: scatterPoints({ count: 80, seed: 4 }),
					life: whole(frameCount),
					motion: motionFor(model),
					frameCount,
				}),
			});
			const solution = solveWith({ tracks, f0: 50, model });
			expect(allOk(solution)).toBe(true);
			expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(1e-3);
			// the pin frame itself maps every point to itself
			for (const q of CORNERS) {
				const p = mapPoint({ solution, t: 50, x: q.x, y: q.y });
				expect(p.x).toBeCloseTo(q.x, 9);
				expect(p.y).toBeCloseTo(q.y, 9);
			}
			expect(solution.nin[50]).toBe(0);
			expect(solution.rms[50]).toBe(0);
		});
	}

	test("a pin on the first or the last frame solves the one direction there is", () => {
		const frameCount = 40;
		const tracks = buildTracks({
			frameCount,
			specs: specsFor({
				points: scatterPoints({ count: 60, seed: 5 }),
				life: whole(frameCount),
				motion: motionFor("S"),
				frameCount,
			}),
		});
		for (const f0 of [0, 39]) {
			const solution = solveWith({ tracks, f0 });
			expect(allOk(solution)).toBe(true);
			expect(worstError({ solution, truth: truthSimilarity })).toBeLessThan(1e-3);
		}
	});

	test("the same input always gives the same solution", () => {
		const frameCount = 60;
		const make = () =>
			buildTracks({
				frameCount,
				specs: specsFor({
					points: scatterPoints({ count: 70, seed: 6 }),
					life: whole(frameCount),
					motion: motionFor("S"),
					noise: 0.15,
					outlierShare: 0.2,
					frameCount,
				}),
			});
		const a = solveWith({ tracks: make(), f0: 10 });
		const b = solveWith({ tracks: make(), f0: 10 });
		expect(Array.from(b.maps)).toEqual(Array.from(a.maps));
	});
});

describe("solvePin robustness", () => {
	for (const model of ["S", "H"] as const) {
		test(`model ${model}: noise and a quarter outliers barely move the solution`, () => {
			const frameCount = 80;
			const tracks = buildTracks({
				frameCount,
				specs: specsFor({
					points: scatterPoints({ count: 90, seed: 7 }),
					life: whole(frameCount),
					motion: motionFor(model),
					noise: 0.05,
					outlierShare: 0.25,
					seed: 11,
					frameCount,
				}),
			});
			const solution = solveWith({ tracks, f0: 0, model });
			expect(allOk(solution)).toBe(true);
			// 0.05 px noise at both ends of the pair: residual rms around 0.1
			const rms = Array.from(solution.rms).slice(1).sort((a, b) => a - b);
			expect(rms[rms.length >> 1]).toBeGreaterThan(0.06);
			expect(rms[rms.length >> 1]).toBeLessThan(0.16);
			// measured 0.08 (S) and 0.14 (H): a homography has more freedom to follow the noise
			expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.15 : 0.25);
		});
	}

	for (const model of ["S", "H"] as const) {
		test(`model ${model}: tracks that live 40 frames still carry a 200 frame clip (anchor hops)`, () => {
			const frameCount = 200;
			const count = 300;
			const tracks = buildTracks({
				frameCount,
				specs: specsFor({
					points: scatterPoints({ count, seed: 8 }),
					life: staggeredLife({ frameCount, count }),
					motion: motionFor(model),
					noise: 0.05,
					seed: 12,
					frameCount,
				}),
			});
			for (let f = 0; f < frameCount; f++) {
				expect(tracks.liveOffsets[f + 1] - tracks.liveOffsets[f]).toBeGreaterThan(30);
			}
			const solution = solveWith({ tracks, f0: 0, model });
			expect(allOk(solution)).toBe(true);
			expect(solution.hops).toBeGreaterThanOrEqual(8);
			// measured 0.15 (S) and 0.32 (H) after 13 hops
			expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.3 : 0.6);
		});
	}

	test("it re-anchors now and then, not on every frame", () => {
		const frameCount = 200;
		const count = 300;
		const tracks = buildTracks({
			frameCount,
			specs: specsFor({
				points: scatterPoints({ count, seed: 9 }),
				life: staggeredLife({ frameCount, count }),
				motion: motionFor("S"),
				noise: 0.05,
				seed: 13,
				frameCount,
			}),
		});
		const anchored = solveWith({ tracks, f0: 0 });
		// hopFrac above 1 makes every frame start from the one before: a chain
		const chained = solveWith({ tracks, f0: 0, options: { hopFrac: 1.01 } });
		expect(allOk(anchored) && allOk(chained)).toBe(true);
		expect(anchored.hops).toBeLessThanOrEqual(30);
		expect(chained.hops).toBeGreaterThanOrEqual(150);
	});

	for (const model of ["S", "H"] as const) {
		test(`model ${model}: features riding a moving object are remembered as outliers`, () => {
			// 70 background features die one after another from frame 59 on, while
			// 45 features on an object that moves its own way (4 px per frame
			// against the scene, too much for even a homography to absorb) live to
			// the end. Once the object has more features than the background it
			// would win every vote, unless it was marked an outlier while it was
			// the minority.
			const frameCount = 140;
			const bg = scatterPoints({ count: 70, seed: 21 });
			const obj = scatterPoints({ count: 45, seed: 22 });
			const bgSpecs = specsFor({
				points: bg,
				life: ({ i }) => ({ start: 0, end: 59 + Math.floor((i * 80) / 70) }),
				motion: motionFor(model),
				frameCount,
			});
			const objSpecs = specsFor({
				points: obj,
				life: whole(frameCount),
				motion: ({ t, p0 }) => ({ x: p0.x - 4 * t, y: p0.y + 2.2 * t }),
				frameCount,
			});
			const tracks = buildTracks({ frameCount, specs: [...bgSpecs, ...objSpecs] });
			const solution = solveWith({ tracks, f0: 0, model });
			const checked = Array.from({ length: 120 }, (_, t) => t);
			expect(checked.every((t) => solution.ok[t] === 1)).toBe(true);
			expect(worstError({ solution, truth: truthFor(model), frames: checked })).toBeLessThan(0.05);

			const forgetful = solveWith({ tracks, f0: 0, model, options: { badLimit: 0 } });
			expect(worstError({ solution: forgetful, truth: truthFor(model), frames: checked })).toBeGreaterThan(20);
		});
	}
});

/** The 34 points of the object in `slowObjectTracks`: a small cluster right of the centre. */
function objectCluster(): Point[] {
	return scatterPoints({ count: 34, seed: 32 }).map((p) => ({
		x: 300 + (p.x - 240) * 0.25,
		y: 120 + (p.y - 135) * 0.25,
	}));
}

/**
 * 60 background features and 34 on an object that drifts `speed` px per frame
 * against the scene (1.3 by default). One frame from the pin that is inside
 * the Tukey cutoff, so the first fits lean towards the object; once the object
 * is rejected the support drops, the solver re-anchors on such a frame and
 * keeps its bias for the rest of the clip.
 *
 * The object keeps pace with the scene for its first `delay` frames from `pin`
 * and drifts from then on; `pin` is the frame its drift is counted from (the
 * clip's first frame unless said otherwise).
 */
function slowObjectTracks({
	model,
	speed = 1.34,
	delay = 0,
	pin = 0,
}: {
	model: "S" | "H";
	speed?: number;
	delay?: number;
	pin?: number;
}): FeatureTracks {
	const frameCount = 60;
	const motion = motionFor(model);
	const bg = specsFor({
		points: scatterPoints({ count: 60, seed: 31 }),
		life: whole(frameCount),
		motion,
		noise: 0.05,
		seed: 3,
		frameCount,
	});
	const obj = specsFor({
		points: objectCluster(),
		life: whole(frameCount),
		motion: ({ t, p0 }) => {
			const q = motion({ t, p0 });
			const away = Math.max(0, Math.abs(t - pin) - delay);
			return { x: q.x - (2 / Math.sqrt(5)) * speed * away, y: q.y + (1 / Math.sqrt(5)) * speed * away };
		},
		noise: 0.05,
		seed: 4,
		frameCount,
	});
	return buildTracks({ frameCount, specs: [...bg, ...obj] });
}

/**
 * The clip's first or last frame is the pin. Everything alive on it (60 scene
 * features and the 34 of the slow object) is gone `reachTo` frames later, and
 * the 60 features that carry the rest of the clip are born 2 frames after the
 * pin: no feature is alive on both the pin frame and the frame 6 away, so that
 * fit has nothing to stand on and the look-ahead has to fall back to a nearer
 * frame. The object drifts 1.34 px per frame from the pin.
 */
function shortLivedStartTracks({
	model,
	pin,
	reachTo,
}: {
	model: "S" | "H";
	pin: 0 | 59;
	reachTo: number;
}): FeatureTracks {
	const frameCount = 60;
	const motion = motionFor(model);
	const dir = pin === 0 ? 1 : -1;
	const early = { start: Math.min(pin, pin + dir * reachTo), end: Math.max(pin, pin + dir * reachTo) };
	const late = dir === 1 ? { start: pin + 2, end: frameCount - 1 } : { start: 0, end: pin - 2 };
	const bg = specsFor({
		points: scatterPoints({ count: 60, seed: 31 }),
		life: () => early,
		motion,
		noise: 0.05,
		seed: 3,
		frameCount,
	});
	const carriers = specsFor({
		points: scatterPoints({ count: 60, seed: 35 }),
		life: () => late,
		motion,
		noise: 0.05,
		seed: 5,
		frameCount,
	});
	const obj = specsFor({
		points: objectCluster(),
		life: () => early,
		motion: ({ t, p0 }) => {
			const q = motion({ t, p0 });
			const away = 1.34 * Math.abs(t - pin);
			return { x: q.x - (2 / Math.sqrt(5)) * away, y: q.y + (1 / Math.sqrt(5)) * away };
		},
		noise: 0.05,
		seed: 4,
		frameCount,
	});
	return buildTracks({ frameCount, specs: [...bg, ...carriers, ...obj] });
}

/**
 * 60 scene features that die away over the 10 to 20 frames after (or before)
 * the pin, and 50 that live the whole clip on an object. The object moves 1 px
 * per frame through the scene for the 8 frames after (or before) the pin, then
 * stops: from there on it is part of the scene like any other feature.
 *
 * While the scene features are alive the object's are marked as moving at the
 * pin. Once they have died away the object's features are all there is, and
 * they fit the scene's motion exactly.
 */
function stoppingObjectTracks({
	model,
	pin,
	side,
}: {
	model: "S" | "H";
	pin: number;
	side: "after" | "before";
}): FeatureTracks {
	const frameCount = 60;
	const motion = motionFor(model);
	const sign = side === "after" ? 1 : -1;
	const bg = specsFor({
		points: scatterPoints({ count: 60, seed: 31 }),
		life: ({ i }) => {
			const end = pin + sign * (10 + Math.floor((i * 10) / 60));
			return { start: Math.min(pin, end), end: Math.max(pin, end) };
		},
		motion,
		noise: 0.05,
		seed: 3,
		frameCount,
	});
	const obj = specsFor({
		points: scatterPoints({ count: 50, seed: 32 }),
		life: whole(frameCount),
		// the object moves inside the scene, so after it stops it moves with the scene's motion
		motion: ({ t, p0 }) => {
			const away = Math.min(Math.max(sign * (t - pin), 0), 8);
			return motion({
				t,
				p0: { x: p0.x + (2 / Math.sqrt(5)) * away, y: p0.y - (1 / Math.sqrt(5)) * away },
			});
		},
		noise: 0.05,
		seed: 4,
		frameCount,
	});
	return buildTracks({ frameCount, specs: [...bg, ...obj] });
}

describe("solvePin right after the pin frame", () => {
	// Without the look-ahead (`lookahead: 0`) the error is 0.76 (S, pin 0), 9.3 (S, pin 59), 3.3 (H, pin 0), 8.1 px (H, pin 59).
	// Under S at 1.34 px per frame the first fits from frame 59 happen not to lean towards the
	// object (0.05 px even without the look-ahead), so that pin uses 0.5 px per frame, where they do.
	const slowCases = [
		{ model: "S", f0: 0, speed: 1.34 },
		{ model: "S", f0: 59, speed: 0.5 },
		{ model: "H", f0: 0, speed: 1.34 },
		{ model: "H", f0: 59, speed: 1.34 },
	] as const;
	for (const { model, f0, speed } of slowCases) {
		test(`model ${model}, pin on frame ${f0}, object at ${speed} px per frame: a slow object does not bias the first fits`, () => {
			// a fit to a frame farther away tells the object apart before the first fits are made
			const tracks = slowObjectTracks({ model, speed });
			const solution = solveWith({ tracks, f0, model });
			expect(allOk(solution)).toBe(true);
			// measured 0.05 (S) and 0.08 (H); without the look-ahead 0.76 / 9.3 px (S) and 3.3 / 8.1 px (H)
			expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.1 : 0.15);
			// a scene that the first fits get right anyway would prove nothing
			const off = solveWith({ tracks, f0, model, options: { lookahead: 0 } });
			expect(worstError({ solution: off, truth: truthFor(model) })).toBeGreaterThan(0.5);
		});
	}

	test("an object at 0.5 px per frame stays out for the whole look-ahead, not just its first frame", () => {
		// one frame from the pin it is within the noise and the persistent-outlier
		// bookkeeping lets it back in; only the look-ahead knows it is moving
		const tracks = slowObjectTracks({ model: "S", speed: 0.5 });
		const solution = solveWith({ tracks, f0: 0 });
		// measured 0.05; without the look-ahead the object takes over: 14 px
		expect(worstError({ solution, truth: truthFor("S") })).toBeLessThan(0.1);
	});

	test("a range too short for the look-ahead solves as without it", () => {
		// the frames past the range are not looked at, even though tracks go on there
		const tracks = slowObjectTracks({ model: "S" });
		const range = { lo: 19, hi: 21 };
		const solution = solvePin({ tracks, f0: 20, model: "S", mode: "scene", range });
		const plain = solvePin({ tracks, f0: 20, model: "S", mode: "scene", range, options: { lookahead: 0 } });
		expect(Array.from(solution.maps)).toEqual(Array.from(plain.maps));
	});

	test("with the look-ahead turned off the slow object biases the fit", () => {
		const off = solveWith({ tracks: slowObjectTracks({ model: "S" }), f0: 0, options: { lookahead: 0 } });
		expect(worstError({ solution: off, truth: truthFor("S") })).toBeGreaterThan(0.5);
	});

	test("the look-ahead is 6 frames in the scene presets and off in the object preset", () => {
		expect(SOLVE_PRESETS["S-scene"].lookahead).toBe(6);
		expect(SOLVE_PRESETS["H-scene"].lookahead).toBe(6);
		expect(SOLVE_PRESETS["S-object"].lookahead).toBe(0);
	});

	for (const model of ["S", "H"] as const) {
		for (const f0 of [0, 59]) {
			test(`model ${model}, pin on frame ${f0}: an object that parts from the scene only after the 4th frame is caught by the 6 frame window`, () => {
				// it keeps pace for 4 frames, then drifts 1.4 px per frame: 0 px off the scene at the 4th
				// frame from the pin, 1.4 at the 5th, 2.8 at the 6th (a mark needs more than `scaleWin`, 1.5 px)
				const tracks = slowObjectTracks({ model, speed: 1.4, delay: 4, pin: f0 });
				const solution = solveWith({ tracks, f0, model });
				expect(allOk(solution)).toBe(true);
				// measured 0.05 (S) and 0.08 (H)
				expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.1 : 0.15);
				// a window of 3 frames sees the object still with the scene: 9.2 / 1.7 px (S) and 99 / 7.1 px (H) at pin 0 / 59
				const short = solveWith({ tracks, f0, model, options: { lookahead: 3 } });
				expect(worstError({ solution: short, truth: truthFor(model) })).toBeGreaterThan(0.5);
			});
		}
	}

	for (const model of ["S", "H"] as const) {
		for (const pin of [0, 59] as const) {
			for (const reachTo of [4, 5]) {
				test(`model ${model}, pin on frame ${pin}: nothing fits the frame 6 away, so the one ${reachTo} away is used`, () => {
					const tracks = shortLivedStartTracks({ model, pin, reachTo });
					const solution = solveWith({ tracks, f0: pin, model });
					expect(allOk(solution)).toBe(true);
					// measured 0.04 to 0.07 (S) and 0.09 to 0.12 (H)
					expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.1 : 0.2);
					// with no frame to look at the object leans the first fits: 1.1 to 1.7 px (S), 2.9 to 3.8 px (H)
					const off = solveWith({ tracks, f0: pin, model, options: { lookahead: 0 } });
					expect(worstError({ solution: off, truth: truthFor(model) })).toBeGreaterThan(0.5);
				});
			}
		}
	}

	for (const model of ["S", "H"] as const) {
		for (const { pin, side } of [
			{ pin: 0, side: "after" },
			{ pin: 59, side: "before" },
		] as const) {
			test(`model ${model}, pin on frame ${pin}: the marks end with the first re-anchor, the object that stopped is let back in`, () => {
				// the object is marked as moving at the pin; its features are the only ones left once the
				// scene's have died away, which is possible only if the marks do not outlive the first
				// re-anchor (the persistent-outlier count of the stopped object is back at 0 by then)
				const tracks = stoppingObjectTracks({ model, pin, side });
				const solution = solveWith({ tracks, f0: pin, model });
				expect(solution.hops).toBeGreaterThanOrEqual(1);
				expect(allOk(solution)).toBe(true);
				// the far end of the clip is carried by the object's 50 features alone
				expect(solution.nin[side === "after" ? 59 : 0]).toBeGreaterThanOrEqual(40);
				// measured 0.06 (S) and 0.14 (H)
				expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.1 : 0.25);
			});
		}
	}

	for (const model of ["S", "H"] as const) {
		for (const side of ["after", "before"] as const) {
			test(`model ${model}, pin mid-clip, object moving ${side} the pin: the marks of one direction do not reach the other`, () => {
				// The scene's features live on one side of the pin only, the object's on both. Where the
				// object moves, its features are marked; on the other side it keeps pace with the scene and
				// is all there is to follow. The persistent-outlier count is shared by both directions, but
				// the object stopped moving, so the re-anchor of the first direction put it back to 0 and
				// only a leftover mark could still keep the object out of the second direction.
				// (The forward direction runs first: "before" cannot leak, it guards the symmetric case.)
				const tracks = stoppingObjectTracks({ model, pin: 30, side });
				const solution = solveWith({ tracks, f0: 30, model });
				expect(allOk(solution)).toBe(true);
				// measured 0.05-0.07 (S) and 0.13-0.15 (H); with the marks left over 1.4 (S) and 0.6 px (H) and the second side bridged
				expect(worstError({ solution, truth: truthFor(model) })).toBeLessThan(model === "S" ? 0.1 : 0.25);
			});
		}
	}

	test("without a moving object the look-ahead changes nothing, however noisy the tracks", () => {
		// the noisy tail of the background ends up just beyond the cutoff; marking it would
		// shift the first fits and with them every later re-anchoring of a long clip
		const frameCount = 200;
		const count = 300;
		for (const model of ["S", "H"] as const) {
			const tracks = buildTracks({
				frameCount,
				specs: specsFor({
					points: scatterPoints({ count, seed: 34 }),
					life: staggeredLife({ frameCount, count }),
					motion: motionFor(model),
					noise: 0.25,
					seed: 14,
					frameCount,
				}),
			});
			for (const f0 of [0, 100]) {
				const plain = solveWith({ tracks, f0, model, options: { lookahead: 0 } });
				const solution = solveWith({ tracks, f0, model });
				expect(solution.hops).toBe(plain.hops);
				expect(Array.from(solution.maps)).toEqual(Array.from(plain.maps));
			}
		}
	});

	test("the look-ahead stays inside the pin's scene and the frames asked for", () => {
		// a cut 3 frames after the pin: the look-ahead may not reach past it
		const frameCount = 40;
		const tracks = buildTracks({
			frameCount,
			cuts: [23],
			specs: specsFor({
				points: scatterPoints({ count: 60, seed: 33 }),
				life: () => ({ start: 0, end: 22 }),
				motion: motionFor("S"),
				frameCount,
			}),
		});
		const solution = solveWith({ tracks, f0: 20 });
		const scene = Array.from({ length: 23 }, (_, t) => t);
		expect(scene.every((t) => solution.ok[t] === 1)).toBe(true);
		expect(worstError({ solution, truth: truthFor("S"), frames: scene })).toBeLessThan(1e-3);
		const ranged = solvePin({ tracks, f0: 20, model: "S", mode: "scene", range: { lo: 18, hi: 21 } });
		expect(Array.from(ranged.ok.subarray(18, 22))).toEqual([1, 1, 1, 1]);
	});
});

describe("solvePin when the tracks give out", () => {
	test("frames beyond the last common track hold the last solved map", () => {
		const frameCount = 100;
		const tracks = buildTracks({
			frameCount,
			specs: specsFor({
				points: scatterPoints({ count: 60, seed: 31 }),
				life: whole(60),
				motion: motionFor("S"),
				frameCount,
			}),
		});
		const solution = solveWith({ tracks, f0: 10 });
		expect(Array.from(solution.ok.slice(0, 60)).every((v) => v === 1)).toBe(true);
		for (let t = 60; t < 100; t++) {
			expect(solution.ok[t]).toBe(0);
			expect(solution.nin[t]).toBe(0);
			expect(solution.rms[t]).toBe(0);
			expect(Array.from(solution.maps.subarray(4 * t, 4 * t + 4))).toEqual(
				Array.from(solution.maps.subarray(4 * 59, 4 * 59 + 4)),
			);
		}
		expect(worstError({ solution, truth: truthSimilarity })).toBeLessThan(1e-3);
	});

	test("a clip with no usable tracks holds the identity", () => {
		const tracks = buildTracks({ frameCount: 10, specs: [] });
		const solution = solveWith({ tracks, f0: 3 });
		expect(solution.ok[3]).toBe(1);
		for (let t = 0; t < 10; t++) {
			if (t !== 3) expect(solution.ok[t]).toBe(0);
			expect(Array.from(solution.maps.subarray(4 * t, 4 * t + 4))).toEqual([1, 0, 0, 0]);
		}
	});

	test("features bunched in a corner cannot define the camera", () => {
		const frameCount = 30;
		const clustered = scatterPoints({ count: 40, seed: 32 }).map((p) => ({
			x: 100 + (p.x % 20),
			y: 80 + (p.y % 20),
		}));
		const tracks = buildTracks({
			frameCount,
			specs: specsFor({ points: clustered, life: whole(frameCount), motion: motionFor("S"), frameCount }),
		});
		const solution = solveWith({ tracks, f0: 0 });
		expect(solution.ok.slice(1).every((v) => v === 0)).toBe(true);
		const loose = solveWith({ tracks, f0: 0, options: { minSpread: 5 } });
		expect(loose.ok.every((v) => v === 1)).toBe(true);
	});

	test("never solves across a scene cut: the far side is held", () => {
		// 12 "bridge" tracks live on both sides of the cut, as garbage samples
		// of a careless tracker would. They agree with each other, so a solver
		// that did not know about the cut would happily solve with them.
		const frameCount = 100;
		const before = specsFor({
			points: scatterPoints({ count: 60, seed: 33 }),
			life: () => ({ start: 0, end: 49 }),
			motion: motionFor("S"),
			frameCount,
		});
		const after = specsFor({
			points: scatterPoints({ count: 60, seed: 34 }),
			life: () => ({ start: 50, end: 99 }),
			motion: ({ t, p0 }) => ({ x: p0.x + 0.3 * t, y: p0.y }),
			frameCount,
		});
		const bridge = specsFor({
			points: scatterPoints({ count: 12, seed: 35 }),
			life: () => ({ start: 40, end: 70 }),
			motion: ({ t, p0 }) => ({ x: p0.x + 2 * t, y: p0.y }),
			frameCount,
		});
		const tracks = buildTracks({ frameCount, specs: [...before, ...after, ...bridge], cuts: [50] });
		const early = solveWith({ tracks, f0: 20 });
		expect(Array.from(early.ok.slice(0, 50)).every((v) => v === 1)).toBe(true);
		expect(Array.from(early.ok.slice(50)).every((v) => v === 0)).toBe(true);
		expect(Array.from(early.maps.subarray(4 * 80, 4 * 80 + 4))).toEqual(
			Array.from(early.maps.subarray(4 * 49, 4 * 49 + 4)),
		);
		const late = solveWith({ tracks, f0: 70 });
		expect(Array.from(late.ok.slice(50)).every((v) => v === 1)).toBe(true);
		expect(Array.from(late.ok.slice(0, 50)).every((v) => v === 0)).toBe(true);
		expect(Array.from(late.maps.subarray(4 * 10, 4 * 10 + 4))).toEqual(
			Array.from(late.maps.subarray(4 * 50, 4 * 50 + 4)),
		);
	});
});

describe("solvePin in object mode", () => {
	const frameCount = 80;
	const objectCentre: Point = { x: 300, y: 100 };

	function sceneWithObject(): FeatureTracks {
		const bg = scatterPoints({ count: 70, seed: 41 });
		const near = scatterPoints({ count: 16, seed: 42, margin: 0 }).map((p) => ({
			x: objectCentre.x + ((p.x % 40) - 20),
			y: objectCentre.y + ((p.y % 40) - 20),
		}));
		return buildTracks({
			frameCount,
			specs: [
				...specsFor({
					points: bg.filter((p) => Math.hypot(p.x - objectCentre.x, p.y - objectCentre.y) > 70),
					life: whole(frameCount),
					motion: ({ p0 }) => p0,
					frameCount,
				}),
				...specsFor({
					points: near,
					life: whole(frameCount),
					motion: ({ t, p0 }) => ({ x: p0.x + 0.8 * t, y: p0.y + 0.3 * t }),
					frameCount,
				}),
			],
		});
	}

	test("follows the thing under the pin, the scene mode follows the background", () => {
		const tracks = sceneWithObject();
		const object = solvePin({ tracks, f0: 0, model: "S", mode: "object", pin: objectCentre });
		expect(object.mode).toBe("object");
		const p = mapPoint({ solution: object, t: 70, x: objectCentre.x, y: objectCentre.y });
		expect(p.x).toBeCloseTo(objectCentre.x + 0.8 * 70, 1);
		expect(p.y).toBeCloseTo(objectCentre.y + 0.3 * 70, 1);

		const scene = solvePin({ tracks, f0: 0, model: "S", mode: "scene" });
		const q = mapPoint({ solution: scene, t: 70, x: objectCentre.x, y: objectCentre.y });
		expect(Math.hypot(q.x - objectCentre.x, q.y - objectCentre.y)).toBeLessThan(0.1);
	});

	test("a pin on the background follows the background even in object mode", () => {
		const tracks = sceneWithObject();
		const pin = { x: 90, y: 200 };
		const object = solvePin({ tracks, f0: 0, model: "S", mode: "object", pin });
		const p = mapPoint({ solution: object, t: 70, x: pin.x, y: pin.y });
		expect(Math.hypot(p.x - pin.x, p.y - pin.y)).toBeLessThan(0.2);
	});

	test("needs a pin and only works with the similarity model", () => {
		const tracks = sceneWithObject();
		expect(() => solvePin({ tracks, f0: 0, model: "S", mode: "object" })).toThrow();
		expect(() =>
			solvePin({ tracks, f0: 0, model: "H", mode: "object", pin: objectCentre }),
		).toThrow();
	});
});

describe("solvePin arguments", () => {
	const tracks = buildTracks({ frameCount: 10, specs: [] });

	test("the pin frame must be inside the clip", () => {
		expect(() => solveWith({ tracks, f0: -1 })).toThrow();
		expect(() => solveWith({ tracks, f0: 10 })).toThrow();
		expect(() => solveWith({ tracks, f0: 2.5 })).toThrow();
	});
});

describe("solution accessors", () => {
	const frameCount = 30;
	const tracks = buildTracks({
		frameCount,
		specs: specsFor({
			points: scatterPoints({ count: 60, seed: 51 }),
			life: whole(frameCount),
			motion: motionFor("S"),
			frameCount,
		}),
	});

	test("similarityAt reads the S map and refuses an H solution", () => {
		const s = solveWith({ tracks, f0: 0, model: "S" });
		const map = similarityAt({ solution: s, t: 20 });
		const want = sceneAt({ t: 20, p0: { x: 100, y: 100 } });
		const got = { x: map.ar * 100 - map.ai * 100 + map.br, y: map.ar * 100 + map.ai * 100 + map.bi };
		expect(got.x).toBeCloseTo(want.x, 2);
		expect(got.y).toBeCloseTo(want.y, 2);
		const h = solveWith({ tracks, f0: 0, model: "H" });
		expect(() => similarityAt({ solution: h, t: 5 })).toThrow();
		expect(() => homographyAt({ solution: s, t: 5 })).toThrow();
	});

	test("homographyAt reads the H map and mapPoint agrees with it", () => {
		const h = solveWith({ tracks, f0: 0, model: "H" });
		const m = homographyAt({ solution: h, t: 20 });
		expect(m.length).toBe(9);
		expect(m[8]).toBeCloseTo(1, 9);
		const viaMap = hApply({ h: m, x: 123, y: 87 });
		const viaPoint = mapPoint({ solution: h, t: 20, x: 123, y: 87 });
		expect(viaPoint.x).toBeCloseTo(viaMap.x, 9);
		expect(viaPoint.y).toBeCloseTo(viaMap.y, 9);
	});

	test("asking for a frame outside the clip is an error, not a guess", () => {
		const s = solveWith({ tracks, f0: 0 });
		expect(() => mapPoint({ solution: s, t: -1, x: 0, y: 0 })).toThrow();
		expect(() => mapPoint({ solution: s, t: frameCount, x: 0, y: 0 })).toThrow();
	});
});
