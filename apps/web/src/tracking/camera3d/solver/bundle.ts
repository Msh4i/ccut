/**
 * Sparse bundle adjustment for the camera solver: Levenberg-Marquardt on
 * the reprojection error with a Huber loss, the point blocks eliminated by
 * the Schur complement and the reduced camera system solved densely by
 * Cholesky. References: Triggs, McLauchlan, Hartley & Fitzgibbon, "Bundle
 * Adjustment: A Modern Synthesis" (2000), sections 4 (robust costs), 6.1
 * (Schur complement); Hartley & Zisserman appendix A6; Nielsen's damping
 * update ("Damping parameter in Marquardt's method", 1999).
 *
 * Camera model: `X_cam = R (X - C)`, `(u, v) = f (x / z, y / z)` with `(u,
 * v)` frame pixels relative to the frame centre. Rotation updates are
 * left-multiplied `R <- exp([w]x) R`; focal lengths are adjusted in log
 * space (`f <- f exp(d)`).
 *
 * All functions with typed-array state work in place.
 */
import { choleskySolve, mat3Mul, rotExp } from "./linalg";

export interface BundleCameras {
	count: number;
	/** 9 per camera: world-to-camera rotation, row-major. */
	rotations: Float64Array;
	/** 3 per camera: centre in world units. */
	centers: Float64Array;
	/** Focal length per camera, frame pixels. */
	focals: Float64Array;
}

export interface BundleObservations {
	count: number;
	camera: Int32Array;
	point: Int32Array;
	/** 2 per observation: frame pixels relative to the frame centre. */
	uv: Float64Array;
	/** 1 = used, 0 = ignored (an outlier). */
	active: Uint8Array;
}

export interface BundleProblem {
	cameras: BundleCameras;
	/** 3 per point. */
	points: Float64Array;
	observations: BundleObservations;
}

export interface BundleOptions {
	/** Per camera: 1 = its pose is held fixed. */
	fixedPose: Uint8Array;
	/** Rotation-only cameras (tripod pan): no camera ever moves its centre. */
	fixPositions: boolean;
	/**
	 * `fixed`: focal lengths are held. `shared`: one focal for every camera
	 * (fixed angle of view). `per-camera`: one per camera with a free pose
	 * (variable zoom), tied by `focalSmoothness`.
	 */
	focal: "fixed" | "shared" | "per-camera";
	/** With `per-camera`: 1 = this camera's focal length is held (`null` = all free, even where the pose is held). */
	fixedFocal: Uint8Array | null;
	/**
	 * Weights of the residuals `w_k (ln f_k - ln f_{k+1})` between cameras k
	 * and k + 1 (cameras in time order), length `count - 1`. Only used with
	 * `per-camera`.
	 */
	focalSmoothness: Float64Array | null;
	/** Per point: 1 = held fixed (motion-only adjustment). `null` = all free. */
	fixedPoints: Uint8Array | null;
	/** Huber threshold on the reprojection error, frame pixels. */
	huber: number;
	maxIterations: number;
	/** One centre coordinate held to remove the scale gauge, or `null`. */
	scaleAnchor: { camera: number; axis: 0 | 1 | 2 } | null;
	/**
	 * Extra damping of every point block, as a share of its mean diagonal:
	 * keeps points whose depth the data cannot fix (rotation-only cameras)
	 * from running off along their ray. Default 0.
	 */
	pointDamping?: number;
}

export interface BundleResult {
	/** Robust cost at the end. */
	cost: number;
	initialCost: number;
	iterations: number;
}

/** Robust (Huber) cost of a squared error. */
function huberCost({ e2, delta }: { e2: number; delta: number }): number {
	return e2 <= delta * delta ? e2 : 2 * delta * Math.sqrt(e2) - delta * delta;
}

/** Points grouped by observation (CSR over the active observations). */
function groupByPoint({ problem }: { problem: BundleProblem }): { offsets: Int32Array; list: Int32Array } {
	const pointCount = problem.points.length / 3;
	const { observations } = problem;
	const offsets = new Int32Array(pointCount + 1);
	for (let o = 0; o < observations.count; o++) {
		if (observations.active[o]) offsets[observations.point[o] + 1]++;
	}
	for (let p = 0; p < pointCount; p++) offsets[p + 1] += offsets[p];
	const fill = Int32Array.from(offsets.subarray(0, pointCount));
	const list = new Int32Array(offsets[pointCount]);
	for (let o = 0; o < observations.count; o++) {
		if (observations.active[o]) list[fill[observations.point[o]]++] = o;
	}
	return { offsets, list };
}

/** Total robust cost: reprojection terms plus the focal smoothness prior. */
function totalCost({
	problem,
	options,
	rotations,
	centers,
	focals,
	points,
}: {
	problem: BundleProblem;
	options: BundleOptions;
	rotations: Float64Array;
	centers: Float64Array;
	focals: Float64Array;
	points: Float64Array;
}): number {
	const { observations } = problem;
	const delta = options.huber;
	let cost = 0;
	for (let o = 0; o < observations.count; o++) {
		if (!observations.active[o]) continue;
		const c = observations.camera[o];
		const p = observations.point[o];
		const r = c * 9;
		const dx = points[p * 3] - centers[c * 3];
		const dy = points[p * 3 + 1] - centers[c * 3 + 1];
		const dz = points[p * 3 + 2] - centers[c * 3 + 2];
		const x = rotations[r] * dx + rotations[r + 1] * dy + rotations[r + 2] * dz;
		const y = rotations[r + 3] * dx + rotations[r + 4] * dy + rotations[r + 5] * dz;
		const z = rotations[r + 6] * dx + rotations[r + 7] * dy + rotations[r + 8] * dz;
		let e2: number;
		if (!(z > 1e-9)) {
			e2 = 1e12;
		} else {
			const eu = (focals[c] * x) / z - observations.uv[2 * o];
			const ev = (focals[c] * y) / z - observations.uv[2 * o + 1];
			e2 = eu * eu + ev * ev;
		}
		cost += huberCost({ e2, delta });
	}
	if (options.focal === "per-camera" && options.focalSmoothness) {
		const w = options.focalSmoothness;
		for (let k = 0; k + 1 < problem.cameras.count; k++) {
			const residual = w[k] * (Math.log(focals[k]) - Math.log(focals[k + 1]));
			cost += residual * residual;
		}
	}
	return cost;
}

/**
 * Levenberg-Marquardt bundle adjustment of `problem` (updated in place).
 * `step` is awaited between iterations and inside long loops: it is where
 * the caller yields to the UI and checks for cancellation (it may throw).
 */
export async function bundleAdjust({
	problem,
	options,
	step,
}: {
	problem: BundleProblem;
	options: BundleOptions;
	step: () => Promise<void>;
}): Promise<BundleResult> {
	const { cameras, observations } = problem;
	const pointCount = problem.points.length / 3;
	const cameraCount = cameras.count;
	const fixedPoints = options.fixedPoints;

	// parameter index of every camera-side unknown (rx ry rz cx cy cz lnf), -1 = held
	const camIdx = new Int32Array(cameraCount * 7).fill(-1);
	let size = 0;
	for (let c = 0; c < cameraCount; c++) {
		if (options.fixedPose[c]) continue;
		for (let k = 0; k < 3; k++) camIdx[c * 7 + k] = size++;
		if (options.fixPositions) continue;
		for (let k = 0; k < 3; k++) {
			if (options.scaleAnchor && options.scaleAnchor.camera === c && options.scaleAnchor.axis === k) continue;
			camIdx[c * 7 + 3 + k] = size++;
		}
	}
	if (options.focal === "shared") {
		const shared = size++;
		for (let c = 0; c < cameraCount; c++) camIdx[c * 7 + 6] = shared;
	} else if (options.focal === "per-camera") {
		for (let c = 0; c < cameraCount; c++) if (!options.fixedFocal || !options.fixedFocal[c]) camIdx[c * 7 + 6] = size++;
	}

	const { offsets: pointOffsets, list: pointObs } = groupByPoint({ problem });
	const obsCount = observations.count;
	const jc = new Float64Array(obsCount * 14);
	const jp = new Float64Array(obsCount * 6);
	const res = new Float64Array(obsCount * 2);
	const wt = new Float64Array(obsCount);
	const wcp = new Float64Array(obsCount * 21);
	const ycp = new Float64Array(obsCount * 21);
	const vBlocks = new Float64Array(pointCount * 9);
	const gPoints = new Float64Array(pointCount * 3);
	const vInv = new Float64Array(pointCount * 9);
	const s0 = new Float64Array(size * size);
	const g0 = new Float64Array(size);
	const sMat = new Float64Array(size * size);
	const rhs = new Float64Array(size);
	const delta = options.huber;

	let rotations = cameras.rotations;
	let centers = cameras.centers;
	let focals = cameras.focals;
	let points = problem.points;
	let cost = totalCost({ problem, options, rotations, centers, focals, points });
	const initialCost = cost;
	let lambda = 1e-4;
	let nu = 2;
	let iterations = 0;

	for (let iter = 0; iter < options.maxIterations; iter++) {
		await step();
		// --- linearise
		s0.fill(0);
		g0.fill(0);
		vBlocks.fill(0);
		gPoints.fill(0);
		for (let o = 0; o < obsCount; o++) {
			if (!observations.active[o]) continue;
			const c = observations.camera[o];
			const p = observations.point[o];
			const r = c * 9;
			const dx = points[p * 3] - centers[c * 3];
			const dy = points[p * 3 + 1] - centers[c * 3 + 1];
			const dz = points[p * 3 + 2] - centers[c * 3 + 2];
			const x = rotations[r] * dx + rotations[r + 1] * dy + rotations[r + 2] * dz;
			const y = rotations[r + 3] * dx + rotations[r + 4] * dy + rotations[r + 5] * dz;
			let z = rotations[r + 6] * dx + rotations[r + 7] * dy + rotations[r + 8] * dz;
			if (!(z > 1e-9)) z = 1e-9;
			const f = focals[c];
			const iz = 1 / z;
			const u = f * x * iz;
			const v = f * y * iz;
			const eu = u - observations.uv[2 * o];
			const ev = v - observations.uv[2 * o + 1];
			const e = Math.sqrt(eu * eu + ev * ev);
			const w = e <= delta ? 1 : delta / e;
			wt[o] = w;
			res[2 * o] = eu;
			res[2 * o + 1] = ev;
			// d(u, v)/d(X_cam) = f/z [[1, 0, -x/z], [0, 1, -y/z]]
			const a = f * iz;
			const xz = x * iz;
			const yz = y * iz;
			const j = o * 14;
			// rotation: [-f x y / z^2, f (1 + x^2/z^2), -f y / z] and [-f (1 + y^2/z^2), f x y / z^2, f x / z]
			jc[j] = -f * xz * yz;
			jc[j + 1] = f * (1 + xz * xz);
			jc[j + 2] = -f * yz;
			jc[j + 7] = -f * (1 + yz * yz);
			jc[j + 8] = f * xz * yz;
			jc[j + 9] = f * xz;
			// point: P R; centre: -P R
			const p00 = a * (rotations[r] - xz * rotations[r + 6]);
			const p01 = a * (rotations[r + 1] - xz * rotations[r + 7]);
			const p02 = a * (rotations[r + 2] - xz * rotations[r + 8]);
			const p10 = a * (rotations[r + 3] - yz * rotations[r + 6]);
			const p11 = a * (rotations[r + 4] - yz * rotations[r + 7]);
			const p12 = a * (rotations[r + 5] - yz * rotations[r + 8]);
			jc[j + 3] = -p00;
			jc[j + 4] = -p01;
			jc[j + 5] = -p02;
			jc[j + 10] = -p10;
			jc[j + 11] = -p11;
			jc[j + 12] = -p12;
			jc[j + 6] = u;
			jc[j + 13] = v;
			const q = o * 6;
			jp[q] = p00;
			jp[q + 1] = p01;
			jp[q + 2] = p02;
			jp[q + 3] = p10;
			jp[q + 4] = p11;
			jp[q + 5] = p12;
			// camera-side normal equations
			const base = c * 7;
			for (let ka = 0; ka < 7; ka++) {
				const ia = camIdx[base + ka];
				if (ia < 0) continue;
				const ja0 = jc[j + ka];
				const ja1 = jc[j + 7 + ka];
				g0[ia] += w * (ja0 * eu + ja1 * ev);
				const row = ia * size;
				for (let kb = 0; kb < 7; kb++) {
					const ib = camIdx[base + kb];
					if (ib < 0) continue;
					s0[row + ib] += w * (ja0 * jc[j + kb] + ja1 * jc[j + 7 + kb]);
				}
			}
			if (fixedPoints && fixedPoints[p]) continue;
			// point block, gradient and the camera-point coupling W = Jc^T w Jp
			const vb = p * 9;
			for (let m = 0; m < 3; m++) {
				const pm0 = jp[q + m];
				const pm1 = jp[q + 3 + m];
				gPoints[p * 3 + m] += w * (pm0 * eu + pm1 * ev);
				for (let n = 0; n < 3; n++) vBlocks[vb + m * 3 + n] += w * (pm0 * jp[q + n] + pm1 * jp[q + 3 + n]);
			}
			const wo = o * 21;
			for (let ka = 0; ka < 7; ka++) {
				const ja0 = w * jc[j + ka];
				const ja1 = w * jc[j + 7 + ka];
				for (let n = 0; n < 3; n++) wcp[wo + ka * 3 + n] = ja0 * jp[q + n] + ja1 * jp[q + 3 + n];
			}
		}
		if (options.focal === "per-camera" && options.focalSmoothness) {
			const smooth = options.focalSmoothness;
			for (let k = 0; k + 1 < cameraCount; k++) {
				const residual = smooth[k] * (Math.log(focals[k]) - Math.log(focals[k + 1]));
				const ia = camIdx[k * 7 + 6];
				const ib = camIdx[(k + 1) * 7 + 6];
				const w2 = smooth[k] * smooth[k];
				if (ia >= 0) {
					s0[ia * size + ia] += w2;
					g0[ia] += smooth[k] * residual;
				}
				if (ib >= 0) {
					s0[ib * size + ib] += w2;
					g0[ib] -= smooth[k] * residual;
				}
				if (ia >= 0 && ib >= 0) {
					s0[ia * size + ib] -= w2;
					s0[ib * size + ia] -= w2;
				}
			}
		}
		let sMax = 0;
		for (let i = 0; i < size; i++) sMax = Math.max(sMax, s0[i * size + i]);
		let vMax = 0;
		for (let p = 0; p < pointCount; p++) vMax = Math.max(vMax, vBlocks[p * 9], vBlocks[p * 9 + 4], vBlocks[p * 9 + 8]);

		// --- damped solves until the cost goes down
		let accepted = false;
		for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
			sMat.set(s0);
			for (let i = 0; i < size; i++) sMat[i * size + i] += lambda * s0[i * size + i] + 1e-12 * sMax + 1e-12;
			for (let i = 0; i < size; i++) rhs[i] = -g0[i];
			let pointsSeen = 0;
			for (let p = 0; p < pointCount; p++) {
				if (fixedPoints && fixedPoints[p]) continue;
				const start = pointOffsets[p];
				const end = pointOffsets[p + 1];
				if (end === start) continue;
				const vb = p * 9;
				const d = 1 + lambda;
				const eps =
					1e-12 * vMax + 1e-12 + (options.pointDamping ?? 0) * ((vBlocks[vb] + vBlocks[vb + 4] + vBlocks[vb + 8]) / 3);
				const m00 = vBlocks[vb] * d + eps;
				const m11 = vBlocks[vb + 4] * d + eps;
				const m22 = vBlocks[vb + 8] * d + eps;
				const m01 = vBlocks[vb + 1];
				const m02 = vBlocks[vb + 2];
				const m12 = vBlocks[vb + 5];
				const c00 = m11 * m22 - m12 * m12;
				const c01 = m02 * m12 - m01 * m22;
				const c02 = m01 * m12 - m02 * m11;
				const det = m00 * c00 + m01 * c01 + m02 * c02;
				const inv = det > 1e-300 ? 1 / det : 0;
				const vi = vInv;
				vi[vb] = c00 * inv;
				vi[vb + 1] = c01 * inv;
				vi[vb + 2] = c02 * inv;
				vi[vb + 3] = c01 * inv;
				vi[vb + 4] = (m00 * m22 - m02 * m02) * inv;
				vi[vb + 5] = (m01 * m02 - m00 * m12) * inv;
				vi[vb + 6] = c02 * inv;
				vi[vb + 7] = (m01 * m02 - m00 * m12) * inv;
				vi[vb + 8] = (m00 * m11 - m01 * m01) * inv;
				const gp0 = gPoints[p * 3];
				const gp1 = gPoints[p * 3 + 1];
				const gp2 = gPoints[p * 3 + 2];
				for (let s = start; s < end; s++) {
					const o = pointObs[s];
					const wo = o * 21;
					// Y = W V^-1, rhs += Y g_p
					const cBase = observations.camera[o] * 7;
					for (let ka = 0; ka < 7; ka++) {
						const w0 = wcp[wo + ka * 3];
						const w1 = wcp[wo + ka * 3 + 1];
						const w2 = wcp[wo + ka * 3 + 2];
						const y0 = w0 * vi[vb] + w1 * vi[vb + 3] + w2 * vi[vb + 6];
						const y1 = w0 * vi[vb + 1] + w1 * vi[vb + 4] + w2 * vi[vb + 7];
						const y2 = w0 * vi[vb + 2] + w1 * vi[vb + 5] + w2 * vi[vb + 8];
						ycp[wo + ka * 3] = y0;
						ycp[wo + ka * 3 + 1] = y1;
						ycp[wo + ka * 3 + 2] = y2;
						const ia = camIdx[cBase + ka];
						if (ia >= 0) rhs[ia] += y0 * gp0 + y1 * gp1 + y2 * gp2;
					}
				}
				for (let s1 = start; s1 < end; s1++) {
					const o1 = pointObs[s1];
					const b1 = observations.camera[o1] * 7;
					const y = o1 * 21;
					for (let s2 = start; s2 < end; s2++) {
						const o2 = pointObs[s2];
						const b2 = observations.camera[o2] * 7;
						const wv = o2 * 21;
						for (let ka = 0; ka < 7; ka++) {
							const ia = camIdx[b1 + ka];
							if (ia < 0) continue;
							const y0 = ycp[y + ka * 3];
							const y1 = ycp[y + ka * 3 + 1];
							const y2 = ycp[y + ka * 3 + 2];
							const row = ia * size;
							for (let kb = 0; kb < 7; kb++) {
								const ib = camIdx[b2 + kb];
								if (ib < 0) continue;
								sMat[row + ib] -= y0 * wcp[wv + kb * 3] + y1 * wcp[wv + kb * 3 + 1] + y2 * wcp[wv + kb * 3 + 2];
							}
						}
					}
				}
				if (++pointsSeen % 512 === 0) await step();
			}
			const dc = rhs;
			if (size > 0 && !choleskySolve({ a: sMat, b: dc, n: size })) {
				lambda *= nu;
				nu *= 2;
				continue;
			}
			// --- candidate update
			const nextRotations = Float64Array.from(rotations);
			const nextCenters = Float64Array.from(centers);
			const nextFocals = Float64Array.from(focals);
			const nextPoints = Float64Array.from(points);
			for (let c = 0; c < cameraCount; c++) {
				const base = c * 7;
				const w0 = camIdx[base] >= 0 ? dc[camIdx[base]] : 0;
				const w1 = camIdx[base + 1] >= 0 ? dc[camIdx[base + 1]] : 0;
				const w2 = camIdx[base + 2] >= 0 ? dc[camIdx[base + 2]] : 0;
				if (w0 !== 0 || w1 !== 0 || w2 !== 0) {
					nextRotations.set(mat3Mul({ a: rotExp([w0, w1, w2]), b: rotations.subarray(c * 9, c * 9 + 9) }), c * 9);
				}
				for (let k = 0; k < 3; k++) {
					const index = camIdx[base + 3 + k];
					if (index >= 0) nextCenters[c * 3 + k] += dc[index];
				}
				const fIndex = camIdx[base + 6];
				if (fIndex >= 0) nextFocals[c] = focals[c] * Math.exp(Math.max(-0.5, Math.min(0.5, dc[fIndex])));
			}
			for (let p = 0; p < pointCount; p++) {
				if (fixedPoints && fixedPoints[p]) continue;
				const start = pointOffsets[p];
				const end = pointOffsets[p + 1];
				if (end === start) continue;
				// dp = -V^-1 (g_p + sum W^T dc)
				let t0 = gPoints[p * 3];
				let t1 = gPoints[p * 3 + 1];
				let t2 = gPoints[p * 3 + 2];
				for (let s = start; s < end; s++) {
					const o = pointObs[s];
					const wo = o * 21;
					const cBase = observations.camera[o] * 7;
					for (let ka = 0; ka < 7; ka++) {
						const ia = camIdx[cBase + ka];
						if (ia < 0) continue;
						const value = dc[ia];
						t0 += wcp[wo + ka * 3] * value;
						t1 += wcp[wo + ka * 3 + 1] * value;
						t2 += wcp[wo + ka * 3 + 2] * value;
					}
				}
				const vb = p * 9;
				nextPoints[p * 3] -= vInv[vb] * t0 + vInv[vb + 1] * t1 + vInv[vb + 2] * t2;
				nextPoints[p * 3 + 1] -= vInv[vb + 3] * t0 + vInv[vb + 4] * t1 + vInv[vb + 5] * t2;
				nextPoints[p * 3 + 2] -= vInv[vb + 6] * t0 + vInv[vb + 7] * t1 + vInv[vb + 8] * t2;
			}
			const nextCost = totalCost({
				problem,
				options,
				rotations: nextRotations,
				centers: nextCenters,
				focals: nextFocals,
				points: nextPoints,
			});
			if (nextCost < cost) {
				const gain = (cost - nextCost) / Math.max(cost, 1e-300);
				rotations = nextRotations;
				centers = nextCenters;
				focals = nextFocals;
				points = nextPoints;
				cost = nextCost;
				lambda = Math.max(1e-12, lambda / 3);
				nu = 2;
				accepted = true;
				iterations++;
				if (gain < 1e-7) iter = options.maxIterations;
			} else {
				lambda *= nu;
				nu *= 2;
			}
		}
		if (!accepted) break;
	}
	cameras.rotations.set(rotations);
	cameras.centers.set(centers);
	cameras.focals.set(focals);
	problem.points.set(points);
	return { cost, initialCost, iterations };
}

export interface PoseRefinement {
	rotation: Float64Array;
	center: Float64Array;
	focal: number;
	/** Root mean square reprojection error over the points, frame pixels. */
	rms: number;
	/** Per point reprojection error. */
	errors: Float64Array;
}

/**
 * Motion-only Levenberg-Marquardt for one camera against fixed points
 * (`points` xyz triples, `uv` their frame pixels relative to the centre),
 * Huber loss. `refineFocal` adds the focal length; `focalPrior` ties it
 * to a value with a weight (residual `weight ln(f / value)`).
 */
export function refinePose({
	rotation,
	center,
	focal,
	points,
	uv,
	huber,
	iterations,
	refineFocal,
	fixPosition,
	focalPrior,
}: {
	rotation: ArrayLike<number>;
	center: ArrayLike<number>;
	focal: number;
	points: Float64Array;
	uv: Float64Array;
	huber: number;
	iterations: number;
	refineFocal: boolean;
	fixPosition: boolean;
	focalPrior?: { value: number; weight: number };
}): PoseRefinement {
	const n = points.length / 3;
	let r: Float64Array = Float64Array.from(rotation);
	let c: Float64Array = Float64Array.from(center);
	let f = focal;
	const dims = 3 + (fixPosition ? 0 : 3) + (refineFocal ? 1 : 0);
	const evaluate = ({ rr, cc, ff }: { rr: Float64Array; cc: Float64Array; ff: number }): number => {
		let cost = 0;
		for (let i = 0; i < n; i++) {
			const dx = points[i * 3] - cc[0];
			const dy = points[i * 3 + 1] - cc[1];
			const dz = points[i * 3 + 2] - cc[2];
			const x = rr[0] * dx + rr[1] * dy + rr[2] * dz;
			const y = rr[3] * dx + rr[4] * dy + rr[5] * dz;
			const z = rr[6] * dx + rr[7] * dy + rr[8] * dz;
			if (!(z > 1e-9)) {
				cost += huberCost({ e2: 1e12, delta: huber });
				continue;
			}
			const eu = (ff * x) / z - uv[2 * i];
			const ev = (ff * y) / z - uv[2 * i + 1];
			cost += huberCost({ e2: eu * eu + ev * ev, delta: huber });
		}
		if (focalPrior) {
			const residual = focalPrior.weight * Math.log(ff / focalPrior.value);
			cost += residual * residual;
		}
		return cost;
	};
	let cost = evaluate({ rr: r, cc: c, ff: f });
	let lambda = 1e-4;
	const h = new Float64Array(dims * dims);
	const g = new Float64Array(dims);
	const jrow = new Float64Array(dims * 2);
	for (let iter = 0; iter < iterations; iter++) {
		h.fill(0);
		g.fill(0);
		for (let i = 0; i < n; i++) {
			const dx = points[i * 3] - c[0];
			const dy = points[i * 3 + 1] - c[1];
			const dz = points[i * 3 + 2] - c[2];
			const x = r[0] * dx + r[1] * dy + r[2] * dz;
			const y = r[3] * dx + r[4] * dy + r[5] * dz;
			const z = r[6] * dx + r[7] * dy + r[8] * dz;
			if (!(z > 1e-9)) continue;
			const iz = 1 / z;
			const xz = x * iz;
			const yz = y * iz;
			const u = f * xz;
			const v = f * yz;
			const eu = u - uv[2 * i];
			const ev = v - uv[2 * i + 1];
			const e = Math.sqrt(eu * eu + ev * ev);
			const w = e <= huber ? 1 : huber / e;
			const a = f * iz;
			jrow[0] = -f * xz * yz;
			jrow[1] = f * (1 + xz * xz);
			jrow[2] = -f * yz;
			jrow[dims] = -f * (1 + yz * yz);
			jrow[dims + 1] = f * xz * yz;
			jrow[dims + 2] = f * xz;
			let k = 3;
			if (!fixPosition) {
				jrow[3] = -a * (r[0] - xz * r[6]);
				jrow[4] = -a * (r[1] - xz * r[7]);
				jrow[5] = -a * (r[2] - xz * r[8]);
				jrow[dims + 3] = -a * (r[3] - yz * r[6]);
				jrow[dims + 4] = -a * (r[4] - yz * r[7]);
				jrow[dims + 5] = -a * (r[5] - yz * r[8]);
				k = 6;
			}
			if (refineFocal) {
				jrow[k] = u;
				jrow[dims + k] = v;
			}
			for (let p = 0; p < dims; p++) {
				g[p] += w * (jrow[p] * eu + jrow[dims + p] * ev);
				for (let q = 0; q < dims; q++) h[p * dims + q] += w * (jrow[p] * jrow[q] + jrow[dims + p] * jrow[dims + q]);
			}
		}
		if (refineFocal && focalPrior) {
			const k = dims - 1;
			const residual = focalPrior.weight * Math.log(f / focalPrior.value);
			h[k * dims + k] += focalPrior.weight * focalPrior.weight;
			g[k] += focalPrior.weight * residual;
		}
		let accepted = false;
		for (let attempt = 0; attempt < 10 && !accepted; attempt++) {
			const a = Float64Array.from(h);
			const b = new Float64Array(dims);
			for (let p = 0; p < dims; p++) {
				a[p * dims + p] += lambda * h[p * dims + p] + 1e-12;
				b[p] = -g[p];
			}
			if (!choleskySolve({ a, b, n: dims })) {
				lambda *= 10;
				continue;
			}
			const nr = mat3Mul({ a: rotExp([b[0], b[1], b[2]]), b: r });
			const nc = Float64Array.from(c);
			let k = 3;
			if (!fixPosition) {
				nc[0] += b[3];
				nc[1] += b[4];
				nc[2] += b[5];
				k = 6;
			}
			const nf = refineFocal ? f * Math.exp(Math.max(-0.5, Math.min(0.5, b[k]))) : f;
			const nextCost = evaluate({ rr: nr, cc: nc, ff: nf });
			if (nextCost < cost) {
				const gain = (cost - nextCost) / Math.max(cost, 1e-300);
				r = nr;
				c = nc;
				f = nf;
				cost = nextCost;
				lambda = Math.max(1e-12, lambda / 3);
				accepted = true;
				if (gain < 1e-9) iter = iterations;
			} else {
				lambda *= 10;
			}
		}
		if (!accepted) break;
	}
	const errors = new Float64Array(n);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const dx = points[i * 3] - c[0];
		const dy = points[i * 3 + 1] - c[1];
		const dz = points[i * 3 + 2] - c[2];
		const x = r[0] * dx + r[1] * dy + r[2] * dz;
		const y = r[3] * dx + r[4] * dy + r[5] * dz;
		const z = r[6] * dx + r[7] * dy + r[8] * dz;
		const error = z > 1e-9 ? Math.hypot((f * x) / z - uv[2 * i], (f * y) / z - uv[2 * i + 1]) : 1e6;
		errors[i] = error;
		sum += error * error;
	}
	return { rotation: r, center: c, focal: f, rms: n > 0 ? Math.sqrt(sum / n) : 0, errors };
}

/**
 * Gauss-Newton (damped) refinement of one point seen by fixed cameras
 * (`cameras` indexes `rotations`/`centers`/`focals`, `uv` the observations
 * relative to the frame centre). Squared loss: call it on inliers.
 */
export function refinePoint({
	point,
	rotations,
	centers,
	focals,
	cameras,
	uv,
	iterations,
}: {
	point: ArrayLike<number>;
	rotations: Float64Array;
	centers: Float64Array;
	focals: Float64Array;
	cameras: Int32Array;
	uv: Float64Array;
	iterations: number;
}): { point: Float64Array; rms: number; errors: Float64Array } {
	const n = cameras.length;
	const p = Float64Array.from(point);
	const residuals = ({ q, out }: { q: Float64Array; out: Float64Array | null }): number => {
		let sum = 0;
		for (let k = 0; k < n; k++) {
			const c = cameras[k];
			const r = c * 9;
			const dx = q[0] - centers[c * 3];
			const dy = q[1] - centers[c * 3 + 1];
			const dz = q[2] - centers[c * 3 + 2];
			const x = rotations[r] * dx + rotations[r + 1] * dy + rotations[r + 2] * dz;
			const y = rotations[r + 3] * dx + rotations[r + 4] * dy + rotations[r + 5] * dz;
			const z = rotations[r + 6] * dx + rotations[r + 7] * dy + rotations[r + 8] * dz;
			const e2 = z > 1e-9 ? ((focals[c] * x) / z - uv[2 * k]) ** 2 + ((focals[c] * y) / z - uv[2 * k + 1]) ** 2 : 1e12;
			if (out) out[k] = Math.sqrt(e2);
			sum += e2;
		}
		return sum;
	};
	let cost = residuals({ q: p, out: null });
	let lambda = 1e-6;
	for (let iter = 0; iter < iterations; iter++) {
		const h = new Float64Array(9);
		const g = new Float64Array(3);
		for (let k = 0; k < n; k++) {
			const c = cameras[k];
			const r = c * 9;
			const dx = p[0] - centers[c * 3];
			const dy = p[1] - centers[c * 3 + 1];
			const dz = p[2] - centers[c * 3 + 2];
			const x = rotations[r] * dx + rotations[r + 1] * dy + rotations[r + 2] * dz;
			const y = rotations[r + 3] * dx + rotations[r + 4] * dy + rotations[r + 5] * dz;
			const z = rotations[r + 6] * dx + rotations[r + 7] * dy + rotations[r + 8] * dz;
			if (!(z > 1e-9)) continue;
			const f = focals[c];
			const a = f / z;
			const xz = x / z;
			const yz = y / z;
			const eu = f * xz - uv[2 * k];
			const ev = f * yz - uv[2 * k + 1];
			const j0 = [a * (rotations[r] - xz * rotations[r + 6]), a * (rotations[r + 1] - xz * rotations[r + 7]), a * (rotations[r + 2] - xz * rotations[r + 8])];
			const j1 = [a * (rotations[r + 3] - yz * rotations[r + 6]), a * (rotations[r + 4] - yz * rotations[r + 7]), a * (rotations[r + 5] - yz * rotations[r + 8])];
			for (let m = 0; m < 3; m++) {
				g[m] += j0[m] * eu + j1[m] * ev;
				for (let q = 0; q < 3; q++) h[m * 3 + q] += j0[m] * j0[q] + j1[m] * j1[q];
			}
		}
		let accepted = false;
		for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
			const a = Float64Array.from(h);
			for (let m = 0; m < 3; m++) a[m * 3 + m] += lambda * h[m * 3 + m] + 1e-12;
			const b = Float64Array.from([-g[0], -g[1], -g[2]]);
			if (!choleskySolve({ a, b, n: 3 })) {
				lambda *= 10;
				continue;
			}
			const q = Float64Array.from([p[0] + b[0], p[1] + b[1], p[2] + b[2]]);
			const next = residuals({ q, out: null });
			if (next < cost) {
				const gain = (cost - next) / Math.max(cost, 1e-300);
				p.set(q);
				cost = next;
				lambda = Math.max(1e-12, lambda / 3);
				accepted = true;
				if (gain < 1e-10) iter = iterations;
			} else {
				lambda *= 10;
			}
		}
		if (!accepted) break;
	}
	const errors = new Float64Array(n);
	const total = residuals({ q: p, out: errors });
	return { point: p, rms: n > 0 ? Math.sqrt(total / n) : 0, errors };
}
