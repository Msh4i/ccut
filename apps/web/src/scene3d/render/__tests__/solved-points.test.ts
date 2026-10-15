import { describe, expect, test } from "bun:test";
import { projectToCanvas } from "../../camera";
import { trackedViewCamera } from "../active-camera";
import { trackPointColor, trackPointsAt } from "../solved-points";
import { packSolve, packTracks } from "@/tracking/camera3d/codec";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { CameraSolve } from "@/tracking/camera3d/types";
import { cameraSolve, FRAME_COUNT, featureTracks, seconds, trackerData, videoElement } from "./fixtures";

const CANVAS = { canvasWidth: 1080, canvasHeight: 1920 };

function renderingVideo({
	deletedTrackIds = [],
	trackPointSize = 100,
}: {
	deletedTrackIds?: number[];
	trackPointSize?: number;
} = {}) {
	return videoElement({
		cameraTracker: trackerData({
			settings: { renderTrackPoints: true, trackPointSize },
			deletedTrackIds,
		}),
	});
}

describe("trackPointsAt", () => {
	test("nothing unless Render Track Points is on", () => {
		expect(trackPointsAt({ video: videoElement(), time: seconds(1), ...CANVAS })).toBeNull();
		expect(
			trackPointsAt({ video: videoElement({ cameraTracker: null }), time: seconds(1), ...CANVAS }),
		).toBeNull();
	});

	test("the solved points of the tracks alive at the shown frame, projected through the clip's camera", () => {
		const video = renderingVideo();
		// Timeline 1 s -> analysis frame 15: tracks 0 (frames 0..59) and 1 (10..19) are alive.
		const result = trackPointsAt({ video, time: seconds(1), ...CANVAS });
		expect(result?.points.map((point) => point.trackId)).toEqual([0, 1]);
		const view = trackedViewCamera({ video, time: seconds(1), ...CANVAS });
		if (!view || !result) throw new Error("expected a tracked camera and points");
		const solve = cameraSolve();
		for (const point of result.points) {
			const solved = solve.points.find((candidate) => candidate.trackId === point.trackId);
			if (!solved) throw new Error("unknown track");
			const expected = projectToCanvas({ view, point: solved.position });
			expect(point.x).toBeCloseTo(expected?.x ?? Number.NaN, 6);
			expect(point.y).toBeCloseTo(expected?.y ?? Number.NaN, 6);
		}
		// Timeline 1.8 s -> frame 39: tracks 0 and 2.
		const later = trackPointsAt({ video, time: seconds(1.8), ...CANVAS });
		expect(later?.points.map((point) => point.trackId)).toEqual([0, 2]);
	});

	test("deleted track points are not drawn", () => {
		const result = trackPointsAt({
			video: renderingVideo({ deletedTrackIds: [1] }),
			time: seconds(1),
			...CANVAS,
		});
		expect(result?.points.map((point) => point.trackId)).toEqual([0]);
	});

	test("outside the analysed frames no point is drawn", () => {
		// Timeline 0 s -> frame -15.
		const result = trackPointsAt({ video: renderingVideo(), time: seconds(0), ...CANVAS });
		expect(result?.points).toEqual([]);
	});

	test("the marker size follows Track Point Size and the canvas", () => {
		const normal = trackPointsAt({ video: renderingVideo(), time: seconds(1), ...CANVAS });
		const double = trackPointsAt({
			video: renderingVideo({ trackPointSize: 200 }),
			time: seconds(1),
			...CANVAS,
		});
		expect(normal?.radius).toBeGreaterThan(0);
		expect(double?.radius).toBeCloseTo((normal?.radius ?? 0) * 2, 9);
		const small = trackPointsAt({
			video: renderingVideo(),
			time: seconds(1),
			canvasWidth: 540,
			canvasHeight: 960,
		});
		expect(small?.radius).toBeCloseTo((normal?.radius ?? 0) / 2, 9);
	});
});

/** A clip whose solve has `count` points, all alive on every analysis frame and in front of the camera. */
function crowdedVideo({ count }: { count: number }) {
	const base: FeatureTracks = featureTracks();
	const tracks: FeatureTracks = {
		...base,
		trackStart: new Int32Array(count),
		trackLen: new Int32Array(count).fill(FRAME_COUNT),
		trackOffset: Int32Array.from({ length: count }, (_, i) => i * FRAME_COUNT * 2),
		xy: new Float32Array(count * FRAME_COUNT * 2),
	};
	const solve: CameraSolve = {
		...cameraSolve(),
		points: Array.from({ length: count }, (_, trackId) => ({ trackId, position: [0, 0, 0], error: 0.2 })),
	};
	const data = trackerData({ settings: { renderTrackPoints: true } });
	return videoElement({ cameraTracker: { ...data, tracks: packTracks(tracks), solve: packSolve(solve) } });
}

describe("trackPointsAt with a crowded solve", () => {
	test("draws at most 5000 crosses, the first ones by track id, however many are alive", () => {
		const result = trackPointsAt({ video: crowdedVideo({ count: 6000 }), time: seconds(1), ...CANVAS });
		expect(result?.points).toHaveLength(5000);
		expect(result?.points[0].trackId).toBe(0);
		expect(result?.points[4999].trackId).toBe(4999);
	});

	test("below the cap every point is drawn", () => {
		const result = trackPointsAt({ video: crowdedVideo({ count: 40 }), time: seconds(1), ...CANVAS });
		expect(result?.points).toHaveLength(40);
	});
});

describe("trackPointColor", () => {
	test("is stable per track and differs between neighbours", () => {
		expect(trackPointColor(7)).toBe(trackPointColor(7));
		expect(trackPointColor(7)).not.toBe(trackPointColor(8));
	});
});
