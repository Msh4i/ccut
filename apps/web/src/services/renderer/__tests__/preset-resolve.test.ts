import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTransformedBounds, type PresetAnimations } from "@/animation/presets";
import { registerDefaultEffects } from "@/effects";
import { computeShakeOffsetPx } from "@/effects/definitions/shake";
import type { Effect } from "@/effects/types";
import type { Transform } from "@/rendering";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { EffectLayerNode } from "@/services/renderer/nodes/effect-layer-node";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { TextNode } from "@/services/renderer/nodes/text-node";
import { resolveRenderTree } from "@/services/renderer/resolve";
import { ZERO_MEDIA_TIME, mediaTime, mediaTimeToSeconds } from "@/wasm";

// Preview and export both go through resolveRenderTree, so this is where the
// presets meet the renderer. Only the 2D measuring canvas is stubbed (bun has
// no OffscreenCanvas); the GPU is never involved at this stage.

const CLIP = 4000;
const PHASE = 1000;
const CANVAS = { width: 1920, height: 1080 };
// A 512 px graphic is fitted into the 1920 x 1080 canvas as 1080 x 1080.
const FITTED = 1080;

const IDENTITY: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
};

function presets({
	phase,
	id,
}: {
	phase: "in" | "out";
	id: "fade" | "zoom" | "slide-left" | "typewriter";
}): PresetAnimations {
	const animation = { id, duration: mediaTime({ ticks: PHASE }) };
	return phase === "in" ? { in: animation } : { out: animation };
}

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), CANVAS);
}

const BLUR: Effect = {
	id: "fx",
	type: "blur",
	params: { intensity: 15 },
	enabled: true,
};

async function resolveGraphic({
	time,
	presetAnimations,
	transform = IDENTITY,
	effects = [],
}: {
	time: number;
	presetAnimations?: PresetAnimations;
	transform?: Transform;
	effects?: Effect[];
}) {
	registerDefaultEffects();
	const node = new GraphicNode({
		definitionId: "rectangle",
		params: {},
		duration: CLIP,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform,
		presetAnimations,
		opacity: 1,
		effects,
	});
	await resolveRenderTree({ node, renderer: renderer(), time });
	if (!node.resolved) throw new Error("graphic did not resolve");
	return node.resolved;
}

/** Blur sigma of the horizontal and the vertical pass. */
function blurSigmas(resolved: { effectPasses: { uniforms: Record<string, unknown> }[][] }) {
	const [passes] = resolved.effectPasses;
	return passes.map((pass) => pass.uniforms.u_sigma);
}

describe("graphic, video, image and sticker clips", () => {
	test("without presets the user's own values come through unchanged", async () => {
		const resolved = await resolveGraphic({ time: 0 });
		expect(resolved.transform).toEqual(IDENTITY);
		expect(resolved.opacity).toBe(1);
	});

	test("a clip at rest, between the phases, is unchanged", async () => {
		const resolved = await resolveGraphic({
			time: CLIP / 2,
			presetAnimations: {
				...presets({ phase: "in", id: "fade" }),
				...presets({ phase: "out", id: "fade" }),
			},
		});
		expect(resolved.opacity).toBe(1);
		expect(resolved.transform).toEqual(IDENTITY);
	});

	test("fade in multiplies the user's opacity", async () => {
		const resolved = await resolveGraphic({
			time: PHASE / 2,
			presetAnimations: presets({ phase: "in", id: "fade" }),
		});
		expect(resolved.opacity).toBe(0.5);
	});

	test("fade out is nearly transparent on the last frame", async () => {
		const resolved = await resolveGraphic({
			time: CLIP - 1,
			presetAnimations: presets({ phase: "out", id: "fade" }),
		});
		expect(resolved.opacity).toBeCloseTo(0.001, 9);
	});

	test("effect sizes follow the scale AFTER the preset (zoom starts at half size)", async () => {
		const plain = await resolveGraphic({ time: 0, effects: [BLUR] });
		// sigma = intensity / 5 * size / reference: 3 * 1080 / 1920 and 3 * 1080 / 1080.
		expect(blurSigmas(plain)).toEqual([1.6875, 3]);

		const zooming = await resolveGraphic({
			time: 0,
			effects: [BLUR],
			presetAnimations: presets({ phase: "in", id: "zoom" }),
		});
		expect(zooming.transform.scaleX).toBe(0.5);
		expect(zooming.transform.scaleY).toBe(0.5);
		expect(blurSigmas(zooming)).toEqual([0.84375, 1.5]);
	});

	test("slide-left starts with the whole clip just off the left edge", async () => {
		const resolved = await resolveGraphic({
			time: 0,
			presetAnimations: presets({ phase: "in", id: "slide-left" }),
		});
		// Right edge at -960: centre at -(960 + half of 1080).
		expect(resolved.transform.position.x).toBe(-(CANVAS.width / 2 + FITTED / 2));
		expect(resolved.transform.position.y).toBe(0);
	});

	test("the slide is added to the user's own position", async () => {
		const resolved = await resolveGraphic({
			time: 0,
			transform: { ...IDENTITY, position: { x: 100, y: 30 } },
			presetAnimations: presets({ phase: "in", id: "slide-left" }),
		});
		// The clip ends up in the same place relative to the edge: right edge at -960.
		expect(resolved.transform.position.x).toBe(-(CANVAS.width / 2 + FITTED / 2));
		expect(resolved.transform.position.y).toBe(30);
	});

	test("a rotated clip slides by its rotated box", async () => {
		const resolved = await resolveGraphic({
			time: 0,
			transform: { ...IDENTITY, rotate: 30 },
			presetAnimations: presets({ phase: "in", id: "slide-left" }),
		});
		const half = (FITTED / 2) * (Math.cos(Math.PI / 6) + Math.sin(Math.PI / 6));
		expect(resolved.transform.position.x).toBeCloseTo(-(CANVAS.width / 2 + half), 9);
		expect(resolved.transform.rotate).toBe(30);
	});
});

describe("text clips", () => {
	const originalCanvas = Reflect.get(globalThis, "OffscreenCanvas");

	// 10 px per character, so "Hello" is 50 px wide.
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

	beforeAll(() => {
		Reflect.set(
			globalThis,
			"OffscreenCanvas",
			class {
				getContext() {
					return measuringContext;
				}
			},
		);
	});

	afterAll(() => {
		if (originalCanvas === undefined) {
			Reflect.deleteProperty(globalThis, "OffscreenCanvas");
		} else {
			Reflect.set(globalThis, "OffscreenCanvas", originalCanvas);
		}
	});

	async function resolveText({
		time,
		presetAnimations,
		textAlign = "center",
		transform = IDENTITY,
	}: {
		time: number;
		presetAnimations?: PresetAnimations;
		textAlign?: "left" | "center";
		transform?: Transform;
	}) {
		const node = new TextNode({
			id: "text-1",
			type: "text",
			name: "Text",
			startTime: ZERO_MEDIA_TIME,
			duration: mediaTime({ ticks: CLIP }),
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: { content: "Hello\nWorld", fontSize: 15, textAlign },
			presetAnimations,
			transform,
			opacity: 1,
			canvasCenter: { x: CANVAS.width / 2, y: CANVAS.height / 2 },
			canvasHeight: CANVAS.height,
		});
		await resolveRenderTree({ node, renderer: renderer(), time });
		if (!node.resolved) throw new Error("text did not resolve");
		return node.resolved;
	}

	test("typewriter hands the renderer how much of each line to draw, layout stays full", async () => {
		const resolved = await resolveText({
			time: PHASE / 2,
			presetAnimations: presets({ phase: "in", id: "typewriter" }),
		});
		// 10 characters, half visible: the whole first line.
		expect(resolved.visibleLengths).toEqual([5, 0]);
		expect(resolved.measuredText.lines).toEqual(["Hello", "World"]);
		expect(resolved.opacity).toBe(1);
	});

	test("no reveal outside the phase", async () => {
		const resolved = await resolveText({
			time: CLIP / 2,
			presetAnimations: presets({ phase: "in", id: "typewriter" }),
		});
		expect(resolved.visibleLengths).toBeUndefined();
	});

	test("slide uses the real extent of the text: centred and left-aligned differ", async () => {
		const slide = presets({ phase: "in", id: "slide-left" });
		const centred = await resolveText({ time: 0, presetAnimations: slide });
		const left = await resolveText({
			time: 0,
			presetAnimations: slide,
			textAlign: "left",
		});
		// Centred: right edge at +25. Left-aligned: right edge at +50.
		expect(centred.transform.position.x).toBe(-(CANVAS.width / 2 + 25));
		expect(left.transform.position.x).toBe(-(CANVAS.width / 2 + 50));
	});

	test("rotated text is bounded rotate-first, scale-second, as it is drawn", async () => {
		const transform: Transform = { ...IDENTITY, scaleX: 2, rotate: 90 };
		const resolved = await resolveText({
			time: 0,
			transform,
			presetAnimations: presets({ phase: "in", id: "slide-left" }),
		});
		const rect = resolved.measuredText.visualRect;
		const asDrawn = getTransformedBounds({
			rect,
			scaleX: 2,
			scaleY: 1,
			rotate: 90,
			scaleAfterRotate: true,
		});
		const asQuad = getTransformedBounds({ rect, scaleX: 2, scaleY: 1, rotate: 90 });

		expect(asDrawn.right).not.toBeCloseTo(asQuad.right, 3);
		expect(resolved.transform.position.x).toBeCloseTo(
			-(CANVAS.width / 2 + asDrawn.right),
			9,
		);
	});
});

// round18: a time-based effect (shake) needs the resolver to actually thread
// "seconds since this effect instance started" through, for both a clip
// effect and the separate effect-track layer. Regression coverage for the
// resolve.ts plumbing itself, not just the pure computeShakeOffsetPx math
// (see effects/definitions/__tests__/shake.test.ts for that).
describe("time-based effects (clip effect vs. effect track)", () => {
	const SHAKE: Effect = {
		id: "shk",
		type: "shake",
		params: { intensity: 80, speed: 1 },
		enabled: true,
	};

	function shakeUniforms(resolved: {
		effectPasses: { uniforms: Record<string, unknown> }[][];
	}) {
		const [[pass]] = resolved.effectPasses;
		return pass.uniforms.u_offset;
	}

	test("a clip's shake offset changes between two timeline times, matching computeShakeOffsetPx", async () => {
		const early = await resolveGraphic({ time: 0, effects: [SHAKE] });
		const later = await resolveGraphic({ time: CLIP / 2, effects: [SHAKE] });

		expect(shakeUniforms(early)).not.toEqual(shakeUniforms(later));

		const expectedLater = computeShakeOffsetPx({
			intensity: 80,
			speed: 1,
			localTimeSeconds: mediaTimeToSeconds({ time: mediaTime({ ticks: CLIP / 2 }) }),
			durationSeconds: mediaTimeToSeconds({ time: mediaTime({ ticks: CLIP }) }),
			referenceSize: FITTED,
		});
		expect(shakeUniforms(later)).toEqual([expectedLater.x, expectedLater.y]);
	});

	test("an effect-track shake also changes over time and clamps to its own span", async () => {
		registerDefaultEffects();
		const node = new EffectLayerNode({
			effectType: "shake",
			effectParams: { intensity: 80, speed: 1 },
			timeOffset: 500,
			duration: CLIP,
		});

		async function resolveAt(time: number) {
			await resolveRenderTree({ node, renderer: renderer(), time });
			if (!node.resolved) throw new Error("effect layer did not resolve");
			return node.resolved;
		}

		const atStart = await resolveAt(500);
		const midway = await resolveAt(500 + CLIP / 2);
		const atEnd = await resolveAt(500 + CLIP); // last valid instant (inclusive)

		expect(atStart.passes[0].uniforms.u_offset).toEqual([0, 0]); // ramp-in starts at zero
		expect(midway.passes[0].uniforms.u_offset).not.toEqual(
			atStart.passes[0].uniforms.u_offset,
		);

		// At the node's last instant, localTime clamps to exactly `duration`
		// (getElementLocalTime), not something past it.
		const expectedAtDuration = computeShakeOffsetPx({
			intensity: 80,
			speed: 1,
			localTimeSeconds: mediaTimeToSeconds({ time: mediaTime({ ticks: CLIP }) }),
			durationSeconds: mediaTimeToSeconds({ time: mediaTime({ ticks: CLIP }) }),
			referenceSize: Math.min(CANVAS.width, CANVAS.height),
		});
		expect(atEnd.passes[0].uniforms.u_offset).toEqual([
			expectedAtDuration.x,
			expectedAtDuration.y,
		]);

		// Just past the node's span it stops resolving at all (handled by a
		// bounds check this test doesn't own — see resolveEffectLayerNode).
		await resolveRenderTree({
			node,
			renderer: renderer(),
			time: 500 + CLIP + 1000,
		});
		expect(node.resolved).toBeNull();
	});
});
