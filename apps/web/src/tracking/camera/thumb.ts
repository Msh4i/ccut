/** Thumbnail size used for the scene cut test, whatever the frame size. */
export const THUMB_W = 48;
export const THUMB_H = 27;

/** Block-averages a gray frame down to 48 x 27. */
export function makeThumb({
	gray,
	w,
	h,
	out,
}: {
	gray: ArrayLike<number>;
	w: number;
	h: number;
	out?: Float32Array;
}): Float32Array {
	const thumb = out ?? new Float32Array(THUMB_W * THUMB_H);
	const bx = w / THUMB_W;
	const by = h / THUMB_H;
	for (let ty = 0; ty < THUMB_H; ty++) {
		const y0 = Math.floor(ty * by);
		const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * by));
		for (let tx = 0; tx < THUMB_W; tx++) {
			const x0 = Math.floor(tx * bx);
			const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * bx));
			let sum = 0;
			let count = 0;
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					sum += gray[y * w + x];
					count++;
				}
			}
			thumb[ty * THUMB_W + tx] = sum / count;
		}
	}
	return thumb;
}

/**
 * Best zero-mean normalised cross-correlation between two thumbnails over all
 * shifts within `radius` thumbnail pixels (6 by default), in [-1, 1]. -1 when
 * no shift leaves enough overlap or the overlapping parts are flat.
 */
export function thumbNcc({
	a,
	b,
	radius = 6,
}: {
	a: Float32Array;
	b: Float32Array;
	radius?: number;
}): number {
	let best = -1;
	for (let sy = -radius; sy <= radius; sy++) {
		for (let sx = -radius; sx <= radius; sx++) {
			let n = 0;
			let sa = 0;
			let sb = 0;
			let saa = 0;
			let sbb = 0;
			let sab = 0;
			const yEnd = Math.min(THUMB_H, THUMB_H - sy);
			const xEnd = Math.min(THUMB_W, THUMB_W - sx);
			for (let y = Math.max(0, -sy); y < yEnd; y++) {
				for (let x = Math.max(0, -sx); x < xEnd; x++) {
					const va = a[y * THUMB_W + x];
					const vb = b[(y + sy) * THUMB_W + x + sx];
					n++;
					sa += va;
					sb += vb;
					saa += va * va;
					sbb += vb * vb;
					sab += va * vb;
				}
			}
			if (n < 200) continue;
			const cov = sab - (sa * sb) / n;
			const va = saa - (sa * sa) / n;
			const vb = sbb - (sb * sb) / n;
			if (va < 1e-6 || vb < 1e-6) continue;
			const r = cov / Math.sqrt(va * vb);
			if (r > best) best = r;
		}
	}
	return best;
}
