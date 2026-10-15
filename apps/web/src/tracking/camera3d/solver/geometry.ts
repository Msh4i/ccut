/**
 * Multiple-view geometry for the camera solver: normalised DLT estimators,
 * essential-matrix and homography decompositions, triangulation and PnP.
 * References: Hartley & Zisserman, "Multiple View Geometry in Computer
 * Vision", 2nd ed. (H&Z): 8-point algorithm 11.2, essential matrix 9.6,
 * DLT homography 4.1, triangulation 12.2, camera resection 7.1; Faugeras &
 * Lustman, "Motion and structure from motion in a piecewise planar
 * environment" (1988) for the homography decomposition.
 *
 * Point lists are interleaved `[x0, y0, x1, y1, ...]`; `idx[0..n)` picks the
 * pairs to use. Calibrated ("normalised") image coordinates are
 * `(u / f, v / f)` with `(u, v)` frame pixels relative to the frame centre.
 * A two-view motion `(R, t)` maps camera-a coordinates to camera b:
 * `X_b = R X_a + t`, so `E = [t]x R` and `x_b^T E x_a = 0`.
 */
import {
	closestRotation,
	mat3Det,
	mat3Mul,
	mat3Transpose,
	nullVector,
	svd3,
} from "./linalg";

/** Similarity that moves the selected points to their centroid and a mean distance of sqrt(2). */
function hartleyNormalization({
	points,
	idx,
	n,
}: {
	points: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): { scale: number; cx: number; cy: number } | null {
	let cx = 0;
	let cy = 0;
	for (let q = 0; q < n; q++) {
		cx += points[2 * idx[q]];
		cy += points[2 * idx[q] + 1];
	}
	cx /= n;
	cy /= n;
	let spread = 0;
	for (let q = 0; q < n; q++) spread += Math.hypot(points[2 * idx[q]] - cx, points[2 * idx[q] + 1] - cy);
	spread /= n;
	if (!(spread > 1e-12)) return null;
	return { scale: Math.SQRT2 / spread, cx, cy };
}

/**
 * Fundamental matrix (rank 2) of `x_b^T F x_a = 0` from 8 or more pairs, by
 * the normalised 8-point algorithm (H&Z 11.2). On calibrated points this is
 * an essential matrix before its singular values are fixed.
 */
export function fitFundamental({
	a,
	b,
	idx,
	n,
}: {
	a: ArrayLike<number>;
	b: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): Float64Array | null {
	if (n < 8) return null;
	const na = hartleyNormalization({ points: a, idx, n });
	const nb = hartleyNormalization({ points: b, idx, n });
	if (!na || !nb) return null;
	const rows = new Float64Array(n * 9);
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const xa = (a[2 * i] - na.cx) * na.scale;
		const ya = (a[2 * i + 1] - na.cy) * na.scale;
		const xb = (b[2 * i] - nb.cx) * nb.scale;
		const yb = (b[2 * i + 1] - nb.cy) * nb.scale;
		const base = q * 9;
		rows[base] = xb * xa;
		rows[base + 1] = xb * ya;
		rows[base + 2] = xb;
		rows[base + 3] = yb * xa;
		rows[base + 4] = yb * ya;
		rows[base + 5] = yb;
		rows[base + 6] = xa;
		rows[base + 7] = ya;
		rows[base + 8] = 1;
	}
	const f = nullVector({ rows, m: n, n: 9 });
	const { u, s, v } = svd3(f);
	const rank2 = new Float64Array(9);
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) rank2[i * 3 + j] = u[i * 3] * s[0] * v[j * 3] + u[i * 3 + 1] * s[1] * v[j * 3 + 1];
	}
	// F = Tb^T F~ Ta with T = [[s, 0, -s cx], [0, s, -s cy], [0, 0, 1]]
	const ta = Float64Array.from([na.scale, 0, -na.scale * na.cx, 0, na.scale, -na.scale * na.cy, 0, 0, 1]);
	const tb = Float64Array.from([nb.scale, 0, -nb.scale * nb.cx, 0, nb.scale, -nb.scale * nb.cy, 0, 0, 1]);
	const out = mat3Mul({ a: mat3Mul({ a: mat3Transpose(tb), b: rank2 }), b: ta });
	const norm = Math.hypot(...out);
	if (!(norm > 0)) return null;
	for (let i = 0; i < 9; i++) out[i] /= norm;
	return out;
}

/** The nearest essential matrix (singular values 1, 1, 0) to `m`. */
export function projectToEssential(m: ArrayLike<number>): Float64Array {
	const { u, v } = svd3(m);
	const out = new Float64Array(9);
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) out[i * 3 + j] = u[i * 3] * v[j * 3] + u[i * 3 + 1] * v[j * 3 + 1];
	}
	return out;
}

/** Essential matrix from calibrated pairs (8-point, then projected to the essential manifold). */
export function essentialFromPoints({
	a,
	b,
	idx,
	n,
}: {
	a: ArrayLike<number>;
	b: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): Float64Array | null {
	const f = fitFundamental({ a, b, idx, n });
	return f ? projectToEssential(f) : null;
}

/**
 * First-order geometric error of a pair against `x_b^T F x_a = 0`
 * (Sampson distance, H&Z 11.4.3), in the units of the coordinates.
 */
export function sampsonDistance({
	f,
	ax,
	ay,
	bx,
	by,
}: {
	f: ArrayLike<number>;
	ax: number;
	ay: number;
	bx: number;
	by: number;
}): number {
	const fa0 = f[0] * ax + f[1] * ay + f[2];
	const fa1 = f[3] * ax + f[4] * ay + f[5];
	const fa2 = f[6] * ax + f[7] * ay + f[8];
	const ftb0 = f[0] * bx + f[3] * by + f[6];
	const ftb1 = f[1] * bx + f[4] * by + f[7];
	const err = bx * fa0 + by * fa1 + fa2;
	const den = fa0 * fa0 + fa1 * fa1 + ftb0 * ftb0 + ftb1 * ftb1;
	if (!(den > 0)) return Infinity;
	return Math.abs(err) / Math.sqrt(den);
}

export interface Motion {
	/** Rotation a -> b (row-major). */
	r: Float64Array;
	/** Translation a -> b (unit length for decompositions). */
	t: Float64Array;
}

/** The four motions of an essential matrix (H&Z result 9.19); cheirality picks one. */
export function decomposeEssential(e: ArrayLike<number>): Motion[] {
	const { u, v } = svd3(e);
	if (mat3Det(u) < 0) for (let i = 0; i < 9; i++) u[i] = -u[i];
	if (mat3Det(v) < 0) for (let i = 0; i < 9; i++) v[i] = -v[i];
	const w = Float64Array.from([0, -1, 0, 1, 0, 0, 0, 0, 1]);
	const vt = mat3Transpose(v);
	const r1 = mat3Mul({ a: mat3Mul({ a: u, b: w }), b: vt });
	const r2 = mat3Mul({ a: mat3Mul({ a: u, b: mat3Transpose(w) }), b: vt });
	const t = Float64Array.from([u[2], u[5], u[8]]);
	const minus = Float64Array.from([-t[0], -t[1], -t[2]]);
	return [
		{ r: r1, t },
		{ r: r1, t: minus },
		{ r: r2, t },
		{ r: r2, t: minus },
	];
}

/**
 * Linear (DLT) triangulation of one point seen by several calibrated
 * cameras `X_cam = R_k X + t_k` at normalised positions `(xs[k], ys[k])`
 * (H&Z 12.2). `null` for a point at infinity.
 */
export function triangulate({
	rotations,
	translations,
	xs,
	ys,
}: {
	rotations: readonly ArrayLike<number>[];
	translations: readonly ArrayLike<number>[];
	xs: readonly number[];
	ys: readonly number[];
}): Float64Array | null {
	const views = rotations.length;
	const rows = new Float64Array(views * 2 * 4);
	for (let k = 0; k < views; k++) {
		const r = rotations[k];
		const t = translations[k];
		const p0 = [r[0], r[1], r[2], t[0]];
		const p1 = [r[3], r[4], r[5], t[1]];
		const p2 = [r[6], r[7], r[8], t[2]];
		for (let c = 0; c < 4; c++) {
			rows[k * 8 + c] = xs[k] * p2[c] - p0[c];
			rows[k * 8 + 4 + c] = ys[k] * p2[c] - p1[c];
		}
	}
	const x = nullVector({ rows, m: views * 2, n: 4 });
	if (!(Math.abs(x[3]) > 1e-12)) return null;
	return Float64Array.from([x[0] / x[3], x[1] / x[3], x[2] / x[3]]);
}

/** Normalised DLT homography `x_b ~ H x_a` from 4 or more pairs (H&Z 4.1, 4.4). */
export function fitHomography({
	a,
	b,
	idx,
	n,
}: {
	a: ArrayLike<number>;
	b: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): Float64Array | null {
	if (n < 4) return null;
	const na = hartleyNormalization({ points: a, idx, n });
	const nb = hartleyNormalization({ points: b, idx, n });
	if (!na || !nb) return null;
	const rows = new Float64Array(n * 2 * 9);
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const xa = (a[2 * i] - na.cx) * na.scale;
		const ya = (a[2 * i + 1] - na.cy) * na.scale;
		const xb = (b[2 * i] - nb.cx) * nb.scale;
		const yb = (b[2 * i + 1] - nb.cy) * nb.scale;
		const r0 = q * 18;
		rows[r0] = -xa;
		rows[r0 + 1] = -ya;
		rows[r0 + 2] = -1;
		rows[r0 + 6] = xb * xa;
		rows[r0 + 7] = xb * ya;
		rows[r0 + 8] = xb;
		const r1 = r0 + 9;
		rows[r1 + 3] = -xa;
		rows[r1 + 4] = -ya;
		rows[r1 + 5] = -1;
		rows[r1 + 6] = yb * xa;
		rows[r1 + 7] = yb * ya;
		rows[r1 + 8] = yb;
	}
	const h = nullVector({ rows, m: 2 * n, n: 9 });
	// H = Tb^-1 H~ Ta
	const ta = Float64Array.from([na.scale, 0, -na.scale * na.cx, 0, na.scale, -na.scale * na.cy, 0, 0, 1]);
	const tbInv = Float64Array.from([1 / nb.scale, 0, nb.cx, 0, 1 / nb.scale, nb.cy, 0, 0, 1]);
	const out = mat3Mul({ a: mat3Mul({ a: tbInv, b: h }), b: ta });
	const norm = Math.hypot(...out);
	if (!(norm > 0)) return null;
	for (let i = 0; i < 9; i++) out[i] /= norm;
	return out;
}

/** Distance from `H x_a` to `x_b` (one-way transfer error). */
export function homographyTransfer({
	h,
	ax,
	ay,
	bx,
	by,
}: {
	h: ArrayLike<number>;
	ax: number;
	ay: number;
	bx: number;
	by: number;
}): number {
	const w = h[6] * ax + h[7] * ay + h[8];
	if (!(Math.abs(w) > 1e-300)) return Infinity;
	return Math.hypot((h[0] * ax + h[1] * ay + h[2]) / w - bx, (h[3] * ax + h[4] * ay + h[5]) / w - by);
}

export interface PlanarMotion extends Motion {
	/** Unit plane normal in camera a, oriented with a positive z. */
	n: Float64Array;
}

/**
 * The eight motion and plane hypotheses of a calibrated homography
 * `H ~ R + t n^T / d` (Faugeras & Lustman 1988, in the form used by
 * ORB-SLAM's initializer). Translations are unit length; triangulating the
 * pairs (cheirality, parallax) picks one. Empty when the singular values are
 * (nearly) degenerate, e.g. a pure rotation.
 */
export function decomposeHomography(h: ArrayLike<number>): PlanarMotion[] {
	const { u, s: w, v } = svd3(h);
	const sign = mat3Det(u) * mat3Det(v) < 0 ? -1 : 1;
	const [d1, d2, d3] = [w[0], w[1], w[2]];
	if (!(d2 > 0) || d1 / d2 < 1.00001 || d2 / Math.max(d3, 1e-300) < 1.00001) return [];
	const vt = mat3Transpose(v);
	const aux1 = Math.sqrt((d1 * d1 - d2 * d2) / (d1 * d1 - d3 * d3));
	const aux3 = Math.sqrt((d2 * d2 - d3 * d3) / (d1 * d1 - d3 * d3));
	const x1 = [aux1, aux1, -aux1, -aux1];
	const x3 = [aux3, -aux3, aux3, -aux3];
	const out: PlanarMotion[] = [];
	const push = ({ rp, tp, np }: { rp: number[]; tp: number[]; np: number[] }): void => {
		const r = mat3Mul({ a: mat3Mul({ a: u, b: rp }), b: vt });
		for (let i = 0; i < 9; i++) r[i] *= sign;
		const t = Float64Array.from([
			u[0] * tp[0] + u[1] * tp[1] + u[2] * tp[2],
			u[3] * tp[0] + u[4] * tp[1] + u[5] * tp[2],
			u[6] * tp[0] + u[7] * tp[1] + u[8] * tp[2],
		]);
		const tl = Math.hypot(t[0], t[1], t[2]);
		for (let i = 0; i < 3; i++) t[i] /= tl;
		const n = Float64Array.from([
			v[0] * np[0] + v[1] * np[1] + v[2] * np[2],
			v[3] * np[0] + v[4] * np[1] + v[5] * np[2],
			v[6] * np[0] + v[7] * np[1] + v[8] * np[2],
		]);
		if (n[2] < 0) for (let i = 0; i < 3; i++) n[i] = -n[i];
		out.push({ r: closestRotation(r), t, n });
	};
	// d' = d2
	const sTheta = Math.sqrt((d1 * d1 - d2 * d2) * (d2 * d2 - d3 * d3)) / ((d1 + d3) * d2);
	const cTheta = (d2 * d2 + d1 * d3) / ((d1 + d3) * d2);
	const sThetas = [sTheta, -sTheta, -sTheta, sTheta];
	for (let i = 0; i < 4; i++) {
		push({
			rp: [cTheta, 0, -sThetas[i], 0, 1, 0, sThetas[i], 0, cTheta],
			tp: [x1[i] * (d1 - d3), 0, -x3[i] * (d1 - d3)],
			np: [x1[i], 0, x3[i]],
		});
	}
	// d' = -d2
	const sPhi = Math.sqrt((d1 * d1 - d2 * d2) * (d2 * d2 - d3 * d3)) / ((d1 - d3) * d2);
	const cPhi = (d1 * d3 - d2 * d2) / ((d1 - d3) * d2);
	const sPhis = [sPhi, -sPhi, -sPhi, sPhi];
	for (let i = 0; i < 4; i++) {
		push({
			rp: [cPhi, 0, sPhis[i], 0, -1, 0, sPhis[i], 0, -cPhi],
			tp: [x1[i] * (d1 + d3), 0, x3[i] * (d1 + d3)],
			np: [x1[i], 0, x3[i]],
		});
	}
	return out;
}

/** Centroid and scale that move 3D points to a mean distance of sqrt(3) from the origin. */
function normalize3D({
	points,
	idx,
	n,
}: {
	points: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): { cx: number; cy: number; cz: number; scale: number } | null {
	let cx = 0;
	let cy = 0;
	let cz = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		cx += points[3 * i];
		cy += points[3 * i + 1];
		cz += points[3 * i + 2];
	}
	cx /= n;
	cy /= n;
	cz /= n;
	let spread = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		spread += Math.hypot(points[3 * i] - cx, points[3 * i + 1] - cy, points[3 * i + 2] - cz);
	}
	spread /= n;
	if (!(spread > 1e-12)) return null;
	return { cx, cy, cz, scale: Math.sqrt(3) / spread };
}

/** The 3x4 DLT camera matrix (row-major) of 6+ correspondences 3D point -> image point (H&Z 7.1). */
function dltProjection({
	points,
	xs,
	idx,
	n,
}: {
	points: ArrayLike<number>;
	xs: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): Float64Array | null {
	if (n < 6) return null;
	const norm = normalize3D({ points, idx, n });
	if (!norm) return null;
	const rows = new Float64Array(n * 2 * 12);
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const X = (points[3 * i] - norm.cx) * norm.scale;
		const Y = (points[3 * i + 1] - norm.cy) * norm.scale;
		const Z = (points[3 * i + 2] - norm.cz) * norm.scale;
		const x = xs[2 * i];
		const y = xs[2 * i + 1];
		const r0 = q * 24;
		rows[r0] = X;
		rows[r0 + 1] = Y;
		rows[r0 + 2] = Z;
		rows[r0 + 3] = 1;
		rows[r0 + 8] = -x * X;
		rows[r0 + 9] = -x * Y;
		rows[r0 + 10] = -x * Z;
		rows[r0 + 11] = -x;
		const r1 = r0 + 12;
		rows[r1 + 4] = X;
		rows[r1 + 5] = Y;
		rows[r1 + 6] = Z;
		rows[r1 + 7] = 1;
		rows[r1 + 8] = -y * X;
		rows[r1 + 9] = -y * Y;
		rows[r1 + 10] = -y * Z;
		rows[r1 + 11] = -y;
	}
	const p = nullVector({ rows, m: 2 * n, n: 12 });
	// undo the normalisation: P = P~ T with T = [[s I, -s c], [0, 1]]
	const out = new Float64Array(12);
	for (let r = 0; r < 3; r++) {
		const a = p[r * 4];
		const b = p[r * 4 + 1];
		const c = p[r * 4 + 2];
		out[r * 4] = a * norm.scale;
		out[r * 4 + 1] = b * norm.scale;
		out[r * 4 + 2] = c * norm.scale;
		out[r * 4 + 3] = p[r * 4 + 3] - norm.scale * (a * norm.cx + b * norm.cy + c * norm.cz);
	}
	return out;
}

/** Sign of P so that the selected points are in front of the camera (positive third row). */
function frontSign({ p, points, idx, n }: { p: Float64Array; points: ArrayLike<number>; idx: ArrayLike<number>; n: number }): number {
	let front = 0;
	for (let q = 0; q < n; q++) {
		const i = idx[q];
		const w = p[8] * points[3 * i] + p[9] * points[3 * i + 1] + p[10] * points[3 * i + 2] + p[11];
		front += w > 0 ? 1 : -1;
	}
	return front >= 0 ? 1 : -1;
}

/**
 * Calibrated camera resection by DLT: the pose `X_cam = R X + t` that maps
 * 3D `points` (xyz triples) to normalised image points `xs`. Needs 6 pairs.
 */
export function pnpDlt({
	points,
	xs,
	idx,
	n,
}: {
	points: ArrayLike<number>;
	xs: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
}): Motion | null {
	const p = dltProjection({ points, xs, idx, n });
	if (!p) return null;
	const m = Float64Array.from([p[0], p[1], p[2], p[4], p[5], p[6], p[8], p[9], p[10]]);
	const { s } = svd3(m);
	const scale = (s[0] + s[1] + s[2]) / 3;
	if (!(scale > 1e-12)) return null;
	const sign = frontSign({ p, points, idx, n });
	const r = closestRotation(m.map((value) => (sign * value) / scale));
	if (mat3Det(m) * sign < 0) return null;
	const t = Float64Array.from([(sign * p[3]) / scale, (sign * p[7]) / scale, (sign * p[11]) / scale]);
	return { r, t };
}

/**
 * Camera resection with an unknown focal length (square pixels, principal
 * point at the centre): DLT on `uv / focalGuess`, then `K = diag(k, k, 1)`
 * read off the row norms of the left 3x3 block. `uv` are frame pixels
 * relative to the centre.
 */
export function pnpDltUncalibrated({
	points,
	uv,
	idx,
	n,
	focalGuess,
}: {
	points: ArrayLike<number>;
	uv: ArrayLike<number>;
	idx: ArrayLike<number>;
	n: number;
	focalGuess: number;
}): (Motion & { focal: number }) | null {
	const scaled = new Float64Array(uv.length);
	for (let i = 0; i < uv.length; i++) scaled[i] = uv[i] / focalGuess;
	const p = dltProjection({ points, xs: scaled, idx, n });
	if (!p) return null;
	const sign = frontSign({ p, points, idx, n });
	for (let i = 0; i < 12; i++) p[i] *= sign;
	const rowNorm = (r: number): number => Math.hypot(p[r * 4], p[r * 4 + 1], p[r * 4 + 2]);
	const s = rowNorm(2);
	if (!(s > 1e-12)) return null;
	const k = (rowNorm(0) + rowNorm(1)) / (2 * s);
	if (!(k > 1e-6)) return null;
	const m = Float64Array.from([
		p[0] / (k * s),
		p[1] / (k * s),
		p[2] / (k * s),
		p[4] / (k * s),
		p[5] / (k * s),
		p[6] / (k * s),
		p[8] / s,
		p[9] / s,
		p[10] / s,
	]);
	if (mat3Det(m) < 0) return null;
	const r = closestRotation(m);
	const t = Float64Array.from([p[3] / (k * s), p[7] / (k * s), p[11] / s]);
	return { r, t, focal: k * focalGuess };
}
