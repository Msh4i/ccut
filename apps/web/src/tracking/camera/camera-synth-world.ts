/**
 * The textured "world" image the synthetic cameras look at: octaves of value
 * noise plus random rectangles, discs and bars. Deterministic for a seed.
 */
import { createRng } from "./random";

export interface World {
	/** Gray levels 0..255 as floats, row-major. */
	data: Float32Array;
	width: number;
	height: number;
}

function addNoiseOctave({
	img,
	width,
	height,
	cell,
	amp,
	random,
}: {
	img: Float32Array;
	width: number;
	height: number;
	cell: number;
	amp: number;
	random: () => number;
}): void {
	const gw = Math.ceil(width / cell) + 2;
	const gh = Math.ceil(height / cell) + 2;
	const lattice = new Float32Array(gw * gh);
	for (let i = 0; i < lattice.length; i++) lattice[i] = random() * 2 - 1;
	for (let y = 0; y < height; y++) {
		const fy = y / cell;
		const iy = Math.floor(fy);
		const ty = fy - iy;
		const sy = ty * ty * (3 - 2 * ty);
		for (let x = 0; x < width; x++) {
			const fx = x / cell;
			const ix = Math.floor(fx);
			const tx = fx - ix;
			const sx = tx * tx * (3 - 2 * tx);
			const a = lattice[iy * gw + ix];
			const b = lattice[iy * gw + ix + 1];
			const c = lattice[(iy + 1) * gw + ix];
			const d = lattice[(iy + 1) * gw + ix + 1];
			img[y * width + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
		}
	}
}

function fillShapes({
	img,
	width,
	height,
	count,
	random,
	ampLo,
	ampHi,
	maxSize,
}: {
	img: Float32Array;
	width: number;
	height: number;
	count: number;
	random: () => number;
	ampLo: number;
	ampHi: number;
	maxSize: number;
}): void {
	for (let k = 0; k < count; k++) {
		const kind = random();
		const cx = random() * width;
		const cy = random() * height;
		const size = 6 + random() * random() * maxSize;
		const delta = (random() < 0.5 ? -1 : 1) * (ampLo + random() * (ampHi - ampLo));
		const x0 = Math.max(0, Math.floor(cx - size));
		const x1 = Math.min(width - 1, Math.ceil(cx + size));
		const y0 = Math.max(0, Math.floor(cy - size));
		const y1 = Math.min(height - 1, Math.ceil(cy + size));
		if (kind < 0.45) {
			const hw = size * (0.3 + random());
			const hh = size * (0.3 + random());
			const ang = random() * Math.PI;
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const dx = x - cx;
					const dy = y - cy;
					const u = dx * c + dy * s;
					const v = -dx * s + dy * c;
					if (Math.abs(u) < hw && Math.abs(v) < hh) img[y * width + x] += delta;
				}
			}
		} else if (kind < 0.8) {
			const rr = size * 0.6;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const dx = x - cx;
					const dy = y - cy;
					if (dx * dx + dy * dy < rr * rr) img[y * width + x] += delta;
				}
			}
		} else {
			// a thin bar
			const ang = random() * Math.PI;
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			const len = size * 1.5;
			const th = 1.5 + random() * 3;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const dx = x - cx;
					const dy = y - cy;
					const u = dx * c + dy * s;
					const v = -dx * s + dy * c;
					if (Math.abs(u) < len && Math.abs(v) < th) img[y * width + x] += delta * 1.3;
				}
			}
		}
	}
}

/**
 * A natural-looking texture: octaves of value noise from 256 px cells down to
 * 2 px, plus random rectangles, discs and bars (corners and edges). `texture`
 * (0..1) scales all the detail; around 0.06 almost nothing is left to follow.
 */
export function makeWorld({
	width,
	height,
	seed,
	texture = 1,
	shapes = 700,
	maxSize = 160,
	minCell = 2,
}: {
	width: number;
	height: number;
	seed: number;
	texture?: number;
	shapes?: number;
	maxSize?: number;
	minCell?: number;
}): World {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new RangeError(`world size must be positive integers, got ${width}x${height}`);
	}
	const random = createRng({ seed });
	const img = new Float32Array(width * height).fill(128);
	const cells = [256, 128, 64, 32, 16, 8, 4, 2].filter((c) => c >= minCell);
	const amps = [22, 18, 14, 12, 11, 10, 9, 8];
	for (let i = 0; i < cells.length; i++) {
		addNoiseOctave({ img, width, height, cell: cells[i], amp: texture * amps[i], random });
	}
	fillShapes({
		img,
		width,
		height,
		count: Math.round(shapes * texture),
		random,
		ampLo: 10,
		ampHi: 40,
		maxSize,
	});
	for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(255, img[i]));
	return { data: img, width, height };
}
