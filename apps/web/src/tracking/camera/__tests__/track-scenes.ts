/**
 * Hand-made feature tracks for the solver tests: scenes that move by a known
 * similarity or homography path, with lifetimes, noise and outliers of choice.
 */
import { hApply } from "../homography";
import { createRng, gaussianSample } from "../random";
import { mapPoint, solvePin, type SolveOptions } from "../solve-pin";
import type { FeatureTracks, PinModel, PinSolution } from "../types";
import { FRAME_H, FRAME_W, type Point, type TrackSpec } from "./camera-fixtures";

export const C: Point = { x: FRAME_W / 2, y: FRAME_H / 2 };
export const CORNERS: Point[] = [
	{ x: 60, y: 40 },
	{ x: 420, y: 40 },
	{ x: 420, y: 230 },
	{ x: 60, y: 230 },
	{ x: 240, y: 135 },
];

/** The scene point that sits at `p0` on frame 0 is at `sceneAt(t, p0)` on frame t. */
export function sceneAt({ t, p0 }: { t: number; p0: Point }): Point {
	const s = 1 + 0.004 * t;
	const th = 0.0015 * t;
	const dx = p0.x - C.x;
	const dy = p0.y - C.y;
	return {
		x: C.x + s * (Math.cos(th) * dx - Math.sin(th) * dy) + 0.6 * t,
		y: C.y + s * (Math.sin(th) * dx + Math.cos(th) * dy) - 0.35 * t,
	};
}

export function sceneInverse({ t, q }: { t: number; q: Point }): Point {
	const s = 1 + 0.004 * t;
	const th = 0.0015 * t;
	const dx = q.x - C.x - 0.6 * t;
	const dy = q.y - C.y + 0.35 * t;
	return {
		x: C.x + (Math.cos(th) * dx + Math.sin(th) * dy) / s,
		y: C.y + (-Math.sin(th) * dx + Math.cos(th) * dy) / s,
	};
}

/** Where a frame-`f0` point should be on frame `t`. */
export function truthSimilarity({ f0, t, q }: { f0: number; t: number; q: Point }): Point {
	return sceneAt({ t, p0: sceneInverse({ t: f0, q }) });
}

/** A mild perspective path: identity at t = 0. */
export function homographyOf({ t }: { t: number }): Float64Array {
	return Float64Array.from([
		1 + 0.0008 * t,
		-0.0004 * t,
		0.5 * t,
		0.0003 * t,
		1 + 0.0006 * t,
		-0.3 * t,
		2e-6 * t,
		-1e-6 * t,
		1,
	]);
}

export function inverse3({ h }: { h: Float64Array }): Float64Array {
	const [a, b, c, d, e, f, g, i, j] = h;
	const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
	return Float64Array.from([
		(e * j - f * i) / det,
		(c * i - b * j) / det,
		(b * f - c * e) / det,
		(f * g - d * j) / det,
		(a * j - c * g) / det,
		(c * d - a * f) / det,
		(d * i - e * g) / det,
		(b * g - a * i) / det,
		(a * e - b * d) / det,
	]);
}

export function truthHomography({ f0, t, q }: { f0: number; t: number; q: Point }): Point {
	const p0 = hApply({ h: inverse3({ h: homographyOf({ t: f0 }) }), x: q.x, y: q.y });
	return hApply({ h: homographyOf({ t }), x: p0.x, y: p0.y });
}

export type Motion = ({ t, p0 }: { t: number; p0: Point }) => Point;

export function specsFor({
	points,
	life,
	motion,
	noise = 0,
	seed = 1,
	outlierShare = 0,
	frameCount,
}: {
	points: Point[];
	/** Null leaves the track out. */
	life: ({ i }: { i: number }) => { start: number; end: number } | null;
	motion: Motion;
	noise?: number;
	seed?: number;
	outlierShare?: number;
	frameCount: number;
}): TrackSpec[] {
	const random = createRng({ seed });
	const specs: TrackSpec[] = [];
	points.forEach((p0, i) => {
		const span = life({ i });
		if (!span) return;
		specs.push({
			start: span.start,
			end: Math.min(span.end, frameCount - 1),
			positionAt: (t) => {
				const p = motion({ t, p0 });
				const jump = outlierShare > 0 && random() < outlierShare;
				return {
					x: p.x + (noise ? noise * gaussianSample({ random }) : 0) + (jump ? (random() - 0.5) * 60 : 0),
					y: p.y + (noise ? noise * gaussianSample({ random }) : 0) + (jump ? (random() - 0.5) * 60 : 0),
				};
			},
		});
	});
	return specs;
}

/**
 * Tracks that each live about 42 frames and are born steadily, a fifth of them
 * before frame 0 (so frame 0 is as busy as any other): about 60 are alive at
 * any frame.
 */
export function staggeredLife({
	frameCount,
	count,
}: {
	frameCount: number;
	count: number;
}): ({ i }: { i: number }) => { start: number; end: number } | null {
	return ({ i }) => {
		const born = Math.floor((i * (frameCount + 42)) / count) - 42;
		const end = born + 38 + (i % 9);
		return end < 0 ? null : { start: Math.max(0, born), end };
	};
}

export const whole = (frameCount: number) => () => ({ start: 0, end: frameCount - 1 });

export function worstError({
	solution,
	truth,
	frames,
}: {
	solution: PinSolution;
	truth: ({ f0, t, q }: { f0: number; t: number; q: Point }) => Point;
	frames?: number[];
}): number {
	let worst = 0;
	for (let t = 0; t < solution.frameCount; t++) {
		if (frames && !frames.includes(t)) continue;
		if (!solution.ok[t]) continue;
		for (const q of CORNERS) {
			const got = mapPoint({ solution, t, x: q.x, y: q.y });
			const want = truth({ f0: solution.f0, t, q });
			worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
		}
	}
	return worst;
}

export function allOk(solution: PinSolution): boolean {
	return solution.ok.every((v) => v === 1);
}

export function solveWith({
	tracks,
	f0,
	model = "S",
	options,
}: {
	tracks: FeatureTracks;
	f0: number;
	model?: PinModel;
	options?: Partial<SolveOptions>;
}) {
	return solvePin({ tracks, f0, model, mode: "scene", options });
}

export const truthFor = (model: PinModel) => (model === "S" ? truthSimilarity : truthHomography);
export const motionFor = (model: PinModel): Motion =>
	model === "S"
		? ({ t, p0 }) => sceneAt({ t, p0 })
		: ({ t, p0 }) => hApply({ h: homographyOf({ t }), x: p0.x, y: p0.y });

