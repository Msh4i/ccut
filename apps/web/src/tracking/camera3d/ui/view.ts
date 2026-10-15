import { cameraAtFrame, quadFrameToCanvas } from "@/scene3d/camera";
import type { Affine2, ViewCamera } from "@/scene3d/types";
import type { ElementBounds } from "@/preview/element-bounds";
import { getSourceTimeAtClipTime } from "@/retime/resolve";
import type { VideoElement } from "@/timeline";
import { mediaTimeToSeconds, type MediaTime } from "@/wasm";
import type { CameraSolve } from "../types";

/**
 * The coordinate chain of the track points overlay: playhead -> the tracked
 * clip's source time -> analysis frame; solve camera at that frame + where the
 * clip is drawn on the canvas -> a view camera that projects world points to
 * canvas pixels. The canvas -> overlay step is `preview/preview-coords.ts`.
 */

/** Source-media second shown by the clip at timeline time `time` (trim and retime included, as the renderer does). */
export function clipSourceTimeAt({
	clip,
	time,
}: {
	clip: Pick<VideoElement, "startTime" | "trimStart" | "retime">;
	time: MediaTime;
}): number {
	const clipTime =
		mediaTimeToSeconds({ time }) - mediaTimeToSeconds({ time: clip.startTime });
	return (
		mediaTimeToSeconds({ time: clip.trimStart }) +
		getSourceTimeAtClipTime({ clipTime, retime: clip.retime })
	);
}

/** Fractional analysis frame of a source time: frame i is at `sourceStart + i / fps`. */
export function analysisFrameAt({
	sourceTime,
	sourceStart,
	fps,
}: {
	sourceTime: number;
	sourceStart: number;
	fps: number;
}): number {
	return (sourceTime - sourceStart) * fps;
}

/** The analysis frame whose samples are shown at `frame` (the nearest), or `null` outside the analysis. */
export function analysisIndexAt({
	frame,
	frameCount,
}: {
	frame: number;
	frameCount: number;
}): number | null {
	if (!Number.isFinite(frame)) return null;
	const index = Math.floor(frame + 0.5);
	return index >= 0 && index < frameCount ? index : null;
}

/**
 * Frame pixels -> canvas pixels of the tracked clip drawn with `bounds`
 * (`tracking/host.ts` `buildHostBoundsAt`): the same quad the compositor
 * gets from `computeVisualTransform` (a negative size is a flip). `null`
 * for a zero-size (or non-finite) clip, canvas or frame.
 */
export function frameToCanvasFromBounds({
	bounds,
	frameWidth,
	frameHeight,
}: {
	bounds: ElementBounds;
	frameWidth: number;
	frameHeight: number;
}): Affine2 | null {
	const values = [bounds.cx, bounds.cy, bounds.width, bounds.height, bounds.rotation];
	if (!values.every(Number.isFinite)) return null;
	if (bounds.width === 0 || bounds.height === 0) return null;
	if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
	return quadFrameToCanvas({
		quad: {
			centerX: bounds.cx,
			centerY: bounds.cy,
			width: Math.abs(bounds.width),
			height: Math.abs(bounds.height),
			rotationDegrees: bounds.rotation,
			flipX: bounds.width < 0,
			flipY: bounds.height < 0,
		},
		frameWidth,
		frameHeight,
	});
}

/** The solve's camera at a fractional analysis frame, ready to project onto the canvas. */
export function trackedViewAt({
	solve,
	frame,
	frameToCanvas,
}: {
	solve: CameraSolve;
	frame: number;
	frameToCanvas: Affine2;
}): ViewCamera | null {
	const camera = cameraAtFrame({ frames: solve.cameras, frame });
	if (!camera) return null;
	return {
		kind: "tracked",
		rotation: camera.rotation,
		position: camera.position,
		focalPx: camera.focalPx,
		frameWidth: solve.frameWidth,
		frameHeight: solve.frameHeight,
		frameToCanvas,
	};
}
