import {
	mat3ToEulerDeg,
	mFromColumns,
	quatToMat3,
	vCross,
	vDot,
	vNormalize,
	vScale,
	vSub,
} from "@/scene3d/math";
import type { CameraState, Target, Transform3D, Vec3 } from "@/scene3d/types";

/** The component of `v` inside the plane with unit normal `normal`, unit length; `null` when `v` is (nearly) along the normal. */
function inPlane({ v, normal }: { v: Vec3; normal: Vec3 }): Vec3 | null {
	const projected = vSub({ a: v, b: vScale({ v: normal, s: vDot({ a: v, b: normal }) }) });
	return vLength2(projected) > 1e-12 ? vNormalize(projected) : null;
}

function vLength2(v: Vec3): number {
	return v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
}

function isFiniteVec(v: Vec3): boolean {
	return v.every(Number.isFinite);
}

/**
 * Where AE puts a layer created on a camera-tracker target: centred on the
 * target, lying in its plane with its front (local -z) towards the camera
 * (local z = -normal), its x axis along the camera's right vector projected
 * on the plane (so it reads left to right from the camera at that frame),
 * y = z x x, and scaled uniformly so the content's larger side equals the
 * target's diameter. Rotation stays 0 (the placement is the Orientation).
 * `contentSize` is the layer's local content size (its size on the canvas at
 * 2D scale 1). `null` for a degenerate target or content.
 */
export function placeLayerOnTarget({
	target,
	camera,
	contentSize,
}: {
	target: Target;
	camera: CameraState;
	contentSize: { width: number; height: number };
}): Transform3D | null {
	const side = Math.max(contentSize.width, contentSize.height);
	if (!(side > 0) || !Number.isFinite(side)) return null;
	if (!(target.radius > 0) || !Number.isFinite(target.radius)) return null;
	if (!isFiniteVec(target.center)) return null;
	const normal = vNormalize(target.normal);
	if (!normal) return null;

	const zAxis: Vec3 = [-normal[0], -normal[1], -normal[2]];
	// camera axes in world space are the rows of the world -> camera rotation
	const r = quatToMat3(camera.rotation);
	const right: Vec3 = [r[0], r[1], r[2]];
	const down: Vec3 = [r[3], r[4], r[5]];
	// a plane seen edge-on along the right vector: keep the camera's up as -y instead
	const xAxis =
		inPlane({ v: right, normal }) ??
		(() => {
			const y = inPlane({ v: down, normal });
			return y ? vCross({ a: y, b: zAxis }) : null;
		})();
	if (!xAxis) return null;
	const yAxis = vCross({ a: zAxis, b: xAxis });
	const scale = (2 * target.radius) / side;
	return {
		position: [target.center[0], target.center[1], target.center[2]],
		orientationDeg: mat3ToEulerDeg(mFromColumns({ x: xAxis, y: yAxis, z: zAxis })),
		rotationDeg: [0, 0, 0],
		scale: [scale, scale, scale],
	};
}
