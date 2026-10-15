import type { Pyramid, PyramidLevel } from "./pyramid";

export interface LkOptions {
	/** Half the window side: the window is `2 * half + 1` pixels square. */
	half: number;
	maxIter: number;
	/** Stop when an update moves the estimate by less than this (|dx| + |dy|). */
	eps: number;
}

/** Where the feature landed, and the mean absolute gray-level difference left over. */
export interface LkResult {
	x: number;
	y: number;
	res: number;
}

const MAX_HALF = 15;

/** Window buffers, sized for the biggest window `lkPyr` accepts. */
export interface LkWorkspace {
	half: number;
	current: Float32Array;
	template: Float32Array;
	gradX: Float32Array;
	gradY: Float32Array;
	/** Level-local result of the last `lkLevel`. */
	x: number;
	y: number;
	res: number;
}

export function createLkWorkspace({ half }: { half: number }): LkWorkspace {
	if (!Number.isInteger(half) || half < 1 || half > MAX_HALF) {
		throw new RangeError(`LK half window must be an integer in 1..${MAX_HALF}, got ${half}`);
	}
	const area = (2 * half + 1) * (2 * half + 1);
	return {
		half,
		current: new Float32Array(area),
		template: new Float32Array(area),
		gradX: new Float32Array(area),
		gradY: new Float32Array(area),
		x: 0,
		y: 0,
		res: 0,
	};
}

/**
 * One pyramid level of inverse-compositional Lucas-Kanade. The template is the
 * window around (ax, ay) in `from`; the estimate starts at (bx, by) in `to`.
 * Both windows are made zero-mean, so a brightness step between the frames
 * (flash, auto-exposure) does not move the result. Writes `ws.x / y / res` and
 * returns false when the window leaves the image, the patch has too little
 * texture, or the iteration runs away.
 */
function lkLevel({
	from,
	to,
	ax,
	ay,
	bx,
	by,
	options,
	ws,
}: {
	from: PyramidLevel;
	to: PyramidLevel;
	ax: number;
	ay: number;
	bx: number;
	by: number;
	options: LkOptions;
	ws: LkWorkspace;
}): boolean {
	const { w, h } = from;
	const { half, maxIter, eps } = options;
	const n = 2 * half + 1;
	const { template: T, gradX: GX, gradY: GY, current: BB } = ws;
	const ixb = Math.floor(ax);
	const iyb = Math.floor(ay);
	if (ixb - half < 0 || iyb - half < 0 || ixb + half + 1 >= w || iyb + half + 1 >= h) return false;
	const fx = ax - ixb;
	const fy = ay - iyb;
	const w00 = (1 - fx) * (1 - fy);
	const w10 = fx * (1 - fy);
	const w01 = (1 - fx) * fy;
	const w11 = fx * fy;
	const AI = from.I;
	const AX = from.Ix;
	const AY = from.Iy;
	let gxx = 0;
	let gxy = 0;
	let gyy = 0;
	let k = 0;
	for (let j = -half; j <= half; j++) {
		let idx = (iyb + j) * w + ixb - half;
		for (let i = 0; i < n; i++, idx++, k++) {
			T[k] = AI[idx] * w00 + AI[idx + 1] * w10 + AI[idx + w] * w01 + AI[idx + w + 1] * w11;
			const gx = AX[idx] * w00 + AX[idx + 1] * w10 + AX[idx + w] * w01 + AX[idx + w + 1] * w11;
			const gy = AY[idx] * w00 + AY[idx + 1] * w10 + AY[idx + w] * w01 + AY[idx + w + 1] * w11;
			GX[k] = gx;
			GY[k] = gy;
			gxx += gx * gx;
			gxy += gx * gy;
			gyy += gy * gy;
		}
	}
	const det = gxx * gyy - gxy * gxy;
	const area = n * n;
	let tsum = 0;
	for (let q = 0; q < area; q++) tsum += T[q];
	const tmean = tsum / area;
	for (let q = 0; q < area; q++) T[q] -= tmean;
	const minEig = (gxx + gyy - Math.sqrt((gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy)) / (2 * area);
	if (!(minEig > 0.5) || det < 1e-6) return false;

	const BI = to.I;
	let u = bx;
	let v = by;
	let res = 0;
	const idet = 1 / det;
	for (let it = 0; it < maxIter; it++) {
		const jx = Math.floor(u);
		const jy = Math.floor(v);
		if (jx - half < 0 || jy - half < 0 || jx + half + 1 >= w || jy + half + 1 >= h) return false;
		const ux = u - jx;
		const uy = v - jy;
		const v00 = (1 - ux) * (1 - uy);
		const v10 = ux * (1 - uy);
		const v01 = (1 - ux) * uy;
		const v11 = ux * uy;
		let sx = 0;
		let sy = 0;
		let sr = 0;
		let bsum = 0;
		k = 0;
		for (let j = -half; j <= half; j++) {
			let idx = (jy + j) * w + jx - half;
			for (let i = 0; i < n; i++, idx++, k++) {
				const bv = BI[idx] * v00 + BI[idx + 1] * v10 + BI[idx + w] * v01 + BI[idx + w + 1] * v11;
				BB[k] = bv;
				bsum += bv;
			}
		}
		const bmean = bsum / area;
		for (k = 0; k < area; k++) {
			const e = BB[k] - bmean - T[k];
			sx += GX[k] * e;
			sy += GY[k] * e;
			sr += e < 0 ? -e : e;
		}
		const dx = -idet * (gyy * sx - gxy * sy);
		const dy = -idet * (-gxy * sx + gxx * sy);
		u += dx;
		v += dy;
		res = sr / area;
		if (Math.abs(dx) + Math.abs(dy) < eps) break;
		if (Math.abs(dx) > 8 || Math.abs(dy) > 8) return false;
	}
	ws.x = u;
	ws.y = v;
	ws.res = res;
	return true;
}

/**
 * Pyramidal Lucas-Kanade: follows the feature at (x, y) of `from` into `to`,
 * starting from the guess (guessX, guessY) and refining it from the coarsest
 * level down. All positions are level-0 pixels. Writes the result to `out` and
 * returns true, or returns false when the feature cannot be followed.
 */
export function lkPyr({
	from,
	to,
	x,
	y,
	guessX,
	guessY,
	options,
	workspace,
	out,
}: {
	from: Pyramid;
	to: Pyramid;
	x: number;
	y: number;
	guessX: number;
	guessY: number;
	options: LkOptions;
	workspace: LkWorkspace;
	out: LkResult;
}): boolean {
	if (options.half !== workspace.half) {
		throw new RangeError(`workspace was made for half ${workspace.half}, options ask for ${options.half}`);
	}
	let px = guessX;
	let py = guessY;
	let res = 0;
	for (let l = from.levels.length - 1; l >= 0; l--) {
		const s = 1 / (1 << l);
		const ok = lkLevel({
			from: from.levels[l],
			to: to.levels[l],
			ax: x * s,
			ay: y * s,
			bx: px * s,
			by: py * s,
			options,
			ws: workspace,
		});
		if (!ok) return false;
		px = workspace.x / s;
		py = workspace.y / s;
		res = workspace.res;
	}
	out.x = px;
	out.y = py;
	out.res = res;
	return true;
}
