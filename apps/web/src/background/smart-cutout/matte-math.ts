import { SCENE_CUT_THRESHOLD } from "./constants";

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export type Letterbox = {
	/** Side of the square model input. */
	size: number;
	/** The picture inside the square: offset and size in model pixels. */
	x: number;
	y: number;
	width: number;
	height: number;
};

/** Where a picture of `width` x `height` goes inside the `size` x `size` model input (aspect kept, centred). */
export function letterboxLayout({
	width,
	height,
	size,
}: {
	width: number;
	height: number;
	size: number;
}): Letterbox {
	const scale = Math.min(size / width, size / height);
	const w = Math.max(1, Math.min(size, Math.round(width * scale)));
	const h = Math.max(1, Math.min(size, Math.round(height * scale)));
	return { size, x: Math.floor((size - w) / 2), y: Math.floor((size - h) / 2), width: w, height: h };
}

/** RGBA pixels of the letterboxed square -> the model's input: float32 CHW, ImageNet-normalised. */
export function rgbaToTensor({ rgba, size }: { rgba: Uint8ClampedArray; size: number }): Float32Array {
	const plane = size * size;
	const tensor = new Float32Array(3 * plane);
	for (let index = 0; index < plane; index++) {
		for (let channel = 0; channel < 3; channel++) {
			const value = (rgba[index * 4 + channel] ?? 0) / 255;
			tensor[channel * plane + index] = (value - (MEAN[channel] ?? 0)) / (STD[channel] ?? 1);
		}
	}
	return tensor;
}

/**
 * The model's first output (size x size, any range) -> an 8-bit matte of just the picture area
 * (the letterbox bars are cut off), min-max scaled. A flat output is "keep nothing".
 */
export function outputToMatte({
	output,
	box,
}: {
	output: Float32Array;
	box: Letterbox;
}): Uint8Array {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	const matte = new Uint8Array(box.width * box.height);
	for (let y = 0; y < box.height; y++) {
		for (let x = 0; x < box.width; x++) {
			const value = output[(y + box.y) * box.size + (x + box.x)] ?? 0;
			if (value < min) min = value;
			if (value > max) max = value;
		}
	}
	const range = max - min;
	if (!(range > 1e-9)) return matte;
	for (let y = 0; y < box.height; y++) {
		for (let x = 0; x < box.width; x++) {
			const value = output[(y + box.y) * box.size + (x + box.x)] ?? 0;
			matte[y * box.width + x] = Math.round(((value - min) / range) * 255);
		}
	}
	return matte;
}

/** current * alpha + previous * (1 - alpha), in place on a copy of `current`. */
export function smoothMatte({
	previous,
	current,
	alpha,
}: {
	previous: Uint8Array | null;
	current: Uint8Array;
	alpha: number;
}): Uint8Array {
	if (!previous || previous.length !== current.length) return current;
	const out = new Uint8Array(current.length);
	for (let index = 0; index < current.length; index++) {
		out[index] = Math.round((current[index] ?? 0) * alpha + (previous[index] ?? 0) * (1 - alpha));
	}
	return out;
}

/** Mean luma (0..1) of a small RGBA square, sampled on a coarse grid: the scene-cut fingerprint. */
export function lumaFingerprint({ rgba, size, grid = 16 }: { rgba: Uint8ClampedArray; size: number; grid?: number }): Float32Array {
	const out = new Float32Array(grid * grid);
	for (let gy = 0; gy < grid; gy++) {
		for (let gx = 0; gx < grid; gx++) {
			const x = Math.min(size - 1, Math.floor(((gx + 0.5) * size) / grid));
			const y = Math.min(size - 1, Math.floor(((gy + 0.5) * size) / grid));
			const i = (y * size + x) * 4;
			out[gy * grid + gx] = (0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0)) / 255;
		}
	}
	return out;
}

export function isSceneCut({
	previous,
	current,
	threshold = SCENE_CUT_THRESHOLD,
}: {
	previous: Float32Array | null;
	current: Float32Array;
	threshold?: number;
}): boolean {
	if (!previous || previous.length !== current.length) return false;
	let total = 0;
	for (let index = 0; index < current.length; index++) total += Math.abs((current[index] ?? 0) - (previous[index] ?? 0));
	return total / current.length > threshold;
}

/** Linear blend of two mattes of the same size (t = 0 gives `a`). */
export function blendMattes({ a, b, t }: { a: Uint8Array; b: Uint8Array; t: number }): Uint8Array {
	if (a.length !== b.length) return a;
	const out = new Uint8Array(a.length);
	for (let index = 0; index < a.length; index++) {
		out[index] = Math.round((a[index] ?? 0) * (1 - t) + (b[index] ?? 0) * t);
	}
	return out;
}
