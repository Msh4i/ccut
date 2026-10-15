import { describe, expect, test } from "bun:test";
import type { ElementAnimations } from "@/animation/types";
import { planStrokeToggle } from "@/graphics/stroke-toggle";
import { buildGraphicElement } from "@/timeline/element-utils";
import type { GraphicElement } from "@/timeline";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const SECOND = TICKS_PER_SECOND;

function graphic({ strokeWidth, animations }: { strokeWidth: number; animations?: ElementAnimations }): GraphicElement {
	const built = buildGraphicElement({
		definitionId: "rectangle",
		startTime: mediaTime({ ticks: 0 }),
		params: { strokeWidth },
	});
	if (built.type !== "graphic") throw new Error("expected graphic");
	return { id: "g", ...built, duration: mediaTime({ ticks: 10 * SECOND }), animations };
}

const keyed = (): ElementAnimations => ({
	"params.strokeWidth": {
		keys: [
			{ id: "a", time: mediaTime({ ticks: 0 }), value: 0, segmentToNext: "linear", tangentMode: "flat" },
			{ id: "b", time: mediaTime({ ticks: 10 * SECOND }), value: 10, segmentToNext: "linear", tangentMode: "flat" },
		],
	},
});

describe("the Stroke +/- button", () => {
	test("without keys it flips the fixed width, as before", () => {
		const off = planStrokeToggle({ element: graphic({ strokeWidth: 4 }), localTime: 0, rememberedWidth: 2 });
		expect(off.wasEnabled).toBe(true);
		expect(off.widthToRemember).toBe(4);
		expect(off.action).toMatchObject({ kind: "params", params: { strokeWidth: 0 } });
		const on = planStrokeToggle({ element: graphic({ strokeWidth: 0 }), localTime: 0, rememberedWidth: 6 });
		expect(on.wasEnabled).toBe(false);
		expect(on.action).toMatchObject({ kind: "params", params: { strokeWidth: 6 } });
	});

	test("with keys it reads what is drawn at the playhead, not the fixed width", () => {
		// The fixed width is 0 but the keys show a stroke of 5 in the middle.
		const plan = planStrokeToggle({ element: graphic({ strokeWidth: 0, animations: keyed() }), localTime: 5 * SECOND, rememberedWidth: 2 });
		expect(plan.wasEnabled).toBe(true);
		expect(plan.widthToRemember).toBeCloseTo(5, 9);
	});

	test("with keys, turning it off writes a 0 key at the playhead and leaves the other keys", () => {
		const plan = planStrokeToggle({ element: graphic({ strokeWidth: 4, animations: keyed() }), localTime: 5 * SECOND, rememberedWidth: 2 });
		expect(plan.action).toEqual({ kind: "key", propertyPath: "params.strokeWidth", time: 5 * SECOND, value: 0 });
	});

	test("with keys, where the stroke shows nothing it turns on with the remembered width", () => {
		const plan = planStrokeToggle({ element: graphic({ strokeWidth: 4, animations: keyed() }), localTime: 0, rememberedWidth: 3 });
		expect(plan.wasEnabled).toBe(false);
		expect(plan.action).toEqual({ kind: "key", propertyPath: "params.strokeWidth", time: 0, value: 3 });
	});

	test("a playhead outside the clip is held to the clip", () => {
		const plan = planStrokeToggle({ element: graphic({ strokeWidth: 4, animations: keyed() }), localTime: 99 * SECOND, rememberedWidth: 2 });
		expect(plan.action).toMatchObject({ kind: "key", time: 10 * SECOND });
	});
});
