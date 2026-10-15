import { describe, expect, spyOn, test } from "bun:test";
import * as codec from "../../codec";
import type { CameraTrackerData } from "../../types";
import { decodedParts, decodedSolve, decodedTracks } from "../decoded-cache";
import { normalizeCameraTracker } from "../normalize";
import { withDeletedTrackPoints } from "../tracker-tracks";
import { trackerData } from "./fixtures";

/** A record the way load hands it out: a plain JSON copy, validated. */
function loaded(): CameraTrackerData {
	const data = normalizeCameraTracker(JSON.parse(JSON.stringify(trackerData())));
	if (!data || !data.solve) throw new Error("fixture must load with a solve");
	return data;
}

describe("a stored record is decoded once, whoever asks", () => {
	test("validation at load decodes the tracks and the solve; asking again, from either side, does not", () => {
		const tracksSpy = spyOn(codec, "unpackTracks");
		const solveSpy = spyOn(codec, "unpackSolve");
		try {
			const data = loaded();
			if (!data.solve) throw new Error("no solve");
			expect(tracksSpy).toHaveBeenCalledTimes(1);
			expect(solveSpy).toHaveBeenCalledTimes(1);
			decodedParts({ data });
			decodedTracks(data.tracks);
			decodedSolve(data.solve);
			decodedParts({ data: { ...data, stale: "solve" } });
			expect(tracksSpy).toHaveBeenCalledTimes(1);
			expect(solveSpy).toHaveBeenCalledTimes(1);
		} finally {
			tracksSpy.mockRestore();
			solveSpy.mockRestore();
		}
	});

	test("the engine side and the render side get the same decoded objects", () => {
		const data = loaded();
		if (!data.solve) throw new Error("no solve");
		const parts = decodedParts({ data });
		expect(parts.tracks).not.toBeNull();
		expect(parts.solve).not.toBeNull();
		expect(decodedSolve(data.solve)).toBe(parts.solve);
		expect(decodedTracks(data.tracks)).toBe(parts.tracks);
	});

	test("an edit that leaves the packed tracks and solve alone does not decode them again", () => {
		const data = loaded();
		const before = decodedParts({ data });
		const edited: CameraTrackerData = {
			...data,
			settings: { ...data.settings, trackPointSize: 50 },
			stale: "solve",
		};
		const after = decodedParts({ data: edited });
		expect(after.tracks).toBe(before.tracks);
		expect(after.solve).toBe(before.solve);
		expect(after.deleted).toBe(before.deleted);
	});

	test("deleting points gives a new deleted set and keeps the decoded arrays", () => {
		const data = loaded();
		const before = decodedParts({ data });
		const next = withDeletedTrackPoints({ data, trackIds: [1, 2] });
		if (!next) throw new Error("expected points to delete");
		const after = decodedParts({ data: next });
		expect([...after.deleted]).toEqual([1, 2]);
		expect(after.tracks).toBe(before.tracks);
		expect(after.solve).toBe(before.solve);
		expect(decodedParts({ data: next }).deleted).toBe(after.deleted);
	});

	test("another packed object is decoded afresh, and unreadable data is null (once)", () => {
		const data = loaded();
		if (!data.solve) throw new Error("no solve");
		const before = decodedParts({ data });
		const copy: CameraTrackerData = { ...data, solve: { ...data.solve }, tracks: { ...data.tracks } };
		expect(decodedParts({ data: copy }).solve).not.toBe(before.solve);
		expect(decodedParts({ data: copy }).tracks).not.toBe(before.tracks);
		const broken: CameraTrackerData = { ...data, tracks: { ...data.tracks, xy: "%%%%" }, solve: { ...data.solve, cameras: "!" } };
		expect(decodedParts({ data: broken }).tracks).toBeNull();
		expect(decodedParts({ data: broken }).solve).toBeNull();
		expect(decodedParts({ data: { ...data, solve: null } }).solve).toBeNull();
	});
});
