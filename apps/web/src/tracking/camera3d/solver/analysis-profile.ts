/**
 * Analysis profile recommended for the 3D camera solver: the analysis frame
 * width and the `FeatureTracker` options the engine should run.
 *
 * STATUS: provisional best guess, measured only partly on the synthetic 3D
 * bench (`synth3d.ts`, 120-frame scenes, bun/JavaScriptCore):
 *  - `cell: 16` at 480 px gives ~300-430 live features per frame (default
 *    `cell: 36` gives ~100), needed so the acceptance metric finds 3+ solved
 *    points within 80 frame px; tracking cost ~11-13 ms per frame.
 *  - `fbTol: 0.25` (default 0.6) cuts the drift tail of the tracks against
 *    ground truth: 90th percentile error 3.27 -> 1.11 analysis px on
 *    pan-parallax, 2.0 -> 1.17 on shake; `eps`/`half` changes did not help.
 * The Detailed Analysis values (960 px, `cell: 16`) are NOT measured yet.
 */
import type { TrackerOptions } from "@/tracking/camera/tracker";

export interface AnalysisProfile {
	analysisWidth: number;
	trackerOptions: Partial<TrackerOptions>;
}

export const NORMAL_ANALYSIS_PROFILE: AnalysisProfile = {
	analysisWidth: 480,
	trackerOptions: { cell: 16, fbTol: 0.25 },
};

/** Not measured: a guess (twice the width, same density in analysis pixels). */
export const DETAILED_ANALYSIS_PROFILE: AnalysisProfile = {
	analysisWidth: 960,
	trackerOptions: { cell: 16, fbTol: 0.25 },
};

export function analysisProfile({ detailed }: { detailed: boolean }): AnalysisProfile {
	return detailed ? DETAILED_ANALYSIS_PROFILE : NORMAL_ANALYSIS_PROFILE;
}
