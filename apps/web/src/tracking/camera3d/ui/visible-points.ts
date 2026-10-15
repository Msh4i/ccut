import { projectToCanvas } from "@/scene3d/camera";
import { affineApply } from "@/scene3d/math";
import type { Affine2, Vec3, ViewCamera } from "@/scene3d/types";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { CameraSolve, TrackPointDisplay } from "../types";

/** A track point drawn at the current frame, in canvas pixels. */
export interface VisiblePoint {
	trackId: number;
	x: number;
	y: number;
	/** Camera-space depth (3D Solved only). */
	depth: number | null;
	/** The solved 3D position, `null` when the solve has none for this track (it cannot define a target). */
	world: Vec3 | null;
}

/** Solved 3D position per track id. */
export function solvedPositions(solve: CameraSolve | null): ReadonlyMap<number, Vec3> {
	const positions = new Map<number, Vec3>();
	for (const point of solve?.points ?? []) {
		positions.set(point.trackId, point.position);
	}
	return positions;
}

/**
 * The track points AE shows at analysis frame `index`: with 2D Source the
 * tracked positions (index pixels -> frame pixels -> canvas), with 3D Solved
 * the solved points of the tracks alive there, projected through `view`
 * (points behind the camera are dropped). Deleted tracks are never shown.
 */
export function visiblePointsAt({
	display,
	tracks,
	index,
	deleted,
	solved,
	frameWidth,
	frameHeight,
	frameToCanvas,
	view,
}: {
	display: TrackPointDisplay;
	tracks: FeatureTracks;
	index: number;
	deleted: ReadonlySet<number>;
	solved: ReadonlyMap<number, Vec3>;
	frameWidth: number;
	frameHeight: number;
	frameToCanvas: Affine2;
	view: ViewCamera | null;
}): VisiblePoint[] {
	if (!(index >= 0 && index < tracks.frameCount)) return [];
	if (display === "3d-solved" && !view) return [];
	const points: VisiblePoint[] = [];
	const scaleX = frameWidth / tracks.w;
	const scaleY = frameHeight / tracks.h;
	for (let k = tracks.liveOffsets[index]; k < tracks.liveOffsets[index + 1]; k++) {
		const trackId = tracks.liveIds[k];
		if (deleted.has(trackId)) continue;
		const world = solved.get(trackId) ?? null;
		if (display === "3d-solved") {
			if (!world || !view) continue;
			const projected = projectToCanvas({ view, point: world });
			if (!projected) continue;
			points.push({ trackId, x: projected.x, y: projected.y, depth: projected.depth, world });
			continue;
		}
		const sample = index - tracks.trackStart[trackId];
		if (sample < 0 || sample >= tracks.trackLen[trackId]) continue;
		const offset = tracks.trackOffset[trackId] + 2 * sample;
		const canvas = affineApply({
			m: frameToCanvas,
			x: (tracks.xy[offset] + 0.5) * scaleX,
			y: (tracks.xy[offset + 1] + 0.5) * scaleY,
		});
		points.push({ trackId, x: canvas.x, y: canvas.y, depth: null, world });
	}
	return points;
}
