import type { Target } from "@/scene3d/types";
import {
	updateElementInSceneTracks,
	type CameraElement,
	type CameraTrack,
	type CreateCameraElement,
	type CreateTimelineElement,
	type OverlayTrack,
	type SceneTracks,
	type TimelineElement,
	type TrackType,
	type VideoElement,
} from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { findElementInTracks } from "@/tracking/host";
import { packSolve } from "../codec";
import type { CameraTrackerData, CameraTrackerStale } from "../types";
import { decodedParts } from "./decoded-cache";
import {
	groundPlaneRebase,
	layersSeenThroughClip,
	rebaseLayerElement,
	rebaseSolve,
} from "./ground-plane";

/**
 * Pure scene edits behind the Track Camera commands. Each returns new
 * tracks (unchanged parts keep their identity) or throws, changing
 * nothing, when the edit cannot be made.
 */

/** The video clip with this id and the track it is on, wherever it lives. */
export function findVideoClip({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): { trackId: string; element: VideoElement } | null {
	const found = findElementInTracks({ tracks, elementId });
	if (!found || found.element.type !== "video") return null;
	return { trackId: found.trackId, element: found.element };
}

function requireVideoClip({ tracks, elementId }: { tracks: SceneTracks; elementId: string }) {
	const found = findVideoClip({ tracks, elementId });
	if (!found) throw new Error(`Track Camera: no video clip "${elementId.slice(0, 80)}" in the scene.`);
	return found;
}

/** The clip with `data` as its tracker data (`null` removes the field). */
export function withCameraTracker({
	tracks,
	elementId,
	data,
}: {
	tracks: SceneTracks;
	elementId: string;
	data: CameraTrackerData | null;
}): SceneTracks {
	const { trackId } = requireVideoClip({ tracks, elementId });
	return updateElementInSceneTracks({
		tracks,
		trackId,
		elementId,
		update: (element) => {
			if (element.type !== "video") return element;
			if (data) return { ...element, cameraTracker: data };
			const { cameraTracker: removed, ...rest } = element;
			if (removed === undefined) return rest;
			// A tracker removed on purpose is gone: the record set aside before the clip was tracked again
			// must not be written back by the next save (a new record already wins over it there).
			const { unusableCameraTracker: _superseded, ...cleaned } = rest;
			return cleaned;
		},
	});
}

const STALE_ORDER: Record<CameraTrackerStale, number> = { none: 0, solve: 1, analysis: 2 };

/** The more severe of two staleness levels (an analysis to redo also needs a solve). */
export function maxStale({ a, b }: { a: CameraTrackerStale; b: CameraTrackerStale }): CameraTrackerStale {
	return STALE_ORDER[a] >= STALE_ORDER[b] ? a : b;
}

/**
 * The record with `trackIds` added to the deleted tracks (whole tracks: AE's
 * Auto-delete Points Across Time) and the solve marked stale; `null` when no
 * new valid id is among them.
 */
export function withDeletedTrackPoints({
	data,
	trackIds,
}: {
	data: CameraTrackerData;
	trackIds: readonly number[];
}): CameraTrackerData | null {
	const deleted = new Set(data.deletedTrackIds);
	const before = deleted.size;
	for (const id of trackIds) {
		if (Number.isInteger(id) && id >= 0 && id < data.tracks.trackCount) deleted.add(id);
	}
	if (deleted.size === before) return null;
	return {
		...data,
		deletedTrackIds: [...deleted].sort((a, b) => a - b),
		stale: maxStale({ a: data.stale, b: "solve" }),
	};
}

/**
 * Set Ground Plane and Origin on the clip's solve, with the camera of
 * analysis frame `frame` (clamped) fixing the turn about the new up axis;
 * every 3D layer seen through the clip's camera moves into the new world so
 * nothing changes on screen.
 */
export function applyGroundPlane({
	tracks,
	elementId,
	target,
	frame,
}: {
	tracks: SceneTracks;
	elementId: string;
	target: Target;
	frame: number;
}): SceneTracks {
	const { trackId, element } = requireVideoClip({ tracks, elementId });
	const data = element.cameraTracker;
	if (!data?.solve) throw new Error("Set Ground Plane needs a solved camera.");
	const solve = decodedParts({ data }).solve;
	if (!solve || solve.cameras.length === 0) throw new Error("The stored camera solve cannot be read.");
	const index = Math.min(solve.cameras.length - 1, Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0)));
	const rebase = groundPlaneRebase({ target, camera: solve.cameras[index] });
	if (!rebase) throw new Error("Set Ground Plane needs a target with a plane.");
	const nextData: CameraTrackerData = {
		...data,
		solve: packSolve(rebaseSolve({ rebase, solve })),
		groundPlaneSet: true,
	};
	let next = updateElementInSceneTracks({
		tracks,
		trackId,
		elementId,
		update: (clip) => (clip.type === "video" ? { ...clip, cameraTracker: nextData } : clip),
	});
	for (const ref of layersSeenThroughClip({ tracks, clipId: elementId })) {
		next = updateElementInSceneTracks({
			tracks: next,
			trackId: ref.trackId,
			elementId: ref.elementId,
			update: (layer) => rebaseLayerElement({ element: layer, rebase }),
		});
	}
	return next;
}

const LAYER_TRACK_TYPES: Partial<Record<TimelineElement["type"], Exclude<TrackType, "audio" | "camera">>> = {
	text: "text",
	image: "video",
	sticker: "graphic",
	graphic: "graphic",
};

function overlaps({ a, b }: { a: { startTime: number; duration: number }; b: { startTime: number; duration: number } }): boolean {
	return a.startTime < b.startTime + b.duration && b.startTime < a.startTime + a.duration;
}

function emptyOverlayTrack({ id, type }: { id: string; type: Exclude<TrackType, "audio" | "camera"> }): OverlayTrack {
	switch (type) {
		case "video":
			return buildEmptyTrack({ id, type });
		case "text":
			return buildEmptyTrack({ id, type });
		case "graphic":
			return buildEmptyTrack({ id, type });
		case "effect":
			return buildEmptyTrack({ id, type });
	}
}

function withElement({ track, element }: { track: OverlayTrack; element: TimelineElement }): OverlayTrack {
	switch (track.type) {
		case "text":
			return element.type === "text" ? { ...track, elements: [...track.elements, element] } : track;
		case "graphic":
			return element.type === "sticker" || element.type === "graphic"
				? { ...track, elements: [...track.elements, element] }
				: track;
		case "video":
			return element.type === "image" || element.type === "video"
				? { ...track, elements: [...track.elements, element] }
				: track;
		default:
			return track;
	}
}

/**
 * Inserts created 3D layers and an optional camera at the top of the
 * overlay tracks: the camera on a new camera track above everything, the
 * layers on new tracks below it (a layer shares a new track with an earlier
 * one when their times do not overlap). `elementIds` / `trackIds` are the
 * ids to use, in order (made once by the command, so a redo repeats them).
 */
export function insertTrackedLayers({
	tracks,
	layers,
	camera,
	elementIds,
	cameraElementId,
	trackIds,
	cameraTrackId,
}: {
	tracks: SceneTracks;
	layers: readonly CreateTimelineElement[];
	camera: CreateCameraElement | null;
	elementIds: readonly string[];
	cameraElementId: string;
	trackIds: readonly string[];
	cameraTrackId: string;
}): SceneTracks {
	if (layers.length === 0 && !camera) throw new Error("Nothing to create.");
	if (elementIds.length < layers.length || trackIds.length < layers.length) {
		throw new Error("Track Camera: missing ids for the created layers.");
	}
	const newTracks: OverlayTrack[] = [];
	layers.forEach((layer, index) => {
		const trackType = LAYER_TRACK_TYPES[layer.type];
		if (!trackType) throw new Error(`Track Camera cannot create a ${layer.type} layer.`);
		const element: TimelineElement = { ...layer, id: elementIds[index] };
		const free = newTracks.findIndex(
			(track) => track.type === trackType && track.elements.every((other) => !overlaps({ a: other, b: element })),
		);
		if (free >= 0) {
			newTracks[free] = withElement({ track: newTracks[free], element });
		} else {
			newTracks.push(withElement({ track: emptyOverlayTrack({ id: trackIds[newTracks.length], type: trackType }), element }));
		}
	});
	const cameraTracks: CameraTrack[] = [];
	if (camera) {
		const cameraElement: CameraElement = { ...camera, id: cameraElementId };
		cameraTracks.push({ ...buildEmptyTrack({ id: cameraTrackId, type: "camera" }), elements: [cameraElement] });
	}
	return { ...tracks, overlay: [...cameraTracks, ...newTracks, ...tracks.overlay] };
}
