import { afterEach, describe, expect, test } from "bun:test";
import { layerToWorld, projectToFrame } from "@/scene3d/camera";
import { LAYER_3D_ENABLED_KEY, transform3DFromParams } from "@/scene3d/layer-params";
import type { CameraState, Target, Vec3 } from "@/scene3d/types";
import type { SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { packSolve, packTracks } from "@/tracking/camera3d/codec";
import { DEFAULT_CAMERA_TRACKER_SETTINGS, type CameraSolve, type CameraTrackerData } from "@/tracking/camera3d/types";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { CREATE_LAYER_MESSAGES, SOLID_FILL } from "../create-layers";
import { CAMERA_TRACKER_MESSAGES } from "../engine";
import { applyGroundPlane } from "../tracker-tracks";
import {
	cameraLayer,
	cameraTrack,
	listElements,
	sceneOf,
	sec,
	textLayer,
	textTrack,
	videoClip,
} from "./editor-harness";
import { CLIP_MEDIA, engineHarness, type EngineHarness } from "./engine-harness";
import { buildTracks, cameraAt, FRAME, trackerData } from "./fixtures";

let current: EngineHarness | null = null;
afterEach(() => {
	current?.dispose();
	current = null;
});

function start(options: Parameters<typeof engineHarness>[0] = {}): EngineHarness {
	current = engineHarness(options);
	return current;
}

function tracksOf(h: EngineHarness): SceneTracks {
	return h.editor.state.tracks;
}

function clipData({ h, id = "clip" }: { h: EngineHarness; id?: string }): CameraTrackerData | undefined {
	const clip = listElements({ tracks: tracksOf(h) }).find((entry) => entry.element.id === id)?.element;
	return clip?.type === "video" ? clip.cameraTracker : undefined;
}

function elementById({ h, id }: { h: EngineHarness; id: string }): TimelineElement {
	const found = listElements({ tracks: tracksOf(h) }).find((entry) => entry.element.id === id)?.element;
	if (!found) throw new Error(`no ${id}`);
	return found;
}

function trackedScene({ data = trackerData(), extra = [] }: { data?: CameraTrackerData; extra?: VideoElement[] } = {}) {
	return sceneOf({ main: [videoClip({ extra: { cameraTracker: data } }), ...extra] });
}

describe("updateSettings", () => {
	test("a solve setting marks the solve stale, in one undo step", () => {
		const h = start({ tracks: trackedScene() });
		const before = tracksOf(h);
		h.engine.updateSettings({ elementId: "clip", patch: { shotType: "variable-zoom" } });
		expect(clipData({ h })?.settings.shotType).toBe("variable-zoom");
		expect(clipData({ h })?.stale).toBe("solve");
		h.editor.editor.command.undo();
		expect(tracksOf(h)).toBe(before);
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});

	test("Detailed Analysis marks the analysis stale; display settings change nothing else", () => {
		const h = start({ tracks: trackedScene() });
		h.engine.updateSettings({ elementId: "clip", patch: { trackPointSize: 150, renderTrackPoints: true } });
		expect(clipData({ h })).toMatchObject({ stale: "none", settings: { trackPointSize: 150, renderTrackPoints: true } });
		h.engine.updateSettings({ elementId: "clip", patch: { detailedAnalysis: true } });
		expect(clipData({ h })?.stale).toBe("analysis");
		h.engine.updateSettings({ elementId: "clip", patch: { solveMethod: "typical" } });
		expect(clipData({ h })?.stale).toBe("analysis");
	});

	test("no change, invalid values and unknown keys write nothing; numbers are clamped", () => {
		const h = start({ tracks: trackedScene() });
		const before = tracksOf(h);
		h.engine.updateSettings({ elementId: "clip", patch: { shotType: DEFAULT_CAMERA_TRACKER_SETTINGS.shotType } });
		h.engine.updateSettings({ elementId: "clip", patch: JSON.parse('{"shotType":"dolly","targetSize":null,"x":1}') });
		h.engine.updateSettings({ elementId: "clip", patch: { horizontalAngleOfViewDeg: Number.NaN } });
		h.engine.updateSettings({ elementId: "missing", patch: { shotType: "variable-zoom" } });
		expect(tracksOf(h)).toBe(before);
		expect(h.editor.editor.command.canUndo()).toBe(false);
		h.engine.updateSettings({ elementId: "clip", patch: { targetSize: 1e6 } });
		expect(clipData({ h })?.settings.targetSize).toBe(1000);
	});

	test("before a first track the settings wait in the session (no undo step)", () => {
		const h = start({ tracks: sceneOf() });
		const before = tracksOf(h);
		h.engine.updateSettings({ elementId: "clip", patch: { detailedAnalysis: true } });
		expect(tracksOf(h)).toBe(before);
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});
});

describe("deletePoints", () => {
	test("one undo step; nothing new is no step", () => {
		const h = start({ tracks: trackedScene() });
		h.engine.deletePoints({ elementId: "clip", trackIds: [2, 0] });
		expect(clipData({ h })).toMatchObject({ deletedTrackIds: [0, 2], stale: "solve" });
		h.engine.deletePoints({ elementId: "clip", trackIds: [2] });
		h.engine.deletePoints({ elementId: "missing", trackIds: [2] });
		h.editor.editor.command.undo();
		expect(clipData({ h })?.deletedTrackIds).toEqual([]);
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});
});

describe("setGroundPlane", () => {
	test("uses the camera of the analysis frame under the playhead; one undo step", () => {
		const data = trackerData({ frameCount: 8 });
		const h = start({ tracks: trackedScene({ data }) });
		h.editor.state.playhead = mediaTimeFromSeconds({ seconds: 4 / 30 });
		const before = tracksOf(h);
		const target: Target = { center: [10, 0, 260], normal: [0, -1, 0], radius: 30 };
		h.engine.setGroundPlane({ elementId: "clip", target });
		const expected = applyGroundPlane({ tracks: before, elementId: "clip", target, frame: 4 });
		expect(tracksOf(h)).toEqual(expected);
		expect(clipData({ h })?.groundPlaneSet).toBe(true);
		h.editor.editor.command.undo();
		expect(tracksOf(h)).toBe(before);
	});

	test("without a solve or with a bad target nothing happens and nothing throws", () => {
		const h = start({ tracks: trackedScene({ data: trackerData({ overrides: { solve: null } }) }) });
		const before = tracksOf(h);
		const target: Target = { center: [0, 0, 0], normal: [0, -1, 0], radius: 3 };
		h.engine.setGroundPlane({ elementId: "clip", target });
		h.engine.setGroundPlane({ elementId: "missing", target });
		expect(tracksOf(h)).toBe(before);
		const solved = start({ tracks: trackedScene() });
		const unchanged = tracksOf(solved);
		solved.engine.setGroundPlane({ elementId: "clip", target: { ...target, normal: [0, 0, 0] } });
		expect(tracksOf(solved)).toBe(unchanged);
	});
});

/**
 * 30 analysis frames (1 s); track 0 lives all along, track 1 on frames
 * 10..14, track 2 on 20..29; a camera walking past points on a wall.
 */
function lifetimeData(): CameraTrackerData {
	const cameras: CameraState[] = Array.from({ length: 30 }, (_, i) =>
		cameraAt({ position: [i * 5, -100, -1200], yawDeg: 3, pitchDeg: -5 }),
	);
	const solve: CameraSolve = {
		frameWidth: FRAME.width,
		frameHeight: FRAME.height,
		cameras,
		solved: new Uint8Array(30).fill(1),
		points: [
			{ trackId: 0, position: [0, -50, 400], error: 0.2 },
			{ trackId: 1, position: [120, -80, 400], error: 0.2 },
			{ trackId: 2, position: [-90, -30, 400], error: 0.2 },
		],
		methodUsed: "typical",
		averageError: 0.2,
		notices: [],
	};
	const tracks = buildTracks({
		frameCount: 30,
		tracks: [
			{ start: 0, samples: Array.from({ length: 30 }, () => [100, 100]) },
			{ start: 10, samples: Array.from({ length: 5 }, () => [200, 100]) },
			{ start: 20, samples: Array.from({ length: 10 }, () => [300, 100]) },
		],
	});
	return {
		...trackerData(),
		tracks: packTracks(tracks),
		solve: packSolve(solve),
	};
}

const WALL: Target = { center: [10, -60, 400], normal: [0, 0, -1], radius: 50 };

function projectedCentre({ element, camera }: { element: TimelineElement; camera: CameraState }) {
	const transform = transform3DFromParams((key) => element.params[key]);
	if (!transform) throw new Error("not 3D");
	const at = (point: Vec3) => projectToFrame({ camera, frameWidth: FRAME.width, frameHeight: FRAME.height, point });
	return { layer: at(layerToWorld({ transform, local: [0, 0, 0] })), transform };
}

describe("createLayers", () => {
	function createScene({ data = lifetimeData(), overlay = [] }: { data?: CameraTrackerData; overlay?: SceneTracks["overlay"] } = {}) {
		return sceneOf({ main: [videoClip({ start: 2, duration: 1, extra: { cameraTracker: data } })], overlay });
	}

	test("Create Text and Camera: a 3D text on the target spanning the clip, a camera above, one undo step", () => {
		const h = start({ tracks: createScene() });
		const before = tracksOf(h);
		const outcome = h.engine.createLayers({ elementId: "clip", kind: "text", multiple: false, target: WALL, trackIds: [], frame: 12 });
		if (outcome.status !== "created") throw new Error(outcome.message);
		expect(outcome.elementIds).toHaveLength(1);
		const text = elementById({ h, id: outcome.elementIds[0] });
		expect(text).toMatchObject({ type: "text", name: "Track Text 1", startTime: sec(2), duration: sec(1) });
		expect(text.params.content).toBe("Text");
		expect(text.params[LAYER_3D_ENABLED_KEY]).toBe(true);
		const camera = lifetimeDataCamera({ frame: 12 });
		const { layer, transform } = projectedCentre({ element: text, camera });
		const target = projectToFrame({ camera, frameWidth: FRAME.width, frameHeight: FRAME.height, point: WALL.center });
		expect(Math.hypot((layer?.x ?? 0) - (target?.x ?? 1), (layer?.y ?? 0) - (target?.y ?? 1))).toBeLessThan(1e-6);
		// measured text 300 x 80 (harness): the larger side spans the target's diameter
		expect(transform.scale[0]).toBeCloseTo(100 / 300, 12);
		expect(elementById({ h, id: outcome.cameraElementId ?? "" })).toMatchObject({
			type: "camera",
			sourceElementId: "clip",
			startTime: sec(2),
			duration: sec(1),
		});
		expect(tracksOf(h).overlay[0].type).toBe("camera");
		h.editor.editor.command.undo();
		expect(tracksOf(h)).toBe(before);
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});

	test("Create Solid / Null when the clip already has a camera: no second camera, graphic sized from the canvas", () => {
		const h = start({ tracks: createScene({ overlay: [cameraTrack({ elements: [cameraLayer({ start: 1, duration: 3 })] })] }) });
		const solid = h.engine.createLayers({ elementId: "clip", kind: "solid", multiple: false, target: WALL, trackIds: [], frame: 0 });
		const nul = h.engine.createLayers({ elementId: "clip", kind: "null", multiple: false, target: WALL, trackIds: [], frame: 0 });
		if (solid.status !== "created" || nul.status !== "created") throw new Error("not created");
		expect(solid.cameraElementId).toBeNull();
		expect(nul.cameraElementId).toBeNull();
		const solidElement = elementById({ h, id: solid.elementIds[0] });
		expect(solidElement).toMatchObject({ type: "graphic", definitionId: "rectangle", name: "Track Solid 1" });
		expect(solidElement.params.fill).toBe(SOLID_FILL);
		// a graphic is a square source fitted to the 1920 x 1080 canvas: 1080 px
		expect(transform3DFromParams((key) => solidElement.params[key])?.scale[0]).toBeCloseTo(100 / 1080, 12);
		expect(elementById({ h, id: nul.elementIds[0] })).toMatchObject({ type: "graphic", definitionId: "null", name: "Track Null 1" });
		expect(listElements({ tracks: tracksOf(h) }).filter((entry) => entry.element.type === "camera")).toHaveLength(1);
	});

	test("Create Multiple: one layer per point at the point, trimmed to its tracked lifetime, numbered after existing names", () => {
		const h = start({ tracks: createScene({ overlay: [textTrack({ elements: [{ ...textLayer(), name: "Track Text 4" }] })] }) });
		const outcome = h.engine.createLayers({
			elementId: "clip",
			kind: "text",
			multiple: true,
			target: WALL,
			trackIds: [1, 2, 2, 77],
			frame: 12,
		});
		if (outcome.status !== "created") throw new Error(outcome.message);
		const created = outcome.elementIds.map((id) => elementById({ h, id }));
		expect(created.map((element) => element.name)).toEqual(["Track Text 5", "Track Text 6"]);
		// frames 10..15 and 20..30 of an analysis that starts with the clip at 2 s
		const ticks = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);
		const startOf = (element: TimelineElement): number => element.startTime;
		expect(startOf(created[0])).toBe(ticks(2 + 10 / 30));
		expect(created[0].startTime + created[0].duration).toBe(ticks(2 + 15 / 30));
		expect(startOf(created[1])).toBe(ticks(2 + 20 / 30));
		expect(created[1].startTime + created[1].duration).toBe(ticks(3));
		const position = transform3DFromParams((key) => created[0].params[key])?.position;
		expect(position).toEqual([120, -80, 400]);
	});

	test("Create Multiple skips deleted points and fails when none is left", () => {
		const h = start({ tracks: createScene({ data: { ...lifetimeData(), deletedTrackIds: [1] } }) });
		expect(
			h.engine.createLayers({ elementId: "clip", kind: "null", multiple: true, target: WALL, trackIds: [1], frame: 0 }),
		).toEqual({ status: "failed", message: CREATE_LAYER_MESSAGES.noPoints });
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});

	test("Create Image needs an image from the media library and is sized from it", () => {
		const h = start({
			tracks: createScene(),
			media: {
				"media-clip": CLIP_MEDIA,
				photo: { file: new File([], "p.png"), type: "image", name: "p.png", width: 4000, height: 3000 },
			},
		});
		expect(
			h.engine.createLayers({ elementId: "clip", kind: "image", multiple: false, target: WALL, trackIds: [], frame: 0 }),
		).toEqual({ status: "failed", message: CREATE_LAYER_MESSAGES.noImage });
		expect(
			h.engine.createLayers({ elementId: "clip", kind: "image", multiple: false, target: WALL, trackIds: [], frame: 0, mediaId: "media-clip" }),
		).toEqual({ status: "failed", message: CREATE_LAYER_MESSAGES.noImage });
		const outcome = h.engine.createLayers({
			elementId: "clip",
			kind: "image",
			multiple: false,
			target: WALL,
			trackIds: [],
			frame: 0,
			mediaId: "photo",
		});
		if (outcome.status !== "created") throw new Error(outcome.message);
		const image = elementById({ h, id: outcome.elementIds[0] });
		expect(image).toMatchObject({ type: "image", mediaId: "photo" });
		// 4000 x 3000 contain-fitted to 1920 x 1080 is 1440 x 1080
		expect(transform3DFromParams((key) => image.params[key])?.scale[0]).toBeCloseTo(100 / 1440, 12);
	});

	test("Create Camera alone; refused when the clip already has one", () => {
		const h = start({ tracks: createScene() });
		const first = h.engine.createLayers({ elementId: "clip", kind: null, multiple: false, target: null, trackIds: [], frame: 0 });
		expect(first).toMatchObject({ status: "created", elementIds: [] });
		expect(
			h.engine.createLayers({ elementId: "clip", kind: null, multiple: false, target: null, trackIds: [], frame: 0 }),
		).toEqual({ status: "failed", message: CREATE_LAYER_MESSAGES.cameraExists });
	});

	test("refusals: no target, no solve, no data, no clip", () => {
		const h = start({
			tracks: sceneOf({
				main: [
					videoClip({ extra: { cameraTracker: { ...lifetimeData(), solve: null } } }),
					videoClip({ id: "plain", start: 5 }),
				],
			}),
		});
		const args = { kind: "text" as const, multiple: false, target: WALL, trackIds: [], frame: 0 };
		expect(h.engine.createLayers({ ...args, elementId: "clip", target: null })).toMatchObject({ status: "failed" });
		expect(h.engine.createLayers({ ...args, elementId: "clip" })).toEqual({ status: "failed", message: CREATE_LAYER_MESSAGES.noSolve });
		expect(h.engine.createLayers({ ...args, elementId: "plain" })).toEqual({
			status: "failed",
			message: CAMERA_TRACKER_MESSAGES.noAnalysis,
		});
		expect(h.engine.createLayers({ ...args, elementId: "gone" })).toEqual({
			status: "failed",
			message: CAMERA_TRACKER_MESSAGES.clipMissing,
		});
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});
});

function lifetimeDataCamera({ frame }: { frame: number }): CameraState {
	return cameraAt({ position: [frame * 5, -100, -1200], yawDeg: 3, pitchDeg: -5 });
}

describe("decoded", () => {
	test("decodes once per stored object, per clip; null without data", () => {
		const shared = trackerData();
		const h = start({ tracks: trackedScene({ data: shared, extra: [videoClip({ id: "copy", start: 5, extra: { cameraTracker: shared } }), videoClip({ id: "plain", start: 9 })] }) });
		const first = h.engine.decoded({ elementId: "clip" });
		expect(first).not.toBeNull();
		expect(h.engine.decoded({ elementId: "clip" })).toBe(first);
		expect(first?.tracks?.frameCount).toBe(6);
		expect(first?.solve?.cameras).toHaveLength(6);
		// a duplicated clip shares the stored object but is its own element
		expect(h.engine.decoded({ elementId: "copy" })?.elementId).toBe("copy");
		expect(h.engine.decoded({ elementId: "plain" })).toBeNull();
		h.engine.deletePoints({ elementId: "clip", trackIds: [3] });
		const after = h.engine.decoded({ elementId: "clip" });
		expect(after).not.toBe(first);
		expect([...(after?.deleted ?? [])]).toEqual([3]);
	});
});

describe("session pruning", () => {
	test("a deleted clip's outcome is forgotten, another clip's stays", async () => {
		const h = start({
			tracks: sceneOf({ main: [videoClip({ duration: 0.2 }), videoClip({ id: "other", start: 3 })] }),
			media: { "media-clip": { ...CLIP_MEDIA, file: null } },
		});
		await h.engine.trackCamera({ elementId: "clip" });
		await h.engine.trackCamera({ elementId: "other" });
		const { useCameraTrackerSession } = await import("@/tracking/camera3d/session");
		expect(Object.keys(useCameraTrackerSession.getState().outcomes).sort()).toEqual(["clip", "other"]);
		h.engine.prune({ mediaIdOf: (id) => (id === "other" ? "media-clip" : null) });
		expect(Object.keys(useCameraTrackerSession.getState().outcomes)).toEqual(["other"]);
		h.engine.clearSession();
		expect(useCameraTrackerSession.getState().outcomes).toEqual({});
	});

	test("settings chosen before a first track are dropped when the clip gets other media", async () => {
		const h = start({ tracks: sceneOf({ main: [videoClip({ duration: 0.2 })] }) });
		h.engine.updateSettings({ elementId: "clip", patch: { solveMethod: "tripod-pan" } });
		h.engine.prune({ mediaIdOf: () => "replaced-media" });
		await h.engine.trackCamera({ elementId: "clip" });
		expect(h.solveCalls[0].input.settings.solveMethod).toBe("auto");
	});
});
