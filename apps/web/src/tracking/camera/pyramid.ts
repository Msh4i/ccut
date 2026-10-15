/** One level of the image pyramid: intensities and their Scharr gradient. */
export interface PyramidLevel {
	w: number;
	h: number;
	I: Float32Array;
	Ix: Float32Array;
	Iy: Float32Array;
}

export interface Pyramid {
	levels: PyramidLevel[];
	/** Room for the horizontal pass of the blur, sized for the biggest level. */
	scratch: Float32Array;
}

const MAX_LEVELS = 8;

/** A pyramid of `levels` levels, each half the size of the one before (rounded down). */
export function allocPyramid({
	w,
	h,
	levels,
}: {
	w: number;
	h: number;
	levels: number;
}): Pyramid {
	if (!Number.isInteger(levels) || levels < 1 || levels > MAX_LEVELS) {
		throw new RangeError(`pyramid levels must be 1..${MAX_LEVELS}, got ${levels}`);
	}
	if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
		throw new RangeError(`pyramid size must be positive integers, got ${w}x${h}`);
	}
	const out: PyramidLevel[] = [];
	let lw = w;
	let lh = h;
	for (let l = 0; l < levels; l++) {
		if (lw < 1 || lh < 1) throw new RangeError(`${w}x${h} is too small for ${levels} levels`);
		out.push({
			w: lw,
			h: lh,
			I: new Float32Array(lw * lh),
			Ix: new Float32Array(lw * lh),
			Iy: new Float32Array(lw * lh),
		});
		lw >>= 1;
		lh >>= 1;
	}
	return { levels: out, scratch: new Float32Array(w * h) };
}

/** Blurs with [1 4 6 4 1] / 16 in both directions and keeps every second pixel. */
function pyrDown({
	src,
	dst,
	scratch,
}: {
	src: PyramidLevel;
	dst: PyramidLevel;
	scratch: Float32Array;
}): void {
	const { w, h, I } = src;
	const dw = dst.w;
	const dh = dst.h;
	// horizontal pass, only at the even columns that survive
	for (let y = 0; y < h; y++) {
		const r = y * w;
		for (let x = 0; x < dw; x++) {
			const c = 2 * x;
			const xm2 = c - 2 < 0 ? 0 : c - 2;
			const xm1 = c - 1 < 0 ? 0 : c - 1;
			const xp1 = c + 1 >= w ? w - 1 : c + 1;
			const xp2 = c + 2 >= w ? w - 1 : c + 2;
			scratch[y * dw + x] =
				(I[r + xm2] + 4 * I[r + xm1] + 6 * I[r + c] + 4 * I[r + xp1] + I[r + xp2]) * (1 / 16);
		}
	}
	const out = dst.I;
	for (let y = 0; y < dh; y++) {
		const c = 2 * y;
		const ym2 = c - 2 < 0 ? 0 : c - 2;
		const ym1 = c - 1 < 0 ? 0 : c - 1;
		const yp1 = c + 1 >= h ? h - 1 : c + 1;
		const yp2 = c + 2 >= h ? h - 1 : c + 2;
		for (let x = 0; x < dw; x++) {
			out[y * dw + x] =
				(scratch[ym2 * dw + x] +
					4 * scratch[ym1 * dw + x] +
					6 * scratch[c * dw + x] +
					4 * scratch[yp1 * dw + x] +
					scratch[yp2 * dw + x]) *
				(1 / 16);
		}
	}
}

/** Scharr gradient scaled by 1/32, so a ramp of slope s gives exactly s. The one-pixel border stays 0. */
function scharr(level: PyramidLevel): void {
	const { w, h, I, Ix, Iy } = level;
	for (let y = 1; y < h - 1; y++) {
		const r0 = (y - 1) * w;
		const r1 = y * w;
		const r2 = (y + 1) * w;
		for (let x = 1; x < w - 1; x++) {
			const a = I[r0 + x - 1];
			const b = I[r0 + x];
			const c = I[r0 + x + 1];
			const d = I[r1 + x - 1];
			const f = I[r1 + x + 1];
			const g = I[r2 + x - 1];
			const hh = I[r2 + x];
			const i = I[r2 + x + 1];
			Ix[r1 + x] = (3 * (c - a) + 10 * (f - d) + 3 * (i - g)) * (1 / 32);
			Iy[r1 + x] = (3 * (g - a) + 10 * (hh - b) + 3 * (i - c)) * (1 / 32);
		}
	}
}

/** Loads a gray image into level 0 and rebuilds every level and gradient. */
export function fillPyramid({
	pyramid,
	gray,
}: {
	pyramid: Pyramid;
	gray: ArrayLike<number>;
}): void {
	const base = pyramid.levels[0];
	if (gray.length !== base.w * base.h) {
		throw new RangeError(`image has ${gray.length} pixels, the pyramid holds ${base.w * base.h}`);
	}
	for (let i = 0; i < gray.length; i++) base.I[i] = gray[i];
	for (let l = 1; l < pyramid.levels.length; l++) {
		pyrDown({ src: pyramid.levels[l - 1], dst: pyramid.levels[l], scratch: pyramid.scratch });
	}
	for (const level of pyramid.levels) scharr(level);
}
