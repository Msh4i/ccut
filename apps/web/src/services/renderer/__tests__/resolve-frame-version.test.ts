import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import type { VisualNodeParams } from "@/services/renderer/nodes/visual-node";
import { resolveRenderTree } from "@/services/renderer/resolve";
import { videoCache } from "@/services/video-cache/service";

// The decoder hands video frames out in a small pool of canvases and redraws
// them in place, so the canvas a node resolves to is not proof of its pixels.
// resolveRenderTree passes the frame's timestamp on as the version the
// compositor's texture cache (and the blur background's content hash) goes by.

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
}

// An 800x600 picture that "loads" as soon as its source is set.
class FakeImage {
	naturalWidth = 800;
	naturalHeight = 600;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	set src(_url: string) {
		queueMicrotask(() => this.onload?.());
	}
}

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(
	globalThis,
	"OffscreenCanvas",
);

beforeAll(() => {
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: FakeOffscreenCanvas,
	});
});

const getFrameAt = spyOn(videoCache, "getFrameAt");

afterEach(() => {
	getFrameAt.mockReset();
});

afterAll(() => {
	getFrameAt.mockRestore();
	if (originalOffscreenCanvas) {
		Object.defineProperty(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	} else {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	}
});

const CLIP = 4000;

const VISUAL_PARAMS: VisualNodeParams = {
	duration: CLIP,
	timeOffset: 0,
	trimStart: 0,
	trimEnd: 0,
	transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
	opacity: 1,
};

function renderer({
	width = 1920,
	height = 1080,
}: { width?: number; height?: number } = {}): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), {
		width,
		height,
	});
}

function frameOf({
	canvas,
	timestamp,
}: {
	canvas: OffscreenCanvas;
	timestamp: number;
}) {
	return {
		canvas,
		timestamp,
		duration: 1 / 30,
		scale: 1,
		displayWidth: canvas.width,
		displayHeight: canvas.height,
	};
}

function createVideoNode() {
	return new VideoNode({
		...VISUAL_PARAMS,
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaId: "clip",
	});
}

function createBlurNode({
	mediaType,
	blurIntensity = 10,
}: {
	mediaType: "video" | "image";
	blurIntensity?: number;
}) {
	return new BlurBackgroundNode({
		mediaId: "clip",
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaType,
		duration: CLIP,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		blurIntensity,
	});
}

describe("a video node", () => {
	test("resolves to the decoded canvas and the timestamp of its frame as version", async () => {
		const canvas = new OffscreenCanvas(1280, 720);
		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 2.5 }));
		const node = createVideoNode();

		await resolveRenderTree({ node, renderer: renderer(), time: 0 });

		expect(node.resolved?.source).toBe(canvas);
		expect(node.resolved?.sourceVersion).toBe(2.5);
	});

	test("the version follows the frame when the decoder redraws the same canvas", async () => {
		const canvas = new OffscreenCanvas(1280, 720);
		const node = createVideoNode();

		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 1 }));
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		expect(node.resolved?.sourceVersion).toBe(1);

		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 4 }));
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		expect(node.resolved?.source).toBe(canvas);
		expect(node.resolved?.sourceVersion).toBe(4);
	});

	test("a frame at timestamp 0 is a version too, not a missing one", async () => {
		const canvas = new OffscreenCanvas(1280, 720);
		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 0 }));
		const node = createVideoNode();

		await resolveRenderTree({ node, renderer: renderer(), time: 0 });

		expect(node.resolved?.sourceVersion).toBe(0);
	});
});

describe("a blur background over a video", () => {
	test("resolves to the decoded canvas and the timestamp of its frame as version", async () => {
		const canvas = new OffscreenCanvas(1280, 720);
		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 2.5 }));
		const node = createBlurNode({ mediaType: "video" });

		await resolveRenderTree({ node, renderer: renderer(), time: 0 });

		expect(node.resolved?.backdropSource.source).toBe(canvas);
		expect(node.resolved?.backdropSource.version).toBe(2.5);
	});

	test("the version follows the frame when the decoder redraws the same canvas", async () => {
		const canvas = new OffscreenCanvas(1280, 720);
		const node = createBlurNode({ mediaType: "video" });

		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 1 }));
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		expect(node.resolved?.backdropSource.version).toBe(1);

		getFrameAt.mockResolvedValue(frameOf({ canvas, timestamp: 4 }));
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		expect(node.resolved?.backdropSource.version).toBe(4);
	});
});

describe("a blur background's backdrop downscale", () => {
	async function downscaleOf({
		blurIntensity,
		width,
		height,
	}: {
		blurIntensity: number;
		width: number;
		height: number;
	}) {
		getFrameAt.mockResolvedValue(
			frameOf({ canvas: new OffscreenCanvas(1920, 1080), timestamp: 1 }),
		);
		const node = createBlurNode({ mediaType: "video", blurIntensity });
		await resolveRenderTree({ node, renderer: renderer({ width, height }), time: 0 });
		return node.resolved?.downscale;
	}

	test("a strong blur on a 1080x1920 canvas shrinks the backdrop to the cap", async () => {
		// sigma 22.5 x 71.1: the weaker horizontal axis allows far more than 8
		expect(await downscaleOf({ blurIntensity: 200, width: 1080, height: 1920 })).toBe(8);
	});

	test("the default blur on a 1080x1920 canvas keeps the backdrop full size", async () => {
		// sigma 1.1 x 3.6: too weak a blur to hide a resample
		expect(await downscaleOf({ blurIntensity: 10, width: 1080, height: 1920 })).toBe(1);
	});

	test("follows the weaker of the two sigmas on a 1920x1080 canvas", async () => {
		// intensity 20: sigma 4 x 4 -> floor(1.1 * 4) = 4
		expect(await downscaleOf({ blurIntensity: 20, width: 1920, height: 1080 })).toBe(4);
	});

	test("follows the weaker of the two sigmas also when that is the vertical one", async () => {
		// intensity 20 on 2560x1080: sigma 5.33 x 4, so the vertical axis limits it:
		// floor(1.1 * 4) = 4, not floor(1.1 * 5.33) = 5
		expect(await downscaleOf({ blurIntensity: 20, width: 2560, height: 1080 })).toBe(4);
	});

	test("follows the weaker of the two sigmas also when that is the horizontal one", async () => {
		// intensity 20 on 1080x1920: sigma 2.25 x 7.11, so the horizontal axis limits it:
		// floor(1.1 * 2.25) = 2, not floor(1.1 * 7.11) = 7
		expect(await downscaleOf({ blurIntensity: 20, width: 1080, height: 1920 })).toBe(2);
	});

	test("an intensity of 0 resolves to no blur passes and a full-size backdrop", async () => {
		getFrameAt.mockResolvedValue(
			frameOf({ canvas: new OffscreenCanvas(1920, 1080), timestamp: 1 }),
		);
		const node = createBlurNode({ mediaType: "video", blurIntensity: 0 });
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		expect(node.resolved?.passes).toEqual([]);
		expect(node.resolved?.downscale).toBe(1);
	});

	test("grows with the intensity", async () => {
		const small = await downscaleOf({ blurIntensity: 15, width: 1920, height: 1080 });
		const large = await downscaleOf({ blurIntensity: 30, width: 1920, height: 1080 });
		expect(small).toBe(3);
		expect(large).toBe(6);
	});

	test("an image backdrop gets it too", async () => {
		const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");
		Object.defineProperty(globalThis, "Image", {
			configurable: true,
			writable: true,
			value: FakeImage,
		});
		try {
			const node = createBlurNode({ mediaType: "image", blurIntensity: 100 });
			await resolveRenderTree({ node, renderer: renderer(), time: 0 });
			expect(node.resolved?.backdropSource.width).toBe(800);
			expect(node.resolved?.downscale).toBe(8);
		} finally {
			if (originalImage) {
				Object.defineProperty(globalThis, "Image", originalImage);
			} else {
				Reflect.deleteProperty(globalThis, "Image");
			}
		}
	});

	test("a strong blur on a 1080x1920 canvas takes two passes at the frame's own sigma, not eight", async () => {
		getFrameAt.mockResolvedValue(
			frameOf({ canvas: new OffscreenCanvas(1920, 1080), timestamp: 1 }),
		);
		const node = createBlurNode({ mediaType: "video", blurIntensity: 200 });
		await resolveRenderTree({
			node,
			renderer: renderer({ width: 1080, height: 1920 }),
			time: 0,
		});
		const sigmas = node.resolved?.passes.map((pass) => pass.uniforms.u_sigma);
		// sigma 22.5 horizontally, 71.1 vertically, one pass each
		expect(sigmas).toHaveLength(2);
		expect(sigmas?.[0]).toBeCloseTo(22.5, 6);
		expect(sigmas?.[1]).toBeCloseTo(71.11, 2);
	});

	test("the passes still blur at the frame's own sigma", async () => {
		getFrameAt.mockResolvedValue(
			frameOf({ canvas: new OffscreenCanvas(1920, 1080), timestamp: 1 }),
		);
		const node = createBlurNode({ mediaType: "video", blurIntensity: 20 });
		await resolveRenderTree({ node, renderer: renderer(), time: 0 });
		const sigmas = node.resolved?.passes.map((pass) => pass.uniforms.u_sigma);
		// 4 px per axis, one horizontal and one vertical pass
		expect(sigmas).toEqual([4, 4]);
	});
});
