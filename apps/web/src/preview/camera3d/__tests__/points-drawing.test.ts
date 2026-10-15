import { describe, expect, test } from "bun:test";
import type { Target, ViewCamera } from "@/scene3d/types";
import { markerHue } from "@/tracking/camera3d/ui/markers";
import type { OverlayScene } from "@/tracking/camera3d/ui/overlay-scene";
import { TARGET_RING_FACTORS } from "@/tracking/camera3d/ui/target";
import { buildPointsDrawing } from "../points-drawing";

const view: ViewCamera = {
	kind: "tracked", rotation: [1, 0, 0, 0], position: [0, 0, -1000], focalPx: 1000,
	frameWidth: 1920, frameHeight: 1080, frameToCanvas: [1, 0, 0, 0, 1, 0],
};

const scene: OverlayScene = {
	frame: 1,
	index: 1,
	view,
	points: [
		{ trackId: 4, x: 100, y: 200, depth: 1000, world: [0, 0, 0] },
		{ trackId: 9, x: 300, y: 400, depth: null, world: null },
	],
	sizes: [10, 12],
	selectable: [0],
	triangles: () => [],
	solved: new Map(),
};

// canvas -> overlay: half size, shifted
const toOverlay = (point: { x: number; y: number }) => ({ x: point.x / 2 + 10, y: point.y / 2 + 20 });

describe("buildPointsDrawing", () => {
	test("markers in overlay pixels with size, hue, selection and dimming of points without a 3D position", () => {
		const drawing = buildPointsDrawing({ scene, selection: [4], hoverTriangle: null, target: null, gesture: { kind: "idle" }, toOverlay });
		expect(drawing.markers).toEqual([
			{ trackId: 4, x: 60, y: 120, size: 10, hue: markerHue(4), selected: true, dim: false },
			{ trackId: 9, x: 160, y: 220, size: 12, hue: markerHue(9), selected: false, dim: true },
		]);
		expect(drawing.triangle).toBeNull();
		expect(drawing.rings).toBeNull();
		expect(drawing.marquee).toBeNull();
		expect(drawing.lasso).toBeNull();
	});

	test("the hover triangle and the target's rings (outer first), mapped to the overlay", () => {
		const target: Target = { center: [0, 0, 0], normal: [0, 0, -1], radius: 100 };
		const drawing = buildPointsDrawing({
			scene,
			selection: [],
			hoverTriangle: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }],
			target,
			gesture: { kind: "idle" },
			toOverlay,
		});
		expect(drawing.triangle).toEqual([{ x: 10, y: 20 }, { x: 20, y: 20 }, { x: 10, y: 30 }]);
		expect(drawing.rings).toHaveLength(TARGET_RING_FACTORS.length);
		// facing the camera at depth 1000 with focal 1000: the outer ring is a circle of 100 canvas px = 50 overlay px around (490, 290)
		for (const point of drawing.rings?.[0] ?? []) {
			expect(Math.hypot(point.x - 490, point.y - 290)).toBeCloseTo(50, 6);
		}
		for (const point of drawing.rings?.[3] ?? []) {
			expect(Math.hypot(point.x - 490, point.y - 290)).toBeCloseTo(12.5, 6);
		}
	});

	test("a target partly behind the camera is not drawn", () => {
		const behind: Target = { center: [0, 0, -1000], normal: [1, 0, 0], radius: 100 };
		const drawing = buildPointsDrawing({ scene, selection: [], hoverTriangle: null, target: behind, gesture: { kind: "idle" }, toOverlay });
		expect(drawing.rings).toBeNull();
	});

	test("marquee rectangle and lasso path in overlay pixels", () => {
		const marquee = buildPointsDrawing({
			scene, selection: [], hoverTriangle: null, target: null, toOverlay,
			gesture: { kind: "marquee", start: { x: 100, y: 100 }, current: { x: 40, y: 160 }, shift: false },
		});
		expect(marquee.marquee).toEqual({ x: 30, y: 70, width: 30, height: 30 });
		const lasso = buildPointsDrawing({
			scene, selection: [], hoverTriangle: null, target: null, toOverlay,
			gesture: { kind: "lasso", path: [{ x: 0, y: 0 }, { x: 20, y: 40 }], lastScreen: { x: 0, y: 0 }, shift: false },
		});
		expect(lasso.lasso).toEqual([{ x: 10, y: 20 }, { x: 20, y: 40 }]);
	});

	test("no view: no target even when one is given", () => {
		const target: Target = { center: [0, 0, 0], normal: [0, 0, -1], radius: 100 };
		const drawing = buildPointsDrawing({ scene: { ...scene, view: null }, selection: [], hoverTriangle: null, target, gesture: { kind: "idle" }, toOverlay });
		expect(drawing.rings).toBeNull();
	});
});
