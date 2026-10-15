/**
 * Turns a finished reconstruction into the contract's `CameraSolve`: the
 * world gauge of the `CameraSolve` doc comment (origin at the centroid of
 * the reliable points, axes of the first solved camera, scale such that the
 * median depth of the points seen from that camera equals its focal
 * length), one camera per analysis frame of the clip (unsolved frames and
 * frames outside the solved scene hold the nearest solved camera), the
 * points with their mean reprojection error, the average error and the
 * notices.
 */
import { mat3ToQuat } from "@/scene3d/math";
import type { CameraState, Mat3, Vec3 } from "@/scene3d/types";
import type { CameraSolve, CameraSolveNotice, SolveMethodUsed, TrackPoint3D } from "../types";
import { median } from "./linalg";
import { reprojectionError, type Reconstruction } from "./reconstruct";

/** Average error above this many ANALYSIS pixels gets the `high-error` notice. */
export const HIGH_ERROR_ANALYSIS_PX = 0.5;

/** A point is "reliable" for the gauge with this many good observations ... */
const RELIABLE_OBSERVATIONS = 5;

export interface SolveQuality {
	/** Mean reprojection error over the good observations, frame pixels. */
	averageError: number;
	/** Per track with a point: mean error and good observation count. */
	pointError: Float64Array;
	pointObservations: Int32Array;
	/** Frames of the scene that are solved. */
	solvedFrames: number;
}

/** Reprojection statistics of the solved frames and points. */
export function measureQuality(rec: Reconstruction): SolveQuality {
	const { st } = rec;
	const trackCount = st.trackIds.length;
	const pointError = new Float64Array(trackCount);
	const pointObservations = new Int32Array(trackCount);
	let sum = 0;
	let count = 0;
	let solvedFrames = 0;
	for (let f = 0; f < st.frameCount; f++) {
		if (!rec.registered[f]) continue;
		solvedFrames++;
		for (let q = st.liveOffsets[f]; q < st.liveOffsets[f + 1]; q++) {
			const t = st.live[q];
			if (!rec.hasPoint[t]) continue;
			const s = st.offset[t] + f - st.start[t];
			if (rec.bad[s]) continue;
			const e = reprojectionError({ rec, track: t, frame: f, sample: s });
			if (!Number.isFinite(e)) continue;
			pointError[t] += e;
			pointObservations[t]++;
			sum += e;
			count++;
		}
	}
	for (let t = 0; t < trackCount; t++) if (pointObservations[t] > 0) pointError[t] /= pointObservations[t];
	return { averageError: count > 0 ? sum / count : Number.NaN, pointError, pointObservations, solvedFrames };
}

/** The similarity `X' = s R0 (X - origin)` of the contract's gauge. */
export interface Gauge {
	scale: number;
	rotation: Float64Array;
	origin: Float64Array;
}

export function computeGauge({ rec, quality }: { rec: Reconstruction; quality: SolveQuality }): Gauge | null {
	const { st } = rec;
	let first = -1;
	for (let f = 0; f < st.frameCount; f++) {
		if (rec.registered[f]) {
			first = f;
			break;
		}
	}
	if (first < 0) return null;
	const withPoint: number[] = [];
	for (let t = 0; t < st.trackIds.length; t++) if (rec.hasPoint[t] && quality.pointObservations[t] > 0) withPoint.push(t);
	if (withPoint.length === 0) return null;
	const typical = median({ values: withPoint.map((t) => quality.pointError[t]) });
	let reliable = withPoint.filter((t) => quality.pointObservations[t] >= RELIABLE_OBSERVATIONS && quality.pointError[t] <= 2 * typical);
	if (reliable.length < 3) reliable = withPoint;
	const origin = new Float64Array(3);
	for (const t of reliable) for (let k = 0; k < 3; k++) origin[k] += rec.points[t * 3 + k] / reliable.length;
	const r0 = rec.rotations.slice(first * 9, first * 9 + 9);
	const c0 = rec.centers.subarray(first * 3, first * 3 + 3);
	const depthOf = (t: number): number =>
		r0[6] * (rec.points[t * 3] - c0[0]) + r0[7] * (rec.points[t * 3 + 1] - c0[1]) + r0[8] * (rec.points[t * 3 + 2] - c0[2]);
	let depths: number[] = [];
	for (let q = st.liveOffsets[first]; q < st.liveOffsets[first + 1]; q++) {
		const t = st.live[q];
		if (!rec.hasPoint[t] || rec.bad[st.offset[t] + first - st.start[t]]) continue;
		const z = depthOf(t);
		if (z > 0) depths.push(z);
	}
	if (depths.length === 0) depths = withPoint.map(depthOf).filter((z) => z > 0);
	if (depths.length === 0) return null;
	const scale = rec.focals[first] / median({ values: depths });
	if (!(scale > 0) || !Number.isFinite(scale)) return null;
	return { scale, rotation: r0, origin };
}

function applyToPoint({ gauge, point }: { gauge: Gauge; point: ArrayLike<number> }): Vec3 {
	const d0 = point[0] - gauge.origin[0];
	const d1 = point[1] - gauge.origin[1];
	const d2 = point[2] - gauge.origin[2];
	const r = gauge.rotation;
	const s = gauge.scale;
	return [s * (r[0] * d0 + r[1] * d1 + r[2] * d2), s * (r[3] * d0 + r[4] * d1 + r[5] * d2), s * (r[6] * d0 + r[7] * d1 + r[8] * d2)];
}

/** Camera of reconstruction frame `frame` in the gauge's world. */
function gaugedCamera({ rec, gauge, frame }: { rec: Reconstruction; gauge: Gauge; frame: number }): CameraState {
	const r = rec.rotations.subarray(frame * 9, frame * 9 + 9);
	const g = gauge.rotation;
	// R' = R R0^T
	const m: number[] = [];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) m.push(r[i * 3] * g[j * 3] + r[i * 3 + 1] * g[j * 3 + 1] + r[i * 3 + 2] * g[j * 3 + 2]);
	}
	const rotation: Mat3 = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
	return {
		rotation: mat3ToQuat(rotation),
		position: applyToPoint({ gauge, point: rec.centers.subarray(frame * 3, frame * 3 + 3) }),
		focalPx: rec.focals[frame],
	};
}

/**
 * The `CameraSolve` of a reconstruction of scene `scene` within a clip of
 * `clipFrames` analysis frames. `null` when nothing was solved.
 */
export function buildSolve({
	rec,
	clipFrames,
	method,
	rotationOnly,
}: {
	rec: Reconstruction;
	clipFrames: number;
	method: SolveMethodUsed;
	rotationOnly: boolean;
}): CameraSolve | null {
	const { st } = rec;
	const quality = measureQuality(rec);
	const gauge = computeGauge({ rec, quality });
	if (!gauge) return null;
	const sceneCameras: (CameraState | null)[] = [];
	for (let f = 0; f < st.frameCount; f++) sceneCameras.push(rec.registered[f] ? gaugedCamera({ rec, gauge, frame: f }) : null);
	const cameras: CameraState[] = [];
	const solved = new Uint8Array(clipFrames);
	for (let frame = 0; frame < clipFrames; frame++) {
		const local = Math.max(0, Math.min(st.frameCount - 1, frame - st.firstFrame));
		const inside = frame - st.firstFrame === local;
		// the nearest solved frame of the scene holds where this one is not solved
		let best: CameraState | null = null;
		for (let d = 0; d < st.frameCount && !best; d++) {
			const before = local - d;
			const after = local + d;
			if (before >= 0 && sceneCameras[before]) best = sceneCameras[before];
			else if (after < st.frameCount && sceneCameras[after]) best = sceneCameras[after];
		}
		if (!best) return null;
		cameras.push(best);
		solved[frame] = inside && sceneCameras[local] ? 1 : 0;
	}
	const points: TrackPoint3D[] = [];
	for (let t = 0; t < st.trackIds.length; t++) {
		if (!rec.hasPoint[t] || quality.pointObservations[t] === 0) continue;
		points.push({
			trackId: st.trackIds[t],
			position: applyToPoint({ gauge, point: rec.points.subarray(t * 3, t * 3 + 3) }),
			error: quality.pointError[t],
		});
	}
	const notices: CameraSolveNotice[] = [];
	if (rotationOnly) notices.push({ kind: "tripod-no-depth" });
	const unsolved = st.frameCount - quality.solvedFrames;
	if (unsolved > 0) notices.push({ kind: "unsolved-frames", count: unsolved });
	if (st.firstFrame > 0) notices.push({ kind: "cut", frame: st.firstFrame });
	if (st.firstFrame + st.frameCount < clipFrames) notices.push({ kind: "cut", frame: st.firstFrame + st.frameCount });
	if (quality.averageError > HIGH_ERROR_ANALYSIS_PX * st.pixelScale) {
		notices.push({ kind: "high-error", averageError: quality.averageError });
	}
	return {
		frameWidth: st.frameWidth,
		frameHeight: st.frameHeight,
		cameras,
		solved,
		points,
		methodUsed: method,
		averageError: quality.averageError,
		notices,
	};
}
