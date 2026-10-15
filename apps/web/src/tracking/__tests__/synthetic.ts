import type { GrayFrame } from "@/tracking/types";

function hash({ ix, iy, seed }: { ix: number; iy: number; seed: number }) {
	let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
	h += Math.imul(seed, 1442695041);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

function smooth(t: number) {
	return t * t * (3 - 2 * t);
}

function valueNoise({ x, y, seed }: { x: number; y: number; seed: number }) {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = smooth(x - ix);
	const fy = smooth(y - iy);
	const a = hash({ ix, iy, seed });
	const b = hash({ ix: ix + 1, iy, seed });
	const c = hash({ ix, iy: iy + 1, seed });
	const d = hash({ ix: ix + 1, iy: iy + 1, seed });
	return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Smooth, textured, infinite scene: it can be sampled at any sub-pixel position. */
export function sceneValue({
	x,
	y,
	variant = 0,
}: {
	x: number;
	y: number;
	variant?: number;
}): number {
	const seed = variant * 10;
	return (
		128 +
		120 * (valueNoise({ x: x / 6, y: y / 6, seed: seed + 1 }) - 0.5) +
		60 * (valueNoise({ x: x / 13, y: y / 13, seed: seed + 2 }) - 0.5) +
		40 * (valueNoise({ x: x / 3, y: y / 3, seed: seed + 3 }) - 0.5)
	);
}

function toByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * The scene moved by (dx, dy) pixels, optionally with a gain and brightness
 * offset. `morph` (0..1) cross-fades it into a different scene, the way a
 * surface slowly changes its look.
 */
export function renderFrame({
	w,
	h,
	dx = 0,
	dy = 0,
	gain = 1,
	offset = 0,
	morph = 0,
}: {
	w: number;
	h: number;
	dx?: number;
	dy?: number;
	gain?: number;
	offset?: number;
	morph?: number;
}): GrayFrame {
	const data = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const value =
				morph === 0
					? sceneValue({ x: x - dx, y: y - dy })
					: (1 - morph) * sceneValue({ x: x - dx, y: y - dy }) +
						morph * sceneValue({ x: x - dx, y: y - dy, variant: 1 });
			data[y * w + x] = toByte(value * gain + offset);
		}
	}
	return { w, h, data };
}
