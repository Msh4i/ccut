import { describe, expect, test } from "bun:test";
import { projectToCanvas } from "@/scene3d/camera";
import { quatFromAxisAngle, vCross, vDot, vLength, vNormalize, vSub } from "@/scene3d/math";
import { fitPlane } from "@/scene3d/plane";
import type { Vec3, ViewCamera } from "@/scene3d/types";
import {
	TARGET_BASE_RADIUS_FRACTION,
	TARGET_SIZE_RANGE,
	planeHitAt,
	resizedTargetSize,
	targetBaseRadius,
	targetFromPoints,
	targetOutline,
} from "../target";

const FRAME_W = 1920;
const FRAME_H = 1080;

function view({ position = [0, 0, -1000], rotation = [1, 0, 0, 0], frameToCanvas = [1, 0, 0, 0, 1, 0] }: {
	position?: Vec3;
	rotation?: ViewCamera["rotation"];
	frameToCanvas?: ViewCamera["frameToCanvas"];
} = {}): ViewCamera {
	return { kind: "tracked", rotation, position, focalPx: 1000, frameWidth: FRAME_W, frameHeight: FRAME_H, frameToCanvas };
}

function angleDeg({ a, b }: { a: Vec3; b: Vec3 }): number {
	const cos = Math.min(1, Math.abs(vDot({ a, b })) / (vLength(a) * vLength(b)));
	return (Math.acos(cos) * 180) / Math.PI;
}

function expectVec({ actual, expected, digits = 9 }: { actual: Vec3; expected: Vec3; digits?: number }) {
	for (let k = 0; k < 3; k++) expect(actual[k]).toBeCloseTo(expected[k], digits);
}

describe("targetFromPoints", () => {
	const camera = view();

	test("no point: no target", () => {
		expect(targetFromPoints({ points: [], camera, targetSize: 100 })).toBeNull();
	});

	test("one point: a plane through it facing the camera, radius from the target size", () => {
		const point: Vec3 = [300, -200, 500];
		const target = targetFromPoints({ points: [point], camera, targetSize: 100 });
		expect(target).not.toBeNull();
		if (!target) return;
		expectVec({ actual: target.center, expected: point });
		const toCamera = vNormalize(vSub({ a: camera.position, b: point }));
		if (toCamera) expectVec({ actual: target.normal, expected: toCamera });
		const distance = vLength(vSub({ a: camera.position, b: point }));
		expect(target.radius).toBeCloseTo((TARGET_BASE_RADIUS_FRACTION * FRAME_H * distance) / 1000, 9);
		const double = targetFromPoints({ points: [point], camera, targetSize: 200 });
		expect(double?.radius).toBeCloseTo(target.radius * 2, 9);
	});

	test("two points: the plane holds both and faces the camera as much as it can", () => {
		const a: Vec3 = [-100, 50, 400];
		const b: Vec3 = [150, 20, 700];
		const target = targetFromPoints({ points: [a, b], camera, targetSize: 100 });
		expect(target).not.toBeNull();
		if (!target) return;
		const along = vSub({ a: b, b: a });
		expect(vDot({ a: target.normal, b: along })).toBeCloseTo(0, 9);
		expectVec({ actual: target.center, expected: [25, 35, 550] });
		const toCamera = vSub({ a: camera.position, b: target.center });
		expect(vDot({ a: target.normal, b: toCamera })).toBeGreaterThan(0);
		// no other normal perpendicular to the line is closer to the camera direction
		const direction = vNormalize(toCamera);
		if (!direction) return;
		const best = vDot({ a: target.normal, b: direction });
		for (let k = 0; k < 36; k++) {
			const angle = (k / 36) * Math.PI * 2;
			const u = vNormalize(vCross({ a: along, b: [0, 1, 0] }));
			const w = u ? vNormalize(vCross({ a: along, b: u })) : null;
			if (!u || !w) continue;
			const candidate: Vec3 = [
				Math.cos(angle) * u[0] + Math.sin(angle) * w[0],
				Math.cos(angle) * u[1] + Math.sin(angle) * w[1],
				Math.cos(angle) * u[2] + Math.sin(angle) * w[2],
			];
			expect(vDot({ a: candidate, b: direction })).toBeLessThanOrEqual(best + 1e-9);
		}
	});

	test("two points on the camera's line of sight still give a unit normal perpendicular to them", () => {
		const target = targetFromPoints({ points: [[0, 0, 0], [0, 0, 300]], camera, targetSize: 100 });
		expect(target).not.toBeNull();
		if (!target) return;
		expect(vLength(target.normal)).toBeCloseTo(1, 9);
		expect(target.normal[2]).toBeCloseTo(0, 9);
	});

	test("three or more points: the least-squares plane, normal towards the camera, centre = centroid", () => {
		// a floor below the camera (y down): y = 200
		const floor: Vec3[] = [
			[-300, 200, 200],
			[250, 200, 400],
			[40, 200, 900],
			[-120, 200, 650],
		];
		const target = targetFromPoints({ points: floor, camera, targetSize: 100 });
		expect(target).not.toBeNull();
		if (!target) return;
		expectVec({ actual: target.normal, expected: [0, -1, 0] });
		expectVec({ actual: target.center, expected: [-32.5, 200, 537.5] });
	});

	test("collinear points behave like the two outermost ones; coincident points like one", () => {
		const line: Vec3[] = [
			[0, 0, 100],
			[100, 0, 100],
			[50, 0, 100],
		];
		const fromLine = targetFromPoints({ points: line, camera, targetSize: 100 });
		const fromTwo = targetFromPoints({ points: [line[0], line[1]], camera, targetSize: 100 });
		expect(fromLine).not.toBeNull();
		if (fromLine && fromTwo) expectVec({ actual: fromLine.normal, expected: fromTwo.normal });
		const same: Vec3[] = [
			[10, 20, 30],
			[10, 20, 30],
			[10, 20, 30],
		];
		const fromSame = targetFromPoints({ points: same, camera, targetSize: 100 });
		const fromOne = targetFromPoints({ points: [same[0]], camera, targetSize: 100 });
		expect(fromSame).toEqual(fromOne);
	});

	test("robust: one stray point barely tilts the plane (plain least squares would)", () => {
		const points: Vec3[] = [];
		for (let i = 0; i < 9; i++) points.push([-400 + 100 * i, 200, 300 + ((i * 37) % 5) * 120]);
		const stray: Vec3 = [0, -150, 700];
		const withStray = [...points, stray];
		const plain = fitPlane({ points: withStray });
		expect(plain).not.toBeNull();
		if (plain) expect(angleDeg({ a: plain.normal, b: [0, 1, 0] })).toBeGreaterThan(5);
		const target = targetFromPoints({ points: withStray, camera, targetSize: 100 });
		expect(target).not.toBeNull();
		if (target) expect(angleDeg({ a: target.normal, b: [0, 1, 0] })).toBeLessThan(1);
	});

	test("a point at the camera centre gives no target", () => {
		expect(targetFromPoints({ points: [[0, 0, -1000]], camera, targetSize: 100 })).toBeNull();
	});
});

describe("plane picking, outline, resize", () => {
	const turned = view({
		position: [120, -80, -900],
		rotation: quatFromAxisAngle({ axis: [0, 1, 0], radians: 0.3 }),
		frameToCanvas: [0.5, 0.1, 40, -0.1, 0.5, 300],
	});
	const planePoint: Vec3 = [50, 100, 300];
	const fallbackNormal: Vec3 = [0, -1, 0];
	const plane = { point: planePoint, normal: vNormalize([0.2, -1, -0.3]) ?? fallbackNormal };

	test("planeHitAt inverts the projection of a point on the plane (frameToCanvas included)", () => {
		const u = vNormalize(vCross({ a: plane.normal, b: [1, 0, 0] }));
		if (!u) throw new Error("basis");
		const world: Vec3 = [plane.point[0] + 80 * u[0], plane.point[1] + 80 * u[1], plane.point[2] + 80 * u[2]];
		const canvas = projectToCanvas({ view: turned, point: world });
		expect(canvas).not.toBeNull();
		if (!canvas) return;
		const hit = planeHitAt({ view: turned, plane, canvasPoint: canvas });
		expect(hit).not.toBeNull();
		if (hit) expectVec({ actual: hit, expected: world, digits: 6 });
	});

	test("planeHitAt: null for a ray parallel to the plane or a degenerate canvas map", () => {
		const facing = view();
		const parallelPoint: Vec3 = [0, 0, 500];
		const parallelNormal: Vec3 = [0, 1, 0];
		const parallel = { point: parallelPoint, normal: parallelNormal };
		// the frame centre's ray runs along +z, inside the plane y = 0
		expect(planeHitAt({ view: facing, plane: parallel, canvasPoint: { x: FRAME_W / 2, y: FRAME_H / 2 } })).toBeNull();
		const flat = view({ frameToCanvas: [0, 0, 0, 0, 0, 0] });
		expect(planeHitAt({ view: flat, plane, canvasPoint: { x: 1, y: 1 } })).toBeNull();
	});

	test("targetOutline: a circle of the target's radius on its plane, seen through the camera", () => {
		const target = { center: plane.point, normal: plane.normal, radius: 90 };
		const outline = targetOutline({ target, view: turned, segments: 24 });
		expect(outline).toHaveLength(24);
		for (const point of outline ?? []) {
			const hit = planeHitAt({ view: turned, plane, canvasPoint: point });
			expect(hit).not.toBeNull();
			if (hit) expect(vLength(vSub({ a: hit, b: target.center }))).toBeCloseTo(90, 5);
		}
		const half = targetOutline({ target, view: turned, radiusFactor: 0.5, segments: 8 });
		expect(half).toHaveLength(8);
	});

	test("targetOutline: null when any part is behind the camera", () => {
		const behind: Vec3 = [0, 0, -1005];
		const back: Vec3 = [0, 0, -1];
		const target = { center: behind, normal: back, radius: 50 };
		expect(targetOutline({ target, view: view(), segments: 12 })).toBeNull();
		const atCamera: Vec3 = [0, 0, -1000];
		const sideways: Vec3 = [1, 0, 0];
		const across = { center: atCamera, normal: sideways, radius: 50 };
		expect(targetOutline({ target: across, view: view(), segments: 12 })).toBeNull();
	});

	test("resizedTargetSize: the target edge follows the pointer, clamped", () => {
		const camera = view();
		const center: Vec3 = [0, 200, 500];
		const up: Vec3 = [0, -1, 0];
		const target = { center, normal: up, radius: 10 };
		const base = targetBaseRadius({ center, camera });
		expect(base).not.toBeNull();
		if (!base) return;
		const edge = projectToCanvas({ view: camera, point: [2 * base, 200, 500] });
		expect(edge).not.toBeNull();
		if (!edge) return;
		expect(resizedTargetSize({ target, view: camera, canvasPoint: edge })).toBeCloseTo(200, 6);
		const near = projectToCanvas({ view: camera, point: [0.0001, 200, 500] });
		if (near) expect(resizedTargetSize({ target, view: camera, canvasPoint: near })).toBe(TARGET_SIZE_RANGE.min);
		const far = projectToCanvas({ view: camera, point: [400 * base, 200, 500] });
		if (far) expect(resizedTargetSize({ target, view: camera, canvasPoint: far })).toBe(TARGET_SIZE_RANGE.max);
		// above the horizon the ray misses the floor
		expect(resizedTargetSize({ target, view: camera, canvasPoint: { x: 960, y: 10 } })).toBeNull();
	});
});
