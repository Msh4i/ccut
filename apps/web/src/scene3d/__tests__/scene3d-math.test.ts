import { describe, expect, test } from "bun:test";
import { uvToCanvas } from "@/tracking/projection";
import {
	cameraAtFrame,
	defaultViewCamera,
	focalFromAngleOfViewDeg,
	frameRay,
	horizontalAngleOfViewDeg,
	layerToWorld,
	projectToCanvas,
	projectToFrame,
	quadFrameToCanvas,
} from "../camera";
import {
	affineApply,
	affineCompose,
	affineInverse,
	eulerDegToMat3,
	mApply,
	mat3ToEulerDeg,
	mat3ToQuat,
	mDeterminant,
	mInverse,
	mMul,
	quatAngle,
	quatFromAxisAngle,
	quatMul,
	quatSlerp,
	quatToMat3,
	vCross,
} from "../math";
import {
	fitPlane,
	intersectRayPlane,
	planeDistance,
	planeFacing,
	symmetricEigen3,
} from "../plane";
import type { CameraState, Mat3, Quat, Vec3 } from "../types";

function expectVecClose({
	actual,
	expected,
	digits = 9,
}: {
	actual: readonly number[];
	expected: readonly number[];
	digits?: number;
}) {
	expect(actual.length).toBe(expected.length);
	for (let i = 0; i < actual.length; i++) {
		expect(actual[i]).toBeCloseTo(expected[i], digits);
	}
}

const SAMPLE_EULERS: Vec3[] = [
	[0, 0, 0],
	[30, 0, 0],
	[0, 45, 0],
	[0, 0, -60],
	[12, -37, 101],
	[-80, 20, 170],
	[170, -10, -30],
];

describe("rotations", () => {
	test("euler is Rz Ry Rx: x applied first", () => {
		const m = eulerDegToMat3([90, 0, 90]);
		// x 90: y axis -> z axis; then z 90: z stays z
		expectVecClose({ actual: mApply({ m, v: [0, 1, 0] }), expected: [0, 0, 1] });
		// x axis is untouched by Rx, then Rz turns x into y (clockwise on screen, y down)
		expectVecClose({ actual: mApply({ m, v: [1, 0, 0] }), expected: [0, 1, 0] });
	});

	test("euler <-> matrix <-> quaternion round trips", () => {
		for (const euler of SAMPLE_EULERS) {
			const m = eulerDegToMat3(euler);
			expect(mDeterminant(m)).toBeCloseTo(1, 12);
			expectVecClose({ actual: eulerDegToMat3(mat3ToEulerDeg(m)), expected: m });
			const q = mat3ToQuat(m);
			expectVecClose({ actual: quatToMat3(q), expected: m });
		}
	});

	test("gimbal lock keeps the matrix", () => {
		const m = eulerDegToMat3([25, 90, 40]);
		expectVecClose({ actual: eulerDegToMat3(mat3ToEulerDeg(m)), expected: m, digits: 6 });
	});

	test("quaternion product matches matrix product", () => {
		const a = mat3ToQuat(eulerDegToMat3([12, -37, 101]));
		const b = mat3ToQuat(eulerDegToMat3([-80, 20, 170]));
		expectVecClose({
			actual: quatToMat3(quatMul({ a, b })),
			expected: mMul({ a: quatToMat3(a), b: quatToMat3(b) }),
		});
	});

	test("slerp: ends, midpoint angle, shortest arc", () => {
		const axis: Vec3 = [0, 1, 0];
		const a = quatFromAxisAngle({ axis, radians: 0.2 });
		const b = quatFromAxisAngle({ axis, radians: 1.0 });
		expectVecClose({ actual: quatSlerp({ a, b, t: 0 }), expected: a });
		expectVecClose({ actual: quatSlerp({ a, b, t: 1 }), expected: b });
		const mid = quatSlerp({ a, b, t: 0.5 });
		expectVecClose({ actual: mid, expected: quatFromAxisAngle({ axis, radians: 0.6 }) });
		const negated: Quat = [-b[0], -b[1], -b[2], -b[3]];
		expect(quatAngle({ a: quatSlerp({ a, b: negated, t: 0.5 }), b: mid })).toBeLessThan(1e-9);
	});

	test("inverse of a general matrix", () => {
		const m: Mat3 = [2, 1, 0, -1, 3, 2, 0.5, 0, 1];
		const inv = mInverse(m);
		expect(inv).not.toBeNull();
		if (inv) expectVecClose({ actual: mMul({ a: m, b: inv }), expected: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
		expect(mInverse([1, 2, 3, 2, 4, 6, 0, 1, 1])).toBeNull();
	});
});

describe("projection", () => {
	const camera: CameraState = {
		rotation: mat3ToQuat(eulerDegToMat3([5, -12, 3])),
		position: [10, -20, -500],
		focalPx: 1200,
	};

	test("a point on the optical axis lands on the frame centre", () => {
		const forward = frameRay({ camera, frameWidth: 1920, frameHeight: 1080, x: 960, y: 540 });
		const point: Vec3 = [
			forward.origin[0] + forward.direction[0] * 800,
			forward.origin[1] + forward.direction[1] * 800,
			forward.origin[2] + forward.direction[2] * 800,
		];
		const p = projectToFrame({ camera, frameWidth: 1920, frameHeight: 1080, point });
		expect(p).not.toBeNull();
		if (p) {
			expect(p.x).toBeCloseTo(960, 9);
			expect(p.y).toBeCloseTo(540, 9);
			expect(p.depth).toBeCloseTo(800, 9);
		}
	});

	test("frameRay inverts projectToFrame", () => {
		for (const [x, y] of [
			[0, 0],
			[1920, 1080],
			[123.25, 987.5],
		]) {
			const ray = frameRay({ camera, frameWidth: 1920, frameHeight: 1080, x, y });
			const point: Vec3 = [
				ray.origin[0] + ray.direction[0] * 333,
				ray.origin[1] + ray.direction[1] * 333,
				ray.origin[2] + ray.direction[2] * 333,
			];
			const p = projectToFrame({ camera, frameWidth: 1920, frameHeight: 1080, point });
			expect(p?.x).toBeCloseTo(x, 8);
			expect(p?.y).toBeCloseTo(y, 8);
		}
	});

	test("points behind the camera are not projected", () => {
		const behind: Vec3 = [camera.position[0], camera.position[1], camera.position[2] - 10];
		const local = projectToFrame({
			camera: { ...camera, rotation: [1, 0, 0, 0] },
			frameWidth: 100,
			frameHeight: 100,
			point: behind,
		});
		expect(local).toBeNull();
	});

	test("angle of view and focal length are inverse", () => {
		const focal = focalFromAngleOfViewDeg({ degrees: 60, frameWidth: 1920 });
		expect(focal).toBeCloseTo(960 / Math.tan(Math.PI / 6), 9);
		expect(horizontalAngleOfViewDeg({ focalPx: focal, frameWidth: 1920 })).toBeCloseTo(60, 9);
	});

	test("default camera: a layer at z = 0 looks 2D (canvas centre origin, 1 unit = 1 px)", () => {
		const view = defaultViewCamera({ canvasWidth: 1080, canvasHeight: 1920 });
		const p = projectToCanvas({ view, point: [-200, 300, 0] });
		expect(p?.x).toBeCloseTo(540 - 200, 9);
		expect(p?.y).toBeCloseTo(960 + 300, 9);
		// farther away = smaller, around the centre
		const far = projectToCanvas({ view, point: [-200, 300, view.focalPx] });
		expect(far?.x).toBeCloseTo(540 - 100, 9);
	});

	test("layerToWorld: orientation then rotation, scale on local units", () => {
		const point = layerToWorld({
			transform: {
				position: [1, 2, 3],
				orientationDeg: [0, 0, 90],
				rotationDeg: [0, 0, 0],
				scale: [2, 1, 1],
			},
			local: [10, 0, 0],
		});
		expectVecClose({ actual: point, expected: [1, 22, 3] });
	});
});

describe("camera path", () => {
	const frames: CameraState[] = [
		{ rotation: [1, 0, 0, 0], position: [0, 0, 0], focalPx: 1000 },
		{
			rotation: quatFromAxisAngle({ axis: [0, 1, 0], radians: 0.4 }),
			position: [10, 0, 0],
			focalPx: 1200,
		},
	];

	test("holds the ends and interpolates inside", () => {
		expect(cameraAtFrame({ frames, frame: -3 })).toBe(frames[0]);
		expect(cameraAtFrame({ frames, frame: 7 })).toBe(frames[1]);
		const mid = cameraAtFrame({ frames, frame: 0.5 });
		expect(mid?.position[0]).toBeCloseTo(5, 12);
		expect(mid?.focalPx).toBeCloseTo(1100, 12);
		if (mid) expect(quatAngle({ a: mid.rotation, b: frames[0].rotation })).toBeCloseTo(0.2, 9);
		expect(cameraAtFrame({ frames: [], frame: 0 })).toBeNull();
	});
});

describe("quadFrameToCanvas", () => {
	const cases = [
		{ centerX: 540, centerY: 960, width: 1080, height: 607.5, rotationDegrees: 0, flipX: false, flipY: false },
		{ centerX: 300, centerY: 700, width: 900, height: 500, rotationDegrees: 17, flipX: false, flipY: false },
		{ centerX: 610, centerY: 820, width: 400, height: 225, rotationDegrees: -130, flipX: true, flipY: false },
		{ centerX: 100, centerY: 100, width: 200, height: 300, rotationDegrees: 45, flipX: true, flipY: true },
	];

	test("matches the 2D tracker's uvToCanvas (same compositor rule)", () => {
		for (const quad of cases) {
			const m = quadFrameToCanvas({ quad, frameWidth: 1920, frameHeight: 1080 });
			for (const [u, v] of [
				[0, 0],
				[1, 0],
				[0.25, 0.75],
				[1, 1],
			]) {
				const actual = affineApply({ m, x: u * 1920, y: v * 1080 });
				const expected = uvToCanvas({
					u,
					v,
					bounds: {
						cx: quad.centerX,
						cy: quad.centerY,
						width: quad.flipX ? -quad.width : quad.width,
						height: quad.flipY ? -quad.height : quad.height,
						rotation: quad.rotationDegrees,
					},
				});
				expect(actual.x).toBeCloseTo(expected.x, 9);
				expect(actual.y).toBeCloseTo(expected.y, 9);
			}
		}
	});

	test("matches the layer shader's inverse map (rotate_inverse, uv, flip)", () => {
		for (const quad of cases) {
			const m = quadFrameToCanvas({ quad, frameWidth: 800, frameHeight: 600 });
			const pixel = affineApply({ m, x: 200, y: 450 });
			const radians = (quad.rotationDegrees * Math.PI) / 180;
			const c = Math.cos(radians);
			const s = Math.sin(radians);
			const px = pixel.x - quad.centerX;
			const py = pixel.y - quad.centerY;
			const local = { x: px * c + py * s, y: -px * s + py * c };
			const uv = { x: local.x / quad.width + 0.5, y: local.y / quad.height + 0.5 };
			const sample = { x: quad.flipX ? 1 - uv.x : uv.x, y: quad.flipY ? 1 - uv.y : uv.y };
			expect(sample.x).toBeCloseTo(200 / 800, 9);
			expect(sample.y).toBeCloseTo(450 / 600, 9);
		}
	});

	test("affine compose and inverse", () => {
		const m = quadFrameToCanvas({ quad: cases[2], frameWidth: 1920, frameHeight: 1080 });
		const inv = affineInverse(m);
		expect(inv).not.toBeNull();
		if (inv) expectVecClose({ actual: affineCompose({ a: m, b: inv }), expected: [1, 0, 0, 0, 1, 0] });
	});
});

describe("planes", () => {
	test("symmetric eigen: A v = lambda v, ascending", () => {
		const matrix = [4, 1, 2, 1, 3, 0.5, 2, 0.5, 5];
		const { values, vectors } = symmetricEigen3(matrix);
		expect(values[0]).toBeLessThanOrEqual(values[1]);
		expect(values[1]).toBeLessThanOrEqual(values[2]);
		for (let k = 0; k < 3; k++) {
			const v = vectors[k];
			const av = [
				matrix[0] * v[0] + matrix[1] * v[1] + matrix[2] * v[2],
				matrix[3] * v[0] + matrix[4] * v[1] + matrix[5] * v[2],
				matrix[6] * v[0] + matrix[7] * v[1] + matrix[8] * v[2],
			];
			expectVecClose({ actual: av, expected: [v[0] * values[k], v[1] * values[k], v[2] * values[k]] });
		}
	});

	test("fitPlane recovers a tilted plane from noisy points", () => {
		const normal: Vec3 = [0.3, -0.8, 0.52];
		const length = Math.hypot(...normal);
		const n: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
		const u = vCross({ a: n, b: [0, 0, 1] });
		const ul = Math.hypot(...u);
		const uu: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
		const vv = vCross({ a: n, b: uu });
		const points: Vec3[] = [];
		let seed = 7;
		const random = () => {
			seed = (seed * 16807) % 2147483647;
			return seed / 2147483647 - 0.5;
		};
		for (let i = 0; i < 60; i++) {
			const a = random() * 200;
			const b = random() * 200;
			const noise = random() * 0.2;
			points.push([
				5 + a * uu[0] + b * vv[0] + noise * n[0],
				-3 + a * uu[1] + b * vv[1] + noise * n[1],
				400 + a * uu[2] + b * vv[2] + noise * n[2],
			]);
		}
		const plane = fitPlane({ points });
		expect(plane).not.toBeNull();
		if (plane) {
			const dot = Math.abs(plane.normal[0] * n[0] + plane.normal[1] * n[1] + plane.normal[2] * n[2]);
			expect(dot).toBeGreaterThan(0.99999);
			expect(Math.abs(planeDistance({ plane, point: [5, -3, 400] }))).toBeLessThan(0.05);
		}
	});

	test("fitPlane refuses lines and too few points", () => {
		expect(fitPlane({ points: [[0, 0, 0], [1, 1, 1]] })).toBeNull();
		expect(fitPlane({ points: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]] })).toBeNull();
	});

	test("planeFacing and ray hits", () => {
		const plane = planeFacing({
			plane: { point: [0, 0, 100], normal: [0, 0, 1] },
			viewpoint: [0, 0, 0],
		});
		expect(plane.normal[2]).toBe(-1);
		const hit = intersectRayPlane({ origin: [0, 0, 0], direction: [0, 0.6, 0.8], plane });
		expect(hit?.[2]).toBeCloseTo(100, 12);
		expect(hit?.[1]).toBeCloseTo(75, 12);
		expect(intersectRayPlane({ origin: [0, 0, 0], direction: [0, 0, -1], plane })).toBeNull();
		expect(intersectRayPlane({ origin: [0, 0, 0], direction: [1, 0, 0], plane })).toBeNull();
	});
});
