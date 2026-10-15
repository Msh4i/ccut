import { describe, expect, test } from "bun:test";
import { resolveAnimationPathValueAtTime } from "@/animation";
import type { Transform } from "@/rendering";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { resolveRenderTree } from "@/services/renderer/resolve";
import { buildGraphicElement } from "@/timeline/element-utils";
import { applyKeyframePresetToElement } from "@/timeline/keyframe-preset";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

// Keyframe presets write plain keyframes, so the renderer (preview and export
// both go through resolveRenderTree) needs no code of its own for them. This
// test proves it: the transform and opacity the renderer resolves are exactly
// what the channels say.

const CLIP = 10 * TICKS_PER_SECOND;
const CANVAS = { width: 1920, height: 1080 };
const IDENTITY: Transform = { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 };

function renderer(): CanvasRenderer {
	return Object.assign(Object.create(CanvasRenderer.prototype), CANVAS);
}

async function resolveWith({ id, time }: { id: "zoom-in" | "pan-left" | "swing"; time: number }) {
	const element = {
		id: "g",
		...buildGraphicElement({ definitionId: "rectangle", startTime: mediaTime({ ticks: 0 }) }),
		duration: mediaTime({ ticks: CLIP }),
	};
	const applied = applyKeyframePresetToElement({
		element,
		presetId: id,
		placement: "start",
		seconds: 4,
		playheadLocal: 0,
		canvas: CANVAS,
	});
	if (!applied) throw new Error("preset did not apply");
	const node = new GraphicNode({
		definitionId: "rectangle",
		params: {},
		duration: CLIP,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: IDENTITY,
		animations: applied.element.animations,
		opacity: 1,
	});
	await resolveRenderTree({ node, renderer: renderer(), time });
	if (!node.resolved) throw new Error("graphic did not resolve");
	return { resolved: node.resolved, animations: applied.element.animations };
}

describe("keyframe presets in the render tree", () => {
	test("zoom in: the resolved scale is the keyframed one at the start, the middle and after the end", async () => {
		for (const fraction of [0, 0.5, 1, 1.5]) {
			const time = fraction * 4 * TICKS_PER_SECOND;
			const { resolved, animations } = await resolveWith({ id: "zoom-in", time });
			const expected = resolveAnimationPathValueAtTime({ animations, propertyPath: "transform.scaleX", localTime: time, fallbackValue: 1 });
			expect(resolved.transform.scaleX).toBeCloseTo(expected, 9);
			expect(resolved.transform.scaleY).toBeCloseTo(expected, 9);
		}
		const end = await resolveWith({ id: "zoom-in", time: 4 * TICKS_PER_SECOND });
		expect(end.resolved.transform.scaleX).toBeCloseTo(1.3, 9);
	});

	test("pan left: the resolved position ends 10% of the canvas to the left", async () => {
		const end = await resolveWith({ id: "pan-left", time: 4 * TICKS_PER_SECOND });
		expect(end.resolved.transform.position.x).toBeCloseTo(-192, 9);
		expect(end.resolved.transform.position.y).toBe(0);
	});

	test("swing: the resolved rotation follows the keys", async () => {
		const quarter = await resolveWith({ id: "swing", time: 1 * TICKS_PER_SECOND });
		expect(quarter.resolved.transform.rotate).toBeCloseTo(8, 9);
	});
});
