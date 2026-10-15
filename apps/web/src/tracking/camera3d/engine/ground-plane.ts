import { resolveAnimationPathValueAtTime } from "@/animation";
import { getChannel, setChannel } from "@/animation/keyframes";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import {
	LAYER_3D_KEYS,
	transform3DFromParams,
	type Layer3DKey,
} from "@/scene3d/layer-params";
import {
	eulerDegToMat3,
	mApply,
	mat3ToEulerDeg,
	mat3ToQuat,
	mMul,
	mTranspose,
	quatToMat3,
	vCross,
	vDot,
	vNormalize,
	vScale,
	vSub,
} from "@/scene3d/math";
import type { CameraState, Mat3, Target, Transform3D, Vec3 } from "@/scene3d/types";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import type { CameraSolve } from "../types";

/**
 * AE "Set Ground Plane and Origin": a rigid change of the solve's world,
 * `X' = rotation (X - origin)`, that puts the target's plane at y = 0 with
 * its camera-facing side up (-y, since y points down), the target centre at
 * the origin, and the camera of the chosen frame looking along +z. Applied
 * to the cameras, the solved points and every 3D layer seen through the
 * clip's camera, nothing moves on screen: camera-space coordinates are
 * unchanged.
 */
export interface WorldRebase {
	rotation: Mat3;
	origin: Vec3;
}

function inPlane({ v, normal }: { v: Vec3; normal: Vec3 }): Vec3 | null {
	const projected = vSub({ a: v, b: vScale({ v: normal, s: vDot({ a: v, b: normal }) }) });
	return vDot({ a: projected, b: projected }) > 1e-12 ? vNormalize(projected) : null;
}

/** The re-basing for a target seen from `camera`; `null` for a degenerate target. */
export function groundPlaneRebase({
	target,
	camera,
}: {
	target: Target;
	camera: CameraState;
}): WorldRebase | null {
	if (!target.center.every(Number.isFinite)) return null;
	const normal = vNormalize(target.normal);
	if (!normal) return null;
	const yAxis: Vec3 = [-normal[0], -normal[1], -normal[2]];
	const r = quatToMat3(camera.rotation);
	const forward: Vec3 = [r[6], r[7], r[8]];
	const up: Vec3 = [-r[3], -r[4], -r[5]];
	const right: Vec3 = [r[0], r[1], r[2]];
	// looking straight at the plane: the picture's up (then its right) gives "forward" on the ground
	const zAxis =
		inPlane({ v: forward, normal }) ??
		inPlane({ v: up, normal }) ??
		(() => {
			const x = inPlane({ v: right, normal });
			return x ? vCross({ a: x, b: yAxis }) : null;
		})();
	if (!zAxis) return null;
	const xAxis = vCross({ a: yAxis, b: zAxis });
	return {
		// rows are the new axes in old coordinates
		rotation: [...xAxis, ...yAxis, ...zAxis],
		origin: [target.center[0], target.center[1], target.center[2]],
	};
}

export function rebasePoint({ rebase, point }: { rebase: WorldRebase; point: Vec3 }): Vec3 {
	return mApply({ m: rebase.rotation, v: vSub({ a: point, b: rebase.origin }) });
}

/** `X_cam = R (X - C)` with `X = W^T X' + origin`: `R' = R W^T`, `C' = W (C - origin)`. */
export function rebaseCamera({ rebase, camera }: { rebase: WorldRebase; camera: CameraState }): CameraState {
	return {
		rotation: mat3ToQuat(mMul({ a: quatToMat3(camera.rotation), b: mTranspose(rebase.rotation) })),
		position: rebasePoint({ rebase, point: camera.position }),
		focalPx: camera.focalPx,
	};
}

export function rebaseSolve({ rebase, solve }: { rebase: WorldRebase; solve: CameraSolve }): CameraSolve {
	return {
		...solve,
		cameras: solve.cameras.map((camera) => rebaseCamera({ rebase, camera })),
		solved: solve.solved.slice(),
		points: solve.points.map((point) => ({
			...point,
			position: rebasePoint({ rebase, point: point.position }),
		})),
		notices: solve.notices.map((notice) => ({ ...notice })),
	};
}

function rebaseOrientation({ rebase, orientationDeg }: { rebase: WorldRebase; orientationDeg: Vec3 }): Vec3 {
	return mat3ToEulerDeg(mMul({ a: rebase.rotation, b: eulerDegToMat3(orientationDeg) }));
}

/** Position and Orientation change with the world; X/Y/Z Rotation and Scale are local and stay. */
export function rebaseLayerTransform({
	rebase,
	transform,
}: {
	rebase: WorldRebase;
	transform: Transform3D;
}): Transform3D {
	return {
		position: rebasePoint({ rebase, point: transform.position }),
		orientationDeg: rebaseOrientation({ rebase, orientationDeg: transform.orientationDeg }),
		rotationDeg: transform.rotationDeg,
		scale: transform.scale,
	};
}

const LAYER_3D_ELEMENT_TYPES = new Set<TimelineElement["type"]>(["text", "image", "sticker", "graphic"]);

function isLayer3DElement(element: TimelineElement): boolean {
	return LAYER_3D_ELEMENT_TYPES.has(element.type) && transform3DFromParams((key) => element.params[key]) !== null;
}

function overlaps({ a, b }: { a: TimelineElement; b: TimelineElement }): boolean {
	return a.startTime < b.startTime + b.duration && b.startTime < a.startTime + a.duration;
}

/**
 * The 3D layers drawn in the world of `clipId`'s solve: those that overlap
 * in time a camera element (hidden or not) whose source is that clip.
 */
export function layersSeenThroughClip({ tracks, clipId }: { tracks: SceneTracks; clipId: string }): ElementRef[] {
	const cameras = tracks.overlay.flatMap((track) =>
		track.type === "camera" ? track.elements.filter((camera) => camera.sourceElementId === clipId) : [],
	);
	if (cameras.length === 0) return [];
	return [...tracks.overlay, tracks.main].flatMap((track) =>
		track.elements
			.filter((element) => isLayer3DElement(element) && cameras.some((camera) => overlaps({ a: camera, b: element })))
			.map((element) => ({ trackId: track.id, elementId: element.id })),
	);
}

type Triple = readonly [Layer3DKey, Layer3DKey, Layer3DKey];

const POSITION_KEYS: Triple = [LAYER_3D_KEYS.positionX, LAYER_3D_KEYS.positionY, LAYER_3D_KEYS.positionZ];
const ORIENTATION_KEYS: Triple = [LAYER_3D_KEYS.orientationX, LAYER_3D_KEYS.orientationY, LAYER_3D_KEYS.orientationZ];

function scalarKeys({ animations, path }: { animations: ElementAnimations | undefined; path: string }): ScalarAnimationKey[] {
	const channel = getChannel({ animations, propertyPath: path });
	if (!channel) return [];
	return channel.keys.flatMap((key) => (typeof key.value === "number" && "segmentToNext" in key ? [key] : []));
}

/** `value` moved by whole turns to lie within 180 degrees of `near`. */
function unwrapDegrees({ value, near }: { value: number; near: number }): number {
	return value + 360 * Math.round((near - value) / 360);
}

function keyTimes({ animations, keys }: { animations: ElementAnimations | undefined; keys: Triple }): MediaTime[] {
	return keys.flatMap((path) => scalarKeys({ animations, path }).map((key) => key.time));
}

/**
 * Re-bases a keyframed vector (three channels) key time by key time: at
 * each of `times`, the full vector is evaluated, mapped, and written to all
 * three channels (existing keys keep their id and interpolation; missing
 * ones are added, linear). Exact at those times; between them exact when
 * the channels were linear and the map is affine (Position), approximate
 * for eased channels and for Orientation (Euler angles do not interpolate
 * like rotations).
 */
function rebaseKeyedTriple({
	animations,
	keys,
	times,
	base,
	map,
	angles,
}: {
	animations: ElementAnimations | undefined;
	keys: Triple;
	times: readonly MediaTime[];
	base: Vec3;
	map: (value: Vec3) => Vec3;
	angles: boolean;
}): ElementAnimations | undefined {
	const perAxis = keys.map((path) => scalarKeys({ animations, path }));
	if (perAxis.every((axisKeys) => axisKeys.length === 0)) return animations;
	let previous: Vec3 | null = null;
	const mapped = times.map((time) => {
		const at = (axis: 0 | 1 | 2) =>
			resolveAnimationPathValueAtTime({
				animations,
				propertyPath: keys[axis],
				localTime: time,
				fallbackValue: base[axis],
			});
		let next = map([at(0), at(1), at(2)]);
		if (angles && previous) {
			const near = previous;
			const unwrap = (axis: 0 | 1 | 2) => unwrapDegrees({ value: next[axis], near: near[axis] });
			next = [unwrap(0), unwrap(1), unwrap(2)];
		}
		previous = next;
		return next;
	});
	let result = animations;
	keys.forEach((path, axis) => {
		const existing = new Map(perAxis[axis].map((key) => [key.time, key]));
		const channelKeys: ScalarAnimationKey[] = times.map((time: MediaTime, index) => {
			const key = existing.get(time);
			const value = mapped[index][axis];
			return key
				? { ...key, value }
				: { id: `rebased-${path}-${time}`, time, value, segmentToNext: "linear", tangentMode: "flat" };
		});
		const channel = getChannel({ animations: result, propertyPath: path });
		result = setChannel({
			animations: result,
			propertyPath: path,
			channel: { ...(channel && "extrapolation" in channel ? { extrapolation: channel.extrapolation } : {}), keys: channelKeys },
		});
	});
	return result;
}

/**
 * A 3D layer element re-based into the new world: base Position and
 * Orientation params, and their keyframes (see {@link rebaseKeyedTriple}).
 * 2D elements come back unchanged. Deterministic, so a redo writes the same.
 */
export function rebaseLayerElement<T extends TimelineElement>({
	element,
	rebase,
}: {
	element: T;
	rebase: WorldRebase;
}): T {
	const transform = transform3DFromParams((key) => element.params[key]);
	if (!transform) return element;
	const next = rebaseLayerTransform({ rebase, transform });
	const params = { ...element.params };
	POSITION_KEYS.forEach((key, axis) => {
		params[key] = next.position[axis];
	});
	ORIENTATION_KEYS.forEach((key, axis) => {
		params[key] = next.orientationDeg[axis];
	});
	// keyed channels of both vectors get keys at every key time of either, so the
	// moved layer matches the old one exactly at each of them
	const times = [
		...new Set([
			...keyTimes({ animations: element.animations, keys: POSITION_KEYS }),
			...keyTimes({ animations: element.animations, keys: ORIENTATION_KEYS }),
		]),
	].sort((a, b) => a - b);
	let animations = rebaseKeyedTriple({
		animations: element.animations,
		keys: POSITION_KEYS,
		times,
		base: transform.position,
		map: (point) => rebasePoint({ rebase, point }),
		angles: false,
	});
	animations = rebaseKeyedTriple({
		animations,
		keys: ORIENTATION_KEYS,
		times,
		base: transform.orientationDeg,
		map: (orientationDeg) => rebaseOrientation({ rebase, orientationDeg }),
		angles: true,
	});
	return animations === element.animations ? { ...element, params } : { ...element, params, animations };
}
