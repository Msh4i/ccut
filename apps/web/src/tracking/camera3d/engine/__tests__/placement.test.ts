import { describe, expect, test } from "bun:test";
import { layerToWorld, projectToFrame } from "@/scene3d/camera";
import { mDeterminant, quatToMat3, vDot, vLength, vSub } from "@/scene3d/math";
import { planeDistance } from "@/scene3d/plane";
import type { CameraState, Target, Transform3D, Vec3 } from "@/scene3d/types";
import { placeLayerOnTarget } from "../placement";
import { cameraAt, FRAME, unit } from "./fixtures";
import { layerLinear } from "@/scene3d/camera";

function project({ camera, point }: { camera: CameraState; point: Vec3 }) {
	const p = projectToFrame({ camera, frameWidth: FRAME.width, frameHeight: FRAME.height, point });
	if (!p) throw new Error("behind the camera");
	return p;
}

function corners({ transform, size }: { transform: Transform3D; size: { width: number; height: number } }): Vec3[] {
	const w = size.width / 2;
	const h = size.height / 2;
	return [
		[-w, -h, 0],
		[w, -h, 0],
		[w, h, 0],
		[-w, h, 0],
	].map(([x, y, z]) => layerToWorld({ transform, local: [x, y, z] }));
}

const CAMERA = cameraAt({ position: [-120, -350, -1400], yawDeg: 8, pitchDeg: -15, rollDeg: 3 });
const WALL: Target = { center: [80, -150, 600], normal: unit([0.1, -0.05, -1]), radius: 90 };
const FLOOR: Target = { center: [30, 0, 300], normal: [0, -1, 0], radius: 60 };

describe("placeLayerOnTarget", () => {
	for (const [name, target] of [
		["wall", WALL],
		["floor", FLOOR],
	] as const) {
		test(`${name}: centred on the target, flat on its plane, larger side = target diameter`, () => {
			const size = { width: 400, height: 100 };
			const transform = placeLayerOnTarget({ target, camera: CAMERA, contentSize: size });
			if (!transform) throw new Error("no placement");
			expect(transform.rotationDeg).toEqual([0, 0, 0]);
			expect(transform.scale[0]).toBeCloseTo((2 * target.radius) / 400, 12);
			expect(transform.scale[1]).toBe(transform.scale[0]);
			expect(transform.scale[2]).toBe(transform.scale[0]);
			const world = corners({ transform, size });
			const plane = { point: target.center, normal: target.normal };
			for (const corner of world) expect(Math.abs(planeDistance({ plane, point: corner }))).toBeLessThan(1e-9);
			expect(vLength(vSub({ a: world[1], b: world[0] }))).toBeCloseTo(2 * target.radius, 9);
			const centre = project({ camera: CAMERA, point: layerToWorld({ transform, local: [0, 0, 0] }) });
			const expected = project({ camera: CAMERA, point: target.center });
			expect(Math.hypot(centre.x - expected.x, centre.y - expected.y)).toBeLessThan(1e-9);
		});

		test(`${name}: front faces the camera and the content reads left to right, top to bottom`, () => {
			const transform = placeLayerOnTarget({ target, camera: CAMERA, contentSize: { width: 300, height: 300 } });
			if (!transform) throw new Error("no placement");
			const linear = layerLinear(transform);
			expect(mDeterminant(linear)).toBeGreaterThan(0);
			// local -z (the front) is the target normal, which faces the camera
			const front: Vec3 = [-linear[2], -linear[5], -linear[8]];
			expect(vDot({ a: unit(front), b: target.normal })).toBeCloseTo(1, 12);
			expect(vDot({ a: target.normal, b: vSub({ a: CAMERA.position, b: target.center }) })).toBeGreaterThan(0);
			const at = (local: Vec3) => project({ camera: CAMERA, point: layerToWorld({ transform, local }) });
			const centre = at([0, 0, 0]);
			expect(at([50, 0, 0]).x).toBeGreaterThan(centre.x);
			expect(at([0, 50, 0]).y).toBeGreaterThan(centre.y);
		});
	}

	test("local x follows the camera's right vector projected on the plane", () => {
		const transform = placeLayerOnTarget({ target: WALL, camera: CAMERA, contentSize: { width: 10, height: 10 } });
		if (!transform) throw new Error("no placement");
		const linear = layerLinear(transform);
		const xAxis = unit([linear[0], linear[3], linear[6]]);
		const r = quatToMat3(CAMERA.rotation);
		const right: Vec3 = [r[0], r[1], r[2]];
		const inPlane = unit(vSub({ a: right, b: [WALL.normal[0] * vDot({ a: right, b: WALL.normal }), WALL.normal[1] * vDot({ a: right, b: WALL.normal }), WALL.normal[2] * vDot({ a: right, b: WALL.normal })] }));
		expect(vDot({ a: xAxis, b: inPlane })).toBeCloseTo(1, 12);
	});

	test("degenerate input gives no placement", () => {
		const size = { width: 10, height: 10 };
		expect(placeLayerOnTarget({ target: { ...WALL, normal: [0, 0, 0] }, camera: CAMERA, contentSize: size })).toBeNull();
		expect(placeLayerOnTarget({ target: { ...WALL, radius: 0 }, camera: CAMERA, contentSize: size })).toBeNull();
		expect(placeLayerOnTarget({ target: WALL, camera: CAMERA, contentSize: { width: 0, height: 0 } })).toBeNull();
		expect(placeLayerOnTarget({ target: { ...WALL, center: [Number.NaN, 0, 0] }, camera: CAMERA, contentSize: size })).toBeNull();
	});

	test("a plane seen edge-on along the camera's right vector still gets an upright basis", () => {
		const r = quatToMat3(CAMERA.rotation);
		const right: Vec3 = [r[0], r[1], r[2]];
		const transform = placeLayerOnTarget({
			target: { center: [0, 0, 500], normal: right, radius: 50 },
			camera: CAMERA,
			contentSize: { width: 100, height: 100 },
		});
		if (!transform) throw new Error("no placement");
		expect(transform.orientationDeg.every(Number.isFinite)).toBe(true);
		expect(mDeterminant(layerLinear(transform))).toBeGreaterThan(0);
	});
});
