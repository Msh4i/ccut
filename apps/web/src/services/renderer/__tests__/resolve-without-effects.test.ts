import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { effectPassesOfFrame } from "@/diagnostics/playback-hud/session";
import { registerDefaultEffects } from "@/effects";
import type { Effect } from "@/effects/types";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type { FrameDescriptor } from "@/services/renderer/compositor/types";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";
import { EffectLayerNode } from "@/services/renderer/nodes/effect-layer-node";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { TextNode } from "@/services/renderer/nodes/text-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { resolveRenderTree } from "@/services/renderer/resolve";
import { videoCache } from "@/services/video-cache/service";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

// When a frame fails in the compositor, the preview draws it once more without
// effects (render-gate.ts, drawPreviewFrame). "Without effects" means: no
// Effects-panel effect on a clip, no effect-track layer, and no resolution of
// them at all, so an effect that cannot even be resolved (an unknown type from
// another version's project) cannot fail the retry. The project's background
// blur stays as it is: dropping it would change the whole background and make
// every retried frame upload a full-size backdrop.

registerDefaultEffects();

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
	}
	// Measures 10 px per character (text layout).
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
const ensureInitialized = spyOn(wasmCompositor, "ensureInitialized");
const syncTextures = spyOn(wasmCompositor, "syncTextures");
const renderFrame = spyOn(wasmCompositor, "render");
const drawnFrames: FrameDescriptor[] = [];

beforeAll(() => {
	Reflect.set(globalThis, "OffscreenCanvas", FakeOffscreenCanvas);
	getFrameAt.mockImplementation(async () => ({
		canvas: new OffscreenCanvas(1920, 1080),
		timestamp: 1,
		duration: 1 / 30,
		scale: 1,
		displayWidth: 1920,
		displayHeight: 1080,
	}));
	ensureInitialized.mockImplementation(() => {});
	syncTextures.mockImplementation(() => {});
	renderFrame.mockImplementation((frame) => {
		drawnFrames.push(frame);
		return drawnFrames.length;
	});
});

afterAll(() => {
	getFrameAt.mockRestore();
	ensureInitialized.mockRestore();
	syncTextures.mockRestore();
	renderFrame.mockRestore();
	if (originalOffscreenCanvas === undefined) {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	} else {
		Reflect.set(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	}
});

const CLIP = 4000;

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), {
		width: 1080,
		height: 1920,
	});
}

function blur(intensity: number): Effect {
	return { id: "fx", type: "blur", params: { intensity }, enabled: true };
}

function scene({
	clipEffects,
	withEffectLayer = true,
}: {
	clipEffects: Effect[];
	withEffectLayer?: boolean;
}) {
	const backdrop = new BlurBackgroundNode({
		mediaId: "clip",
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
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		effects: clipEffects,
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaId: "clip",
	});
	const effectLayer = new EffectLayerNode({
		effectType: "blur",
		effectParams: { intensity: 30 },
		timeOffset: 0,
		duration: CLIP,
	});
	const text = new TextNode({
		id: "text-1",
		type: "text",
		name: "Text",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: CLIP }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: "Hello", fontSize: 15, textAlign: "center" },
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		effects: clipEffects,
		canvasCenter: { x: 540, y: 960 },
		canvasHeight: 1920,
	});
	const root = new RootNode({ duration: CLIP });
	root.add(backdrop);
	root.add(video);
	root.add(text);
	if (withEffectLayer) root.add(effectLayer);
	return { root, backdrop, video, text, effectLayer };
}

function effectGroupsOf(frame: FrameDescriptor): number {
	return frame.items.reduce((sum, item) => sum + item.effectPassGroups.length, 0);
}

describe("resolveRenderTree without effects", () => {
	test("with effects (the default) every effect resolves", async () => {
		const { root, backdrop, video, text, effectLayer } = scene({ clipEffects: [blur(50)] });
		await resolveRenderTree({ node: root, renderer: renderer(), time: 0 });
		expect(video.resolved?.effectPasses).toHaveLength(1);
		expect(text.resolved?.effectPasses).toHaveLength(1);
		expect(effectLayer.resolved?.passes.length).toBeGreaterThan(0);
		expect(backdrop.resolved?.passes.length).toBeGreaterThan(0);
		expect(backdrop.resolved?.downscale).toBeGreaterThan(1);
	});

	test("without effects: no clip effect, no effect layer, the background blur unchanged", async () => {
		const { root, backdrop, video, text, effectLayer } = scene({ clipEffects: [blur(50)] });
		await resolveRenderTree({ node: root, renderer: renderer(), time: 0 });
		const blurredBackdrop = backdrop.resolved;

		await resolveRenderTree({ node: root, renderer: renderer(), time: 0, effects: false });
		expect(video.resolved?.effectPasses).toEqual([]);
		expect(video.resolved?.source).toBeDefined();
		expect(text.resolved?.effectPasses).toEqual([]);
		expect(text.resolved?.measuredText).toBeDefined();
		expect(effectLayer.resolved).toBeNull();
		expect(backdrop.resolved).toEqual(blurredBackdrop);
	});

	test("an effect that cannot be resolved fails the frame with effects, not without", async () => {
		const unknown: Effect = { id: "fx", type: "no-such-effect", params: {}, enabled: true };
		const { root } = scene({ clipEffects: [unknown] });
		await expect(
			resolveRenderTree({ node: root, renderer: renderer(), time: 0 }),
		).rejects.toThrow("Unknown effect");
		await resolveRenderTree({ node: root, renderer: renderer(), time: 0, effects: false });
	});
});

describe("CanvasRenderer.render without effects", () => {
	test("hands the compositor a frame with only the background blur's group and no scene effect", async () => {
		const canvasRenderer = new CanvasRenderer({
			width: 1080,
			height: 1920,
			fps: { numerator: 30, denominator: 1 },
		});
		const { root } = scene({ clipEffects: [blur(50)] });

		drawnFrames.length = 0;
		await canvasRenderer.render({ node: root, time: 0 });
		await canvasRenderer.render({ node: root, time: 0, effects: false });
		expect(drawnFrames).toHaveLength(2);
		const [withEffects, withoutEffects] = drawnFrames;
		// backdrop, video, text, effect layer
		expect(effectGroupsOf(withEffects)).toBe(4);
		expect(withEffects.items.some((item) => item.type === "sceneEffect")).toBe(true);
		// the backdrop's blur only
		expect(effectGroupsOf(withoutEffects)).toBe(1);
		expect(withoutEffects.items[0].effectPassGroups).toEqual(withEffects.items[0].effectPassGroups);
		expect(withoutEffects.items.some((item) => item.type === "sceneEffect")).toBe(false);
		// the backdrop, the video and the text are still drawn
		expect(withoutEffects.items.filter((item) => item.type === "layer")).toHaveLength(3);
	});

	test("keeps the last frame it handed to the compositor (the playback HUD counts its passes)", async () => {
		const canvasRenderer = new CanvasRenderer({
			width: 1080,
			height: 1920,
			fps: { numerator: 30, denominator: 1 },
		});
		expect(canvasRenderer.lastFrame).toBeNull();
		const { root } = scene({ clipEffects: [blur(50)] });

		drawnFrames.length = 0;
		await canvasRenderer.render({ node: root, time: 0 });
		expect(canvasRenderer.lastFrame).toBe(drawnFrames[0]);
		expect(effectPassesOfFrame(canvasRenderer.lastFrame)).toBeGreaterThan(0);

		const withEffects = effectPassesOfFrame(canvasRenderer.lastFrame);
		await canvasRenderer.render({ node: root, time: 0, effects: false });
		expect(canvasRenderer.lastFrame).toBe(drawnFrames[1]);
		// what is left are the background blur's passes
		const backdropPasses = drawnFrames[1].items[0].effectPassGroups.flat().length;
		expect(backdropPasses).toBeGreaterThan(0);
		expect(effectPassesOfFrame(canvasRenderer.lastFrame)).toBe(backdropPasses);
		expect(backdropPasses).toBeLessThan(withEffects);
	});
});

// The preview retries a failed frame without effects only when the frame had
// Effects-panel work: a surface error (a lost or outdated canvas) on a project
// without effects must not be reported as "an effect could not be drawn".
describe("the Effects-panel work of a render", () => {
	function canvasRenderer(): CanvasRenderer {
		return new CanvasRenderer({
			width: 1080,
			height: 1920,
			fps: { numerator: 30, denominator: 1 },
		});
	}

	test("counts the clip effect groups and the effect-track layers, not the background blur", async () => {
		const renderer = canvasRenderer();
		expect(renderer.lastEffectWork.groups).toBe(0);
		// video + text with a blur each, one effect layer; the backdrop's blur does not count
		await renderer.render({ node: scene({ clipEffects: [blur(50)] }).root, time: 0 });
		expect(renderer.lastEffectWork.groups).toBe(3);
	});

	test("a project with only the background blur has none", async () => {
		const renderer = canvasRenderer();
		await renderer.render({
			node: scene({ clipEffects: [], withEffectLayer: false }).root,
			time: 0,
		});
		expect(renderer.lastEffectWork.groups).toBe(0);
	});

	test("a blur with nothing to do (intensity 0) is no work", async () => {
		const renderer = canvasRenderer();
		await renderer.render({
			node: scene({ clipEffects: [blur(0)], withEffectLayer: false }).root,
			time: 0,
		});
		expect(renderer.lastEffectWork.groups).toBe(0);
	});

	test("an effect that fails to resolve counts, so the failed frame is retried without it", async () => {
		const renderer = canvasRenderer();
		const unknown: Effect = { id: "fx", type: "no-such-effect", params: {}, enabled: true };
		await expect(
			renderer.render({ node: scene({ clipEffects: [unknown], withEffectLayer: false }).root, time: 0 }),
		).rejects.toThrow("Unknown effect");
		expect(renderer.lastEffectWork.groups).toBeGreaterThan(0);
	});

	test("the draw without effects has none, and each render starts from 0", async () => {
		const renderer = canvasRenderer();
		const { root } = scene({ clipEffects: [blur(50)] });
		await renderer.render({ node: root, time: 0 });
		await renderer.render({ node: root, time: 0, effects: false });
		expect(renderer.lastEffectWork.groups).toBe(0);
	});
});
