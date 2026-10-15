/**
 * From the keyframe model to every frame: each frame is registered against
 * the keyframe points (motion-only LM from the pose interpolated between
 * its solved neighbours), then the structure is completed with the tracks
 * that live between keyframes and refined with all frames, and the frames
 * are registered again ("resection-intersection", alternating the two
 * halves of a bundle adjustment with the other half held). A zoom's focal
 * lengths are smoothed over time before the last pass.
 */
import { refinePoint } from "./bundle";
import { mat3Mul, mat3Transpose, rotExp, rotLog } from "./linalg";
import {
	registerFrame,
	reprojectionError,
	thresholdsFor,
	triangulateTrack,
	type FocalMode,
	type Reconstruction,
} from "./reconstruct";
import type { Work } from "./work";

/** Sets `frame`'s pose to the interpolation between registered frames `a` < frame < `b`. */
function interpolatePose({ rec, frame, a, b }: { rec: Reconstruction; frame: number; a: number; b: number }): void {
	const t = (frame - a) / (b - a);
	const ra = rec.rotations.subarray(a * 9, a * 9 + 9);
	const rb = rec.rotations.subarray(b * 9, b * 9 + 9);
	const w = rotLog(mat3Mul({ a: rb, b: mat3Transpose(ra) }));
	rec.rotations.set(mat3Mul({ a: rotExp([w[0] * t, w[1] * t, w[2] * t]), b: ra }), frame * 9);
	for (let k = 0; k < 3; k++) {
		rec.centers[frame * 3 + k] = rec.centers[a * 3 + k] + (rec.centers[b * 3 + k] - rec.centers[a * 3 + k]) * t;
	}
	rec.focals[frame] = Math.exp(Math.log(rec.focals[a]) + (Math.log(rec.focals[b]) - Math.log(rec.focals[a])) * t);
}

/** Registered frames on which a track is alive. */
function trackFrames({ rec, track }: { rec: Reconstruction; track: number }): number[] {
	const out: number[] = [];
	const first = rec.st.start[track];
	for (let j = 0; j < rec.st.length[track]; j++) if (rec.registered[first + j]) out.push(first + j);
	return out;
}

/** Registers every frame that is not registered yet; returns how many could not be. */
export async function registerRemaining({
	rec,
	focalMode,
	fixPosition,
	work,
	random,
}: {
	rec: Reconstruction;
	focalMode: FocalMode;
	fixPosition: boolean;
	work: Work;
	random: () => number;
}): Promise<number> {
	const n = rec.st.frameCount;
	const thresholds = thresholdsFor(rec.st);
	const anchors: number[] = [];
	for (let f = 0; f < n; f++) if (rec.registered[f]) anchors.push(f);
	if (anchors.length === 0) return n;
	const firstAnchor = anchors[0];
	const tryFrame = ({ frame, from }: { frame: number; from: number }): boolean => {
		const ok = registerFrame({
			rec,
			frame,
			prediction: from,
			focalMode: focalMode === "per-camera" ? "per-camera" : "fixed",
			thresholds,
			random,
			ransacRounds: 0,
			minInliers: 8,
			fixPosition,
			focalPriorWeight: 20,
		});
		if (ok) return true;
		return registerFrame({
			rec,
			frame,
			prediction: from,
			focalMode: focalMode === "per-camera" ? "per-camera" : "fixed",
			thresholds,
			random,
			ransacRounds: 60,
			minInliers: 8,
			fixPosition,
			focalPriorWeight: 20,
		});
	};
	let failed = 0;
	for (let f = firstAnchor + 1; f < n; f++) {
		if (rec.registered[f]) continue;
		if (f % 8 === 0) await work.checkpoint();
		let next = -1;
		for (let g = f + 1; g < n; g++) {
			if (rec.registered[g]) {
				next = g;
				break;
			}
		}
		let previous = f - 1;
		while (previous >= 0 && !rec.registered[previous]) previous--;
		if (previous < 0) continue;
		if (next >= 0) interpolatePose({ rec, frame: f, a: previous, b: next });
		else {
			rec.rotations.copyWithin(f * 9, previous * 9, previous * 9 + 9);
			rec.centers.copyWithin(f * 3, previous * 3, previous * 3 + 3);
			rec.focals[f] = rec.focals[previous];
		}
		if (!tryFrame({ frame: f, from: f })) failed++;
	}
	for (let f = firstAnchor - 1; f >= 0; f--) {
		if (f % 8 === 0) await work.checkpoint();
		let next = f + 1;
		while (next < n && !rec.registered[next]) next++;
		if (next >= n) continue;
		rec.rotations.copyWithin(f * 9, next * 9, next * 9 + 9);
		rec.centers.copyWithin(f * 3, next * 3, next * 3 + 3);
		rec.focals[f] = rec.focals[next];
		if (!tryFrame({ frame: f, from: f })) failed++;
	}
	return failed;
}

/**
 * Completes and refines the points with every registered frame: tracks
 * without a point are triangulated (or, for a rotation-only solve, placed
 * on their mean viewing direction at `rotationOnlyDistance`), every point
 * is re-estimated from all its good observations, observations past the
 * outlier threshold are rejected, points left with fewer than two good
 * observations are dropped.
 */
export async function refineStructure({
	rec,
	work,
	rotationOnlyDistance,
}: {
	rec: Reconstruction;
	work: Work;
	/** Set for a rotation-only (tripod) solve: points live on a sphere of this radius around the camera. */
	rotationOnlyDistance: number | null;
}): Promise<void> {
	const { st } = rec;
	const thresholds = thresholdsFor(st);
	const trackCount = st.trackIds.length;
	for (let t = 0; t < trackCount; t++) {
		if (t % 256 === 0) await work.checkpoint();
		const frames = trackFrames({ rec, track: t });
		const good = frames.filter((frame) => !rec.bad[st.offset[t] + frame - st.start[t]]);
		if (good.length < 2) {
			rec.hasPoint[t] = 0;
			continue;
		}
		if (rotationOnlyDistance !== null) {
			placeOnSphere({ rec, track: t, frames: good, distance: rotationOnlyDistance });
		} else if (!rec.hasPoint[t]) {
			triangulateTrack({ rec, track: t, frames: good, thresholds });
			if (!rec.hasPoint[t]) continue;
		} else {
			const refined = refinePoint({
				point: rec.points.subarray(t * 3, t * 3 + 3),
				rotations: rec.rotations,
				centers: rec.centers,
				focals: rec.focals,
				cameras: Int32Array.from(good),
				uv: Float64Array.from(good.flatMap((frame) => {
					const s = st.offset[t] + frame - st.start[t];
					return [st.uv[2 * s], st.uv[2 * s + 1]];
				})),
				iterations: 6,
			});
			rec.points.set(refined.point, t * 3);
		}
		// reject what does not fit, on every frame the track is alive on (bad ones may come back)
		let kept = 0;
		for (const frame of frames) {
			const s = st.offset[t] + frame - st.start[t];
			const e = reprojectionError({ rec, track: t, frame, sample: s });
			const ok = e < thresholds.outlier;
			rec.bad[s] = ok ? 0 : 1;
			if (ok) kept++;
		}
		rec.hasPoint[t] = kept >= 2 ? 1 : 0;
	}
}

/** Puts a track's point on its mean viewing direction (rotation-only solve: every camera at the same centre). */
export function placeOnSphere({ rec, track, frames, distance }: { rec: Reconstruction; track: number; frames: readonly number[]; distance: number }): void {
	const { st } = rec;
	let x = 0;
	let y = 0;
	let z = 0;
	for (const frame of frames) {
		const s = st.offset[track] + frame - st.start[track];
		const f = rec.focals[frame];
		const u = st.uv[2 * s] / f;
		const v = st.uv[2 * s + 1] / f;
		const length = Math.hypot(u, v, 1);
		const r = rec.rotations.subarray(frame * 9, frame * 9 + 9);
		// R^T d
		x += (r[0] * u + r[3] * v + r[6]) / length;
		y += (r[1] * u + r[4] * v + r[7]) / length;
		z += (r[2] * u + r[5] * v + r[8]) / length;
	}
	const length = Math.hypot(x, y, z);
	if (!(length > 0)) return;
	const c = rec.centers.subarray(frames[0] * 3, frames[0] * 3 + 3);
	rec.points.set([c[0] + (distance * x) / length, c[1] + (distance * y) / length, c[2] + (distance * z) / length], track * 3);
	rec.hasPoint[track] = 1;
}

/** Registers every registered frame again from its own pose against the current points (no RANSAC). */
export async function reregisterAll({
	rec,
	focalMode,
	fixPosition,
	work,
	random,
}: {
	rec: Reconstruction;
	focalMode: FocalMode;
	fixPosition: boolean;
	work: Work;
	random: () => number;
}): Promise<void> {
	const thresholds = thresholdsFor(rec.st);
	for (let f = 0; f < rec.st.frameCount; f++) {
		if (!rec.registered[f]) continue;
		if (f % 8 === 0) await work.checkpoint();
		registerFrame({
			rec,
			frame: f,
			prediction: f,
			focalMode: focalMode === "per-camera" ? "per-camera" : "fixed",
			thresholds,
			random,
			ransacRounds: 0,
			minInliers: 8,
			fixPosition,
			focalPriorWeight: 20,
		});
	}
}

/**
 * Smooths the focal lengths of a zoom over time: a local linear fit of ln f
 * with Gaussian weights (sigma `radius / 2` frames) at every registered
 * frame. The tracker's noise makes the per-frame focal jitter; a real zoom
 * is smooth.
 */
export function smoothFocals({ rec, radius }: { rec: Reconstruction; radius: number }): void {
	const n = rec.st.frameCount;
	const logs = Float64Array.from(rec.focals, (f) => Math.log(f));
	const out = Float64Array.from(logs);
	const sigma = radius / 2;
	for (let f = 0; f < n; f++) {
		if (!rec.registered[f]) continue;
		let sw = 0;
		let st = 0;
		let stt = 0;
		let sy = 0;
		let sty = 0;
		for (let g = Math.max(0, f - radius); g <= Math.min(n - 1, f + radius); g++) {
			if (!rec.registered[g]) continue;
			const d = g - f;
			const w = Math.exp((-0.5 * d * d) / (sigma * sigma));
			sw += w;
			st += w * d;
			stt += w * d * d;
			sy += w * logs[g];
			sty += w * d * logs[g];
		}
		const det = sw * stt - st * st;
		out[f] = Math.abs(det) > 1e-12 ? (stt * sy - st * sty) / det : sy / sw;
	}
	for (let f = 0; f < n; f++) if (rec.registered[f]) rec.focals[f] = Math.exp(out[f]);
}
