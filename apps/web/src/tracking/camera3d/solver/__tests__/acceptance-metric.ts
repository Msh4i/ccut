/**
 * The acceptance metric of `docs/ccut/ae-camera-architecture.md` section 3.1,
 * implemented exactly once for every scene: on the middle frame f0, the
 * solved points within 80 px of a wall pixel define a plane (`fitPlane`), a
 * 200 px square is placed there with the placement rule of
 * `placeLayerOnTarget` (a local copy until workstream D's lands), the same
 * construction is made with the true camera and the true wall, and the two
 * squares' corners are compared on every frame where both are in front of
 * both cameras, in 1920 x 1080 frame pixels.
 */
import { frameRay, projectToFrame, worldToCamera } from "@/scene3d/camera";
import { quatToMat3, vAdd, vCross, vDot, vNormalize, vScale, vSub } from "@/scene3d/math";
import { fitPlane, intersectRayPlane, planeFacing } from "@/scene3d/plane";
import type { CameraState, Plane, Vec3 } from "@/scene3d/types";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { CameraSolve } from "../../types";
import { metricPixel, wallPlane, type Synth3DScene } from "../synth3d";

/** Points within this distance of the metric pixel define the plane (frame pixels). */
export const METRIC_SELECT_RADIUS = 80;
/** Side of the placed square on f0 (frame pixels). */
export const METRIC_SQUARE_PX = 200;

export interface PlacementMetric {
	f0: number;
	pixel: { x: number; y: number };
	/** Solved points that defined the plane. */
	selected: number;
	/** Frames where every corner is in front of both cameras. */
	frames: number;
	mean: number;
	max: number;
	jitter: number;
	/** Mean corner error on the clip's last frame (NaN when it is not evaluated). */
	drift: number;
}

/**
 * The placement rule of `placeLayerOnTarget` for a square of `side` frame
 * pixels: centre on the plane, local z = -normal (front face to the
 * camera), local x = the camera's right vector projected on the plane,
 * local y = z cross x; the side converted to world units at the centre's
 * depth. Returns the 4 world corners.
 */
export function squareCorners({
	camera,
	plane,
	center,
	side,
}: {
	camera: CameraState;
	plane: Plane;
	center: Vec3;
	side: number;
}): Vec3[] | null {
	const facing = planeFacing({ plane, viewpoint: camera.position });
	const n = facing.normal;
	const z: Vec3 = [-n[0], -n[1], -n[2]];
	const r = quatToMat3(camera.rotation);
	const right: Vec3 = [r[0], r[1], r[2]];
	const x = vNormalize(vSub({ a: right, b: vScale({ v: n, s: vDot({ a: right, b: n }) }) }));
	if (!x) return null;
	const y = vCross({ a: z, b: x });
	const depth = worldToCamera({ camera, point: center })[2];
	if (!(depth > 0)) return null;
	const half = (side * depth) / camera.focalPx / 2;
	const corners: Vec3[] = [];
	for (const [sx, sy] of [
		[-1, -1],
		[1, -1],
		[1, 1],
		[-1, 1],
	]) {
		corners.push(vAdd({ a: center, b: vAdd({ a: vScale({ v: x, s: sx * half }), b: vScale({ v: y, s: sy * half }) }) }));
	}
	return corners;
}

/** Runs the metric. Throws when the construction is impossible (no pixel, fewer than 3 points, no hit). */
export function placementMetric({
	scene,
	solve,
	tracks,
}: {
	scene: Synth3DScene;
	solve: CameraSolve;
	tracks: FeatureTracks;
}): PlacementMetric {
	const W = scene.frameWidth;
	const H = scene.frameHeight;
	const f0 = Math.floor((scene.frameCount - 1) / 2);
	const pixel = metricPixel({ scene, frame: f0 });
	if (!pixel) throw new Error("metric: no wall pixel on f0");
	const solvedCamera = solve.cameras[f0];
	const selected: Vec3[] = [];
	for (const point of solve.points) {
		const id = point.trackId;
		if (f0 < tracks.trackStart[id] || f0 >= tracks.trackStart[id] + tracks.trackLen[id]) continue;
		const p = projectToFrame({ camera: solvedCamera, frameWidth: W, frameHeight: H, point: point.position });
		if (!p) continue;
		if (Math.hypot(p.x - pixel.x, p.y - pixel.y) <= METRIC_SELECT_RADIUS) selected.push(point.position);
	}
	const plane = fitPlane({ points: selected });
	if (!plane) throw new Error(`metric: ${selected.length} solved points within ${METRIC_SELECT_RADIUS} px of the pixel`);
	const solvedRay = frameRay({ camera: solvedCamera, frameWidth: W, frameHeight: H, x: pixel.x, y: pixel.y });
	const solvedCenter = intersectRayPlane({ origin: solvedRay.origin, direction: solvedRay.direction, plane });
	if (!solvedCenter) throw new Error("metric: the pixel's ray misses the solved plane");
	const solvedCorners = squareCorners({ camera: solvedCamera, plane, center: solvedCenter, side: METRIC_SQUARE_PX });
	const trueCamera = scene.cameraAt(f0);
	const truePlane = wallPlane(scene);
	const trueRay = frameRay({ camera: trueCamera, frameWidth: W, frameHeight: H, x: pixel.x, y: pixel.y });
	const trueCenter = intersectRayPlane({ origin: trueRay.origin, direction: trueRay.direction, plane: truePlane });
	if (!trueCenter) throw new Error("metric: the pixel's ray misses the wall");
	const trueCorners = squareCorners({ camera: trueCamera, plane: truePlane, center: trueCenter, side: METRIC_SQUARE_PX });
	if (!solvedCorners || !trueCorners) throw new Error("metric: square construction failed");

	let sum = 0;
	let count = 0;
	let max = 0;
	let jitterSum = 0;
	let jitterCount = 0;
	let frames = 0;
	let drift = Number.NaN;
	let previous: { dx: number; dy: number }[] | null = null;
	for (let t = 0; t < scene.frameCount; t++) {
		const truth = scene.cameraAt(t);
		const solved = solve.cameras[t];
		const s = solvedCorners.map((point) => projectToFrame({ camera: solved, frameWidth: W, frameHeight: H, point }));
		const g = trueCorners.map((point) => projectToFrame({ camera: truth, frameWidth: W, frameHeight: H, point }));
		// "in front of both cameras": the solved square in front of the solved camera, the true one of the true camera
		if (s.some((p) => !p) || g.some((p) => !p)) {
			previous = null;
			continue;
		}
		frames++;
		const deltas: { dx: number; dy: number }[] = [];
		let frameSum = 0;
		for (let k = 0; k < 4; k++) {
			const sp = s[k];
			const gp = g[k];
			if (!sp || !gp) continue;
			const dx = sp.x - gp.x;
			const dy = sp.y - gp.y;
			const e = Math.hypot(dx, dy);
			sum += e;
			count++;
			max = Math.max(max, e);
			frameSum += e;
			deltas.push({ dx, dy });
		}
		if (previous) {
			for (let k = 0; k < 4; k++) {
				jitterSum += (deltas[k].dx - previous[k].dx) ** 2 + (deltas[k].dy - previous[k].dy) ** 2;
				jitterCount++;
			}
		}
		previous = deltas;
		if (t === scene.frameCount - 1) drift = frameSum / 4;
	}
	return {
		f0,
		pixel,
		selected: selected.length,
		frames,
		mean: count > 0 ? sum / count : Number.NaN,
		max,
		jitter: jitterCount > 0 ? Math.sqrt(jitterSum / jitterCount) : Number.NaN,
		drift,
	};
}
