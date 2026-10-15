import { NULL_GRAPHIC_DEFINITION_ID } from "@/graphics/definitions";
import { paramsFromTransform3D } from "@/scene3d/layer-params";
import type { Target } from "@/scene3d/types";
import type {
	CreateCameraElement,
	CreateTimelineElement,
	SceneTracks,
	VideoElement,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import {
	buildCameraElement,
	buildElementFromMedia,
	buildGraphicElement,
	buildTextElement,
} from "@/timeline/element-utils";
import type { FeatureTracks } from "@/tracking/camera/types";
import { roundMediaTime, type MediaTime } from "@/wasm";
import type { CreatableLayerKind, CreateTrackedLayersArgs } from "../session";
import type { CameraSolve, CameraTrackerData } from "../types";
import { timelineTicksOfFrame } from "./frame-time";
import { placeLayerOnTarget } from "./placement";

/** AE "Create Solid": a neutral grey, visible on light and dark footage. */
export const SOLID_FILL = "#808080";
/** AE gives a created text layer this text. */
export const CREATED_TEXT_CONTENT = "Text";

export const CREATE_LAYER_MESSAGES = {
	noSolve: "Solve the camera of this clip first.",
	noTarget: "Select track points to place the layer on.",
	badTarget: "The selected points do not define a plane.",
	noImage: "Choose an image from the media library.",
	noPoints: "None of the selected points can carry a layer.",
	cameraExists: "This clip already has a camera.",
	noContent: "The layer has no size to place.",
} as const;

const NAME_PREFIX: Record<CreatableLayerKind, string> = {
	text: "Track Text",
	solid: "Track Solid",
	null: "Track Null",
	image: "Track Image",
};

export type PlannedLayers =
	| { status: "planned"; layers: CreateTimelineElement[]; camera: CreateCameraElement | null }
	| { status: "failed"; message: string };

function allElementNames({ tracks }: { tracks: SceneTracks }): string[] {
	const names: string[] = [];
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) names.push(element.name);
	}
	return names;
}

/** The first number N such that "<prefix> N" and above are free in the scene. */
export function nextLayerNumber({ tracks, prefix }: { tracks: SceneTracks; prefix: string }): number {
	let highest = 0;
	for (const name of allElementNames({ tracks })) {
		if (!name.startsWith(`${prefix} `)) continue;
		const number = Number(name.slice(prefix.length + 1));
		if (Number.isInteger(number) && number > highest) highest = number;
	}
	return highest + 1;
}

/** Is there a camera of this clip spanning all of it? */
export function hasCoveringCamera({ tracks, clip }: { tracks: SceneTracks; clip: VideoElement }): boolean {
	const clipEnd = clip.startTime + clip.duration;
	return tracks.overlay.some(
		(track) =>
			track.type === "camera" &&
			track.elements.some(
				(camera) =>
					camera.sourceElementId === clip.id &&
					camera.startTime <= clip.startTime &&
					camera.startTime + camera.duration >= clipEnd,
			),
	);
}

function buildBase({
	kind,
	name,
	startTime,
	duration,
	mediaId,
}: {
	kind: CreatableLayerKind;
	name: string;
	startTime: MediaTime;
	duration: MediaTime;
	mediaId: string;
}): CreateTimelineElement {
	switch (kind) {
		case "text":
			return buildTextElement({
				raw: {
					...DEFAULTS.text.element,
					name,
					duration,
					params: { ...DEFAULTS.text.element.params, content: CREATED_TEXT_CONTENT },
				},
				startTime,
			});
		case "solid":
			return {
				...buildGraphicElement({ definitionId: "rectangle", name, startTime, params: { fill: SOLID_FILL } }),
				duration,
			};
		case "null":
			return { ...buildGraphicElement({ definitionId: NULL_GRAPHIC_DEFINITION_ID, name, startTime }), duration };
		case "image":
			return buildElementFromMedia({ mediaId, mediaType: "image", name, duration, startTime });
	}
}

function withParams({
	element,
	params,
}: {
	element: CreateTimelineElement;
	params: Record<string, number | boolean>;
}): CreateTimelineElement {
	return { ...element, params: { ...element.params, ...params } };
}

/**
 * The elements Track Camera's "Create ..." items add (AE behaviour), placed
 * with {@link placeLayerOnTarget} through the camera of `args.frame`:
 * - one layer on the target, spanning the tracked clip;
 * - with `multiple`, one layer per selected point (at the point, oriented
 *   like the target, sized from it), in/out trimmed to the point's tracked
 *   lifetime; numbered names;
 * - a camera spanning the clip when no camera of this clip covers it
 *   (`kind: null` = camera only, refused when one exists).
 * `contentSize` measures a layer's local content (its canvas size at 2D
 * scale 1). Pure: nothing is written.
 */
export function planTrackedLayers({
	tracks,
	clip,
	data,
	solve,
	featureTracks,
	args,
	imageMedia,
	contentSize,
}: {
	tracks: SceneTracks;
	clip: VideoElement;
	data: CameraTrackerData;
	solve: CameraSolve | null;
	featureTracks: FeatureTracks | null;
	args: CreateTrackedLayersArgs;
	imageMedia: { id: string; name: string } | null;
	contentSize: ({ element }: { element: CreateTimelineElement }) => { width: number; height: number } | null;
}): PlannedLayers {
	const needsCamera = !hasCoveringCamera({ tracks, clip });
	const camera = needsCamera
		? buildCameraElement({ sourceElementId: clip.id, startTime: clip.startTime, duration: clip.duration })
		: null;
	if (args.kind === null) {
		return camera
			? { status: "planned", layers: [], camera }
			: { status: "failed", message: CREATE_LAYER_MESSAGES.cameraExists };
	}
	const kind = args.kind;
	if (!solve || solve.cameras.length === 0) return { status: "failed", message: CREATE_LAYER_MESSAGES.noSolve };
	const target = args.target;
	if (!target) return { status: "failed", message: CREATE_LAYER_MESSAGES.noTarget };
	if (kind === "image" && !imageMedia) return { status: "failed", message: CREATE_LAYER_MESSAGES.noImage };
	const frame = Number.isFinite(args.frame) ? Math.round(args.frame) : 0;
	const view = solve.cameras[Math.min(solve.cameras.length - 1, Math.max(0, frame))];
	const prefix = NAME_PREFIX[kind];
	let number = nextLayerNumber({ tracks, prefix });
	const mediaId = imageMedia?.id ?? "";
	const name = () => `${prefix} ${number++}`;

	const probe = buildBase({ kind, name: prefix, startTime: clip.startTime, duration: clip.duration, mediaId });
	const size = contentSize({ element: probe });
	if (!size) return { status: "failed", message: CREATE_LAYER_MESSAGES.noContent };

	const place = ({ on, startTime, duration }: { on: Target; startTime: MediaTime; duration: MediaTime }) => {
		const transform = placeLayerOnTarget({ target: on, camera: view, contentSize: size });
		if (!transform) return null;
		return withParams({
			element: buildBase({ kind, name: name(), startTime, duration, mediaId }),
			params: paramsFromTransform3D(transform),
		});
	};

	if (!args.multiple) {
		const layer = place({ on: target, startTime: clip.startTime, duration: clip.duration });
		if (!layer) return { status: "failed", message: CREATE_LAYER_MESSAGES.badTarget };
		return { status: "planned", layers: [layer], camera };
	}

	const deleted = new Set(data.deletedTrackIds);
	const points = new Map(solve.points.map((point) => [point.trackId, point]));
	const clipEnd = clip.startTime + clip.duration;
	const layers: CreateTimelineElement[] = [];
	for (const trackId of new Set(args.trackIds)) {
		const point = points.get(trackId);
		if (!point || deleted.has(trackId) || !featureTracks || trackId >= featureTracks.trackStart.length) continue;
		const first = featureTracks.trackStart[trackId];
		const startTicks = Math.max(clip.startTime, timelineTicksOfFrame({ clip, data, frame: first }));
		const endTicks = Math.min(
			clipEnd,
			timelineTicksOfFrame({ clip, data, frame: first + featureTracks.trackLen[trackId] }),
		);
		const startTime = roundMediaTime({ time: startTicks });
		const duration = roundMediaTime({ time: endTicks - startTime });
		if (duration <= 0) continue;
		const layer = place({
			on: { center: point.position, normal: target.normal, radius: target.radius },
			startTime,
			duration,
		});
		if (layer) layers.push(layer);
	}
	if (layers.length === 0) return { status: "failed", message: CREATE_LAYER_MESSAGES.noPoints };
	return { status: "planned", layers, camera };
}
