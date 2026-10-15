import { quatFromAxisAngle, quatMul, vNormalize } from "@/scene3d/math";
import { projectToFrame } from "@/scene3d/camera";
import type { CameraState, Vec3 } from "@/scene3d/types";
import type { FeatureTracks } from "@/tracking/camera/types";
import { packSolve, packTracks } from "@/tracking/camera3d/codec";
import {
	DEFAULT_CAMERA_TRACKER_SETTINGS,
	type CameraSolve,
	type CameraTrackerData,
} from "@/tracking/camera3d/types";

export const FRAME = { width: 1920, height: 1080 } as const;
export const ANALYSIS = { width: 480, height: 270 } as const;

/**
 * Feature tracks from explicit samples (analysis index pixels), with the
 * offsets and live lists built the way the tracker builds them.
 */
export function buildTracks({
	frameCount,
	fps = 30,
	tracks,
	w = ANALYSIS.width,
	h = ANALYSIS.height,
}: {
	frameCount: number;
	fps?: number;
	tracks: Array<{ start: number; samples: Array<[number, number]> }>;
	w?: number;
	h?: number;
}): FeatureTracks {
	const trackStart = Int32Array.from(tracks.map((track) => track.start));
	const trackLen = Int32Array.from(tracks.map((track) => track.samples.length));
	const trackOffset = new Int32Array(tracks.length);
	const xyValues: number[] = [];
	tracks.forEach((track, i) => {
		trackOffset[i] = xyValues.length;
		for (const [x, y] of track.samples) xyValues.push(x, y);
	});
	const live: number[][] = Array.from({ length: frameCount }, () => []);
	tracks.forEach((track, i) => {
		for (let f = track.start; f < track.start + track.samples.length; f++) live[f].push(i);
	});
	const liveOffsets = new Int32Array(frameCount + 1);
	for (let f = 0; f < frameCount; f++) liveOffsets[f + 1] = liveOffsets[f] + live[f].length;
	return {
		w,
		h,
		frameCount,
		fps,
		trackStart,
		trackLen,
		trackOffset,
		xy: Float32Array.from(xyValues),
		liveOffsets,
		liveIds: Int32Array.from(live.flat()),
		cuts: [],
		stats: { lostFraction: new Float32Array(frameCount), cutNcc: [] },
	};
}

/** A camera at `position` turned by `yawDeg` about y then `rollDeg` about z (world -> camera). */
export function cameraAt({
	position,
	yawDeg = 0,
	pitchDeg = 0,
	rollDeg = 0,
	focalPx = 1500,
}: {
	position: Vec3;
	yawDeg?: number;
	pitchDeg?: number;
	rollDeg?: number;
	focalPx?: number;
}): CameraState {
	const yaw = quatFromAxisAngle({ axis: [0, 1, 0], radians: (yawDeg * Math.PI) / 180 });
	const pitch = quatFromAxisAngle({ axis: [1, 0, 0], radians: (pitchDeg * Math.PI) / 180 });
	const roll = quatFromAxisAngle({ axis: [0, 0, 1], radians: (rollDeg * Math.PI) / 180 });
	return { rotation: quatMul({ a: roll, b: quatMul({ a: pitch, b: yaw }) }), position, focalPx };
}

/** A small walking camera path looking at points on a floor and a wall. */
export function sceneSolve({ frameCount = 6 }: { frameCount?: number } = {}): {
	solve: CameraSolve;
	tracks: FeatureTracks;
} {
	const cameras: CameraState[] = Array.from({ length: frameCount }, (_, i) =>
		cameraAt({
			position: [-200 + i * 40, -300, -1500 + i * 30],
			yawDeg: 4 - i,
			pitchDeg: -12,
			rollDeg: 2,
		}),
	);
	// a floor (y = 0) and a wall (z = 800), world units
	const world: Vec3[] = [
		[-300, 0, 200],
		[0, 0, 300],
		[300, 0, 150],
		[100, 0, 600],
		[-200, -200, 800],
		[150, -400, 800],
		[400, -100, 800],
		[-50, 0, -100],
	];
	const tracks = buildTracks({
		frameCount,
		tracks: world.map((point) => ({
			start: 0,
			samples: cameras.map((camera) => {
				const p = projectToFrame({ camera, frameWidth: FRAME.width, frameHeight: FRAME.height, point }) ?? {
					x: 0,
					y: 0,
				};
				return [(p.x * ANALYSIS.width) / FRAME.width - 0.5, (p.y * ANALYSIS.height) / FRAME.height - 0.5];
			}),
		})),
	});
	return {
		tracks,
		solve: {
			frameWidth: FRAME.width,
			frameHeight: FRAME.height,
			cameras,
			solved: new Uint8Array(frameCount).fill(1),
			points: world.map((position, trackId) => ({ trackId, position, error: 0.25 })),
			methodUsed: "typical",
			averageError: 0.31,
			notices: [{ kind: "unsolved-frames", count: 0 }],
		},
	};
}

export function trackerData({
	frameCount = 6,
	overrides = {},
}: {
	frameCount?: number;
	overrides?: Partial<CameraTrackerData>;
} = {}): CameraTrackerData {
	const { solve, tracks } = sceneSolve({ frameCount });
	return {
		version: 1,
		settings: { ...DEFAULT_CAMERA_TRACKER_SETTINGS },
		mediaId: "media-clip",
		sourceStart: 0,
		frameWidth: FRAME.width,
		frameHeight: FRAME.height,
		tracks: packTracks(tracks),
		deletedTrackIds: [],
		solve: packSolve(solve),
		failure: null,
		stale: "none",
		groundPlaneSet: false,
		...overrides,
	};
}

export function unit(v: Vec3): Vec3 {
	const n = vNormalize(v);
	if (!n) throw new Error("zero vector");
	return n;
}
