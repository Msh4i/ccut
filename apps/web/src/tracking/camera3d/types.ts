import type { FeatureTracks } from "@/tracking/camera/types";
import type { CameraState, Vec3 } from "@/scene3d/types";

/**
 * Contract of the AE-style 3D camera tracker ("Track Camera"). Types only.
 * Owners: the solver (`tracking/camera3d/solve*`), the engine/controller
 * (analysis + solve orchestration, project commands) and the UI code
 * against these shapes. Changing this file needs the lead's agreement
 * (see `docs/ccut/ae-camera-architecture.md`).
 *
 * Coordinates: the solver reads 2D tracks in analysis-frame INDEX pixels
 * (`FeatureTracks`, `tracking/camera/types.ts`) and produces everything in
 * FRAME pixels of the source picture (`frameWidth` x `frameHeight`, the
 * video's display size, continuous coordinates, see `scene3d/types.ts`).
 */

/** AE "Shot Type". */
export type ShotType = "fixed-angle" | "variable-zoom" | "specify-angle";

/** AE "Solve Method". */
export type SolveMethod = "auto" | "typical" | "mostly-flat" | "tripod-pan";

/** AE "Method Used": what Auto Detect picked (or the forced method). */
export type SolveMethodUsed = Exclude<SolveMethod, "auto">;

/** AE "Show Track Points". */
export type TrackPointDisplay = "2d-source" | "3d-solved";

/** The effect controls of AE's 3D Camera Tracker, stored with the tracked clip. */
export interface CameraTrackerSettings {
	shotType: ShotType;
	/** Used when `shotType` is `specify-angle`. Degrees, 1..179. */
	horizontalAngleOfViewDeg: number;
	solveMethod: SolveMethod;
	/** Denser features and a larger analysis frame (re-analysis needed). */
	detailedAnalysis: boolean;
	/** Deleting a point deletes the whole feature track (all frames). */
	autoDeleteAcrossTime: boolean;
	hideWarningBanner: boolean;
	showTrackPoints: TrackPointDisplay;
	/** Draw the track points into preview AND export (same render path). */
	renderTrackPoints: boolean;
	/** Percent, 100 = default marker size. */
	trackPointSize: number;
	/** Percent, 100 = default target radius. */
	targetSize: number;
}

export const DEFAULT_CAMERA_TRACKER_SETTINGS: CameraTrackerSettings = {
	shotType: "fixed-angle",
	horizontalAngleOfViewDeg: 60,
	solveMethod: "auto",
	detailedAnalysis: false,
	autoDeleteAcrossTime: true,
	hideWarningBanner: false,
	showTrackPoints: "3d-solved",
	renderTrackPoints: false,
	trackPointSize: 100,
	targetSize: 100,
};

/** Settings that only need a re-solve when they change (not a re-analysis). */
export const SOLVE_SETTING_KEYS = [
	"shotType",
	"horizontalAngleOfViewDeg",
	"solveMethod",
] as const;

/** Settings that need a re-analysis when they change. */
export const ANALYSIS_SETTING_KEYS = ["detailedAnalysis"] as const;

/** One solved 3D track point. `trackId` indexes `FeatureTracks` (trackStart/trackLen/...). */
export interface TrackPoint3D {
	trackId: number;
	/** World units. */
	position: Vec3;
	/** Mean reprojection error over the frames it was tracked, frame pixels. */
	error: number;
}

export type CameraSolveNotice =
	/** Tripod pan: the camera only rotates, so the points have no real depth (AE: "no depth from a tripod pan solve"). */
	| { kind: "tripod-no-depth" }
	/** Some frames could not be solved and hold their neighbours' camera. */
	| { kind: "unsolved-frames"; count: number }
	/** A scene cut: only the longest scene was solved. */
	| { kind: "cut"; frame: number }
	/** Average error above the warning level. */
	| { kind: "high-error"; averageError: number };

/**
 * A solved camera for one analysis: one camera per analysis frame (frame i
 * is at source time `sourceStart + i / fps` of the analysis), the 3D points
 * and the solve's quality.
 *
 * World gauge: until "Set Ground Plane and Origin" the solver picks it:
 * origin at the centroid of the reliable points, axes of the first solved
 * camera, scale such that the median depth of the points seen from the
 * first solved camera equals that camera's focal length (so 1 world unit
 * is about 1 frame pixel there, like AE where a layer at the zoom distance
 * shows at 100 %).
 */
export interface CameraSolve {
	frameWidth: number;
	frameHeight: number;
	/** One per analysis frame. Frames not solved hold the nearest solved camera. */
	cameras: CameraState[];
	/** 1 where the frame was solved, 0 where it holds a neighbour. Same length as `cameras`. */
	solved: Uint8Array;
	points: TrackPoint3D[];
	methodUsed: SolveMethodUsed;
	/** AE "Average Error": mean distance between the 2D track points and their reprojected 3D points, frame pixels. */
	averageError: number;
	notices: CameraSolveNotice[];
}

export type CameraSolveFailure =
	/** Too few trackable features. */
	| "no-texture"
	/** The camera does not move. */
	| "no-motion"
	/** Too few frames or tracks to solve. */
	| "too-short"
	/** The solve did not converge to a usable result. */
	| "diverged";

export const CAMERA_SOLVE_MESSAGES: Record<CameraSolveFailure, string> = {
	"no-texture": "Not enough detail in this clip to track the camera.",
	"no-motion": "The camera does not move: nothing to solve.",
	"too-short": "The clip is too short to track the camera.",
	diverged: "Could not solve the camera for this clip.",
};

export type CameraSolveOutcome =
	| { status: "solved"; solve: CameraSolve }
	| { status: "failed"; reason: CameraSolveFailure; message: string }
	| { status: "cancelled" };

export interface SolveCameraInput {
	tracks: FeatureTracks;
	frameWidth: number;
	frameHeight: number;
	settings: Pick<
		CameraTrackerSettings,
		"shotType" | "horizontalAngleOfViewDeg" | "solveMethod"
	>;
	/** Deleted track points: ignored by the solve. */
	excludedTrackIds?: ReadonlySet<number>;
}

export interface SolveCameraDeps {
	/** Give the UI a turn (the solve runs on the main thread in slices). */
	yieldToUi(): Promise<void>;
	now(): number;
}

/** The solver entry point (`tracking/camera3d/solve-camera.ts`). */
export type SolveCamera = (args: {
	input: SolveCameraInput;
	deps: SolveCameraDeps;
	signal?: AbortSignal;
	/** 0..1 of the solve. */
	onProgress?: (fraction: number) => void;
}) => Promise<CameraSolveOutcome>;

/** Base64 of the little-endian bytes of a typed array (JSON-safe, compact). */
export type PackedArray = string;

/**
 * 2D tracks as stored in the project. Positions are analysis-frame index
 * coordinates times `quantization` (a power of two, 1/64 px at 480 wide),
 * rounded into an Int16Array (x, y per sample). `codec.ts` packs and unpacks.
 */
export interface PackedTracks {
	width: number;
	height: number;
	frameCount: number;
	fps: number;
	/** Steps per analysis pixel. */
	quantization: number;
	trackCount: number;
	/** Int32 per track. */
	trackStart: PackedArray;
	/** Int32 per track. */
	trackLen: PackedArray;
	/** Int16 pairs, all samples of track 0, then track 1, ... */
	xy: PackedArray;
	cuts: number[];
}

/**
 * A solve as stored in the project. `cameras`: Float32 x 8 per frame
 * (qw qx qy qz, px py pz, focalPx); `solved`: Uint8 per frame;
 * `pointIds`: Int32 per point; `points`: Float32 x 4 per point (x y z error).
 */
export interface PackedSolve {
	frameWidth: number;
	frameHeight: number;
	frameCount: number;
	cameras: PackedArray;
	solved: PackedArray;
	pointIds: PackedArray;
	points: PackedArray;
	methodUsed: SolveMethodUsed;
	averageError: number;
	notices: CameraSolveNotice[];
}

/** Why the stored result no longer matches the settings or the clip (AE's warning banner). */
export type CameraTrackerStale = "none" | "solve" | "analysis";

/**
 * Everything the camera tracker keeps on a video element
 * (`VideoElement.cameraTracker`, optional, additive: no migration).
 * Analysis frames sample SOURCE time uniformly: frame i is at
 * `sourceStart + i / tracks.fps` seconds of the media.
 */
export interface CameraTrackerData {
	version: 1;
	settings: CameraTrackerSettings;
	/** The media the analysis was made from; a different `mediaId` on the clip makes the data stale. */
	mediaId: string;
	/** Source-media second of analysis frame 0. */
	sourceStart: number;
	/** Source picture size (frame pixels). */
	frameWidth: number;
	frameHeight: number;
	tracks: PackedTracks;
	/** Track ids deleted by the user (all frames). */
	deletedTrackIds: number[];
	solve: PackedSolve | null;
	failure: { reason: CameraSolveFailure; message: string } | null;
	stale: CameraTrackerStale;
	/**
	 * Set Ground Plane and Origin has been applied (the solve's world was
	 * re-based). Informational: the re-basing is baked into `solve`.
	 */
	groundPlaneSet: boolean;
}

/** UI-facing phases of a Track Camera run (AE's banner). */
export type CameraTrackerPhase =
	| { phase: "idle" }
	| { phase: "analyzing"; elementId: string; progress: number }
	| { phase: "solving"; elementId: string; progress: number };

export const CAMERA_TRACKER_BANNERS = {
	analyzing: "Analyzing in background (Step 1 of 2)",
	solving: "Solving camera (Step 2 of 2)",
	stale: "Settings changed. Solve again.",
} as const;
