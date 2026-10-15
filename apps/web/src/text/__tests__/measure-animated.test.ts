import { describe, expect, test } from "bun:test";
import type { ElementAnimations, ScalarAnimationKey } from "@/animation/types";
import {
	buildTextLayoutParamsFromElement,
	measureTextElement,
} from "@/text/measure-element";
import { buildTextElement } from "@/timeline/element-utils";
import type { TextElement } from "@/timeline";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

// A context where every character is 10 px wide at font size 10, so the width
// follows the font size the way a real one does.
function context() {
	const ctx = Object.assign(Object.create(null), {
		font: "",
		textBaseline: "",
		letterSpacing: "",
		save() {},
		restore() {},
		measureText(text: string) {
			const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
			return {
				width: text.length * size,
				actualBoundingBoxAscent: size * 0.8,
				actualBoundingBoxDescent: size * 0.2,
				fontBoundingBoxAscent: size * 0.8,
				fontBoundingBoxDescent: size * 0.2,
				actualBoundingBoxLeft: 0,
				actualBoundingBoxRight: text.length * size,
			};
		},
	});
	return ctx;
}

function key({ seconds, value }: { seconds: number; value: number }): ScalarAnimationKey {
	return {
		id: `k${seconds}`,
		time: mediaTime({ ticks: seconds * TICKS_PER_SECOND }),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function text(animations?: ElementAnimations): TextElement {
	const built = buildTextElement({
		raw: { duration: mediaTime({ ticks: 4 * TICKS_PER_SECOND }), params: { content: "Hello", fontSize: 10 } },
		startTime: mediaTime({ ticks: 0 }),
	});
	if (built.type !== "text") throw new Error("expected text");
	return { id: "t", ...built, animations };
}

const at = (seconds: number) => seconds * TICKS_PER_SECOND;

describe("text size keyframes reach the layout", () => {
	const animations: ElementAnimations = {
		fontSize: { keys: [key({ seconds: 0, value: 10 }), key({ seconds: 4, value: 30 })] },
		letterSpacing: { keys: [key({ seconds: 0, value: 0 }), key({ seconds: 4, value: 8 })] },
		lineHeight: { keys: [key({ seconds: 0, value: 1 }), key({ seconds: 4, value: 2 })] },
	};

	test("font size, letter spacing and line height are the keyed values at the time asked", () => {
		const element = text(animations);
		const start = buildTextLayoutParamsFromElement({ element, localTime: 0 });
		const middle = buildTextLayoutParamsFromElement({ element, localTime: at(2) });
		const end = buildTextLayoutParamsFromElement({ element, localTime: at(4) });
		expect([start.fontSize, middle.fontSize, end.fontSize]).toEqual([10, 20, 30]);
		expect([start.letterSpacing, middle.letterSpacing, end.letterSpacing]).toEqual([0, 4, 8]);
		expect([start.lineHeight, middle.lineHeight, end.lineHeight]).toEqual([1, 1.5, 2]);
	});

	test("measured at two times, the text is a different size", () => {
		const element = text(animations);
		const measure = (localTime: number) =>
			measureTextElement({ element, canvasHeight: 1080, localTime, ctx: context() });
		const first = measure(0);
		const last = measure(at(4));
		expect(last.scaledFontSize).toBeGreaterThan(first.scaledFontSize * 2.9);
		expect(last.visualRect.width).toBeGreaterThan(first.visualRect.width * 2);
		expect(last.lineHeightPx).toBeGreaterThan(first.lineHeightPx);
	});

	test("without keys the layout is the fixed one at any time; without a time, the fixed values", () => {
		const element = text();
		const a = buildTextLayoutParamsFromElement({ element, localTime: 0 });
		const b = buildTextLayoutParamsFromElement({ element, localTime: at(3) });
		expect(a).toEqual(b);
		expect(buildTextLayoutParamsFromElement({ element: text(animations) }).fontSize).toBe(10);
	});
});
