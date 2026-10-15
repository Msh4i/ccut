import { beforeAll, describe, expect, test } from "bun:test";
import { makeWorld, renderPose, type Pose, type World } from "../camera-synth";
import {
	createLkWorkspace,
	lkPyr,
	type LkOptions,
	type LkResult,
} from "../lk";
import { allocPyramid, fillPyramid, type Pyramid } from "../pyramid";

const W = 480;
const H = 270;
const OPTIONS: LkOptions = { half: 5, maxIter: 12, eps: 0.02 };

let world: World;
let otherWorld: World;

beforeAll(() => {
	world = makeWorld({ width: 1000, height: 800, seed: 21 });
	otherWorld = makeWorld({ width: 1000, height: 800, seed: 22 });
});

function pose({ dx = 0, dy = 0 }: { dx?: number; dy?: number }): Pose {
	return { s: 1, theta: 0, dx, dy, wcx: 500, wcy: 400 };
}

function pyramidOf({
	source,
	dx,
	dy,
	levels = 3,
	level,
}: {
	source: World;
	dx?: number;
	dy?: number;
	levels?: number;
	/** Maps every gray value `v` to `0.8 v + level`: a brightness step, with room so nothing clips. */
	level?: number;
}): Pyramid {
	const frame = renderPose({ world: source, pose: pose({ dx, dy }), width: W, height: H });
	if (level !== undefined) {
		for (let i = 0; i < frame.data.length; i++) frame.data[i] = 0.8 * frame.data[i] + level;
	}
	const pyramid = allocPyramid({ w: W, h: H, levels });
	fillPyramid({ pyramid, gray: frame.data });
	return pyramid;
}

const POINTS = (() => {
	const points: { x: number; y: number }[] = [];
	for (let y = 50; y <= 230; y += 45) {
		for (let x = 60; x <= 420; x += 60) points.push({ x, y });
	}
	return points;
})();

function trackAll({
	from,
	to,
	options = OPTIONS,
	shift,
}: {
	from: Pyramid;
	to: Pyramid;
	options?: LkOptions;
	shift: { x: number; y: number };
}) {
	const workspace = createLkWorkspace({ half: options.half });
	const out: LkResult = { x: 0, y: 0, res: 0 };
	const errors: number[] = [];
	let failed = 0;
	for (const p of POINTS) {
		const ok = lkPyr({
			from,
			to,
			x: p.x,
			y: p.y,
			guessX: p.x,
			guessY: p.y,
			options,
			workspace,
			out,
		});
		if (!ok) {
			failed++;
			continue;
		}
		errors.push(Math.hypot(out.x - (p.x + shift.x), out.y - (p.y + shift.y)));
	}
	errors.sort((a, b) => a - b);
	return { errors, failed, median: errors[errors.length >> 1], worst: errors[errors.length - 1] };
}

describe("lkPyr", () => {
	test("recovers a sub-pixel shift", () => {
		// pose.dx moves the content by +dx
		const r = trackAll({
			from: pyramidOf({ source: world }),
			to: pyramidOf({ source: world, dx: 0.3, dy: -0.7 }),
			shift: { x: 0.3, y: -0.7 },
		});
		expect(r.errors.length).toBeGreaterThanOrEqual(POINTS.length - 2);
		// the shifted frame is the world resampled bilinearly, which blurs 2 px detail a little
		expect(r.median).toBeLessThan(0.08);
		expect(r.worst).toBeLessThan(0.35);
	});

	test("the pyramid reaches motion that one level cannot", () => {
		const from = pyramidOf({ source: world });
		const to = pyramidOf({ source: world, dx: 9.6, dy: -6.4 });
		const shift = { x: 9.6, y: -6.4 };
		const pyramidal = trackAll({ from, to, shift });
		const flat = trackAll({
			from: pyramidOf({ source: world, levels: 1 }),
			to: pyramidOf({ source: world, dx: 9.6, dy: -6.4, levels: 1 }),
			shift,
		});
		expect(pyramidal.median).toBeLessThan(0.15);
		expect(pyramidal.errors.length).toBeGreaterThanOrEqual(POINTS.length - 4);
		// one level starts 11 px away and either fails or lands somewhere else
		const flatGood = flat.errors.filter((e) => e < 0.3).length;
		expect(flatGood).toBeLessThan(pyramidal.errors.filter((e) => e < 0.3).length / 2);
	});

	test("ignores a brightness step of 30 gray levels (zero-mean patches)", () => {
		const r = trackAll({
			from: pyramidOf({ source: world, level: 20 }),
			to: pyramidOf({ source: world, dx: 1.4, dy: 0.5, level: 50 }),
			shift: { x: 1.4, y: 0.5 },
		});
		expect(r.errors.length).toBeGreaterThanOrEqual(POINTS.length - 3);
		expect(r.median).toBeLessThan(0.1);
		expect(r.worst).toBeLessThan(0.4);
	});

	test("going there and back returns to the start", () => {
		const a = pyramidOf({ source: world });
		const b = pyramidOf({ source: world, dx: 2.2, dy: 1.3 });
		const workspace = createLkWorkspace({ half: OPTIONS.half });
		const out: LkResult = { x: 0, y: 0, res: 0 };
		let checked = 0;
		for (const p of POINTS) {
			if (!lkPyr({ from: a, to: b, x: p.x, y: p.y, guessX: p.x, guessY: p.y, options: OPTIONS, workspace, out })) continue;
			const nx = out.x;
			const ny = out.y;
			if (!lkPyr({ from: b, to: a, x: nx, y: ny, guessX: p.x, guessY: p.y, options: OPTIONS, workspace, out })) continue;
			expect(Math.hypot(out.x - p.x, out.y - p.y)).toBeLessThan(0.15);
			checked++;
		}
		expect(checked).toBeGreaterThanOrEqual(POINTS.length - 3);
	});

	test("a good match leaves a smaller residual than an unrelated image does", () => {
		const from = pyramidOf({ source: world });
		const workspace = createLkWorkspace({ half: OPTIONS.half });
		const out: LkResult = { x: 0, y: 0, res: 0 };
		const good = pyramidOf({ source: world, dx: 0.5, dy: 0.5 });
		const unrelated = pyramidOf({ source: otherWorld });
		const mean = (values: number[]) => values.reduce((a, v) => a + v, 0) / values.length;
		const goodRes: number[] = [];
		const wrongRes: number[] = [];
		for (const p of POINTS) {
			const args = { from, x: p.x, y: p.y, guessX: p.x, guessY: p.y, options: OPTIONS, workspace, out };
			if (lkPyr({ ...args, to: good })) goodRes.push(out.res);
			if (lkPyr({ ...args, to: unrelated })) wrongRes.push(out.res);
		}
		expect(goodRes.length).toBeGreaterThan(POINTS.length - 3);
		expect(wrongRes.length).toBeGreaterThan(10);
		expect(mean(goodRes)).toBeLessThan(5);
		expect(mean(wrongRes)).toBeGreaterThan(2 * mean(goodRes));
	});

	test("gives up on a patch with no texture", () => {
		const flat = allocPyramid({ w: W, h: H, levels: 3 });
		fillPyramid({ pyramid: flat, gray: new Uint8Array(W * H).fill(128) });
		const workspace = createLkWorkspace({ half: OPTIONS.half });
		const out: LkResult = { x: 0, y: 0, res: 0 };
		expect(lkPyr({ from: flat, to: flat, x: 200, y: 100, guessX: 200, guessY: 100, options: OPTIONS, workspace, out })).toBe(false);
	});

	test("gives up when the window leaves the image", () => {
		const a = pyramidOf({ source: world });
		const workspace = createLkWorkspace({ half: OPTIONS.half });
		const out: LkResult = { x: 0, y: 0, res: 0 };
		for (const [x, y] of [
			[2, 100],
			[200, 1],
			[W - 2, 100],
			[200, H - 2],
		]) {
			expect(lkPyr({ from: a, to: a, x, y, guessX: x, guessY: y, options: OPTIONS, workspace, out })).toBe(false);
		}
	});

	test("a window wider than the workspace is refused", () => {
		expect(() => createLkWorkspace({ half: 16 })).toThrow();
		expect(() => createLkWorkspace({ half: 0 })).toThrow();
	});
});
