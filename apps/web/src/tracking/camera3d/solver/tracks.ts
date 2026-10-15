/**
 * The solver's view of the 2D tracks: the longest scene between cuts, the
 * tracks kept for the solve (excluded ones and very short ones dropped),
 * their samples in FRAME pixels relative to the frame centre, statistics
 * for the failure checks, and keyframe selection.
 */
import type { FeatureTracks } from "@/tracking/camera/types";
import { median } from "./linalg";

/** Tracks shorter than this many frames are not used. */
export const MIN_TRACK_FRAMES = 3;

export interface SolverTracks {
	/** First analysis frame of the solved scene. */
	firstFrame: number;
	/** Frames of the solved scene; frame indices below are relative to `firstFrame`. */
	frameCount: number;
	frameWidth: number;
	frameHeight: number;
	/** Frame pixels per analysis pixel (geometric mean of both axes). */
	pixelScale: number;
	/** Per kept track: its id in the `FeatureTracks`. */
	trackIds: Int32Array;
	/** Per kept track: first frame (relative) and number of samples. */
	start: Int32Array;
	length: Int32Array;
	/** Per kept track: index of its first sample; sample j is at `uv[2 * (offset + j)]`. */
	offset: Int32Array;
	/** Frame pixels relative to the frame centre, interleaved. */
	uv: Float64Array;
	/** Per frame: the kept tracks alive there are `live[liveOffsets[f] .. liveOffsets[f + 1])`, ascending. */
	liveOffsets: Int32Array;
	live: Int32Array;
}

/** The scenes between cuts, as `[first, end)` frame ranges, in order. */
export function sceneRanges({ frameCount, cuts }: { frameCount: number; cuts: readonly number[] }): { first: number; end: number }[] {
	const bounds = [...new Set(cuts.filter((cut) => cut > 0 && cut < frameCount))].sort((a, b) => a - b);
	const ranges: { first: number; end: number }[] = [];
	let first = 0;
	for (const cut of bounds) {
		ranges.push({ first, end: cut });
		first = cut;
	}
	ranges.push({ first, end: frameCount });
	return ranges;
}

/** The longest scene (the first of equal ones). */
export function longestScene({ frameCount, cuts }: { frameCount: number; cuts: readonly number[] }): { first: number; end: number } {
	let best = { first: 0, end: frameCount };
	let bestLength = -1;
	for (const range of sceneRanges({ frameCount, cuts })) {
		if (range.end - range.first > bestLength) {
			best = range;
			bestLength = range.end - range.first;
		}
	}
	return best;
}

/**
 * The tracks of one scene, converted to frame pixels: `x_frame = (x_index +
 * 0.5) * frameWidth / tracks.w` (and the same for y), then made relative
 * to the frame centre.
 */
export function prepareTracks({
	tracks,
	frameWidth,
	frameHeight,
	scene,
	excluded,
	minFrames = MIN_TRACK_FRAMES,
}: {
	tracks: FeatureTracks;
	frameWidth: number;
	frameHeight: number;
	scene: { first: number; end: number };
	excluded?: ReadonlySet<number>;
	minFrames?: number;
}): SolverTracks {
	const sx = frameWidth / tracks.w;
	const sy = frameHeight / tracks.h;
	const frameCount = scene.end - scene.first;
	const ids: number[] = [];
	const starts: number[] = [];
	const lengths: number[] = [];
	const firstSample: number[] = [];
	for (let id = 0; id < tracks.trackStart.length; id++) {
		if (excluded?.has(id)) continue;
		const a = Math.max(tracks.trackStart[id], scene.first);
		const b = Math.min(tracks.trackStart[id] + tracks.trackLen[id], scene.end);
		if (b - a < minFrames) continue;
		ids.push(id);
		starts.push(a - scene.first);
		lengths.push(b - a);
		firstSample.push(a - tracks.trackStart[id]);
	}
	const count = ids.length;
	const offset = new Int32Array(count);
	let total = 0;
	for (let t = 0; t < count; t++) {
		offset[t] = total;
		total += lengths[t];
	}
	const uv = new Float64Array(total * 2);
	const cx = frameWidth / 2;
	const cy = frameHeight / 2;
	for (let t = 0; t < count; t++) {
		const base = tracks.trackOffset[ids[t]] + 2 * firstSample[t];
		for (let j = 0; j < lengths[t]; j++) {
			uv[2 * (offset[t] + j)] = (tracks.xy[base + 2 * j] + 0.5) * sx - cx;
			uv[2 * (offset[t] + j) + 1] = (tracks.xy[base + 2 * j + 1] + 0.5) * sy - cy;
		}
	}
	const counts = new Int32Array(frameCount + 1);
	for (let t = 0; t < count; t++) for (let j = 0; j < lengths[t]; j++) counts[starts[t] + j + 1]++;
	for (let f = 0; f < frameCount; f++) counts[f + 1] += counts[f];
	const live = new Int32Array(counts[frameCount]);
	const fill = Int32Array.from(counts.subarray(0, frameCount));
	for (let t = 0; t < count; t++) for (let j = 0; j < lengths[t]; j++) live[fill[starts[t] + j]++] = t;
	return {
		firstFrame: scene.first,
		frameCount,
		frameWidth,
		frameHeight,
		pixelScale: Math.sqrt(sx * sy),
		trackIds: Int32Array.from(ids),
		start: Int32Array.from(starts),
		length: Int32Array.from(lengths),
		offset,
		uv,
		liveOffsets: counts,
		live,
	};
}

/** Index of track `t`'s sample on frame `f` in `uv` pairs, or -1 when it is not alive there. */
export function sampleIndex({ st, track, frame }: { st: SolverTracks; track: number; frame: number }): number {
	const j = frame - st.start[track];
	if (j < 0 || j >= st.length[track]) return -1;
	return st.offset[track] + j;
}

/** Median number of kept tracks alive per frame. */
export function medianLive(st: SolverTracks): number {
	if (st.frameCount === 0) return 0;
	const counts = new Float64Array(st.frameCount);
	for (let f = 0; f < st.frameCount; f++) counts[f] = st.liveOffsets[f + 1] - st.liveOffsets[f];
	return median({ values: counts });
}

/**
 * How far the picture moves: the median over tracks of 5+ frames of the
 * largest distance a track gets from its first position, in ANALYSIS
 * pixels (the tracker's noise is in those units). 0 without such tracks.
 */
export function motionExtent(st: SolverTracks): number {
	const extents: number[] = [];
	for (let t = 0; t < st.trackIds.length; t++) {
		if (st.length[t] < 5) continue;
		const base = st.offset[t];
		const u0 = st.uv[2 * base];
		const v0 = st.uv[2 * base + 1];
		let far = 0;
		for (let j = 1; j < st.length[t]; j++) {
			far = Math.max(far, Math.hypot(st.uv[2 * (base + j)] - u0, st.uv[2 * (base + j) + 1] - v0));
		}
		extents.push(far / st.pixelScale);
	}
	return extents.length > 0 ? median({ values: extents }) : 0;
}

/** Tracks alive on both frames, with their samples there (frame pixels relative to the centre). */
export interface PairData {
	a: number;
	b: number;
	tracks: Int32Array;
	pa: Float64Array;
	pb: Float64Array;
	n: number;
}

export function pairData({ st, a, b }: { st: SolverTracks; a: number; b: number }): PairData {
	const shared: number[] = [];
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	for (let q = st.liveOffsets[lo]; q < st.liveOffsets[lo + 1]; q++) {
		const t = st.live[q];
		if (st.start[t] + st.length[t] - 1 >= hi) shared.push(t);
	}
	const n = shared.length;
	const pa = new Float64Array(2 * n);
	const pb = new Float64Array(2 * n);
	for (let i = 0; i < n; i++) {
		const t = shared[i];
		const ia = st.offset[t] + a - st.start[t];
		const ib = st.offset[t] + b - st.start[t];
		pa[2 * i] = st.uv[2 * ia];
		pa[2 * i + 1] = st.uv[2 * ia + 1];
		pb[2 * i] = st.uv[2 * ib];
		pb[2 * i + 1] = st.uv[2 * ib + 1];
	}
	return { a, b, tracks: Int32Array.from(shared), pa, pb, n };
}

/** Number of tracks alive on both frames. */
export function sharedCount({ st, a, b }: { st: SolverTracks; a: number; b: number }): number {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	let count = 0;
	for (let q = st.liveOffsets[lo]; q < st.liveOffsets[lo + 1]; q++) {
		const t = st.live[q];
		if (st.start[t] + st.length[t] - 1 >= hi) count++;
	}
	return count;
}

export interface KeyframeOptions {
	/** A new keyframe once fewer than this share of the last keyframe's tracks are still alive ... */
	keepShare: number;
	/** ... or the median track moved this share of the frame width since it ... */
	moveShare: number;
	/** ... or this many frames went by. */
	maxGap: number;
	/** At most this many keyframes (the gap grows instead). */
	maxKeyframes: number;
}

export const DEFAULT_KEYFRAME_OPTIONS: KeyframeOptions = {
	keepShare: 0.7,
	moveShare: 0.025,
	maxGap: 12,
	maxKeyframes: 48,
};

/**
 * Keyframes of the scene, ascending, always including its first and last
 * frame: a frame becomes a keyframe when the tracks it shares with the last
 * keyframe fall under `keepShare`, or they moved `moveShare` of the frame
 * width (median), or `maxGap` frames went by; never closer than
 * `frameCount / maxKeyframes` frames.
 */
export function selectKeyframes({ st, options = DEFAULT_KEYFRAME_OPTIONS }: { st: SolverTracks; options?: KeyframeOptions }): number[] {
	const n = st.frameCount;
	if (n <= 1) return n === 1 ? [0] : [];
	const minGap = Math.max(1, Math.ceil(n / options.maxKeyframes));
	const maxGap = Math.max(options.maxGap, minGap);
	const keyframes = [0];
	let last = 0;
	const moveLimit = options.moveShare * st.frameWidth;
	for (let f = 1; f < n; f++) {
		const gap = f - last;
		if (gap < minGap && f !== n - 1) continue;
		let take = gap >= maxGap || f === n - 1;
		if (!take) {
			const pair = pairData({ st, a: last, b: f });
			const liveLast = st.liveOffsets[last + 1] - st.liveOffsets[last];
			if (pair.n < options.keepShare * liveLast) take = true;
			else if (pair.n > 0) {
				const moves = new Float64Array(pair.n);
				for (let i = 0; i < pair.n; i++) {
					moves[i] = Math.hypot(pair.pb[2 * i] - pair.pa[2 * i], pair.pb[2 * i + 1] - pair.pa[2 * i + 1]);
				}
				if (median({ values: moves }) > moveLimit) take = true;
			}
		}
		if (take) {
			keyframes.push(f);
			last = f;
		}
	}
	return keyframes;
}
