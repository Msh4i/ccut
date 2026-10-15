import { describe, expect, test } from "bun:test";
import { LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS } from "@/scene3d/layer-params";
import type { CameraElement, VideoElement } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import {
	CAMERA_TAB_NOTES,
	LAYER_3D_TAB_ID,
	arrangeLayerTabs,
	buildCameraTab,
	layer3DTabKeys,
} from "../layer-tabs";
import { buildData, buildDecoded, buildSolve, buildTracks } from "./fixtures";

const ALL_KEYS = new Set([LAYER_3D_ENABLED_KEY, ...Object.values(LAYER_3D_KEYS), "opacity"]);

describe("the 3D tab's fields", () => {
	test("the switch first, then Position, Orientation, Rotation, Scale X/Y/Z", () => {
		expect(layer3DTabKeys({ elementType: "text", registeredKeys: ALL_KEYS })).toEqual([
			"transform3d.enabled",
			"transform3d.positionX",
			"transform3d.positionY",
			"transform3d.positionZ",
			"transform3d.orientationX",
			"transform3d.orientationY",
			"transform3d.orientationZ",
			"transform3d.rotationX",
			"transform3d.rotationY",
			"transform3d.rotationZ",
			"transform3d.scaleX",
			"transform3d.scaleY",
			"transform3d.scaleZ",
		]);
	});

	test("only for text, image, sticker and graphic layers", () => {
		for (const elementType of ["text", "image", "sticker", "graphic"] as const) {
			expect(layer3DTabKeys({ elementType, registeredKeys: ALL_KEYS })).not.toBeNull();
		}
		for (const elementType of ["video", "audio", "effect", "camera"] as const) {
			expect(layer3DTabKeys({ elementType, registeredKeys: ALL_KEYS })).toBeNull();
		}
	});

	test("no tab until the params are registered (the 3D switch is required); partial registration lists what exists", () => {
		expect(layer3DTabKeys({ elementType: "text", registeredKeys: new Set(["opacity"]) })).toBeNull();
		const partial = new Set([LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS.positionX]);
		expect(layer3DTabKeys({ elementType: "image", registeredKeys: partial })).toEqual([LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS.positionX]);
	});
});

describe("arrangeLayerTabs", () => {
	const tabs = ["transform", "animation", "blending", "masks", "effects"].map((id) => ({ id }));
	const tab3d = { id: LAYER_3D_TAB_ID };

	test("without a 3D tab nothing changes", () => {
		expect(arrangeLayerTabs({ tabs, defaultTab: "transform", layer3DTab: null, is3D: false })).toEqual({ tabs, defaultTab: "transform" });
	});

	test("a 2D layer gets the 3D tab right after Transform", () => {
		const result = arrangeLayerTabs({ tabs, defaultTab: "transform", layer3DTab: tab3d, is3D: false });
		expect(result.tabs.map((tab) => tab.id)).toEqual(["transform", LAYER_3D_TAB_ID, "animation", "blending", "masks", "effects"]);
		expect(result.defaultTab).toBe("transform");
	});

	test("a 3D layer loses the 2D Transform and Masks tabs (ignored and unsupported in 3D) and defaults to 3D", () => {
		const result = arrangeLayerTabs({ tabs, defaultTab: "transform", layer3DTab: tab3d, is3D: true });
		expect(result.tabs.map((tab) => tab.id)).toEqual([LAYER_3D_TAB_ID, "animation", "blending", "effects"]);
		expect(result.defaultTab).toBe(LAYER_3D_TAB_ID);
		const text = arrangeLayerTabs({ tabs: [{ id: "text" }, ...tabs], defaultTab: "text", layer3DTab: tab3d, is3D: true });
		expect(text.defaultTab).toBe("text");
		expect(text.tabs.map((tab) => tab.id)).toEqual(["text", LAYER_3D_TAB_ID, "animation", "blending", "effects"]);
	});
});

describe("the camera layer's tab", () => {
	const sec = (seconds: number) => mediaTimeFromSeconds({ seconds });
	const camera: CameraElement = {
		id: "cam", type: "camera", name: "Camera", sourceElementId: "v", startTime: sec(2), duration: sec(5),
		trimStart: ZERO_MEDIA_TIME, trimEnd: ZERO_MEDIA_TIME, params: {},
	};
	const source: VideoElement = {
		id: "v", type: "video", name: "street-walk.mp4", mediaId: "m", startTime: sec(2), duration: sec(5),
		trimStart: sec(1), trimEnd: ZERO_MEDIA_TIME, params: {},
	};
	// focal 1000 then 2000 over 1920 px: 87.66 deg then 51.28 deg
	const solve = buildSolve({
		cameras: [
			{ rotation: [1, 0, 0, 0], position: [0, 0, 0], focalPx: 1000 },
			{ rotation: [1, 0, 0, 0], position: [0, 0, 0], focalPx: 2000 },
		],
		points: [],
	});
	const tracks = buildTracks({ frameCount: 2, fps: 1, tracks: [] });
	const decoded = buildDecoded({ elementId: "v", data: buildData({ sourceStart: 1, fps: 1, frameCount: 2 }), tracks, solve });

	test("source clip name and the angle of view at the playhead", () => {
		// playhead 2 s = clip start = source 1 s = analysis frame 0
		expect(buildCameraTab({ camera, source, decoded, time: sec(2) })).toEqual({
			sourceName: "street-walk.mp4",
			angleOfView: "87.7°",
			note: null,
			hidden: false,
		});
		// 2.5 s -> frame 0.5 -> focal 1500 -> 65.24 deg
		expect(buildCameraTab({ camera, source, decoded, time: sec(2.5) }).angleOfView).toBe("65.2°");
		expect(buildCameraTab({ camera: { ...camera, hidden: true }, source, decoded, time: sec(9) }).hidden).toBe(true);
	});

	test("a missing source or solve says so", () => {
		expect(buildCameraTab({ camera, source: null, decoded: null, time: sec(2) })).toEqual({
			sourceName: "Missing clip",
			angleOfView: null,
			note: CAMERA_TAB_NOTES.missingSource,
			hidden: false,
		});
		expect(buildCameraTab({ camera, source, decoded: null, time: sec(2) }).note).toBe(CAMERA_TAB_NOTES.noSolve);
		expect(buildCameraTab({ camera, source, decoded: buildDecoded({ solve: null }), time: sec(2) }).angleOfView).toBeNull();
	});
});
