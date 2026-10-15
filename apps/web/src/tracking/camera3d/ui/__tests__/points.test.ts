import { describe, expect, test } from "bun:test";
import { affineApply } from "@/scene3d/math";
import { projectToCanvas, quadFrameToCanvas } from "@/scene3d/camera";
import { mediaTimeFromSeconds } from "@/wasm";
import { buildSolve, buildTracks, straightCamera } from "./fixtures";
import {
	analysisFrameAt,
	analysisIndexAt,
	clipSourceTimeAt,
	frameToCanvasFromBounds,
	trackedViewAt,
} from "../view";
import { solvedPositions, visiblePointsAt } from "../visible-points";
import { MARKER_BASE_PX, markerHue, markerSizes } from "../markers";

const sec = (seconds: number) => mediaTimeFromSeconds({ seconds });

describe("timing: playhead -> clip source time -> analysis frame", () => {
	test("source time includes trim and retime", () => {
		const clip = { startTime: sec(4), trimStart: sec(1), retime: { rate: 2 } };
		expect(clipSourceTimeAt({ clip, time: sec(6) })).toBeCloseTo(1 + 2 * 2, 6);
		expect(clipSourceTimeAt({ clip: { ...clip, retime: undefined }, time: sec(6) })).toBeCloseTo(3, 6);
	});

	test("analysis frame = (source time - sourceStart) * fps; index = nearest frame inside the analysis", () => {
		expect(analysisFrameAt({ sourceTime: 3.5, sourceStart: 1, fps: 30 })).toBeCloseTo(75, 9);
		expect(analysisIndexAt({ frame: 4.4, frameCount: 10 })).toBe(4);
		expect(analysisIndexAt({ frame: 4.6, frameCount: 10 })).toBe(5);
		expect(analysisIndexAt({ frame: -0.4, frameCount: 10 })).toBe(0);
		expect(analysisIndexAt({ frame: -0.6, frameCount: 10 })).toBeNull();
		expect(analysisIndexAt({ frame: 9.4, frameCount: 10 })).toBe(9);
		expect(analysisIndexAt({ frame: 9.6, frameCount: 10 })).toBeNull();
		expect(analysisIndexAt({ frame: Number.NaN, frameCount: 10 })).toBeNull();
		expect(analysisIndexAt({ frame: 0, frameCount: 0 })).toBeNull();
	});
});

describe("frame -> canvas map of the tracked clip", () => {
	test("bounds -> the compositor quad (flips from negative sizes) -> quadFrameToCanvas", () => {
		const bounds = { cx: 540, cy: 900, width: -1080, height: 607.5, rotation: 12 };
		const map = frameToCanvasFromBounds({ bounds, frameWidth: 1920, frameHeight: 1080 });
		const expected = quadFrameToCanvas({
			quad: { centerX: 540, centerY: 900, width: 1080, height: 607.5, rotationDegrees: 12, flipX: true, flipY: false },
			frameWidth: 1920,
			frameHeight: 1080,
		});
		expect(map).toEqual(expected);
	});

	test("zero-size canvas, clip or frame: no map", () => {
		expect(frameToCanvasFromBounds({ bounds: { cx: 0, cy: 0, width: 0, height: 0, rotation: 0 }, frameWidth: 1920, frameHeight: 1080 })).toBeNull();
		expect(frameToCanvasFromBounds({ bounds: { cx: 5, cy: 5, width: 10, height: 10, rotation: 0 }, frameWidth: 0, frameHeight: 1080 })).toBeNull();
		expect(frameToCanvasFromBounds({ bounds: { cx: 5, cy: 5, width: Number.NaN, height: 10, rotation: 0 }, frameWidth: 10, frameHeight: 10 })).toBeNull();
	});

	test("trackedViewAt interpolates the solved camera and keeps the frame size and map", () => {
		const solve = buildSolve({ cameras: [straightCamera([0, 0, -1000]), straightCamera([100, 0, -1000])], points: [] });
		const view = trackedViewAt({ solve, frame: 0.25, frameToCanvas: [0.5, 0, 10, 0, 0.5, 20] });
		expect(view?.kind).toBe("tracked");
		expect(view?.position[0]).toBeCloseTo(25, 9);
		expect(view?.frameWidth).toBe(1920);
		expect(view?.frameToCanvas).toEqual([0.5, 0, 10, 0, 0.5, 20]);
		expect(trackedViewAt({ solve: { ...solve, cameras: [] }, frame: 0, frameToCanvas: [1, 0, 0, 0, 1, 0] })).toBeNull();
	});
});

describe("visible points at a frame", () => {
	// track 0: frames 0-2, track 1: frames 1-4, track 2: frames 2-3 (deleted), track 3: frame 4 (no 3D point)
	const tracks = buildTracks({
		frameCount: 5,
		tracks: [
			{ start: 0, samples: [[10, 20], [11, 21], [12, 22]] },
			{ start: 1, samples: [[100, 50], [101, 51], [102, 52], [103, 53]] },
			{ start: 2, samples: [[200, 100], [201, 101]] },
			{ start: 4, samples: [[300, 150]] },
		],
	});
	const solve = buildSolve({
		cameras: [0, 1, 2, 3, 4].map((f) => straightCamera([f * 10, 0, -1000])),
		points: [
			{ trackId: 0, position: [-100, -50, 0] },
			{ trackId: 1, position: [200, 80, 500] },
			{ trackId: 2, position: [0, 0, 100] },
			{ trackId: 9, position: [0, 0, 0] },
		],
	});
	const solved = solvedPositions(solve);
	const map: [number, number, number, number, number, number] = [0.5, 0, 30, 0, 0.5, 40];

	test("2D Source: tracks alive at the index, index pixels -> frame pixels -> canvas; deleted hidden; world attached when solved", () => {
		const points = visiblePointsAt({
			display: "2d-source",
			tracks,
			index: 2,
			deleted: new Set([2]),
			solved,
			frameWidth: 1920,
			frameHeight: 1080,
			frameToCanvas: map,
			view: null,
		});
		expect(points.map((point) => point.trackId)).toEqual([0, 1]);
		// track 0, sample 2 = (12, 22) index px -> frame px ((12 + 0.5) * 4, (22 + 0.5) * 4)
		const expected = affineApply({ m: map, x: 12.5 * 4, y: 22.5 * 4 });
		expect(points[0].x).toBeCloseTo(expected.x, 9);
		expect(points[0].y).toBeCloseTo(expected.y, 9);
		expect(points[0].world).toEqual([-100, -50, 0]);
		expect(points[0].depth).toBeNull();
		const late = visiblePointsAt({ display: "2d-source", tracks, index: 4, deleted: new Set(), solved, frameWidth: 1920, frameHeight: 1080, frameToCanvas: map, view: null });
		expect(late.map((point) => point.trackId)).toEqual([1, 3]);
		expect(late[1].world).toBeNull();
	});

	test("3D Solved: solved points whose track is alive, projected through the view; behind the camera dropped", () => {
		const view = trackedViewAt({ solve, frame: 2, frameToCanvas: map });
		expect(view).not.toBeNull();
		if (!view) return;
		const points = visiblePointsAt({ display: "3d-solved", tracks, index: 2, deleted: new Set(), solved, frameWidth: 1920, frameHeight: 1080, frameToCanvas: map, view });
		expect(points.map((point) => point.trackId)).toEqual([0, 1, 2]);
		const expected = projectToCanvas({ view, point: [200, 80, 500] });
		expect(points[1].x).toBeCloseTo(expected?.x ?? Number.NaN, 9);
		expect(points[1].depth).toBeCloseTo(1500, 9);
		const behind = { ...view, position: [0, 0, 600] as const };
		const fromBehind = visiblePointsAt({ display: "3d-solved", tracks, index: 2, deleted: new Set(), solved, frameWidth: 1920, frameHeight: 1080, frameToCanvas: map, view: behind });
		expect(fromBehind.map((point) => point.trackId)).toEqual([]);
	});

	test("3D Solved without a view, or an index outside the analysis: nothing", () => {
		expect(visiblePointsAt({ display: "3d-solved", tracks, index: 2, deleted: new Set(), solved, frameWidth: 1920, frameHeight: 1080, frameToCanvas: map, view: null })).toEqual([]);
		expect(visiblePointsAt({ display: "2d-source", tracks, index: 7, deleted: new Set(), solved, frameWidth: 1920, frameHeight: 1080, frameToCanvas: map, view: null })).toEqual([]);
	});
});

describe("markers", () => {
	test("2D Source: one size, scaled by Track Point Size", () => {
		expect(markerSizes({ depths: [null, null], trackPointSize: 100, display: "2d-source" })).toEqual([MARKER_BASE_PX, MARKER_BASE_PX]);
		expect(markerSizes({ depths: [500, 2000], trackPointSize: 50, display: "2d-source" })).toEqual([MARKER_BASE_PX / 2, MARKER_BASE_PX / 2]);
	});

	test("3D Solved: nearer is bigger (median depth = base size), clamped", () => {
		const sizes = markerSizes({ depths: [500, 1000, 2000, 100000, 1], trackPointSize: 100, display: "3d-solved" });
		// median depth 1000
		expect(sizes[1]).toBeCloseTo(MARKER_BASE_PX, 9);
		expect(sizes[0]).toBeCloseTo(2 * MARKER_BASE_PX, 9);
		expect(sizes[2]).toBeCloseTo(0.5 * MARKER_BASE_PX, 9);
		expect(sizes[3]).toBeCloseTo(0.4 * MARKER_BASE_PX, 9);
		expect(sizes[4]).toBeCloseTo(2.5 * MARKER_BASE_PX, 9);
		const doubled = markerSizes({ depths: [500, 1000, 2000], trackPointSize: 200, display: "3d-solved" });
		expect(doubled[2]).toBeCloseTo(2 * MARKER_BASE_PX * 0.5, 9);
	});

	test("no points, missing depths and odd sizes stay finite", () => {
		expect(markerSizes({ depths: [], trackPointSize: 100, display: "3d-solved" })).toEqual([]);
		expect(markerSizes({ depths: [null, 800], trackPointSize: 100, display: "3d-solved" })).toEqual([MARKER_BASE_PX, MARKER_BASE_PX]);
		expect(markerSizes({ depths: [800], trackPointSize: -5, display: "3d-solved" })[0]).toBeGreaterThan(0);
		expect(markerSizes({ depths: [800], trackPointSize: Number.NaN, display: "2d-source" })[0]).toBe(MARKER_BASE_PX);
	});

	test("colours are stable per track and spread", () => {
		expect(markerHue(5)).toBe(markerHue(5));
		expect(markerHue(5)).not.toBe(markerHue(6));
		for (const id of [0, 1, 17, 123456]) {
			expect(markerHue(id)).toBeGreaterThanOrEqual(0);
			expect(markerHue(id)).toBeLessThan(360);
		}
	});
});
