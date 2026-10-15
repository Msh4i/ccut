import { afterAll, describe, expect, test } from "bun:test";

// The export must stop on a sticker (or any source) that cannot be loaded,
// instead of leaving it out of the video: that is the renderer's strictSources
// flag, and the exporter is what turns it on. Preview never does.

class FakeOffscreenCanvas {
	width = 0;
	height = 0;
	getContext() {
		return {};
	}
}

const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, writable: true, value: FakeOffscreenCanvas });
afterAll(() => {
	if (originalOffscreenCanvas) {
		Object.defineProperty(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	} else {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	}
});

const { CanvasRenderer } = await import("../canvas-renderer");
const { SceneExporter } = await import("../scene-exporter");

const FPS = { numerator: 30, denominator: 1 };

describe("strictSources", () => {
	test("the exporter's renderer is strict", () => {
		const exporter = new SceneExporter({ width: 64, height: 64, fps: FPS, format: "mp4", quality: "high" });
		const renderer = Reflect.get(exporter, "renderer");
		expect(renderer).toBeInstanceOf(CanvasRenderer);
		expect(renderer instanceof CanvasRenderer && renderer.strictSources).toBe(true);
	});

	test("a renderer is not strict unless asked to be (preview)", () => {
		expect(new CanvasRenderer({ width: 64, height: 64, fps: FPS }).strictSources).toBe(false);
		expect(new CanvasRenderer({ width: 64, height: 64, fps: FPS, strictSources: true }).strictSources).toBe(true);
	});
});
