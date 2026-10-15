import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { defaultViewCamera } from "@/scene3d/camera";
import { LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS } from "@/scene3d/layer-params";
import {
	cameraElement,
	cameraTrack,
	sceneTracks,
	seconds,
} from "@/scene3d/render/__tests__/fixtures";
import { activeCameraAt } from "@/scene3d/render/active-camera";
import { projectedLayerBounds } from "@/scene3d/render/homography";
import type { ImageElement, SceneTracks, VideoTrack } from "@/timeline";
import { getVisibleElementsWithBounds } from "../element-bounds";

const CANVAS = { width: 1080, height: 1920 };

const MEDIA: MediaAsset[] = [
	{
		id: "photo",
		name: "photo.png",
		type: "image",
		file: new File([], "photo.png"),
		width: 800,
		height: 600,
	},
];

function image(params: ImageElement["params"]): ImageElement {
	return {
		id: "image",
		name: "image",
		type: "image",
		mediaId: "photo",
		startTime: seconds(0),
		trimStart: seconds(0),
		trimEnd: seconds(0),
		duration: seconds(2),
		params,
	};
}

function withImage({
	params,
	overlay = [],
}: {
	params: ImageElement["params"];
	overlay?: SceneTracks["overlay"];
}): SceneTracks {
	const track: VideoTrack = {
		id: "images",
		name: "images",
		type: "video",
		elements: [image(params)],
		muted: false,
		hidden: false,
	};
	return sceneTracks({ overlay: [...overlay, track] });
}

function boundsOf(tracks: SceneTracks) {
	return getVisibleElementsWithBounds({
		tracks,
		currentTime: seconds(1),
		canvasSize: CANVAS,
		mediaAssets: MEDIA,
	}).find((entry) => entry.elementId === "image")?.bounds;
}

describe("element bounds of 3D layers", () => {
	test("a 3D layer at z = 0 facing the default camera has its 2D box at scale 1", () => {
		const bounds = boundsOf(
			withImage({
				params: {
					[LAYER_3D_ENABLED_KEY]: true,
					// 2D params are ignored for 3D layers.
					"transform.scaleX": 3,
					"transform.rotate": 45,
				},
			}),
		);
		// 800x600 contain-fitted into 1080x1920: 1080 x 810, centred.
		expect(bounds?.cx).toBeCloseTo(540, 6);
		expect(bounds?.cy).toBeCloseTo(960, 6);
		expect(bounds?.width).toBeCloseTo(1080, 6);
		expect(bounds?.height).toBeCloseTo(810, 6);
		expect(bounds?.rotation).toBe(0);
	});

	test("a turned 3D layer is bounded by the box of its projected quad, through the active camera", () => {
		const params = {
			[LAYER_3D_ENABLED_KEY]: true,
			[LAYER_3D_KEYS.positionX]: 40,
			[LAYER_3D_KEYS.positionZ]: 300,
			[LAYER_3D_KEYS.orientationY]: 35,
			[LAYER_3D_KEYS.rotationX]: -20,
		};
		const overlay = [cameraTrack({ elements: [cameraElement()] })];
		const tracks = withImage({ params, overlay });
		const bounds = boundsOf(tracks);
		const view = activeCameraAt({
			tracks,
			time: seconds(1),
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		expect(view.kind).toBe("tracked");
		const box = projectedLayerBounds({
			view,
			transform: {
				position: [40, 0, 300],
				orientationDeg: [0, 35, 0],
				rotationDeg: [-20, 0, 0],
				scale: [1, 1, 1],
			},
			contentWidth: 1080,
			contentHeight: 810,
			canvasWidth: CANVAS.width,
			canvasHeight: CANVAS.height,
		});
		if (!box) throw new Error("expected a visible layer");
		expect(bounds?.cx).toBeCloseTo((box.left + box.right) / 2, 6);
		expect(bounds?.cy).toBeCloseTo((box.top + box.bottom) / 2, 6);
		expect(bounds?.width).toBeCloseTo(box.right - box.left, 6);
		expect(bounds?.height).toBeCloseTo(box.bottom - box.top, 6);
		expect(bounds?.rotation).toBe(0);
	});

	test("a 3D layer behind the camera has no bounds (cannot be picked)", () => {
		const view = defaultViewCamera({ canvasWidth: CANVAS.width, canvasHeight: CANVAS.height });
		const bounds = boundsOf(
			withImage({
				params: {
					[LAYER_3D_ENABLED_KEY]: true,
					[LAYER_3D_KEYS.positionZ]: -view.focalPx - 1000,
				},
			}),
		);
		expect(bounds).toBeUndefined();
	});

	test("2D layers keep their bounds", () => {
		const bounds = boundsOf(
			withImage({ params: { "transform.scaleX": 0.5, "transform.rotate": 30 } }),
		);
		expect(bounds?.width).toBeCloseTo(540, 9);
		expect(bounds?.height).toBeCloseTo(810, 9);
		expect(bounds?.rotation).toBe(30);
	});
});
