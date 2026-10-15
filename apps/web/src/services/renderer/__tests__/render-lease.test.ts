import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { type RenderLease, videoCache } from "@/services/video-cache/service";

// Every render asks its video frames under one lease of the frame cache and
// ends it once the compositor uploaded them, or when the render fails: the
// canvases are not recycled by another render (the playing preview) before
// this one uploaded them.

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
const events: string[] = [];
const getFrameAt = spyOn(videoCache, "getFrameAt");
const peekDisplaySize = spyOn(videoCache, "peekDisplaySize");
const beginRender = spyOn(videoCache, "beginRender");
const endRender = spyOn(videoCache, "endRender");
const ensureInitialized = spyOn(wasmCompositor, "ensureInitialized");
const syncTextures = spyOn(wasmCompositor, "syncTextures");
const renderFrame = spyOn(wasmCompositor, "render");
let failUpload = false;
let leases = 0;

beforeAll(() => {
	Reflect.set(globalThis, "OffscreenCanvas", FakeOffscreenCanvas);
	beginRender.mockImplementation(() => {
		leases += 1;
		events.push(`begin ${leases}`);
		return { id: leases };
	});
	endRender.mockImplementation(({ lease }: { lease: RenderLease }) => {
		events.push(`end ${lease.id}`);
	});
	getFrameAt.mockImplementation(async ({ lease }) => {
		events.push(`frame under ${lease?.id ?? "none"}`);
		return {
			canvas: new OffscreenCanvas(1920, 1080),
			timestamp: 1,
			duration: 1 / 30,
			scale: 1,
			displayWidth: 1920,
			displayHeight: 1080,
		};
	});
	peekDisplaySize.mockImplementation(() => ({ width: 1920, height: 1080 }));
	ensureInitialized.mockImplementation(() => {});
	syncTextures.mockImplementation(() => {
		if (failUpload) throw new Error("upload failed");
		events.push("upload");
	});
	renderFrame.mockImplementation(() => {
		events.push("draw");
		return 1;
	});
});

afterEach(() => {
	events.length = 0;
	failUpload = false;
	leases = 0;
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

describe("CanvasRenderer: the video frames' lease", () => {
	test("frames are asked under the render's lease, which ends after the upload", async () => {
		await renderer().render({ node: scene(), time: 0 });
		expect(events).toEqual(["begin 1", "frame under 1", "upload", "draw", "end 1"]);
	});

	test("a render that fails still ends its lease, and the failure reaches the caller", async () => {
		failUpload = true;
		const outcome = await renderer()
			.render({ node: scene(), time: 0 })
			.then(
				() => "drawn",
				(error: unknown) => String(error),
			);
		expect(outcome).toBe("Error: upload failed");
		expect(events.filter((event) => event.startsWith("begin") || event.startsWith("end"))).toEqual([
			"begin 1",
			"end 1",
		]);
	});
});
