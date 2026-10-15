import { afterEach, describe, expect, test } from "bun:test";
import { activeCameraAt, analysisFrameAt, trackedViewCamera } from "@/scene3d/render/active-camera";
import { trackPointsAt } from "@/scene3d/render/solved-points";
import {
	cameraElement,
	cameraTrack as renderCameraTrack,
	sceneTracks as renderSceneTracks,
	seconds,
	videoElement as renderVideoElement,
} from "@/scene3d/render/__tests__/fixtures";
import type { TimelineElement, VideoElement } from "@/timeline";
import { DEFAULT_CAMERA_TRACKER_SETTINGS } from "../../types";
import { CAMERA_TRACKER_MESSAGES } from "../engine";
import { restoreUnusableCameraTrackers } from "../normalize";
import { withCameraTracker } from "../tracker-tracks";
import { listElements, sceneOf, sec, videoClip } from "./editor-harness";
import { engineHarness, type EngineHarness } from "./engine-harness";
import { trackerData } from "./fixtures";

/**
 * A clip whose stored Track Camera record could not be read keeps it in
 * `unusableCameraTracker`. Everything that reads `cameraTracker` must see an
 * untracked clip, and the editing commands must carry the record along.
 */

/** Would render, solve and delete if anything read it: a newer-version record that looks perfectly valid. */
function futureRecord() {
	return {
		...trackerData(),
		version: 2,
		settings: { ...DEFAULT_CAMERA_TRACKER_SETTINGS, renderTrackPoints: true },
	};
}

let current: EngineHarness | null = null;
afterEach(() => {
	current?.dispose();
	current = null;
});

function start({ raw }: { raw: unknown }): EngineHarness {
	current = engineHarness({ tracks: sceneOf({ main: [videoClip({ extra: { unusableCameraTracker: raw } })] }) });
	return current;
}

function videoOf(element: TimelineElement | undefined): VideoElement {
	if (!element || element.type !== "video") throw new Error("expected a video clip");
	return element;
}

function clips({ h }: { h: EngineHarness }): VideoElement[] {
	return listElements({ tracks: h.editor.state.tracks }).flatMap((entry) =>
		entry.element.type === "video" ? [entry.element] : [],
	);
}

describe("a clip with a set-aside record is an untracked clip to every consumer", () => {
	test("render: no camera, no track points, no frame", () => {
		const video: VideoElement = { ...renderVideoElement({ cameraTracker: null }), unusableCameraTracker: futureRecord() };
		const tracks = renderSceneTracks({
			overlay: [renderCameraTrack({ elements: [cameraElement()] })],
			main: [video],
		});
		const canvas = { canvasWidth: 1080, canvasHeight: 1920 };
		expect(trackedViewCamera({ video, time: seconds(1), ...canvas })).toBeNull();
		expect(activeCameraAt({ tracks, time: seconds(1), ...canvas }).kind).not.toBe("tracked");
		expect(trackPointsAt({ video, time: seconds(1), ...canvas })).toBeNull();
		expect(analysisFrameAt({ video, time: seconds(1) })).toBeNull();
	});

	test("engine: nothing decoded, nothing to re-solve, nothing to create from, nothing written", () => {
		const h = start({ raw: futureRecord() });
		const before = h.editor.state.tracks;
		expect(h.engine.decoded({ elementId: "clip" })).toBeNull();
		expect(h.engine.createLayers({ elementId: "clip", kind: "text", multiple: false, target: null, trackIds: [0], frame: 0 })).toEqual({
			status: "failed",
			message: CAMERA_TRACKER_MESSAGES.noAnalysis,
		});
		h.engine.setGroundPlane({ elementId: "clip", target: { center: [0, 0, 0], normal: [0, 1, 0], radius: 10 } });
		h.engine.deletePoints({ elementId: "clip", trackIds: [0] });
		h.engine.updateSettings({ elementId: "clip", patch: { trackPointSize: 50 } });
		expect(h.editor.state.tracks).toBe(before);
		expect(h.editor.editor.command.canUndo()).toBe(false);
		expect(h.editor.editor.timeline.deleteTrackPoints({ elementId: "clip", trackIds: [0] })).toBe(false);
	});

	test("engine: Solve Again has no stored analysis to use", async () => {
		const h = start({ raw: futureRecord() });
		expect(await h.engine.resolve({ elementId: "clip" })).toEqual({
			status: "failed",
			elementId: "clip",
			message: CAMERA_TRACKER_MESSAGES.noAnalysis,
		});
		expect(h.solveCalls).toHaveLength(0);
	});

	test("Track Camera analyses the clip afresh; the set-aside record is not touched, and the new data wins on save", async () => {
		const raw = futureRecord();
		const h = start({ raw });
		expect(await h.engine.trackCamera({ elementId: "clip" })).toEqual({ status: "solved", elementId: "clip" });
		expect(h.decodeCalls).toHaveLength(1);
		const clip = videoOf(h.editor.state.tracks.main.elements[0]);
		expect(clip.cameraTracker).toBeDefined();
		expect(clip.unusableCameraTracker).toBe(raw);
		const saved = videoOf(restoreUnusableCameraTrackers({ tracks: h.editor.state.tracks }).main.elements[0]);
		expect(saved.cameraTracker).toBe(clip.cameraTracker);
		expect("unusableCameraTracker" in saved).toBe(false);
	});
});

describe("splitting and duplicating a clip with a set-aside record", () => {
	test("both halves of a split carry the record, the same object, and nothing reads it", () => {
		const raw = futureRecord();
		const h = start({ raw });
		h.editor.editor.timeline.splitElements({ elements: [{ trackId: "main", elementId: "clip" }], splitTime: sec(2) });
		const halves = clips({ h });
		expect(halves).toHaveLength(2);
		for (const half of halves) {
			expect(half.unusableCameraTracker).toBe(raw);
			expect("cameraTracker" in half).toBe(false);
		}
		// undo gives the clip back as it was
		h.editor.editor.command.undo();
		expect(clips({ h })).toHaveLength(1);
		expect(clips({ h })[0].unusableCameraTracker).toBe(raw);
	});

	test("a duplicate carries the record too", () => {
		const raw = futureRecord();
		const h = start({ raw });
		h.editor.editor.timeline.duplicateElements({ elements: [{ trackId: "main", elementId: "clip" }] });
		const copies = clips({ h });
		expect(copies).toHaveLength(2);
		for (const copy of copies) expect(copy.unusableCameraTracker).toBe(raw);
	});

	test("each half is written back with the record on save", () => {
		const raw = futureRecord();
		const h = start({ raw });
		h.editor.editor.timeline.splitElements({ elements: [{ trackId: "main", elementId: "clip" }], splitTime: sec(2) });
		const saved = restoreUnusableCameraTrackers({ tracks: h.editor.state.tracks });
		for (const half of saved.main.elements) {
			expect(Reflect.get(half, "cameraTracker")).toBe(raw);
			expect("unusableCameraTracker" in half).toBe(false);
		}
	});
});

describe("writing or removing the tracker of a clip that carries a set-aside record", () => {
	function loadedClip({ raw }: { raw: unknown }) {
		return sceneOf({ main: [videoClip({ extra: { unusableCameraTracker: raw } })] });
	}

	test("a new record written over it wins on save and the old one is not written back", () => {
		const fresh = trackerData({ overrides: { stale: "solve" } });
		const tracks = withCameraTracker({ tracks: loadedClip({ raw: futureRecord() }), elementId: "clip", data: fresh });
		const saved = videoOf(restoreUnusableCameraTrackers({ tracks }).main.elements[0]);
		expect(saved.cameraTracker).toBe(fresh);
		expect("unusableCameraTracker" in saved).toBe(false);
	});

	test("removing the tracker after a re-track takes the old record with it: the next save writes no tracker", () => {
		const retracked = withCameraTracker({ tracks: loadedClip({ raw: futureRecord() }), elementId: "clip", data: trackerData() });
		const removed = withCameraTracker({ tracks: retracked, elementId: "clip", data: null });
		const saved = videoOf(restoreUnusableCameraTrackers({ tracks: removed }).main.elements[0]);
		expect("cameraTracker" in saved).toBe(false);
		expect("unusableCameraTracker" in saved).toBe(false);
	});

	test("removing on a clip that looks untracked removes nothing visible: the set-aside record is still written back", () => {
		const raw = futureRecord();
		const removed = withCameraTracker({ tracks: loadedClip({ raw }), elementId: "clip", data: null });
		const saved = restoreUnusableCameraTrackers({ tracks: removed }).main.elements[0];
		expect(Reflect.get(saved, "cameraTracker")).toBe(raw);
	});

	test("Remove is one undo step: undo gives back the re-tracked clip, still carrying the old record", async () => {
		const raw = futureRecord();
		const h = start({ raw });
		expect(await h.engine.trackCamera({ elementId: "clip" })).toEqual({ status: "solved", elementId: "clip" });
		const retracked = h.editor.state.tracks;
		h.editor.editor.timeline.setCameraTracker({ elementId: "clip", data: null });
		const [removed] = clips({ h });
		expect("cameraTracker" in removed).toBe(false);
		expect("unusableCameraTracker" in removed).toBe(false);
		h.editor.editor.command.undo();
		expect(h.editor.state.tracks).toBe(retracked);
		expect(clips({ h })[0].unusableCameraTracker).toBe(raw);
	});
});
