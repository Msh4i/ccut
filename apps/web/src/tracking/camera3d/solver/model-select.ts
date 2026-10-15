/**
 * What kind of shot is this? Keyframe pairs that span the scene are fitted
 * with three models, and Torr's GRIC (`two-view.ts`) picks the one that
 * explains them best for its complexity, summed over the pairs:
 *  - rotation only (`x_b ~ K_b R K_a^-1 x_a`): the camera turns about its
 *    centre, a tripod pan; no depth can be recovered;
 *  - homography: a (mostly) planar scene seen with translation;
 *  - fundamental matrix: a general scene with parallax ("typical").
 * The same pairs' fundamental matrices give the initial focal length
 * (`searchFocal`).
 */
import type { SolveMethodUsed } from "../types";
import { median } from "./linalg";
import { pairData, sharedCount, type PairData, type SolverTracks } from "./tracks";
import {
	fitRotationOnly,
	fundamentalResiduals,
	gric,
	homographyResiduals,
	ransacFundamental,
	ransacHomography,
	searchFocal,
	type RobustFit,
} from "./two-view";
import type { Work } from "./work";

export interface PairFits {
	pair: PairData;
	fundamental: RobustFit;
	homography: RobustFit;
}

/** At most this many pairs are fitted. */
const MAX_PAIRS = 12;

/**
 * Keyframe pairs spread over the scene, each as wide as the shared tracks
 * allow (at least `max(24, 40 %)` of the first keyframe's tracks still
 * alive on the second), with their robust F and H fits.
 */
export async function fitKeyframePairs({
	st,
	keyframes,
	random,
	work,
	threshold,
}: {
	st: SolverTracks;
	keyframes: readonly number[];
	random: () => number;
	work: Work;
	/** RANSAC inlier distance, frame pixels. */
	threshold: number;
}): Promise<PairFits[]> {
	const out: PairFits[] = [];
	const stride = Math.max(1, Math.ceil(keyframes.length / MAX_PAIRS));
	const used = new Set<string>();
	for (let i = 0; i < keyframes.length - 1; i += stride) {
		await work.checkpoint();
		const a = keyframes[i];
		const liveA = st.liveOffsets[a + 1] - st.liveOffsets[a];
		let j = i + 1;
		while (j + 1 < keyframes.length && sharedCount({ st, a, b: keyframes[j + 1] }) >= Math.max(24, 0.4 * liveA)) j++;
		const b = keyframes[j];
		const key = `${a}:${b}`;
		if (used.has(key)) continue;
		used.add(key);
		const pair = pairData({ st, a, b });
		if (pair.n < 16) continue;
		const fundamental = ransacFundamental({ pair, threshold, maxRounds: 300, random });
		const homography = ransacHomography({ pair, threshold, maxRounds: 300, random });
		if (!fundamental || !homography) continue;
		out.push({ pair, fundamental, homography });
	}
	return out;
}

export interface MethodChoice {
	method: SolveMethodUsed;
	/** Summed GRIC per model (lower is better), for diagnostics. */
	gric: { rotation: number; homography: number; fundamental: number };
	/** Noise sigma the scores used, frame pixels. */
	sigma: number;
}

/**
 * GRIC over the pairs. `focal` known (specify angle) or `null`; `zoom` =
 * the focal length may differ between the views (variable zoom).
 * `minSigma` keeps a near-perfect fit from making every residual look huge.
 */
export function chooseMethod({
	fits,
	focal,
	zoom,
	frameWidth,
	minSigma,
}: {
	fits: readonly PairFits[];
	focal: number | null;
	zoom: boolean;
	frameWidth: number;
	minSigma: number;
}): MethodChoice | null {
	if (fits.length === 0) return null;
	const inlierResiduals: number[] = [];
	for (const fit of fits) {
		const e2 = fundamentalResiduals({ pair: fit.pair, f: fit.fundamental.model });
		for (let i = 0; i < fit.pair.n; i++) if (fit.fundamental.inliers[i]) inlierResiduals.push(Math.sqrt(e2[i]));
	}
	const sigma = Math.max(minSigma, median({ values: inlierResiduals }) / 0.6745);
	const sigma2 = sigma * sigma;
	let rotation = 0;
	let homography = 0;
	let fundamental = 0;
	const rotationParams = 3 + (focal === null ? (zoom ? 2 : 1) : 0);
	for (const fit of fits) {
		fundamental += gric({ e2: fundamentalResiduals({ pair: fit.pair, f: fit.fundamental.model }), sigma2, d: 3, k: 7 });
		homography += gric({ e2: homographyResiduals({ pair: fit.pair, h: fit.homography.model }), sigma2, d: 2, k: 8 });
		const rot = fitRotationOnly({
			pair: fit.pair,
			h: fit.homography.model,
			select: fit.homography.inliers,
			focal,
			zoom,
			frameWidth,
		});
		rotation += rot ? gric({ e2: rot.e2, sigma2, d: 2, k: rotationParams }) : Infinity;
	}
	let method: SolveMethodUsed = "typical";
	if (rotation <= homography && rotation <= fundamental) method = "tripod-pan";
	else if (homography < fundamental) method = "mostly-flat";
	return { method, gric: { rotation, homography, fundamental }, sigma };
}

/** Initial focal length from the pairs' fundamental matrices, or `null` when they say nothing. */
export function initialFocal({ fits, frameWidth }: { fits: readonly PairFits[]; frameWidth: number }): number | null {
	const result = searchFocal({ fundamentals: fits.map((fit) => fit.fundamental.model), frameWidth });
	return result ? result.focal : null;
}
