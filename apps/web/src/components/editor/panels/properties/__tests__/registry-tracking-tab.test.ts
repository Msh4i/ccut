/**
 * Which clips get which tabs for the AE-style camera tracker: the video
 * clip's Tracking tab (Track Camera), no "Stick to scene" tab on overlay
 * elements any more, the camera layer's tab, and the 3D tab of 3D layers.
 */
import { describe, expect, test } from "bun:test";
import type {
	CameraElement,
	GraphicElement,
	ImageElement,
	StickerElement,
	TextElement,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { elementParamRegistry } from "@/params/registry";
import { LAYER_3D_ENABLED_KEY } from "@/scene3d/layer-params";
import { getPropertiesConfig } from "../registry";

const base = {
	startTime: ZERO_MEDIA_TIME,
	duration: ZERO_MEDIA_TIME,
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
	params: {},
};

const video: VideoElement = { ...base, id: "v", type: "video", name: "v", mediaId: "m" };
const image: ImageElement = { ...base, id: "i", type: "image", name: "i", mediaId: "m" };
const text: TextElement = { ...base, id: "t", type: "text", name: "t" };
const sticker: StickerElement = { ...base, id: "s", type: "sticker", name: "s", stickerId: "emoji:1f600" };
const graphic: GraphicElement = { ...base, id: "g", type: "graphic", name: "g", definitionId: "rectangle" };
const camera: CameraElement = { ...base, id: "c", type: "camera", name: "Camera", sourceElementId: "v" };

function tabIds({ element }: { element: TimelineElement }) {
	return getPropertiesConfig({ element, mediaAssets: [] }).tabs.map((tab) => tab.id);
}

describe("the Tracking tab", () => {
	test("a video clip has it (Track Camera), after its other tabs, which keep their order", () => {
		expect(tabIds({ element: video })).toEqual([
			"transform",
			"animation",
			"keyframe-presets",
			"audio",
			"speed",
			"blending",
			"background",
			"masks",
			"effects",
			"tracking",
		]);
	});

	test("text, image, sticker and graphic clips no longer have the Stick to scene tab", () => {
		for (const element of [text, image, sticker, graphic]) {
			expect(tabIds({ element })).not.toContain("tracking");
		}
	});

	test("the other tabs of those clips keep their order, the 3D tab comes right after Transform", () => {
		expect(tabIds({ element: text })).toEqual(["text", "transform", "transform3d", "animation", "keyframe-presets", "blending"]);
		expect(tabIds({ element: image })).toEqual(["transform", "transform3d", "animation", "keyframe-presets", "blending", "background", "masks", "effects"]);
		expect(tabIds({ element: sticker })).toEqual(["transform", "transform3d", "animation", "keyframe-presets", "blending", "background", "effects"]);
		expect(tabIds({ element: graphic })).toEqual([
			"graphic",
			"transform",
			"transform3d",
			"animation",
			"keyframe-presets",
			"blending",
			"masks",
			"effects",
		]);
	});
});

describe("the camera layer", () => {
	test("has its own tab, open by default", () => {
		const config = getPropertiesConfig({ element: camera, mediaAssets: [] });
		expect(config.tabs.map((tab) => tab.id)).toEqual(["camera"]);
		expect(config.defaultTab).toBe("camera");
	});
});

describe("the 3D tab", () => {
	test("is offered on every overlay type (the model registers the transform3d params)", () => {
		for (const element of [text, image, sticker, graphic]) {
			expect(tabIds({ element })).toContain("transform3d");
		}
		expect(getPropertiesConfig({ element: image, mediaAssets: [] }).defaultTab).toBe("transform");
	});

	test("is not offered when the type has no transform3d params", () => {
		const original = elementParamRegistry.get("image");
		try {
			elementParamRegistry.register({
				key: "image",
				definition: original.filter((definition) => !definition.key.startsWith("transform3d.")),
			});
			expect(tabIds({ element: image })).not.toContain("transform3d");
		} finally {
			elementParamRegistry.register({ key: "image", definition: original });
		}
		expect(tabIds({ element: image })).toContain("transform3d");
	});

	test("on a 3D layer: no 2D Transform, no Masks, the 3D tab opens by default", () => {
		const image3D: ImageElement = { ...image, params: { [LAYER_3D_ENABLED_KEY]: true } };
		const config = getPropertiesConfig({ element: image3D, mediaAssets: [] });
		expect(config.tabs.map((tab) => tab.id)).toEqual(["transform3d", "animation", "keyframe-presets", "blending", "background", "effects"]);
		expect(config.defaultTab).toBe("transform3d");
	});
});
