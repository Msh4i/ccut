import { afterEach, describe, expect, test } from "bun:test";
import { layerToWorld, projectToFrame } from "@/scene3d/camera";
import { paramsFromTransform3D, transform3DFromParams } from "@/scene3d/layer-params";
import type { CameraState, Transform3D, Vec3 } from "@/scene3d/types";
import type { CameraElement, CreateTimelineElement, SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { buildCameraElement, buildGraphicElement, buildTextElement } from "@/timeline/element-utils";
import { DEFAULTS } from "@/timeline/defaults";
import { unpackSolve } from "@/tracking/camera3d/codec";
import type { CameraTrackerData } from "@/tracking/camera3d/types";
import {
	cameraLayer,
	cameraTrack,
	createEditorHarness,
	listElements,
	sceneOf,
	sec,
	textLayer,
	textTrack,
	videoClip,
	type EditorHarness,
} from "@/tracking/camera3d/engine/__tests__/editor-harness";
import { FRAME, trackerData } from "@/tracking/camera3d/engine/__tests__/fixtures";

let harness: EditorHarness | null = null;
afterEach(() => {
	harness?.restore();
	harness = null;
});

function start({ tracks }: { tracks: SceneTracks }): EditorHarness {
	harness = createEditorHarness({ tracks });
	return harness;
}

function clipOf({ tracks, id = "clip" }: { tracks: SceneTracks; id?: string }): VideoElement {
	const found = listElements({ tracks }).find((entry) => entry.element.id === id)?.element;
	if (!found || found.type !== "video") throw new Error(`no video ${id}`);
	return found;
}

function elementOf({ tracks, id }: { tracks: SceneTracks; id: string }): TimelineElement {
	const found = listElements({ tracks }).find((entry) => entry.element.id === id)?.element;
	if (!found) throw new Error(`no element ${id}`);
	return found;
}

/** Undo gives back the very tracks object of before; redo the very state of after (deep). */
function expectOneUndoStep({
	h,
	before,
	run,
}: {
	h: EditorHarness;
	before: SceneTracks;
	run: () => void;
}): SceneTracks {
	const history = h.editor.command.canUndo();
	expect(history).toBe(false);
	run();
	const after = h.state.tracks;
	expect(after).not.toBe(before);
	h.editor.command.undo();
	expect(h.state.tracks).toBe(before);
	expect(h.editor.command.canUndo()).toBe(false);
	h.editor.command.redo();
	expect(h.state.tracks).toEqual(after);
	return h.state.tracks;
}

describe("SetCameraTrackerCommand", () => {
	test("writes the tracker data in one undo step; undo restores the clip as it was", () => {
		const h = start({ tracks: sceneOf() });
		const before = h.state.tracks;
		const data = trackerData();
		const after = expectOneUndoStep({
			h,
			before,
			run: () => h.editor.timeline.setCameraTracker({ elementId: "clip", data }),
		});
		expect(clipOf({ tracks: after }).cameraTracker).toEqual(data);
	});

	test("null removes the field", () => {
		const h = start({ tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: trackerData() } })] }) });
		const before = h.state.tracks;
		const after = expectOneUndoStep({
			h,
			before,
			run: () => h.editor.timeline.setCameraTracker({ elementId: "clip", data: null }),
		});
		expect("cameraTracker" in clipOf({ tracks: after })).toBe(false);
	});

	test("a missing clip or a non-video element is refused: nothing written, no undo step", () => {
		const h = start({ tracks: sceneOf({ overlay: [textTrack({ elements: [textLayer()] })] }) });
		const before = h.state.tracks;
		expect(() => h.editor.timeline.setCameraTracker({ elementId: "nope", data: trackerData() })).toThrow();
		expect(() => h.editor.timeline.setCameraTracker({ elementId: "text", data: trackerData() })).toThrow();
		expect(h.state.tracks).toBe(before);
		expect(h.editor.command.canUndo()).toBe(false);
	});

	test("a clip on an overlay video track is found too", () => {
		const overlayVideo = { id: "ov", name: "ov", type: "video" as const, muted: false, hidden: false, elements: [videoClip({ id: "top" })] };
		const h = start({ tracks: sceneOf({ overlay: [overlayVideo] }) });
		h.editor.timeline.setCameraTracker({ elementId: "top", data: trackerData() });
		expect(clipOf({ tracks: h.state.tracks, id: "top" }).cameraTracker).toBeDefined();
	});
});

describe("DeleteTrackPointsCommand", () => {
	test("adds the ids (sorted, once), marks the solve stale, one undo step", () => {
		const data = trackerData({ overrides: { deletedTrackIds: [5] } });
		const h = start({ tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: data } })] }) });
		const before = h.state.tracks;
		const after = expectOneUndoStep({
			h,
			before,
			run: () => {
				expect(h.editor.timeline.deleteTrackPoints({ elementId: "clip", trackIds: [3, 1, 5, 3, 99, -1, 1.5] })).toBe(true);
			},
		});
		const next = clipOf({ tracks: after }).cameraTracker;
		expect(next?.deletedTrackIds).toEqual([1, 3, 5]);
		expect(next?.stale).toBe("solve");
		expect(next?.solve).toEqual(data.solve);
	});

	test("an analysis-stale record stays analysis-stale", () => {
		const data = trackerData({ overrides: { stale: "analysis" } });
		const h = start({ tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: data } })] }) });
		h.editor.timeline.deleteTrackPoints({ elementId: "clip", trackIds: [0] });
		expect(clipOf({ tracks: h.state.tracks }).cameraTracker?.stale).toBe("analysis");
	});

	test("nothing new to delete: no command, no undo step", () => {
		const data = trackerData({ overrides: { deletedTrackIds: [2] } });
		const h = start({ tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: data } })] }) });
		const before = h.state.tracks;
		expect(h.editor.timeline.deleteTrackPoints({ elementId: "clip", trackIds: [2, 1000] })).toBe(false);
		expect(h.editor.timeline.deleteTrackPoints({ elementId: "nope", trackIds: [1] })).toBe(false);
		expect(h.state.tracks).toBe(before);
		expect(h.editor.command.canUndo()).toBe(false);
	});
});

const LAYER: Transform3D = {
	position: [40, -60, 500],
	orientationDeg: [10, -25, 5],
	rotationDeg: [0, 0, 30],
	scale: [0.3, 0.3, 0.3],
};

function projectedCorners({ camera, transform }: { camera: CameraState; transform: Transform3D }): Array<{ x: number; y: number }> {
	return (
		[
			[-200, -80, 0],
			[200, -80, 0],
			[200, 80, 0],
			[-200, 80, 0],
		] satisfies Vec3[]
	).map((local) => {
		const p = projectToFrame({
			camera,
			frameWidth: FRAME.width,
			frameHeight: FRAME.height,
			point: layerToWorld({ transform, local }),
		});
		if (!p) throw new Error("behind");
		return p;
	});
}

describe("SetGroundPlaneCommand", () => {
	function groundScene(): SceneTracks {
		return sceneOf({
			main: [videoClip({ extra: { cameraTracker: trackerData({ frameCount: 8 }) } })],
			overlay: [
				cameraTrack({ elements: [cameraLayer({ sourceElementId: "clip" })] }),
				textTrack({
					elements: [
						textLayer({ id: "seen", start: 1, duration: 2, params: paramsFromTransform3D(LAYER) }),
						textLayer({ id: "after", start: 6, duration: 2, params: paramsFromTransform3D(LAYER) }),
					],
				}),
			],
		});
	}

	test("re-bases the solve and the layers seen through the clip's camera; nothing moves on screen", () => {
		const h = start({ tracks: groundScene() });
		const before = h.state.tracks;
		const target = { center: [20, 0, 250] satisfies Vec3, normal: [0, -1, 0] satisfies Vec3, radius: 40 };
		const after = expectOneUndoStep({
			h,
			before,
			run: () => h.editor.timeline.setGroundPlane({ elementId: "clip", target, frame: 3 }),
		});
		const oldData = clipOf({ tracks: before }).cameraTracker;
		const newData = clipOf({ tracks: after }).cameraTracker;
		if (!oldData?.solve || !newData?.solve) throw new Error("no solve");
		expect(newData.groundPlaneSet).toBe(true);
		expect(newData.tracks).toBe(oldData.tracks);
		const oldSolve = unpackSolve(oldData.solve);
		const newSolve = unpackSolve(newData.solve);
		if (!oldSolve || !newSolve) throw new Error("bad solve");
		const layerAfter = transform3DFromParams((key) => elementOf({ tracks: after, id: "seen" }).params[key]);
		if (!layerAfter) throw new Error("not 3D any more");
		let worst = 0;
		oldSolve.cameras.forEach((camera, frame) => {
			const a = projectedCorners({ camera, transform: LAYER });
			const b = projectedCorners({ camera: newSolve.cameras[frame], transform: layerAfter });
			a.forEach((p, k) => {
				worst = Math.max(worst, Math.hypot(p.x - b[k].x, p.y - b[k].y));
			});
		});
		// the stored solve is Float32: the round trip costs well under a hundredth of a pixel
		expect(worst).toBeLessThan(0.01);
		// a 3D layer that is not under this clip's camera is left alone
		expect(elementOf({ tracks: after, id: "after" })).toBe(elementOf({ tracks: before, id: "after" }));
	});

	test("without a solve, or with a degenerate target, nothing is written", () => {
		const h = start({
			tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: trackerData({ overrides: { solve: null } }) } })] }),
		});
		const before = h.state.tracks;
		const target = { center: [0, 0, 0] satisfies Vec3, normal: [0, -1, 0] satisfies Vec3, radius: 1 };
		expect(() => h.editor.timeline.setGroundPlane({ elementId: "clip", target, frame: 0 })).toThrow();
		expect(() =>
			h.editor.timeline.setGroundPlane({ elementId: "clip", target: { ...target, normal: [0, 0, 0] }, frame: 0 }),
		).toThrow();
		expect(h.state.tracks).toBe(before);
		expect(h.editor.command.canUndo()).toBe(false);
	});
});

describe("CreateTrackedLayersCommand", () => {
	const placed = paramsFromTransform3D(LAYER);

	function layers(): CreateTimelineElement[] {
		const text = buildTextElement({ raw: { ...DEFAULTS.text.element, name: "Track Text 1" }, startTime: sec(0) });
		const solid = buildGraphicElement({ definitionId: "rectangle", name: "Track Solid 1", startTime: sec(1), params: placed });
		return [
			{ ...text, duration: sec(4), params: { ...text.params, ...placed, content: "Text" } },
			{ ...solid, duration: sec(2) },
		];
	}

	test("adds the layers on new tracks at the top and a camera above them, in one undo step", () => {
		const h = start({ tracks: sceneOf({ overlay: [textTrack({ elements: [textLayer()] })] }) });
		const before = h.state.tracks;
		let created: { elementIds: string[]; cameraElementId: string | null } = { elementIds: [], cameraElementId: null };
		const camera = buildCameraElement({ sourceElementId: "clip", startTime: sec(0), duration: sec(4) });
		const after = expectOneUndoStep({
			h,
			before,
			run: () => {
				created = h.editor.timeline.createTrackedLayers({ layers: layers(), camera });
			},
		});
		expect(created.elementIds).toHaveLength(2);
		expect(created.cameraElementId).not.toBeNull();
		expect(after.overlay.map((track) => track.type)).toEqual(["camera", "text", "graphic", "text"]);
		const cameraElement = after.overlay[0].elements[0];
		expect(cameraElement).toMatchObject({ id: created.cameraElementId, type: "camera", sourceElementId: "clip" });
		expect(after.overlay[1].elements[0]).toMatchObject({ id: created.elementIds[0], type: "text", params: { content: "Text" } });
		expect(after.overlay[2].elements[0]).toMatchObject({ id: created.elementIds[1], type: "graphic", definitionId: "rectangle" });
		// the existing track and its element are untouched
		expect(after.overlay[3]).toBe(before.overlay[0]);
		// redo brings back the same ids (selection and later commands refer to them)
		expect(listElements({ tracks: h.state.tracks }).map((entry) => entry.element.id)).toEqual(
			listElements({ tracks: after }).map((entry) => entry.element.id),
		);
	});

	test("layers that do not overlap share a new track", () => {
		const h = start({ tracks: sceneOf() });
		const text = buildTextElement({ raw: DEFAULTS.text.element, startTime: sec(0) });
		const many: CreateTimelineElement[] = [0, 1, 2].map((i) => ({
			...text,
			name: `x${i}`,
			startTime: sec(i * 2),
			duration: sec(i === 0 ? 3 : 1),
		}));
		h.editor.timeline.createTrackedLayers({ layers: many, camera: null });
		// x0 spans 0..3 and x1 2..3 overlap; x2 at 4..5 fits under x0
		expect(h.state.tracks.overlay.map((track) => track.elements.length)).toEqual([2, 1]);
	});

	test("camera only (AE Create Camera)", () => {
		const h = start({ tracks: sceneOf() });
		const result = h.editor.timeline.createTrackedLayers({
			layers: [],
			camera: buildCameraElement({ sourceElementId: "clip", startTime: sec(0), duration: sec(4) }),
		});
		expect(result.elementIds).toEqual([]);
		const cameras = listElements({ tracks: h.state.tracks }).filter((entry): entry is typeof entry & { element: CameraElement } => entry.element.type === "camera");
		expect(cameras.map((entry) => entry.element.id)).toEqual([result.cameraElementId ?? ""]);
	});

	test("an element that cannot be placed refuses the whole command", () => {
		const h = start({ tracks: sceneOf() });
		const before = h.state.tracks;
		const audio: CreateTimelineElement = {
			type: "audio",
			sourceType: "library",
			sourceUrl: "x",
			name: "a",
			startTime: sec(0),
			duration: sec(1),
			trimStart: sec(0),
			trimEnd: sec(0),
			params: {},
		};
		expect(() => h.editor.timeline.createTrackedLayers({ layers: [audio], camera: null })).toThrow();
		expect(() => h.editor.timeline.createTrackedLayers({ layers: [], camera: null })).toThrow();
		expect(h.state.tracks).toBe(before);
		expect(h.editor.command.canUndo()).toBe(false);
	});
});

describe("tracker data the commands write is what load accepts", () => {
	test("delete + ground plane results pass normalizeCameraTracker", async () => {
		const { normalizeCameraTracker } = await import("@/tracking/camera3d/engine/normalize");
		const h = start({
			tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: trackerData({ frameCount: 8 }) } })] }),
		});
		h.editor.timeline.deleteTrackPoints({ elementId: "clip", trackIds: [0, 7] });
		h.editor.timeline.setGroundPlane({
			elementId: "clip",
			target: { center: [0, 0, 300], normal: [0, -1, 0], radius: 30 },
			frame: 100,
		});
		const data: CameraTrackerData | undefined = clipOf({ tracks: h.state.tracks }).cameraTracker;
		expect(data).toBeDefined();
		expect(normalizeCameraTracker(JSON.parse(JSON.stringify(data)))).toEqual(data);
	});
});
