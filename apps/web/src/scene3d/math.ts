import type { Affine2, Mat3, Quat, Vec3 } from "./types";

/**
 * Small 3D math shared by the camera tracker, 3D layers and the renderer.
 * Every function is pure and allocation-light; hot solver loops use their
 * own typed-array code instead.
 */

const DEG = Math.PI / 180;

export const IDENTITY_QUAT: Quat = [1, 0, 0, 0];
export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const IDENTITY_AFFINE2: Affine2 = [1, 0, 0, 0, 1, 0];

export function vAdd({ a, b }: { a: Vec3; b: Vec3 }): Vec3 {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub({ a, b }: { a: Vec3; b: Vec3 }): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale({ v, s }: { v: Vec3; s: number }): Vec3 {
	return [v[0] * s, v[1] * s, v[2] * s];
}

export function vDot({ a, b }: { a: Vec3; b: Vec3 }): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross({ a, b }: { a: Vec3; b: Vec3 }): Vec3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function vLength(v: Vec3): number {
	return Math.hypot(v[0], v[1], v[2]);
}

/** Unit vector along `v`; `null` for a (near) zero vector. */
export function vNormalize(v: Vec3): Vec3 | null {
	const length = vLength(v);
	if (!(length > 1e-12)) return null;
	return [v[0] / length, v[1] / length, v[2] / length];
}

export function vLerp({ a, b, t }: { a: Vec3; b: Vec3; t: number }): Vec3 {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
	];
}

export function mMul({ a, b }: { a: Mat3; b: Mat3 }): Mat3 {
	return [
		a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
		a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
		a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
		a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
		a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
		a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
		a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
		a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
		a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
	];
}

export function mApply({ m, v }: { m: Mat3; v: Vec3 }): Vec3 {
	return [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	];
}

export function mTranspose(m: Mat3): Mat3 {
	return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mDeterminant(m: Mat3): number {
	return (
		m[0] * (m[4] * m[8] - m[5] * m[7]) -
		m[1] * (m[3] * m[8] - m[5] * m[6]) +
		m[2] * (m[3] * m[7] - m[4] * m[6])
	);
}

/** Inverse of `m`; `null` when it is singular (|det| below 1e-15 of its scale). */
export function mInverse(m: Mat3): Mat3 | null {
	const det = mDeterminant(m);
	const scale = Math.max(...m.map((value) => Math.abs(value)));
	if (!(Math.abs(det) > 1e-15 * scale * scale * scale)) return null;
	const inv = 1 / det;
	return [
		(m[4] * m[8] - m[5] * m[7]) * inv,
		(m[2] * m[7] - m[1] * m[8]) * inv,
		(m[1] * m[5] - m[2] * m[4]) * inv,
		(m[5] * m[6] - m[3] * m[8]) * inv,
		(m[0] * m[8] - m[2] * m[6]) * inv,
		(m[2] * m[3] - m[0] * m[5]) * inv,
		(m[3] * m[7] - m[4] * m[6]) * inv,
		(m[1] * m[6] - m[0] * m[7]) * inv,
		(m[0] * m[4] - m[1] * m[3]) * inv,
	];
}

/** The matrix whose COLUMNS are the three axes (a local -> world rotation when they are orthonormal). */
export function mFromColumns({
	x,
	y,
	z,
}: {
	x: Vec3;
	y: Vec3;
	z: Vec3;
}): Mat3 {
	return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export function mColumn({ m, index }: { m: Mat3; index: 0 | 1 | 2 }): Vec3 {
	return [m[index], m[index + 3], m[index + 6]];
}

export function quatNormalize(q: Quat): Quat {
	const length = Math.hypot(q[0], q[1], q[2], q[3]);
	if (!(length > 1e-12)) return IDENTITY_QUAT;
	return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Hamilton product `a b` (apply b first, then a). */
export function quatMul({ a, b }: { a: Quat; b: Quat }): Quat {
	return [
		a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
		a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
		a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
		a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
	];
}

export function quatConjugate(q: Quat): Quat {
	return [q[0], -q[1], -q[2], -q[3]];
}

/** Rotation of `radians` about the unit `axis`. */
export function quatFromAxisAngle({
	axis,
	radians,
}: {
	axis: Vec3;
	radians: number;
}): Quat {
	const half = radians / 2;
	const s = Math.sin(half);
	return [Math.cos(half), axis[0] * s, axis[1] * s, axis[2] * s];
}

export function quatToMat3(q: Quat): Mat3 {
	const [w, x, y, z] = quatNormalize(q);
	return [
		1 - 2 * (y * y + z * z),
		2 * (x * y - w * z),
		2 * (x * z + w * y),
		2 * (x * y + w * z),
		1 - 2 * (x * x + z * z),
		2 * (y * z - w * x),
		2 * (x * z - w * y),
		2 * (y * z + w * x),
		1 - 2 * (x * x + y * y),
	];
}

/** Quaternion of a rotation matrix (Shepperd's method, w >= 0). */
export function mat3ToQuat(m: Mat3): Quat {
	const trace = m[0] + m[4] + m[8];
	let q: [number, number, number, number];
	if (trace > 0) {
		const s = Math.sqrt(trace + 1) * 2;
		q = [s / 4, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
	} else if (m[0] > m[4] && m[0] > m[8]) {
		const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
		q = [(m[7] - m[5]) / s, s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
	} else if (m[4] > m[8]) {
		const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
		q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s];
	} else {
		const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
		q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4];
	}
	const unit = quatNormalize(q);
	return unit[0] < 0 ? [-unit[0], -unit[1], -unit[2], -unit[3]] : unit;
}

/** Spherical interpolation along the shortest arc; `t` in 0..1. */
export function quatSlerp({ a, b, t }: { a: Quat; b: Quat; t: number }): Quat {
	let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	let end: Quat = b;
	if (dot < 0) {
		dot = -dot;
		end = [-b[0], -b[1], -b[2], -b[3]];
	}
	if (dot > 0.9995) {
		return quatNormalize([
			a[0] + (end[0] - a[0]) * t,
			a[1] + (end[1] - a[1]) * t,
			a[2] + (end[2] - a[2]) * t,
			a[3] + (end[3] - a[3]) * t,
		]);
	}
	const theta = Math.acos(Math.min(1, dot));
	const sinTheta = Math.sin(theta);
	const wa = Math.sin((1 - t) * theta) / sinTheta;
	const wb = Math.sin(t * theta) / sinTheta;
	return [
		a[0] * wa + end[0] * wb,
		a[1] * wa + end[1] * wb,
		a[2] * wa + end[2] * wb,
		a[3] * wa + end[3] * wb,
	];
}

/** Angle between two rotations, radians (0..pi). */
export function quatAngle({ a, b }: { a: Quat; b: Quat }): number {
	const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
	return 2 * Math.acos(Math.min(1, dot));
}

/**
 * Rotation matrix of AE-style Euler angles in degrees:
 * `Rz(z) Ry(y) Rx(x)` (x is applied first). Same convention for Orientation
 * and X/Y/Z Rotation.
 */
export function eulerDegToMat3(degrees: Vec3): Mat3 {
	const cx = Math.cos(degrees[0] * DEG);
	const sx = Math.sin(degrees[0] * DEG);
	const cy = Math.cos(degrees[1] * DEG);
	const sy = Math.sin(degrees[1] * DEG);
	const cz = Math.cos(degrees[2] * DEG);
	const sz = Math.sin(degrees[2] * DEG);
	return [
		cz * cy,
		cz * sy * sx - sz * cx,
		cz * sy * cx + sz * sx,
		sz * cy,
		sz * sy * sx + cz * cx,
		sz * sy * cx - cz * sx,
		-sy,
		cy * sx,
		cy * cx,
	];
}

/**
 * Euler angles (degrees, the {@link eulerDegToMat3} convention) of a
 * rotation matrix. At gimbal lock (|y| = 90 deg) x is set to 0.
 */
export function mat3ToEulerDeg(m: Mat3): Vec3 {
	const sy = Math.max(-1, Math.min(1, -m[6]));
	const y = Math.asin(sy);
	if (Math.abs(sy) < 0.999999) {
		return [
			Math.atan2(m[7], m[8]) / DEG,
			y / DEG,
			Math.atan2(m[3], m[0]) / DEG,
		];
	}
	return [0, y / DEG, Math.atan2(-m[1], m[4]) / DEG];
}

export function affineApply({
	m,
	x,
	y,
}: {
	m: Affine2;
	x: number;
	y: number;
}): { x: number; y: number } {
	return { x: m[0] * x + m[1] * y + m[2], y: m[3] * x + m[4] * y + m[5] };
}

/** `a` after `b`: `(a o b)(p) = a(b(p))`. */
export function affineCompose({ a, b }: { a: Affine2; b: Affine2 }): Affine2 {
	return [
		a[0] * b[0] + a[1] * b[3],
		a[0] * b[1] + a[1] * b[4],
		a[0] * b[2] + a[1] * b[5] + a[2],
		a[3] * b[0] + a[4] * b[3],
		a[3] * b[1] + a[4] * b[4],
		a[3] * b[2] + a[4] * b[5] + a[5],
	];
}

export function affineInverse(m: Affine2): Affine2 | null {
	const det = m[0] * m[4] - m[1] * m[3];
	if (!(Math.abs(det) > 1e-12)) return null;
	const inv = 1 / det;
	const a = m[4] * inv;
	const b = -m[1] * inv;
	const d = -m[3] * inv;
	const e = m[0] * inv;
	return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

/** The 3x3 homogeneous form of an affine map (row-major, last row 0 0 1). */
export function affineToMat3(m: Affine2): Mat3 {
	return [m[0], m[1], m[2], m[3], m[4], m[5], 0, 0, 1];
}
