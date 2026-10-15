import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { usePlaybackLeversStore } from "@/services/playback-levers/store";
import { videoCache } from "@/services/video-cache/service";

// Lever b (reused textures) is for the playing preview only: the renderer asks
// the compositor to reuse only when the draw is a preview AND the lever is on.
// Export, snapshot and thumbnail renders (no `preview`) never reuse.

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return {};
	}
}

const originalOffscreenCanvas = Reflect.get(globalThis, "OffscreenCanvas");
const getFrameAt = spyOn(videoCache, "getFrameAt");
const peekDisplaySize = spyOn(videoCache, "peekDisplaySize");
const beginRender = spyOn(videoCache, "beginRender");
const endRender = spyOn(videoCache, "endRender");
const ensureInitialized = spyOn(wasmCompositor, "ensureInitialized");
const syncTextures = spyOn(wasmCompositor, "syncTextures");
const renderFrame = spyOn(wasmCompositor, "render");
const reuseFlags: boolean[] = [];

beforeAll(() => {
	Reflect.set(globalThis, "OffscreenCanvas", FakeOffscreenCanvas);
	beginRender.mockImplementation(() => ({ id: 1 }));
	endRender.mockImplementation(() => {});
	getFrameAt.mockImplementation(async () => ({
		canvas: new OffscreenCanvas(1920, 1080),
		timestamp: 1,
		duration: 1 / 30,
		scale: 1,
		displayWidth: 1920,
		displayHeight: 1080,
	}));
	peekDisplaySize.mockImplementation(() => ({ width: 1920, height: 1080 }));
	ensureInitialized.mockImplementation(() => {});
	syncTextures.mockImplementation(({ reuse }) => {
		reuseFlags.push(reuse);
	});
	renderFrame.mockImplementation(() => 1);
});

afterEach(() => {
	reuseFlags.length = 0;
	usePlaybackLeversStore.getState().setLever({ key: "bitmapUpload", on: false });
});

afterAll(() => {
	for (const spy of [getFrameAt, peekDisplaySize, beginRender, endRender, ensureInitialized, syncTextures, renderFrame]) {
		spy.mockRestore();
	}
	if (originalOffscreenCanvas === undefined) Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	else Reflect.set(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
});

function scene() {
	const root = new RootNode({ duration: 4000 });
	root.add(
		new VideoNode({
			duration: 4000,
			timeOffset: 0,
			trimStart: 0,
			trimEnd: 0,
			transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
			opacity: 1,
			url: "blob:clip",
			file: new File([], "clip.mp4"),
			mediaId: "clip",
			elementId: "el-1",
		}),
	);
	return root;
}

function renderer() {
	return new CanvasRenderer({ width: 1080, height: 1920, fps: { numerator: 30, denominator: 1 } });
}

function setBitmapLever(on: boolean) {
	usePlaybackLeversStore.getState().setLever({ key: "bitmapUpload", on });
}

describe("CanvasRenderer: when textures are reused", () => {
	test("lever on: only a preview draw reuses; a bare render (export, snapshot, thumbnail) never does", async () => {
		setBitmapLever(true);
		await renderer().render({ node: scene(), time: 0, preview: { sourceDensity: null } });
		await renderer().render({ node: scene(), time: 0 });
		expect(reuseFlags).toEqual([true, false]);
	});

	test("lever off: nothing reuses, preview or not", async () => {
		await renderer().render({ node: scene(), time: 0, preview: { sourceDensity: null } });
		await renderer().render({ node: scene(), time: 0 });
		expect(reuseFlags).toEqual([false, false]);
	});
});
