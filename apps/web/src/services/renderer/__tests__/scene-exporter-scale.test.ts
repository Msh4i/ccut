import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CanvasSource } from "mediabunny";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { scaledFrameSize } from "@/services/video-cache/frame-scale";
import { videoCache } from "@/services/video-cache/service";

// An export is full resolution, every frame drawn: the exporter never passes
// the preview's options to its renderer, so every video frame (clip and blur
// backdrop) is asked for at scale 1 and the compositor never reuses a draw.
// Runs the real SceneExporter and CanvasRenderer; only the frame cache, the
// compositor and the encoder's input (bun has no VideoEncoder) are replaced.

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	getContext() {
		return { save() {}, restore() {} };
	}
}

function replaceGlobal({ name, value }: { name: string; value: unknown }): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

const DISPLAY = { width: 1920, height: 1080 };
const FRAMES = 3;
const TICKS_PER_FRAME = 4000; // 120 000 ticks per second / 30 fps

const getFrameAt = spyOn(videoCache, "getFrameAt");
const peekDisplaySize = spyOn(videoCache, "peekDisplaySize");
const ensureInitialized = spyOn(wasmCompositor, "ensureInitialized");
const syncTextures = spyOn(wasmCompositor, "syncTextures");
const renderFrame = spyOn(wasmCompositor, "render");
const getCanvas = spyOn(wasmCompositor, "getCanvas");
const addFrame = spyOn(CanvasSource.prototype, "add");
const restores: Array<() => void> = [];

beforeAll(() => {
	restores.push(replaceGlobal({ name: "OffscreenCanvas", value: FakeOffscreenCanvas }));
	getFrameAt.mockImplementation(async ({ scale = 1 }) => {
		const size = scaledFrameSize({ ...DISPLAY, scale });
		return {
			canvas: new OffscreenCanvas(size.width, size.height),
			timestamp: 0,
			duration: 1 / 30,
			scale,
			displayWidth: DISPLAY.width,
			displayHeight: DISPLAY.height,
		};
	});
	// The media is open: a preview-resolution render would ask for less than 1.
	peekDisplaySize.mockImplementation(() => DISPLAY);
	ensureInitialized.mockImplementation(() => {});
	syncTextures.mockImplementation(() => {});
	renderFrame.mockImplementation(() => 1);
	// CanvasSource only checks that it gets a canvas (Object.create returns any).
	getCanvas.mockImplementation(() =>
		Object.assign(Object.create(FakeOffscreenCanvas.prototype), { width: 1080, height: 1920 }),
	);
	// bun has no VideoEncoder: the frames are counted, not encoded.
	addFrame.mockImplementation(async () => {});
});

afterAll(() => {
	for (const spy of [getFrameAt, peekDisplaySize, ensureInitialized, syncTextures, renderFrame, getCanvas]) {
		spy.mockRestore();
	}
	addFrame.mockRestore();
	for (const restore of restores.splice(0).reverse()) restore();
});

const { SceneExporter } = await import("../scene-exporter");
const { RootNode } = await import("../nodes/root-node");
const { VideoNode } = await import("../nodes/video-node");
const { BlurBackgroundNode } = await import("../nodes/blur-background-node");

function scene() {
	const duration = FRAMES * TICKS_PER_FRAME;
	const root = new RootNode({ duration });
	const common = {
		mediaId: "clip",
		elementId: "el-1",
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		duration,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
	};
	root.add(new BlurBackgroundNode({ ...common, mediaType: "video", blurIntensity: 100 }));
	root.add(
		new VideoNode({
			...common,
			// a small layer: what the preview would ask for least
			transform: { scaleX: 0.5, scaleY: 0.5, position: { x: 0, y: 0 }, rotate: 0 },
			opacity: 1,
		}),
	);
	return root;
}

type Outcome = { rejected: false } | { rejected: true; error: unknown };

// bun 1.2.18 does not exit after an unhandled rejection: only ever await this.
function outcomeOf({ promise }: { promise: Promise<unknown> }): Promise<Outcome> {
	return promise.then(
		(): Outcome => ({ rejected: false }),
		(error: unknown): Outcome => ({ rejected: true, error }),
	);
}

describe("SceneExporter and preview resolution", () => {
	test("every video frame of an export is asked at full size", async () => {
		const exporter = new SceneExporter({
			width: 1080,
			height: 1920,
			fps: { numerator: 30, denominator: 1 },
			format: "mp4",
			quality: "high",
		});
		// Whether the Output can finalize without encoded packets does not matter here.
		await outcomeOf({ promise: exporter.export({ rootNode: scene() }) });

		expect(addFrame).toHaveBeenCalledTimes(FRAMES);
		// a backdrop and a clip per frame
		expect(getFrameAt).toHaveBeenCalledTimes(2 * FRAMES);
		const scales = getFrameAt.mock.calls.map(([request]) => request.scale ?? 1);
		expect(scales).toEqual(new Array(2 * FRAMES).fill(1));
	});

	test("the memory guard is asked before every frame and its error stops the export", async () => {
		addFrame.mockClear();
		const asked: number[] = [];
		const exporter = new SceneExporter({
			width: 1080,
			height: 1920,
			fps: { numerator: 30, denominator: 1 },
			format: "mp4",
			quality: "high",
			memoryGuard: async ({ index }) => {
				asked.push(index);
				if (index === 1) throw new Error("memory limit");
			},
		});
		const outcome = await outcomeOf({ promise: exporter.export({ rootNode: scene() }) });

		expect(asked).toEqual([0, 1]);
		expect(outcome.rejected && outcome.error instanceof Error && outcome.error.message).toBe("memory limit");
		expect(addFrame).toHaveBeenCalledTimes(1);
	});
});
