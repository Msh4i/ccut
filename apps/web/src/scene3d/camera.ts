import {
	affineApply,
	eulerDegToMat3,
	IDENTITY_AFFINE2,
	IDENTITY_QUAT,
	mApply,
	mMul,
	mTranspose,
	quatSlerp,
	quatToMat3,
	vAdd,
	vLerp,
	vNormalize,
	vSub,
} from "./math";
import type {
	Affine2,
	CameraState,
	Mat3,
	Transform3D,
	Vec3,
	ViewCamera,
} from "./types";

/**
 * Projection rules shared by the solver, the preview overlay and the
 * renderer. See `types.ts` for the axes and pixel conventions.
 */

/** Points closer to the camera plane than this (camera-space z) are not projected. */
export const MIN_PROJECT_DEPTH = 1e-6;

/** AE's default comp camera is a 50 mm lens on a 36 mm wide film back. */
export const DEFAULT_CAMERA_FOCAL_PER_WIDTH = 50 / 36;

export function worldToCamera({
	camera,
	point,
}: {
	camera: CameraState;
	point: Vec3;
}): Vec3 {
	return mApply({
		m: quatToMat3(camera.rotation),
		v: vSub({ a: point, b: camera.position }),
	});
}

/** Frame-pixel position of a camera-space point, or `null` when it is not in front of the camera. */
export function cameraToFrame({
	focalPx,
	frameWidth,
	frameHeight,
	point,
}: {
	focalPx: number;
	frameWidth: number;
	frameHeight: number;
	point: Vec3;
}): { x: number; y: number; depth: number } | null {
	const depth = point[2];
	if (!(depth > MIN_PROJECT_DEPTH)) return null;
	return {
		x: frameWidth / 2 + (focalPx * point[0]) / depth,
		y: frameHeight / 2 + (focalPx * point[1]) / depth,
		depth,
	};
}

/** World point -> frame pixels of `camera` (`null` behind the camera). */
export function projectToFrame({
	camera,
	frameWidth,
	frameHeight,
	point,
}: {
	camera: CameraState;
	frameWidth: number;
	frameHeight: number;
	point: Vec3;
}): { x: number; y: number; depth: number } | null {
	return cameraToFrame({
		focalPx: camera.focalPx,
		frameWidth,
		frameHeight,
		point: worldToCamera({ camera, point }),
	});
}

/** World point -> canvas pixels through a view camera (`null` behind it). */
export function projectToCanvas({
	view,
	point,
}: {
	view: ViewCamera;
	point: Vec3;
}): { x: number; y: number; depth: number } | null {
	const frame = projectToFrame({
		camera: view,
		frameWidth: view.frameWidth,
		frameHeight: view.frameHeight,
		point,
	});
	if (!frame) return null;
	const canvas = affineApply({ m: view.frameToCanvas, x: frame.x, y: frame.y });
	return { x: canvas.x, y: canvas.y, depth: frame.depth };
}

/**
 * The world-space ray through a frame pixel: `origin` is the camera centre,
 * `direction` is unit length and points into the scene.
 */
export function frameRay({
	camera,
	frameWidth,
	frameHeight,
	x,
	y,
}: {
	camera: CameraState;
	frameWidth: number;
	frameHeight: number;
	x: number;
	y: number;
}): { origin: Vec3; direction: Vec3 } {
	const local: Vec3 = [
		(x - frameWidth / 2) / camera.focalPx,
		(y - frameHeight / 2) / camera.focalPx,
		1,
	];
	const world = mApply({ m: mTranspose(quatToMat3(camera.rotation)), v: local });
	return { origin: camera.position, direction: vNormalize(world) ?? [0, 0, 1] };
}

/** Horizontal angle of view in degrees of a focal length (frame pixels). */
export function horizontalAngleOfViewDeg({
	focalPx,
	frameWidth,
}: {
	focalPx: number;
	frameWidth: number;
}): number {
	return (2 * Math.atan(frameWidth / (2 * focalPx)) * 180) / Math.PI;
}

/** Focal length in frame pixels of a horizontal angle of view in degrees. */
export function focalFromAngleOfViewDeg({
	degrees,
	frameWidth,
}: {
	degrees: number;
	frameWidth: number;
}): number {
	return frameWidth / (2 * Math.tan((degrees * Math.PI) / 360));
}

/**
 * The camera at a fractional frame index of a per-frame camera path:
 * rotation by slerp, position and focal length linearly. Outside the path
 * the nearest end is held (like AE's camera keys). `null` for an empty path.
 */
export function cameraAtFrame({
	frames,
	frame,
}: {
	frames: readonly CameraState[];
	frame: number;
}): CameraState | null {
	if (frames.length === 0) return null;
	if (!(frame > 0)) return frames[0];
	const last = frames.length - 1;
	if (frame >= last) return frames[last];
	const index = Math.floor(frame);
	const t = frame - index;
	const a = frames[index];
	const b = frames[index + 1];
	if (t === 0) return a;
	return {
		rotation: quatSlerp({ a: a.rotation, b: b.rotation, t }),
		position: vLerp({ a: a.position, b: b.position, t }),
		focalPx: a.focalPx + (b.focalPx - a.focalPx) * t,
	};
}

/**
 * AE-like default camera for a canvas: a 50 mm lens, looking along +z from
 * `(0, 0, -focal)`, world units = canvas pixels with the origin at the canvas
 * centre. A layer at z = 0 with no rotation looks exactly like its 2D self.
 */
export function defaultViewCamera({
	canvasWidth,
	canvasHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
}): ViewCamera {
	const focalPx = canvasWidth * DEFAULT_CAMERA_FOCAL_PER_WIDTH;
	return {
		kind: "default",
		rotation: IDENTITY_QUAT,
		position: [0, 0, -focalPx],
		focalPx,
		frameWidth: canvasWidth,
		frameHeight: canvasHeight,
		frameToCanvas: IDENTITY_AFFINE2,
	};
}

/**
 * Frame pixels -> canvas pixels of a picture drawn by the compositor with a
 * 2D quad (`QuadTransformDescriptor` of `services/renderer/compositor/types.ts`):
 * the exact forward map of `layer.wgsl` (scale, flip, then rotate about the
 * centre).
 */
export function quadFrameToCanvas({
	quad,
	frameWidth,
	frameHeight,
}: {
	quad: {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
		rotationDegrees: number;
		flipX: boolean;
		flipY: boolean;
	};
	frameWidth: number;
	frameHeight: number;
}): Affine2 {
	const radians = (quad.rotationDegrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const sx = ((quad.flipX ? -1 : 1) * quad.width) / frameWidth;
	const sy = ((quad.flipY ? -1 : 1) * quad.height) / frameHeight;
	// local = (sx (x - W/2), sy (y - H/2)); canvas = centre + R local
	const a = cos * sx;
	const b = -sin * sy;
	const d = sin * sx;
	const e = cos * sy;
	const cx = frameWidth / 2;
	const cy = frameHeight / 2;
	return [
		a,
		b,
		quad.centerX - a * cx - b * cy,
		d,
		e,
		quad.centerY - d * cx - e * cy,
	];
}

/** Local -> world linear part of a 3D layer transform (rotation times scale). */
export function layerLinear(transform: Transform3D): Mat3 {
	const rotation = mMul({
		a: eulerDegToMat3(transform.orientationDeg),
		b: eulerDegToMat3(transform.rotationDeg),
	});
	const [sx, sy, sz] = transform.scale;
	return [
		rotation[0] * sx,
		rotation[1] * sy,
		rotation[2] * sz,
		rotation[3] * sx,
		rotation[4] * sy,
		rotation[5] * sz,
		rotation[6] * sx,
		rotation[7] * sy,
		rotation[8] * sz,
	];
}

/** A layer-local point (content units, origin at the content centre) in world space. */
export function layerToWorld({
	transform,
	local,
}: {
	transform: Transform3D;
	local: Vec3;
}): Vec3 {
	return vAdd({
		a: transform.position,
		b: mApply({ m: layerLinear(transform), v: local }),
	});
}
