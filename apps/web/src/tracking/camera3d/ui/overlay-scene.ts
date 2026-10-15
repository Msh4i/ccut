import type { Target, Vec3, ViewCamera } from "@/scene3d/types";
import { buildHostBoundsAt, type HostBoundsClip } from "@/tracking/host";
import { mediaTimeToSeconds, type MediaTime } from "@/wasm";
import type { DecodedCameraTracker } from "../session";
import {
	dropLongTriangles,
	MAX_TRIANGULATED_POINTS,
	triangulate,
	type Point2,
	type Triangle,
} from "./delaunay";
import {
	findPointAt,
	findTriangleAt,
	indicesInPolygon,
	indicesInRect,
	pointInPolygon,
} from "./hit-test";
import { markerSizes } from "./markers";
import type { Selection, SelectionHit } from "./selection";
import { targetFromPoints, targetWithCenter } from "./target";
import {
	analysisFrameAt,
	analysisIndexAt,
	clipSourceTimeAt,
	frameToCanvasFromBounds,
	trackedViewAt,
} from "./view";
import { solvedPositions, visiblePointsAt, type VisiblePoint } from "./visible-points";

/**
 * Everything the track points overlay draws at the playhead, in canvas
 * pixels, computed once per frame: the visible points and their marker
 * sizes, the Delaunay triangles between the points that have a solved 3D
 * position (only those can define a target), and the view camera. The
 * triangles are computed on first use (hover, click), not during playback.
 */
export interface OverlayScene {
	/** Fractional analysis frame of the playhead. */
	frame: number;
	/** The analysis frame whose samples are shown, `null` outside the analysis. */
	index: number | null;
	view: ViewCamera | null;
	points: VisiblePoint[];
	/** Marker size (screen pixels) of each of `points`. */
	sizes: number[];
	/** Indices into `points` of the points that have a solved 3D position. */
	selectable: number[];
	/** Triangles over `selectable` (indices into `selectable`), computed once on first call. */
	triangles: () => readonly Triangle[];
	solved: ReadonlyMap<number, Vec3>;
}

/** Triangles with an edge longer than this share of the clip's on-canvas diagonal are not offered. */
const MAX_TRIANGLE_EDGE_SHARE = 0.35;

/**
 * At most this many points are drawn per frame (lowest track ids first):
 * stored data is untrusted, and a hostile project must not make the
 * overlay draw a million markers.
 */
export const MAX_DRAWN_POINTS = 5000;

const NO_TRIANGLES = (): readonly Triangle[] => [];

/** Memoised on first call. */
function lazy<T>(compute: () => T): () => T {
	let cache: { value: T } | null = null;
	return () => {
		if (!cache) cache = { value: compute() };
		return cache.value;
	};
}

export function buildOverlayScene({
	decoded,
	clip,
	time,
	canvasWidth,
	canvasHeight,
}: {
	decoded: DecodedCameraTracker;
	clip: HostBoundsClip;
	time: MediaTime;
	canvasWidth: number;
	canvasHeight: number;
}): OverlayScene | null {
	const { data, tracks, solve } = decoded;
	if (!tracks) return null;
	if (!(canvasWidth > 0) || !(canvasHeight > 0)) return null;
	const bounds = buildHostBoundsAt({
		host: clip,
		canvasWidth,
		canvasHeight,
		sourceWidth: data.frameWidth,
		sourceHeight: data.frameHeight,
	})(mediaTimeToSeconds({ time }));
	const frameToCanvas = frameToCanvasFromBounds({
		bounds,
		frameWidth: data.frameWidth,
		frameHeight: data.frameHeight,
	});
	if (!frameToCanvas) return null;
	const frame = analysisFrameAt({
		sourceTime: clipSourceTimeAt({ clip, time }),
		sourceStart: data.sourceStart,
		fps: tracks.fps,
	});
	const index = analysisIndexAt({ frame, frameCount: tracks.frameCount });
	const view = solve ? trackedViewAt({ solve, frame, frameToCanvas }) : null;
	const solved = solvedPositions(solve);
	const empty: OverlayScene = {
		frame,
		index,
		view,
		points: [],
		sizes: [],
		selectable: [],
		triangles: NO_TRIANGLES,
		solved,
	};
	if (index === null) return empty;
	const display = data.settings.showTrackPoints;
	const points = visiblePointsAt({
		display,
		tracks,
		index,
		deleted: decoded.deleted,
		solved,
		frameWidth: data.frameWidth,
		frameHeight: data.frameHeight,
		frameToCanvas,
		view,
	}).slice(0, MAX_DRAWN_POINTS);
	const sizes = markerSizes({
		depths: points.map((point) => point.depth),
		trackPointSize: data.settings.trackPointSize,
		display,
	});
	const selectable = points.flatMap((point, at) => (point.world ? [at] : []));
	const corners: Point2[] = selectable.map((at) => points[at]);
	const maxEdge = MAX_TRIANGLE_EDGE_SHARE * Math.hypot(bounds.width, bounds.height);
	const triangles = lazy(() =>
		corners.length <= MAX_TRIANGULATED_POINTS
			? dropLongTriangles({ triangles: triangulate({ points: corners }), points: corners, maxEdge })
			: [],
	);
	return { ...empty, points, sizes, selectable, triangles };
}

export interface Hover {
	/** The point under the pointer. */
	trackId: number | null;
	/** The triangle under the pointer (when no point is), as track ids. */
	triangleIds: readonly [number, number, number] | null;
	/** That triangle's corners in canvas pixels. */
	triangle: readonly [Point2, Point2, Point2] | null;
}

const NO_HOVER: Hover = { trackId: null, triangleIds: null, triangle: null };

/** What is under the pointer (canvas pixels): a point within `pointRadius`, else a triangle. */
export function hoverAt({
	scene,
	at,
	pointRadius,
}: {
	scene: OverlayScene;
	at: Point2;
	pointRadius: number;
}): Hover {
	const pointIndex = findPointAt({ points: scene.points, at, radius: pointRadius });
	if (pointIndex !== null) {
		return { ...NO_HOVER, trackId: scene.points[pointIndex].trackId };
	}
	const corners = scene.selectable.map((index) => scene.points[index]);
	const triangles = scene.triangles();
	const triangleIndex = findTriangleAt({ points: corners, triangles, at });
	if (triangleIndex === null) return NO_HOVER;
	const [a, b, c] = triangles[triangleIndex];
	return {
		trackId: null,
		triangleIds: [corners[a].trackId, corners[b].trackId, corners[c].trackId],
		triangle: [corners[a], corners[b], corners[c]],
	};
}

/** The selection change of a click at `at`: a solved point, else the triangle around it, else nothing. */
export function selectionHitAt({
	scene,
	at,
	pointRadius,
}: {
	scene: OverlayScene;
	at: Point2;
	pointRadius: number;
}): SelectionHit {
	const hover = hoverAt({ scene, at, pointRadius });
	if (hover.trackId !== null) {
		// a point without a solved 3D position cannot be selected (it cannot define a target)
		return scene.solved.has(hover.trackId)
			? { kind: "point", trackId: hover.trackId }
			: { kind: "none" };
	}
	return hover.triangleIds
		? { kind: "triangle", trackIds: hover.triangleIds }
		: { kind: "none" };
}

/** Track ids of the selectable points inside a marquee (`rect`) or a lasso (`polygon`). */
export function trackIdsInRegion({
	scene,
	region,
}: {
	scene: OverlayScene;
	region: { kind: "rect"; from: Point2; to: Point2 } | { kind: "polygon"; polygon: readonly Point2[] };
}): number[] {
	const points = scene.selectable.map((index) => scene.points[index]);
	const inside =
		region.kind === "rect"
			? indicesInRect({ points, from: region.from, to: region.to })
			: indicesInPolygon({ points, polygon: region.polygon });
	return inside.map((index) => points[index].trackId);
}

/**
 * What a left press starts: inside the selection target's centre area a
 * target move (Alt: a resize, AE's Alt-drag), anywhere else a selection
 * gesture (click, marquee, Alt lasso).
 */
export function pressRole({
	at,
	alt,
	moveHandle,
}: {
	at: Point2;
	alt: boolean;
	moveHandle: readonly Point2[] | null;
}): "move-target" | "resize-target" | "select" {
	if (!moveHandle || !pointInPolygon({ polygon: moveHandle, p: at })) return "select";
	return alt ? "resize-target" : "move-target";
}

/**
 * The target of a set of track ids: on the plane of their solved 3D points
 * (ids without one are skipped), moved to `centerOverride` when the user
 * dragged it. `null` without any solved point or view.
 */
export function selectionTarget({
	selection,
	solved,
	view,
	targetSize,
	centerOverride,
}: {
	selection: Selection;
	solved: ReadonlyMap<number, Vec3>;
	view: ViewCamera;
	targetSize: number;
	centerOverride: Vec3 | null;
}): Target | null {
	const points = selection.flatMap((id) => {
		const position = solved.get(id);
		return position ? [position] : [];
	});
	const target = targetFromPoints({ points, camera: view, targetSize });
	if (!target || !centerOverride) return target;
	return targetWithCenter({ target, center: centerOverride, camera: view, targetSize });
}
