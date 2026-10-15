import { describe, expect, test } from "bun:test";
import { makeScene, packTracks, syntheticTracks } from "../synth3d";
import {
	longestScene,
	medianLive,
	motionExtent,
	pairData,
	prepareTracks,
	sceneRanges,
	selectKeyframes,
} from "../tracks";

describe("scenes between cuts", () => {
	test("ranges cover the clip and the longest one wins (the first of equals)", () => {
		expect(sceneRanges({ frameCount: 100, cuts: [30, 80] })).toEqual([
			{ first: 0, end: 30 },
			{ first: 30, end: 80 },
			{ first: 80, end: 100 },
		]);
		expect(longestScene({ frameCount: 100, cuts: [30, 80] })).toEqual({ first: 30, end: 80 });
		expect(longestScene({ frameCount: 100, cuts: [50] })).toEqual({ first: 0, end: 50 });
		expect(longestScene({ frameCount: 100, cuts: [] })).toEqual({ first: 0, end: 100 });
		// a cut on frame 0 or past the end is no cut
		expect(sceneRanges({ frameCount: 10, cuts: [0, 10, 12] })).toEqual([{ first: 0, end: 10 }]);
	});
});

describe("prepareTracks", () => {
	test("converts index pixels to frame pixels relative to the centre and drops excluded and short tracks", () => {
		// 3 tracks on a 480 x 270 analysis of a 1920 x 1080 frame
		const tracks = packTracks({
			width: 480,
			height: 270,
			frameCount: 6,
			fps: 30,
			starts: [0, 1, 2],
			samples: [
				[-0.5, -0.5, 0, 0, 239.5, 134.5, 479.5, 269.5],
				[10, 10, 11, 11, 12, 12, 13, 13],
				[5, 5, 6, 6],
			],
			cuts: [],
		});
		const st = prepareTracks({ tracks, frameWidth: 1920, frameHeight: 1080, scene: { first: 0, end: 6 }, excluded: new Set([1]) });
		// track 1 excluded, track 2 has only 2 frames
		expect(Array.from(st.trackIds)).toEqual([0]);
		// index -0.5 is the left edge of the picture: frame x 0, i.e. -960 from the centre
		expect(Array.from(st.uv.subarray(0, 8))).toEqual([-960, -540, -958, -538, 0, 0, 960, 540]);
		expect(st.pixelScale).toBe(4);
		expect(Array.from(st.liveOffsets)).toEqual([0, 1, 2, 3, 4, 4, 4]);
	});

	test("a scene range clips the tracks and renumbers the frames", () => {
		const tracks = packTracks({
			width: 480,
			height: 270,
			frameCount: 10,
			fps: 30,
			starts: [0, 5],
			samples: [
				[1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
				[1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
			],
			cuts: [5],
		});
		const st = prepareTracks({ tracks, frameWidth: 1920, frameHeight: 1080, scene: { first: 5, end: 10 } });
		expect(st.firstFrame).toBe(5);
		expect(st.frameCount).toBe(5);
		expect(Array.from(st.trackIds)).toEqual([1]);
		expect(Array.from(st.start)).toEqual([0]);
	});
});

describe("statistics and keyframes", () => {
	const scene = makeScene({ name: "pan-parallax", frameCount: 90 });
	const { tracks } = syntheticTracks({ scene, width: 480, noise: 0.05, pointCount: 600, seed: 3 });
	const st = prepareTracks({ tracks, frameWidth: 1920, frameHeight: 1080, scene: { first: 0, end: 90 } });

	test("a moving camera moves the tracks; a frozen copy of them does not", () => {
		expect(medianLive(st)).toBeGreaterThan(50);
		expect(motionExtent(st)).toBeGreaterThan(5);
		const frozen = { ...st, uv: Float64Array.from(st.uv) };
		for (let t = 0; t < frozen.trackIds.length; t++) {
			for (let j = 1; j < frozen.length[t]; j++) {
				frozen.uv[2 * (frozen.offset[t] + j)] = frozen.uv[2 * frozen.offset[t]];
				frozen.uv[2 * (frozen.offset[t] + j) + 1] = frozen.uv[2 * frozen.offset[t] + 1];
			}
		}
		expect(motionExtent(frozen)).toBe(0);
	});

	test("keyframes start and end the scene, ascend and respect the gap limits", () => {
		const keyframes = selectKeyframes({ st });
		expect(keyframes[0]).toBe(0);
		expect(keyframes[keyframes.length - 1]).toBe(89);
		for (let k = 1; k < keyframes.length; k++) {
			expect(keyframes[k]).toBeGreaterThan(keyframes[k - 1]);
			expect(keyframes[k] - keyframes[k - 1]).toBeLessThanOrEqual(12);
		}
		const capped = selectKeyframes({ st, options: { keepShare: 1, moveShare: 0, maxGap: 1, maxKeyframes: 10 } });
		expect(capped.length).toBeLessThanOrEqual(11);
	});

	test("pair data lists the tracks alive on both frames with their samples", () => {
		const pair = pairData({ st, a: 10, b: 20 });
		expect(pair.n).toBeGreaterThan(10);
		for (let i = 0; i < pair.n; i++) {
			const t = pair.tracks[i];
			expect(st.start[t]).toBeLessThanOrEqual(10);
			expect(st.start[t] + st.length[t] - 1).toBeGreaterThanOrEqual(20);
			expect(pair.pa[2 * i]).toBe(st.uv[2 * (st.offset[t] + 10 - st.start[t])]);
		}
	});
});
