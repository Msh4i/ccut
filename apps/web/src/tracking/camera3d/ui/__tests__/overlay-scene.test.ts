import { describe, expect, test } from "bun:test";
import { projectToCanvas } from "@/scene3d/camera";
import type { Vec3 } from "@/scene3d/types";
import type { VideoElement } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { buildData, buildDecoded, buildSolve, buildTracks, straightCamera } from "./fixtures";
import {
	buildOverlayScene,
	hoverAt,
	MAX_DRAWN_POINTS,
	pressRole,
	selectionHitAt,
	selectionTarget,
	trackIdsInRegion,
} from "../overlay-scene";
import { MARKER_BASE_PX } from "../markers";

const sec = (seconds: number) => mediaTimeFromSeconds({ seconds });

// a 1920x1080 clip filling a 1920x1080 canvas: frame px = canvas px
const clip: VideoElement = {
	id: "v", type: "video", name: "v", mediaId: "media-1", startTime: sec(10), duration: sec(5),
	trimStart: sec(2), trimEnd: ZERO_MEDIA_TIME, params: {},
};

// 6 points on the plane z = 0, seen by a camera at z = -1000 (focal 1000), analysis 480x270 = frame / 4
const WORLD: Vec3[] = [
	[-400, -200, 0], [0, -250, 0], [400, -200, 0],
	[-400, 200, 0], [0, 250, 0], [400, 200, 0],
];
const camera = straightCamera([0, 0, -1000]);
function indexSample(point: Vec3): [number, number] {
	// frame px = (960 + x, 540 + y) at depth 1000 with focal 1000; index = frame / 4 - 0.5
	return [(960 + point[0]) / 4 - 0.5, (540 + point[1]) / 4 - 0.5];
}
const tracks = buildTracks({
	frameCount: 3,
	fps: 10,
	tracks: WORLD.map((point) => ({ start: 0, samples: [indexSample(point), indexSample(point), indexSample(point)] })),
});
const solve = buildSolve({ cameras: [camera, camera, camera], points: WORLD.map((position, trackId) => ({ trackId, position })) });
const data = buildData({ sourceStart: 2, fps: 10, frameCount: 3 });

function scene({ display = "3d-solved", deleted = [], time = sec(10.1) }: { display?: "2d-source" | "3d-solved"; deleted?: number[]; time?: ReturnType<typeof sec> } = {}) {
	const decoded = buildDecoded({ data: { ...data, settings: { ...data.settings, showTrackPoints: display } }, tracks, solve, deleted });
	return buildOverlayScene({ decoded, clip, time, canvasWidth: 1920, canvasHeight: 1080 });
}

describe("buildOverlayScene", () => {
	test("playhead 10.1 s = source 2.1 s = analysis frame 1; 3D Solved points projected, sized, triangulated", () => {
		const result = scene();
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.frame).toBeCloseTo(1, 9);
		expect(result.index).toBe(1);
		expect(result.points.map((point) => point.trackId)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(result.points[0].x).toBeCloseTo(560, 6);
		expect(result.points[0].y).toBeCloseTo(340, 6);
		expect(result.sizes).toEqual(Array(6).fill(MARKER_BASE_PX));
		expect(result.triangles().length).toBe(4);
		expect(result.triangles()).toBe(result.triangles());
		expect(result.view?.kind).toBe("tracked");
	});

	test("2D Source gives the same places here (the tracks are exact) and deleted points disappear", () => {
		const result = scene({ display: "2d-source", deleted: [2] });
		expect(result?.points.map((point) => point.trackId)).toEqual([0, 1, 3, 4, 5]);
		expect(result?.points[0].x).toBeCloseTo(560, 6);
		expect(result?.points[0].y).toBeCloseTo(340, 6);
	});

	test("outside the analysis: a scene with no points", () => {
		const result = scene({ time: sec(14) });
		expect(result?.index).toBeNull();
		expect(result?.points).toEqual([]);
		expect(result?.triangles()).toEqual([]);
	});

	test("a hostile frame with more live points than the cap draws only the first ones (lowest ids)", () => {
		const many = buildTracks({
			frameCount: 1,
			fps: 10,
			tracks: Array.from({ length: MAX_DRAWN_POINTS + 7 }, (_, i) => ({ start: 0, samples: [[i % 480, (i * 7) % 270] as const] })),
		});
		const decoded = buildDecoded({ data: { ...data, settings: { ...data.settings, showTrackPoints: "2d-source" } }, tracks: many, solve: null });
		const result = buildOverlayScene({ decoded, clip, time: sec(10), canvasWidth: 1920, canvasHeight: 1080 });
		expect(result?.points).toHaveLength(MAX_DRAWN_POINTS);
		expect(result?.points[MAX_DRAWN_POINTS - 1].trackId).toBe(MAX_DRAWN_POINTS - 1);
		expect(result?.sizes).toHaveLength(MAX_DRAWN_POINTS);
	});

	test("no tracks, or a zero-size canvas: no scene", () => {
		expect(buildOverlayScene({ decoded: buildDecoded({ data, tracks: null, solve }), clip, time: sec(10.1), canvasWidth: 1920, canvasHeight: 1080 })).toBeNull();
		const decoded = buildDecoded({ data, tracks, solve });
		expect(buildOverlayScene({ decoded, clip, time: sec(10.1), canvasWidth: 0, canvasHeight: 0 })).toBeNull();
	});
});

describe("click, region and press decisions", () => {
	test("a click on a solved point selects it; on a point without a 3D position, nothing; between points, the triangle", () => {
		const result = scene();
		if (!result) throw new Error("scene");
		expect(selectionHitAt({ scene: result, at: { x: 560, y: 340 }, pointRadius: 6 })).toEqual({ kind: "point", trackId: 0 });
		const unsolved = { ...result, solved: new Map([...result.solved].filter(([id]) => id !== 0)) };
		expect(selectionHitAt({ scene: unsolved, at: { x: 560, y: 340 }, pointRadius: 6 })).toEqual({ kind: "none" });
		expect(selectionHitAt({ scene: result, at: { x: 700, y: 400 }, pointRadius: 6 }).kind).toBe("triangle");
		expect(selectionHitAt({ scene: result, at: { x: 5, y: 5 }, pointRadius: 6 })).toEqual({ kind: "none" });
	});

	test("marquee and lasso give the track ids of the selectable points inside", () => {
		const result = scene();
		if (!result) throw new Error("scene");
		expect(trackIdsInRegion({ scene: result, region: { kind: "rect", from: { x: 500, y: 200 }, to: { x: 1000, y: 400 } } })).toEqual([0, 1]);
		const lasso = [{ x: 900, y: 700 }, { x: 1400, y: 700 }, { x: 1400, y: 850 }, { x: 900, y: 850 }];
		expect(trackIdsInRegion({ scene: result, region: { kind: "polygon", polygon: lasso } })).toEqual([4, 5]);
	});

	test("a press in the target's centre area moves it (Alt resizes); elsewhere it selects", () => {
		const handle = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
		expect(pressRole({ at: { x: 5, y: 5 }, alt: false, moveHandle: handle })).toBe("move-target");
		expect(pressRole({ at: { x: 5, y: 5 }, alt: true, moveHandle: handle })).toBe("resize-target");
		expect(pressRole({ at: { x: 50, y: 5 }, alt: true, moveHandle: handle })).toBe("select");
		expect(pressRole({ at: { x: 5, y: 5 }, alt: false, moveHandle: null })).toBe("select");
	});
});

describe("hoverAt and selectionTarget", () => {
	test("a point under the pointer wins over the triangle around it; between points the triangle's track ids", () => {
		const result = scene();
		if (!result) throw new Error("scene");
		const onPoint = hoverAt({ scene: result, at: { x: 561, y: 341 }, pointRadius: 6 });
		expect(onPoint.trackId).toBe(0);
		expect(onPoint.triangleIds).toBeNull();
		const between = hoverAt({ scene: result, at: { x: 700, y: 400 }, pointRadius: 6 });
		expect(between.trackId).toBeNull();
		expect(between.triangleIds?.length).toBe(3);
		const outside = hoverAt({ scene: result, at: { x: 5, y: 5 }, pointRadius: 6 });
		expect(outside).toEqual({ trackId: null, triangleIds: null, triangle: null });
	});

	test("the selection's target sits on the plane of its solved points; a centre override moves it", () => {
		const result = scene();
		if (!result?.view) throw new Error("scene");
		const target = selectionTarget({ selection: [0, 1, 3, 4], solved: result.solved, view: result.view, targetSize: 100, centerOverride: null });
		expect(target).not.toBeNull();
		if (!target) return;
		expect(target.normal[2]).toBeCloseTo(-1, 9);
		expect(target.center[0]).toBeCloseTo(-200, 9);
		const center = projectToCanvas({ view: result.view, point: target.center });
		expect(center?.x).toBeCloseTo(760, 6);
		const moved = selectionTarget({ selection: [0, 1, 3, 4], solved: result.solved, view: result.view, targetSize: 100, centerOverride: [50, 0, 0] });
		expect(moved?.center).toEqual([50, 0, 0]);
		expect(selectionTarget({ selection: [], solved: result.solved, view: result.view, targetSize: 100, centerOverride: null })).toBeNull();
		expect(selectionTarget({ selection: [42], solved: result.solved, view: result.view, targetSize: 100, centerOverride: null })).toBeNull();
	});
});
