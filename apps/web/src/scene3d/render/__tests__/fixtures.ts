import { packSolve, packTracks } from "@/tracking/camera3d/codec";
import {
	DEFAULT_CAMERA_TRACKER_SETTINGS,
	type CameraSolve,
	type CameraTrackerData,
	type CameraTrackerSettings,
} from "@/tracking/camera3d/types";
import type { FeatureTracks } from "@/tracking/camera/types";
import type {
	CameraElement,
	CameraTrack,
	SceneTracks,
	TextElement,
	TextTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { quatFromAxisAngle } from "../../math";
import type { CameraState } from "../../types";

/** Test data for the 3D render helpers: a tracked clip, its camera element, scene tracks. */

export const FRAME = { width: 1920, height: 1080 };
export const ANALYSIS_FPS = 30;
export const FRAME_COUNT = 60;

export function seconds(value: number): MediaTime {
	return mediaTimeFromSeconds({ seconds: value });
}

/** A camera that slides right and pans a little each analysis frame. */
export function solvedCameras(): CameraState[] {
	const cameras: CameraState[] = [];
	for (let i = 0; i < FRAME_COUNT; i++) {
		cameras.push({
			rotation: quatFromAxisAngle({ axis: [0, 1, 0], radians: i * 0.004 }),
			position: [i * 8, -20, -1500],
			focalPx: 1500 + i,
		});
	}
	return cameras;
}

/**
 * Tracks of three features: track 0 lives on frames 0..59, track 1 on
 * 10..19, track 2 on 30..59.
 */
export function featureTracks(): FeatureTracks {
	const trackStart = Int32Array.from([0, 10, 30]);
	const trackLen = Int32Array.from([60, 10, 30]);
	const trackOffset = Int32Array.from([0, 120, 140]);
	const xy = new Float32Array(200);
	for (let i = 0; i < xy.length; i++) xy[i] = (i % 2 === 0 ? 100 : 60) + i * 0.01;
	const liveOffsets = new Int32Array(FRAME_COUNT + 1);
	const live: number[] = [];
	for (let f = 0; f < FRAME_COUNT; f++) {
		for (let id = 0; id < 3; id++) {
			if (f >= trackStart[id] && f < trackStart[id] + trackLen[id]) live.push(id);
		}
		liveOffsets[f + 1] = live.length;
	}
	return {
		w: 480,
		h: 270,
		frameCount: FRAME_COUNT,
		fps: ANALYSIS_FPS,
		trackStart,
		trackLen,
		trackOffset,
		xy,
		liveOffsets,
		liveIds: Int32Array.from(live),
		cuts: [],
		stats: { lostFraction: new Float32Array(FRAME_COUNT), cutNcc: [] },
	};
}

export function cameraSolve(): CameraSolve {
	return {
		frameWidth: FRAME.width,
		frameHeight: FRAME.height,
		cameras: solvedCameras(),
		solved: new Uint8Array(FRAME_COUNT).fill(1),
		points: [
			{ trackId: 0, position: [0, 0, 0], error: 0.2 },
			{ trackId: 1, position: [200, 50, 100], error: 0.3 },
			{ trackId: 2, position: [-150, 80, -50], error: 0.4 },
		],
		methodUsed: "typical",
		averageError: 0.3,
		notices: [],
	};
}

export function trackerData({
	sourceStart = 1.5,
	settings = {},
	deletedTrackIds = [],
}: {
	sourceStart?: number;
	settings?: Partial<CameraTrackerSettings>;
	deletedTrackIds?: number[];
} = {}): CameraTrackerData {
	return {
		version: 1,
		settings: { ...DEFAULT_CAMERA_TRACKER_SETTINGS, ...settings },
		mediaId: "clip-media",
		sourceStart,
		frameWidth: FRAME.width,
		frameHeight: FRAME.height,
		tracks: packTracks(featureTracks()),
		deletedTrackIds,
		solve: packSolve(cameraSolve()),
		failure: null,
		stale: "none",
		groundPlaneSet: false,
	};
}

export function videoElement({
	id = "clip",
	startTime = 0,
	trimStart = 1,
	duration = 2,
	params = {},
	cameraTracker = trackerData(),
	rate,
}: {
	id?: string;
	startTime?: number;
	trimStart?: number;
	duration?: number;
	params?: VideoElement["params"];
	/** `null`: a clip that was never tracked. */
	cameraTracker?: CameraTrackerData | null;
	rate?: number;
} = {}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "clip-media",
		startTime: seconds(startTime),
		trimStart: seconds(trimStart),
		trimEnd: seconds(0),
		duration: seconds(duration),
		params,
		...(rate !== undefined && { retime: { rate } }),
		...(cameraTracker && { cameraTracker }),
	};
}

export function cameraElement({
	id = "camera",
	sourceElementId = "clip",
	startTime = 0,
	duration = 2,
	hidden,
}: {
	id?: string;
	sourceElementId?: string;
	startTime?: number;
	duration?: number;
	hidden?: boolean;
} = {}): CameraElement {
	return {
		id,
		name: id,
		type: "camera",
		sourceElementId,
		startTime: seconds(startTime),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		duration: seconds(duration),
		params: {},
		...(hidden !== undefined && { hidden }),
	};
}

export function cameraTrack({
	id = "camera-track",
	elements,
	hidden = false,
}: {
	id?: string;
	elements: CameraElement[];
	hidden?: boolean;
}): CameraTrack {
	return { id, name: id, type: "camera", elements, hidden };
}

export function mainTrack(elements: VideoElement[]): VideoTrack {
	return {
		id: "main",
		name: "main",
		type: "video",
		elements,
		muted: false,
		hidden: false,
	};
}

export function textTrack(elements: TextElement[]): TextTrack {
	return { id: "text-track", name: "text", type: "text", elements, hidden: false };
}

export function sceneTracks({
	overlay = [],
	main = [videoElement()],
}: {
	overlay?: SceneTracks["overlay"];
	main?: VideoElement[];
} = {}): SceneTracks {
	return { overlay, main: mainTrack(main), audio: [] };
}
