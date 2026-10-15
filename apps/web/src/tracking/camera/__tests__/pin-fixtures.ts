/**
 * Helpers of the slice-T3 tests: an independent simulation of how the renderer
 * lays an element out (written from the compositor shader and the text node,
 * not from `to-channels.ts`), hosts that place the video picture on the canvas,
 * and ground truth for a scene point stuck to the world.
 *
 * Frame coordinates are the analysis frame's pixel index coordinates, so the
 * picture position of frame point `(x, y)` is `u = (x + 0.5) / w`.
 */
import type { ElementBounds } from "@/preview/element-bounds";
import type { Pose } from "../camera-synth";
import { applySim } from "../similarity";
import { fitH } from "../homography";
import type { PinSolution } from "../types";

export const CANVAS = { width: 1920, height: 1080 } as const;
export const FRAME = { w: 480, h: 270 } as const;
export const FPS = 30;
/** Timeline second of analysis frame 0 (not zero, so local and timeline time cannot be mixed up). */
export const START_SEC = 2;
/** One analysis frame of px@480 is this many canvas px. */
export const CANVAS_PER_FRAME_PX = CANVAS.width / FRAME.w;

export interface Pt {
	x: number;
	y: number;
}

export const frameTimeAt = (frame: number): number => START_SEC + frame / FPS;

// ---------------------------------------------------------------------------
// Hosts: where the picture of the video sits on the canvas
// ---------------------------------------------------------------------------

export type HostFn = (seconds: number) => ElementBounds;

export const fillHost: HostFn = () => ({
	cx: CANVAS.width / 2,
	cy: CANVAS.height / 2,
	width: CANVAS.width,
	height: CANVAS.height,
	rotation: 0,
});

/** Scaled 1.2x, shifted and turned 5 degrees. */
export const shiftedHost: HostFn = () => ({
	cx: CANVAS.width / 2 + 37,
	cy: CANVAS.height / 2 - 21,
	width: CANVAS.width * 1.2,
	height: CANVAS.height * 1.2,
	rotation: 5,
});

/** Ken Burns: the host's own animation, slowly zooming, drifting and turning. */
export const kenBurnsHost: HostFn = (seconds) => {
	const s = seconds - START_SEC;
	return {
		cx: CANVAS.width / 2 + 20 * s,
		cy: CANVAS.height / 2 - 8 * s,
		width: CANVAS.width * (1 + 0.04 * s),
		height: CANVAS.height * (1 + 0.04 * s),
		rotation: 0.3 * s,
	};
};

/** A negative width is a horizontal mirror, as the transform handles use it. */
export const mirroredHost: HostFn = () => ({
	cx: CANVAS.width / 2,
	cy: CANVAS.height / 2,
	width: -CANVAS.width,
	height: CANVAS.height,
	rotation: 0,
});

export const mirroredRotatedHost: HostFn = () => ({
	cx: CANVAS.width / 2 + 12,
	cy: CANVAS.height / 2 + 9,
	width: -CANVAS.width * 1.1,
	height: CANVAS.height * 1.1,
	rotation: -4,
});

/** The picture stretched wider than tall: breaks the similarity (rare). */
export const stretchedHost: HostFn = () => ({
	cx: CANVAS.width / 2,
	cy: CANVAS.height / 2,
	width: CANVAS.width * 1.2,
	height: CANVAS.height,
	rotation: 0,
});

export function canvasToFrame({
	c,
	bounds,
}: {
	c: Pt;
	bounds: ElementBounds;
}): Pt {
	const r = (bounds.rotation * Math.PI) / 180;
	const dx = c.x - bounds.cx;
	const dy = c.y - bounds.cy;
	const lx = dx * Math.cos(r) + dy * Math.sin(r);
	const ly = -dx * Math.sin(r) + dy * Math.cos(r);
	return {
		x: (lx / bounds.width + 0.5) * FRAME.w - 0.5,
		y: (ly / bounds.height + 0.5) * FRAME.h - 0.5,
	};
}

export function frameToCanvas({
	p,
	bounds,
}: {
	p: Pt;
	bounds: ElementBounds;
}): Pt {
	const r = (bounds.rotation * Math.PI) / 180;
	const lx = ((p.x + 0.5) / FRAME.w - 0.5) * bounds.width;
	const ly = ((p.y + 0.5) / FRAME.h - 0.5) * bounds.height;
	return {
		x: bounds.cx + lx * Math.cos(r) - ly * Math.sin(r),
		y: bounds.cy + lx * Math.sin(r) + ly * Math.cos(r),
	};
}

// ---------------------------------------------------------------------------
// The renderer's layout rules, simulated
// ---------------------------------------------------------------------------

/** The element's box in its own unscaled space, relative to the point `position` moves. */
export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Look {
	position: Pt;
	scaleX: number;
	scaleY: number;
	rotate: number;
}

export interface ElementSpec {
	rect: Rect;
	isText: boolean;
}

type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Canvas 2D semantics: the new matrix is applied to the points first, the current one after. */
function postMultiply({ m, n }: { m: Mat; n: Mat }): Mat {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5],
	];
}

function applyMat({ m, x, y }: { m: Mat; x: number; y: number }): Pt {
	return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * Where the four corners of the element's box (top-left, top-right,
 * bottom-right, bottom-left of its own picture) land on the canvas.
 *
 * Text follows `text-node.ts`: `translate`, then `scale`, then `rotate` on a 2D
 * context. Everything else follows `layer.wgsl`: the quad is `|scale|` times
 * the fitted size, flips mirror the texture (not the quad), and the quad is
 * rotated about its centre.
 */
export function renderedCorners({
	spec,
	look,
	canvas = CANVAS,
}: {
	spec: ElementSpec;
	look: Look;
	canvas?: { width: number; height: number };
}): Pt[] {
	const { rect } = spec;
	const cx = canvas.width / 2 + look.position.x;
	const cy = canvas.height / 2 + look.position.y;
	const radians = (look.rotate * Math.PI) / 180;
	if (spec.isText) {
		let m = IDENTITY;
		m = postMultiply({ m, n: [1, 0, 0, 1, cx, cy] });
		m = postMultiply({ m, n: [look.scaleX, 0, 0, look.scaleY, 0, 0] });
		m = postMultiply({
			m,
			n: [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0],
		});
		return [
			[rect.left, rect.top],
			[rect.left + rect.width, rect.top],
			[rect.left + rect.width, rect.top + rect.height],
			[rect.left, rect.top + rect.height],
		].map(([x, y]) => applyMat({ m, x, y }));
	}
	// the fragment shader samples `source(uv)` at `uv = R^-1 (pixel - centre) / size + 0.5`,
	// reading the texture backwards when flipped; invert that for each texture corner
	const width = Math.abs(rect.width * look.scaleX);
	const height = Math.abs(rect.height * look.scaleY);
	const flipX = look.scaleX < 0;
	const flipY = look.scaleY < 0;
	return [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	].map(([tu, tv]) => {
		const u = flipX ? 1 - tu : tu;
		const v = flipY ? 1 - tv : tv;
		const lx = (u - 0.5) * width;
		const ly = (v - 0.5) * height;
		return {
			x: cx + lx * Math.cos(radians) - ly * Math.sin(radians),
			y: cy + lx * Math.sin(radians) + ly * Math.cos(radians),
		};
	});
}

/** A channel set in the shape `buildCameraPinChannels` returns it. */
export interface ChannelsLike {
	x: ArrayLike<number>;
	y: ArrayLike<number>;
	scaleX: ArrayLike<number>;
	scaleY: ArrayLike<number>;
	rotate: ArrayLike<number>;
}

export function lookAt({ channels, i }: { channels: ChannelsLike; i: number }): Look {
	return {
		position: { x: channels.x[i], y: channels.y[i] },
		scaleX: channels.scaleX[i],
		scaleY: channels.scaleY[i],
		rotate: channels.rotate[i],
	};
}

// ---------------------------------------------------------------------------
// Ground truth: a point stuck to the world
// ---------------------------------------------------------------------------

export interface WorldTruth {
	/** Frame coordinates (px@480) of the scene point that shows at canvas point `c` on frame `f0`, seen on frame `t`. */
	frameAt: ({ t, c }: { t: number; c: Pt }) => Pt;
	/** Canvas position of that scene point on frame `t`, through the host. */
	canvasAt: ({ t, c }: { t: number; c: Pt }) => Pt;
}

/** A similarity camera: frame pixel `p = fc + d + s R(theta) (w - wc)`. */
export function similarityWorldTruth({
	poses,
	f0,
	host,
}: {
	poses: Pose[];
	f0: number;
	host: HostFn;
}): WorldTruth {
	const fc = { x: FRAME.w / 2, y: FRAME.h / 2 };
	const frameAt = ({ t, c }: { t: number; c: Pt }): Pt => {
		const a = poses[f0];
		const p0 = canvasToFrame({ c, bounds: host(frameTimeAt(f0)) });
		// frame -> world
		const px = p0.x - fc.x - a.dx;
		const py = p0.y - fc.y - a.dy;
		const wx = a.wcx + (px * Math.cos(a.theta) + py * Math.sin(a.theta)) / a.s;
		const wy = a.wcy + (-px * Math.sin(a.theta) + py * Math.cos(a.theta)) / a.s;
		// world -> frame t
		const b = poses[t];
		const qx = b.s * ((wx - b.wcx) * Math.cos(b.theta) - (wy - b.wcy) * Math.sin(b.theta));
		const qy = b.s * ((wx - b.wcx) * Math.sin(b.theta) + (wy - b.wcy) * Math.cos(b.theta));
		return { x: fc.x + b.dx + qx, y: fc.y + b.dy + qy };
	};
	return {
		frameAt,
		canvasAt: ({ t, c }) => frameToCanvas({ p: frameAt({ t, c }), bounds: host(frameTimeAt(t)) }),
	};
}

/** A camera that only rotates, from the generator's `truthPoint` (it maps frame-0 points, so `f0` is 0). */
export function homographyWorldTruth({
	truthPoint,
	host,
}: {
	truthPoint: ({ t, x, y }: { t: number; x: number; y: number }) => Pt;
	host: HostFn;
}): WorldTruth {
	const frameAt = ({ t, c }: { t: number; c: Pt }): Pt => {
		const p0 = canvasToFrame({ c, bounds: host(frameTimeAt(0)) });
		return truthPoint({ t, x: p0.x, y: p0.y });
	};
	return {
		frameAt,
		canvasAt: ({ t, c }) => frameToCanvas({ p: frameAt({ t, c }), bounds: host(frameTimeAt(t)) }),
	};
}

export interface CornerError {
	/** Worst corner distance (canvas px) over the compared frames. */
	max: number;
	rms: number;
	frames: number;
	/** Frame index of the worst corner. */
	worstFrame: number;
}

/**
 * Plays the produced channels through the renderer simulation and compares the
 * four corners with where the world says they are. Only frames where every
 * true corner is inside the video frame count (the pin is visible there).
 */
export function cornerErrors({
	spec,
	overlay,
	channels,
	frames,
	truth,
	onlyVisible = true,
}: {
	spec: ElementSpec;
	overlay: Look;
	channels: ChannelsLike;
	/** The analysis frame of each channel sample. */
	frames: ArrayLike<number>;
	truth: WorldTruth;
	onlyVisible?: boolean;
}): CornerError {
	const start = renderedCorners({ spec, look: overlay });
	let max = 0;
	let sum = 0;
	let count = 0;
	let worstFrame = -1;
	for (let i = 0; i < frames.length; i++) {
		const t = frames[i];
		const expectedFrame = start.map((c) => truth.frameAt({ t, c }));
		if (
			onlyVisible &&
			expectedFrame.some((p) => p.x < 0 || p.y < 0 || p.x > FRAME.w - 1 || p.y > FRAME.h - 1)
		) {
			continue;
		}
		const got = renderedCorners({ spec, look: lookAt({ channels, i }) });
		for (let k = 0; k < 4; k++) {
			const want = truth.canvasAt({ t, c: start[k] });
			const d = Math.hypot(got[k].x - want.x, got[k].y - want.y);
			sum += d * d;
			count++;
			if (d > max) {
				max = d;
				worstFrame = t;
			}
		}
	}
	return { max, rms: count > 0 ? Math.sqrt(sum / count) : 0, frames: count / 4, worstFrame };
}

// ---------------------------------------------------------------------------
// Exact solutions (no tracking), so the conversion is tested on its own
// ---------------------------------------------------------------------------

function emptySolution({
	model,
	f0,
	frameCount,
}: {
	model: "S" | "H";
	f0: number;
	frameCount: number;
}): PinSolution {
	const stride = model === "S" ? 4 : 9;
	const ok = new Uint8Array(frameCount).fill(1);
	return {
		model,
		mode: "scene",
		f0,
		frameCount,
		range: { lo: 0, hi: frameCount - 1 },
		stride,
		maps: new Float64Array(stride * frameCount),
		ok,
		nin: new Int32Array(frameCount).fill(50),
		rms: new Float64Array(frameCount),
		hops: 0,
	};
}

/** The exact similarity from frame `f0` to every frame of a pose path. */
export function exactSimilaritySolution({
	poses,
	f0,
}: {
	poses: Pose[];
	f0: number;
}): PinSolution {
	const solution = emptySolution({ model: "S", f0, frameCount: poses.length });
	const fc = { x: FRAME.w / 2, y: FRAME.h / 2 };
	const a = poses[f0];
	for (let t = 0; t < poses.length; t++) {
		const b = poses[t];
		// z_t = b.s R(b.theta) (w - wc) + fc + d_t, w from frame f0
		const sr = b.s / a.s;
		const th = b.theta - a.theta;
		const ar = sr * Math.cos(th);
		const ai = sr * Math.sin(th);
		const image = applySim({ map: { ar, ai, br: 0, bi: 0 }, x: fc.x + a.dx, y: fc.y + a.dy });
		solution.maps[4 * t] = ar;
		solution.maps[4 * t + 1] = ai;
		solution.maps[4 * t + 2] = fc.x + b.dx - image.x;
		solution.maps[4 * t + 3] = fc.y + b.dy - image.y;
	}
	return solution;
}

/** The exact homography from frame 0, fitted to a grid of the generator's true points. */
export function exactHomographySolution({
	truthPoint,
	frameCount,
}: {
	truthPoint: ({ t, x, y }: { t: number; x: number; y: number }) => Pt;
	frameCount: number;
}): PinSolution {
	const solution = emptySolution({ model: "H", f0: 0, frameCount });
	const nx = 9;
	const ny = 7;
	const za = new Float64Array(2 * nx * ny);
	const zb = new Float64Array(2 * nx * ny);
	const w = new Float64Array(nx * ny).fill(1);
	const idx = Int32Array.from({ length: nx * ny }, (_, i) => i);
	for (let t = 0; t < frameCount; t++) {
		let k = 0;
		for (let j = 0; j < ny; j++) {
			for (let i = 0; i < nx; i++) {
				const x = (i / (nx - 1)) * (FRAME.w - 1);
				const y = (j / (ny - 1)) * (FRAME.h - 1);
				const q = truthPoint({ t, x, y });
				za[2 * k] = x;
				za[2 * k + 1] = y;
				zb[2 * k] = q.x;
				zb[2 * k + 1] = q.y;
				k++;
			}
		}
		const h = fitH({ za, zb, w, idx, n: nx * ny });
		if (!h) throw new Error("the exact homography could not be fitted");
		const scale = 1 / h[8];
		for (let i = 0; i < 9; i++) solution.maps[9 * t + i] = h[i] * scale;
	}
	return solution;
}

// ---------------------------------------------------------------------------
// Pose paths (similarity cameras)
// ---------------------------------------------------------------------------

const BASE = { wcx: 1000, wcy: 900 };

function pose({
	s = 1,
	theta = 0,
	dx = 0,
	dy = 0,
}: {
	s?: number;
	theta?: number;
	dx?: number;
	dy?: number;
}): Pose {
	return { s, theta, dx, dy, ...BASE };
}

const DEG = Math.PI / 180;

export type PathKind = "pan" | "zoom" | "roll" | "shake" | "combo";

/** Camera paths of `n` frames, built like the generator's but analytic (no frames rendered). */
export function posePath({ kind, n }: { kind: PathKind; n: number }): Pose[] {
	return Array.from({ length: n }, (_, t) => {
		const u = n > 1 ? t / (n - 1) : 0;
		switch (kind) {
			case "pan":
				return pose({ dx: -1.5 * t, dy: -0.4 * t });
			case "zoom":
				return pose({ s: 1.5 ** u, dx: -0.5 * t });
			case "roll":
				return pose({ theta: 10 * DEG * Math.sin(2 * Math.PI * u) });
			case "shake":
				return pose({
					dx: 3 * Math.sin(t * 0.7) + 1.5 * Math.sin(t * 1.9),
					dy: 2.5 * Math.sin(t * 0.8 + 1) + 1 * Math.sin(t * 2.3),
					theta: 0.3 * DEG * Math.sin(t * 0.6),
					s: 1 + 0.003 * Math.sin(t * 0.5),
				});
			case "combo":
				return pose({
					dx: -1 * t,
					dy: -0.3 * t,
					s: 1.3 ** u,
					theta: 6 * DEG * Math.sin(2 * Math.PI * u * 1.3),
				});
		}
	});
}

/** A camera turning about the frame centre by `totalDeg` in total (a spin, to test the angle unwrap). */
export function spinPath({ n, totalDeg }: { n: number; totalDeg: number }): Pose[] {
	return Array.from({ length: n }, (_, t) =>
		pose({ theta: (totalDeg * DEG * t) / (n - 1) }),
	);
}

/** A camera zooming from 1 to `finalScale`, which may be tiny. */
export function zoomPath({ n, finalScale }: { n: number; finalScale: number }): Pose[] {
	return Array.from({ length: n }, (_, t) =>
		pose({ s: finalScale ** (n > 1 ? t / (n - 1) : 0) }),
	);
}
