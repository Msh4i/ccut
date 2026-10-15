import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { RendererManager } from "@/core/managers/renderer-manager";
import type { MediaAsset } from "@/media/types";
import {
	mainTrack,
	sceneTracks,
	seconds,
	videoElement,
} from "@/scene3d/render/__tests__/fixtures";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type {
	ExternalTextureDescriptor,
	FrameDescriptor,
	TextureUploadDescriptor,
} from "@/services/renderer/compositor/types";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import type { BuildSceneParams } from "@/services/renderer/scene-builder";
import { scaledFrameSize } from "@/services/video-cache/frame-scale";
import { videoCache } from "@/services/video-cache/service";

// A snapshot (Save / Copy snapshot) is taken while the preview may be playing.
// Resolving a render writes each node's state (`node.resolved`), and the frame
// is built from those states once every node resolved. The snapshot used to
// render the preview's own scene: when the playing preview resolved a clip
// between the snapshot's clips, the snapshot's frame took that clip from the
// preview's draw, at preview resolution (W1 review: 480x270 in a snapshot).
// The snapshot renders its own copy of the preview's scene instead, and copies
// the shared compositor canvas right after its own draw, before the preview
// can draw into it.

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

/** What createSnapshot and downloadBlob touch of the DOM: a canvas that makes a PNG, a link that is clicked. */
const fakeDocument = {
	createElement: (tag: string) =>
		tag === "canvas"
			? {
					width: 0,
					height: 0,
					getContext: () => ({
						drawImage() {
							copied.push(onCompositorCanvas);
						},
					}),
					toBlob: (done: (blob: Blob | null) => void) => done(new Blob(["png"], { type: "image/png" })),
				}
			: { href: "", download: "", click() {} },
	body: { appendChild() {}, removeChild() {} },
};

/** The video texture sizes of the frame the compositor drew last (what its canvas shows). */
let onCompositorCanvas = "";
let lastSynced = "";
/** What the snapshot's copy of the compositor canvas showed. */
const copied: string[] = [];

const DISPLAY = { width: 1920, height: 1080 };
const TIME = seconds(0.5);
const MEDIA: MediaAsset[] = [
	{ id: "clip-media", name: "clip.mp4", type: "video", file: new File([], "clip.mp4"), url: "blob:clip" },
];

const getFrameAt = spyOn(videoCache, "getFrameAt");
const peekDisplaySize = spyOn(videoCache, "peekDisplaySize");
const ensureInitialized = spyOn(wasmCompositor, "ensureInitialized");
const syncTextures = spyOn(wasmCompositor, "syncTextures");
const renderFrame = spyOn(wasmCompositor, "render");
const getCanvas = spyOn(wasmCompositor, "getCanvas");
const createObjectURL = spyOn(URL, "createObjectURL");
const revokeObjectURL = spyOn(URL, "revokeObjectURL");

type Pending = { key: string | undefined; scale: number; resolve: () => void };
const pending: Pending[] = [];
/** Whose draw syncTextures is uploading for: set by the test right before it lets that draw finish. */
let uploading = "";
const uploads: Array<{ who: string; textures: TextureUploadDescriptor[] }> = [];
const frames: Array<{ who: string; frame: FrameDescriptor }> = [];
const restores: Array<() => void> = [];

beforeAll(() => {
	restores.push(replaceGlobal({ name: "OffscreenCanvas", value: FakeOffscreenCanvas }));
	restores.push(replaceGlobal({ name: "document", value: fakeDocument }));
	// A cache that answers when the test says so, at the scale it was asked for.
	getFrameAt.mockImplementation(
		({ streamKey, scale = 1 }) =>
			new Promise((resolve) => {
				const size = scaledFrameSize({ ...DISPLAY, scale });
				pending.push({
					key: streamKey,
					scale,
					resolve: () =>
						resolve({
							canvas: new OffscreenCanvas(size.width, size.height),
							timestamp: 0.5,
							duration: 1 / 30,
							scale,
							displayWidth: DISPLAY.width,
							displayHeight: DISPLAY.height,
						}),
				});
			}),
	);
	peekDisplaySize.mockImplementation(() => DISPLAY);
	ensureInitialized.mockImplementation(() => {});
	syncTextures.mockImplementation(({ textures }) => {
		uploads.push({ who: uploading, textures });
		lastSynced = textures
			.filter((texture): texture is ExternalTextureDescriptor => texture.kind === "external")
			.map((texture) => `${texture.width}x${texture.height}`)
			.join(",");
	});
	renderFrame.mockImplementation((frame) => {
		frames.push({ who: uploading, frame });
		onCompositorCanvas = lastSynced;
		return frames.length;
	});
	// Object.create returns any: drawImage of the fake 2D context ignores it.
	getCanvas.mockImplementation(() => Object.create(null));
	createObjectURL.mockImplementation(() => "blob:snapshot");
	revokeObjectURL.mockImplementation(() => {});
});

afterEach(() => {
	pending.length = 0;
	uploads.length = 0;
	frames.length = 0;
	copied.length = 0;
	uploading = "";
	onCompositorCanvas = "";
	lastSynced = "";
});

afterAll(() => {
	for (const spy of [getFrameAt, peekDisplaySize, ensureInitialized, syncTextures, renderFrame, getCanvas]) {
		spy.mockRestore();
	}
	createObjectURL.mockRestore();
	revokeObjectURL.mockRestore();
	for (const restore of restores.splice(0).reverse()) restore();
});

/** The preview's scene inputs: two clips of one file on screen at TIME. */
function previewSceneParams(): BuildSceneParams {
	const overlay = {
		...mainTrack([videoElement({ id: "clip-b", startTime: 0, trimStart: 6, cameraTracker: null })]),
		id: "overlay",
	};
	return {
		canvasSize: { width: 1080, height: 1920 },
		tracks: sceneTracks({
			main: [videoElement({ id: "clip-a", startTime: 0, trimStart: 1, cameraTracker: null })],
			overlay: [overlay],
		}),
		mediaAssets: MEDIA,
		duration: seconds(2),
		background: { type: "color", color: "#000000" },
		isPreview: true,
	};
}

function managerFor() {
	// Object.create returns any: the fake only has what createSnapshot reads.
	const editor = Object.assign(Object.create(null), {
		project: {
			getActive: () => ({
				metadata: { name: "Snapshot test" },
				settings: {
					fps: { numerator: 30, denominator: 1 },
					canvasSize: { width: 1080, height: 1920 },
					background: { type: "color", color: "#000000" },
				},
			}),
		},
		timeline: { getTotalDuration: () => seconds(2), getLastFrameTime: () => seconds(2) },
		playback: { getCurrentTime: () => TIME },
	});
	return new RendererManager(editor);
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function takePending({ count }: { count: number }): Pending[] {
	expect(pending.length).toBe(count);
	return pending.splice(0, count);
}

/** Answers every frame request until the draws settle (bounded). */
async function answerAll(): Promise<void> {
	for (let round = 0; round < 10; round++) {
		await settle();
		for (const request of pending.splice(0)) request.resolve();
	}
}

function frameOf({ who }: { who: string }): FrameDescriptor {
	const drawn = frames.find((entry) => entry.who === who);
	if (!drawn) throw new Error(`${who} drew nothing`);
	return drawn.frame;
}

function externalSizes({ who }: { who: string }): string[] {
	const upload = uploads.find((entry) => entry.who === who);
	if (!upload) throw new Error(`${who} uploaded nothing`);
	return upload.textures
		.filter((texture): texture is ExternalTextureDescriptor => texture.kind === "external")
		.map((texture) => `${texture.width}x${texture.height}`);
}

describe("a snapshot taken while the preview plays", () => {
	test("is full resolution even when the preview resolves a clip between the snapshot's clips", async () => {
		const manager = managerFor();
		manager.setPreviewScene({ params: previewSceneParams() });
		const previewTree = manager.getRenderTree();
		if (!previewTree) throw new Error("no preview scene");

		const saved = manager.saveSnapshot();
		await settle();
		const [snapshotA, snapshotB] = takePending({ count: 2 });
		expect([snapshotA.scale, snapshotB.scale]).toEqual([1, 1]);
		snapshotA.resolve();
		await settle();

		// the playing preview's next draw, at preview resolution
		const preview = new CanvasRenderer({ width: 1080, height: 1920, fps: { numerator: 30, denominator: 1 } }).render({
			node: previewTree,
			time: TIME,
			preview: { sourceDensity: 450 / 1080 },
		});
		await settle();
		const [previewA, previewB] = takePending({ count: 2 });
		expect([previewA.scale, previewB.scale]).toEqual([0.25, 0.25]);
		previewA.resolve();
		await settle();

		// the snapshot's slower clip arrives: the snapshot builds its frame now
		uploading = "snapshot";
		snapshotB.resolve();
		expect(await saved).toEqual({ success: true });
		uploading = "preview";
		previewB.resolve();
		await preview;

		expect(externalSizes({ who: "snapshot" })).toEqual(["1920x1080", "1920x1080"]);
		expect(externalSizes({ who: "preview" })).toEqual(["480x270", "480x270"]);
	});

	test("shows exactly what the preview's scene shows at that time, at full resolution", async () => {
		const manager = managerFor();
		manager.setPreviewScene({ params: previewSceneParams() });
		const previewTree = manager.getRenderTree();
		if (!previewTree) throw new Error("no preview scene");

		uploading = "preview scene, full resolution";
		const reference = new CanvasRenderer({ width: 1080, height: 1920, fps: { numerator: 30, denominator: 1 } }).render({
			node: previewTree,
			time: TIME,
		});
		await answerAll();
		await reference;

		uploading = "snapshot";
		const saved = manager.saveSnapshot();
		await answerAll();
		expect(await saved).toEqual({ success: true });

		expect(frameOf({ who: "snapshot" })).toEqual(frameOf({ who: "preview scene, full resolution" }));
		expect(externalSizes({ who: "snapshot" })).toEqual(["1920x1080", "1920x1080"]);
		// every frame of the snapshot was asked at full size, for the clip's own stream
		expect(getFrameAt.mock.calls.slice(-2).map(([request]) => [request.streamKey, request.scale])).toEqual([
			["clip-a", 1],
			["clip-b", 1],
		]);
	});

	test("the scene the preview shows last is what the next snapshot shows", async () => {
		const manager = managerFor();
		manager.setPreviewScene({ params: previewSceneParams() });
		const oneClip = previewSceneParams();
		manager.setPreviewScene({ params: { ...oneClip, tracks: { ...oneClip.tracks, overlay: [] } } });
		uploading = "snapshot";
		const saved = manager.saveSnapshot();
		await answerAll();
		expect(await saved).toEqual({ success: true });
		expect(externalSizes({ who: "snapshot" })).toEqual(["1920x1080"]);
	});

	test("without a preview scene there is nothing to capture", async () => {
		expect(await managerFor().saveSnapshot()).toEqual({
			success: false,
			error: "No project or scene to capture",
		});
	});

	test("copies the compositor canvas right after its own draw, also when the preview's draw is ready in the same task", async () => {
		const manager = managerFor();
		manager.setPreviewScene({ params: previewSceneParams() });
		const previewTree = manager.getRenderTree();
		if (!previewTree) throw new Error("no preview scene");
		const saved = manager.saveSnapshot();
		await settle();
		const [snapshotA, snapshotB] = takePending({ count: 2 });
		snapshotA.resolve();
		const preview = new CanvasRenderer({ width: 1080, height: 1920, fps: { numerator: 30, denominator: 1 } }).render({
			node: previewTree,
			time: TIME,
			preview: { sourceDensity: 450 / 1080 },
		});
		await settle();
		const [previewA, previewB] = takePending({ count: 2 });
		previewA.resolve();
		await settle();
		// Both last frames arrive in one task: the preview's request waited behind
		// the snapshot's on the clip's stream and is answered right after it.
		snapshotB.resolve();
		previewB.resolve();
		expect(await saved).toEqual({ success: true });
		await preview;
		expect(copied).toEqual(["1920x1080,1920x1080"]);
		// the preview drew afterwards, at its own resolution
		expect(onCompositorCanvas).toBe("480x270,480x270");
	});
});
