import { getElementLocalTime } from "@/animation";
import { buildTransformFromParams, readOpacityFromParams } from "@/rendering";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	resolveVisualTransformAtTime,
	visualQuadTransform,
} from "@/services/renderer/visual-transform";
import { decodedSolve } from "@/tracking/camera3d/engine/decoded-cache";
import type { CameraElement, SceneTracks, VideoElement } from "@/timeline";
import { mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import { cameraAtFrame, defaultViewCamera, quadFrameToCanvas } from "../camera";
import type { ViewCamera } from "../types";

/**
 * The camera 3D layers are drawn through at a time (AE: the topmost active
 * camera layer). Reads stored tracker data through the shared decode cache
 * (`codec.ts`, validated, untrusted input) and never throws on bad data:
 * anything unusable falls back to the default camera.
 */

function isActiveAt({
	element,
	time,
}: {
	element: { startTime: number; duration: number };
	time: number;
}): boolean {
	const clipTime = time - element.startTime;
	return clipTime >= 0 && clipTime < element.duration;
}

/**
 * The topmost visible camera element active at `time`: overlay tracks from
 * the top, hidden tracks and hidden elements skipped; on one track the one
 * drawn last (latest start, then id) wins.
 */
export function findActiveCameraElement({
	tracks,
	time,
}: {
	tracks: SceneTracks;
	time: number;
}): CameraElement | null {
	for (const track of tracks.overlay) {
		if (track.type !== "camera" || track.hidden) continue;
		let found: CameraElement | null = null;
		for (const element of track.elements) {
			if (element.hidden || !isActiveAt({ element, time })) continue;
			if (
				!found ||
				element.startTime > found.startTime ||
				(element.startTime === found.startTime &&
					element.id.localeCompare(found.id) > 0)
			) {
				found = element;
			}
		}
		if (found) return found;
	}
	return null;
}

/** The video element with this id on any video track, or null. */
export function findVideoElement({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): VideoElement | null {
	for (const track of [...tracks.overlay, tracks.main]) {
		if (track.type !== "video") continue;
		for (const element of track.elements) {
			if (element.type === "video" && element.id === elementId) return element;
		}
	}
	return null;
}

/** Source-media second the clip shows at a timeline time (the video layer's rule). */
function sourceSecondsAt({
	video,
	time,
}: {
	video: VideoElement;
	time: number;
}): number {
	const sourceTicks =
		video.trimStart +
		getSourceTimeAtClipTime({ clipTime: time - video.startTime, retime: video.retime });
	return mediaTimeToSeconds({ time: roundMediaTime({ time: sourceTicks }) });
}

/**
 * The fractional analysis frame of the clip's tracker data shown at a
 * timeline time: `(sourceSeconds - sourceStart) * fps`. Null without
 * tracker data or with an unusable rate.
 */
export function analysisFrameAt({
	video,
	time,
}: {
	video: VideoElement;
	time: number;
}): number | null {
	const data = video.cameraTracker;
	if (!data) return null;
	const fps = data.tracks?.fps;
	if (typeof fps !== "number" || !Number.isFinite(fps) || !(fps > 0)) return null;
	if (!Number.isFinite(data.sourceStart)) return null;
	const frame = (sourceSecondsAt({ video, time }) - data.sourceStart) * fps;
	return Number.isFinite(frame) ? frame : null;
}

/**
 * The camera solved on `video`, at a timeline time, seen on the canvas:
 * `frameToCanvas` is where the clip's picture is drawn then (its animated
 * transform, presets, contain-fit and flips, exactly like the video layer).
 * Null when the clip has no usable solve.
 */
export function trackedViewCamera({
	video,
	time,
	canvasWidth,
	canvasHeight,
}: {
	video: VideoElement;
	time: number;
	canvasWidth: number;
	canvasHeight: number;
}): ViewCamera | null {
	const data = video.cameraTracker;
	if (!data?.solve) return null;
	const solve = decodedSolve(data.solve);
	if (!solve) return null;
	const frame = analysisFrameAt({ video, time });
	if (frame === null) return null;
	const camera = cameraAtFrame({ frames: solve.cameras, frame });
	if (!camera) return null;
	const { transform } = resolveVisualTransformAtTime({
		baseTransform: buildTransformFromParams({ params: video.params }),
		baseOpacity: readOpacityFromParams({ params: video.params }),
		animations: video.animations,
		presetAnimations: video.presetAnimations,
		localTime: getElementLocalTime({
			timelineTime: time,
			elementStartTime: video.startTime,
			elementDuration: video.duration,
		}),
		duration: video.duration,
		canvasWidth,
		canvasHeight,
		sourceWidth: solve.frameWidth,
		sourceHeight: solve.frameHeight,
	});
	const quad = visualQuadTransform({
		canvasWidth,
		canvasHeight,
		transform,
		sourceWidth: solve.frameWidth,
		sourceHeight: solve.frameHeight,
	});
	return {
		kind: "tracked",
		rotation: camera.rotation,
		position: camera.position,
		focalPx: camera.focalPx,
		frameWidth: solve.frameWidth,
		frameHeight: solve.frameHeight,
		frameToCanvas: quadFrameToCanvas({
			quad,
			frameWidth: solve.frameWidth,
			frameHeight: solve.frameHeight,
		}),
	};
}

/**
 * The view camera of the frame at `time`: the topmost active camera
 * element's solved camera, or the default camera of the canvas.
 */
export function activeCameraAt({
	tracks,
	time,
	canvasWidth,
	canvasHeight,
}: {
	tracks: SceneTracks;
	time: number;
	canvasWidth: number;
	canvasHeight: number;
}): ViewCamera {
	const element = findActiveCameraElement({ tracks, time });
	const source = element
		? findVideoElement({ tracks, elementId: element.sourceElementId })
		: null;
	const tracked = source
		? trackedViewCamera({ video: source, time, canvasWidth, canvasHeight })
		: null;
	return tracked ?? defaultViewCamera({ canvasWidth, canvasHeight });
}
