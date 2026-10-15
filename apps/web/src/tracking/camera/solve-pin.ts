import { hApply, hMul, ransacH, refineH } from "./homography";
import { createRng } from "./random";
import { tukeyCutoff } from "./robust";
import {
	applySim,
	composeSim,
	createRefineScratch,
	ransacSim,
	refineSim,
	type RefineScratch,
	type Similarity,
} from "./similarity";
import type { FeatureTracks, PinMode, PinModel, PinSolution } from "./types";

export interface SolveOptions {
	/** RANSAC hypotheses per frame pair. */
	hyp: number;
	/** A pair within this many px of a hypothesis supports it. */
	tau: number;
	/** The points of a hypothesis must be at least this far apart (px). */
	minSep: number;
	/** Fewer inliers than this and the fit is rejected. */
	minInl: number;
	/** Rejected when the inliers' summed weight is below this (similarity). */
	minMass: number;
	/** Rejected when the inliers' spread around their centre is below this (px). */
	minSpread: number;
	/** Re-anchor on the previous solved frame when support falls below this share of its start. */
	hopFrac: number;
	/** A feature outside the model this many frames in a row is no longer a candidate; 0 turns that off. */
	badLimit: number;
	/**
	 * Before the first fits from the pin frame, the map to the frame this many
	 * frames away (or the farthest closer one that fits) is solved, and the
	 * features outside its cutoff and farther than `scaleWin` are no candidates
	 * while the pin frame is the anchor. One frame after the pin a feature on a
	 * slowly moving object is still inside the cutoff; this far away it is not.
	 * The window is counted in frames, not seconds, and only sees what parts
	 * from the scene inside it. 0 turns that off.
	 */
	lookahead: number;
	seed: number;
	/** Tukey cutoff = `cFac` times a robust sigma, which is kept in [`sMin`, `sMax`]. */
	cFac: number;
	sMin: number;
	sMax: number;
	/** Rounds of reweighting after RANSAC. */
	irls: number;
	/** Residuals above this (px) take no part in the scale estimate. */
	scaleWin: number;
	/** "gauss" weights candidates by their distance to the pin (object mode). */
	kernel: "uniform" | "gauss";
	/** The Gaussian's width is the distance to this many-th nearest candidate ... */
	neighbours: number;
	/** ... kept in [`sigmaMin`, `sigmaMax`] px. */
	sigmaMin: number;
	sigmaMax: number;
}

const BASE_OPTIONS: SolveOptions = {
	hyp: 80,
	tau: 1,
	minSep: 12,
	minInl: 4,
	minMass: 1.2,
	minSpread: 35,
	hopFrac: 0.7,
	badLimit: 2,
	lookahead: 6,
	seed: 7,
	cFac: 4.685,
	sMin: 0.12,
	sMax: 0.6,
	irls: 6,
	scaleWin: 1.5,
	kernel: "uniform",
	neighbours: 8,
	sigmaMin: 18,
	sigmaMax: 140,
};

/** The parameter sets measured for the plan, plus the `lookahead` of job J2 (6 frames; 0 in `S-object`). */
export const SOLVE_PRESETS: Readonly<Record<"S-scene" | "S-object" | "H-scene", Readonly<SolveOptions>>> = {
	"S-scene": BASE_OPTIONS,
	"S-object": {
		...BASE_OPTIONS,
		kernel: "gauss",
		neighbours: 4,
		sigmaMin: 15,
		sigmaMax: 40,
		minInl: 3,
		minMass: 1,
		minSpread: 8,
		hopFrac: 0.5,
		badLimit: 0,
		lookahead: 0,
	},
	"H-scene": { ...BASE_OPTIONS, hyp: 120, minInl: 8, minMass: 0, minSep: 25 },
};

/** Frames `[lo, hi]` of the scene that contains `f0`: tracks never cross a cut. */
export function segmentBounds({
	tracks,
	f0,
}: {
	tracks: FeatureTracks;
	f0: number;
}): { lo: number; hi: number } {
	let lo = 0;
	let hi = tracks.frameCount - 1;
	for (const cut of tracks.cuts) {
		if (cut <= f0) lo = Math.max(lo, cut);
		else hi = Math.min(hi, cut - 1);
	}
	return { lo, hi };
}

/** Everything one pair fit needs and leaves behind. Two of these let a re-anchored fit not overwrite the first. */
interface PairBuffers {
	za: Float64Array;
	zb: Float64Array;
	w: Float64Array;
	d2: Float64Array;
	/** Track id of each candidate. */
	tix: Int32Array;
	/** Final residual of each candidate under the fitted model. */
	rs: Float64Array;
	masked: Float64Array;
	ca: Float64Array;
	cb: Float64Array;
	cmap: Int32Array;
	refine: RefineScratch;
	// result of the last successful fit
	model: Float64Array;
	n: number;
	nin: number;
	support: number;
	spread: number;
	cFinal: number;
	rms: number;
}

function createPairBuffers({ capacity }: { capacity: number }): PairBuffers {
	return {
		za: new Float64Array(2 * capacity),
		zb: new Float64Array(2 * capacity),
		w: new Float64Array(capacity),
		d2: new Float64Array(capacity),
		tix: new Int32Array(capacity),
		rs: new Float64Array(capacity),
		masked: new Float64Array(capacity),
		ca: new Float64Array(2 * capacity),
		cb: new Float64Array(2 * capacity),
		cmap: new Int32Array(capacity),
		refine: createRefineScratch({ n: capacity }),
		model: new Float64Array(9),
		n: 0,
		nin: 0,
		support: 0,
		spread: 0,
		cFinal: 1,
		rms: 0,
	};
}

/** Tracks alive on frame `a` that also have a sample on frame `t`, as point pairs. */
function gather({
	tracks,
	a,
	t,
	pin,
	buf,
}: {
	tracks: FeatureTracks;
	a: number;
	t: number;
	pin: { x: number; y: number };
	buf: PairBuffers;
}): number {
	const { liveOffsets, liveIds, trackStart, trackLen, trackOffset, xy } = tracks;
	const lo = Math.min(a, t);
	const hi = Math.max(a, t);
	let n = 0;
	for (let q = liveOffsets[a]; q < liveOffsets[a + 1]; q++) {
		const id = liveIds[q];
		const first = trackStart[id];
		const last = first + trackLen[id] - 1;
		if (first > lo || last < hi) continue;
		const ia = trackOffset[id] + 2 * (a - first);
		const it = trackOffset[id] + 2 * (t - first);
		const ax = xy[ia];
		const ay = xy[ia + 1];
		buf.za[2 * n] = ax;
		buf.za[2 * n + 1] = ay;
		buf.zb[2 * n] = xy[it];
		buf.zb[2 * n + 1] = xy[it + 1];
		buf.tix[n] = id;
		buf.d2[n] = (ax - pin.x) * (ax - pin.x) + (ay - pin.y) * (ay - pin.y);
		n++;
	}
	return n;
}

/** Final cutoff for the persistent-outlier bookkeeping: where the residuals of the good candidates end. */
function outlierCutoff({
	buf,
	n,
	o,
}: {
	buf: PairBuffers;
	n: number;
	o: SolveOptions;
}): number {
	const c = tukeyCutoff({
		residuals: buf.masked,
		n,
		window: o.scaleWin,
		minCount: 1,
		sMin: o.sMin,
		sMax: o.sMax,
		cFac: o.cFac,
		scratch: buf.refine.tmp,
	});
	return c < 0 ? 1 : Math.max(0.5, c);
}

function fitSimilarityPair({
	tracks,
	a,
	t,
	pin,
	o,
	buf,
	random,
	bad,
	excluded,
}: {
	tracks: FeatureTracks;
	a: number;
	t: number;
	pin: { x: number; y: number };
	o: SolveOptions;
	buf: PairBuffers;
	random: () => number;
	bad: Uint8Array;
	/** Tracks that are no candidates for this fit, whatever their residual. */
	excluded: Uint8Array;
}): PairBuffers | null {
	const n = gather({ tracks, a, t, pin, buf });
	if (n < 3) return null;
	const { za, zb, d2, w, tix, rs, masked } = buf;

	let twoSigma2 = 1;
	if (o.kernel === "gauss") {
		// width: distance to the K-th nearest candidate, kept in range; a pin outside the frame may use more
		const sorted = buf.refine.tmp;
		sorted.set(d2.subarray(0, n));
		sorted.subarray(0, n).sort();
		const kth = Math.sqrt(sorted[Math.min(o.neighbours, n) - 1]);
		const outside = pin.x < 0 || pin.y < 0 || pin.x > tracks.w || pin.y > tracks.h;
		const sigma = outside
			? Math.max(o.sigmaMin, kth)
			: Math.max(o.sigmaMin, Math.min(o.sigmaMax, kth));
		twoSigma2 = 2 * sigma * sigma;
	}
	let mass = 0;
	for (let i = 0; i < n; i++) {
		let wi = o.kernel === "uniform" ? 1 : Math.exp(-d2[i] / twoSigma2);
		if (wi < 0.02) wi = 0;
		if (o.badLimit > 0 && bad[tix[i]] >= o.badLimit) wi = 0;
		if (excluded[tix[i]]) wi = 0;
		w[i] = wi;
		mass += wi;
	}
	if (mass < 1e-6) return null;

	const start = ransacSim({
		za,
		zb,
		n,
		weights: w,
		options: { hyp: o.hyp, tau: o.tau, minSep: o.minSep },
		random,
	});
	if (!start) return null;
	const refined = refineSim({ za, zb, n, weights: w, start, options: o, scratch: buf.refine });
	if (!refined) return null;

	// how widely the inliers are spread around their weighted centre
	const { inliers } = buf.refine;
	let sw = 0;
	let mx = 0;
	let my = 0;
	for (let q = 0; q < refined.nin; q++) {
		const i = inliers[q];
		sw += w[i];
		mx += w[i] * za[2 * i];
		my += w[i] * za[2 * i + 1];
	}
	mx /= sw;
	my /= sw;
	let vv = 0;
	for (let q = 0; q < refined.nin; q++) {
		const i = inliers[q];
		vv += w[i] * ((za[2 * i] - mx) ** 2 + (za[2 * i + 1] - my) ** 2);
	}

	const m = refined.model;
	for (let k = 0; k < n; k++) {
		const px = m.ar * za[2 * k] - m.ai * za[2 * k + 1] + m.br - zb[2 * k];
		const py = m.ar * za[2 * k + 1] + m.ai * za[2 * k] + m.bi - zb[2 * k + 1];
		rs[k] = Math.sqrt(px * px + py * py);
		masked[k] = w[k] > 0 ? rs[k] : 1e9;
	}
	buf.model[0] = m.ar;
	buf.model[1] = m.ai;
	buf.model[2] = m.br;
	buf.model[3] = m.bi;
	buf.n = n;
	buf.nin = refined.nin;
	buf.support = refined.mass;
	buf.spread = Math.sqrt(vv / sw);
	buf.cFinal = outlierCutoff({ buf, n, o });
	buf.rms = Math.sqrt(refined.rss / Math.max(refined.mass, 1e-9));
	return buf;
}

function fitHomographyPair({
	tracks,
	a,
	t,
	o,
	buf,
	random,
	bad,
	excluded,
}: {
	tracks: FeatureTracks;
	a: number;
	t: number;
	o: SolveOptions;
	buf: PairBuffers;
	random: () => number;
	bad: Uint8Array;
	excluded: Uint8Array;
}): PairBuffers | null {
	const n = gather({ tracks, a, t, pin: { x: 0, y: 0 }, buf });
	if (n < 8) return null;
	const { za, zb, tix, rs, ca, cb, cmap } = buf;

	// candidates without the persistent outliers
	let m = 0;
	for (let k = 0; k < n; k++) {
		if (o.badLimit > 0 && bad[tix[k]] >= o.badLimit) continue;
		if (excluded[tix[k]]) continue;
		ca[2 * m] = za[2 * k];
		ca[2 * m + 1] = za[2 * k + 1];
		cb[2 * m] = zb[2 * k];
		cb[2 * m + 1] = zb[2 * k + 1];
		cmap[m] = k;
		m++;
	}
	if (m < 8) return null;
	const start = ransacH({
		za: ca,
		zb: cb,
		n: m,
		options: { hyp: o.hyp, tau: o.tau, minSep: o.minSep },
		random,
	});
	if (!start) return null;
	const refined = refineH({ za: ca, zb: cb, n: m, start, options: o, scratch: buf.refine });
	if (!refined) return null;

	const { inliers } = buf.refine;
	let mx = 0;
	let my = 0;
	for (let q = 0; q < refined.nin; q++) {
		mx += ca[2 * inliers[q]];
		my += ca[2 * inliers[q] + 1];
	}
	mx /= refined.nin;
	my /= refined.nin;
	let vv = 0;
	for (let q = 0; q < refined.nin; q++) {
		vv += (ca[2 * inliers[q]] - mx) ** 2 + (ca[2 * inliers[q] + 1] - my) ** 2;
	}

	const h = refined.h;
	for (let k = 0; k < n; k++) {
		const wv = h[6] * za[2 * k] + h[7] * za[2 * k + 1] + h[8];
		const px = (h[0] * za[2 * k] + h[1] * za[2 * k + 1] + h[2]) / wv - zb[2 * k];
		const py = (h[3] * za[2 * k] + h[4] * za[2 * k + 1] + h[5]) / wv - zb[2 * k + 1];
		rs[k] = Math.sqrt(px * px + py * py);
		buf.masked[k] = rs[k];
	}
	for (let i = 0; i < 9; i++) buf.model[i] = h[i];
	buf.n = n;
	buf.nin = refined.nin;
	buf.support = refined.nin;
	buf.spread = Math.sqrt(vv / refined.nin);
	buf.cFinal = outlierCutoff({ buf, n, o });
	buf.rms = Math.sqrt(refined.rss / refined.nin);
	return buf;
}

/**
 * Where every point of frame `f0` is on every other frame, from the sparse
 * feature tracks.
 *
 * For each frame `t` the map `f0 -> t` is fitted to the features alive on `f0`
 * that are still tracked on `t` (RANSAC, then Tukey reweighting). While enough
 * of them survive that direct fit is used, which keeps drift out. When their
 * support falls below `hopFrac` of what it started at, or the fit is weak, the
 * solver re-anchors on the previous frame and composes from there. A feature
 * that stays outside the model for `badLimit` frames in a row stops being a
 * candidate (its residual keeps being watched).
 *
 * A frame where no feature links the two sides (every feature lost at once: a
 * blurred, flashed or dropped frame) is bridged: the solver anchors on the
 * held frame, assuming the camera did not move over the gap, and everything it
 * solves from there on is marked `ok = 2` (see `PinFrameState`). Frames that
 * cannot be solved hold the last map (`ok = 0`), and so do frames beyond a
 * scene cut or outside `range`: tracks never cross a cut and nothing is solved
 * past the frames asked for.
 *
 * `mode: "object"` weights candidates by their distance to `pin` so the map
 * follows what is under the pin; it needs `pin` and the similarity model.
 * `range` limits the frames to solve, for a clip analysed longer than the
 * element needs; it must hold `f0`.
 */
export function solvePin({
	tracks,
	f0,
	model,
	mode,
	pin,
	range,
	options,
}: {
	tracks: FeatureTracks;
	f0: number;
	model: PinModel;
	mode: PinMode;
	/** Pin position on frame `f0` (px of the analysis frame); required for object mode. */
	pin?: { x: number; y: number };
	/** Frames to solve, inclusive (cut to the pin's scene). Everything else is held. */
	range?: { lo: number; hi: number };
	options?: Partial<SolveOptions>;
}): PinSolution {
	const { frameCount } = tracks;
	if (!Number.isInteger(f0) || f0 < 0 || f0 >= frameCount) {
		throw new RangeError(`pin frame ${f0} is outside the clip (0..${frameCount - 1})`);
	}
	if (range) {
		const bad =
			!Number.isInteger(range.lo) ||
			!Number.isInteger(range.hi) ||
			range.lo < 0 ||
			range.hi >= frameCount ||
			range.lo > f0 ||
			range.hi < f0;
		if (bad) {
			throw new RangeError(
				`range ${range.lo}..${range.hi} must be whole frames of the clip (0..${frameCount - 1}) and hold the pin frame ${f0}`,
			);
		}
	}
	if (mode === "object") {
		if (!pin) throw new Error("solvePin: object mode needs the pin position");
		if (model === "H") throw new Error("solvePin: object mode works with the similarity model only");
	}
	const o: SolveOptions = {
		...SOLVE_PRESETS[model === "H" ? "H-scene" : mode === "object" ? "S-object" : "S-scene"],
		...options,
	};
	const stride = model === "S" ? 4 : 9;
	const maps = new Float64Array(stride * frameCount);
	for (let t = 0; t < frameCount; t++) {
		maps[stride * t] = 1;
		if (stride === 9) {
			maps[9 * t + 4] = 1;
			maps[9 * t + 8] = 1;
		}
	}
	const ok = new Uint8Array(frameCount);
	const nin = new Int32Array(frameCount);
	const rms = new Float64Array(frameCount);
	ok[f0] = 1;

	let capacity = 1;
	for (let f = 0; f < frameCount; f++) {
		capacity = Math.max(capacity, tracks.liveOffsets[f + 1] - tracks.liveOffsets[f]);
	}
	const primary = createPairBuffers({ capacity });
	const alternate = createPairBuffers({ capacity });
	const random = createRng({ seed: o.seed });
	const bad = new Uint8Array(tracks.trackStart.length);
	// its own random stream, so the look-ahead does not shift the draws of the fits
	const lookaheadRandom = createRng({ seed: o.seed + 1 });
	const movingAtPin = new Uint8Array(tracks.trackStart.length);
	const noneExcluded = new Uint8Array(tracks.trackStart.length);
	const pinStart = pin ?? { x: 0, y: 0 };
	const scene = segmentBounds({ tracks, f0 });
	const bounds = {
		lo: Math.max(scene.lo, range?.lo ?? 0),
		hi: Math.min(scene.hi, range?.hi ?? frameCount - 1),
	};
	const anchorMap = new Float64Array(stride);
	let hops = 0;

	const solvePair = ({
		a,
		t,
		pinA,
		buf,
		excluded = a === f0 ? movingAtPin : noneExcluded,
		draw = random,
	}: {
		a: number;
		t: number;
		pinA: { x: number; y: number };
		buf: PairBuffers;
		excluded?: Uint8Array;
		draw?: () => number;
	}) =>
		model === "S"
			? fitSimilarityPair({ tracks, a, t, pin: pinA, o, buf, random: draw, bad, excluded })
			: fitHomographyPair({ tracks, a, t, o, buf, random: draw, bad, excluded });
	const isWeak = (r: PairBuffers | null) =>
		!r || r.nin < o.minInl || r.support < o.minMass || r.spread < o.minSpread;
	const copyMap = ({ from, to }: { from: number; to: number }) => {
		for (let i = 0; i < stride; i++) maps[stride * to + i] = maps[stride * from + i];
	};
	const loadAnchor = (frame: number) => {
		for (let i = 0; i < stride; i++) anchorMap[i] = maps[stride * frame + i];
	};
	/** Where the pin is on `frame`, by the map held for it. */
	const pinOn = (frame: number) =>
		model === "S"
			? applySim({
					map: {
						ar: maps[4 * frame],
						ai: maps[4 * frame + 1],
						br: maps[4 * frame + 2],
						bi: maps[4 * frame + 3],
					},
					x: pinStart.x,
					y: pinStart.y,
				})
			: pinStart;

	/**
	 * Marks the features that a fit from the pin frame to a frame well away in
	 * `dir` leaves outside its cutoff and farther than `scaleWin`: the fits from
	 * the pin frame leave them out, while their residuals are still watched.
	 * Nothing when no such frame fits.
	 */
	const markMovingAtPin = ({ dir, last }: { dir: number; last: number }) => {
		movingAtPin.fill(0);
		if (o.lookahead <= 0 || o.badLimit <= 0) return;
		const reach = Math.min(o.lookahead, Math.abs(last - f0));
		for (let k = reach; k >= 2; k--) {
			const r = solvePair({
				a: f0,
				t: f0 + dir * k,
				pinA: pinStart,
				buf: alternate,
				excluded: noneExcluded,
				draw: lookaheadRandom,
			});
			if (!r || isWeak(r)) continue;
			// beyond the cutoff and beyond what noise can do: the noisy tail of the scene stays
			const limit = Math.max(r.cFinal, o.scaleWin);
			for (let i = 0; i < r.n; i++) if (r.rs[i] >= limit) movingAtPin[r.tix[i]] = 1;
			return;
		}
	};

	for (const dir of [1, -1]) {
		const last = dir === 1 ? bounds.hi : bounds.lo;
		// each direction looks ahead its own way; the persistent-outlier marks carry over
		markMovingAtPin({ dir, last });
		let anchor = f0;
		let prev = f0;
		let supportAtHop = -1;
		// once the chain has crossed a frame that was only held, what follows is off by what the camera did there
		let bridged = false;
		loadAnchor(f0);
		let pinA = pinStart;
		for (let t = f0 + dir; dir === 1 ? t <= last : t >= last; t += dir) {
			let res = solvePair({ a: anchor, t, pinA, buf: primary });
			const weakFit = isWeak(res);
			const decayed =
				res !== null &&
				supportAtHop > 0 &&
				res.support < o.hopFrac * supportAtHop &&
				anchor !== prev;
			if (weakFit || decayed) {
				// A held frame can anchor a bridge over a gap, but a good fit is not given up for one.
				const canHop = prev !== anchor && (weakFit || ok[prev] !== 0);
				if (canHop) {
					const hopPin = pinOn(prev);
					const second = solvePair({ a: prev, t, pinA: hopPin, buf: alternate });
					const secondFits = !isWeak(second);
					// Move to the previous frame when it fits, or when nothing does. When only the
					// old anchor fits, stay on it: `res` was made from it.
					if (secondFits || weakFit) {
						anchor = prev;
						loadAnchor(anchor);
						pinA = hopPin;
						hops++;
						if (ok[anchor] === 0) bridged = true;
					}
					if (secondFits) {
						res = second;
						supportAtHop = -1;
					} else if (weakFit) {
						res = null;
					}
				} else if (weakFit) {
					res = null;
				}
			}
			if (!res) {
				copyMap({ from: prev, to: t });
				prev = t;
				continue;
			}
			// compose the fit onto the anchor's map
			if (model === "S") {
				const composed = composeSim({
					outer: { ar: res.model[0], ai: res.model[1], br: res.model[2], bi: res.model[3] },
					inner: { ar: anchorMap[0], ai: anchorMap[1], br: anchorMap[2], bi: anchorMap[3] },
				});
				maps[4 * t] = composed.ar;
				maps[4 * t + 1] = composed.ai;
				maps[4 * t + 2] = composed.br;
				maps[4 * t + 3] = composed.bi;
			} else {
				const composed = hMul({ left: res.model, right: anchorMap });
				const scale = composed[8];
				if (!Number.isFinite(scale) || Math.abs(scale) < 1e-9) {
					// a warp that sends the plane to infinity is no solution
					copyMap({ from: prev, to: t });
					prev = t;
					continue;
				}
				for (let i = 0; i < 9; i++) maps[9 * t + i] = composed[i] / scale;
			}
			if (o.badLimit > 0) {
				for (let k = 0; k < res.n; k++) {
					const id = res.tix[k];
					if (res.rs[k] < res.cFinal) bad[id] = 0;
					else if (bad[id] < 250) bad[id]++;
				}
			}
			ok[t] = bridged ? 2 : 1;
			nin[t] = res.nin;
			rms[t] = res.rms;
			if (supportAtHop < 0) supportAtHop = res.support;
			prev = t;
		}
		// nothing was solved past the pin's scene or the range: hold the last map
		if (dir === 1) {
			for (let t = bounds.hi + 1; t < frameCount; t++) copyMap({ from: t - 1, to: t });
		} else {
			for (let t = bounds.lo - 1; t >= 0; t--) copyMap({ from: t + 1, to: t });
		}
	}

	return { model, mode, f0, frameCount, range: bounds, stride, maps, ok, nin, rms, hops };
}

export type RangeEnd = "cut" | "lost" | "clip";

/** The frames a solution can be used for, and what ended each side. */
export interface TrackedRange {
	first: number;
	last: number;
	/** "cut": the pin's scene ends there. "lost": tracking failed past `first` and never came back. "clip": the clip or the range asked for ends. */
	firstEndedBy: RangeEnd;
	lastEndedBy: RangeEnd;
}

/**
 * The stretch around the pin frame that was tracked: from the first to the
 * last frame with `ok > 0`. Frames held inside it (a bridged gap) are part of
 * it, held frames at its ends (tracking lost for good, a cut, the range's end)
 * are not.
 */
export function trackedRange({
	tracks,
	solution,
}: {
	tracks: FeatureTracks;
	solution: PinSolution;
}): TrackedRange {
	if (tracks.frameCount !== solution.frameCount) {
		throw new RangeError(
			`solution covers ${solution.frameCount} frames, the tracks ${tracks.frameCount}`,
		);
	}
	const { f0, range, ok } = solution;
	let last = f0;
	for (let t = f0 + 1; t <= range.hi; t++) if (ok[t]) last = t;
	let first = f0;
	for (let t = f0 - 1; t >= range.lo; t--) if (ok[t]) first = t;
	const scene = segmentBounds({ tracks, f0 });
	const lastEndedBy: RangeEnd =
		last < range.hi
			? "lost"
			: range.hi === scene.hi && scene.hi < tracks.frameCount - 1
				? "cut"
				: "clip";
	const firstEndedBy: RangeEnd =
		first > range.lo ? "lost" : range.lo === scene.lo && scene.lo > 0 ? "cut" : "clip";
	return { first, last, firstEndedBy, lastEndedBy };
}

function checkFrame({ solution, t }: { solution: PinSolution; t: number }): void {
	if (!Number.isInteger(t) || t < 0 || t >= solution.frameCount) {
		throw new RangeError(`frame ${t} is outside the solution (0..${solution.frameCount - 1})`);
	}
}

/** The similarity from the pin frame to frame `t`. Throws for an H solution. */
export function similarityAt({
	solution,
	t,
}: {
	solution: PinSolution;
	t: number;
}): Similarity {
	if (solution.model !== "S") throw new TypeError("similarityAt: not a similarity solution");
	checkFrame({ solution, t });
	const m = solution.maps;
	return { ar: m[4 * t], ai: m[4 * t + 1], br: m[4 * t + 2], bi: m[4 * t + 3] };
}

/** The 3x3 homography (row-major, a view into the solution) from the pin frame to frame `t`. Throws for an S solution. */
export function homographyAt({
	solution,
	t,
}: {
	solution: PinSolution;
	t: number;
}): Float64Array {
	if (solution.model !== "H") throw new TypeError("homographyAt: not a homography solution");
	checkFrame({ solution, t });
	return solution.maps.subarray(9 * t, 9 * t + 9);
}

/** Where the pin-frame point (x, y) is on frame `t`, whichever the model. */
export function mapPoint({
	solution,
	t,
	x,
	y,
}: {
	solution: PinSolution;
	t: number;
	x: number;
	y: number;
}): { x: number; y: number } {
	checkFrame({ solution, t });
	if (solution.model === "S") return applySim({ map: similarityAt({ solution, t }), x, y });
	return hApply({ h: homographyAt({ solution, t }), x, y });
}
