import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { textMaskDefinition } from "@/masks/builtin/definitions/text";
import type { TextMaskParams } from "@/masks/types";
import { getTextMeasurementContext } from "@/text/measure-element";

// Same stand-in as snap.test.ts: text/measure-element.ts keeps the first canvas
// context it creates for the whole bun process, so both files must use an
// identical fake (every character is 10px wide) and this file reads the font
// back from whichever context won.
const fakeTextContext = {
	font: "",
	textBaseline: "",
	save() {},
	restore() {},
	measureText: (text: string) => ({ width: text.length * 10 }),
};

class FakeOffscreenCanvas {
	getContext() {
		return fakeTextContext;
	}
}

const params: TextMaskParams = {
	feather: 0,
	inverted: false,
	strokeColor: "#ffffff",
	strokeWidth: 0,
	strokeAlign: "center",
	content: "Mask",
	fontSize: 15,
	fontFamily: "Arial",
	fontWeight: "normal",
	fontStyle: "normal",
	textDecoration: "none",
	letterSpacing: 0,
	lineHeight: 1.2,
	centerX: 0,
	centerY: 0,
	rotation: 0,
	scale: 1,
};

const snapArgs = {
	handleId: { kind: "position" },
	bounds: { cx: 200, cy: 150, width: 200, height: 100, rotation: 0 },
	canvasSize: { width: 400, height: 300 },
	snapThreshold: { x: 8, y: 8 },
} as const;

describe("text mask with a corrupt fontFamily", () => {
	beforeAll(() => {
		Object.defineProperty(globalThis, "OffscreenCanvas", {
			value: FakeOffscreenCanvas,
			configurable: true,
			writable: true,
		});
	});

	afterAll(() => {
		Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	});

	test("measures with Arial instead of throwing when fontFamily is not a string", () => {
		// JSON.parse returns any: how a corrupt value arrives from a saved project.
		const corrupt = { ...params, fontFamily: JSON.parse("7") };

		expect(() =>
			textMaskDefinition.interaction.snap?.({
				...snapArgs,
				startParams: corrupt,
				proposedParams: corrupt,
			}),
		).not.toThrow();
		expect(getTextMeasurementContext().font).toContain('"Arial"');
	});

	test("still uses a valid fontFamily", () => {
		const custom = { ...params, fontFamily: "My Font" };

		textMaskDefinition.interaction.snap?.({
			...snapArgs,
			startParams: custom,
			proposedParams: custom,
		});

		expect(getTextMeasurementContext().font).toContain('"My Font"');
	});
});
