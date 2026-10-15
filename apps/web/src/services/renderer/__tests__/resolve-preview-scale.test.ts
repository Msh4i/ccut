import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { registerDefaultEffects } from "@/effects";
import type { Effect } from "@/effects/types";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type {
	ExternalTextureDescriptor,
	FrameDescriptor,
	TextureUploadDescriptor,
} from "@/services/renderer/compositor/types";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { DEFAULT_PLAYBACK_LEVERS } from "@/services/playback-levers/levers";
import { usePlaybackLeversStore } from "@/services/playback-levers/store";
import { videoCache } from "@/services/video-cache/service";
import { scaledFrameSize } from "@/services/video-cache/frame-scale";

// The preview draws video frames at about their size on screen while it plays
// or scrubs (preview: { sourceDensity: number }); a render without `preview`
// (export, snapshot, thumbnail), and a paused preview (sourceDensity null),
// always ask for and upload full-size frames. The layer's quad keeps the
// logical size either way: the compositor stretches the smaller texture.

registerDefaultEffects();

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return {
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
	}
}

const originalOffscreenCanvas = Reflect.get(globalThis, "OffscreenCanvas");
const getFrameAt = spyOn(videoCache, "getFrameAt");
const peekDisplaySize = spyOn(videoCache, "peekDisplaySize");
const ensureInitialized = spyOn(wasmCompositor, "ensureInitialized");
const syncTextures = spyOn(wasmCompositor, "syncTextures");
const renderFrame = spyOn(wasmCompositor, "render");
const getCanvas = spyOn(wasmCompositor, "getCanvas");

const DISPLAY = { width: 1920, height: 1080 };
let displayKnown = true;
const frames: FrameDescriptor[] = [];
const textures: TextureUploadDescriptor[][] = [];

beforeAll(() => {
	Reflect.set(globalThis, "OffscreenCanvas", FakeOffscreenCanvas);
	// A cache that honours the scale it is asked for, like the real one.
	getFrameAt.mockImplementation(async ({ scale = 1 }) => {
		const size = scaledFrameSize({ ...DISPLAY, scale });
		return {
			canvas: new OffscreenCanvas(size.width, size.height),
			timestamp: 1,
			duration: 1 / 30,
			scale,
			displayWidth: DISPLAY.width,
			displayHeight: DISPLAY.height,
		};
	});
	peekDisplaySize.mockImplementation(() => (displayKnown ? DISPLAY : null));
	ensureInitialized.mockImplementation(() => {});
	syncTextures.mockImplementation(({ textures: drawn }) => {
		textures.push(drawn);
	});
	// Object.create returns any: the fake target context ignores what it copies.
	getCanvas.mockImplementation(() => Object.create(null));
	renderFrame.mockImplementation((frame) => {
		frames.push(frame);
		return frames.length;
	});
});

afterEach(() => {
	displayKnown = true;
	frames.length = 0;
	textures.length = 0;
	getFrameAt.mockClear();
	peekDisplaySize.mockClear();
	ensureInitialized.mockClear();
	usePlaybackLeversStore.setState({ levers: { ...DEFAULT_PLAYBACK_LEVERS } });
});

afterAll(() => {
	getFrameAt.mockRestore();
	peekDisplaySize.mockRestore();
	ensureInitialized.mockRestore();
	syncTextures.mockRestore();
	renderFrame.mockRestore();
	getCanvas.mockRestore();
	if (originalOffscreenCanvas === undefined) {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	} else {
		Reflect.set(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	}
});

const CLIP = 4000;
// The owner's case: a 1920x1080 video on a 1080x1920 canvas shown 450 CSS px wide at DPR 1.
const OWNER_DENSITY = 450 / 1080;

function newRenderer() {
	return new CanvasRenderer({
		width: 1080,
		height: 1920,
		fps: { numerator: 30, denominator: 1 },
	});
}

function blur(intensity: number): Effect {
	return { id: "fx", type: "blur", params: { intensity }, enabled: true };
}

function scene({
	withBackdrop = false,
	elementParams,
	effects,
	scale = 1,
}: {
	withBackdrop?: boolean;
	elementParams?: Record<string, number | boolean>;
	effects?: Effect[];
	scale?: number;
} = {}) {
	const root = new RootNode({ duration: CLIP });
	const backdrop = new BlurBackgroundNode({
		mediaId: "clip",
		elementId: "el-1",
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaType: "video",
		duration: CLIP,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		blurIntensity: 100,
	});
	const video = new VideoNode({
		duration: CLIP,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { scaleX: scale, scaleY: scale, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaId: "clip",
		elementId: "el-1",
		...(elementParams && { elementParams }),
		...(effects && { effects }),
	});
	if (withBackdrop) root.add(backdrop);
	root.add(video);
	return { root, video, backdrop };
}

function scaleOfCalls(): number[] {
	return getFrameAt.mock.calls.map(([args]) => args.scale ?? 1);
}

function videoTexture(): ExternalTextureDescriptor {
	const external = textures
		.flat()
		.find((texture): texture is ExternalTextureDescriptor => texture.kind === "external");
	if (!external) throw new Error("no external texture was uploaded");
	return external;
}

function layerOf(frame: FrameDescriptor) {
	const layer = frame.items.find((item) => item.type === "layer");
	if (!layer || layer.type !== "layer") throw new Error("no layer in the frame");
	return layer;
}

describe("a render without `preview` (export, snapshot, thumbnail)", () => {
	test("asks the cache for scale 1 and uploads the full-size texture", async () => {
		const { root } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0 });
		expect(scaleOfCalls()).toEqual([1, 1]);
		expect(videoTexture().width).toBe(1920);
		expect(videoTexture().height).toBe(1080);
	});

	test("does not even look at the media's display size", async () => {
		const { root } = scene();
		await newRenderer().render({ node: root, time: 0 });
		expect(peekDisplaySize).not.toHaveBeenCalled();
	});
});

describe("renderToCanvas (snapshot, project thumbnail)", () => {
	test("asks the cache for scale 1, uploads the full-size texture and makes the draw", async () => {
		const { root } = scene({ withBackdrop: true });
		let copies = 0;
		// Object.create returns any: the target only needs a 2D context that copies.
		const targetCanvas = Object.assign(Object.create(null), {
			width: 1080,
			height: 1920,
			getContext: () => ({
				drawImage: () => {
					copies += 1;
				},
			}),
		});
		await newRenderer().renderToCanvas({ node: root, time: 0, targetCanvas });
		expect(scaleOfCalls()).toEqual([1, 1]);
		expect(videoTexture().width).toBe(1920);
		expect(videoTexture().height).toBe(1080);
		expect(copies).toBe(1);
	});
});

describe("a paused preview (sourceDensity null)", () => {
	test("is full resolution like an export, but may reuse the compositor's last draw", async () => {
		const { root } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: null } });
		expect(scaleOfCalls()).toEqual([1, 1]);
		expect(videoTexture().width).toBe(1920);
	});
});

describe("a playing or scrubbing preview", () => {
	test("the owner's case: 1920x1080 on 1080x1920 shown 450 CSS px wide asks for 0.25 and uploads 480x270", async () => {
		const { root } = scene();
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(scaleOfCalls()).toEqual([0.25]);
		expect(videoTexture().width).toBe(480);
		expect(videoTexture().height).toBe(270);
	});

	test("the layer keeps its logical size: the quad is the same at 0.25 and at 1", async () => {
		const renderer = newRenderer();
		const { root } = scene();
		await renderer.render({ node: root, time: 0 });
		await renderer.render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		const [full, small] = frames.map((frame) => layerOf(frame).transform);
		expect(small).toEqual(full);
		expect(full.width).toBe(1080);
		expect(full.height).toBeCloseTo(607.5, 5);
	});

	test("the uploaded texture is the real size of the frame, smaller than the quad it is stretched over", async () => {
		const { root } = scene();
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		const texture = videoTexture();
		expect(texture.width * texture.height).toBeLessThan(1920 * 1080);
		const layer = layerOf(frames[0]);
		expect(texture.width).toBeLessThanOrEqual(layer.transform.width);
	});

	test("a higher density asks for a larger frame, capped at full size", async () => {
		const renderer = newRenderer();
		const { root } = scene();
		await renderer.render({ node: root, time: 0, preview: { sourceDensity: 0.8 } });
		await renderer.render({ node: root, time: 0, preview: { sourceDensity: 16 } });
		expect(scaleOfCalls()).toEqual([0.5, 1]);
	});

	test("the layer's own scale counts", async () => {
		const { root } = scene({ scale: 0.5 });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: 0.8 } });
		// 0.5625 x 0.5 x 0.8 = 0.225 -> 0.25
		expect(scaleOfCalls()).toEqual([0.25]);
	});

	test("a layer scaled to 0 (a scale keyframe at 0) asks for the smallest frame", async () => {
		const { root } = scene({ scale: 0 });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(scaleOfCalls()).toEqual([1 / 16]);
		expect(videoTexture().width).toBe(120);
	});

	test("before the cache has opened the media (display size unknown) the first frame is full size", async () => {
		displayKnown = false;
		const { root, video } = scene();
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(scaleOfCalls()).toEqual([1]);
		expect(video.resolved?.sourceWidth).toBe(1920);
		expect(video.resolved?.textureWidth).toBe(1920);
	});

	test("a 3D layer is placed by the camera, not its quad: full size", async () => {
		const { root } = scene({ elementParams: { "transform3d.enabled": true } });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(scaleOfCalls()).toEqual([1]);
	});

	test("the logical size and the texture size are both on the resolved node", async () => {
		const { root, video } = scene();
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(video.resolved).toMatchObject({
			sourceWidth: 1920,
			sourceHeight: 1080,
			textureWidth: 480,
			textureHeight: 270,
		});
	});

	test("the clip's effects are resolved once, from the logical size", async () => {
		const full = scene({ effects: [blur(50)] });
		const renderer = newRenderer();
		await renderer.render({ node: full.root, time: 0 });
		const fullGroups = renderer.lastEffectWork.groups;
		const fullPasses = full.video.resolved?.effectPasses;

		const small = scene({ effects: [blur(50)] });
		await renderer.render({ node: small.root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(renderer.lastEffectWork.groups).toBe(fullGroups);
		expect(small.video.resolved?.effectPasses).toEqual(fullPasses);
	});

	test("a frame the cache gives larger than asked is uploaded at its real size", async () => {
		getFrameAt.mockImplementationOnce(async () => ({
			canvas: new OffscreenCanvas(1920, 1080),
			timestamp: 1,
			duration: 1 / 30,
			scale: 1,
			displayWidth: 1920,
			displayHeight: 1080,
		}));
		const { root } = scene();
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(videoTexture().width).toBe(1920);
		expect(layerOf(frames[0]).transform.width).toBe(1080);
	});
});

describe("the blur backdrop", () => {
	test("shares the clip's scale in the owner's case: both ask for 0.25", async () => {
		const { root, backdrop } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(backdrop.resolved?.downscale).toBe(8);
		expect(scaleOfCalls()).toEqual([0.25, 0.25]);
	});

	test("keeps the logical size of the frame whatever its canvas measures", async () => {
		const { root, backdrop } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY } });
		expect(backdrop.resolved?.backdropSource).toMatchObject({ width: 1920, height: 1080 });
	});

	test("export and a paused preview ask for full size", async () => {
		const { root } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0 });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: null } });
		expect(scaleOfCalls()).toEqual([1, 1, 1, 1]);
	});

	test("both frames are asked for before the first await (the playback tolerance is captured synchronously)", async () => {
		const { root } = scene({ withBackdrop: true });
		const renderer = newRenderer();
		const pending = renderer.render({
			node: root,
			time: 0,
			preview: { sourceDensity: OWNER_DENSITY },
		});
		expect(getFrameAt).toHaveBeenCalledTimes(2);
		await pending;
	});
});

// Lever (c): with the display-size lever on, a playing preview (renderScale
// below 1) composites a display-sized frame. Export, snapshot and thumbnail
// renders (no `preview`) and the lever off stay as they were.
describe("the display-size lever", () => {
	const lever = (on: boolean) =>
		usePlaybackLeversStore.setState({ levers: { ...DEFAULT_PLAYBACK_LEVERS, displayResolution: on } });

	test("on, playing at 0.5: a 540x960 frame on a canvas of that size, the logical quad scaled", async () => {
		lever(true);
		const { root } = scene({ withBackdrop: true });
		const renderer = newRenderer();
		await renderer.render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY, renderScale: 0.5 } });
		expect([frames[0].width, frames[0].height]).toEqual([540, 960]);
		expect(ensureInitialized.mock.calls.map(([size]) => size)).toEqual([{ width: 540, height: 960 }]);
		expect(layerOf(frames[0]).transform.width).toBe(540);
		expect(renderer.lastFrame).toBe(frames[0]);
	});

	test("on: export, snapshot and thumbnail renders (no `preview`) are full size", async () => {
		lever(true);
		const { root } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0 });
		expect([frames[0].width, frames[0].height]).toEqual([1080, 1920]);
		expect(ensureInitialized.mock.calls.map(([size]) => size)).toEqual([{ width: 1080, height: 1920 }]);
	});

	test("off: a playing preview with a render scale is full size", async () => {
		lever(false);
		const { root } = scene({ withBackdrop: true });
		await newRenderer().render({ node: root, time: 0, preview: { sourceDensity: OWNER_DENSITY, renderScale: 0.5 } });
		expect([frames[0].width, frames[0].height]).toEqual([1080, 1920]);
	});
});
