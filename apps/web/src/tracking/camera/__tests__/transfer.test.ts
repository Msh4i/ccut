import { describe, expect, test } from "bun:test";
import { homographyAt, solvePin } from "../solve-pin";
import { collectTransferables } from "../transfer";
import type { FeatureTracks } from "../types";
import { buildTracks, scatterPoints } from "./camera-fixtures";
import { motionFor, specsFor, whole } from "./track-scenes";

function someTracks(): FeatureTracks {
	return buildTracks({
		frameCount: 30,
		cuts: [20],
		specs: specsFor({
			points: scatterPoints({ count: 50, seed: 4 }),
			life: whole(30),
			motion: motionFor("S"),
			frameCount: 30,
		}),
	});
}

describe("collectTransferables", () => {
	test("lists every buffer of the tracks once", () => {
		const tracks = someTracks();
		const buffers = collectTransferables({ tracks });
		const expected = new Set([
			tracks.trackStart.buffer,
			tracks.trackLen.buffer,
			tracks.trackOffset.buffer,
			tracks.xy.buffer,
			tracks.liveOffsets.buffer,
			tracks.liveIds.buffer,
			tracks.stats.lostFraction.buffer,
		]);
		expect(buffers.length).toBe(expected.size);
		for (const buffer of buffers) expect(expected.has(buffer)).toBe(true);
	});

	test("hands the tracks to a Worker without copying them: the clone is whole, the source is emptied", () => {
		const tracks = someTracks();
		const before = {
			xy: Array.from(tracks.xy),
			liveIds: Array.from(tracks.liveIds),
			start: Array.from(tracks.trackStart),
		};
		const clone = structuredClone(tracks, { transfer: collectTransferables({ tracks }) });
		expect(clone.frameCount).toBe(30);
		expect(clone.cuts).toEqual([20]);
		expect(clone.fps).toBe(30);
		expect(Array.from(clone.xy)).toEqual(before.xy);
		expect(Array.from(clone.liveIds)).toEqual(before.liveIds);
		expect(Array.from(clone.trackStart)).toEqual(before.start);
		// transferred, not copied
		expect(tracks.xy.byteLength).toBe(0);
		// and the clone is as good as the original
		const solution = solvePin({ tracks: clone, f0: 5, model: "S", mode: "scene" });
		expect(solution.ok[19]).toBe(1);
	});

	test("a buffer shared by two arrays is listed once, or the transfer would throw", () => {
		const tracks = someTracks();
		// trackStart and trackLen are two halves of one buffer
		const both = new Int32Array(2 * tracks.trackStart.length);
		both.set(tracks.trackStart, 0);
		both.set(tracks.trackLen, tracks.trackStart.length);
		const odd: FeatureTracks = {
			...tracks,
			trackStart: both.subarray(0, tracks.trackStart.length),
			trackLen: both.subarray(tracks.trackStart.length),
		};
		const buffers = collectTransferables({ tracks: odd });
		expect(buffers.filter((b) => b === both.buffer).length).toBe(1);
		// and the transfer itself goes through
		const clone = structuredClone(odd, { transfer: buffers });
		expect(Array.from(clone.trackLen)).toEqual(Array.from(tracks.trackLen));
	});

	test("a homography view into a solution is emptied when the solution's buffer is transferred", () => {
		const tracks = someTracks();
		const solution = solvePin({ tracks, f0: 5, model: "H", mode: "scene" });
		const view = homographyAt({ solution, t: 10 });
		expect(view.length).toBe(9);
		structuredClone(solution, { transfer: [solution.maps.buffer] });
		// the documented hazard: take a copy (`Float64Array.from(view)`) before transferring
		expect(view.length).toBe(0);
	});
});
