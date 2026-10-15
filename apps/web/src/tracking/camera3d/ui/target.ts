import { frameRay, projectToCanvas } from "@/scene3d/camera";
import {
	affineApply,
	affineInverse,
	vAdd,
	vCross,
	vDot,
	vLength,
	vNormalize,
	vScale,
	vSub,
} from "@/scene3d/math";
import {
	fitPlane,
	intersectRayPlane,
	planeDistance,
	planeFacing,
	projectOntoPlane,
} from "@/scene3d/plane";
import type { Plane, Target, Vec3, ViewCamera } from "@/scene3d/types";
import type { Point2 } from "./delaunay";

/**
 * The AE target (bullseye): a disc on the plane of the selected (or
 * hovered) track points, drawn in perspective; created layers are placed on
 * it. Everything is in the solve's world; the camera is the tracked view
 * camera at the playhead.
 */

/** Target radius at Target Size 100 %: this share of the frame height, seen from the camera. */
export const TARGET_BASE_RADIUS_FRACTION = 0.06;

/** Target Size (percent) set by an Alt-drag stays in this range. */
export const TARGET_SIZE_RANGE = { min: 10, max: 1000 } as const;

/** The bullseye's rings, outer to inner, as fractions of the radius. */
export const TARGET_RING_FACTORS = [1, 0.75, 0.5, 0.25] as const;

/** Below this many points a plane is fitted once; from it on, outliers are down-weighted. */
const ROBUST_MIN_POINTS = 5;
const ROBUST_ITERATIONS = 3;
const EPSILON = 1e-9;

/**
 * World radius of a 100 % target centred at `center`: the same share of the
 * frame wherever the target is (AE sizes the target on screen). `null` when
 * the centre is at the camera.
 */
export function targetBaseRadius({
	center,
	camera,
}: {
	center: Vec3;
	camera: ViewCamera;
}): number | null {
	const distance = vLength(vSub({ a: center, b: camera.position }));
	if (!(distance > EPSILON) || !(camera.focalPx > 0)) return null;
	return (
		(TARGET_BASE_RADIUS_FRACTION * camera.frameHeight * distance) /
		camera.focalPx
	);
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Least-squares plane, then a few Cauchy-reweighted refits so a stray point does not tilt it. */
function robustPlane(points: readonly Vec3[]): Plane | null {
	let plane = fitPlane({ points });
	if (!plane || points.length < ROBUST_MIN_POINTS) return plane;
	for (let iteration = 0; iteration < ROBUST_ITERATIONS; iteration++) {
		const current = plane;
		const distances = points.map((point) =>
			Math.abs(planeDistance({ plane: current, point })),
		);
		const scale = 1.4826 * median(distances);
		if (!(scale > EPSILON)) return plane;
		const weights = distances.map(
			(distance) => 1 / (1 + (distance / (2 * scale)) ** 2),
		);
		const next = fitPlane({ points, weights });
		if (!next) return plane;
		plane = next;
	}
	return plane;
}

function anyPerpendicular(direction: Vec3): Vec3 {
	const helper: Vec3 = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
	return vNormalize(vCross({ a: direction, b: helper })) ?? [0, 0, 1];
}

/** The plane through a line (`a`, `b`) whose normal points at `viewpoint` as much as possible. */
function planeThroughLine({
	a,
	b,
	viewpoint,
}: {
	a: Vec3;
	b: Vec3;
	viewpoint: Vec3;
}): Plane | null {
	const along = vNormalize(vSub({ a: b, b: a }));
	const middle = vScale({ v: vAdd({ a, b }), s: 0.5 });
	if (!along) return null;
	const toView = vSub({ a: viewpoint, b: middle });
	const perpendicular = vSub({
		a: toView,
		b: vScale({ v: along, s: vDot({ a: toView, b: along }) }),
	});
	const normal =
		vLength(perpendicular) > EPSILON * Math.max(1, vLength(toView))
			? (vNormalize(perpendicular) ?? anyPerpendicular(along))
			: anyPerpendicular(along);
	return { point: middle, normal };
}

/** The two points farthest apart (the ends of a collinear set). */
function outermostPair(points: readonly Vec3[]): [Vec3, Vec3] {
	let best: [Vec3, Vec3] = [points[0], points[0]];
	let bestDistance = -1;
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			const distance = vLength(vSub({ a: points[i], b: points[j] }));
			if (distance > bestDistance) {
				bestDistance = distance;
				best = [points[i], points[j]];
			}
		}
	}
	return best;
}

function centroid(points: readonly Vec3[]): Vec3 {
	let sum: Vec3 = [0, 0, 0];
	for (const point of points) sum = vAdd({ a: sum, b: point });
	return vScale({ v: sum, s: 1 / points.length });
}

/**
 * The target of a set of solved 3D points, seen from `camera`:
 * 1 point: a plane through it facing the camera; 2 points (or collinear
 * ones): the plane through their line facing the camera as much as it can;
 * 3+: the least-squares plane (robust). The centre is the centroid projected
 * on the plane, the normal faces the camera, the radius follows Target Size.
 */
export function targetFromPoints({
	points,
	camera,
	targetSize,
}: {
	points: readonly Vec3[];
	camera: ViewCamera;
	targetSize: number;
}): Target | null {
	if (points.length === 0) return null;
	const center = centroid(points);
	let plane: Plane | null = points.length >= 3 ? robustPlane(points) : null;
	if (!plane) {
		const [a, b] = outermostPair(points);
		const span = vLength(vSub({ a, b }));
		const scale = Math.max(1, vLength(vSub({ a: center, b: camera.position })));
		if (span > EPSILON * scale) {
			plane = planeThroughLine({ a, b, viewpoint: camera.position });
		} else {
			const towards = vNormalize(vSub({ a: camera.position, b: center }));
			plane = towards ? { point: center, normal: towards } : null;
		}
	}
	if (!plane) return null;
	const facing = planeFacing({ plane, viewpoint: camera.position });
	const onPlane = projectOntoPlane({ plane: facing, point: center });
	const base = targetBaseRadius({ center: onPlane, camera });
	if (base === null) return null;
	return {
		center: onPlane,
		normal: facing.normal,
		radius: (base * Math.max(0, targetSize)) / 100,
	};
}

/**
 * Where the camera ray through a canvas point meets `plane` (in front of the
 * camera), or `null` (ray parallel to the plane, plane behind, or a
 * degenerate frame-to-canvas map).
 */
export function planeHitAt({
	view,
	plane,
	canvasPoint,
}: {
	view: ViewCamera;
	plane: Plane;
	canvasPoint: Point2;
}): Vec3 | null {
	const canvasToFrame = affineInverse(view.frameToCanvas);
	if (!canvasToFrame) return null;
	const frame = affineApply({
		m: canvasToFrame,
		x: canvasPoint.x,
		y: canvasPoint.y,
	});
	const ray = frameRay({
		camera: view,
		frameWidth: view.frameWidth,
		frameHeight: view.frameHeight,
		x: frame.x,
		y: frame.y,
	});
	return intersectRayPlane({
		origin: ray.origin,
		direction: ray.direction,
		plane,
	});
}

/**
 * The target's circle (times `radiusFactor`) projected on the canvas, as a
 * polygon of `segments` points; `null` when any of it is behind the camera.
 */
export function targetOutline({
	target,
	view,
	radiusFactor = 1,
	segments = 48,
}: {
	target: Target;
	view: ViewCamera;
	radiusFactor?: number;
	segments?: number;
}): Point2[] | null {
	const u = anyPerpendicular(target.normal);
	const w = vCross({ a: target.normal, b: u });
	const radius = target.radius * radiusFactor;
	const outline: Point2[] = [];
	for (let k = 0; k < segments; k++) {
		const angle = (k / segments) * Math.PI * 2;
		const offset = vAdd({
			a: vScale({ v: u, s: radius * Math.cos(angle) }),
			b: vScale({ v: w, s: radius * Math.sin(angle) }),
		});
		const projected = projectToCanvas({
			view,
			point: vAdd({ a: target.center, b: offset }),
		});
		if (!projected) return null;
		outline.push({ x: projected.x, y: projected.y });
	}
	return outline;
}

/**
 * AE Alt-drag from the target centre: the Target Size (percent) that puts
 * the target's edge under the pointer, clamped to {@link TARGET_SIZE_RANGE}.
 * `null` when the pointer's ray misses the target's plane.
 */
export function resizedTargetSize({
	target,
	view,
	canvasPoint,
}: {
	target: Target;
	view: ViewCamera;
	canvasPoint: Point2;
}): number | null {
	const hit = planeHitAt({
		view,
		plane: { point: target.center, normal: target.normal },
		canvasPoint,
	});
	if (!hit) return null;
	const base = targetBaseRadius({ center: target.center, camera: view });
	if (base === null) return null;
	const size = (100 * vLength(vSub({ a: hit, b: target.center }))) / base;
	return Math.min(TARGET_SIZE_RANGE.max, Math.max(TARGET_SIZE_RANGE.min, size));
}

/**
 * Start of a target drag (AE: drag the target centre): the offset from the
 * point grabbed on the target's plane to its centre, so the target does not
 * jump to the pointer. `null` when the pointer's ray misses the plane.
 */
export function targetMoveOffset({
	target,
	view,
	canvasPoint,
}: {
	target: Target;
	view: ViewCamera;
	canvasPoint: Point2;
}): Vec3 | null {
	const hit = planeHitAt({
		view,
		plane: { point: target.center, normal: target.normal },
		canvasPoint,
	});
	return hit ? vSub({ a: target.center, b: hit }) : null;
}

/** The target centre while dragging: on its plane, under the pointer plus the grab offset. */
export function movedTargetCenter({
	target,
	view,
	canvasPoint,
	offset,
}: {
	target: Target;
	view: ViewCamera;
	canvasPoint: Point2;
	offset: Vec3;
}): Vec3 | null {
	const hit = planeHitAt({
		view,
		plane: { point: target.center, normal: target.normal },
		canvasPoint,
	});
	return hit ? vAdd({ a: hit, b: offset }) : null;
}

/** The same target moved to `center` on its plane, its radius recomputed there (Target Size is on-screen). */
export function targetWithCenter({
	target,
	center,
	camera,
	targetSize,
}: {
	target: Target;
	center: Vec3;
	camera: ViewCamera;
	targetSize: number;
}): Target | null {
	const base = targetBaseRadius({ center, camera });
	if (base === null) return null;
	return {
		center,
		normal: target.normal,
		radius: (base * Math.max(0, targetSize)) / 100,
	};
}
