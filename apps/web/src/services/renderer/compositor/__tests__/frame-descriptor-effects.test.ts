import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EffectPass } from "@/effects/types";
import { LAYER_3D_ENABLED_KEY } from "@/scene3d/layer-params";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";
import { CanvasRenderer } from "../../canvas-renderer";
import { BlurBackgroundNode } from "../../nodes/blur-background-node";
import { EffectLayerNode } from "../../nodes/effect-layer-node";
import { ImageNode } from "../../nodes/image-node";
import { RootNode } from "../../nodes/root-node";
import { TextNode } from "../../nodes/text-node";
import type { AnyBaseNode } from "../../nodes/base-node";
import { resolveRenderTree } from "../../resolve";
import { buildFrameDescriptor } from "../frame-descriptor";
import type { FrameDescriptor } from "../types";

// The compositor fails the whole frame on an empty effect pass group, and a
// uniform that is not a finite number turns a layer into NaN pixels. Whatever a
// node resolved to, the frame descriptor must never carry either.

// A 2D context that measures 10 px per character (text layout).
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

const TRANSFORM = { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 };

function blurPass(sigma: number): EffectPass {
	return {
		shader: "gaussian-blur",
		uniforms: { u_sigma: sigma, u_step: 1, u_direction: [1, 0] },
	};
}

const GOOD = blurPass(3);
const NAN = blurPass(Number.NaN);

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), { width: 16, height: 9 });
}

function imageNode({
	effectPasses,
	transform3d,
}: {
	effectPasses: EffectPass[][];
	transform3d?: boolean;
}): ImageNode {
	const node = new ImageNode({
		duration: 1,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: TRANSFORM,
		opacity: 1,
		url: "blob:image",
	});
	node.resolved = {
		localTime: 0,
		transform: TRANSFORM,
		opacity: 1,
		effectPasses,
		source: new OffscreenCanvas(8, 6),
		sourceWidth: 8,
		sourceHeight: 6,
		...(transform3d && {
			transform3d: {
				position: [0, 0, 0],
				orientationDeg: [0, 0, 0],
				rotationDeg: [0, 0, 0],
				scale: [1, 1, 1],
			},
		}),
	};
	return node;
}

function effectLayer(passes: EffectPass[]): EffectLayerNode {
	const node = new EffectLayerNode({
		effectType: "blur",
		effectParams: {},
		timeOffset: 0,
		duration: 1,
	});
	node.resolved = { passes };
	return node;
}

function blurBackground(passes: EffectPass[]): BlurBackgroundNode {
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
		backdropSource: { source: new OffscreenCanvas(4, 4), width: 4, height: 4 },
		passes,
		downscale: 1,
	};
	return node;
}

/** A resolved text node (2D, or a 3D layer) whose effects resolved to `effectPasses`. */
async function textNode({
	effectPasses,
	is3d,
}: {
	effectPasses: EffectPass[][];
	is3d: boolean;
}): Promise<TextNode> {
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
			...(is3d && { [LAYER_3D_ENABLED_KEY]: true }),
		},
		transform: TRANSFORM,
		opacity: 1,
		canvasCenter: { x: 8, y: 4.5 },
		canvasHeight: 9,
	});
	await resolveRenderTree({ node, renderer: renderer(), time: 0 });
	if (!node.resolved) throw new Error("text did not resolve");
	expect(Boolean(node.resolved.transform3d)).toBe(is3d);
	node.resolved = { ...node.resolved, effectPasses };
	return node;
}

async function frameOf(children: AnyBaseNode[]): Promise<FrameDescriptor> {
	const root = new RootNode({ duration: 1 });
	for (const child of children) root.add(child);
	const { frame } = await buildFrameDescriptor({ node: root, renderer: renderer() });
	return frame;
}

function groupsOf(frame: FrameDescriptor): EffectPass[][][] {
	return frame.items.map((item) => item.effectPassGroups);
}

describe("effect pass groups in the frame descriptor", () => {
	test("a clip layer drops an empty group and keeps the others in order", async () => {
		const second = blurPass(5);
		const frame = await frameOf([imageNode({ effectPasses: [[], [GOOD], [], [second]] })]);
		expect(groupsOf(frame)).toEqual([[[GOOD], [second]]]);
	});

	test("a clip layer whose only group is empty has no effects", async () => {
		const frame = await frameOf([imageNode({ effectPasses: [[]] })]);
		expect(groupsOf(frame)).toEqual([[]]);
	});

	test("a 3D clip layer drops an empty group too", async () => {
		const frame = await frameOf([imageNode({ effectPasses: [[], [GOOD]], transform3d: true })]);
		expect(groupsOf(frame)).toEqual([[[GOOD]]]);
	});

	test("a text layer, 2D or 3D, drops an empty group", async () => {
		for (const is3d of [false, true]) {
			const frame = await frameOf([await textNode({ effectPasses: [[], [GOOD]], is3d })]);
			expect(groupsOf(frame)).toEqual([[[GOOD]]]);
		}
	});

	test("a group with a NaN uniform is dropped, the layer is still drawn", async () => {
		const frame = await frameOf([imageNode({ effectPasses: [[GOOD, NAN], [GOOD]] })]);
		expect(groupsOf(frame)).toEqual([[[GOOD]]]);
	});

	test("an effect-track layer without usable passes adds no sceneEffect item", async () => {
		expect((await frameOf([effectLayer([])])).items).toEqual([]);
		expect((await frameOf([effectLayer([NAN])])).items).toEqual([]);
		expect((await frameOf([effectLayer([GOOD])])).items).toEqual([
			{ type: "sceneEffect", effectPassGroups: [[GOOD]] },
		]);
	});

	test("a blur background with broken passes is drawn without the blur", async () => {
		const frame = await frameOf([blurBackground([NAN, GOOD])]);
		expect(groupsOf(frame)).toEqual([[]]);
	});

	test("no item of a mixed scene carries an empty group", async () => {
		const frame = await frameOf([
			blurBackground([]),
			imageNode({ effectPasses: [[], [GOOD]] }),
			effectLayer([]),
			imageNode({ effectPasses: [[]], transform3d: true }),
			effectLayer([GOOD]),
		]);
		expect(frame.items.length).toBeGreaterThan(0);
		for (const groups of groupsOf(frame)) {
			for (const group of groups) {
				expect(group.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("frame descriptor contract with the Rust compositor", () => {
	// The same file is read by `rust/crates/compositor/src/frame.rs` (test
	// `the_shared_fixture_deserializes`): if a key is renamed on one side only,
	// one of the two tests fails. This is how the effect-track Blur went
	// unnoticed: the scene-effect key was read as `effect_pass_groups` in Rust.
	test("a clip blur and an effect-track blur match the fixture Rust reads", async () => {
		const frame = await frameOf([
			imageNode({ effectPasses: [[GOOD]] }),
			effectLayer([GOOD]),
		]);
		const fixture = JSON.parse(
			readFileSync(
				new URL(
					"../../../../../../../rust/crates/compositor/tests/fixtures/blur-frame.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(JSON.parse(JSON.stringify(frame))).toEqual(fixture);
	});
});
