import type { FeatureTracks } from "@/tracking/camera/types";
import type { CameraState, Vec3 } from "@/scene3d/types";
import type {
	CameraTrackerApi,
	CreateTrackedLayersArgs,
	DecodedCameraTracker,
} from "../../session";
import {
	DEFAULT_CAMERA_TRACKER_SETTINGS,
	type CameraSolve,
	type CameraTrackerData,
	type CameraTrackerSettings,
} from "../../types";

/** Tracks from a plain list: each with its first frame and its (x, y) analysis-index samples. */
export function buildTracks({
	w = 480,
	h = 270,
	frameCount,
	fps = 30,
	tracks,
}: {
	w?: number;
	h?: number;
	frameCount: number;
	fps?: number;
	tracks: ReadonlyArray<{ start: number; samples: ReadonlyArray<readonly [number, number]> }>;
}): FeatureTracks {
	const trackStart = Int32Array.from(tracks.map((track) => track.start));
	const trackLen = Int32Array.from(tracks.map((track) => track.samples.length));
	const trackOffset = new Int32Array(tracks.length);
	const values: number[] = [];
	tracks.forEach((track, index) => {
		trackOffset[index] = values.length;
		for (const [x, y] of track.samples) values.push(x, y);
	});
	const live: number[][] = Array.from({ length: frameCount }, () => []);
	tracks.forEach((track, index) => {
		for (let f = track.start; f < track.start + track.samples.length; f++) live[f].push(index);
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
		xy: Float32Array.from(values),
		liveOffsets,
		liveIds: Int32Array.from(live.flat()),
		cuts: [],
		stats: { lostFraction: new Float32Array(frameCount), cutNcc: [] },
	};
}

/** A camera at `position` looking along +z (no rotation), focal 1000 frame px. */
export function straightCamera(position: Vec3): CameraState {
	return { rotation: [1, 0, 0, 0], position, focalPx: 1000 };
}

export function buildSolve({
	cameras,
	points,
	frameWidth = 1920,
	frameHeight = 1080,
}: {
	cameras: CameraState[];
	points: ReadonlyArray<{ trackId: number; position: Vec3 }>;
	frameWidth?: number;
	frameHeight?: number;
}): CameraSolve {
	return {
		frameWidth,
		frameHeight,
		cameras,
		solved: new Uint8Array(cameras.length).fill(1),
		points: points.map((point) => ({ ...point, error: 0.2 })),
		methodUsed: "typical",
		averageError: 0.384,
		notices: [],
	};
}

/** Stored data with the given parts (packed arrays are placeholders: the UI only reads decoded data). */
export function buildData({
	settings = {},
	stale = "none",
	failure = null,
	hasSolve = true,
	sourceStart = 0,
	fps = 30,
	frameCount = 10,
}: {
	settings?: Partial<CameraTrackerSettings>;
	stale?: CameraTrackerData["stale"];
	failure?: CameraTrackerData["failure"];
	hasSolve?: boolean;
	sourceStart?: number;
	fps?: number;
	frameCount?: number;
} = {}): CameraTrackerData {
	return {
		version: 1,
		settings: { ...DEFAULT_CAMERA_TRACKER_SETTINGS, ...settings },
		mediaId: "media-1",
		sourceStart,
		frameWidth: 1920,
		frameHeight: 1080,
		tracks: {
			width: 480,
			height: 270,
			frameCount,
			fps,
			quantization: 64,
			trackCount: 0,
			trackStart: "",
			trackLen: "",
			xy: "",
			cuts: [],
		},
		deletedTrackIds: [],
		solve: hasSolve
			? {
					frameWidth: 1920,
					frameHeight: 1080,
					frameCount,
					cameras: "",
					solved: "",
					pointIds: "",
					points: "",
					methodUsed: "typical",
					averageError: 0.384,
					notices: [],
				}
			: null,
		failure,
		stale,
		groundPlaneSet: false,
	};
}

export function buildDecoded({
	elementId = "video-1",
	data = buildData(),
	tracks = null,
	solve = null,
	deleted = [],
}: {
	elementId?: string;
	data?: CameraTrackerData;
	tracks?: FeatureTracks | null;
	solve?: CameraSolve | null;
	deleted?: number[];
} = {}): DecodedCameraTracker {
	return { elementId, data, tracks, solve, deleted: new Set(deleted) };
}

/** A fake engine that records every call (workstream D registers the real one). */
export function fakeApi({
	decoded = null,
}: { decoded?: DecodedCameraTracker | null } = {}): CameraTrackerApi & {
	calls: Array<{ method: string; args: unknown }>;
} {
	const calls: Array<{ method: string; args: unknown }> = [];
	return {
		calls,
		trackCamera: (args) => {
			calls.push({ method: "trackCamera", args });
			return Promise.resolve({ status: "solved", elementId: args.elementId });
		},
		resolve: (args) => {
			calls.push({ method: "resolve", args });
			return Promise.resolve({ status: "solved", elementId: args.elementId });
		},
		cancel: () => {
			calls.push({ method: "cancel", args: null });
		},
		updateSettings: (args) => {
			calls.push({ method: "updateSettings", args });
		},
		deletePoints: (args) => {
			calls.push({ method: "deletePoints", args });
		},
		setGroundPlane: (args) => {
			calls.push({ method: "setGroundPlane", args });
		},
		createLayers: (args: CreateTrackedLayersArgs) => {
			calls.push({ method: "createLayers", args });
			return { status: "created", elementIds: ["new-1"], cameraElementId: null };
		},
		decoded: () => decoded,
	};
}
