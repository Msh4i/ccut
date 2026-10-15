/**
 * The 3D camera solver ("Solving camera", step 2 of AE's 3D Camera
 * Tracker): 2D feature tracks in, one pinhole camera per analysis frame and
 * a cloud of 3D points out. Pure TypeScript on the main thread, in slices
 * (`work.ts`). The steps:
 *
 *  1. the longest scene between cuts; tracks converted to frame pixels
 *     (`tracks.ts`); failures for too little texture or motion;
 *  2. keyframes, keyframe pairs fitted with F and H, GRIC model selection
 *     for Auto Detect (`model-select.ts`); the initial focal length from
 *     the pairs' fundamental matrices (Mendonca-Cipolla) unless known;
 *  3. incremental reconstruction over the keyframes (`reconstruct.ts`) or
 *     the rotation-only one for a tripod pan (`tripod.ts`), with bundle
 *     adjustment (`bundle.ts`);
 *  4. every frame registered, the structure completed and refined
 *     (`finalize.ts`), a zoom's focal lengths smoothed;
 *  5. the contract's gauge, errors and notices (`output.ts`).
 *
 * Deterministic: the RANSAC draws come from a fixed seed.
 */
import { focalFromAngleOfViewDeg } from "@/scene3d/camera";
import { createRng } from "@/tracking/camera/random";
import {
	CAMERA_SOLVE_MESSAGES,
	type CameraSolveFailure,
	type CameraSolveOutcome,
	type SolveCamera,
	type SolveCameraInput,
	type SolveMethodUsed,
} from "../types";
import { refineStructure, registerRemaining, reregisterAll, smoothFocals } from "./finalize";
import { chooseMethod, fitKeyframePairs, initialFocal } from "./model-select";
import { buildSolve, measureQuality } from "./output";
import {
	createReconstruction,
	reconstructKeyframes,
	thresholdsFor,
	type FocalMode,
	type Reconstruction,
} from "./reconstruct";
import { longestScene, medianLive, motionExtent, prepareTracks, selectKeyframes, type SolverTracks } from "./tracks";
import { reconstructRotationOnly, TRIPOD_POINT_DISTANCE } from "./tripod";
import { createWork, SolveCancelled, type Work } from "./work";

/** A scene needs this many frames to be solved. */
export const MIN_SCENE_FRAMES = 8;
/** Fewer live tracks than this per frame (median) is "no texture". */
export const NO_TEXTURE_LIVE = 12;
/** Tracks that move less than this many ANALYSIS pixels (median of each track's largest excursion) mean "no motion". */
export const NO_MOTION_ANALYSIS_PX = 1;
/** A solve that registers fewer frames of its scene than this share has diverged. */
export const MIN_SOLVED_SHARE = 0.5;
/** A solve whose average error is above this many ANALYSIS pixels has diverged. */
export const MAX_AVERAGE_ERROR_ANALYSIS_PX = 2;
/** Angle of view assumed when nothing better is known (degrees). */
const FALLBACK_ANGLE_DEG = 55;
const SEED = 0x5eed;

function failed(reason: CameraSolveFailure): CameraSolveOutcome {
	return { status: "failed", reason, message: CAMERA_SOLVE_MESSAGES[reason] };
}

function validInput(input: SolveCameraInput): boolean {
	const { tracks, frameWidth, frameHeight } = input;
	return (
		Number.isFinite(frameWidth) &&
		Number.isFinite(frameHeight) &&
		frameWidth > 0 &&
		frameHeight > 0 &&
		Number.isInteger(tracks.frameCount) &&
		tracks.frameCount >= 0 &&
		tracks.w > 0 &&
		tracks.h > 0 &&
		tracks.trackStart.length === tracks.trackLen.length &&
		tracks.trackOffset.length === tracks.trackStart.length
	);
}

/** Keyframe reconstruction for a general (typical / mostly flat) scene, then every frame. */
async function solveGeneral({
	st,
	keyframes,
	focal,
	focalMode,
	method,
	work,
}: {
	st: SolverTracks;
	keyframes: readonly number[];
	focal: number;
	focalMode: FocalMode;
	method: "typical" | "mostly-flat";
	work: Work;
}): Promise<Reconstruction | null> {
	const random = createRng({ seed: SEED + 1 });
	const rec = createReconstruction({ st, focal });
	const built = await reconstructKeyframes({
		rec,
		keyframes,
		focalMode,
		method,
		work,
		random,
		onProgress: (fraction) => work.progress(0.15 + 0.45 * fraction),
	});
	if (!built) return null;
	await finishAllFrames({ rec, focalMode, rotationOnly: false, work, random });
	return rec;
}

/** Rotation-only reconstruction (tripod pan), then every frame. */
async function solveTripod({
	st,
	keyframes,
	focal,
	knownFocal,
	focalMode,
	work,
}: {
	st: SolverTracks;
	keyframes: readonly number[];
	focal: number;
	knownFocal: number | null;
	focalMode: FocalMode;
	work: Work;
}): Promise<Reconstruction | null> {
	const random = createRng({ seed: SEED + 2 });
	const rec = createReconstruction({ st, focal });
	const ok = await reconstructRotationOnly({ rec, keyframes, focalMode, knownFocal, work, random });
	if (!ok) return null;
	work.progress(0.6);
	await finishAllFrames({ rec, focalMode, rotationOnly: true, work, random });
	return rec;
}

async function finishAllFrames({
	rec,
	focalMode,
	rotationOnly,
	work,
	random,
}: {
	rec: Reconstruction;
	focalMode: FocalMode;
	rotationOnly: boolean;
	work: Work;
	random: () => number;
}): Promise<void> {
	const fixPosition = rotationOnly;
	const distance = rotationOnly ? TRIPOD_POINT_DISTANCE : null;
	await registerRemaining({ rec, focalMode, fixPosition, work, random });
	work.progress(0.7);
	for (let pass = 0; pass < 2; pass++) {
		await refineStructure({ rec, work, rotationOnlyDistance: distance });
		await reregisterAll({ rec, focalMode, fixPosition, work, random });
		work.progress(0.8 + 0.05 * pass);
	}
	if (focalMode === "per-camera") {
		smoothFocals({ rec, radius: 8 });
		await reregisterAll({ rec, focalMode: "fixed", fixPosition, work, random });
		await refineStructure({ rec, work, rotationOnlyDistance: distance });
		await reregisterAll({ rec, focalMode: "fixed", fixPosition, work, random });
	}
	work.progress(0.95);
}

/** See the file comment. */
export const solveCamera: SolveCamera = async ({ input, deps, signal, onProgress }) => {
	const work = createWork({ yieldToUi: () => deps.yieldToUi(), now: () => deps.now(), signal, onProgress });
	try {
		work.progress(0);
		await work.checkpoint();
		if (!validInput(input)) return failed("too-short");
		const { tracks, frameWidth, frameHeight, settings } = input;
		if (tracks.frameCount < MIN_SCENE_FRAMES) return failed("too-short");
		const scene = longestScene({ frameCount: tracks.frameCount, cuts: tracks.cuts });
		if (scene.end - scene.first < MIN_SCENE_FRAMES) return failed("too-short");
		const st = prepareTracks({ tracks, frameWidth, frameHeight, scene, excluded: input.excludedTrackIds });
		if (medianLive(st) < NO_TEXTURE_LIVE) return failed("no-texture");
		if (motionExtent(st) < NO_MOTION_ANALYSIS_PX) return failed("no-motion");
		const keyframes = selectKeyframes({ st });
		if (keyframes.length < 2) return failed("too-short");
		await work.checkpoint();

		const zoom = settings.shotType === "variable-zoom";
		const knownFocal =
			settings.shotType === "specify-angle"
				? focalFromAngleOfViewDeg({ degrees: Math.max(1, Math.min(179, settings.horizontalAngleOfViewDeg)), frameWidth })
				: null;
		const focalMode: FocalMode = knownFocal !== null ? "fixed" : zoom ? "per-camera" : "shared";
		const thresholds = thresholdsFor(st);
		const fits = await fitKeyframePairs({ st, keyframes, random: createRng({ seed: SEED }), work, threshold: thresholds.ransac });
		work.progress(0.1);
		let method: SolveMethodUsed;
		if (settings.solveMethod === "auto") {
			const choice = chooseMethod({ fits, focal: knownFocal, zoom, frameWidth, minSigma: 0.05 * st.pixelScale });
			method = choice ? choice.method : "typical";
		} else {
			method = settings.solveMethod;
		}
		const focal =
			knownFocal ??
			initialFocal({ fits, frameWidth }) ??
			focalFromAngleOfViewDeg({ degrees: FALLBACK_ANGLE_DEG, frameWidth });
		work.progress(0.15);

		const rec =
			method === "tripod-pan"
				? await solveTripod({ st, keyframes, focal, knownFocal, focalMode, work })
				: await solveGeneral({ st, keyframes, focal, focalMode, method, work });
		if (!rec) return failed("diverged");
		const quality = measureQuality(rec);
		if (quality.solvedFrames < MIN_SOLVED_SHARE * st.frameCount) return failed("diverged");
		if (!(quality.averageError <= MAX_AVERAGE_ERROR_ANALYSIS_PX * st.pixelScale)) return failed("diverged");
		const solve = buildSolve({ rec, clipFrames: tracks.frameCount, method, rotationOnly: method === "tripod-pan" });
		if (!solve) return failed("diverged");
		work.progress(1);
		return { status: "solved", solve };
	} catch (error) {
		if (error instanceof SolveCancelled) return { status: "cancelled" };
		throw error;
	}
};
