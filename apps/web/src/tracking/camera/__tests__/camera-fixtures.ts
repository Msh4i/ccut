/**
 * Shared helpers of the camera tracker tests: cached synthetic worlds, a
 * streaming "analyse a generated sequence" runner, ground-truth error metrics
 * (the same ones the measurement prototypes used) and a builder for synthetic
 * feature tracks that need no image at all.
 */
import {
	generateHomographySequence,
	groundTruthMap,
	makeWorld,
	renderSequence,
	type Foreground,
	type HomographyTruth,
	type NoiseModel,
	type SequenceOptions,
	type SequenceTruth,
	type World,
} from "../camera-synth";
import { createRng, gaussianSample } from "../random";
import { applySim } from "../similarity";
import { mapPoint, similarityAt } from "../solve-pin";
import { FeatureTracker, type TrackerOptions } from "../tracker";
import type { FeatureTracks, PinSolution } from "../types";

export const FRAME_W = 480;
export const FRAME_H = 270;
/** The frame rate every synthetic clip is analysed at. */
export const FPS = 30;

export interface Point {
	x: number;
	y: number;
}

/** Prints the measured values of a test when `CAMTRACK_VERBOSE=1`, so the numbers can be read next to the limits. */
export function report({
	label,
	values,
}: {
	label: string;
	values: Record<string, number | string>;
}): void {
	if (process.env.CAMTRACK_VERBOSE !== "1") return;
	const text = Object.entries(values)
		.map(([key, value]) => `${key} ${typeof value === "number" ? value.toFixed(2) : value}`)
		.join(" | ");
	console.log(`MEASURED ${label}: ${text}`);
}

/** Pin position in px@480 on frame `f0`. */
export interface PinSpec {
	f0: number;
	pin: Point;
}

// ---------------------------------------------------------------------------
// Worlds and analyses (cached, release with `releaseCaches`)
// ---------------------------------------------------------------------------

const worlds = new Map<string, World>();
const analyses = new Map<string, Analysis>();

interface WorldSpec {
	width: number;
	height: number;
	seed: number;
	texture: number | undefined;
	shapes: number | undefined;
}

const worldSpecs = new Map<string, string>();

/**
 * A world is 28 MB: build it once per key and let `releaseCaches` drop it. A
 * key stands for one set of parameters; asking for the same key with others is
 * an error (the cached world would silently be the wrong one).
 */
export function getWorld({
	key,
	width = 3200,
	height = 2200,
	seed,
	texture,
	shapes,
}: {
	key: string;
	width?: number;
	height?: number;
	seed: number;
	texture?: number;
	shapes?: number;
}): World {
	const spec: WorldSpec = { width, height, seed, texture, shapes };
	const described = JSON.stringify(spec);
	const cached = worlds.get(key);
	if (cached) {
		if (worldSpecs.get(key) !== described) {
			throw new Error(`world "${key}" was built as ${worldSpecs.get(key)}, not ${described}`);
		}
		return cached;
	}
	const world = makeWorld({ width, height, seed, texture, shapes });
	worlds.set(key, world);
	worldSpecs.set(key, described);
	return world;
}

/**
 * Drops the cached analyses and every world but "main", which nearly every test
 * file needs and which bun's single process shares between files.
 */
export function releaseCaches(): void {
	for (const key of [...worlds.keys()]) {
		if (key === "main") continue;
		worlds.delete(key);
		worldSpecs.delete(key);
	}
	analyses.clear();
}

export interface Analysis {
	tracks: FeatureTracks;
	truth: SequenceTruth;
	/** Wall-clock of the tracker only, not of the frame generation. */
	trackerMs: number;
}

/** Generates `options` frame by frame and feeds each straight into a tracker. */
export function analyse({
	world,
	options,
	trackerOptions,
	mapFrame,
}: {
	world: World;
	options: SequenceOptions;
	trackerOptions?: Partial<TrackerOptions>;
	/** Rewrites a frame in place before the tracker sees it (degradation). */
	mapFrame?: ({ data, index }: { data: Uint8Array; index: number }) => void;
}): Analysis {
	const tracker = new FeatureTracker({
		w: options.width ?? FRAME_W,
		h: options.height ?? FRAME_H,
		fps: FPS,
		options: trackerOptions,
	});
	let trackerMs = 0;
	const truth = renderSequence({
		world,
		options,
		onFrame: ({ frame, index }) => {
			mapFrame?.({ data: frame.data, index });
			const t0 = performance.now();
			tracker.push(frame);
			trackerMs += performance.now() - t0;
		},
	});
	return { tracks: tracker.finish(), truth, trackerMs };
}

/** Same as `analyse`, remembered under `key` so several tests share the work. */
export function cachedAnalysis({
	key,
	make,
}: {
	key: string;
	make: () => Analysis;
}): Analysis {
	const cached = analyses.get(key);
	if (cached) return cached;
	const made = make();
	analyses.set(key, made);
	return made;
}

// ---------------------------------------------------------------------------
// Sequence catalogue shared by the accuracy tests
// ---------------------------------------------------------------------------

export const FG_COMBO: Foreground[] = [
	{ x0: 40, y0: 50, vx: 1.4, vy: 0.6, radius: 35 },
];
export const FG_LONG: Foreground[] = [
	{ x0: 60, y0: 40, vx: 0.5, vy: 0.3, ax: 60, ay: 40, radius: 30 },
];

/** The four pins every measurement sequence is solved from. */
export function standardPins({ frameCount }: { frameCount: number }): PinSpec[] {
	return [
		{ f0: 0, pin: { x: 240, y: 135 } },
		{ f0: 0, pin: { x: 110, y: 200 } },
		{ f0: Math.floor(frameCount / 2), pin: { x: 330, y: 90 } },
		{ f0: Math.floor(frameCount / 3), pin: { x: 180, y: 120 } },
	];
}

// ---------------------------------------------------------------------------
// Error metrics against ground truth
// ---------------------------------------------------------------------------

export interface PinRow {
	t: number;
	/** The pin's true position is inside the frame on this frame. */
	visible: boolean;
	ok: boolean;
	posErr: number;
	/** Worst of the four box corners, px@480. */
	cornerMax: number;
	scaleErrPct: number;
	rotErrDeg: number;
}

export interface PinSummary {
	rows: number;
	solved: number;
	posRms: number;
	posMax: number;
	cornerRms: number;
	cornerMax: number;
	scaleMaxPct: number;
	rotMaxDeg: number;
	/** Mean corner error over the last 30 visible solved frames. */
	drift: number;
}

export const PROBE_BOX = { hw: 50, hh: 25 };

function boxCorners({
	pin,
	box,
}: {
	pin: Point;
	box: { hw: number; hh: number };
}): Point[] {
	return [
		{ x: pin.x - box.hw, y: pin.y - box.hh },
		{ x: pin.x + box.hw, y: pin.y - box.hh },
		{ x: pin.x + box.hw, y: pin.y + box.hh },
		{ x: pin.x - box.hw, y: pin.y + box.hh },
	];
}

/** Similarity solution against the generator's true camera path. */
export function evaluateSimilarity({
	solution,
	truth,
	pin,
	box = PROBE_BOX,
}: {
	solution: PinSolution;
	truth: SequenceTruth;
	pin: Point;
	box?: { hw: number; hh: number };
}): PinRow[] {
	const corners = boxCorners({ pin, box });
	const rows: PinRow[] = [];
	for (let t = 0; t < solution.frameCount; t++) {
		const g = groundTruthMap({
			truth: truth.truth,
			f0: solution.f0,
			t,
			width: truth.width,
			height: truth.height,
		});
		const e = similarityAt({ solution, t });
		const pe = applySim({ map: e, x: pin.x, y: pin.y });
		const pg = applySim({ map: g, x: pin.x, y: pin.y });
		let cornerMax = 0;
		for (const c of corners) {
			const a = applySim({ map: e, x: c.x, y: c.y });
			const b = applySim({ map: g, x: c.x, y: c.y });
			cornerMax = Math.max(cornerMax, Math.hypot(a.x - b.x, a.y - b.y));
		}
		let dth =
			((Math.atan2(e.ai, e.ar) - Math.atan2(g.ai, g.ar)) * 180) / Math.PI;
		dth = ((((dth + 180) % 360) + 360) % 360) - 180;
		rows.push({
			t,
			visible: pg.x >= 0 && pg.x <= truth.width && pg.y >= 0 && pg.y <= truth.height,
			ok: solution.ok[t] === 1,
			posErr: Math.hypot(pe.x - pg.x, pe.y - pg.y),
			cornerMax,
			scaleErrPct: (Math.hypot(e.ar, e.ai) / Math.hypot(g.ar, g.ai) - 1) * 100,
			rotErrDeg: dth,
		});
	}
	return rows;
}

/** Same metrics over the frames where the pin is visible and was solved. */
export function summarizeRows({ rows }: { rows: PinRow[] }): PinSummary {
	const visible = rows.filter((r) => r.visible);
	const ok = visible.filter((r) => r.ok);
	const rms = (pick: (r: PinRow) => number) =>
		Math.sqrt(ok.reduce((s, r) => s + pick(r) ** 2, 0) / Math.max(1, ok.length));
	const max = (pick: (r: PinRow) => number) =>
		ok.reduce((m, r) => Math.max(m, Math.abs(pick(r))), 0);
	const last = visible.slice(-30).filter((r) => r.ok);
	return {
		rows: visible.length,
		solved: ok.length,
		posRms: rms((r) => r.posErr),
		posMax: max((r) => r.posErr),
		cornerRms: rms((r) => r.cornerMax),
		cornerMax: max((r) => r.cornerMax),
		scaleMaxPct: max((r) => r.scaleErrPct),
		rotMaxDeg: max((r) => r.rotErrDeg),
		drift:
			last.reduce((s, r) => s + Math.abs(r.cornerMax), 0) /
			Math.max(1, last.length),
	};
}

export interface WorstOfPins {
	cornerMax: number;
	cornerRms: number;
	/** Mean over the pins of the position error rms. */
	posRms: number;
	posMax: number;
	scaleMaxPct: number;
	rotMaxDeg: number;
	drift: number;
	/** Visible frames over all pins, and how many of them were solved. */
	rows: number;
	solved: number;
	/** Visible solved frames whose worst corner is more than 1 px off. */
	over1px: number;
}

/**
 * Solves every pin with `solve` and reports the worst of each metric (the mean
 * for `posRms`, as the prototype table did).
 */
export function evaluatePins({
	analysis,
	pins,
	solve,
}: {
	analysis: Analysis;
	pins: PinSpec[];
	solve: (spec: PinSpec) => PinSolution;
}): WorstOfPins {
	const worst: WorstOfPins = {
		cornerMax: 0,
		cornerRms: 0,
		posRms: 0,
		posMax: 0,
		scaleMaxPct: 0,
		rotMaxDeg: 0,
		drift: 0,
		rows: 0,
		solved: 0,
		over1px: 0,
	};
	for (const spec of pins) {
		const rows = evaluateSimilarity({
			solution: solve(spec),
			truth: analysis.truth,
			pin: spec.pin,
		});
		const s = summarizeRows({ rows });
		worst.cornerMax = Math.max(worst.cornerMax, s.cornerMax);
		worst.cornerRms = Math.max(worst.cornerRms, s.cornerRms);
		worst.posRms += s.posRms / pins.length;
		worst.posMax = Math.max(worst.posMax, s.posMax);
		worst.scaleMaxPct = Math.max(worst.scaleMaxPct, s.scaleMaxPct);
		worst.rotMaxDeg = Math.max(worst.rotMaxDeg, s.rotMaxDeg);
		worst.drift = Math.max(worst.drift, s.drift);
		worst.rows += s.rows;
		worst.solved += s.solved;
		worst.over1px += rows.filter(
			(r) => r.visible && r.ok && r.cornerMax > 1,
		).length;
	}
	return worst;
}

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

/**
 * A frame of a heavily compressed clip (CRF 38 and beyond), emulated: detail
 * is smeared by a [1 2 1] blur in both directions and the compression noise
 * is added on top. On the measurement scene this gives a median residual rms
 * of 0.88 px, real CRF 38 files gave 1.09 and 1.17 (CRF 23: 0.11-0.20).
 */
export function degradeLikeLowBitrate({
	data,
	width,
	height,
	noise = 12,
	seed,
}: {
	data: Uint8Array;
	width: number;
	height: number;
	noise?: number;
	seed: number;
}): void {
	const random = createRng({ seed });
	const horizontal = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const left = data[y * width + Math.max(0, x - 1)];
			const right = data[y * width + Math.min(width - 1, x + 1)];
			horizontal[y * width + x] = (left + 2 * data[y * width + x] + right) / 4;
		}
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const up = horizontal[Math.max(0, y - 1) * width + x];
			const down = horizontal[Math.min(height - 1, y + 1) * width + x];
			const v = (up + 2 * horizontal[y * width + x] + down) / 4 + noise * gaussianSample({ random });
			data[y * width + x] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
		}
	}
}

/** Box blur of radius `radius` in both directions, in place (a frame the camera could not focus). */
export function boxBlurInPlace({
	data,
	width,
	height,
	radius,
}: {
	data: Uint8Array;
	width: number;
	height: number;
	radius: number;
}): void {
	const horizontal = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				sum += data[y * width + Math.min(width - 1, Math.max(0, x + k))];
			}
			horizontal[y * width + x] = sum / (2 * radius + 1);
		}
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				sum += horizontal[Math.min(height - 1, Math.max(0, y + k)) * width + x];
			}
			data[y * width + x] = Math.round(sum / (2 * radius + 1));
		}
	}
}

// ---------------------------------------------------------------------------
// Perspective oracle (the real projection lives in slice T3)
// ---------------------------------------------------------------------------

/** Jacobian of the homography at (x, y): [dx'/dx, dx'/dy, dy'/dx, dy'/dy]. */
function homographyJacobian({
	h,
	x,
	y,
}: {
	h: Float64Array;
	x: number;
	y: number;
}): [number, number, number, number] {
	const w = h[6] * x + h[7] * y + h[8];
	const nx = h[0] * x + h[1] * y + h[2];
	const ny = h[3] * x + h[4] * y + h[5];
	const w2 = w * w;
	return [
		(h[0] * w - nx * h[6]) / w2,
		(h[1] * w - nx * h[7]) / w2,
		(h[3] * w - ny * h[6]) / w2,
		(h[4] * w - ny * h[7]) / w2,
	];
}

/** Best `R(theta) * diag(sx, sy)` for a 2x2 Jacobian, the family the renderer can draw. */
function projectRotationScale({ jac }: { jac: number[] }) {
	const [a, b, c, d] = jac;
	const t1 = Math.atan2(c, a);
	const t2 = Math.atan2(-b, d);
	const raw = t2 - t1;
	const dt = raw - 2 * Math.PI * Math.round(raw / (2 * Math.PI));
	const theta = t1 + dt / 2;
	return {
		theta,
		sx: a * Math.cos(theta) + c * Math.sin(theta),
		sy: d * Math.cos(theta) - b * Math.sin(theta),
	};
}

export interface ModelComparison {
	/** Worst corner gap between the similarity and the rotation-scale fit of H. */
	disagreement: number;
	/** Worst corner error of the similarity solution. */
	similarityError: number;
	/** Worst corner error of the rotation-scale fit of H (what slice T3 will write). */
	rotationScaleError: number;
	/** Worst corner error of the full homography (what the renderer cannot draw). */
	homographyError: number;
	frames: number;
}

/**
 * Corner errors of the S solution and of H reduced to the renderer's family,
 * over the frames where both solved and the pin is visible. `truthMapAt` maps
 * a frame-`f0` point to its true place on frame `t`.
 */
export function compareModelsOnBox({
	similarity,
	homography,
	pin,
	box = PROBE_BOX,
	truthMapAt,
}: {
	similarity: PinSolution;
	homography: PinSolution;
	pin: Point;
	box?: { hw: number; hh: number };
	truthMapAt: ({ t, x, y }: { t: number; x: number; y: number }) => Point;
}): ModelComparison {
	const result: ModelComparison = {
		disagreement: 0,
		similarityError: 0,
		rotationScaleError: 0,
		homographyError: 0,
		frames: 0,
	};
	const corners = [
		[-box.hw, -box.hh],
		[box.hw, -box.hh],
		[box.hw, box.hh],
		[-box.hw, box.hh],
	];
	for (let t = 0; t < similarity.frameCount; t++) {
		if (!similarity.ok[t] || !homography.ok[t]) continue;
		const pg = truthMapAt({ t, x: pin.x, y: pin.y });
		if (pg.x < 0 || pg.x > FRAME_W || pg.y < 0 || pg.y > FRAME_H) continue;
		const h = homography.maps.subarray(9 * t, 9 * t + 9);
		const jac = homographyJacobian({ h, x: pin.x, y: pin.y });
		const centre = mapPoint({ solution: homography, t, x: pin.x, y: pin.y });
		const rs = projectRotationScale({ jac });
		const cs = Math.cos(rs.theta);
		const sn = Math.sin(rs.theta);
		let d = 0;
		let eS = 0;
		let eR = 0;
		let eH = 0;
		for (const [dx, dy] of corners) {
			const s = mapPoint({ solution: similarity, t, x: pin.x + dx, y: pin.y + dy });
			const r = {
				x: centre.x + cs * rs.sx * dx - sn * rs.sy * dy,
				y: centre.y + sn * rs.sx * dx + cs * rs.sy * dy,
			};
			const full = mapPoint({ solution: homography, t, x: pin.x + dx, y: pin.y + dy });
			const truth = truthMapAt({ t, x: pin.x + dx, y: pin.y + dy });
			d = Math.max(d, Math.hypot(s.x - r.x, s.y - r.y));
			eS = Math.max(eS, Math.hypot(s.x - truth.x, s.y - truth.y));
			eR = Math.max(eR, Math.hypot(r.x - truth.x, r.y - truth.y));
			eH = Math.max(eH, Math.hypot(full.x - truth.x, full.y - truth.y));
		}
		result.disagreement = Math.max(result.disagreement, d);
		result.similarityError = Math.max(result.similarityError, eS);
		result.rotationScaleError = Math.max(result.rotationScaleError, eR);
		result.homographyError = Math.max(result.homographyError, eH);
		result.frames++;
	}
	return result;
}

/** A homography camera analysed frame by frame, like `analyse` for similarity cameras. */
export function analyseHomography({
	world,
	hfovDeg,
	yawMaxDeg,
	pitchMaxDeg,
	frameCount,
	noiseModel,
	trackerOptions,
}: {
	world: World;
	hfovDeg: number;
	yawMaxDeg: number;
	pitchMaxDeg: number;
	frameCount: number;
	noiseModel?: NoiseModel;
	trackerOptions?: Partial<TrackerOptions>;
}): { tracks: FeatureTracks; truth: HomographyTruth } {
	const tracker = new FeatureTracker({
		w: FRAME_W,
		h: FRAME_H,
		fps: FPS,
		options: trackerOptions,
	});
	const truth = generateHomographySequence({
		world,
		hfovDeg,
		yawMaxDeg,
		pitchMaxDeg,
		frameCount,
		noiseModel,
		onFrame: ({ frame }) => tracker.push(frame),
	});
	return { tracks: tracker.finish(), truth };
}

// ---------------------------------------------------------------------------
// Feature tracks without images
// ---------------------------------------------------------------------------

export interface TrackSpec {
	/** First and last frame (inclusive) the track has a sample on. */
	start: number;
	end: number;
	/** Where the track is on frame `t`. */
	positionAt: (t: number) => Point;
}

/** Packs hand-made tracks into the `FeatureTracks` layout the solver reads. */
export function buildTracks({
	frameCount,
	specs,
	cuts = [],
	w = FRAME_W,
	h = FRAME_H,
	fps = FPS,
}: {
	frameCount: number;
	specs: TrackSpec[];
	cuts?: number[];
	w?: number;
	h?: number;
	fps?: number;
}): FeatureTracks {
	const trackStart = new Int32Array(specs.length);
	const trackLen = new Int32Array(specs.length);
	const trackOffset = new Int32Array(specs.length);
	let total = 0;
	for (let i = 0; i < specs.length; i++) {
		trackStart[i] = specs[i].start;
		trackLen[i] = specs[i].end - specs[i].start + 1;
		trackOffset[i] = total;
		total += 2 * trackLen[i];
	}
	const xy = new Float32Array(total);
	for (let i = 0; i < specs.length; i++) {
		for (let j = 0; j < trackLen[i]; j++) {
			const p = specs[i].positionAt(specs[i].start + j);
			xy[trackOffset[i] + 2 * j] = p.x;
			xy[trackOffset[i] + 2 * j + 1] = p.y;
		}
	}
	const liveOffsets = new Int32Array(frameCount + 1);
	const live: number[] = [];
	for (let f = 0; f < frameCount; f++) {
		for (let i = 0; i < specs.length; i++) {
			if (specs[i].start <= f && f <= specs[i].end) live.push(i);
		}
		liveOffsets[f + 1] = live.length;
	}
	return {
		w,
		h,
		frameCount,
		fps,
		trackStart,
		trackLen,
		trackOffset,
		xy,
		liveOffsets,
		liveIds: Int32Array.from(live),
		cuts: [...cuts],
		stats: {
			lostFraction: new Float32Array(frameCount),
			cutNcc: [],
		},
	};
}

/** Seeded scatter of `count` points inside the frame, away from the border. */
export function scatterPoints({
	count,
	seed,
	margin = 20,
}: {
	count: number;
	seed: number;
	margin?: number;
}): Point[] {
	const random = createRng({ seed });
	return Array.from({ length: count }, () => ({
		x: margin + random() * (FRAME_W - 2 * margin),
		y: margin + random() * (FRAME_H - 2 * margin),
	}));
}
