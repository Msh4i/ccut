import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CanvasRenderer } from "../../canvas-renderer";
import { BlurBackgroundNode } from "../../nodes/blur-background-node";
import { EffectLayerNode } from "../../nodes/effect-layer-node";
import { ImageNode } from "../../nodes/image-node";
import { RootNode } from "../../nodes/root-node";
import { VideoNode } from "../../nodes/video-node";
import type {
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "../../nodes/visual-node";
import type { EffectPass } from "@/effects/types";
import {
	buildFrameDescriptor,
	stringifyOmittingEffectPasses,
} from "../frame-descriptor";
import type {
	ExternalTextureDescriptor,
	FrameDescriptor,
	RenderedTextureDescriptor,
	TextureUploadDescriptor,
} from "../types";

// Video frames reach the compositor in pooled canvases that are redrawn in
// place, so the compositor only knows a layer's pixels changed when the frame
// descriptor says so: the layer texture carries the frame's `version`, and the
// blur background (a rendered texture) folds it into its content hash.

class FakeOffscreenCanvas {
	readonly width: number;
	readonly height: number;
	// Mirrors the positional DOM constructor: new OffscreenCanvas(width, height).
	constructor(...[width, height]: [number, number]) {
		this.width = width;
		this.height = height;
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

afterAll(() => {
	if (originalOffscreenCanvas) {
		Object.defineProperty(globalThis, "OffscreenCanvas", originalOffscreenCanvas);
	} else {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	}
});

const TRANSFORM = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};
const VISUAL_PARAMS: VisualNodeParams = {
	duration: 1,
	timeOffset: 0,
	trimStart: 0,
	trimEnd: 0,
	transform: TRANSFORM,
	opacity: 1,
};

// Only the size of the renderer matters to the frame descriptor.
function createRenderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), {
		width: 16,
		height: 9,
	});
}

function resolvedSource({
	source,
	version,
}: {
	source: CanvasImageSource;
	version: number | undefined;
}): ResolvedVisualSourceNodeState {
	return {
		localTime: 0,
		transform: TRANSFORM,
		opacity: 1,
		effectPasses: [],
		source,
		sourceWidth: 4,
		sourceHeight: 4,
		sourceVersion: version,
	};
}

function createVideoNode({
	source,
	version,
}: {
	source: CanvasImageSource;
	version: number | undefined;
}) {
	const node = new VideoNode({
		...VISUAL_PARAMS,
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaId: "clip",
	});
	node.resolved = resolvedSource({ source, version });
	return node;
}

function createBlurNode({
	source,
	version,
	downscale = 1,
	passes = [],
}: {
	source: CanvasImageSource;
	version: number | undefined;
	downscale?: number;
	passes?: EffectPass[];
}) {
	const node = new BlurBackgroundNode({
		mediaId: "clip",
		url: "blob:clip",
		file: new File([], "clip.mp4"),
		mediaType: "video",
		duration: 1,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		blurIntensity: 10,
	});
	node.resolved = {
		backdropSource: { source, width: 4, height: 4, version },
		passes,
		downscale,
	};
	return node;
}

function external({
	textures,
	id,
}: {
	textures: TextureUploadDescriptor[];
	id: string;
}): ExternalTextureDescriptor {
	const texture = textures.find((candidate) => candidate.id === id);
	if (texture?.kind !== "external") {
		throw new Error(`Expected an external texture "${id}"`);
	}
	return texture;
}

function rendered({
	textures,
	id,
}: {
	textures: TextureUploadDescriptor[];
	id: string;
}): RenderedTextureDescriptor {
	const texture = textures.find((candidate) => candidate.id === id);
	if (texture?.kind !== "rendered") {
		throw new Error(`Expected a rendered texture "${id}"`);
	}
	return texture;
}

async function describeFrame(children: VisualScene[]) {
	const root = new RootNode({ duration: 1 });
	for (const child of children) {
		root.add(child);
	}
	return buildFrameDescriptor({
		node: root,
		renderer: createRenderer(),
	});
}

async function describeScene(children: VisualScene[]) {
	const { textures } = await describeFrame(children);
	return textures;
}

function layerItem({ frame, textureId }: { frame: FrameDescriptor; textureId: string }) {
	const item = frame.items.find(
		(candidate) => candidate.type === "layer" && candidate.textureId === textureId,
	);
	if (item?.type !== "layer") {
		throw new Error(`Expected a layer for "${textureId}"`);
	}
	return item;
}

// What a draw did to the 2D context, in order. The stand-in below has no members
// of its own (an empty proxy target), so every property it is asked for or given
// and every call is recorded here, not only the ones a test thought to look for.
type ContextOperation =
	| { kind: "get"; name: string }
	| { kind: "set"; name: string; value: unknown }
	| { kind: "call"; name: string; args: unknown[] };

function recordDraw(texture: RenderedTextureDescriptor): ContextOperation[] {
	const operations: ContextOperation[] = [];
	const context = new Proxy<CanvasRenderingContext2D>(Object.create(null), {
		get: (_target, name) => {
			if (name === "drawImage") {
				return (...args: unknown[]) => {
					operations.push({ kind: "call", name, args });
				};
			}
			operations.push({ kind: "get", name: String(name) });
			return undefined;
		},
		set: (_target, name, value) => {
			operations.push({ kind: "set", name: String(name), value });
			return true;
		},
	});
	texture.draw(context);
	return operations;
}

function describeOperations(operations: ContextOperation[]): string[] {
	return operations.map((operation) =>
		operation.kind === "set"
			? `set ${operation.name} = ${String(operation.value)}`
			: `${operation.kind} ${operation.name}`,
	);
}

// drawImage(source, x, y, width, height): the four numbers of every drawImage call
function drawnRects(texture: RenderedTextureDescriptor): number[][] {
	return recordDraw(texture).flatMap((operation) =>
		operation.kind === "call" && operation.name === "drawImage"
			? [operation.args.slice(1).filter((arg) => typeof arg === "number")]
			: [],
	);
}

type VisualScene = VideoNode | ImageNode | BlurBackgroundNode | EffectLayerNode;

describe("a video layer's descriptor", () => {
	test("carries the version of the frame it shows", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const textures = await describeScene([
			createVideoNode({ source: canvas, version: 1.5 }),
		]);
		const texture = external({ textures, id: "root:0:source" });
		expect(texture.version).toBe(1.5);
		expect(texture.source).toBe(canvas);
		expect([texture.width, texture.height]).toEqual([4, 4]);
	});

	test("follows the frame when the same pooled canvas is redrawn with another one", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const first = await describeScene([
			createVideoNode({ source: canvas, version: 1.5 }),
		]);
		const second = await describeScene([
			createVideoNode({ source: canvas, version: 2.5 }),
		]);
		expect(external({ textures: first, id: "root:0:source" }).version).toBe(1.5);
		expect(external({ textures: second, id: "root:0:source" }).version).toBe(2.5);
	});
});

describe("an image layer's descriptor", () => {
	test("carries no version: its pixels never change", async () => {
		const node = new ImageNode({ ...VISUAL_PARAMS, url: "blob:image" });
		node.resolved = resolvedSource({
			source: new OffscreenCanvas(4, 4),
			version: undefined,
		});
		const textures = await describeScene([node]);
		const texture = external({ textures, id: "root:0:source" });
		expect(texture.version).toBeUndefined();
		expect([texture.width, texture.height]).toEqual([4, 4]);
	});
});

describe("the blur background's content hash", () => {
	async function blurHash({
		source,
		version,
	}: {
		source: CanvasImageSource;
		version: number | undefined;
	}) {
		const textures = await describeScene([createBlurNode({ source, version })]);
		return rendered({ textures, id: "root:0:blur-background" }).contentHash;
	}

	test("changes with the version of the backdrop frame", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const first = await blurHash({ source: canvas, version: 1.5 });
		const second = await blurHash({ source: canvas, version: 2.5 });
		expect(second).not.toBe(first);
	});

	test("stays the same for the same frame, so a frozen frame is not blurred again", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const first = await blurHash({ source: canvas, version: 1.5 });
		const again = await blurHash({ source: canvas, version: 1.5 });
		expect(again).toBe(first);
	});

	test("changes with the backdrop object", async () => {
		const first = await blurHash({
			source: new OffscreenCanvas(4, 4),
			version: 1.5,
		});
		const other = await blurHash({
			source: new OffscreenCanvas(4, 4),
			version: 1.5,
		});
		expect(other).not.toBe(first);
	});

	test("a still image backdrop (no version) stays the same", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const first = await blurHash({ source: canvas, version: undefined });
		const again = await blurHash({ source: canvas, version: undefined });
		expect(again).toBe(first);
	});
});

describe("the blur background's backdrop texture", () => {
	const backdropId = "root:0:blur-background";
	const BLUR_PASSES: EffectPass[] = [
		{
			shader: "gaussian-blur",
			uniforms: { u_sigma: 3, u_step: 1, u_direction: [1, 0] },
		},
		{
			shader: "gaussian-blur",
			uniforms: { u_sigma: 3, u_step: 1, u_direction: [0, 1] },
		},
	];

	async function backdropOf({ downscale, source }: { downscale: number; source?: CanvasImageSource }) {
		const { frame, textures } = await describeFrame([
			createBlurNode({
				source: source ?? new OffscreenCanvas(4, 4),
				version: 1.5,
				downscale,
				passes: BLUR_PASSES,
			}),
		]);
		return { frame, texture: rendered({ textures, id: backdropId }) };
	}

	test("without a downscale it is as big as the frame (16x9)", async () => {
		const { texture } = await backdropOf({ downscale: 1 });
		expect([texture.width, texture.height]).toEqual([16, 9]);
	});

	test("a downscale makes the texture that many times smaller, rounded up", async () => {
		const { texture } = await backdropOf({ downscale: 4 });
		expect([texture.width, texture.height]).toEqual([4, 3]);
		const eight = await backdropOf({ downscale: 8 });
		expect([eight.texture.width, eight.texture.height]).toEqual([2, 2]);
	});

	test("the layer still covers the whole frame and keeps the blur passes", async () => {
		for (const downscale of [1, 4, 8]) {
			const { frame } = await backdropOf({ downscale });
			const layer = layerItem({ frame, textureId: backdropId });
			expect(layer.transform).toEqual({
				centerX: 8,
				centerY: 4.5,
				width: 16,
				height: 9,
				rotationDegrees: 0,
				flipX: false,
				flipY: false,
			});
			expect(layer.effectPassGroups).toEqual([BLUR_PASSES]);
			expect(layer.opacity).toBe(1);
			expect(layer.blendMode).toBe("normal");
			expect(layer.mask).toBeNull();
			expect([frame.width, frame.height]).toEqual([16, 9]);
		}
	});

	test("at full size the backdrop is cover-scaled into the frame as before", async () => {
		const { texture } = await backdropOf({ downscale: 1 });
		// 4x4 source, 16x9 frame: scale 4, 16x16 picture, centred (-3.5 above the frame)
		expect(drawnRects(texture)).toEqual([[0, -3.5, 16, 16]]);
	});

	test("downscaled, it is cover-scaled into the smaller texture the same way", async () => {
		const { texture } = await backdropOf({ downscale: 4 });
		const [rect] = drawnRects(texture);
		// the 4x3 texture is stretched over the 16x9 frame: x by 4/16, y by 3/9
		expect(rect[0]).toBeCloseTo(0, 6);
		expect(rect[1]).toBeCloseTo(-3.5 * (3 / 9), 6);
		expect(rect[2]).toBeCloseTo(16 * (4 / 16), 6);
		expect(rect[3]).toBeCloseTo(16 * (3 / 9), 6);
		expect(drawnRects(texture)).toHaveLength(1);
	});

	test("downscaled, it asks for high quality smoothing before it draws", async () => {
		// A frame cover-scaled to a texture k times smaller would alias with the
		// default two-tap filter: fine detail turns into blobs that flicker as
		// the video moves, and the blur (at frame resolution) cannot hide them.
		const { texture } = await backdropOf({ downscale: 4 });
		expect(describeOperations(recordDraw(texture))).toEqual([
			"set imageSmoothingEnabled = true",
			"set imageSmoothingQuality = high",
			"call drawImage",
		]);
	});

	test("at full size the context is left alone: one drawImage and nothing else", async () => {
		const { texture } = await backdropOf({ downscale: 1 });
		expect(describeOperations(recordDraw(texture))).toEqual(["call drawImage"]);
	});

	test("no blur passes (an intensity of 0) means no effect groups, not one empty group", async () => {
		// The compositor treats a non-empty group list as "apply effects" and fails
		// on an empty group, so a backdrop without passes must carry none.
		const { frame } = await describeFrame([
			createBlurNode({ source: new OffscreenCanvas(4, 4), version: 1.5, passes: [] }),
		]);
		expect(layerItem({ frame, textureId: backdropId }).effectPassGroups).toEqual([]);
	});

	test("its content hash changes with the downscale", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const full = await backdropOf({ downscale: 1, source: canvas });
		const quarter = await backdropOf({ downscale: 4, source: canvas });
		const eighth = await backdropOf({ downscale: 8, source: canvas });
		const hashes = new Set([
			full.texture.contentHash,
			quarter.texture.contentHash,
			eighth.texture.contentHash,
		]);
		expect(hashes.size).toBe(3);
	});

	test("its content hash stays the same for the same frame and downscale", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const first = await backdropOf({ downscale: 4, source: canvas });
		const again = await backdropOf({ downscale: 4, source: canvas });
		expect(again.texture.contentHash).toBe(first.texture.contentHash);
	});

	test("on a bigger canvas the texture is bigger and the content hash is another one", async () => {
		const canvas = new OffscreenCanvas(4, 4);
		const node = createBlurNode({ source: canvas, version: 1.5, downscale: 4 });
		const root = new RootNode({ duration: 1 });
		root.add(node);
		const small = await buildFrameDescriptor({
			node: root,
			renderer: createRenderer(),
		});
		const wideRenderer = Object.assign(Object.create(CanvasRenderer.prototype), {
			width: 32,
			height: 18,
		});
		const wide = await buildFrameDescriptor({ node: root, renderer: wideRenderer });
		const smallTexture = rendered({ textures: small.textures, id: backdropId });
		const wideTexture = rendered({ textures: wide.textures, id: backdropId });
		expect([wideTexture.width, wideTexture.height]).toEqual([8, 5]);
		expect(wideTexture.contentHash).not.toBe(smallTexture.contentHash);
	});
});

describe("an effect-track clip's descriptor", () => {
	test("is a sceneEffect item with exactly the keys the Rust compositor reads", async () => {
		const passes: EffectPass[] = [
			{ shader: "flash", uniforms: { u_amount: 0.5, u_whiteness: 1 } },
		];
		const node = new EffectLayerNode({
			effectType: "flash",
			effectParams: {},
			timeOffset: 0,
			duration: 1,
		});
		node.resolved = { passes };

		const { frame } = await describeFrame([node]);

		// The same shape rust/crates/compositor/src/frame.rs's
		// deserializes_the_scene_effect_item_typescript_sends test parses: a
		// key renamed on either side fails one of the two tests.
		expect(frame.items).toEqual([{ type: "sceneEffect", effectPassGroups: [passes] }]);
	});
});

describe("stringifyOmittingEffectPasses", () => {
	test("drops effectPasses wherever it appears, keeping everything else", () => {
		const before = {
			params: { text: "hello" },
			resolved: {
				transform: { x: 1, y: 2 },
				effectPasses: [[{ shader: "shake", uniforms: { u_offset: [1, 2] } }]],
			},
		};
		const after = {
			params: { text: "hello" },
			resolved: {
				transform: { x: 1, y: 2 },
				effectPasses: [[{ shader: "shake", uniforms: { u_offset: [99, -99] } }]],
			},
		};
		expect(stringifyOmittingEffectPasses({ value: before })).toBe(
			stringifyOmittingEffectPasses({ value: after }),
		);
	});

	test("still distinguishes states that differ outside effectPasses", () => {
		const a = { resolved: { transform: { x: 1 }, effectPasses: [] } };
		const b = { resolved: { transform: { x: 2 }, effectPasses: [] } };
		expect(stringifyOmittingEffectPasses({ value: a })).not.toBe(
			stringifyOmittingEffectPasses({ value: b }),
		);
	});
});
