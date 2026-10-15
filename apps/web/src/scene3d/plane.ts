import { vDot, vNormalize, vScale, vSub, vAdd } from "./math";
import type { Plane, Vec3 } from "./types";

/**
 * Eigen-decomposition of a symmetric 3x3 matrix (cyclic Jacobi). Returns
 * eigenvalues ascending with their unit eigenvectors.
 */
export function symmetricEigen3(
	matrix: readonly number[],
): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
	const a = [...matrix];
	const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	for (let sweep = 0; sweep < 32; sweep++) {
		const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
		if (off < 1e-30) break;
		for (const [p, q] of [
			[0, 1],
			[0, 2],
			[1, 2],
		]) {
			const apq = a[p * 3 + q];
			if (Math.abs(apq) < 1e-300) continue;
			const app = a[p * 3 + p];
			const aqq = a[q * 3 + q];
			const theta = (aqq - app) / (2 * apq);
			const t =
				Math.sign(theta || 1) /
				(Math.abs(theta) + Math.sqrt(theta * theta + 1));
			const c = 1 / Math.sqrt(t * t + 1);
			const s = t * c;
			for (let k = 0; k < 3; k++) {
				const akp = a[k * 3 + p];
				const akq = a[k * 3 + q];
				a[k * 3 + p] = c * akp - s * akq;
				a[k * 3 + q] = s * akp + c * akq;
			}
			for (let k = 0; k < 3; k++) {
				const apk = a[p * 3 + k];
				const aqk = a[q * 3 + k];
				a[p * 3 + k] = c * apk - s * aqk;
				a[q * 3 + k] = s * apk + c * aqk;
			}
			for (let k = 0; k < 3; k++) {
				const vkp = v[k * 3 + p];
				const vkq = v[k * 3 + q];
				v[k * 3 + p] = c * vkp - s * vkq;
				v[k * 3 + q] = s * vkp + c * vkq;
			}
		}
	}
	const order = [0, 1, 2].sort((i, j) => a[i * 4] - a[j * 4]);
	const column = (index: number): Vec3 => [v[index], v[index + 3], v[index + 6]];
	return {
		values: [a[order[0] * 4], a[order[1] * 4], a[order[2] * 4]],
		vectors: [column(order[0]), column(order[1]), column(order[2])],
	};
}

/**
 * Least-squares plane through 3 or more points (total least squares: the
 * normal is the direction of least spread). `null` for fewer than 3 points
 * or points on a line. `weights` (optional) are per-point, >= 0.
 */
export function fitPlane({
	points,
	weights,
}: {
	points: readonly Vec3[];
	weights?: readonly number[];
}): Plane | null {
	if (points.length < 3) return null;
	let total = 0;
	let cx = 0;
	let cy = 0;
	let cz = 0;
	for (let i = 0; i < points.length; i++) {
		const w = weights ? weights[i] : 1;
		total += w;
		cx += w * points[i][0];
		cy += w * points[i][1];
		cz += w * points[i][2];
	}
	if (!(total > 0)) return null;
	cx /= total;
	cy /= total;
	cz /= total;
	const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	for (let i = 0; i < points.length; i++) {
		const w = weights ? weights[i] : 1;
		const dx = points[i][0] - cx;
		const dy = points[i][1] - cy;
		const dz = points[i][2] - cz;
		cov[0] += w * dx * dx;
		cov[1] += w * dx * dy;
		cov[2] += w * dx * dz;
		cov[4] += w * dy * dy;
		cov[5] += w * dy * dz;
		cov[8] += w * dz * dz;
	}
	cov[3] = cov[1];
	cov[6] = cov[2];
	cov[7] = cov[5];
	const { values, vectors } = symmetricEigen3(cov);
	// a line (or a point) has two vanishing spreads: no unique plane
	if (!(values[1] > 1e-12 * Math.max(values[2], 1e-300))) return null;
	const normal = vNormalize(vectors[0]);
	if (!normal) return null;
	return { point: [cx, cy, cz], normal };
}

/** Signed distance of `point` from `plane` (positive on the normal's side). */
export function planeDistance({
	plane,
	point,
}: {
	plane: Plane;
	point: Vec3;
}): number {
	return vDot({ a: vSub({ a: point, b: plane.point }), b: plane.normal });
}

/** The same plane with its normal flipped, when needed, to point towards `viewpoint`. */
export function planeFacing({
	plane,
	viewpoint,
}: {
	plane: Plane;
	viewpoint: Vec3;
}): Plane {
	if (planeDistance({ plane, point: viewpoint }) >= 0) return plane;
	return {
		point: plane.point,
		normal: [-plane.normal[0], -plane.normal[1], -plane.normal[2]],
	};
}

/** Orthogonal projection of `point` onto `plane`. */
export function projectOntoPlane({
	plane,
	point,
}: {
	plane: Plane;
	point: Vec3;
}): Vec3 {
	const distance = planeDistance({ plane, point });
	return vSub({ a: point, b: vScale({ v: plane.normal, s: distance }) });
}

/**
 * Where a ray meets a plane, in front of the ray origin. `null` when the ray
 * is parallel to the plane or the hit is behind the origin.
 */
export function intersectRayPlane({
	origin,
	direction,
	plane,
}: {
	origin: Vec3;
	direction: Vec3;
	plane: Plane;
}): Vec3 | null {
	const denominator = vDot({ a: direction, b: plane.normal });
	if (Math.abs(denominator) < 1e-12) return null;
	const t =
		vDot({ a: vSub({ a: plane.point, b: origin }), b: plane.normal }) /
		denominator;
	if (!(t > 0)) return null;
	return vAdd({ a: origin, b: vScale({ v: direction, s: t }) });
}
