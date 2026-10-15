/**
 * Incremental structure from motion over the keyframes of a scene, in the
 * spirit of Schonberger & Frahm, "Structure-from-Motion Revisited" (COLMAP,
 * CVPR 2016), cut down to an ordered video: a two-view initialisation on
 * the pair with the best mix of parallax and shared tracks, next-best-view
 * registration (PnP + RANSAC, then Levenberg-Marquardt), multi-view
 * triangulation with parallax and cheirality checks, local bundle
 * adjustment after each new keyframe and global bundle adjustment when the
 * model has grown, with outlier rejection by reprojection error.
 *
 * The state is per frame of the scene (cameras) and per kept track
 * (points), so the same state carries on into the all-frames stage
 * (`finalize.ts`).
 */
import { bundleAdjust, refinePoint, refinePose, type BundleProblem } from "./bundle";
import { pnpDlt, pnpDltUncalibrated, triangulate } from "./geometry";
import { closestRotation, median } from "./linalg";
import { pairData, sampleIndex, sharedCount, type PairData, type SolverTracks } from "./tracks";
import {
	initFromEssential,
	initFromHomography,
	ransacEssential,
	ransacHomography,
	type TwoViewInit,
} from "./two-view";
import type { Work } from "./work";

export type FocalMode = "fixed" | "shared" | "per-camera";

export interface Thresholds {
	/** RANSAC inlier distance, frame pixels. */
	ransac: number;
	/** Huber threshold of the adjustments, frame pixels. */
	huber: number;
	/** Observations further than this from their point's projection are outliers, frame pixels. */
	outlier: number;
	/** A new point needs rays at least this many degrees apart. */
	minParallaxDeg: number;
}

/** Thresholds in analysis pixels (the tracker's units), turned into frame pixels. */
export function thresholdsFor(st: SolverTracks): Thresholds {
	const s = st.pixelScale;
	return { ransac: 1.0 * s, huber: 0.25 * s, outlier: 0.8 * s, minParallaxDeg: 1 };
}

export interface Reconstruction {
	st: SolverTracks;
	registered: Uint8Array;
	/** Per frame: world-to-camera rotation (9), centre (3), focal length. */
	rotations: Float64Array;
	centers: Float64Array;
	focals: Float64Array;
	/** Per track: 1 when it has a 3D point. */
	hasPoint: Uint8Array;
	points: Float64Array;
	/** Per sample: 1 = rejected observation. */
	bad: Uint8Array;
}

export function createReconstruction({ st, focal }: { st: SolverTracks; focal: number }): Reconstruction {
	const frames = st.frameCount;
	const tracks = st.trackIds.length;
	return {
		st,
		registered: new Uint8Array(frames),
		rotations: new Float64Array(frames * 9),
		centers: new Float64Array(frames * 3),
		focals: new Float64Array(frames).fill(focal),
		hasPoint: new Uint8Array(tracks),
		points: new Float64Array(tracks * 3),
		bad: new Uint8Array(st.uv.length / 2),
	};
}

/** Reprojection error of track `track`'s point on frame `frame` (Infinity behind the camera). */
export function reprojectionError({ rec, track, frame, sample }: { rec: Reconstruction; track: number; frame: number; sample: number }): number {
	const r = frame * 9;
	const R = rec.rotations;
	const dx = rec.points[track * 3] - rec.centers[frame * 3];
	const dy = rec.points[track * 3 + 1] - rec.centers[frame * 3 + 1];
	const dz = rec.points[track * 3 + 2] - rec.centers[frame * 3 + 2];
	const z = R[r + 6] * dx + R[r + 7] * dy + R[r + 8] * dz;
	if (!(z > 1e-9)) return Infinity;
	const x = R[r] * dx + R[r + 1] * dy + R[r + 2] * dz;
	const y = R[r + 3] * dx + R[r + 4] * dy + R[r + 5] * dz;
	const f = rec.focals[frame];
	return Math.hypot((f * x) / z - rec.st.uv[2 * sample], (f * y) / z - rec.st.uv[2 * sample + 1]);
}

/** The points and observations a frame can be registered with: tracks alive there with a point and a good sample. */
function correspondences({ rec, frame }: { rec: Reconstruction; frame: number }): { tracks: number[]; samples: number[] } {
	const { st } = rec;
	const tracks: number[] = [];
	const samples: number[] = [];
	for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) {
		const t = st.live[q];
		if (!rec.hasPoint[t]) continue;
		const s = sampleIndex({ st, track: t, frame });
		if (s < 0 || rec.bad[s]) continue;
		tracks.push(t);
		samples.push(s);
	}
	return { tracks, samples };
}

/** Number of frames whose registration could use the current points. */
export function correspondenceCount({ rec, frame }: { rec: Reconstruction; frame: number }): number {
	const { st } = rec;
	let count = 0;
	for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) {
		const t = st.live[q];
		if (!rec.hasPoint[t]) continue;
		const s = sampleIndex({ st, track: t, frame });
		if (s >= 0 && !rec.bad[s]) count++;
	}
	return count;
}

/** Copies the pose of `from` to `to` (a prediction for a neighbour). */
export function copyPose({ rec, from, to }: { rec: Reconstruction; from: number; to: number }): void {
	rec.rotations.copyWithin(to * 9, from * 9, from * 9 + 9);
	rec.centers.copyWithin(to * 3, from * 3, from * 3 + 3);
	rec.focals[to] = rec.focals[from];
}

/** Count of inliers of a pose hypothesis among the correspondences. */
function countInliers({
	r,
	c,
	f,
	pts,
	uv,
	threshold,
}: {
	r: ArrayLike<number>;
	c: ArrayLike<number>;
	f: number;
	pts: Float64Array;
	uv: Float64Array;
	threshold: number;
}): number {
	let count = 0;
	const n = pts.length / 3;
	for (let i = 0; i < n; i++) {
		const dx = pts[i * 3] - c[0];
		const dy = pts[i * 3 + 1] - c[1];
		const dz = pts[i * 3 + 2] - c[2];
		const z = r[6] * dx + r[7] * dy + r[8] * dz;
		if (!(z > 1e-9)) continue;
		const x = r[0] * dx + r[1] * dy + r[2] * dz;
		const y = r[3] * dx + r[4] * dy + r[5] * dz;
		if (Math.hypot((f * x) / z - uv[2 * i], (f * y) / z - uv[2 * i + 1]) < threshold) count++;
	}
	return count;
}

/**
 * Registers `frame` against the current points: hypotheses from the
 * `prediction` frame's pose and from DLT resection on random 6-point
 * samples (RANSAC), the best by inlier count refined by robust LM twice
 * (the second time on the inliers of the first). `false` (and nothing
 * changed) with fewer than `minInliers` inliers.
 */
export function registerFrame({
	rec,
	frame,
	prediction,
	focalMode,
	thresholds,
	random,
	ransacRounds,
	minInliers = 10,
	fixPosition = false,
	focalPriorWeight = 0,
}: {
	rec: Reconstruction;
	frame: number;
	/** A registered frame whose pose (and focal) seeds this one, or -1. */
	prediction: number;
	focalMode: FocalMode;
	thresholds: Thresholds;
	random: () => number;
	ransacRounds: number;
	minInliers?: number;
	fixPosition?: boolean;
	/** `per-camera`: weight tying this frame's ln focal to the prediction's. */
	focalPriorWeight?: number;
}): boolean {
	const { tracks, samples } = correspondences({ rec, frame });
	const n = tracks.length;
	if (n < Math.max(6, minInliers)) return false;
	const pts = new Float64Array(n * 3);
	const uv = new Float64Array(n * 2);
	for (let i = 0; i < n; i++) {
		pts.set(rec.points.subarray(tracks[i] * 3, tracks[i] * 3 + 3), i * 3);
		uv[2 * i] = rec.st.uv[2 * samples[i]];
		uv[2 * i + 1] = rec.st.uv[2 * samples[i] + 1];
	}
	const baseFocal = prediction >= 0 ? rec.focals[prediction] : rec.focals[frame];
	let bestR: Float64Array | null = null;
	let bestC: Float64Array | null = null;
	let bestF = baseFocal;
	let bestCount = -1;
	if (prediction >= 0) {
		// the neighbour's pose, pulled in by robust LM with a shrinking Huber threshold: unlike
		// the DLT below this works when the points are (nearly) coplanar
		let r: Float64Array = rec.rotations.slice(prediction * 9, prediction * 9 + 9);
		let c: Float64Array = rec.centers.slice(prediction * 3, prediction * 3 + 3);
		let f = baseFocal;
		for (const huber of [Math.max(40, 10 * thresholds.ransac), 3 * thresholds.ransac, thresholds.ransac]) {
			const refined = refinePose({
				rotation: r,
				center: c,
				focal: f,
				points: pts,
				uv,
				huber,
				iterations: 10,
				refineFocal: focalMode === "per-camera" && huber <= 3 * thresholds.ransac,
				fixPosition,
				focalPrior: focalMode === "per-camera" ? { value: baseFocal, weight: Math.max(focalPriorWeight, 1) } : undefined,
			});
			r = refined.rotation;
			c = refined.center;
			f = refined.focal;
		}
		bestCount = countInliers({ r, c, f, pts, uv, threshold: thresholds.ransac });
		bestR = r;
		bestC = c;
		bestF = f;
	}
	if (!fixPosition && ransacRounds > 0 && n >= 6) {
		const normalised = Float64Array.from(uv, (value) => value / baseFocal);
		const sample = new Int32Array(6);
		for (let round = 0; round < ransacRounds; round++) {
			for (let i = 0; i < 6; i++) {
				let pick = Math.floor(random() * n);
				for (let tries = 0; tries < 16; tries++) {
					let clash = false;
					for (let j = 0; j < i; j++) if (sample[j] === pick) clash = true;
					if (!clash) break;
					pick = Math.floor(random() * n);
				}
				sample[i] = pick;
			}
			let r: Float64Array;
			let t: Float64Array;
			let f = baseFocal;
			if (focalMode === "per-camera") {
				const pose = pnpDltUncalibrated({ points: pts, uv, idx: sample, n: 6, focalGuess: baseFocal });
				if (!pose || !(pose.focal > baseFocal / 3 && pose.focal < baseFocal * 3)) continue;
				r = pose.r;
				t = pose.t;
				f = pose.focal;
			} else {
				const pose = pnpDlt({ points: pts, xs: normalised, idx: sample, n: 6 });
				if (!pose) continue;
				r = pose.r;
				t = pose.t;
			}
			const c = Float64Array.from([
				-(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]),
				-(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]),
				-(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]),
			]);
			const count = countInliers({ r, c, f, pts, uv, threshold: thresholds.ransac });
			if (count > bestCount) {
				bestCount = count;
				bestR = r;
				bestC = c;
				bestF = f;
			}
		}
	}
	if (!bestR || !bestC || bestCount < minInliers) return false;
	let r: Float64Array = bestR;
	let c: Float64Array = bestC;
	let f = bestF;
	const refineFocal = focalMode === "per-camera";
	const focalPrior = refineFocal && focalPriorWeight > 0 ? { value: baseFocal, weight: focalPriorWeight } : undefined;
	let inliers = 0;
	for (let pass = 0; pass < 2; pass++) {
		const keep: number[] = [];
		for (let i = 0; i < n; i++) {
			const dx = pts[i * 3] - c[0];
			const dy = pts[i * 3 + 1] - c[1];
			const dz = pts[i * 3 + 2] - c[2];
			const z = r[6] * dx + r[7] * dy + r[8] * dz;
			if (!(z > 1e-9)) continue;
			const x = r[0] * dx + r[1] * dy + r[2] * dz;
			const y = r[3] * dx + r[4] * dy + r[5] * dz;
			const limit = pass === 0 ? thresholds.ransac : thresholds.outlier;
			if (Math.hypot((f * x) / z - uv[2 * i], (f * y) / z - uv[2 * i + 1]) < limit) keep.push(i);
		}
		if (keep.length < minInliers) return false;
		const subPts = new Float64Array(keep.length * 3);
		const subUv = new Float64Array(keep.length * 2);
		keep.forEach((i, k) => {
			subPts.set(pts.subarray(i * 3, i * 3 + 3), k * 3);
			subUv[2 * k] = uv[2 * i];
			subUv[2 * k + 1] = uv[2 * i + 1];
		});
		const refined = refinePose({
			rotation: r,
			center: c,
			focal: f,
			points: subPts,
			uv: subUv,
			huber: thresholds.huber,
			iterations: 15,
			refineFocal,
			fixPosition,
			focalPrior,
		});
		r = refined.rotation;
		c = refined.center;
		f = refined.focal;
		inliers = keep.length;
	}
	if (inliers < minInliers) return false;
	rec.rotations.set(r, frame * 9);
	rec.centers.set(c, frame * 3);
	rec.focals[frame] = f;
	rec.registered[frame] = 1;
	return true;
}

/**
 * Triangulates `track` from the given registered frames it is seen on
 * (good samples only): DLT, then Gauss-Newton; accepted when it is in
 * front of every camera, the widest ray pair spans `minParallaxDeg` and
 * every observation reprojects within the outlier threshold.
 */
export function triangulateTrack({
	rec,
	track,
	frames,
	thresholds,
}: {
	rec: Reconstruction;
	track: number;
	frames: readonly number[];
	thresholds: Thresholds;
}): boolean {
	const { st } = rec;
	const views: number[] = [];
	const samples: number[] = [];
	for (const frame of frames) {
		const s = sampleIndex({ st, track, frame });
		if (s < 0 || rec.bad[s] || !rec.registered[frame]) continue;
		views.push(frame);
		samples.push(s);
	}
	if (views.length < 2) return false;
	const rotations = views.map((frame) => rec.rotations.subarray(frame * 9, frame * 9 + 9));
	const translations = views.map((frame) => {
		const r = rec.rotations.subarray(frame * 9, frame * 9 + 9);
		const c = rec.centers.subarray(frame * 3, frame * 3 + 3);
		return [-(r[0] * c[0] + r[1] * c[1] + r[2] * c[2]), -(r[3] * c[0] + r[4] * c[1] + r[5] * c[2]), -(r[6] * c[0] + r[7] * c[1] + r[8] * c[2])];
	});
	const xs = views.map((frame, k) => st.uv[2 * samples[k]] / rec.focals[frame]);
	const ys = views.map((frame, k) => st.uv[2 * samples[k] + 1] / rec.focals[frame]);
	const x = triangulate({ rotations, translations, xs, ys });
	if (!x) return false;
	const refined = refinePoint({
		point: x,
		rotations: rec.rotations,
		centers: rec.centers,
		focals: rec.focals,
		cameras: Int32Array.from(views),
		uv: Float64Array.from(samples.flatMap((s) => [st.uv[2 * s], st.uv[2 * s + 1]])),
		iterations: 8,
	});
	const p = refined.point;
	// parallax at the point: the widest angle between the viewing rays from the camera centres
	let parallax = 0;
	const dirs = views.map((frame) => {
		const d = [p[0] - rec.centers[frame * 3], p[1] - rec.centers[frame * 3 + 1], p[2] - rec.centers[frame * 3 + 2]];
		const length = Math.hypot(d[0], d[1], d[2]);
		return [d[0] / length, d[1] / length, d[2] / length];
	});
	for (let k = 1; k < dirs.length; k++) {
		const cos = dirs[0][0] * dirs[k][0] + dirs[0][1] * dirs[k][1] + dirs[0][2] * dirs[k][2];
		parallax = Math.max(parallax, Math.acos(Math.max(-1, Math.min(1, cos))));
	}
	for (let k = 0; k < dirs.length - 1; k++) {
		const end = dirs[dirs.length - 1];
		const cos = end[0] * dirs[k][0] + end[1] * dirs[k][1] + end[2] * dirs[k][2];
		parallax = Math.max(parallax, Math.acos(Math.max(-1, Math.min(1, cos))));
	}
	if ((parallax * 180) / Math.PI < thresholds.minParallaxDeg) return false;
	for (let k = 0; k < views.length; k++) {
		if (!(refined.errors[k] < thresholds.outlier)) return false;
	}
	rec.points.set(p, track * 3);
	rec.hasPoint[track] = 1;
	return true;
}

/** Registered frames among `frames` on which `track` is alive. */
function framesOfTrack({ rec, track, frames }: { rec: Reconstruction; track: number; frames: readonly number[] }): number[] {
	const out: number[] = [];
	const first = rec.st.start[track];
	const end = first + rec.st.length[track];
	for (const frame of frames) if (frame >= first && frame < end && rec.registered[frame]) out.push(frame);
	return out;
}

/** Bundle adjustment of the given frames' cameras (some held) and the points they see, written back. */
export async function adjust({
	rec,
	frames,
	fixedFrames,
	focalMode,
	thresholds,
	iterations,
	work,
	pointTracks,
	fixPositions = false,
	scaleAnchor = true,
	pointDamping = 0,
}: {
	rec: Reconstruction;
	/** Registered frames in the problem, ascending. */
	frames: readonly number[];
	fixedFrames: ReadonlySet<number>;
	focalMode: FocalMode;
	thresholds: Thresholds;
	iterations: number;
	work: Work;
	/** Points to adjust (default: every point seen by a free frame). */
	pointTracks?: readonly number[];
	fixPositions?: boolean;
	/** Hold one coordinate of the camera farthest from the first held one (the scale gauge). */
	scaleAnchor?: boolean;
	pointDamping?: number;
}): Promise<void> {
	const { st } = rec;
	const cameraOf = new Map<number, number>();
	frames.forEach((frame, index) => cameraOf.set(frame, index));
	let tracks: number[];
	if (pointTracks) {
		tracks = [...pointTracks];
	} else {
		const seen = new Set<number>();
		for (const frame of frames) {
			if (fixedFrames.has(frame)) continue;
			for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) {
				const t = st.live[q];
				if (rec.hasPoint[t]) seen.add(t);
			}
		}
		tracks = [...seen].sort((a, b) => a - b);
	}
	const pointOf = new Map<number, number>();
	tracks.forEach((track, index) => pointOf.set(track, index));
	const obsCamera: number[] = [];
	const obsPoint: number[] = [];
	const obsUv: number[] = [];
	for (const track of tracks) {
		const first = st.start[track];
		const end = first + st.length[track];
		for (const frame of frames) {
			if (frame < first || frame >= end) continue;
			const s = st.offset[track] + frame - first;
			if (rec.bad[s]) continue;
			obsCamera.push(cameraOf.get(frame) ?? 0);
			obsPoint.push(pointOf.get(track) ?? 0);
			obsUv.push(st.uv[2 * s], st.uv[2 * s + 1]);
		}
	}
	if (obsCamera.length === 0) return;
	const count = frames.length;
	const rotations = new Float64Array(count * 9);
	const centers = new Float64Array(count * 3);
	const focals = new Float64Array(count);
	const fixedPose = new Uint8Array(count);
	frames.forEach((frame, index) => {
		rotations.set(rec.rotations.subarray(frame * 9, frame * 9 + 9), index * 9);
		centers.set(rec.centers.subarray(frame * 3, frame * 3 + 3), index * 3);
		focals[index] = rec.focals[frame];
		fixedPose[index] = fixedFrames.has(frame) ? 1 : 0;
	});
	let anyFixed = fixedPose.some((value) => value === 1);
	if (!anyFixed) {
		fixedPose[0] = 1;
		anyFixed = true;
	}
	let anchor: { camera: number; axis: 0 | 1 | 2 } | null = null;
	const firstFixed = fixedPose.indexOf(1);
	const fixedCount = fixedPose.reduce((sum, value) => sum + value, 0);
	if (scaleAnchor && !fixPositions && fixedCount === 1) {
		let farthest = -1;
		let distance = 0;
		for (let i = 0; i < count; i++) {
			if (fixedPose[i]) continue;
			const d = Math.hypot(
				centers[i * 3] - centers[firstFixed * 3],
				centers[i * 3 + 1] - centers[firstFixed * 3 + 1],
				centers[i * 3 + 2] - centers[firstFixed * 3 + 2],
			);
			if (d > distance) {
				distance = d;
				farthest = i;
			}
		}
		if (farthest >= 0) {
			const delta = [0, 1, 2].map((k) => Math.abs(centers[farthest * 3 + k] - centers[firstFixed * 3 + k]));
			const axis = delta[0] >= delta[1] && delta[0] >= delta[2] ? 0 : delta[1] >= delta[2] ? 1 : 2;
			anchor = { camera: farthest, axis };
		}
	}
	let smoothness: Float64Array | null = null;
	let fixedFocal: Uint8Array | null = null;
	if (focalMode === "per-camera") {
		smoothness = new Float64Array(Math.max(0, count - 1));
		for (let i = 0; i + 1 < count; i++) smoothness[i] = FOCAL_SMOOTHNESS / Math.sqrt(Math.max(1, frames[i + 1] - frames[i]));
		fixedFocal = Uint8Array.from(frames, (frame) => (fixedFrames.has(frame) ? 1 : 0));
	}
	const problem: BundleProblem = {
		cameras: { count, rotations, centers, focals },
		points: new Float64Array(tracks.length * 3),
		observations: {
			count: obsCamera.length,
			camera: Int32Array.from(obsCamera),
			point: Int32Array.from(obsPoint),
			uv: Float64Array.from(obsUv),
			active: new Uint8Array(obsCamera.length).fill(1),
		},
	};
	tracks.forEach((track, index) => problem.points.set(rec.points.subarray(track * 3, track * 3 + 3), index * 3));
	await bundleAdjust({
		problem,
		options: {
			fixedPose,
			fixPositions,
			focal: focalMode,
			focalSmoothness: smoothness,
			fixedFocal,
			fixedPoints: null,
			huber: thresholds.huber,
			maxIterations: iterations,
			scaleAnchor: anchor,
			pointDamping,
		},
		step: () => work.checkpoint(),
	});
	frames.forEach((frame, index) => {
		rec.rotations.set(closestRotation(rotations.subarray(index * 9, index * 9 + 9)), frame * 9);
		rec.centers.set(centers.subarray(index * 3, index * 3 + 3), frame * 3);
		rec.focals[frame] = focals[index];
	});
	if (focalMode === "shared") {
		// the shared focal applies to every frame, solved or not
		const shared = focals[0];
		rec.focals.fill(shared);
	}
	tracks.forEach((track, index) => rec.points.set(problem.points.subarray(index * 3, index * 3 + 3), track * 3));
}

/** Weight of the per-keyframe focal smoothness residual `w (ln f_k - ln f_k+1)` per sqrt(frame gap). */
export const FOCAL_SMOOTHNESS = 20;

/**
 * Rejects observations on `frames` that reproject further than the
 * outlier threshold (or behind the camera), then drops the points left with
 * fewer than 2 good observations on `supportFrames` (default `frames`).
 * Returns the number of rejected observations.
 */
export function rejectOutliers({
	rec,
	frames,
	thresholds,
	supportFrames,
}: {
	rec: Reconstruction;
	frames: readonly number[];
	thresholds: Thresholds;
	supportFrames?: readonly number[];
}): number {
	const { st } = rec;
	let rejected = 0;
	const touched = new Set<number>();
	for (const frame of frames) {
		if (!rec.registered[frame]) continue;
		for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) {
			const t = st.live[q];
			if (!rec.hasPoint[t]) continue;
			const s = st.offset[t] + frame - st.start[t];
			if (rec.bad[s]) continue;
			const e = reprojectionError({ rec, track: t, frame, sample: s });
			if (!(e < thresholds.outlier)) {
				rec.bad[s] = 1;
				rejected++;
				touched.add(t);
			}
		}
	}
	const support = supportFrames ?? frames;
	for (const t of touched) {
		let good = 0;
		for (const frame of support) {
			if (!rec.registered[frame]) continue;
			const s = sampleIndex({ st, track: t, frame });
			if (s >= 0 && !rec.bad[s]) good++;
		}
		if (good < 2) rec.hasPoint[t] = 0;
	}
	return rejected;
}

/** Bearing-vector parallax (degrees, median) between two frames after the best rotation (Wahba) is removed. */
function rotationFreeParallax({ pair, focal }: { pair: PairData; focal: number }): number {
	const n = pair.n;
	if (n < 8) return 0;
	const a = new Float64Array(n * 3);
	const b = new Float64Array(n * 3);
	const m = new Float64Array(9);
	for (let i = 0; i < n; i++) {
		const ax = pair.pa[2 * i] / focal;
		const ay = pair.pa[2 * i + 1] / focal;
		const la = Math.hypot(ax, ay, 1);
		const bx = pair.pb[2 * i] / focal;
		const by = pair.pb[2 * i + 1] / focal;
		const lb = Math.hypot(bx, by, 1);
		a.set([ax / la, ay / la, 1 / la], i * 3);
		b.set([bx / lb, by / lb, 1 / lb], i * 3);
		for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 3 + c] += b[i * 3 + r] * a[i * 3 + c];
	}
	const rot = closestRotation(m);
	const angles = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const rx = rot[0] * a[i * 3] + rot[1] * a[i * 3 + 1] + rot[2] * a[i * 3 + 2];
		const ry = rot[3] * a[i * 3] + rot[4] * a[i * 3 + 1] + rot[5] * a[i * 3 + 2];
		const rz = rot[6] * a[i * 3] + rot[7] * a[i * 3 + 1] + rot[8] * a[i * 3 + 2];
		const cos = rx * b[i * 3] + ry * b[i * 3 + 1] + rz * b[i * 3 + 2];
		angles[i] = Math.acos(Math.max(-1, Math.min(1, cos)));
	}
	return (median({ values: angles }) * 180) / Math.PI;
}

/** Candidate initial pairs of keyframes, best first. */
function initialPairs({ st, keyframes, focal }: { st: SolverTracks; keyframes: readonly number[]; focal: number }): { a: number; b: number; score: number }[] {
	const out: { a: number; b: number; score: number }[] = [];
	for (let i = 0; i < keyframes.length; i++) {
		const a = keyframes[i];
		const liveA = st.liveOffsets[a + 1] - st.liveOffsets[a];
		for (let j = i + 1; j < keyframes.length; j++) {
			const b = keyframes[j];
			const shared = sharedCount({ st, a, b });
			if (shared < Math.max(30, 0.25 * liveA)) break;
			const parallax = rotationFreeParallax({ pair: pairData({ st, a, b }), focal });
			out.push({ a, b, score: Math.min(parallax, INIT_PARALLAX_DEG) * Math.sqrt(shared) });
		}
	}
	return out.sort((p, q) => q.score - p.score);
}

/** Parallax (degrees) above which a wider initial pair is not preferred over more shared tracks. */
const INIT_PARALLAX_DEG = 4;

export type ReconstructMethod = "typical" | "mostly-flat";

/**
 * Builds cameras for the keyframes and points for the tracks in
 * `trackFilter` (all when omitted). `null` when no initial pair works.
 */
export async function reconstructKeyframes({
	rec,
	keyframes,
	focalMode,
	method,
	work,
	random,
	onProgress,
}: {
	rec: Reconstruction;
	keyframes: readonly number[];
	focalMode: FocalMode;
	method: ReconstructMethod;
	work: Work;
	random: () => number;
	/** Share of the keyframes registered, 0..1. */
	onProgress?: (fraction: number) => void;
}): Promise<{ initPair: [number, number] } | null> {
	const { st } = rec;
	const thresholds = thresholdsFor(st);
	const focal = rec.focals[keyframes[0]];
	const pairs = initialPairs({ st, keyframes, focal });
	let init: TwoViewInit | null = null;
	let pair: PairData | null = null;
	for (const candidate of pairs.slice(0, 6)) {
		await work.checkpoint();
		const data = pairData({ st, a: candidate.a, b: candidate.b });
		let result: TwoViewInit | null = null;
		if (method === "mostly-flat") {
			const fit = ransacHomography({ pair: data, threshold: thresholds.ransac, maxRounds: 300, random });
			if (fit) result = initFromHomography({ pair: data, focal, fit, maxError: thresholds.ransac, minParallaxDeg: thresholds.minParallaxDeg / 2 });
		}
		if (!result) {
			const fit = ransacEssential({ pair: data, focal, threshold: thresholds.ransac, maxRounds: 400, random });
			if (fit) result = initFromEssential({ pair: data, focal, fit, maxError: thresholds.ransac, minParallaxDeg: thresholds.minParallaxDeg / 2 });
		}
		if (result && result.pairIndices.length >= Math.max(20, 0.3 * data.n)) {
			init = result;
			pair = data;
			break;
		}
	}
	if (!init || !pair) return null;
	const a = pair.a;
	const b = pair.b;
	rec.rotations.set([1, 0, 0, 0, 1, 0, 0, 0, 1], a * 9);
	rec.centers.set([0, 0, 0], a * 3);
	rec.rotations.set(init.r, b * 9);
	const r = init.r;
	const t = init.t;
	rec.centers.set(
		[-(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]), -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]), -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2])],
		b * 3,
	);
	rec.registered[a] = 1;
	rec.registered[b] = 1;
	for (let k = 0; k < init.pairIndices.length; k++) {
		const track = pair.tracks[init.pairIndices[k]];
		rec.points.set(init.points.subarray(k * 3, k * 3 + 3), track * 3);
		rec.hasPoint[track] = 1;
	}
	const initFrames = [a, b];
	await adjust({ rec, frames: initFrames, fixedFrames: new Set([a]), focalMode: "fixed", thresholds, iterations: 20, work });
	rejectOutliers({ rec, frames: initFrames, thresholds });

	const order: number[] = [a, b];
	let sinceGlobal = 2;
	const pending = new Set(keyframes.filter((k) => k !== a && k !== b));
	const failed = new Set<number>();
	for (let step = 0; step < keyframes.length * 2 && pending.size > 0; step++) {
		await work.checkpoint();
		// next best view: the most points to register against, nearest to the model on ties
		let next = -1;
		let nextCount = -1;
		for (const frame of pending) {
			if (failed.has(frame)) continue;
			const count = correspondenceCount({ rec, frame });
			if (count > nextCount) {
				next = frame;
				nextCount = count;
			}
		}
		if (next < 0) break;
		let prediction = -1;
		let nearest = Infinity;
		for (const frame of order) {
			if (Math.abs(frame - next) < nearest) {
				nearest = Math.abs(frame - next);
				prediction = frame;
			}
		}
		const ok = registerFrame({
			rec,
			frame: next,
			prediction,
			focalMode: focalMode === "per-camera" ? "per-camera" : "fixed",
			thresholds,
			random,
			ransacRounds: 60,
			focalPriorWeight: 5,
		});
		if (!ok) {
			failed.add(next);
			continue;
		}
		pending.delete(next);
		order.push(next);
		// a failed frame may work now that the model grew
		failed.clear();
		const registeredKeyframes = keyframes.filter((k) => rec.registered[k]);
		// new points from the tracks seen on the new keyframe
		for (let q = st.liveOffsets[next]; q < st.liveOffsets[next + 1]; q++) {
			const track = st.live[q];
			if (rec.hasPoint[track]) continue;
			triangulateTrack({ rec, track, frames: framesOfTrack({ rec, track, frames: registeredKeyframes }), thresholds });
		}
		sinceGlobal++;
		if (sinceGlobal >= Math.max(4, Math.ceil(0.4 * order.length))) {
			await adjust({ rec, frames: registeredKeyframes, fixedFrames: new Set([a]), focalMode, thresholds, iterations: 12, work });
			rejectOutliers({ rec, frames: registeredKeyframes, thresholds });
			sinceGlobal = 0;
		} else {
			// local adjustment: the last few registered keyframes free, their other observers held
			const window = order.slice(-LOCAL_WINDOW);
			const windowSet = new Set(window);
			const seen = new Set<number>();
			for (const frame of window) {
				for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) {
					const track = st.live[q];
					if (rec.hasPoint[track]) seen.add(track);
				}
			}
			const held = registeredKeyframes.filter((frame) => {
				if (windowSet.has(frame)) return false;
				for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) if (seen.has(st.live[q])) return true;
				return false;
			});
			const frames = [...window, ...held].sort((x, y) => x - y);
			const fixedFrames = new Set(held);
			if (held.length === 0) fixedFrames.add(a);
			await adjust({
				rec,
				frames,
				fixedFrames,
				focalMode: focalMode === "per-camera" ? "per-camera" : "fixed",
				thresholds,
				iterations: 6,
				work,
				pointTracks: [...seen].sort((x, y) => x - y),
				scaleAnchor: held.length === 0,
			});
			rejectOutliers({ rec, frames: window, thresholds, supportFrames: registeredKeyframes });
		}
		onProgress?.(order.length / keyframes.length);
	}
	const registeredKeyframes = keyframes.filter((k) => rec.registered[k]);
	await adjust({ rec, frames: registeredKeyframes, fixedFrames: new Set([a]), focalMode, thresholds, iterations: 25, work });
	rejectOutliers({ rec, frames: registeredKeyframes, thresholds });
	for (const frame of registeredKeyframes) {
		for (let q = st.liveOffsets[frame]; q < st.liveOffsets[frame + 1]; q++) {
			const track = st.live[q];
			if (!rec.hasPoint[track]) triangulateTrack({ rec, track, frames: framesOfTrack({ rec, track, frames: registeredKeyframes }), thresholds });
		}
	}
	await adjust({ rec, frames: registeredKeyframes, fixedFrames: new Set([a]), focalMode, thresholds, iterations: 25, work });
	rejectOutliers({ rec, frames: registeredKeyframes, thresholds });
	return { initPair: [a, b] };
}

/** Keyframes adjusted together after each registration. */
const LOCAL_WINDOW = 5;
