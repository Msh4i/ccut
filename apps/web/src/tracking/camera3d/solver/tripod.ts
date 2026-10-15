/**
 * Rotation-only ("tripod pan") solve: every camera shares one centre and
 * only turns, so points have a direction but no depth (AE: "no depth from
 * a tripod pan solve"). Keyframe rotations are chained from the
 * rotation-only fits of consecutive keyframes (`fitRotationOnly`), points
 * are placed on a sphere around the centre on their mean viewing direction,
 * and a bundle adjustment with the centres held refines rotations, focal
 * lengths and directions.
 */
import { placeOnSphere } from "./finalize";
import { mat3Mul, median } from "./linalg";
import { adjust, rejectOutliers, thresholdsFor, type FocalMode, type Reconstruction } from "./reconstruct";
import { pairData } from "./tracks";
import { fitRotationOnly, ransacHomography } from "./two-view";
import type { Work } from "./work";

/** Radius of the point sphere during the solve (the world gauge rescales it at the end). */
export const TRIPOD_POINT_DISTANCE = 1;

/** Tracks seen on a registered frame of `frames` at least twice (good samples). */
function placeTracks({ rec, frames }: { rec: Reconstruction; frames: readonly number[] }): void {
	const { st } = rec;
	for (let t = 0; t < st.trackIds.length; t++) {
		const seen: number[] = [];
		for (const frame of frames) {
			if (!rec.registered[frame]) continue;
			const j = frame - st.start[t];
			if (j < 0 || j >= st.length[t] || rec.bad[st.offset[t] + j]) continue;
			seen.push(frame);
		}
		if (seen.length >= 2) placeOnSphere({ rec, track: t, frames: seen, distance: TRIPOD_POINT_DISTANCE });
		else rec.hasPoint[t] = 0;
	}
}

/**
 * Builds the keyframe rotations and the point directions. `knownFocal`
 * (specify angle) or `null`; `focalMode` `per-camera` lets the focal
 * length change between keyframes. `false` when a keyframe pair cannot be
 * fitted.
 */
export async function reconstructRotationOnly({
	rec,
	keyframes,
	focalMode,
	knownFocal,
	work,
	random,
}: {
	rec: Reconstruction;
	keyframes: readonly number[];
	focalMode: FocalMode;
	knownFocal: number | null;
	work: Work;
	random: () => number;
}): Promise<boolean> {
	const { st } = rec;
	const thresholds = thresholdsFor(st);
	const zoom = focalMode === "per-camera";
	const relative: { r: Float64Array; ratio: number; focal: number }[] = [];
	for (let k = 0; k + 1 < keyframes.length; k++) {
		await work.checkpoint();
		const pair = pairData({ st, a: keyframes[k], b: keyframes[k + 1] });
		const h = ransacHomography({ pair, threshold: thresholds.ransac, maxRounds: 200, random });
		if (!h || h.count < 12) return false;
		const fit = fitRotationOnly({
			pair,
			h: h.model,
			select: h.inliers,
			focal: knownFocal,
			zoom,
			frameWidth: st.frameWidth,
		});
		if (!fit) return false;
		relative.push({ r: fit.r, ratio: fit.focalB / fit.focalA, focal: fit.focalA });
	}
	const baseFocal = knownFocal ?? median({ values: relative.map((item) => item.focal) });
	if (!(baseFocal > 0)) return false;
	const first = keyframes[0];
	rec.rotations.set([1, 0, 0, 0, 1, 0, 0, 0, 1], first * 9);
	rec.centers.set([0, 0, 0], first * 3);
	rec.focals.fill(baseFocal);
	rec.registered[first] = 1;
	for (let k = 0; k < relative.length; k++) {
		const a = keyframes[k];
		const b = keyframes[k + 1];
		rec.rotations.set(mat3Mul({ a: relative[k].r, b: rec.rotations.subarray(a * 9, a * 9 + 9) }), b * 9);
		rec.centers.set([0, 0, 0], b * 3);
		rec.focals[b] = zoom ? rec.focals[a] * relative[k].ratio : baseFocal;
		rec.registered[b] = 1;
	}
	if (zoom) {
		// frames between keyframes start from their neighbour's focal length
		let last = first;
		for (let f = 0; f < st.frameCount; f++) {
			if (rec.registered[f]) last = f;
			else rec.focals[f] = rec.focals[last];
		}
	}
	placeTracks({ rec, frames: keyframes });
	for (let pass = 0; pass < 2; pass++) {
		await adjust({
			rec,
			frames: keyframes,
			fixedFrames: new Set([first]),
			focalMode: knownFocal !== null ? "fixed" : focalMode,
			thresholds,
			iterations: 20,
			work,
			fixPositions: true,
			scaleAnchor: false,
			pointDamping: 1e-6,
		});
		rejectOutliers({ rec, frames: keyframes, thresholds });
		placeTracks({ rec, frames: keyframes });
	}
	return true;
}
