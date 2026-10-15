/**
 * Small dense linear algebra for the camera solver. Matrices are row-major
 * `Float64Array`s; 3x3 rotations act on column vectors (`x' = R x`).
 * Nothing here allocates more than its result.
 */

export type Vec3Like = ArrayLike<number>;

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Eigen-decomposition of a symmetric `n x n` matrix by cyclic Jacobi
 * rotations (Golub & Van Loan, "Matrix Computations", 8.5). Values
 * ascending; `vectors` holds the unit eigenvectors as COLUMNS
 * (`vectors[i * n + k]` is component i of vector k). `a` is not changed.
 */
export function symmetricEigen({
	a,
	n,
}: {
	a: ArrayLike<number>;
	n: number;
}): { values: Float64Array; vectors: Float64Array } {
	const m = Float64Array.from(a);
	const v = new Float64Array(n * n);
	for (let i = 0; i < n; i++) v[i * n + i] = 1;
	let scale = 0;
	for (let i = 0; i < n * n; i++) scale += m[i] * m[i];
	const tiny = 1e-30 * Math.max(scale, 1e-300);
	for (let sweep = 0; sweep < 64; sweep++) {
		let off = 0;
		for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p * n + q] * m[p * n + q];
		if (off <= tiny) break;
		for (let p = 0; p < n; p++) {
			for (let q = p + 1; q < n; q++) {
				const apq = m[p * n + q];
				if (Math.abs(apq) < 1e-300) continue;
				const theta = (m[q * n + q] - m[p * n + p]) / (2 * apq);
				const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					const mkp = m[k * n + p];
					const mkq = m[k * n + q];
					m[k * n + p] = c * mkp - s * mkq;
					m[k * n + q] = s * mkp + c * mkq;
				}
				for (let k = 0; k < n; k++) {
					const mpk = m[p * n + k];
					const mqk = m[q * n + k];
					m[p * n + k] = c * mpk - s * mqk;
					m[q * n + k] = s * mpk + c * mqk;
				}
				for (let k = 0; k < n; k++) {
					const vkp = v[k * n + p];
					const vkq = v[k * n + q];
					v[k * n + p] = c * vkp - s * vkq;
					v[k * n + q] = s * vkp + c * vkq;
				}
			}
		}
	}
	const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => m[i * n + i] - m[j * n + j]);
	const values = new Float64Array(n);
	const vectors = new Float64Array(n * n);
	for (let k = 0; k < n; k++) {
		const src = order[k];
		values[k] = m[src * n + src];
		for (let i = 0; i < n; i++) vectors[i * n + k] = v[i * n + src];
	}
	return { values, vectors };
}

/**
 * Unit vector `x` minimising `|A x|` for an `m x n` row-major `A` (the
 * eigenvector of `A^T A` with the smallest eigenvalue). Used for the
 * homogeneous DLT systems (8-point, homography, PnP), whose rows are
 * normalised first (Hartley, "In defense of the eight-point algorithm").
 */
export function nullVector({
	rows,
	m,
	n,
}: {
	rows: ArrayLike<number>;
	m: number;
	n: number;
}): Float64Array {
	const ata = new Float64Array(n * n);
	for (let r = 0; r < m; r++) {
		const base = r * n;
		for (let i = 0; i < n; i++) {
			const ai = rows[base + i];
			if (ai === 0) continue;
			for (let j = i; j < n; j++) ata[i * n + j] += ai * rows[base + j];
		}
	}
	for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) ata[i * n + j] = ata[j * n + i];
	const { vectors } = symmetricEigen({ a: ata, n });
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = vectors[i * n];
	return out;
}

export function mat3Mul({ a, b }: { a: ArrayLike<number>; b: ArrayLike<number> }): Float64Array {
	const out = new Float64Array(9);
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
		}
	}
	return out;
}

export function mat3Transpose(m: ArrayLike<number>): Float64Array {
	return Float64Array.from([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

export function mat3Det(m: ArrayLike<number>): number {
	return (
		m[0] * (m[4] * m[8] - m[5] * m[7]) -
		m[1] * (m[3] * m[8] - m[5] * m[6]) +
		m[2] * (m[3] * m[7] - m[4] * m[6])
	);
}

export function mat3Apply({ m, v }: { m: ArrayLike<number>; v: Vec3Like }): Float64Array {
	return Float64Array.from([
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	]);
}

/** `M^T v`. */
export function mat3ApplyT({ m, v }: { m: ArrayLike<number>; v: Vec3Like }): Float64Array {
	return Float64Array.from([
		m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
		m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
		m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
	]);
}

export function mat3Inverse(m: ArrayLike<number>): Float64Array | null {
	const det = mat3Det(m);
	if (!(Math.abs(det) > 1e-300)) return null;
	const inv = 1 / det;
	return Float64Array.from([
		(m[4] * m[8] - m[5] * m[7]) * inv,
		(m[2] * m[7] - m[1] * m[8]) * inv,
		(m[1] * m[5] - m[2] * m[4]) * inv,
		(m[5] * m[6] - m[3] * m[8]) * inv,
		(m[0] * m[8] - m[2] * m[6]) * inv,
		(m[2] * m[3] - m[0] * m[5]) * inv,
		(m[3] * m[7] - m[4] * m[6]) * inv,
		(m[1] * m[6] - m[0] * m[7]) * inv,
		(m[0] * m[4] - m[1] * m[3]) * inv,
	]);
}

export function cross({ a, b }: { a: Vec3Like; b: Vec3Like }): Float64Array {
	return Float64Array.from([
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	]);
}

export function norm3(v: Vec3Like): number {
	return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/**
 * SVD of a 3x3 matrix by one-sided Jacobi (Hestenes): `M = U diag(s) V^T`,
 * `s` descending and >= 0, U and V orthogonal (either may have det -1).
 * A rank-deficient M gets the missing columns of U completed to an
 * orthonormal basis.
 */
export function svd3(m: ArrayLike<number>): { u: Float64Array; s: Float64Array; v: Float64Array } {
	const a = Float64Array.from(m);
	const v = Float64Array.from(IDENTITY);
	for (let sweep = 0; sweep < 60; sweep++) {
		let rotated = false;
		for (let p = 0; p < 2; p++) {
			for (let q = p + 1; q < 3; q++) {
				let alpha = 0;
				let beta = 0;
				let gamma = 0;
				for (let i = 0; i < 3; i++) {
					const ap = a[i * 3 + p];
					const aq = a[i * 3 + q];
					alpha += ap * ap;
					beta += aq * aq;
					gamma += ap * aq;
				}
				if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
				rotated = true;
				const zeta = (beta - alpha) / (2 * gamma);
				const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
				const c = 1 / Math.sqrt(1 + t * t);
				const s = c * t;
				for (let i = 0; i < 3; i++) {
					const ap = a[i * 3 + p];
					const aq = a[i * 3 + q];
					a[i * 3 + p] = c * ap - s * aq;
					a[i * 3 + q] = s * ap + c * aq;
					const vp = v[i * 3 + p];
					const vq = v[i * 3 + q];
					v[i * 3 + p] = c * vp - s * vq;
					v[i * 3 + q] = s * vp + c * vq;
				}
			}
		}
		if (!rotated) break;
	}
	const norms = [0, 1, 2].map((k) => Math.hypot(a[k], a[3 + k], a[6 + k]));
	const order = [0, 1, 2].sort((i, j) => norms[j] - norms[i]);
	const u = new Float64Array(9);
	const s = new Float64Array(3);
	const vs = new Float64Array(9);
	const largest = norms[order[0]];
	let valid = 0;
	for (let k = 0; k < 3; k++) {
		const src = order[k];
		s[k] = norms[src];
		for (let i = 0; i < 3; i++) vs[i * 3 + k] = v[i * 3 + src];
		if (norms[src] > 1e-14 * Math.max(largest, 1e-300)) {
			for (let i = 0; i < 3; i++) u[i * 3 + k] = a[i * 3 + src] / norms[src];
			valid = k + 1;
		}
	}
	completeBasis({ u, valid });
	return { u, s, v: vs };
}

/** Fills the columns `valid..2` of `u` so its columns are an orthonormal basis. */
function completeBasis({ u, valid }: { u: Float64Array; valid: number }): void {
	for (let k = valid; k < 3; k++) {
		let best: Float64Array | null = null;
		for (let axis = 0; axis < 3 && !best; axis++) {
			const candidate = new Float64Array(3);
			candidate[axis] = 1;
			for (let j = 0; j < k; j++) {
				const dot = candidate[0] * u[j] + candidate[1] * u[3 + j] + candidate[2] * u[6 + j];
				for (let i = 0; i < 3; i++) candidate[i] -= dot * u[i * 3 + j];
			}
			const length = norm3(candidate);
			if (length > 0.5) {
				for (let i = 0; i < 3; i++) candidate[i] /= length;
				best = candidate;
			}
		}
		const column = best ?? Float64Array.from([0, 0, 1]);
		for (let i = 0; i < 3; i++) u[i * 3 + k] = column[i];
	}
}

/** The rotation nearest to `m` in the Frobenius norm (det +1), from its SVD. */
export function closestRotation(m: ArrayLike<number>): Float64Array {
	const { u, v } = svd3(m);
	let r = mat3Mul({ a: u, b: mat3Transpose(v) });
	if (mat3Det(r) < 0) {
		const flipped = Float64Array.from(u);
		for (let i = 0; i < 3; i++) flipped[i * 3 + 2] = -flipped[i * 3 + 2];
		r = mat3Mul({ a: flipped, b: mat3Transpose(v) });
	}
	return r;
}

/** Rotation matrix of the axis-angle vector `w` (Rodrigues' formula). */
export function rotExp(w: Vec3Like): Float64Array {
	const theta = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
	let a: number;
	let b: number;
	if (theta < 1e-6) {
		a = 1 - (theta * theta) / 6;
		b = 0.5 - (theta * theta) / 24;
	} else {
		a = Math.sin(theta) / theta;
		b = (1 - Math.cos(theta)) / (theta * theta);
	}
	const [x, y, z] = [w[0], w[1], w[2]];
	return Float64Array.from([
		1 - b * (y * y + z * z),
		-a * z + b * x * y,
		a * y + b * x * z,
		a * z + b * x * y,
		1 - b * (x * x + z * z),
		-a * x + b * y * z,
		-a * y + b * x * z,
		a * x + b * y * z,
		1 - b * (x * x + y * y),
	]);
}

/** Axis-angle vector of a rotation matrix (inverse of {@link rotExp}, angle in 0..pi). */
export function rotLog(r: ArrayLike<number>): Float64Array {
	const cosTheta = Math.max(-1, Math.min(1, (r[0] + r[4] + r[8] - 1) / 2));
	const theta = Math.acos(cosTheta);
	const vx = r[7] - r[5];
	const vy = r[2] - r[6];
	const vz = r[3] - r[1];
	if (theta < 1e-6) return Float64Array.from([vx / 2, vy / 2, vz / 2]);
	if (theta < Math.PI - 1e-3) {
		const k = theta / (2 * Math.sin(theta));
		return Float64Array.from([vx * k, vy * k, vz * k]);
	}
	// near pi: the axis from the symmetric part, its sign from the skew part
	const xx = Math.sqrt(Math.max(0, (r[0] + 1) / 2));
	const yy = Math.sqrt(Math.max(0, (r[4] + 1) / 2));
	const zz = Math.sqrt(Math.max(0, (r[8] + 1) / 2));
	let axis: [number, number, number];
	if (xx >= yy && xx >= zz) axis = [xx, (r[1] + r[3]) / (4 * xx), (r[2] + r[6]) / (4 * xx)];
	else if (yy >= zz) axis = [(r[1] + r[3]) / (4 * yy), yy, (r[5] + r[7]) / (4 * yy)];
	else axis = [(r[2] + r[6]) / (4 * zz), (r[5] + r[7]) / (4 * zz), zz];
	const length = Math.hypot(...axis);
	const sign = axis[0] * vx + axis[1] * vy + axis[2] * vz < 0 ? -1 : 1;
	return Float64Array.from(axis.map((value) => (sign * theta * value) / length));
}

/**
 * Solves `A x = b` for a symmetric positive definite `n x n` A by Cholesky.
 * `a` is overwritten with its factor and `b` with the solution. `false`
 * (and garbage in both) when A is not positive definite.
 */
export function choleskySolve({ a, b, n }: { a: Float64Array; b: Float64Array; n: number }): boolean {
	for (let j = 0; j < n; j++) {
		const rowJ = j * n;
		let d = a[rowJ + j];
		for (let k = 0; k < j; k++) d -= a[rowJ + k] * a[rowJ + k];
		if (!(d > 0)) return false;
		const ljj = Math.sqrt(d);
		a[rowJ + j] = ljj;
		const inv = 1 / ljj;
		for (let i = j + 1; i < n; i++) {
			const rowI = i * n;
			let s = a[rowI + j];
			for (let k = 0; k < j; k++) s -= a[rowI + k] * a[rowJ + k];
			a[rowI + j] = s * inv;
		}
	}
	for (let i = 0; i < n; i++) {
		let s = b[i];
		for (let k = 0; k < i; k++) s -= a[i * n + k] * b[k];
		b[i] = s / a[i * n + i];
	}
	for (let i = n - 1; i >= 0; i--) {
		let s = b[i];
		for (let k = i + 1; k < n; k++) s -= a[k * n + i] * b[k];
		b[i] = s / a[i * n + i];
	}
	return true;
}

/** Median of the first `n` values (copies them). `NaN` for none. */
export function median({ values, n }: { values: ArrayLike<number>; n?: number }): number {
	const count = n ?? values.length;
	if (count === 0) return Number.NaN;
	const sorted = Float64Array.from({ length: count }, (_, i) => values[i]).sort();
	return count % 2 === 1 ? sorted[count >> 1] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
}
