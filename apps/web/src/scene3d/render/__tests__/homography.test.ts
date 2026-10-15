import { describe, expect, test } from "bun:test";
import {
	defaultViewCamera,
	layerToWorld,
	projectToCanvas,
	quadFrameToCanvas,
	worldToCamera,
} from "../../camera";
import { quatFromAxisAngle, quatMul } from "../../math";
import type { Transform3D, Vec3, ViewCamera } from "../../types";
import {
	applyHomography,
	depthOfLayer,
	isLayerDrawable,
	layerFacing,
	layerHomography,
	layerPixelScale,
	normalizeHomography,
	projectedLayerBounds,
} from "../homography";

const CANVAS = { width: 1080, height: 1920 };

/** A solved camera seen through a clip that sits rotated and flipped on a 9:16 canvas. */
function trackedView(): ViewCamera {
	const rotation = quatMul({
		a: quatFromAxisAngle({ axis: [0, 1, 0], radians: 0.35 }),
		b: quatFromAxisAngle({ axis: [1, 0, 0], radians: -0.2 }),
	});
	return {
		kind: "tracked",
		rotation,
		position: [120, -80, -1500],
		focalPx: 1400,
		frameWidth: 1920,
		frameHeight: 1080,
		frameToCanvas: quadFrameToCanvas({
			quad: {
				centerX: 540,
				centerY: 960,
				width: 1080,
				height: 607.5,
				rotationDegrees: 7,
				flipX: true,
				flipY: false,
			},
			frameWidth: 1920,
			frameHeight: 1080,
		}),
	};
}

const TILTED: Transform3D = {
	position: [40, 25, 300],
	orientationDeg: [20, -35, 10],
	rotationDeg: [0, 15, 5],
	scale: [1.2, 0.8, 1],
};

const SIZE = { contentWidth: 640, contentHeight: 360 };

function localOf({ u, v }: { u: number; v: number }): Vec3 {
	return [(u - 0.5) * SIZE.contentWidth, (v - 0.5) * SIZE.contentHeight, 0];
}

const UV_SAMPLES: { u: number; v: number }[] = [];
for (let i = 0; i <= 4; i++) {
	for (let j = 0; j <= 4; j++) UV_SAMPLES.push({ u: i / 4, v: j / 4 });
}

describe("layerHomography", () => {
	test("default camera: a layer at z = 0 with no rotation lands exactly on its 2D box", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const transform: Transform3D = {
			position: [30, -45, 0],
			orientationDeg: [0, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		const h = layerHomography({ view, transform, ...SIZE });
		const corners = [
			applyHomography({ h, u: 0, v: 0 }),
			applyHomography({ h, u: 1, v: 0 }),
			applyHomography({ h, u: 1, v: 1 }),
			applyHomography({ h, u: 0, v: 1 }),
		];
		const left = CANVAS.width / 2 + 30 - 320;
		const top = CANVAS.height / 2 - 45 - 180;
		const expected = [
			[left, top],
			[left + 640, top],
			[left + 640, top + 360],
			[left, top + 360],
		];
		corners.forEach((corner, index) => {
			expect(corner).not.toBeNull();
			expect(corner?.x).toBeCloseTo(expected[index][0], 9);
			expect(corner?.y).toBeCloseTo(expected[index][1], 9);
		});
	});

	test("agrees with projecting the layer's world points, and w is the camera depth", () => {
		const view = trackedView();
		const h = layerHomography({ view, transform: TILTED, ...SIZE });
		for (const uv of UV_SAMPLES) {
			const world = layerToWorld({ transform: TILTED, local: localOf(uv) });
			const truth = projectToCanvas({ view, point: world });
			const mapped = applyHomography({ h, ...uv });
			expect(truth).not.toBeNull();
			expect(mapped).not.toBeNull();
			expect(Math.abs((mapped?.x ?? 0) - (truth?.x ?? 0))).toBeLessThan(1e-7);
			expect(Math.abs((mapped?.y ?? 0) - (truth?.y ?? 0))).toBeLessThan(1e-7);
			expect(mapped?.w).toBeCloseTo(truth?.depth ?? 0, 7);
		}
	});

	test("w is negative where the layer is behind the camera", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const focal = view.focalPx;
		// A floor-like layer turned 90 degrees about x reaching past the camera.
		const transform: Transform3D = {
			position: [0, 200, -focal],
			orientationDeg: [90, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		const h = layerHomography({
			view,
			transform,
			contentWidth: 600,
			contentHeight: 2000,
		});
		for (const uv of UV_SAMPLES) {
			const world = layerToWorld({
				transform,
				local: [(uv.u - 0.5) * 600, (uv.v - 0.5) * 2000, 0],
			});
			const depth = worldToCamera({ camera: view, point: world })[2];
			const mapped = applyHomography({ h, ...uv });
			if (Math.abs(depth) < 1e-9) continue;
			expect(mapped === null ? 0 : Math.sign(mapped.w)).toBe(Math.sign(depth));
		}
	});
});

describe("normalizeHomography", () => {
	test("divides by the largest magnitude, keeps the sign and the map", () => {
		const h = layerHomography({ view: trackedView(), transform: TILTED, ...SIZE });
		const normalized = normalizeHomography(h);
		expect(normalized).not.toBeNull();
		if (!normalized) return;
		expect(Math.max(...normalized.map(Math.abs))).toBe(1);
		const scale = normalized[8] / h[8];
		expect(scale).toBeGreaterThan(0);
		for (const uv of UV_SAMPLES) {
			const a = applyHomography({ h, ...uv });
			const b = applyHomography({ h: normalized, ...uv });
			expect(b?.x).toBeCloseTo(a?.x ?? 0, 7);
			expect(b?.y).toBeCloseTo(a?.y ?? 0, 7);
			expect(Math.sign(b?.w ?? 0)).toBe(Math.sign(a?.w ?? 0));
		}
	});

	test("is null for a zero or non-finite matrix", () => {
		expect(normalizeHomography([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
		expect(normalizeHomography([1, 0, 0, 0, Number.NaN, 0, 0, 0, 1])).toBeNull();
		expect(
			normalizeHomography([1, 0, 0, 0, 1, Number.POSITIVE_INFINITY, 0, 0, 1]),
		).toBeNull();
	});
});

describe("depth, facing, drawability", () => {
	test("depthOfLayer is the camera-space z of the layer centre", () => {
		const view = trackedView();
		expect(depthOfLayer({ view, transform: TILTED })).toBeCloseTo(
			worldToCamera({ camera: view, point: TILTED.position })[2],
			12,
		);
	});

	test("a layer seen edge-on has facing ~0 and is not drawable", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		// The camera stands on the plane of a layer turned 90 degrees about y
		// whose centre is straight ahead.
		const edgeOn: Transform3D = {
			position: [0, 0, 0],
			orientationDeg: [0, 90, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		expect(Math.abs(layerFacing({ view, transform: edgeOn }))).toBeLessThan(1e-12);
		expect(isLayerDrawable({ view, transform: edgeOn, ...SIZE })).toBe(false);
		const facing: Transform3D = { ...edgeOn, orientationDeg: [0, 0, 0] };
		// +1: the front face (local -z) looks straight at the camera.
		expect(layerFacing({ view, transform: facing })).toBeCloseTo(1, 12);
		const backwards: Transform3D = { ...edgeOn, orientationDeg: [0, 180, 0] };
		expect(layerFacing({ view, transform: backwards })).toBeCloseTo(-1, 12);
		expect(isLayerDrawable({ view, transform: facing, ...SIZE })).toBe(true);
	});

	test("a layer entirely behind the camera, or with zero scale, is not drawable", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const behind: Transform3D = {
			position: [0, 0, -view.focalPx - 500],
			orientationDeg: [0, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		expect(isLayerDrawable({ view, transform: behind, ...SIZE })).toBe(false);
		const flat: Transform3D = { ...behind, position: [0, 0, 0], scale: [0, 1, 1] };
		expect(isLayerDrawable({ view, transform: flat, ...SIZE })).toBe(false);
	});
});

describe("projectedLayerBounds", () => {
	test("is the axis-aligned box of the projected corners when all are in front", () => {
		const view = trackedView();
		const bounds = projectedLayerBounds({
			view,
			transform: TILTED,
			...SIZE,
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		expect(bounds).not.toBeNull();
		const corners = [
			{ u: 0, v: 0 },
			{ u: 1, v: 0 },
			{ u: 1, v: 1 },
			{ u: 0, v: 1 },
		].map((uv) => {
			const point = projectToCanvas({
				view,
				point: layerToWorld({ transform: TILTED, local: localOf(uv) }),
			});
			if (!point) throw new Error("corner behind the camera");
			return point;
		});
		const xs = corners.map((corner) => corner.x);
		const ys = corners.map((corner) => corner.y);
		expect(bounds?.left).toBeCloseTo(Math.min(...xs), 7);
		expect(bounds?.right).toBeCloseTo(Math.max(...xs), 7);
		expect(bounds?.top).toBeCloseTo(Math.min(...ys), 7);
		expect(bounds?.bottom).toBeCloseTo(Math.max(...ys), 7);
	});

	test("is finite (clipped at the near plane, limited around the canvas) when part of the layer is behind", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const transform: Transform3D = {
			position: [0, 200, -view.focalPx],
			orientationDeg: [90, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		const bounds = projectedLayerBounds({
			view,
			transform,
			contentWidth: 600,
			contentHeight: 2000,
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		expect(bounds).not.toBeNull();
		if (!bounds) return;
		for (const value of [bounds.left, bounds.top, bounds.right, bounds.bottom]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(bounds.left).toBeGreaterThanOrEqual(-CANVAS.width);
		expect(bounds.right).toBeLessThanOrEqual(2 * CANVAS.width);
		expect(bounds.bottom).toBeLessThanOrEqual(2 * CANVAS.height);
		expect(bounds.right).toBeGreaterThan(bounds.left);
	});

	test("is null when the whole layer is behind the camera", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const transform: Transform3D = {
			position: [0, 0, -view.focalPx - 400],
			orientationDeg: [0, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		expect(
			projectedLayerBounds({
				view,
				transform,
				...SIZE,
				canvasWidth: CANVAS.width,
				canvasHeight: CANVAS.height,
			}),
		).toBeNull();
	});
});

describe("layerPixelScale", () => {
	test("is 1 for a layer that looks like its 2D self, and grows as the layer comes closer", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const flat: Transform3D = {
			position: [0, 0, 0],
			orientationDeg: [0, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		expect(layerPixelScale({ view, transform: flat, ...SIZE })).toBeCloseTo(1, 9);
		const closer: Transform3D = { ...flat, position: [0, 0, -view.focalPx / 2] };
		expect(layerPixelScale({ view, transform: closer, ...SIZE })).toBeCloseTo(2, 9);
	});

	test("is null when a corner is behind the camera", () => {
		const view = defaultViewCamera({
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		const transform: Transform3D = {
			position: [0, 200, -view.focalPx],
			orientationDeg: [90, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		expect(
			layerPixelScale({ view, transform, contentWidth: 600, contentHeight: 2000 }),
		).toBeNull();
	});
});
