import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import type { ScalarAnimationKey } from "@/animation/types";
import { layerToWorld, projectToFrame } from "@/scene3d/camera";
import { LAYER_3D_KEYS, paramsFromTransform3D, transform3DFromParams } from "@/scene3d/layer-params";
import { eulerDegToMat3, mApply, mDeterminant, mMul, mTranspose, quatToMat3, vDot, vSub } from "@/scene3d/math";
import type { CameraState, Target, Transform3D, Vec3 } from "@/scene3d/types";
import type { TextElement } from "@/timeline";
import type { CameraSolve } from "@/tracking/camera3d/types";
import { mediaTime } from "@/wasm";
import {
	groundPlaneRebase,
	layersSeenThroughClip,
	rebaseLayerElement,
	rebaseLayerTransform,
	rebasePoint,
	rebaseSolve,
} from "../ground-plane";
import {
	cameraLayer,
	cameraTrack,
	graphicTrack,
	sceneOf,
	textLayer,
	textTrack,
	videoClip,
} from "./editor-harness";
import { cameraAt, FRAME, sceneSolve, unit } from "./fixtures";

const LAYER: Transform3D = {
	position: [40, -60, 500],
	orientationDeg: [10, -25, 5],
	rotationDeg: [0, 0, 30],
	scale: [0.3, 0.3, 0.3],
};
const SIZE = { width: 400, height: 160 };

function corners(transform: Transform3D): Vec3[] {
	const w = SIZE.width / 2;
	const h = SIZE.height / 2;
	return [
		[-w, -h, 0],
		[w, -h, 0],
		[w, h, 0],
		[-w, h, 0],
		[0, 0, 0],
	].map(([x, y, z]) => layerToWorld({ transform, local: [x, y, z] }));
}

function project({ camera, point }: { camera: CameraState; point: Vec3 }) {
	const p = projectToFrame({ camera, frameWidth: FRAME.width, frameHeight: FRAME.height, point });
	if (!p) throw new Error("behind the camera");
	return p;
}

/** Largest pixel distance between the projections of the same layer corners before and after. */
function largestShift({
	before,
	after,
	layerBefore,
	layerAfter,
}: {
	before: CameraSolve;
	after: CameraSolve;
	layerBefore: Transform3D;
	layerAfter: Transform3D;
}): number {
	let worst = 0;
	before.cameras.forEach((camera, frame) => {
		const a = corners(layerBefore).map((point) => project({ camera, point }));
		const b = corners(layerAfter).map((point) => project({ camera: after.cameras[frame], point }));
		a.forEach((p, k) => {
			worst = Math.max(worst, Math.hypot(p.x - b[k].x, p.y - b[k].y));
		});
	});
	return worst;
}

const { solve } = sceneSolve({ frameCount: 8 });
const TARGET: Target = { center: [20, 0, 250], normal: [0, -1, 0], radius: 40 };
const TILTED: Target = { center: [-30, -150, 790], normal: unit([0.2, 0.1, -1]), radius: 70 };

describe("groundPlaneRebase", () => {
	for (const [name, target] of [
		["floor", TARGET],
		["tilted wall", TILTED],
	] as const) {
		test(`${name}: the target plane becomes y = 0 facing up (-y), its centre the origin`, () => {
			const rebase = groundPlaneRebase({ target, camera: solve.cameras[3] });
			if (!rebase) throw new Error("no rebase");
			const r = rebase.rotation;
			expect(mDeterminant(r)).toBeCloseTo(1, 12);
			const rrt = mMul({ a: r, b: mTranspose(r) });
			[1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, i) => expect(rrt[i]).toBeCloseTo(value, 12));
			const n = mApply({ m: r, v: target.normal });
			expect(n[0]).toBeCloseTo(0, 12);
			expect(n[1]).toBeCloseTo(-1, 12);
			expect(n[2]).toBeCloseTo(0, 12);
			const centre = rebasePoint({ rebase, point: target.center });
			centre.forEach((value) => expect(value).toBeCloseTo(0, 9));
			// any point of the plane lands on y = 0
			const inPlane = vSub({ a: target.center, b: [-target.normal[2] * 50, 0, target.normal[0] * 50] });
			expect(rebasePoint({ rebase, point: inPlane })[1]).toBeCloseTo(0, 9);
		});
	}

	test("the camera at that frame looks along +z of the new world (no sideways turn)", () => {
		const camera = solve.cameras[3];
		const rebase = groundPlaneRebase({ target: TARGET, camera });
		if (!rebase) throw new Error("no rebase");
		const r = quatToMat3(camera.rotation);
		const forward = mApply({ m: rebase.rotation, v: [r[6], r[7], r[8]] });
		expect(forward[0]).toBeCloseTo(0, 12);
		expect(forward[2]).toBeGreaterThan(0);
	});

	test("a camera looking straight down on the plane still gives a proper rotation", () => {
		const down = cameraAt({ position: [0, -500, 0], pitchDeg: -90 });
		const rebase = groundPlaneRebase({ target: TARGET, camera: down });
		if (!rebase) throw new Error("no rebase");
		expect(mDeterminant(rebase.rotation)).toBeCloseTo(1, 12);
		expect(rebase.rotation.every(Number.isFinite)).toBe(true);
	});

	test("a target without a normal gives nothing", () => {
		expect(groundPlaneRebase({ target: { ...TARGET, normal: [0, 0, 0] }, camera: solve.cameras[0] })).toBeNull();
		expect(groundPlaneRebase({ target: { ...TARGET, center: [Number.NaN, 0, 0] }, camera: solve.cameras[0] })).toBeNull();
	});
});

describe("rebasing moves nothing on screen", () => {
	for (const [name, target] of [
		["floor", TARGET],
		["tilted wall", TILTED],
	] as const) {
		test(`${name}: every frame projects the layer corners and the solved points where they were (1e-6 px)`, () => {
			const rebase = groundPlaneRebase({ target, camera: solve.cameras[2] });
			if (!rebase) throw new Error("no rebase");
			const after = rebaseSolve({ rebase, solve });
			const layerAfter = rebaseLayerTransform({ rebase, transform: LAYER });
			expect(largestShift({ before: solve, after, layerBefore: LAYER, layerAfter })).toBeLessThan(1e-6);
			expect(layerAfter.rotationDeg).toEqual(LAYER.rotationDeg);
			expect(layerAfter.scale).toEqual(LAYER.scale);
			solve.cameras.forEach((camera, frame) => {
				solve.points.forEach((point, i) => {
					const a = project({ camera, point: point.position });
					const b = project({ camera: after.cameras[frame], point: after.points[i].position });
					expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
				});
			});
			expect(after.points.map((point) => point.trackId)).toEqual(solve.points.map((point) => point.trackId));
			expect(after.solved).toEqual(solve.solved);
			expect(after.cameras.map((camera) => camera.focalPx)).toEqual(solve.cameras.map((camera) => camera.focalPx));
		});
	}
});

describe("layers seen through the clip's camera", () => {
	const placed = paramsFromTransform3D(LAYER);
	const tracks = sceneOf({
		main: [videoClip({ id: "clip" }), videoClip({ id: "other", start: 10 })],
		overlay: [
			cameraTrack({
				elements: [cameraLayer({ id: "cam", sourceElementId: "clip", start: 0, duration: 4 }), cameraLayer({ id: "cam2", sourceElementId: "other", start: 10, duration: 4 })],
			}),
			textTrack({
				elements: [
					textLayer({ id: "in-3d", start: 1, duration: 2, params: placed }),
					textLayer({ id: "flat", start: 1, duration: 2 }),
					textLayer({ id: "late-3d", start: 5, duration: 2, params: placed }),
					textLayer({ id: "other-3d", start: 11, duration: 2, params: placed }),
				],
			}),
			graphicTrack({
				elements: [
					{
						id: "null-3d",
						type: "graphic",
						name: "n",
						definitionId: "null",
						startTime: mediaTime({ ticks: 0 }),
						duration: mediaTime({ ticks: 1 }),
						trimStart: mediaTime({ ticks: 0 }),
						trimEnd: mediaTime({ ticks: 0 }),
						params: placed,
					},
				],
			}),
		],
	});

	test("3D layers overlapping a camera of this clip, and only those", () => {
		expect(layersSeenThroughClip({ tracks, clipId: "clip" }).map((ref) => ref.elementId).sort()).toEqual(["in-3d", "null-3d"]);
		expect(layersSeenThroughClip({ tracks, clipId: "other" }).map((ref) => ref.elementId)).toEqual(["other-3d"]);
		expect(layersSeenThroughClip({ tracks, clipId: "nobody" })).toEqual([]);
	});
});

describe("rebaseLayerElement", () => {
	const rebase = groundPlaneRebase({ target: TILTED, camera: solve.cameras[1] });
	if (!rebase) throw new Error("no rebase");

	test("a 2D element is returned untouched", () => {
		const element = textLayer();
		expect(rebaseLayerElement({ element, rebase })).toBe(element);
	});

	test("static params: position and orientation re-based, rotation, scale and other params kept", () => {
		const element = textLayer({ params: { ...paramsFromTransform3D(LAYER), color: "#ff0000" } });
		const next = rebaseLayerElement({ element, rebase });
		const transform = transform3DFromParams((key) => next.params[key]);
		expect(transform).toEqual(rebaseLayerTransform({ rebase, transform: LAYER }));
		expect(next.params.color).toBe("#ff0000");
		expect(next.params.content).toBe("Hello");
	});

	function key({ id, ticks, value }: { id: string; ticks: number; value: number }): ScalarAnimationKey {
		return { id, time: mediaTime({ ticks }), value, segmentToNext: "linear", tangentMode: "flat" };
	}

	test("keyframed position and orientation: exact at every key time, all three axes keyed", () => {
		const element: TextElement = {
			...textLayer({ params: paramsFromTransform3D(LAYER) }),
			animations: {
				[LAYER_3D_KEYS.positionX]: { keys: [key({ id: "x0", ticks: 0, value: 40 }), key({ id: "x1", ticks: 60000, value: 140 })] },
				[LAYER_3D_KEYS.positionZ]: { keys: [key({ id: "z1", ticks: 30000, value: 650 })] },
				[LAYER_3D_KEYS.orientationY]: { keys: [key({ id: "o0", ticks: 0, value: 170 }), key({ id: "o1", ticks: 60000, value: 190 })] },
			},
		};
		const next = rebaseLayerElement({ element, rebase });
		for (const ticks of [0, 30000, 60000]) {
			const read = ({ base, path }: { base: TextElement; path: string }) =>
				resolveAnimationPathValueAtTime({
					animations: base.animations,
					propertyPath: path,
					localTime: ticks,
					fallbackValue: Number(base.params[path]),
				});
			const transformAt = (base: TextElement): Transform3D => ({
				position: [
					read({ base, path: LAYER_3D_KEYS.positionX }),
					read({ base, path: LAYER_3D_KEYS.positionY }),
					read({ base, path: LAYER_3D_KEYS.positionZ }),
				],
				orientationDeg: [
					read({ base, path: LAYER_3D_KEYS.orientationX }),
					read({ base, path: LAYER_3D_KEYS.orientationY }),
					read({ base, path: LAYER_3D_KEYS.orientationZ }),
				],
				rotationDeg: LAYER.rotationDeg,
				scale: LAYER.scale,
			});
			const expected = corners(rebaseLayerTransform({ rebase, transform: transformAt(element) }));
			const got = corners(transformAt(next));
			got.forEach((point, i) => point.forEach((value, axis) => expect(value).toBeCloseTo(expected[i][axis], 6)));
		}
		// orientation keys are unwrapped: no 340-degree swing between neighbours
		const keysOf = (path: string) => {
			const data = next.animations?.[path];
			return data && "keys" in data && Array.isArray(data.keys) ? data.keys : [];
		};
		for (const path of [LAYER_3D_KEYS.orientationX, LAYER_3D_KEYS.orientationY, LAYER_3D_KEYS.orientationZ]) {
			const values = keysOf(path).map((entry) => Number(entry.value));
			// keyed at every key time of position or orientation
			expect(values).toHaveLength(3);
			expect(Math.abs(values[1] - values[0])).toBeLessThan(180);
			expect(Math.abs(values[2] - values[1])).toBeLessThan(180);
		}
		expect(keysOf(LAYER_3D_KEYS.positionY).map((entry): number => entry.time)).toEqual([0, 30000, 60000]);
		// the ids of keys that existed are kept
		expect(keysOf(LAYER_3D_KEYS.positionX).map((entry) => entry.id)).toContain("x0");
	});

	test("orientation keys that cross 180 degrees after the change keep turning the short way", () => {
		// a turn of 20 degrees about z takes Orientation Z keys 150 -> 175 to 170 -> 195 (= -165)
		const turn = { rotation: eulerDegToMat3([0, 0, 20]), origin: [0, 0, 0] satisfies Vec3 };
		const element: TextElement = {
			...textLayer({ params: paramsFromTransform3D({ ...LAYER, orientationDeg: [0, 0, 150] }) }),
			animations: {
				[LAYER_3D_KEYS.orientationZ]: {
					keys: [key({ id: "z0", ticks: 0, value: 150 }), key({ id: "z1", ticks: 60000, value: 175 })],
				},
			},
		};
		const next = rebaseLayerElement({ element, rebase: turn });
		const data = next.animations?.[LAYER_3D_KEYS.orientationZ];
		const values = data && "keys" in data && Array.isArray(data.keys) ? data.keys.map((entry) => Number(entry.value)) : [];
		expect(values[0]).toBeCloseTo(170, 9);
		expect(values[1]).toBeCloseTo(195, 9);
	});

	test("re-basing is deterministic (redo gives the same element)", () => {
		const element: TextElement = {
			...textLayer({ params: paramsFromTransform3D(LAYER) }),
			animations: { [LAYER_3D_KEYS.positionX]: { keys: [key({ id: "x0", ticks: 0, value: 1 }), key({ id: "x1", ticks: 9000, value: 3 })] } },
		};
		expect(rebaseLayerElement({ element, rebase })).toEqual(rebaseLayerElement({ element, rebase }));
	});

	test("the camera-facing side stays towards the camera", () => {
		const after = rebaseSolve({ rebase, solve });
		const camera = after.cameras[1];
		const r = quatToMat3(camera.rotation);
		const forward: Vec3 = [r[6], r[7], r[8]];
		// the ground's normal is now -y: the camera is on that side
		expect(vDot({ a: [0, -1, 0], b: vSub({ a: camera.position, b: [0, 0, 0] }) })).toBeGreaterThan(0);
		expect(forward.every(Number.isFinite)).toBe(true);
	});
});
