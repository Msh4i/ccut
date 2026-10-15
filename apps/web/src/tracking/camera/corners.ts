import type { PyramidLevel } from "./pyramid";

/** Working memory for `minEigMap`, sized for one frame size. */
export interface CornerScratch {
	xx: Float32Array;
	xy: Float32Array;
	yy: Float32Array;
	rows: Float32Array;
	sxx: Float32Array;
	sxy: Float32Array;
	syy: Float32Array;
}

export function createCornerScratch({ w, h }: { w: number; h: number }): CornerScratch {
	const n = w * h;
	return {
		xx: new Float32Array(n),
		xy: new Float32Array(n),
		yy: new Float32Array(n),
		rows: new Float32Array(n),
		sxx: new Float32Array(n),
		sxy: new Float32Array(n),
		syy: new Float32Array(n),
	};
}

/**
 * Sums `src` over a `win` x `win` window (a box filter, not normalised) into
 * `dst`. Pixels closer than `win / 2` to the border are left at 0.
 */
function boxSum({
	src,
	dst,
	rows,
	w,
	h,
	win,
}: {
	src: Float32Array;
	dst: Float32Array;
	rows: Float32Array;
	w: number;
	h: number;
	win: number;
}): void {
	const hw = win >> 1;
	rows.fill(0);
	dst.fill(0);
	for (let y = 0; y < h; y++) {
		let s = 0;
		const r = y * w;
		for (let x = 0; x < Math.min(w, win); x++) s += src[r + x];
		for (let x = hw; x < w - hw; x++) {
			rows[r + x] = s;
			if (x + hw + 1 < w) s += src[r + x + hw + 1] - src[r + x - hw];
		}
	}
	for (let x = 0; x < w; x++) {
		let s = 0;
		for (let y = 0; y < Math.min(h, win); y++) s += rows[y * w + x];
		for (let y = hw; y < h - hw; y++) {
			dst[y * w + x] = s;
			if (y + hw + 1 < h) s += rows[(y + hw + 1) * w + x] - rows[(y - hw) * w + x];
		}
	}
}

/**
 * Shi-Tomasi corner measure: the smaller eigenvalue of the structure tensor
 * averaged over a `win` x `win` window (normalised by its area), per pixel of
 * `level`. High where the image changes in two directions, 0 on flat ground
 * and along a straight edge.
 */
export function minEigMap({
	level,
	win,
	out,
	scratch,
}: {
	level: PyramidLevel;
	win: number;
	out: Float32Array;
	scratch: CornerScratch;
}): Float32Array {
	const { w, h, Ix, Iy } = level;
	const n = w * h;
	const { xx, xy, yy, rows, sxx, sxy, syy } = scratch;
	for (let i = 0; i < n; i++) {
		const a = Ix[i];
		const b = Iy[i];
		xx[i] = a * a;
		xy[i] = a * b;
		yy[i] = b * b;
	}
	boxSum({ src: xx, dst: sxx, rows, w, h, win });
	boxSum({ src: xy, dst: sxy, rows, w, h, win });
	boxSum({ src: yy, dst: syy, rows, w, h, win });
	const inv = 1 / (win * win);
	for (let i = 0; i < n; i++) {
		const a = sxx[i] * inv;
		const b = sxy[i] * inv;
		const c = syy[i] * inv;
		out[i] = (a + c) / 2 - Math.sqrt(((a - c) / 2) * ((a - c) / 2) + b * b);
	}
	return out;
}

/** Which corners are kept when there are more candidates than room. */
export type BudgetOrder = "first" | "strongest";

export interface GridOptions {
	/** Side of a grid cell in px: at most one new feature per cell. */
	cell: number;
	/** Features keep this far from the frame edge. */
	margin: number;
	/** A corner must reach this share of the frame's best corner measure ... */
	quality: number;
	/** ... and at least this absolute value. */
	absMin: number;
	/** New features keep this far from every live and new feature. */
	minDist: number;
	/** Live plus new features never exceed this. */
	maxFeatures: number;
	/**
	 * One pass adds at most this share of the room left under `maxFeatures`
	 * (rounded up). 1 fills it at once. The measurements in the plan ran with
	 * 0.5, which came from counting every new feature twice in the prototype:
	 * the first frame got half the features and later passes closed the gap.
	 */
	seedShare: number;
	/**
	 * With more candidates than room: "first" keeps the first ones in scan order
	 * (rows from the top, what the prototype did, and why a tall frame got
	 * features in its top rows only), "strongest" keeps the strongest corners.
	 */
	budgetOrder: BudgetOrder;
}

/**
 * Picks the strongest corner of every grid cell that holds no live feature yet.
 * `live` is the interleaved `x, y` of the features already followed. Returns the
 * new features as interleaved integer pixel indices (pixel `i` is at `x = i`),
 * in scan order, at most `ceil((maxFeatures - live) * seedShare)` of them.
 */
export function selectGridCorners({
	eig,
	w,
	h,
	options,
	live,
}: {
	eig: Float32Array;
	w: number;
	h: number;
	options: GridOptions;
	live: ArrayLike<number>;
}): number[] {
	const { cell, margin, quality, absMin, minDist, maxFeatures, seedShare, budgetOrder } = options;
	const gw = Math.ceil(w / cell);
	const gh = Math.ceil(h / cell);
	const occupied = new Uint8Array(gw * gh);
	const taken: number[] = [];
	for (let i = 0; i < live.length; i += 2) {
		taken.push(live[i], live[i + 1]);
		const gx = Math.min(gw - 1, Math.floor(live[i] / cell));
		const gy = Math.min(gh - 1, Math.floor(live[i + 1] / cell));
		occupied[gy * gw + gx] = 1;
	}
	let best = 0;
	for (let i = 0; i < eig.length; i++) if (eig[i] > best) best = eig[i];
	const threshold = Math.max(quality * best, absMin);
	const minDist2 = minDist * minDist;
	const room = maxFeatures - live.length / 2;
	if (room <= 0) return [];
	const maxNew = Math.ceil(room * seedShare);
	const picked: number[] = [];
	const strength: number[] = [];
	for (let gy = 0; gy < gh; gy++) {
		for (let gx = 0; gx < gw; gx++) {
			if (occupied[gy * gw + gx]) continue;
			if (budgetOrder === "first" && picked.length / 2 >= maxNew) return picked;
			const x0 = Math.max(margin, gx * cell);
			const x1 = Math.min(w - 1 - margin, (gx + 1) * cell - 1);
			const y0 = Math.max(margin, gy * cell);
			const y1 = Math.min(h - 1 - margin, (gy + 1) * cell - 1);
			let top = threshold;
			let bx = -1;
			let by = -1;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const v = eig[y * w + x];
					if (v > top) {
						top = v;
						bx = x;
						by = y;
					}
				}
			}
			if (bx < 0) continue;
			let clear = true;
			for (let i = 0; i < taken.length; i += 2) {
				const dx = taken[i] - bx;
				const dy = taken[i + 1] - by;
				if (dx * dx + dy * dy < minDist2) {
					clear = false;
					break;
				}
			}
			if (!clear) continue;
			picked.push(bx, by);
			strength.push(top);
			taken.push(bx, by);
		}
	}
	const count = picked.length / 2;
	if (count <= maxNew) return picked;
	// more candidates than room: keep the strongest, hand them back in scan order
	const order = Array.from({ length: count }, (_, i) => i).sort(
		(a, b) => strength[b] - strength[a] || a - b,
	);
	const kept = order.slice(0, maxNew).sort((a, b) => a - b);
	const out: number[] = [];
	for (const i of kept) out.push(picked[2 * i], picked[2 * i + 1]);
	return out;
}
