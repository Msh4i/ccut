import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Mask } from "@/masks/types";
import { defaultViewCamera, quadFrameToCanvas } from "@/scene3d/camera";
import { LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS } from "@/scene3d/layer-params";
import { quatFromAxisAngle } from "@/scene3d/math";
import { layerHomography, normalizeHomography } from "@/scene3d/render/homography";
import type { Transform3D, ViewCamera } from "@/scene3d/types";
import { sceneTracks } from "@/scene3d/render/__tests__/fixtures";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";
import { CanvasRenderer } from "../../canvas-renderer";
import { CameraRigNode } from "../../nodes/camera-rig-node";
import { ImageNode } from "../../nodes/image-node";
import { RootNode } from "../../nodes/root-node";
import { TextNode } from "../../nodes/text-node";
import { TrackPointsNode } from "../../nodes/solved-points-node";
import type {
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "../../nodes/visual-node";
import { resolveRenderTree } from "../../resolve";
import { buildFrameDescriptor } from "../frame-descriptor";
import type { FrameItemDescriptor, TextureUploadDescriptor } from "../types";

// 3D layers (params `transform3d.*`) are placed by a homography through the
// active camera; everything else must come out exactly as before.

const CANVAS = { width: 1080, height: 1920 };

// bun has no OffscreenCanvas: a stand-in that has a size (picture sources)
// and a 2D context that measures 10 px per character (text layout).
const measuringContext = {
	font: "",
	textBaseline: "",
	letterSpacing: "",
	save() {},
	restore() {},
	measureText: (text: string) => ({
		width: text.length * 10,
		actualBoundingBoxAscent: 8,
		actualBoundingBoxDescent: 2,
	}),
};

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return measuringContext;
	}
}

const originalOffscreenCanvas = Reflect.get(globalThis, "OffscreenCanvas");

beforeAll(() => {
	Reflect.set(globalThis, "OffscreenCanvas", FakeOffscreenCanvas);
});

afterAll(() => {
	if (originalOffscreenCanvas === undefined) {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	} else {
		Reflect.set(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	}
});

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), CANVAS);
}

const TRANSFORM_2D = {
	scaleX: 0.5,
	scaleY: 0.5,
	position: { x: 120, y: -80 },
	rotate: 30,
};

const VISUAL_PARAMS: VisualNodeParams = {
	duration: 1,
	timeOffset: 0,
	trimStart: 0,
	trimEnd: 0,
	transform: TRANSFORM_2D,
	opacity: 1,
};

const MASK: Mask = {
	id: "mask",
	type: "rectangle",
	params: {
		feather: 0,
		inverted: false,
		strokeColor: "#ffffff",
		strokeWidth: 0,
		strokeAlign: "center",
		centerX: 0,
		centerY: 0,
		width: 0.5,
		height: 0.5,
		rotation: 0,
		scale: 1,
	},
};

function at({ z, x = 0 }: { z: number; x?: number }): Transform3D {
	return {
		position: [x, 0, z],
		orientationDeg: [0, 20, 0],
		rotationDeg: [0, 0, 0],
		scale: [1, 1, 1],
	};
}

/** An 800x600 picture node, resolved; 3D when `transform3d` is given. */
function imageNode({
	transform3d,
	masks,
}: {
	transform3d?: Transform3D;
	masks?: Mask[];
} = {}): ImageNode {
	const node = new ImageNode({ ...VISUAL_PARAMS, url: "blob:image", masks });
	const resolved: ResolvedVisualSourceNodeState = {
		localTime: 0,
		transform: TRANSFORM_2D,
		opacity: 0.8,
		effectPasses: [],
		source: new OffscreenCanvas(800, 600),
		sourceWidth: 800,
		sourceHeight: 600,
		...(transform3d && { transform3d }),
	};
	node.resolved = resolved;
	return node;
}

function trackedView(): ViewCamera {
	return {
		kind: "tracked",
		rotation: quatFromAxisAngle({ axis: [0, 1, 0], radians: 0.2 }),
		position: [50, -30, -1400],
		focalPx: 1600,
		frameWidth: 1920,
		frameHeight: 1080,
		frameToCanvas: quadFrameToCanvas({
			quad: {
				centerX: 540,
				centerY: 960,
				width: 1080,
				height: 607.5,
				rotationDegrees: 0,
				flipX: false,
				flipY: false,
			},
			frameWidth: 1920,
			frameHeight: 1080,
		}),
	};
}

async function frameOf(children: (ImageNode | TextNode | CameraRigNode | TrackPointsNode)[]) {
	const root = new RootNode({ duration: 1 });
	for (const child of children) root.add(child);
	return buildFrameDescriptor({ node: root, renderer: renderer() });
}

function layers(items: FrameItemDescriptor[]) {
	return items.flatMap((item) => (item.type === "layer" ? [item] : []));
}

// 800x600 contain-fitted into 1080x1920: 1080 x 810.
const CONTENT = { contentWidth: 1080, contentHeight: 810 };

describe("3D picture layers", () => {
	test("are placed by the camera's homography; the 2D transform and the mask are ignored", async () => {
		const transform3d = at({ z: 200 });
		const { frame, textures } = await frameOf([imageNode({ transform3d, masks: [MASK] })]);
		const [layer] = layers(frame.items);
		expect(frame.items).toHaveLength(1);
		const expected = normalizeHomography(
			layerHomography({
				view: defaultViewCamera({ canvasWidth: 1080, canvasHeight: 1920 }),
				transform: transform3d,
				...CONTENT,
			}),
		);
		expect(layer.transform.homography).toEqual(expected ? [...expected] : null);
		expect(layer.transform.rotationDegrees).toBe(0);
		expect(layer.mask).toBeNull();
		expect(layer.opacity).toBe(0.8);
		expect(textures.map((texture) => texture.id)).toEqual(["root:0:source"]);
	});

	test("are seen through the root's active camera when a camera rig resolved one", async () => {
		const transform3d = at({ z: 200 });
		const rig = new CameraRigNode({ tracks: sceneTracks() });
		rig.resolved = trackedView();
		const { frame } = await frameOf([imageNode({ transform3d }), rig]);
		const [layer] = layers(frame.items);
		const expected = normalizeHomography(
			layerHomography({ view: trackedView(), transform: transform3d, ...CONTENT }),
		);
		expect(layer.transform.homography).toEqual(expected ? [...expected] : null);
	});

	test("a layer that cannot be seen (behind the camera) adds no item and no texture", async () => {
		const view = defaultViewCamera({ canvasWidth: 1080, canvasHeight: 1920 });
		const { frame, textures } = await frameOf([
			imageNode({ transform3d: at({ z: -view.focalPx - 2000 }) }),
		]);
		expect(frame.items).toHaveLength(0);
		expect(textures).toHaveLength(0);
	});
});

describe("2D layers are unchanged", () => {
	test("a 2D picture layer has the same quad as before and no homography", async () => {
		const { frame, textures } = await frameOf([imageNode()]);
		const [layer] = layers(frame.items);
		expect(layer.transform).toEqual({
			centerX: 540 + 120,
			centerY: 960 - 80,
			width: 540,
			height: 405,
			rotationDegrees: 30,
			flipX: false,
			flipY: false,
		});
		expect("homography" in layer.transform).toBe(false);
		expect(textures.map((texture) => texture.id)).toEqual(["root:0:source"]);
	});
});

describe("depth order", () => {
	test("each run of consecutive 3D layers is drawn far to near; 2D layers keep their place", async () => {
		const { frame } = await frameOf([
			imageNode(),
			imageNode({ transform3d: at({ z: 100 }) }),
			imageNode({ transform3d: at({ z: 900 }) }),
			imageNode({ transform3d: at({ z: 400 }) }),
			imageNode(),
			imageNode({ transform3d: at({ z: 50 }) }),
			imageNode({ transform3d: at({ z: 3000 }) }),
		]);
		expect(layers(frame.items).map((layer) => layer.textureId)).toEqual([
			"root:0:source",
			"root:2:source",
			"root:3:source",
			"root:1:source",
			"root:4:source",
			"root:6:source",
			"root:5:source",
		]);
	});
});

describe("Render Track Points", () => {
	test("crosses on a full-canvas layer right where the node sits; nothing when no point is alive", async () => {
		const points = new TrackPointsNode({ video: videoStub() });
		points.resolved = {
			points: [
				{ trackId: 3, x: 100, y: 200 },
				{ trackId: 9, x: 400.5, y: 800.25 },
			],
			radius: 6,
			lineWidth: 2,
		};
		const { frame, textures } = await frameOf([imageNode(), points, imageNode()]);
		const ids = layers(frame.items).map((layer) => layer.textureId);
		expect(ids).toEqual(["root:0:source", "root:1:solved-points", "root:2:source"]);
		const texture = textures.find((entry) => entry.id === "root:1:solved-points");
		expect(texture?.kind).toBe("rendered");
		expect(texture?.width).toBe(1080);
		expect(texture?.height).toBe(1920);
		const layer = layers(frame.items)[1];
		expect(layer.transform).toEqual({
			centerX: 540,
			centerY: 960,
			width: 1080,
			height: 1920,
			rotationDegrees: 0,
			flipX: false,
			flipY: false,
		});

		points.resolved = { points: [], radius: 6, lineWidth: 2 };
		const empty = await frameOf([imageNode(), points]);
		expect(layers(empty.frame.items)).toHaveLength(1);
	});
});

function videoStub() {
	return {
		id: "clip",
		name: "clip",
		type: "video" as const,
		mediaId: "m",
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 1000 }),
		params: {},
	};
}

describe("3D text layers", () => {
	async function textFrame({
		z,
		rotationY = 0,
		transform2D = TRANSFORM_2D,
	}: {
		z: number;
		rotationY?: number;
		transform2D?: typeof TRANSFORM_2D;
	}): Promise<{ textures: TextureUploadDescriptor[]; items: FrameItemDescriptor[] }> {
		const node = new TextNode({
			id: "text-1",
			type: "text",
			name: "Text",
			startTime: ZERO_MEDIA_TIME,
			duration: mediaTime({ ticks: 4000 }),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: {
				content: "Hello",
				fontSize: 15,
				textAlign: "center",
				[LAYER_3D_ENABLED_KEY]: true,
				[LAYER_3D_KEYS.positionZ]: z,
				[LAYER_3D_KEYS.rotationY]: rotationY,
			},
			transform: transform2D,
			opacity: 1,
			canvasCenter: { x: CANVAS.width / 2, y: CANVAS.height / 2 },
			canvasHeight: CANVAS.height,
		});
		const root = new RootNode({ duration: 1 });
		root.add(node);
		await resolveRenderTree({ node: root, renderer: renderer(), time: 0 });
		const { frame, textures } = await buildFrameDescriptor({ node: root, renderer: renderer() });
		return { textures, items: frame.items };
	}

	test("the layout is rasterised into a local texture sized from its on-screen size", async () => {
		const { textures, items } = await textFrame({ z: 0 });
		const [texture] = textures;
		expect(texture.id).toBe("root:0:text3d");
		expect(texture.kind).toBe("rendered");
		// At z = 0 the default camera shows the text at scale 1: the texture is
		// the measured box, far smaller than the canvas.
		expect(texture.width).toBeLessThan(CANVAS.width / 4);
		const [layer] = layers(items);
		expect(layer.transform.homography).toHaveLength(9);
		expect(layer.textureId).toBe("root:0:text3d");
	});

	test("moving or turning the layer a little, or changing its 2D transform, does not re-rasterise it", async () => {
		// z = 0 shows the text at exactly scale 1, the edge of a size bucket:
		// start a little farther so a small move stays inside the bucket.
		const base = await textFrame({ z: 150 });
		const moved = await textFrame({
			z: 100,
			rotationY: 5,
			transform2D: { ...TRANSFORM_2D, rotate: 75, scaleX: 3 },
		});
		const [a] = base.textures;
		const [b] = moved.textures;
		expect(a.kind === "rendered" && b.kind === "rendered" && a.contentHash === b.contentHash).toBe(
			true,
		);
		expect(layers(base.items)[0].transform.homography).not.toEqual(
			layers(moved.items)[0].transform.homography,
		);
	});

	test("coming much closer re-rasterises it at a larger size", async () => {
		const view = defaultViewCamera({ canvasWidth: 1080, canvasHeight: 1920 });
		const base = await textFrame({ z: 0 });
		const close = await textFrame({ z: -view.focalPx * 0.6 });
		const [a] = base.textures;
		const [b] = close.textures;
		expect(b.width).toBeGreaterThan(a.width * 2);
		expect(a.kind === "rendered" && b.kind === "rendered" && a.contentHash !== b.contentHash).toBe(
			true,
		);
	});
});
