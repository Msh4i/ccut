import { beforeAll, describe, expect, test } from "bun:test";
import {
	generateSequence,
	makeWorld,
	type SequenceOptions,
	type World,
} from "../camera-synth";
import {
	DEFAULT_TRACKER_OPTIONS,
	FeatureTracker,
	resolveTrackerOptions,
	type TrackerOptions,
} from "../tracker";
import type { FeatureTracks } from "../types";

const W = 480;
const H = 270;
const CENTRE = { wcx: 600, wcy: 450 };

/**
 * What the measurements in the plan were taken with: seeds half of the room
 * per pass, in scan order, and keeps 10 px off the edge. Production seeds all
 * the room, strongest first (see `corners.ts`).
 */
const PLAN_PROFILE: Partial<TrackerOptions> = {
	margin: 10,
	seedShare: 0.5,
	budgetOrder: "first",
	maxFeatures: 110,
};

let world: World;
let otherWorld: World;

beforeAll(() => {
	world = makeWorld({ width: 1200, height: 900, seed: 41 });
	otherWorld = makeWorld({ width: 1200, height: 900, seed: 42 });
});

function run({
	options,
	world: source = world,
	trackerOptions,
}: {
	options: SequenceOptions;
	world?: World;
	trackerOptions?: Partial<TrackerOptions>;
}) {
	const seq = generateSequence({ world: source, options });
	const tracker = new FeatureTracker({ w: W, h: H, fps: 24, options: trackerOptions });
	for (const frame of seq.frames) tracker.push(frame);
	return { seq, tracks: tracker.finish() };
}

function sample({ tracks, id, j }: { tracks: FeatureTracks; id: number; j: number }) {
	const o = tracks.trackOffset[id] + 2 * j;
	return { x: tracks.xy[o], y: tracks.xy[o + 1] };
}

function liveCount({ tracks, f }: { tracks: FeatureTracks; f: number }) {
	return tracks.liveOffsets[f + 1] - tracks.liveOffsets[f];
}

let panRun: ReturnType<typeof run> | null = null;
const pan = () =>
	(panRun ??= run({ options: { kind: "pan", frameCount: 40, noise: 0, extra: CENTRE } }));

describe("FeatureTracker defaults", () => {
	test("are the measured prototype parameters, with a seeding that fits the frame", () => {
		expect(DEFAULT_TRACKER_OPTIONS).toEqual({
			levels: 3,
			half: 5,
			maxIter: 12,
			eps: 0.02,
			fbTol: 0.6,
			resMax: 14,
			cell: 36,
			minDist: 9,
			quality: 0.003,
			absMin: 4,
			reseedEvery: 4,
			seedShare: 1,
			budgetOrder: "strongest",
			detWin: 5,
		});
	});

	test("the margin keeps seeds out of what the coarsest level cannot follow", () => {
		// three levels, half window 5: a window of 7 coarse pixels = 28 px
		expect(resolveTrackerOptions({ w: 480, h: 270 }).margin).toBe(28);
		expect(resolveTrackerOptions({ w: 480, h: 270, options: { half: 7, levels: 4 } }).margin).toBe(72);
		expect(resolveTrackerOptions({ w: 480, h: 270, options: { margin: 10 } }).margin).toBe(10);
	});

	test("the feature cap follows the grid: 110 at 480 x 270, three per hundred cells beyond", () => {
		expect(resolveTrackerOptions({ w: 480, h: 270 }).maxFeatures).toBe(110);
		expect(resolveTrackerOptions({ w: 480, h: 360 }).maxFeatures).toBe(138);
		expect(resolveTrackerOptions({ w: 480, h: 853 }).maxFeatures).toBe(330);
		expect(resolveTrackerOptions({ w: 100, h: 60 }).maxFeatures).toBe(110);
		expect(resolveTrackerOptions({ w: 480, h: 853, options: { maxFeatures: 40 } }).maxFeatures).toBe(40);
	});
});

describe("FeatureTracker", () => {
	test("follows a pan: every sample sits where the camera path puts it", () => {
		const { seq, tracks } = pan();
		const errors: number[] = [];
		let long = 0;
		for (let id = 0; id < tracks.trackLen.length; id++) {
			if (tracks.trackLen[id] < 10) continue;
			long++;
			const start = tracks.trackStart[id];
			const p0 = sample({ tracks, id, j: 0 });
			for (let j = 1; j < tracks.trackLen[id]; j++) {
				const t = start + j;
				const p = sample({ tracks, id, j });
				const ex = p0.x + (seq.truth[t].dx - seq.truth[start].dx);
				const ey = p0.y + (seq.truth[t].dy - seq.truth[start].dy);
				errors.push(Math.hypot(p.x - ex, p.y - ey));
			}
		}
		expect(long).toBeGreaterThan(60);
		errors.sort((a, b) => a - b);
		// measured: median 0.03, worst 0.25 (chained frame to frame, no noise)
		expect(errors[errors.length >> 1]).toBeLessThan(0.06);
		expect(errors[errors.length - 1]).toBeLessThan(0.4);
	});

	test("keeps about a hundred features alive by re-seeding empty cells", () => {
		const { tracks } = run({
			options: { kind: "pan", frameCount: 60, extra: CENTRE },
		});
		const counts = Array.from({ length: 60 }, (_, f) => liveCount({ tracks, f }));
		const sorted = [...counts].sort((a, b) => a - b);
		expect(sorted[30]).toBeGreaterThanOrEqual(80);
		expect(sorted[59]).toBeLessThanOrEqual(resolveTrackerOptions({ w: W, h: H }).maxFeatures);
		// features leave through the frame edge and are replaced
		expect(counts[59]).toBeGreaterThan(70);
		expect(tracks.trackLen.length).toBeGreaterThan(110);
	});

	test("the first frame is seeded at once, nearly to the cap", () => {
		const { tracks } = run({ options: { kind: "static", frameCount: 12, extra: CENTRE } });
		const counts = Array.from({ length: 12 }, (_, f) => liveCount({ tracks, f }));
		// 80 here: the strongest corner of a cell that has one, and not every cell has one
		expect(counts[0]).toBeGreaterThanOrEqual(75);
		// no dip while the first seeds settle: the margin keeps them off the edge
		expect(Math.min(...counts)).toBeGreaterThanOrEqual(70);
	});

	test("the plan's profile seeds half of the room on the first frame and fills the rest later", () => {
		const { tracks } = run({
			options: { kind: "static", frameCount: 20, extra: CENTRE },
			trackerOptions: PLAN_PROFILE,
		});
		expect(liveCount({ tracks, f: 0 })).toBe(55);
		expect(liveCount({ tracks, f: 4 })).toBeGreaterThan(liveCount({ tracks, f: 3 }));
		expect(liveCount({ tracks, f: 19 })).toBeGreaterThan(liveCount({ tracks, f: 0 }) + 10);
	});

	test("seeds sit on pixel indices: whole numbers, inside the frame", () => {
		const { tracks } = pan();
		for (let id = 0; id < tracks.trackLen.length; id++) {
			const p = sample({ tracks, id, j: 0 });
			expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
			expect(p.x).toBeGreaterThanOrEqual(0);
			expect(p.x).toBeLessThanOrEqual(W - 1);
			expect(p.y).toBeGreaterThanOrEqual(0);
			expect(p.y).toBeLessThanOrEqual(H - 1);
		}
	});

	test("describes its tracks consistently", () => {
		const { tracks } = pan();
		expect(tracks.w).toBe(W);
		expect(tracks.h).toBe(H);
		expect(tracks.fps).toBe(24);
		expect(tracks.frameCount).toBe(40);
		expect(tracks.liveOffsets.length).toBe(41);
		expect(tracks.liveOffsets[0]).toBe(0);
		expect(tracks.stats.lostFraction.length).toBe(40);
		let samples = 0;
		for (let id = 0; id < tracks.trackLen.length; id++) {
			expect(tracks.trackOffset[id]).toBe(2 * samples);
			samples += tracks.trackLen[id];
			expect(tracks.trackStart[id] + tracks.trackLen[id]).toBeLessThanOrEqual(40);
		}
		expect(tracks.xy.length).toBe(2 * samples);
		for (let f = 0; f < 40; f++) {
			let previous = -1;
			for (let k = tracks.liveOffsets[f]; k < tracks.liveOffsets[f + 1]; k++) {
				const id = tracks.liveIds[k];
				expect(id).toBeGreaterThan(previous);
				previous = id;
				expect(tracks.trackStart[id]).toBeLessThanOrEqual(f);
				expect(tracks.trackStart[id] + tracks.trackLen[id] - 1).toBeGreaterThanOrEqual(f);
			}
		}
	});

	test("the tracker reports its own stage timings, they are not part of the tracks", () => {
		const tracker = new FeatureTracker({ w: W, h: H, fps: 30 });
		for (const frame of generateSequence({ world, options: { kind: "hand", frameCount: 6, extra: CENTRE } }).frames) {
			tracker.push(frame);
		}
		const tracks = tracker.finish();
		expect(tracker.timing.pyramidMs).toBeGreaterThan(0);
		expect(tracker.timing.trackMs).toBeGreaterThan(0);
		expect(tracker.timing.detectMs).toBeGreaterThan(0);
		expect(Object.keys(tracks.stats).sort()).toEqual(["cutNcc", "lostFraction"]);
	});

	test("tracks never sit inside the dead band at the frame edge", () => {
		const { tracks } = run({
			options: { kind: "fastpan", frameCount: 40, extra: { ...CENTRE, speed: 6 } },
		});
		const band = resolveTrackerOptions({ w: W, h: H }).margin * 0.5;
		for (let id = 0; id < tracks.trackLen.length; id++) {
			for (let j = 1; j < tracks.trackLen[id]; j++) {
				const p = sample({ tracks, id, j });
				expect(p.x).toBeGreaterThanOrEqual(band);
				expect(p.y).toBeGreaterThanOrEqual(band);
				expect(p.x).toBeLessThanOrEqual(W - 1 - band);
				expect(p.y).toBeLessThanOrEqual(H - 1 - band);
			}
		}
	});

	test("the forward-backward check keeps features from riding a passing object", () => {
		// Static camera: a feature of the scene never moves. A disk drives over the
		// scene and covers features one after another; without the backward check
		// they follow its rim away. Features that were born on the disk itself do
		// move with it, and that is right, so they are left out of the count.
		const options: SequenceOptions = {
			kind: "static",
			frameCount: 40,
			noise: 0,
			extra: CENTRE,
			foregrounds: [{ x0: 40, y0: 135, vx: 7, vy: 0, radius: 40 }],
		};
		const seq = generateSequence({ world, options });
		const wanderingSamples = (trackerOptions?: Partial<TrackerOptions>) => {
			const tracker = new FeatureTracker({ w: W, h: H, fps: 30, options: trackerOptions });
			for (const frame of seq.frames) tracker.push(frame);
			const tracks = tracker.finish();
			let wandering = 0;
			for (let id = 0; id < tracks.trackLen.length; id++) {
				const p0 = sample({ tracks, id, j: 0 });
				const disk = seq.foregroundTruth[tracks.trackStart[id]][0];
				if (Math.hypot(p0.x - disk.x, p0.y - disk.y) < 40 + 6) continue;
				for (let j = 1; j < tracks.trackLen[id]; j++) {
					const p = sample({ tracks, id, j });
					if (Math.hypot(p.x - p0.x, p.y - p0.y) > 1) wandering++;
				}
			}
			return wandering;
		};
		// measured over 60 frames: 2 with the check, 709 without
		expect(wanderingSamples()).toBeLessThanOrEqual(10);
		expect(wanderingSamples({ fbTol: 1e9 })).toBeGreaterThan(50);
	});

	test("a pan of 32 px per frame is followed because each search starts from the last frame's motion", () => {
		// Three pyramid levels reach about 20 px on their own. From the median
		// motion of the previous frame the remaining 32 px are within reach:
		// without that start, over 2 percent of the samples go wrong and half
		// the features are lost (measured: 55 of 944 samples, median 23 live).
		const wide = makeWorld({ width: 2400, height: 900, seed: 43 });
		const seq = generateSequence({
			world: wide,
			options: { kind: "fastpan", frameCount: 50, extra: { speed: 32, wcx: 300, wcy: 450 } },
		});
		const tracker = new FeatureTracker({ w: W, h: H, fps: 30 });
		for (const frame of seq.frames) tracker.push(frame);
		const tracks = tracker.finish();
		let samples = 0;
		let wrong = 0;
		for (let id = 0; id < tracks.trackLen.length; id++) {
			const start = tracks.trackStart[id];
			const p0 = sample({ tracks, id, j: 0 });
			for (let j = 1; j < tracks.trackLen[id]; j++) {
				const p = sample({ tracks, id, j });
				const ex = p0.x + (seq.truth[start + j].dx - seq.truth[start].dx);
				const ey = p0.y + (seq.truth[start + j].dy - seq.truth[start].dy);
				samples++;
				if (Math.hypot(p.x - ex, p.y - ey) > 1) wrong++;
			}
		}
		const counts = Array.from({ length: 50 }, (_, f) => liveCount({ tracks, f })).sort((a, b) => a - b);
		expect(samples).toBeGreaterThan(1500);
		expect(wrong).toBe(0);
		expect(counts[25]).toBeGreaterThanOrEqual(45);
		expect(tracks.cuts).toEqual([]);
	});

	test("a feature whose patch stops looking like itself is dropped even if the backward check agrees", () => {
		// One frame with the contrast raised 2.2 times: the patches are still
		// aligned, so the backward check passes, but their mean difference to the
		// template is far above 14 gray levels for the high-contrast features.
		const exposure = [{ t0: 12, t1: 13, gain: 2.2, offset: -154 }];
		const lostAt12 = (trackerOptions?: Partial<TrackerOptions>) =>
			run({
				options: { kind: "static", frameCount: 20, extra: CENTRE, exposure },
				trackerOptions,
			}).tracks.stats.lostFraction[12];
		// measured: 0.86 with the limit, 0.62 without
		expect(lostAt12()).toBeGreaterThan(0.75);
		expect(lostAt12({ resMax: 1e9 })).toBeLessThan(0.75);
	});

	test("a scene cut ends every track on the last old frame and starts new ones", () => {
		const { tracks } = run({
			options: { kind: "hand", frameCount: 40, extra: CENTRE, cutAt: 20, worldAfterCut: otherWorld },
		});
		expect(tracks.cuts).toEqual([20]);
		expect(tracks.stats.cutNcc.length).toBe(1);
		expect(tracks.stats.cutNcc[0].frame).toBe(20);
		expect(tracks.stats.cutNcc[0].ncc).toBeLessThan(0.45);
		for (let id = 0; id < tracks.trackLen.length; id++) {
			const first = tracks.trackStart[id];
			const last = first + tracks.trackLen[id] - 1;
			expect(first <= 19 ? last <= 19 : first >= 20).toBe(true);
		}
		for (let k = tracks.liveOffsets[20]; k < tracks.liveOffsets[21]; k++) {
			expect(tracks.trackStart[tracks.liveIds[k]]).toBe(20);
		}
		// the new scene is seeded like a first frame
		expect(liveCount({ tracks, f: 20 })).toBeGreaterThan(80);
	});

	test("features that survive a cut by luck are cut off with the rest", () => {
		// The left third of the picture stays the same across the cut, so its
		// features follow on perfectly and 10-40 percent of all features live
		// through the change. They belong to the old shot's sample list and must
		// end at the last old frame like every other track.
		const mixed: World = { ...otherWorld, data: otherWorld.data.slice() };
		for (let y = 0; y < mixed.height; y++) {
			for (let x = 0; x < 520; x++) mixed.data[y * mixed.width + x] = world.data[y * world.width + x];
		}
		const { tracks } = run({
			options: { kind: "static", frameCount: 30, extra: CENTRE, cutAt: 20, worldAfterCut: mixed },
		});
		expect(tracks.cuts).toEqual([20]);
		expect(tracks.stats.lostFraction[20]).toBeGreaterThan(0.6);
		expect(tracks.stats.lostFraction[20]).toBeLessThan(0.9);
		for (let id = 0; id < tracks.trackLen.length; id++) {
			const first = tracks.trackStart[id];
			const last = first + tracks.trackLen[id] - 1;
			expect(first <= 19 ? last <= 19 : first >= 20).toBe(true);
		}
	});

	test("an exposure flash and a lasting brightness step are not cuts", () => {
		const { tracks } = run({
			options: {
				kind: "hand",
				frameCount: 40,
				extra: CENTRE,
				exposure: [
					{ t0: 10, t1: 12, gain: 1.6, offset: 30 },
					{ t0: 25, t1: 40, gain: 1.25, offset: 15 },
				],
			},
		});
		expect(tracks.cuts).toEqual([]);
		expect(liveCount({ tracks, f: 11 })).toBeGreaterThan(60);
		expect(liveCount({ tracks, f: 26 })).toBeGreaterThan(60);
	});

	test("a feature cap is respected", () => {
		const { tracks } = run({
			options: { kind: "hand", frameCount: 20, extra: CENTRE },
			trackerOptions: { maxFeatures: 25 },
		});
		const counts = Array.from({ length: 20 }, (_, f) => liveCount({ tracks, f }));
		expect(Math.max(...counts)).toBeLessThanOrEqual(25);
		expect(Math.max(...counts)).toBeGreaterThan(15);
	});

	test("the same frames always give the same tracks", () => {
		const options: SequenceOptions = { kind: "combo", frameCount: 25, extra: CENTRE };
		const a = run({ options }).tracks;
		const b = run({ options }).tracks;
		expect(Array.from(b.xy)).toEqual(Array.from(a.xy));
		expect(Array.from(b.trackStart)).toEqual(Array.from(a.trackStart));
		expect(Array.from(b.liveIds)).toEqual(Array.from(a.liveIds));
	});

	test("finishing a clip with a single frame is fine", () => {
		const { tracks } = run({ options: { kind: "static", frameCount: 1, extra: CENTRE } });
		expect(tracks.frameCount).toBe(1);
		expect(liveCount({ tracks, f: 0 })).toBeGreaterThan(50);
		for (let id = 0; id < tracks.trackLen.length; id++) expect(tracks.trackLen[id]).toBe(1);
	});

	test("refuses frames of the wrong size and frames after finish", () => {
		const tracker = new FeatureTracker({ w: W, h: H, fps: 30 });
		expect(() => tracker.push({ w: 100, h: 50, data: new Uint8Array(5000) })).toThrow();
		expect(() => tracker.push({ w: W, h: H, data: new Uint8Array(10) })).toThrow();
		const frame = { w: W, h: H, data: new Uint8Array(W * H) };
		tracker.push(frame);
		const done = tracker.finish();
		expect(tracker.finish()).toBe(done);
		expect(() => tracker.push(frame)).toThrow();
	});

	test("refuses a window the workspace cannot hold", () => {
		expect(() => new FeatureTracker({ w: W, h: H, fps: 30, options: { half: 40 } })).toThrow();
		expect(() => new FeatureTracker({ w: 0, h: H, fps: 30 })).toThrow();
	});

	test("frames too small for three pyramid levels are refused with a RangeError", () => {
		for (const [w, h] of [
			[3, 3],
			[1, 1],
			[480, 1],
			[1, 480],
		]) {
			expect(() => new FeatureTracker({ w, h, fps: 30 })).toThrow(RangeError);
		}
	});

	test("the frame rate is required: it is the one number the tracks cannot get from the frames", () => {
		expect(() => new FeatureTracker({ w: W, h: H, fps: 0 })).toThrow(RangeError);
		expect(() => new FeatureTracker({ w: W, h: H, fps: Number.NaN })).toThrow(RangeError);
		expect(() => new FeatureTracker({ w: W, h: H, fps: -30 })).toThrow(RangeError);
		// @ts-expect-error fps has no default
		expect(() => new FeatureTracker({ w: W, h: H })).toThrow(RangeError);
	});

	test("a clip that was never pushed to cannot be finished", () => {
		expect(() => new FeatureTracker({ w: W, h: H, fps: 30 }).finish()).toThrow();
	});
});
