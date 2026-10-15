import { describe, expect, test } from "bun:test";
import {
	createCornerScratch,
	minEigMap,
	selectGridCorners,
	type GridOptions,
} from "../corners";
import { allocPyramid, fillPyramid } from "../pyramid";

const W = 96;
const H = 96;

/** Dark frame with bright rectangles `[x0, x1) x [y0, y1)` of the given gray level. */
function rectangles(
	rects: { x0: number; y0: number; x1: number; y1: number; value: number }[],
): Uint8Array {
	const gray = new Uint8Array(W * H).fill(40);
	for (const r of rects) {
		for (let y = r.y0; y < r.y1; y++) {
			for (let x = r.x0; x < r.x1; x++) gray[y * W + x] = r.value;
		}
	}
	return gray;
}

function eigOf(gray: Uint8Array): Float32Array {
	const pyramid = allocPyramid({ w: W, h: H, levels: 1 });
	fillPyramid({ pyramid, gray });
	const out = new Float32Array(W * H);
	minEigMap({
		level: pyramid.levels[0],
		win: 5,
		out,
		scratch: createCornerScratch({ w: W, h: H }),
	});
	return out;
}

const SQUARE = rectangles([{ x0: 30, y0: 30, x1: 66, y1: 66, value: 200 }]);

const OPTIONS: GridOptions = {
	cell: 36,
	margin: 10,
	quality: 0.003,
	absMin: 4,
	minDist: 9,
	maxFeatures: 110,
	seedShare: 1,
	budgetOrder: "first",
};

function pairs(flat: number[]): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
	return out;
}

describe("minEigMap", () => {
	test("is zero on flat ground and on a straight edge, large on a corner", () => {
		const eig = eigOf(SQUARE);
		expect(eig[10 * W + 10]).toBe(0);
		// middle of the top edge: gradient in one direction only
		expect(eig[30 * W + 48]).toBeLessThan(1e-3);
		// the corner
		let corner = 0;
		for (let y = 28; y <= 32; y++) {
			for (let x = 28; x <= 32; x++) corner = Math.max(corner, eig[y * W + x]);
		}
		expect(corner).toBeGreaterThan(300);
	});

	test("scales with the square of the contrast", () => {
		const strong = eigOf(rectangles([{ x0: 30, y0: 30, x1: 66, y1: 66, value: 200 }]));
		const weak = eigOf(rectangles([{ x0: 30, y0: 30, x1: 66, y1: 66, value: 120 }]));
		const peak = (eig: Float32Array) => Math.max(...eig);
		expect(peak(weak) / peak(strong)).toBeCloseTo((80 / 160) ** 2, 2);
	});

	test("a frame that has not changed gives the same map, and reusing the scratch does not leak", () => {
		const pyramid = allocPyramid({ w: W, h: H, levels: 1 });
		const scratch = createCornerScratch({ w: W, h: H });
		const first = new Float32Array(W * H);
		const second = new Float32Array(W * H);
		fillPyramid({ pyramid, gray: SQUARE });
		minEigMap({ level: pyramid.levels[0], win: 5, out: first, scratch });
		fillPyramid({
			pyramid,
			gray: rectangles([{ x0: 10, y0: 50, x1: 40, y1: 80, value: 230 }]),
		});
		minEigMap({ level: pyramid.levels[0], win: 5, out: second, scratch });
		fillPyramid({ pyramid, gray: SQUARE });
		minEigMap({ level: pyramid.levels[0], win: 5, out: second, scratch });
		expect(Array.from(second)).toEqual(Array.from(first));
	});
});

describe("selectGridCorners", () => {
	test("picks the four corners of a square, one per grid cell, nothing on the edges", () => {
		const picks = pairs(
			selectGridCorners({ eig: eigOf(SQUARE), w: W, h: H, options: OPTIONS, live: [] }),
		);
		expect(picks.length).toBe(4);
		for (const [cx, cy] of [
			[30, 30],
			[65, 30],
			[30, 65],
			[65, 65],
		]) {
			expect(picks.some((p) => Math.abs(p.x - cx) <= 2 && Math.abs(p.y - cy) <= 2)).toBe(true);
		}
	});

	test("keeps off the frame border", () => {
		const gray = rectangles([{ x0: 2, y0: 2, x1: 40, y1: 40, value: 220 }]);
		const picks = pairs(
			selectGridCorners({ eig: eigOf(gray), w: W, h: H, options: OPTIONS, live: [] }),
		);
		for (const p of picks) {
			expect(p.x).toBeGreaterThanOrEqual(OPTIONS.margin);
			expect(p.y).toBeGreaterThanOrEqual(OPTIONS.margin);
			expect(p.x).toBeLessThanOrEqual(W - 1 - OPTIONS.margin);
			expect(p.y).toBeLessThanOrEqual(H - 1 - OPTIONS.margin);
		}
	});

	test("does not seed a cell that already holds a live feature", () => {
		const picks = pairs(
			selectGridCorners({
				eig: eigOf(SQUARE),
				w: W,
				h: H,
				options: OPTIONS,
				live: [20, 20],
			}),
		);
		expect(picks.length).toBe(3);
		expect(picks.every((p) => !(p.x < 36 && p.y < 36))).toBe(true);
	});

	test("keeps new features at least minDist away from each other and from live ones", () => {
		const tiny = rectangles([{ x0: 34, y0: 50, x1: 40, y1: 56, value: 220 }]);
		const eig = eigOf(tiny);
		const crowded = pairs(selectGridCorners({ eig, w: W, h: H, options: OPTIONS, live: [] }));
		const loose = pairs(
			selectGridCorners({ eig, w: W, h: H, options: { ...OPTIONS, minDist: 1 }, live: [] }),
		);
		expect(crowded.length).toBe(1);
		expect(loose.length).toBe(2);
		// A live feature sits in cell (0, 1); cell (1, 1) is free but too close to
		// it, so only minDist can be what blocks the new corner there.
		const live = [crowded[0].x, crowded[0].y];
		const blockedByLive = selectGridCorners({ eig, w: W, h: H, options: OPTIONS, live });
		const freeOfLive = selectGridCorners({
			eig,
			w: W,
			h: H,
			options: { ...OPTIONS, minDist: 1 },
			live,
		});
		expect(blockedByLive.length).toBe(0);
		expect(freeOfLive.length).toBe(2);
	});

	test("stops at maxFeatures, counting the live features", () => {
		const base = { eig: eigOf(SQUARE), w: W, h: H };
		const two = selectGridCorners({ ...base, options: { ...OPTIONS, maxFeatures: 2 }, live: [] });
		expect(two.length).toBe(4);
		const one = selectGridCorners({
			...base,
			options: { ...OPTIONS, maxFeatures: 2 },
			live: [80, 80],
		});
		expect(one.length).toBe(2);
		const none = selectGridCorners({
			...base,
			options: { ...OPTIONS, maxFeatures: 1 },
			live: [80, 80],
		});
		expect(none.length).toBe(0);
	});

	test("one pass adds only a share of the room left, rounded up", () => {
		const base = { eig: eigOf(SQUARE), w: W, h: H };
		const half = { ...OPTIONS, maxFeatures: 4, seedShare: 0.5 };
		expect(pairs(selectGridCorners({ ...base, options: half, live: [] })).length).toBe(2);
		// one live feature leaves a room of 3: half of that, rounded up, is 2
		expect(
			pairs(selectGridCorners({ ...base, options: half, live: [80, 80] })).length,
		).toBe(2);
		expect(
			pairs(selectGridCorners({ ...base, options: { ...half, maxFeatures: 2 }, live: [80, 80] })).length,
		).toBe(1);
		expect(pairs(selectGridCorners({ ...base, options: { ...half, seedShare: 1 }, live: [] })).length).toBe(4);
	});

	test("over budget, the strongest corners are kept, not the first ones in scan order", () => {
		const gray = rectangles([
			{ x0: 12, y0: 12, x1: 28, y1: 28, value: 90 },
			{ x0: 48, y0: 48, x1: 64, y1: 64, value: 220 },
			{ x0: 12, y0: 48, x1: 28, y1: 64, value: 140 },
		]);
		const eig = eigOf(gray);
		const base = { eig, w: W, h: H, live: [] };
		const first = pairs(selectGridCorners({ ...base, options: { ...OPTIONS, maxFeatures: 2, budgetOrder: "first" } }));
		const strongest = pairs(
			selectGridCorners({ ...base, options: { ...OPTIONS, maxFeatures: 2, budgetOrder: "strongest" } }),
		);
		// scan order meets the weak square first; strength order keeps the 220 and the 140 ones
		expect(first.length).toBe(2);
		expect(first.some((p) => p.x < 36 && p.y < 36)).toBe(true);
		expect(strongest.length).toBe(2);
		expect(strongest.every((p) => p.y >= 36)).toBe(true);
		expect(strongest.some((p) => p.x >= 36)).toBe(true);
		// within budget both orders agree
		const all = { ...OPTIONS, maxFeatures: 110 };
		expect(selectGridCorners({ ...base, options: { ...all, budgetOrder: "strongest" } })).toEqual(
			selectGridCorners({ ...base, options: { ...all, budgetOrder: "first" } }),
		);
	});

	test("what is returned stays in scan order whichever way it was chosen", () => {
		const gray = rectangles([
			{ x0: 12, y0: 12, x1: 28, y1: 28, value: 90 },
			{ x0: 48, y0: 12, x1: 64, y1: 28, value: 120 },
			{ x0: 48, y0: 48, x1: 64, y1: 64, value: 220 },
		]);
		const picks = pairs(
			selectGridCorners({
				eig: eigOf(gray),
				w: W,
				h: H,
				options: { ...OPTIONS, maxFeatures: 2, budgetOrder: "strongest" },
				live: [],
			}),
		);
		expect(picks.length).toBe(2);
		expect(picks[1].y * W + picks[1].x).toBeGreaterThan(picks[0].y * W + picks[0].x);
	});

	test("quality is relative to the best corner, absMin is absolute", () => {
		const two = rectangles([
			{ x0: 20, y0: 20, x1: 40, y1: 40, value: 220 },
			{ x0: 60, y0: 60, x1: 80, y1: 80, value: 45 },
		]);
		const eig = eigOf(two);
		const base = { eig, w: W, h: H, live: [] };
		const strict = pairs(
			selectGridCorners({ ...base, options: { ...OPTIONS, quality: 0.003, absMin: 0 } }),
		);
		const loose = pairs(
			selectGridCorners({ ...base, options: { ...OPTIONS, quality: 0.0001, absMin: 0 } }),
		);
		const none = pairs(
			selectGridCorners({ ...base, options: { ...OPTIONS, quality: 0, absMin: 1e9 } }),
		);
		expect(strict.every((p) => p.x < 50 && p.y < 50)).toBe(true);
		expect(loose.some((p) => p.x > 50 && p.y > 50)).toBe(true);
		expect(none.length).toBe(0);
	});
});
