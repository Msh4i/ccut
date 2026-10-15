/**
 * Seeded synthetic footage with known camera motion, for testing and
 * measuring the camera tracker (and, later, for the end-to-end test videos).
 *
 * A big textured "world" image is seen through a camera whose path is known
 * exactly: similarity paths (pan, zoom, roll, hand shake) or a pure rotation of
 * a pinhole camera over a flat scene (a homography). On top of that come
 * moving foreground disks, motion blur, exposure jumps, scene cuts and sensor
 * noise. Everything is deterministic for a given seed.
 */
import type { GrayFrame } from "../types";
import {
	jitterPaths,
	poseAt,
	type Pose,
	type PoseExtra,
	type PoseKind,
} from "./camera-synth-motion";
import { makeWorld, type World } from "./camera-synth-world";
import { createRng, gaussianSample } from "./random";
import type { Similarity } from "./similarity";

export { makeWorld, type World } from "./camera-synth-world";
export type { Pose, PoseExtra, PoseKind } from "./camera-synth-motion";

/** Renders `world` seen from `pose` into `out` (float gray levels, no noise). */
function renderWorldFrame({
	world,
	out,
	width,
	height,
	pose,
}: {
	world: World;
	out: Float32Array;
	width: number;
	height: number;
	pose: Pose;
}): void {
	const { data, width: ww, height: wh } = world;
	const cs = Math.cos(pose.theta);
	const sn = Math.sin(pose.theta);
	const inv = 1 / pose.s;
	const fcx = width / 2;
	const fcy = height / 2;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const px = x - fcx - pose.dx;
			const py = y - fcy - pose.dy;
			// the inverse of the pose: w - wc = R(-theta) p / s
			const wx = (px * cs + py * sn) * inv + pose.wcx;
			const wy = (-px * sn + py * cs) * inv + pose.wcy;
			const ix = Math.floor(wx);
			const iy = Math.floor(wy);
			let v: number;
			if (ix < 0 || iy < 0 || ix >= ww - 1 || iy >= wh - 1) {
				v = 128;
			} else {
				const fx = wx - ix;
				const fy = wy - iy;
				const i = iy * ww + ix;
				v =
					(data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) +
					(data[i + ww] * (1 - fx) + data[i + ww + 1] * fx) * fy;
			}
			out[y * width + x] = v;
		}
	}
}

/** One noise-free 8-bit frame of `world` seen from `pose`. */
export function renderPose({
	world,
	pose,
	width = 480,
	height = 270,
}: {
	world: World;
	pose: Pose;
	width?: number;
	height?: number;
}): GrayFrame {
	const floats = new Float32Array(width * height);
	renderWorldFrame({ world, out: floats, width, height, pose });
	const data = new Uint8Array(width * height);
	for (let i = 0; i < data.length; i++) data[i] = (floats[i] + 0.5) | 0;
	return { w: width, h: height, data };
}

// ---------------------------------------------------------------------------
// Foreground objects, exposure, noise
// ---------------------------------------------------------------------------

/** A textured disk that moves on its own over the picture (frame coordinates). */
export interface Foreground {
	x0: number;
	y0: number;
	/** Velocity in px per frame. */
	vx: number;
	vy: number;
	radius?: number;
	/** Sway amplitudes added to the straight path. */
	ax?: number;
	ay?: number;
	/** Visible from frame `t0` up to (not including) `t1`; always visible when `t0` is left out. */
	t0?: number;
	t1?: number;
}

export interface ForegroundState {
	x: number;
	y: number;
	visible: boolean;
}

/** From frame `t0` up to `t1`, the gray levels are `v * gain + offset`. */
export interface ExposureChange {
	t0: number;
	t1: number;
	gain: number;
	offset: number;
}

interface DiskTexture {
	radius: number;
	size: number;
	data: Float32Array;
}

function makeDisk({ seed, radius }: { seed: number; radius: number }): DiskTexture {
	const size = radius * 2 + 4;
	const tex = makeWorld({
		width: size,
		height: size,
		seed: seed + 77,
		texture: 1,
		shapes: 25,
		maxSize: 14,
		minCell: 2,
	});
	return { radius, size, data: tex.data };
}

function drawDisk({
	buf,
	width,
	height,
	disk,
	cx,
	cy,
}: {
	buf: Float32Array;
	width: number;
	height: number;
	disk: DiskTexture;
	cx: number;
	cy: number;
}): void {
	const { radius, size, data } = disk;
	const x0 = Math.max(0, Math.floor(cx - radius - 2));
	const x1 = Math.min(width - 1, Math.ceil(cx + radius + 2));
	const y0 = Math.max(0, Math.floor(cy - radius - 2));
	const y1 = Math.min(height - 1, Math.ceil(cy + radius + 2));
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const alpha = Math.max(0, Math.min(1, radius + 0.75 - Math.sqrt(dx * dx + dy * dy)));
			if (alpha <= 0) continue;
			const tx = Math.max(0, Math.min(size - 1, Math.round(dx + size / 2)));
			const ty = Math.max(0, Math.min(size - 1, Math.round(dy + size / 2)));
			buf[y * width + x] = buf[y * width + x] * (1 - alpha) + data[ty * size + tx] * alpha;
		}
	}
}

/**
 * `exact`: one Box-Muller draw per pixel from the sequence's own stream (what
 * the measurements used). `table`: draws from a 65536-entry table of normal
 * samples with a xorshift index, an order of magnitude cheaper and as good for
 * a tracker; the default.
 */
export type NoiseModel = "table" | "exact";

function makeNoise({
	model,
	sigma,
	seed,
}: {
	model: NoiseModel;
	sigma: number;
	seed: number;
}): () => number {
	if (sigma <= 0) return () => 0;
	if (model === "exact") {
		const random = createRng({ seed });
		return () => sigma * gaussianSample({ random });
	}
	const random = createRng({ seed: seed + 0x5bd1e995 });
	const table = new Float32Array(65536);
	for (let i = 0; i < table.length; i++) table[i] = gaussianSample({ random });
	let state = ((seed * 2654435761) >>> 0) || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return sigma * table[(state >>> 16) & 0xffff];
	};
}

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

export interface SequenceOptions {
	kind: PoseKind;
	frameCount: number;
	width?: number;
	height?: number;
	/** Sensor noise sigma in gray levels. Default 2.5. */
	noise?: number;
	noiseModel?: NoiseModel;
	/** Seeds the camera shake, the disks' textures and the noise. Default 5. */
	seed?: number;
	foregrounds?: Foreground[];
	/** Motion blur: shutter open for this fraction of a frame interval (5 sub-frames). Default 0. */
	blur?: number;
	extra?: PoseExtra;
	/** From this frame on the camera sees `worldAfterCut` instead of the world. */
	cutAt?: number;
	worldAfterCut?: World;
	exposure?: ExposureChange[];
}

/** What the generator knows that the tracker has to find out. */
export interface SequenceTruth {
	truth: Pose[];
	/** Per frame, per foreground. */
	foregroundTruth: ForegroundState[][];
	width: number;
	height: number;
	frameCount: number;
}

/**
 * Generates the frames one at a time into a buffer that is reused, so a long
 * clip never has to be held in memory: `onFrame` must copy a frame it wants to
 * keep. Returns the ground truth.
 */
export function renderSequence({
	world,
	options,
	onFrame,
}: {
	world: World;
	options: SequenceOptions;
	onFrame: ({ frame, index }: { frame: GrayFrame; index: number }) => void;
}): SequenceTruth {
	const {
		kind,
		frameCount,
		width = 480,
		height = 270,
		noise = 2.5,
		noiseModel = "table",
		seed = 5,
		foregrounds = [],
		blur = 0,
		extra = {},
		cutAt = -1,
		worldAfterCut,
		exposure = [],
	} = options;
	if (!Number.isInteger(frameCount) || frameCount < 1) {
		throw new RangeError(`frameCount must be a positive integer, got ${frameCount}`);
	}
	const jitter = jitterPaths({ random: createRng({ seed: seed + 9 }) });
	const nextNoise = makeNoise({ model: noiseModel, sigma: noise, seed });
	const disks = foregrounds.map((f, i) => makeDisk({ seed: seed * 31 + i, radius: f.radius ?? 28 }));
	const truth: Pose[] = [];
	const foregroundTruth: ForegroundState[][] = [];
	const tmp = new Float32Array(width * height);
	const acc = new Float32Array(width * height);
	const data = new Uint8Array(width * height);
	const frame: GrayFrame = { w: width, h: height, data };
	for (let t = 0; t < frameCount; t++) {
		const pose = poseAt({ kind, t, frameCount, jitter, extra });
		truth.push(pose);
		const source = cutAt >= 0 && t >= cutAt && worldAfterCut ? worldAfterCut : world;
		if (blur > 0) {
			const subframes = 5;
			acc.fill(0);
			for (let k = 0; k < subframes; k++) {
				const tt = t + (k / (subframes - 1) - 0.5) * blur;
				const p = poseAt({ kind, t: tt, frameCount, jitter, extra });
				renderWorldFrame({ world: source, out: tmp, width, height, pose: p });
				for (let i = 0; i < acc.length; i++) acc[i] += tmp[i] / subframes;
			}
			tmp.set(acc);
		} else {
			renderWorldFrame({ world: source, out: tmp, width, height, pose });
		}
		const states: ForegroundState[] = [];
		foregrounds.forEach((f, i) => {
			const x = f.x0 + f.vx * t + (f.ax ? f.ax * Math.sin(t / 20) : 0);
			const y = f.y0 + f.vy * t + (f.ay ? f.ay * Math.cos(t / 25) : 0);
			const visible = f.t0 === undefined || (t >= f.t0 && t < (f.t1 ?? Infinity));
			if (visible) drawDisk({ buf: tmp, width, height, disk: disks[i], cx: x, cy: y });
			states.push({ x, y, visible });
		});
		foregroundTruth.push(states);
		const active = exposure.filter((e) => t >= e.t0 && t < e.t1);
		for (let i = 0; i < data.length; i++) {
			let v = tmp[i];
			for (const e of active) v = v * e.gain + e.offset;
			v += nextNoise();
			data[i] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
		}
		onFrame({ frame, index: t });
	}
	return { truth, foregroundTruth, width, height, frameCount };
}

/** `renderSequence` that keeps every frame. Fine for a few hundred frames. */
export function generateSequence({
	world,
	options,
}: {
	world: World;
	options: SequenceOptions;
}): SequenceTruth & { frames: GrayFrame[] } {
	const frames: GrayFrame[] = [];
	const truth = renderSequence({
		world,
		options,
		onFrame: ({ frame }) => frames.push({ w: frame.w, h: frame.h, data: frame.data.slice() }),
	});
	return { ...truth, frames };
}

/**
 * Where a point of frame `f0` is on frame `t`, as an exact similarity of frame
 * pixels (not about the frame centre): the ground truth of a similarity camera.
 */
export function groundTruthMap({
	truth,
	f0,
	t,
	width,
	height,
}: {
	truth: Pose[];
	f0: number;
	t: number;
	width: number;
	height: number;
}): Similarity {
	const a = truth[f0];
	const b = truth[t];
	const sr = b.s / a.s;
	const th = b.theta - a.theta;
	const ar = sr * Math.cos(th);
	const ai = sr * Math.sin(th);
	const fcx = width / 2;
	const fcy = height / 2;
	// Z_t = a Z_0 + b' with b' = fc + d_t - a (fc + d_0)
	return {
		ar,
		ai,
		br: fcx + b.dx - (ar * (fcx + a.dx) - ai * (fcy + a.dy)),
		bi: fcy + b.dy - (ar * (fcy + a.dy) + ai * (fcx + a.dx)),
	};
}

// ---------------------------------------------------------------------------
// Homography camera
// ---------------------------------------------------------------------------

/** What the generator knows about a homography camera. */
export interface HomographyTruth {
	/** Where the point (x, y) of frame 0 is on frame `t`. */
	truthPoint: ({ t, x, y }: { t: number; x: number; y: number }) => { x: number; y: number };
	frameCount: number;
	width: number;
	height: number;
}

type Mat3 = number[][];

function mul3({ a, b }: { a: Mat3; b: Mat3 }): Mat3 {
	return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}

function rotation({ yaw, pitch, roll }: { yaw: number; pitch: number; roll: number }): Mat3 {
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	const cp = Math.cos(pitch);
	const sp = Math.sin(pitch);
	const cr = Math.cos(roll);
	const sr = Math.sin(roll);
	const ry: Mat3 = [
		[cy, 0, sy],
		[0, 1, 0],
		[-sy, 0, cy],
	];
	const rx: Mat3 = [
		[1, 0, 0],
		[0, cp, -sp],
		[0, sp, cp],
	];
	const rz: Mat3 = [
		[cr, -sr, 0],
		[sr, cr, 0],
		[0, 0, 1],
	];
	return mul3({ a: mul3({ a: ry, b: rx }), b: rz });
}

/**
 * A pinhole camera that only rotates (yaw ramps to `yawMaxDeg`, pitch bumps up
 * to `pitchMaxDeg` and back, roll sways by `rollMaxDeg`) in front of a flat
 * distant scene: the picture moves by a homography, which no similarity can
 * follow. The scene is the middle of `world`.
 */
export function generateHomographySequence({
	world,
	hfovDeg,
	yawMaxDeg,
	pitchMaxDeg,
	rollMaxDeg = 0,
	frameCount,
	width = 480,
	height = 270,
	noise = 2.5,
	noiseModel = "table",
	seed = 8,
	onFrame,
}: {
	world: World;
	hfovDeg: number;
	yawMaxDeg: number;
	pitchMaxDeg: number;
	rollMaxDeg?: number;
	frameCount: number;
	width?: number;
	height?: number;
	noise?: number;
	noiseModel?: NoiseModel;
	seed?: number;
	onFrame: ({ frame, index }: { frame: GrayFrame; index: number }) => void;
}): HomographyTruth {
	if (!Number.isInteger(frameCount) || frameCount < 1) {
		throw new RangeError(`frameCount must be a positive integer, got ${frameCount}`);
	}
	const focal = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
	const wcx = world.width / 2;
	const wcy = world.height / 2;
	const deg = Math.PI / 180;
	const rotations: Mat3[] = [];
	for (let t = 0; t < frameCount; t++) {
		const u = frameCount > 1 ? t / (frameCount - 1) : 0;
		rotations.push(
			rotation({
				yaw: yawMaxDeg * u * deg,
				pitch: pitchMaxDeg * Math.sin(Math.PI * u) * deg,
				roll: rollMaxDeg * Math.sin(2 * Math.PI * u) * deg,
			}),
		);
	}
	/** Frame pixel to world pixel for a camera with rotation `r`. */
	const frameToWorld = ({ r, x, y }: { r: Mat3; x: number; y: number }) => {
		const d0 = (x - width / 2) / focal;
		const d1 = (y - height / 2) / focal;
		const r0 = r[0][0] * d0 + r[1][0] * d1 + r[2][0];
		const r1 = r[0][1] * d0 + r[1][1] * d1 + r[2][1];
		const r2 = r[0][2] * d0 + r[1][2] * d1 + r[2][2];
		return { x: wcx + (focal * r0) / r2, y: wcy + (focal * r1) / r2 };
	};
	const worldToFrame = ({ r, x, y }: { r: Mat3; x: number; y: number }) => {
		const d0 = (x - wcx) / focal;
		const d1 = (y - wcy) / focal;
		const r0 = r[0][0] * d0 + r[0][1] * d1 + r[0][2];
		const r1 = r[1][0] * d0 + r[1][1] * d1 + r[1][2];
		const r2 = r[2][0] * d0 + r[2][1] * d1 + r[2][2];
		return { x: width / 2 + (focal * r0) / r2, y: height / 2 + (focal * r1) / r2 };
	};

	const nextNoise = makeNoise({ model: noiseModel, sigma: noise, seed });
	const data = new Uint8Array(width * height);
	const frame: GrayFrame = { w: width, h: height, data };
	const { data: pixels, width: ww, height: wh } = world;
	for (let t = 0; t < frameCount; t++) {
		const r = rotations[t];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const d0 = (x - width / 2) / focal;
				const d1 = (y - height / 2) / focal;
				const r0 = r[0][0] * d0 + r[1][0] * d1 + r[2][0];
				const r1 = r[0][1] * d0 + r[1][1] * d1 + r[2][1];
				const r2 = r[0][2] * d0 + r[1][2] * d1 + r[2][2];
				const sx = wcx + (focal * r0) / r2;
				const sy = wcy + (focal * r1) / r2;
				const ix = Math.floor(sx);
				const iy = Math.floor(sy);
				let v = 128;
				if (ix >= 0 && iy >= 0 && ix < ww - 1 && iy < wh - 1) {
					const fx = sx - ix;
					const fy = sy - iy;
					const i = iy * ww + ix;
					v =
						(pixels[i] * (1 - fx) + pixels[i + 1] * fx) * (1 - fy) +
						(pixels[i + ww] * (1 - fx) + pixels[i + ww + 1] * fx) * fy;
				}
				v += nextNoise();
				data[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
			}
		}
		onFrame({ frame, index: t });
	}
	return {
		frameCount,
		width,
		height,
		truthPoint: ({ t, x, y }) => {
			const w = frameToWorld({ r: rotations[0], x, y });
			return worldToFrame({ r: rotations[t], x: w.x, y: w.y });
		},
	};
}
