import { frameCentre } from "./frame-coordinates";
import { mapPoint, segmentBounds } from "./solve-pin";
import type { CameraNotice, FeatureTracks, PinSolution } from "./types";

export interface ClassifyOptions {
	/** The pin is judged by this many features nearest to it ... */
	neighbours: number;
	/** ... among those within this many px of it on the pin frame. */
	maxDist: number;
	/** A feature must be followed at least this many frames from the pin frame to count. */
	minLife: number;
	/** Its motion is measured over at most this many frames. */
	maxLife: number;
	/** Median speed against the scene (px per frame) above which the pin is on an object. */
	speedThreshold: number;
}

export const DEFAULT_CLASSIFY_OPTIONS: Readonly<ClassifyOptions> = {
	neighbours: 5,
	maxDist: 50,
	minLife: 10,
	maxLife: 40,
	speedThreshold: 0.1,
};

export interface ClassifyResult {
	isObject: boolean;
	/** Median speed of the nearest features against the scene model, px per frame. */
	velocity: number;
	/** How many features that median is over; under 3 the classifier says nothing. */
	n: number;
}

/**
 * Is the pin sitting on something that moves on its own? The features nearest
 * to the pin are compared with where the scene solution says they should be
 * `maxLife` frames later (or earlier): background features stay on the model,
 * features on a moving object drift away from it at their own speed.
 *
 * With fewer than three usable features nearby it stays quiet (`isObject:
 * false`, `n < 3`) and the scene mode is kept.
 */
export function classifyPin({
	tracks,
	solution,
	pin,
	options,
}: {
	tracks: FeatureTracks;
	/** The scene solution from the pin frame. */
	solution: PinSolution;
	/** Pin position on the pin frame, px@480. */
	pin: { x: number; y: number };
	options?: Partial<ClassifyOptions>;
}): ClassifyResult {
	if (solution.frameCount !== tracks.frameCount) {
		throw new RangeError(
			`solution covers ${solution.frameCount} frames, the tracks ${tracks.frameCount}`,
		);
	}
	if (solution.mode !== "scene") throw new TypeError("classifyPin needs the scene solution");
	const o = { ...DEFAULT_CLASSIFY_OPTIONS, ...options };
	const { f0 } = solution;
	const { liveOffsets, liveIds, trackStart, trackLen, trackOffset, xy } = tracks;

	const near: { id: number; d: number; x: number; y: number }[] = [];
	for (let q = liveOffsets[f0]; q < liveOffsets[f0 + 1]; q++) {
		const id = liveIds[q];
		const i = trackOffset[id] + 2 * (f0 - trackStart[id]);
		const d = Math.hypot(xy[i] - pin.x, xy[i + 1] - pin.y);
		if (d <= o.maxDist) near.push({ id, d, x: xy[i], y: xy[i + 1] });
	}
	near.sort((a, b) => a.d - b.d);

	const speeds: number[] = [];
	for (const c of near) {
		if (speeds.length >= o.neighbours) break;
		const first = trackStart[c.id];
		const last = first + trackLen[c.id] - 1;
		const forward = Math.min(last - f0, o.maxLife);
		const backward = Math.min(f0 - first, o.maxLife);
		const dt = forward >= backward ? forward : -backward;
		if (Math.abs(dt) < o.minLife) continue;
		const t = f0 + dt;
		if (!solution.ok[t]) continue;
		const expected = mapPoint({ solution, t, x: c.x, y: c.y });
		const j = trackOffset[c.id] + 2 * (t - first);
		speeds.push(Math.hypot(expected.x - xy[j], expected.y - xy[j + 1]) / Math.abs(dt));
	}
	if (speeds.length < 3) return { isObject: false, velocity: 0, n: speeds.length };
	speeds.sort((a, b) => a - b);
	const velocity = speeds[speeds.length >> 1];
	return { isObject: velocity > o.speedThreshold, velocity, n: speeds.length };
}

/** Residual p90 (px@480 of the similarity fit) above which a similarity is probably the wrong model. */
const PERSPECTIVE_P90 = 0.55;

/**
 * Should the homography be computed too? A pan over a flat scene is a
 * perspective change, which a similarity fits with a larger residual in the
 * worst tenth of the frames. This only opens the gate: whether H is then used
 * is decided by how far apart the two models put the element's corners.
 */
export function perspectiveSuspected({
	solution,
	threshold = PERSPECTIVE_P90,
}: {
	/** A similarity solution. */
	solution: PinSolution;
	threshold?: number;
}): { suspected: boolean; p90: number } {
	if (solution.model !== "S") throw new TypeError("perspectiveSuspected needs a similarity solution");
	const values = residualsOf({ solution, lo: 0, hi: solution.frameCount - 1 });
	if (values.length === 0) return { suspected: false, p90: 0 };
	const p90 = values[Math.floor(values.length * 0.9)];
	return { suspected: p90 > threshold, p90 };
}

/** Residual rms of the solved pair fits in frames `[lo, hi]`, ascending. */
function residualsOf({
	solution,
	lo,
	hi,
}: {
	solution: PinSolution;
	lo: number;
	hi: number;
}): Float64Array {
	const out: number[] = [];
	for (let t = lo; t <= hi; t++) {
		if (solution.ok[t] && solution.nin[t] > 0) out.push(solution.rms[t]);
	}
	return Float64Array.from(out).sort();
}

/**
 * Median inlier count of the solved pair fits in frames `[lo, hi]` (the frames
 * {@link residualsOf} reads), 0 when there is none.
 */
function medianInliersOf({
	solution,
	lo,
	hi,
}: {
	solution: PinSolution;
	lo: number;
	hi: number;
}): number {
	const out: number[] = [];
	for (let t = lo; t <= hi; t++) {
		if (solution.ok[t] && solution.nin[t] > 0) out.push(solution.nin[t]);
	}
	if (out.length === 0) return 0;
	return Float64Array.from(out).sort()[out.length >> 1];
}

export interface CameraQualityStats {
	/** Median number of live features per frame. */
	medianLive: number;
	/** Share of the frames that were solved (`ok > 0`), frames after a bridged gap included. */
	solvedFraction: number;
	/**
	 * How far the camera moved over the frames, against the solved frame nearest
	 * the pin (the pin frame itself when it is in the window): the largest move
	 * of the scene point that sits at the picture centre there, px@480.
	 */
	maxShift: number;
	/** Largest |scale - 1| against that frame. */
	maxScaleDeviation: number;
	/** Largest rotation against that frame, degrees. */
	maxRotationDeg: number;
	/** Median residual rms of the pair fits, px@480; 0 when nothing was solved. */
	medianResidual: number;
}

/** Frames of the analysis, inclusive. */
export interface FrameWindow {
	first: number;
	last: number;
}

/**
 * The frames the statistics and notices are about: `window` (the frames the
 * element is on; the whole clip when left out) within the solution's range.
 * Throws a `RangeError` for a window that is not in the clip or does not meet
 * the range.
 */
function frameSpan({
	tracks,
	solution,
	window,
}: {
	tracks: FeatureTracks;
	solution: PinSolution;
	window: FrameWindow | undefined;
}): { lo: number; hi: number } {
	if (solution.frameCount !== tracks.frameCount) {
		throw new RangeError(
			`solution covers ${solution.frameCount} frames, the tracks ${tracks.frameCount}`,
		);
	}
	const first = window?.first ?? 0;
	const last = window?.last ?? tracks.frameCount - 1;
	if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last >= tracks.frameCount || first > last) {
		throw new RangeError(`window ${first}..${last} must be whole frames of the clip (0..${tracks.frameCount - 1})`);
	}
	const lo = Math.max(first, solution.range.lo);
	const hi = Math.min(last, solution.range.hi);
	if (lo > hi) {
		throw new RangeError(
			`window ${first}..${last} does not meet the solved frames ${solution.range.lo}..${solution.range.hi}`,
		);
	}
	return { lo, hi };
}

/**
 * Numbers behind `qualityNotices`, over the frames of `window` that are in the
 * pin's scene (between cuts) and range.
 */
export function cameraQualityStats({
	tracks,
	solution,
	window,
}: {
	tracks: FeatureTracks;
	/** The similarity scene solution. */
	solution: PinSolution;
	window?: FrameWindow;
}): CameraQualityStats {
	if (solution.model !== "S") throw new TypeError("quality needs a similarity solution");
	const { lo, hi } = frameSpan({ tracks, solution, window });
	const frames = hi - lo + 1;
	const live = new Int32Array(frames);
	let solved = 0;
	let maxShift = 0;
	let maxScaleDeviation = 0;
	let maxRotationDeg = 0;
	const centre = frameCentre({ w: tracks.w, h: tracks.h });
	const m = solution.maps;
	// the reference: the solved frame of the window nearest the pin frame
	let ref = -1;
	for (let t = lo; t <= hi; t++) {
		live[t - lo] = tracks.liveOffsets[t + 1] - tracks.liveOffsets[t];
		if (!solution.ok[t]) continue;
		solved++;
		if (ref < 0 || Math.abs(t - solution.f0) < Math.abs(ref - solution.f0)) ref = t;
	}
	if (ref >= 0) {
		// frame `ref` to frame `t`: z' = a_t (z - b_ref) / a_ref + b_t, with the picture centre as z
		const aRefR = m[4 * ref];
		const aRefI = m[4 * ref + 1];
		const aRefN = aRefR * aRefR + aRefI * aRefI;
		const zr = centre.x - m[4 * ref + 2];
		const zi = centre.y - m[4 * ref + 3];
		// (z - b_ref) / a_ref
		const qr = (zr * aRefR + zi * aRefI) / aRefN;
		const qi = (zi * aRefR - zr * aRefI) / aRefN;
		for (let t = lo; t <= hi; t++) {
			if (!solution.ok[t]) continue;
			const ar = m[4 * t];
			const ai = m[4 * t + 1];
			const x = ar * qr - ai * qi + m[4 * t + 2];
			const y = ar * qi + ai * qr + m[4 * t + 3];
			maxShift = Math.max(maxShift, Math.hypot(x - centre.x, y - centre.y));
			// a_t / a_ref
			const rr = (ar * aRefR + ai * aRefI) / aRefN;
			const ri = (ai * aRefR - ar * aRefI) / aRefN;
			maxScaleDeviation = Math.max(maxScaleDeviation, Math.abs(Math.hypot(rr, ri) - 1));
			maxRotationDeg = Math.max(maxRotationDeg, Math.abs((Math.atan2(ri, rr) * 180) / Math.PI));
		}
	}
	live.sort();
	const residuals = residualsOf({ solution, lo, hi });
	return {
		medianLive: live[frames >> 1],
		solvedFraction: solved / frames,
		maxShift,
		maxScaleDeviation,
		maxRotationDeg,
		medianResidual: residuals.length ? residuals[residuals.length >> 1] : 0,
	};
}

/**
 * Is the median residual of the solved pair fits (any model, `window` as for
 * {@link qualityNotices}) above the low-quality line? The pin judges the
 * quality of the motion model it writes with this: a similarity that misfits a
 * perspective pan says nothing about the video, a homography that still misfits
 * says the tracks are noisy.
 */
export function hasLowQualityResidual(args: ResidualQualityArgs): boolean {
	return residualQuality(args) === "low";
}

interface ResidualQualityArgs {
	tracks: FeatureTracks;
	solution: PinSolution;
	window?: FrameWindow;
}

/**
 * The same judgement with a third answer: "unknown" when there is no evidence
 * of good quality. A caller that DROPS a warning on good quality must ask for
 * `=== "good"`: no evidence is not evidence of good quality. Two cases are no
 * evidence:
 *  - no frame of the window was solved;
 *  - a homography whose median inlier count over the window's solved frames is
 *    under {@link MIN_H_INLIERS_FOR_QUALITY}. A homography has 8 degrees of
 *    freedom and its residual is not corrected for them, so on 8 to 14 features
 *    it fits sigma 0.4-0.5 px noise down to a 0.5 px median that 120 features
 *    would show as 1.0 px. Its low residual then says nothing about the video.
 *    A HIGH residual stays "low" (the noise is at least that large), and a
 *    similarity (4 degrees of freedom) is judged on its residual as before.
 */
export function residualQuality({
	tracks,
	solution,
	window,
}: ResidualQualityArgs): "good" | "low" | "unknown" {
	const { lo, hi } = frameSpan({ tracks, solution, window });
	const residuals = residualsOf({ solution, lo, hi });
	if (residuals.length === 0) return "unknown";
	if (residuals[residuals.length >> 1] > LOW_QUALITY_RESIDUAL) return "low";
	if (solution.model === "H" && medianInliersOf({ solution, lo, hi }) < MIN_H_INLIERS_FOR_QUALITY) {
		return "unknown";
	}
	return "good";
}

const NO_TEXTURE_LIVE = 8;
/** "No motion" is only said when at least this share of the frames was solved: unsolved frames show no motion either. */
const NO_MOTION_SOLVED = 0.5;
const NO_MOTION_SHIFT = 1.5;
const NO_MOTION_SCALE = 0.005;
const NO_MOTION_ROTATION_DEG = 0.3;
const LOW_QUALITY_RESIDUAL = 0.6;
/**
 * A homography's low residual only counts as "good quality" when it was fitted
 * on at least this many inliers (median over the solved frames of the window).
 * Its `minInl` is 8, the same count as its degrees of freedom: fewer than about
 * 20 inliers leave the fit free to absorb the noise (measured on the perspective
 * test clip, yaw 12, sigma 0.4-0.5 px: 12-14 features read 0.47-0.58 px against
 * 0.9 px for the similarity and ~1.0 px for 120 features). The unit fixtures
 * with a dense world have 120 inliers.
 */
export const MIN_H_INLIERS_FOR_QUALITY = 20;

/**
 * What the user should be told about this analysis, in this order:
 *  - `no-texture`: a median of under 8 live features. Nothing else is judged
 *    then, the solution means nothing.
 *  - `no-motion`: over the window the scene never moved 1.5 px at the picture
 *    centre, scale never 0.5 %, rotation never 0.3 degrees (and most frames
 *    were solved): there is nothing to stick to.
 *  - `cut`: a scene cut starts or ends the pin's scene within the window, with
 *    its frame (one notice for each side).
 *  - `lost`: tracking was lost at this frame, the one nearest the pin frame
 *    (forward wins a tie); it may have been picked up again after it. The
 *    frames that are lost are those with `ok = 0` in the window.
 *  - `low-quality`: median residual above 0.6 px, a heavily compressed or noisy clip.
 *  - `object`: the pin sits on something that moves (`classification`).
 *
 * `window` is the frames the element is on (the whole clip when left out):
 * statistics and notices leave the rest of the analysis alone.
 */
export function qualityNotices({
	tracks,
	solution,
	classification,
	window,
}: {
	tracks: FeatureTracks;
	/** The similarity scene solution. */
	solution: PinSolution;
	classification?: ClassifyResult;
	window?: FrameWindow;
}): CameraNotice[] {
	const stats = cameraQualityStats({ tracks, solution, window });
	const { lo, hi } = frameSpan({ tracks, solution, window });
	const notices: CameraNotice[] = [];
	const noTexture = stats.medianLive < NO_TEXTURE_LIVE;
	if (noTexture) notices.push({ kind: "no-texture" });
	if (
		!noTexture &&
		stats.solvedFraction >= NO_MOTION_SOLVED &&
		stats.maxShift < NO_MOTION_SHIFT &&
		stats.maxScaleDeviation < NO_MOTION_SCALE &&
		stats.maxRotationDeg < NO_MOTION_ROTATION_DEG
	) {
		notices.push({ kind: "no-motion" });
	}
	// the cuts that bound the pin's scene, when the window reaches past them
	const scene = segmentBounds({ tracks, f0: solution.f0 });
	const reachFirst = window?.first ?? 0;
	const reachLast = window?.last ?? tracks.frameCount - 1;
	if (scene.lo > 0 && scene.lo > reachFirst) notices.push({ kind: "cut", frame: scene.lo });
	if (scene.hi < tracks.frameCount - 1 && scene.hi + 1 <= reachLast) {
		notices.push({ kind: "cut", frame: scene.hi + 1 });
	}
	if (!noTexture) {
		let nearest = -1;
		for (let t = lo; t <= hi; t++) {
			if (solution.ok[t]) continue;
			const d = Math.abs(t - solution.f0);
			const best = nearest < 0 ? Infinity : Math.abs(nearest - solution.f0);
			if (d < best || (d === best && t > solution.f0)) nearest = t;
		}
		if (nearest >= 0) notices.push({ kind: "lost", frame: nearest });
		if (stats.medianResidual > LOW_QUALITY_RESIDUAL) notices.push({ kind: "low-quality" });
	}
	if (classification?.isObject) notices.push({ kind: "object" });
	return notices;
}
