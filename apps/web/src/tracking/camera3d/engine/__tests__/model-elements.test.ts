import { afterEach, describe, expect, test } from "bun:test";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { getGraphicDefinition, graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { NULL_GRAPHIC_DEFINITION_ID } from "@/graphics/definitions";
import { shapesProvider } from "@/stickers/providers/shapes";
import type { ElementType, TrackType } from "@/timeline";
import { canTrackBeHidden } from "@/timeline/track-capabilities";
import {
	buildCameraElement,
	buildGraphicElement,
	canElementBeHidden,
	isCameraElement,
} from "@/timeline/element-utils";
import { canElementGoOnTrack, resolveTrackPlacement } from "@/timeline/placement";
import {
	startTrackCamera,
	trackCameraMenuItem,
} from "@/timeline/components/track-camera-menu";
import type { CameraTrackerApi, CameraTrackerRunOutcome } from "@/tracking/camera3d/session";
import { CAMERA_TRACKER_NOT_READY_MESSAGE } from "@/tracking/camera3d/session";
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
} from "./editor-harness";

let harness: EditorHarness | null = null;
afterEach(() => {
	harness?.restore();
	harness = null;
});

describe("the null graphic (AE Create Null)", () => {
	test("is registered, so stored nulls render and insert", () => {
		registerDefaultGraphics();
		expect(graphicsRegistry.has(NULL_GRAPHIC_DEFINITION_ID)).toBe(true);
		const element = buildGraphicElement({ definitionId: NULL_GRAPHIC_DEFINITION_ID, startTime: sec(0) });
		expect(element.definitionId).toBe("null");
		expect(element.name).toBe("Null");
	});

	test("draws nothing", () => {
		const calls: string[] = [];
		const ctx = new Proxy(
			{},
			{
				get: (_target, property) => {
					calls.push(String(property));
					return () => {};
				},
				set: (_target, property) => {
					calls.push(`set ${String(property)}`);
					return true;
				},
			},
		);
		const definition = getGraphicDefinition({ definitionId: NULL_GRAPHIC_DEFINITION_ID });
		Reflect.apply(definition.render, definition, [{ ctx, params: {}, width: 64, height: 64 }]);
		expect(calls.filter((call) => call !== "clearRect")).toEqual([]);
	});

	test("is not offered in the shapes library", async () => {
		registerDefaultGraphics();
		expect(graphicsRegistry.getAll().map((definition) => definition.id)).not.toContain("null");
		const browse = await shapesProvider.browse({});
		const ids = browse.sections.flatMap((section) => section.items.map((item) => item.metadata?.definitionId));
		expect(ids).toContain("rectangle");
		expect(ids).not.toContain("null");
		const search = await shapesProvider.search({ query: "null" });
		expect(search.items).toEqual([]);
	});
});

describe("camera elements", () => {
	test("builder, predicate and hiding", () => {
		const camera = { ...buildCameraElement({ sourceElementId: "clip", startTime: sec(1), duration: sec(2) }), id: "c" };
		expect(camera).toMatchObject({ type: "camera", sourceElementId: "clip", name: "3D Tracker Camera", params: {} });
		expect(isCameraElement(camera)).toBe(true);
		expect(isCameraElement(videoClip())).toBe(false);
		expect(canElementBeHidden(camera)).toBe(true);
		expect(canTrackBeHidden(cameraTrack({ elements: [camera] }))).toBe(true);
	});

	test("go only onto camera tracks, and nothing else goes onto a camera track", () => {
		const elementTypes: ElementType[] = ["video", "image", "text", "sticker", "graphic", "audio", "effect", "camera"];
		const trackTypes: TrackType[] = ["video", "text", "graphic", "audio", "effect", "camera"];
		for (const elementType of elementTypes) {
			for (const trackType of trackTypes) {
				const allowed = canElementGoOnTrack({ elementType, trackType });
				if (elementType === "camera" || trackType === "camera") {
					expect(allowed).toBe(elementType === "camera" && trackType === "camera");
				}
			}
		}
	});

	test("placement refuses mixed drops and puts a new camera track at the top", () => {
		const tracks = sceneOf({
			overlay: [textTrack({ elements: [textLayer()] }), cameraTrack({ elements: [cameraLayer({ start: 0, duration: 2 })] })],
		});
		const span = [{ startTime: sec(5), duration: sec(1) }];
		expect(
			resolveTrackPlacement({ tracks, elementType: "camera", timeSpans: span, strategy: { type: "explicit", trackId: "text-track" } }),
		).toBeNull();
		expect(
			resolveTrackPlacement({ tracks, elementType: "text", timeSpans: span, strategy: { type: "explicit", trackId: "camera-track" } }),
		).toBeNull();
		expect(
			resolveTrackPlacement({ tracks, elementType: "camera", timeSpans: span, strategy: { type: "firstAvailable" } }),
		).toMatchObject({ kind: "existingTrack", trackId: "camera-track" });
		expect(
			resolveTrackPlacement({
				tracks,
				elementType: "camera",
				timeSpans: [{ startTime: sec(1), duration: sec(1) }],
				strategy: { type: "firstAvailable" },
			}),
		).toMatchObject({ kind: "newTrack", trackType: "camera", insertIndex: 0 });
	});

	test("insertion validates the source reference and lands on a camera track", () => {
		harness = createEditorHarness();
		const before = harness.state.tracks;
		const bad = new InsertElementCommand({
			element: { ...buildCameraElement({ sourceElementId: "", startTime: sec(0), duration: sec(1) }) },
			placement: { mode: "auto" },
		});
		const originalError = console.error;
		console.error = () => {};
		try {
			bad.execute();
		} finally {
			console.error = originalError;
		}
		expect(harness.state.tracks).toBe(before);

		harness.editor.timeline.insertElement({
			element: buildCameraElement({ sourceElementId: "clip", startTime: sec(0), duration: sec(4) }),
			placement: { mode: "auto" },
		});
		const cameras = listElements({ tracks: harness.state.tracks }).filter((entry) => entry.element.type === "camera");
		expect(cameras).toHaveLength(1);
		expect(cameras[0].trackType).toBe("camera");
		expect(harness.state.tracks.overlay[0].type).toBe("camera");

		harness.editor.command.undo();
		expect(harness.state.tracks).toBe(before);
	});

	test("a camera cannot be inserted onto a text track", () => {
		harness = createEditorHarness({ tracks: sceneOf({ overlay: [textTrack({ elements: [] })] }) });
		const before = harness.state.tracks;
		const originalError = console.error;
		console.error = () => {};
		try {
			new InsertElementCommand({
				element: buildCameraElement({ sourceElementId: "clip", startTime: sec(0), duration: sec(1) }),
				placement: { mode: "explicit", trackId: "text-track" },
			}).execute();
		} finally {
			console.error = originalError;
		}
		expect(harness.state.tracks).toBe(before);
	});
});

describe("Track Camera in the clip context menu", () => {
	test("is offered on video clips only, and greyed out while a run is going", () => {
		expect(trackCameraMenuItem({ element: videoClip(), phase: { phase: "idle" } })).toEqual({
			label: "Track Camera",
			disabled: false,
		});
		expect(
			trackCameraMenuItem({ element: videoClip(), phase: { phase: "analyzing", elementId: "other", progress: 0.2 } }),
		).toEqual({ label: "Track Camera", disabled: true });
		expect(trackCameraMenuItem({ element: textLayer(), phase: { phase: "idle" } })).toBeNull();
		expect(trackCameraMenuItem({ element: cameraLayer(), phase: { phase: "idle" } })).toBeNull();
	});

	/** `outcome` is called per run, so a rejection only exists once someone awaits it. */
	function fakeApi(outcome: () => Promise<CameraTrackerRunOutcome>): { api: CameraTrackerApi; calls: string[] } {
		const calls: string[] = [];
		const api: CameraTrackerApi = {
			trackCamera: ({ elementId }) => {
				calls.push(elementId);
				return outcome();
			},
			resolve: () => outcome(),
			cancel: () => {},
			updateSettings: () => {},
			deletePoints: () => {},
			setGroundPlane: () => {},
			createLayers: () => ({ status: "failed", message: "" }),
			decoded: () => null,
		};
		return { api, calls };
	}

	test("calls the engine for the clicked clip; says why when it cannot", async () => {
		const notes: string[] = [];
		const notify = (message: string) => notes.push(message);

		await startTrackCamera({ elementId: "clip", api: null, notify });
		expect(notes).toEqual([CAMERA_TRACKER_NOT_READY_MESSAGE]);

		const solved = fakeApi(() => Promise.resolve({ status: "solved", elementId: "clip" }));
		await startTrackCamera({ elementId: "clip", api: solved.api, notify });
		expect(solved.calls).toEqual(["clip"]);
		expect(notes).toHaveLength(1);

		const busy = fakeApi(() => Promise.resolve({ status: "busy", elementId: "clip", message: "Busy." }));
		await startTrackCamera({ elementId: "clip", api: busy.api, notify });
		expect(notes.at(-1)).toBe("Busy.");

		const broken = fakeApi(() => Promise.reject(new Error("boom")));
		await startTrackCamera({ elementId: "clip", api: broken.api, notify });
		expect(notes.at(-1)).toBe("boom");
	});
});
