import { describe, expect, test } from "bun:test";
import { allocPyramid, fillPyramid } from "../pyramid";

function ramp({
	w,
	h,
	ax,
	ay,
}: {
	w: number;
	h: number;
	ax: number;
	ay: number;
}): Float32Array {
	const data = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) data[y * w + x] = ax * x + ay * y;
	}
	return data;
}

describe("allocPyramid", () => {
	test("each level halves the size, rounding down", () => {
		const { levels } = allocPyramid({ w: 480, h: 270, levels: 3 });
		expect(levels.map((l) => [l.w, l.h])).toEqual([
			[480, 270],
			[240, 135],
			[120, 67],
		]);
		for (const l of levels) {
			expect(l.I.length).toBe(l.w * l.h);
			expect(l.Ix.length).toBe(l.w * l.h);
			expect(l.Iy.length).toBe(l.w * l.h);
		}
	});

	test("rejects sizes it cannot build", () => {
		expect(() => allocPyramid({ w: 480, h: 270, levels: 0 })).toThrow();
		expect(() => allocPyramid({ w: 0, h: 270, levels: 3 })).toThrow();
		expect(() => allocPyramid({ w: 480, h: 270, levels: 12 })).toThrow();
	});
});

describe("fillPyramid", () => {
	test("level 0 is the input and a constant image has no gradient anywhere", () => {
		const pyramid = allocPyramid({ w: 64, h: 48, levels: 3 });
		fillPyramid({ pyramid, gray: new Uint8Array(64 * 48).fill(90) });
		for (const l of pyramid.levels) {
			for (let i = 0; i < l.I.length; i++) {
				expect(l.I[i]).toBeCloseTo(90, 4);
				expect(l.Ix[i]).toBe(0);
				expect(l.Iy[i]).toBe(0);
			}
		}
	});

	test("a linear ramp keeps its exact slope in the Scharr gradient", () => {
		const pyramid = allocPyramid({ w: 64, h: 48, levels: 1 });
		fillPyramid({ pyramid, gray: ramp({ w: 64, h: 48, ax: 2, ay: 0.5 }) });
		const l = pyramid.levels[0];
		for (let y = 2; y < 46; y++) {
			for (let x = 2; x < 62; x++) {
				expect(l.Ix[y * 64 + x]).toBeCloseTo(2, 4);
				expect(l.Iy[y * 64 + x]).toBeCloseTo(0.5, 4);
			}
		}
	});

	test("the slope per pixel doubles on every coarser level", () => {
		const pyramid = allocPyramid({ w: 128, h: 96, levels: 3 });
		fillPyramid({ pyramid, gray: ramp({ w: 128, h: 96, ax: 1, ay: 0.25 }) });
		for (const [level, factor] of [
			[1, 2],
			[2, 4],
		] as const) {
			const l = pyramid.levels[level];
			for (let y = 6; y < l.h - 6; y++) {
				for (let x = 6; x < l.w - 6; x++) {
					expect(l.Ix[y * l.w + x]).toBeCloseTo(1 * factor, 3);
					expect(l.Iy[y * l.w + x]).toBeCloseTo(0.25 * factor, 3);
				}
			}
		}
	});

	test("the gradient points toward brighter pixels (sign check on a vertical edge)", () => {
		const gray = new Uint8Array(32 * 32);
		for (let y = 0; y < 32; y++) {
			for (let x = 16; x < 32; x++) gray[y * 32 + x] = 200;
		}
		const pyramid = allocPyramid({ w: 32, h: 32, levels: 1 });
		fillPyramid({ pyramid, gray });
		const l = pyramid.levels[0];
		expect(l.Ix[10 * 32 + 15]).toBeGreaterThan(50);
		expect(l.Ix[10 * 32 + 16]).toBeGreaterThan(50);
		expect(l.Ix[10 * 32 + 5]).toBe(0);
		expect(Math.abs(l.Iy[10 * 32 + 15])).toBe(0);
	});

	test("filling again replaces everything, nothing is left from the last image", () => {
		const pyramid = allocPyramid({ w: 40, h: 30, levels: 3 });
		fillPyramid({ pyramid, gray: ramp({ w: 40, h: 30, ax: 3, ay: 1 }) });
		fillPyramid({ pyramid, gray: new Uint8Array(40 * 30).fill(7) });
		for (const l of pyramid.levels) {
			expect(Math.max(...l.Ix)).toBe(0);
			expect(Math.min(...l.Ix)).toBe(0);
			expect(Math.max(...l.I)).toBeCloseTo(7, 4);
			expect(Math.min(...l.I)).toBeCloseTo(7, 4);
		}
	});

	test("rejects an image that does not fit the pyramid", () => {
		const pyramid = allocPyramid({ w: 64, h: 48, levels: 3 });
		expect(() => fillPyramid({ pyramid, gray: new Uint8Array(64 * 47) })).toThrow();
	});
});
