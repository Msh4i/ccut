/**
 * Shared shapes of the camera tracker ("Stick to scene"). Everything here is
 * plain data so it can cross a Worker boundary (see `collectTransferables`)
 * and live in the session store.
 *
 * Coordinates are pixels of the analysis frame (480 px wide by default,
 * "px@480"), origin top-left, x right, y down.
 *
 * **Pixel centres.** A feature position is a pixel *index* coordinate: the
 * centre of pixel `i` is at `x = i`, not `i + 0.5`. The picture spans
 * `-0.5 .. w - 0.5`, and its centre is `((w - 1) / 2, (h - 1) / 2)`. To go to
 * the unit square of the picture (what the renderer's uv and
 * `canvasToFramePoint` use) take `u = (x + 0.5) / w`, to come back
 * `x = u * w - 0.5` (`frame-coordinates.ts`). Mixing the two conventions moves
 * a point by half an analysis pixel: 2 px on a 1920 px canvas.
 */

/**
 * What the user may be told about an analysis, with the frame an event is
 * about where there is one (frames of the analysis, `tracks.fps` per second).
 */
export type CameraNotice =
	| { kind: "no-texture" }
	| { kind: "no-motion" }
	/** The pin's scene starts or ends with a cut on this frame (the first frame of the new scene). */
	| { kind: "cut"; frame: number }
	/** Tracking was lost at this frame (and may have been picked up again later). */
	| { kind: "lost"; frame: number }
	| { kind: "low-quality" }
	| { kind: "object" };

export type CameraNoticeKind = CameraNotice["kind"];

/** S: similarity (translate, scale, rotate). H: homography (adds perspective). */
export type PinModel = "S" | "H";

/**
 * scene: follow the dominant camera motion. object: follow what moves with the
 * features nearest the pin (local weights), for a pin sitting on a moving thing.
 */
export type PinMode = "scene" | "object";

/** Wall-clock cost of the analysis stages, summed over all frames. Diagnostics: not part of the tracks. */
export interface TrackerTiming {
	pyramidMs: number;
	trackMs: number;
	detectMs: number;
}

export interface TrackerStats {
	/** Per frame: share of the live features that died on that frame. */
	lostFraction: Float32Array;
	/** Every frame where most features died at once, and its thumbnail NCC. */
	cutNcc: { frame: number; ncc: number }[];
}

/**
 * Sparse feature tracks of one clip. Track `i` was first seen on frame
 * `trackStart[i]` and has `trackLen[i]` samples, one per frame. Its sample `j`
 * is `(xy[trackOffset[i] + 2 * j], xy[trackOffset[i] + 2 * j + 1])`. The tracks
 * alive on frame `f` are `liveIds[liveOffsets[f] .. liveOffsets[f + 1])`: those
 * with a sample on `f`, in ascending id order.
 *
 * The same frames always give the same tracks: nothing here depends on the
 * clock or the machine.
 */
export interface FeatureTracks {
	w: number;
	h: number;
	frameCount: number;
	/** Frames per second of the analysis (the clip's rate or less). */
	fps: number;
	trackStart: Int32Array;
	trackLen: Int32Array;
	/** Index into `xy` (in floats, not samples) of each track's first x. */
	trackOffset: Int32Array;
	xy: Float32Array;
	/** `frameCount + 1` entries. */
	liveOffsets: Int32Array;
	liveIds: Int32Array;
	/** Frames that start a new scene, ascending. No track crosses one. */
	cuts: number[];
	stats: TrackerStats;
}

/**
 * What the session store keeps per analysed clip window. Frame count and rate
 * are those of `tracks`.
 */
export interface CameraAnalysis {
	id: string;
	/** The clip it was taken from, wherever that clip lives now. */
	hostElementId: string;
	mediaId: string;
	/** Source-media second of frame 0: trim start plus the window's offset times the rate. */
	sourceStart: number;
	/** The clip's retime rate when it was analysed. */
	rate0: number;
	tracks: FeatureTracks;
	status: "complete" | "cancelled";
}

/**
 * How a frame of a {@link PinSolution} came about:
 *  - 0: held. Nothing could be solved here; the map is the last solved one (or
 *    the identity), and so are the frames beyond the pin's scene or range.
 *  - 1: solved, by a chain of fits that runs unbroken back to the pin frame.
 *  - 2: solved, after a bridged gap: the chain from the pin frame crosses
 *    frames that could not be solved, where the camera is assumed not to have
 *    moved. The map is as good as the tracks, off by what the camera really did
 *    in the gap.
 */
export type PinFrameState = 0 | 1 | 2;

/**
 * The scene motion from the pin frame `f0` to every frame `t`, as a map of
 * analysis-frame points. `maps` holds `stride` numbers per frame:
 *  - model "S": `[ar, ai, br, bi]`, the map `z' = a z + b` with `z = x + i y`.
 *  - model "H": the 3x3 homography row-major with `h33 = 1` exactly.
 *
 * `homographyAt` returns a view into `maps`: transferring `maps.buffer` to a
 * Worker detaches every such view.
 */
export interface PinSolution {
	model: PinModel;
	mode: PinMode;
	f0: number;
	frameCount: number;
	/** The frames the solver was allowed to solve: the pin's scene (between cuts) within the range asked for. */
	range: { lo: number; hi: number };
	stride: 4 | 9;
	maps: Float64Array;
	/** See {@link PinFrameState}. */
	ok: Uint8Array;
	/** Inliers of the pair fit that produced frame `t` (0 on `f0` and held frames). */
	nin: Int32Array;
	/** Residual rms in px@480 of that fit's inliers (0 on `f0` and held frames). */
	rms: Float64Array;
	/** How many times the solver re-anchored on an earlier frame. */
	hops: number;
}
