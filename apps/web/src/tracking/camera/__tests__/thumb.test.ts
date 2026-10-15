import { beforeAll, describe, expect, test } from "bun:test";
import { makeWorld, renderPose, type World } from "../camera-synth";
import { makeThumb, THUMB_H, THUMB_W, thumbNcc } from "../thumb";

let world: World;
let otherWorld: World;

beforeAll(() => {
	world = makeWorld({ width: 1000, height: 800, seed: 31 });
	otherWorld = makeWorld({ width: 1000, height: 800, seed: 32 });
});

function thumbOfWorld({ source, dx = 0 }: { source: World; dx?: number }) {
	const frame = renderPose({
		world: source,
		pose: { s: 1, theta: 0, dx, dy: 0, wcx: 500, wcy: 400 },
		width: 480,
		height: 270,
	});
	return makeThumb({ gray: frame.data, w: 480, h: 270 });
}

describe("makeThumb", () => {
	test("is 48 by 27 and averages each block", () => {
		const gray = new Uint8Array(480 * 270);
		for (let y = 0; y < 270; y++) {
			for (let x = 240; x < 480; x++) gray[y * 480 + x] = 200;
		}
		const thumb = makeThumb({ gray, w: 480, h: 270 });
		expect(THUMB_W).toBe(48);
		expect(THUMB_H).toBe(27);
		expect(thumb.length).toBe(48 * 27);
		for (let y = 0; y < 27; y++) {
			expect(thumb[y * 48 + 23]).toBe(0);
			expect(thumb[y * 48 + 24]).toBe(200);
		}
	});

	test("a block that straddles an edge gets the mean of its pixels", () => {
		const gray = new Uint8Array(480 * 270);
		for (let y = 0; y < 270; y++) {
			for (let x = 5; x < 480; x++) gray[y * 480 + x] = 100;
		}
		// block 0 covers x 0..9: five dark and five bright columns
		expect(makeThumb({ gray, w: 480, h: 270 })[0]).toBeCloseTo(50, 4);
	});

	test("writes into the buffer it is given", () => {
		const out = new Float32Array(48 * 27);
		const result = makeThumb({ gray: new Uint8Array(480 * 270).fill(9), w: 480, h: 270, out });
		expect(result).toBe(out);
		expect(out[100]).toBe(9);
	});

	test("copes with sizes that are not a multiple of the grid", () => {
		const thumb = makeThumb({ gray: new Uint8Array(101 * 53).fill(77), w: 101, h: 53 });
		expect(thumb.length).toBe(48 * 27);
		for (const v of thumb) expect(v).toBeCloseTo(77, 4);
	});
});

describe("thumbNcc", () => {
	test("a thumbnail matches itself perfectly", () => {
		const a = thumbOfWorld({ source: world });
		expect(thumbNcc({ a, b: a })).toBeCloseTo(1, 5);
	});

	test("is not fooled by a brightness change", () => {
		const a = thumbOfWorld({ source: world });
		const b = a.map((v) => v * 0.8 + 30);
		expect(thumbNcc({ a, b })).toBeCloseTo(1, 4);
	});

	test("finds the same scene shifted by a few thumbnail pixels", () => {
		const a = thumbOfWorld({ source: world });
		const b = thumbOfWorld({ source: world, dx: 30 });
		expect(thumbNcc({ a, b })).toBeGreaterThan(0.85);
		// beyond the search radius the scenes no longer overlap enough to match
		const far = thumbOfWorld({ source: world, dx: 140 });
		expect(thumbNcc({ a, b: far, radius: 6 })).toBeLessThan(0.6);
	});

	test("two different scenes score below the cut threshold", () => {
		const a = thumbOfWorld({ source: world });
		const b = thumbOfWorld({ source: otherWorld });
		expect(thumbNcc({ a, b })).toBeLessThan(0.45);
	});

	test("a flat thumbnail never matches anything", () => {
		const a = thumbOfWorld({ source: world });
		const flat = new Float32Array(48 * 27).fill(100);
		expect(thumbNcc({ a, b: flat })).toBe(-1);
		expect(thumbNcc({ a: flat, b: flat })).toBe(-1);
	});
});
