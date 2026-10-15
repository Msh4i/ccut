import type { VideoElement } from "@/timeline";
import { decodedParts } from "@/tracking/camera3d/engine/decoded-cache";
import { projectToCanvas } from "../camera";
import { analysisFrameAt, trackedViewCamera } from "./active-camera";

/**
 * AE "Render Track Points": the solved 3D track points of a tracked clip,
 * drawn into the picture (preview AND export, one render path) as small
 * crosses at their projections, for the tracks alive at the shown frame.
 */

/** Cross half-size in canvas pixels at Track Point Size 100 % on a 1080 px short side. */
export const TRACK_POINT_RADIUS_PER_1080 = 6;

export interface RenderedTrackPoint {
	trackId: number;
	x: number;
	y: number;
}

export interface RenderedTrackPoints {
	points: RenderedTrackPoint[];
	/** Cross half-size, canvas pixels. */
	radius: number;
	lineWidth: number;
}

/** Points farther outside the canvas than this many radii are left out. */
const OFFSCREEN_MARGIN_RADII = 2;

/** At most this many crosses are drawn per frame (the first by track id), however many tracks are alive. */
export const MAX_RENDERED_TRACK_POINTS = 5000;

/**
 * The crosses to draw for `video` at a timeline time, or `null` when the
 * clip does not render its track points (setting off, no usable solve).
 */
export function trackPointsAt({
	video,
	time,
	canvasWidth,
	canvasHeight,
}: {
	video: VideoElement;
	time: number;
	canvasWidth: number;
	canvasHeight: number;
}): RenderedTrackPoints | null {
	const data = video.cameraTracker;
	if (!data?.settings?.renderTrackPoints || !data.solve) return null;
	const { solve, tracks, deleted } = decodedParts({ data });
	const view = trackedViewCamera({ video, time, canvasWidth, canvasHeight });
	const frame = analysisFrameAt({ video, time });
	if (!solve || !tracks || !view || frame === null) return null;

	const size = Number.isFinite(data.settings.trackPointSize)
		? Math.max(0, data.settings.trackPointSize)
		: 100;
	const radius =
		TRACK_POINT_RADIUS_PER_1080 *
		(Math.min(canvasWidth, canvasHeight) / 1080) *
		(size / 100);
	const result: RenderedTrackPoints = {
		points: [],
		radius,
		lineWidth: Math.max(1, radius / 3),
	};
	const index = Math.round(frame);
	if (index < 0 || index >= tracks.frameCount || !(radius > 0)) return result;

	const margin = radius * OFFSCREEN_MARGIN_RADII;
	for (const point of solve.points) {
		if (result.points.length >= MAX_RENDERED_TRACK_POINTS) break;
		const id = point.trackId;
		if (deleted.has(id) || id >= tracks.trackStart.length) continue;
		const start = tracks.trackStart[id];
		if (index < start || index >= start + tracks.trackLen[id]) continue;
		const projected = projectToCanvas({ view, point: point.position });
		if (!projected) continue;
		if (
			projected.x < -margin ||
			projected.y < -margin ||
			projected.x > canvasWidth + margin ||
			projected.y > canvasHeight + margin
		) {
			continue;
		}
		result.points.push({ trackId: id, x: projected.x, y: projected.y });
	}
	return result;
}

/** A stable colour per track (golden-angle hues), so neighbouring points can be told apart. */
export function trackPointColor(trackId: number): string {
	const hue = (trackId * 137.508) % 360;
	return `hsl(${hue.toFixed(1)}, 90%, 55%)`;
}
