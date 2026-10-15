import type { GrayFrame } from "../types";
import {
	createCornerScratch,
	minEigMap,
	selectGridCorners,
	type BudgetOrder,
	type CornerScratch,
	type GridOptions,
} from "./corners";
import {
	createLkWorkspace,
	lkPyr,
	type LkOptions,
	type LkResult,
	type LkWorkspace,
} from "./lk";
import { allocPyramid, fillPyramid, type Pyramid } from "./pyramid";
import { makeThumb, THUMB_H, THUMB_W, thumbNcc } from "./thumb";
import type { FeatureTracks, TrackerStats, TrackerTiming } from "./types";

export interface TrackerOptions {
	/** Pyramid levels for Lucas-Kanade. */
	levels: number;
	/** Half the Lucas-Kanade window: 5 means 11 x 11 px. */
	half: number;
	maxIter: number;
	eps: number;
	/** A feature tracked forward and back must return within this many px, or it dies. */
	fbTol: number;
	/** A feature whose mean absolute gray-level residual is above this dies. */
	resMax: number;
	/** Grid cell side for seeding features (px). */
	cell: number;
	/**
	 * Seeding keeps this far from the frame edge, so a seed can be followed at
	 * all: on the coarsest pyramid level the window must fit, which needs
	 * `(half + 2) << (levels - 1)` px (28 by default; a seed closer to the edge
	 * dies on its first step). Features that move closer than half of it die.
	 */
	margin: number;
	minDist: number;
	quality: number;
	absMin: number;
	/** Empty cells are re-seeded every this many frames while below 85 % of `maxFeatures`. */
	reseedEvery: number;
	/** At most this many features alive. By default one per grid cell, 110 at 480 x 270. */
	maxFeatures: number;
	/** One seeding pass fills at most this share of the room left under `maxFeatures`. */
	seedShare: number;
	/** With more candidates than room, keep the strongest ("strongest") or the first in scan order ("first"). */
	budgetOrder: BudgetOrder;
	/** Structure tensor window for the corner measure. */
	detWin: number;
}

/**
 * The parameters the measurements in the plan were taken with, except the two
 * that depend on the frame (`margin`, `maxFeatures`: see
 * {@link resolveTrackerOptions}) and the seeding, which differs on purpose: the
 * prototype seeded half the free room per pass in scan order (`seedShare 0.5`,
 * `budgetOrder "first"`, `margin 10`, `maxFeatures 110`), which left a tall
 * frame without features below its top rows and a new scene with half the set
 * until the next passes. `camera-reproduction.test.ts` runs both.
 */
export const DEFAULT_TRACKER_OPTIONS: Readonly<Omit<TrackerOptions, "margin" | "maxFeatures">> = {
	levels: 3,
	half: 5,
	maxIter: 12,
	eps: 0.02,
	fbTol: 0.6,
	resMax: 14,
	cell: 36,
	minDist: 9,
	quality: 0.003,
	absMin: 4,
	reseedEvery: 4,
	seedShare: 1,
	budgetOrder: "strongest",
	detWin: 5,
};

/** Smallest margin at which a seed's window fits on the coarsest pyramid level. */
export function defaultMargin({ half, levels }: { half: number; levels: number }): number {
	return (half + 2) << (levels - 1);
}

/** One feature per grid cell (98 percent of them), never fewer than 110. */
export function defaultMaxFeatures({ w, h, cell }: { w: number; h: number; cell: number }): number {
	return Math.max(110, Math.ceil(0.98 * Math.ceil(w / cell) * Math.ceil(h / cell)));
}

/** `options` laid over the defaults, with the frame-dependent ones worked out for a `w` x `h` frame. */
export function resolveTrackerOptions({
	w,
	h,
	options,
}: {
	w: number;
	h: number;
	options?: Partial<TrackerOptions>;
}): TrackerOptions {
	const base = { ...DEFAULT_TRACKER_OPTIONS, ...options };
	return {
		...base,
		margin: options?.margin ?? defaultMargin({ half: base.half, levels: base.levels }),
		maxFeatures: options?.maxFeatures ?? defaultMaxFeatures({ w, h, cell: base.cell }),
	};
}

/** Most features dying on one frame, and the thumbnails then no longer matching, mean a cut. */
const CUT_LOST_SHARE = 0.6;
const CUT_MIN_LIVE = 8;
const CUT_NCC = 0.45;
/** Re-seed at once when the live features fall below this, whatever the frame number. */
const MIN_LIVE_BEFORE_RESEED = 12;
/** Re-seed only while the live share is below this. */
const RESEED_BELOW_SHARE = 0.85;
/** The median motion is only trusted as the next guess when this many features gave one. */
const MIN_FOR_PRIOR = 6;

/**
 * Follows sparse corner features through a clip, frame by frame, and hands
 * back every track at the end: `push` each gray frame in order, then `finish`.
 *
 * Per frame: pyramid and gradients, pyramidal Lucas-Kanade from the previous
 * frame (starting at the median motion of the last frame), a backward check,
 * re-seeding of empty grid cells, and a scene cut test on thumbnails.
 */
export class FeatureTracker {
	private readonly w: number;
	private readonly h: number;
	private readonly fps: number;
	private readonly o: TrackerOptions;
	private readonly lk: LkOptions;
	private readonly grid: GridOptions;
	private readonly workspace: LkWorkspace;
	private readonly lkOut: LkResult = { x: 0, y: 0, res: 0 };
	private readonly eig: Float32Array;
	private readonly cornerScratch: CornerScratch;
	private cur: Pyramid;
	private prev: Pyramid;
	private thumbCur = new Float32Array(THUMB_W * THUMB_H);
	private thumbPrev = new Float32Array(THUMB_W * THUMB_H);
	/** First frame, and interleaved `x, y` samples, of every track so far. */
	private readonly starts: number[] = [];
	private readonly samples: number[][] = [];
	private live: number[] = [];
	private readonly liveLists: Int32Array[] = [];
	private priorX = 0;
	private priorY = 0;
	private frame = -1;
	private readonly lostFraction: number[] = [];
	private readonly cuts: number[] = [];
	private readonly cutNcc: { frame: number; ncc: number }[] = [];
	private readonly stageMs: TrackerTiming = { pyramidMs: 0, trackMs: 0, detectMs: 0 };
	private result: FeatureTracks | null = null;

	/**
	 * `fps` is the rate of the frames that will be pushed, written into the
	 * tracks: there is no default, a wrong one would move every pin in time.
	 * Throws a `RangeError` for a bad `fps`, a frame too small for the pyramid
	 * (3 x 3, 1 x 1 and 480 x 1 all are) or a Lucas-Kanade window above 31 px.
	 */
	constructor({
		w,
		h,
		fps,
		options,
	}: {
		w: number;
		h: number;
		fps: number;
		options?: Partial<TrackerOptions>;
	}) {
		if (!Number.isFinite(fps) || fps <= 0) {
			throw new RangeError(`FeatureTracker: fps must be a positive number, got ${fps}`);
		}
		this.w = w;
		this.h = h;
		this.fps = fps;
		this.o = resolveTrackerOptions({ w, h, options });
		this.lk = { half: this.o.half, maxIter: this.o.maxIter, eps: this.o.eps };
		this.grid = {
			cell: this.o.cell,
			margin: this.o.margin,
			quality: this.o.quality,
			absMin: this.o.absMin,
			minDist: this.o.minDist,
			maxFeatures: this.o.maxFeatures,
			seedShare: this.o.seedShare,
			budgetOrder: this.o.budgetOrder,
		};
		this.workspace = createLkWorkspace({ half: this.o.half });
		this.cur = allocPyramid({ w, h, levels: this.o.levels });
		this.prev = allocPyramid({ w, h, levels: this.o.levels });
		this.eig = new Float32Array(w * h);
		this.cornerScratch = createCornerScratch({ w, h });
	}

	/** Where the time went so far, per stage (diagnostics: not part of the tracks). */
	get timing(): TrackerTiming {
		return { ...this.stageMs };
	}

	/** Adds the next frame of the clip. It must be `w` x `h`. */
	push(gray: GrayFrame): void {
		if (this.result) throw new Error("FeatureTracker: push after finish");
		if (gray.w !== this.w || gray.h !== this.h || gray.data.length !== this.w * this.h) {
			throw new RangeError(
				`FeatureTracker: expected a ${this.w}x${this.h} frame, got ${gray.w}x${gray.h} with ${gray.data.length} pixels`,
			);
		}
		const o = this.o;
		const f = ++this.frame;
		[this.prev, this.cur] = [this.cur, this.prev];
		[this.thumbPrev, this.thumbCur] = [this.thumbCur, this.thumbPrev];

		let t0 = performance.now();
		makeThumb({ gray: gray.data, w: this.w, h: this.h, out: this.thumbCur });
		fillPyramid({ pyramid: this.cur, gray: gray.data });
		this.stageMs.pyramidMs += performance.now() - t0;

		t0 = performance.now();
		this.lostFraction.push(0);
		if (f > 0 && this.live.length > 0) this.trackLive(f);
		this.stageMs.trackMs += performance.now() - t0;

		t0 = performance.now();
		if (
			f === 0 ||
			(this.live.length < o.maxFeatures * RESEED_BELOW_SHARE && f % o.reseedEvery === 0) ||
			this.live.length < MIN_LIVE_BEFORE_RESEED
		) {
			this.detect(f);
		}
		this.stageMs.detectMs += performance.now() - t0;
		this.liveLists.push(Int32Array.from(this.live));
	}

	private trackLive(f: number): void {
		const o = this.o;
		const edge = o.margin * 0.5;
		const out = this.lkOut;
		const next: number[] = [];
		const dxs: number[] = [];
		const dys: number[] = [];
		const total = this.live.length;
		let lost = 0;
		for (const id of this.live) {
			const s = this.samples[id];
			const x = s[s.length - 2];
			const y = s[s.length - 1];
			let ok = lkPyr({
				from: this.prev,
				to: this.cur,
				x,
				y,
				guessX: x + this.priorX,
				guessY: y + this.priorY,
				options: this.lk,
				workspace: this.workspace,
				out,
			});
			let nx = 0;
			let ny = 0;
			if (ok) {
				nx = out.x;
				ny = out.y;
				if (out.res > o.resMax) ok = false;
				else if (nx < edge || ny < edge || nx > this.w - 1 - edge || ny > this.h - 1 - edge) ok = false;
			}
			if (ok) {
				const back = lkPyr({
					from: this.cur,
					to: this.prev,
					x: nx,
					y: ny,
					guessX: x,
					guessY: y,
					options: this.lk,
					workspace: this.workspace,
					out,
				});
				if (!back || Math.hypot(out.x - x, out.y - y) > o.fbTol) ok = false;
			}
			if (ok) {
				s.push(nx, ny);
				next.push(id);
				dxs.push(nx - x);
				dys.push(ny - y);
			} else {
				lost++;
			}
		}
		this.live = next;
		this.lostFraction[f] = lost / total;

		let isCut = false;
		if (total >= CUT_MIN_LIVE && lost / total > CUT_LOST_SHARE) {
			const ncc = thumbNcc({ a: this.thumbPrev, b: this.thumbCur });
			this.cutNcc.push({ frame: f, ncc });
			isCut = ncc < CUT_NCC;
		}
		if (isCut) {
			// the few that "survived" were matched into a different scene: drop that sample too
			for (const id of this.live) this.samples[id].length -= 2;
			this.live = [];
			this.cuts.push(f);
			this.priorX = 0;
			this.priorY = 0;
			return;
		}
		if (dxs.length >= MIN_FOR_PRIOR) {
			dxs.sort((a, b) => a - b);
			dys.sort((a, b) => a - b);
			this.priorX = dxs[dxs.length >> 1];
			this.priorY = dys[dys.length >> 1];
		} else {
			this.priorX = 0;
			this.priorY = 0;
		}
	}

	private detect(frame: number): void {
		const livePositions: number[] = [];
		for (const id of this.live) {
			const s = this.samples[id];
			livePositions.push(s[s.length - 2], s[s.length - 1]);
		}
		const eig = minEigMap({
			level: this.cur.levels[0],
			win: this.o.detWin,
			out: this.eig,
			scratch: this.cornerScratch,
		});
		const fresh = selectGridCorners({
			eig,
			w: this.w,
			h: this.h,
			options: this.grid,
			live: livePositions,
		});
		for (let i = 0; i < fresh.length; i += 2) {
			this.starts.push(frame);
			this.samples.push([fresh[i], fresh[i + 1]]);
			this.live.push(this.samples.length - 1);
		}
	}

	/** Packs every track into typed arrays. The tracker takes no more frames afterwards. */
	finish(): FeatureTracks {
		if (this.result) return this.result;
		const frameCount = this.frame + 1;
		if (frameCount < 1) throw new Error("FeatureTracker: finish without a single frame");
		const trackCount = this.samples.length;
		const trackStart = Int32Array.from(this.starts);
		const trackLen = new Int32Array(trackCount);
		const trackOffset = new Int32Array(trackCount);
		let floats = 0;
		for (let i = 0; i < trackCount; i++) {
			trackLen[i] = this.samples[i].length / 2;
			trackOffset[i] = floats;
			floats += this.samples[i].length;
		}
		const xy = new Float32Array(floats);
		for (let i = 0; i < trackCount; i++) xy.set(this.samples[i], trackOffset[i]);
		const liveOffsets = new Int32Array(frameCount + 1);
		let liveTotal = 0;
		for (let f = 0; f < frameCount; f++) {
			liveTotal += this.liveLists[f].length;
			liveOffsets[f + 1] = liveTotal;
		}
		const liveIds = new Int32Array(liveTotal);
		for (let f = 0; f < frameCount; f++) liveIds.set(this.liveLists[f], liveOffsets[f]);
		const stats: TrackerStats = {
			lostFraction: Float32Array.from(this.lostFraction),
			cutNcc: this.cutNcc,
		};
		this.result = {
			w: this.w,
			h: this.h,
			frameCount,
			fps: this.fps,
			trackStart,
			trackLen,
			trackOffset,
			xy,
			liveOffsets,
			liveIds,
			cuts: this.cuts,
			stats,
		};
		// the build-up lists are not needed any more: a long clip holds tens of MB of them
		this.samples.length = 0;
		this.starts.length = 0;
		this.liveLists.length = 0;
		this.lostFraction.length = 0;
		this.live = [];
		return this.result;
	}
}
