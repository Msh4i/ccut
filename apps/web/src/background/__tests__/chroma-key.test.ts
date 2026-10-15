import { describe, expect, test } from "bun:test";
import {
	CHROMA_KEY_DEFAULTS,
	applyChromaKey,
	chromaKeyHash,
	parseKeyColor,
	resolveChromaKeyAtTime,
	type ChromaKeySettings,
} from "@/background/chroma-key";
import type { ElementAnimations } from "@/animation/types";
import { keyedSourceTexture } from "@/services/renderer/compositor/frame-descriptor";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const GREEN: ChromaKeySettings = {
	color: { r: 0, g: 255, b: 0 },
	tolerance: 30,
	softness: 20,
	spill: 0,
	invert: false,
};

function pixels(...rgba: number[][]): Uint8ClampedArray {
	return Uint8ClampedArray.from(rgba.flat());
}

function alphaOf({ data, pixel }: { data: Uint8ClampedArray; pixel: number }): number {
	return data[pixel * 4 + 3];
}

describe("chroma key pixels", () => {
	test("the key colour goes transparent, other colours stay opaque", () => {
		const data = pixels([0, 255, 0, 255], [255, 0, 0, 255], [30, 30, 220, 255], [255, 255, 255, 255]);
		applyChromaKey({ data, settings: GREEN });
		expect([0, 1, 2, 3].map((i) => alphaOf({ data, pixel: i }))).toEqual([0, 255, 255, 255]);
	});

	test("a shadowed green (same hue, darker) is keyed too: the key works on chroma, not brightness", () => {
		const data = pixels([0, 120, 0, 255], [10, 90, 12, 255]);
		applyChromaKey({ data, settings: GREEN });
		expect(alphaOf({ data: data, pixel: 0 })).toBe(0);
		expect(alphaOf({ data: data, pixel: 1 })).toBe(0);
	});

	test("softness gives a graded edge between keyed out and kept; zero softness is a hard edge", () => {
		// A yellow-green between the key and the kept colours.
		const edge = [150, 255, 0, 255];
		const soft = pixels(edge);
		applyChromaKey({ data: soft, settings: { ...GREEN, tolerance: 20, softness: 60 } });
		expect(alphaOf({ data: soft, pixel: 0 })).toBeGreaterThan(0);
		expect(alphaOf({ data: soft, pixel: 0 })).toBeLessThan(255);
		const hard = pixels(edge);
		applyChromaKey({ data: hard, settings: { ...GREEN, tolerance: 20, softness: 0 } });
		expect([0, 255]).toContain(alphaOf({ data: hard, pixel: 0 }));
	});

	test("a larger tolerance keys out more", () => {
		const nearGreen = [90, 220, 60, 255];
		const narrow = pixels(nearGreen);
		const wide = pixels(nearGreen);
		applyChromaKey({ data: narrow, settings: { ...GREEN, tolerance: 5, softness: 5 } });
		applyChromaKey({ data: wide, settings: { ...GREEN, tolerance: 60, softness: 5 } });
		expect(alphaOf({ data: wide, pixel: 0 })).toBeLessThan(alphaOf({ data: narrow, pixel: 0 }));
	});

	test("invert keeps the keyed colour and removes the rest", () => {
		const data = pixels([0, 255, 0, 255], [255, 0, 0, 255]);
		applyChromaKey({ data, settings: { ...GREEN, invert: true } });
		expect([alphaOf({ data: data, pixel: 0 }), alphaOf({ data: data, pixel: 1 })]).toEqual([255, 0]);
	});

	test("an already transparent pixel stays transparent, a half transparent one keeps its share", () => {
		const data = pixels([255, 0, 0, 0], [255, 0, 0, 128]);
		applyChromaKey({ data, settings: GREEN });
		expect([alphaOf({ data: data, pixel: 0 }), alphaOf({ data: data, pixel: 1 })]).toEqual([0, 128]);
	});

	test("spill removal takes the green cast out of a kept pixel and leaves a red one alone", () => {
		// Skin with a green cast from the screen: g is high for a skin tone.
		const cast = [200, 190, 150, 255];
		const kept = pixels(cast, [220, 40, 40, 255]);
		const untouched = pixels(cast, [220, 40, 40, 255]);
		applyChromaKey({ data: kept, settings: { ...GREEN, tolerance: 5, softness: 5, spill: 100 } });
		applyChromaKey({ data: untouched, settings: { ...GREEN, tolerance: 5, softness: 5, spill: 0 } });
		expect(kept[1]).toBeLessThan(untouched[1]);
		// the red pixel has no green cast: it is not changed
		expect(Array.from(kept.slice(4, 8))).toEqual(Array.from(untouched.slice(4, 8)));
	});

	test("the same pixels and settings give the same result twice (preview and export agree)", () => {
		const make = () => pixels([10, 200, 20, 255], [180, 90, 60, 255], [40, 240, 200, 255]);
		const a = make();
		const b = make();
		applyChromaKey({ data: a, settings: { ...GREEN, spill: 70 } });
		applyChromaKey({ data: b, settings: { ...GREEN, spill: 70 } });
		expect(Array.from(a)).toEqual(Array.from(b));
	});
});

describe("chroma key settings at a time", () => {
	const params = {
		"chromaKey.enabled": true,
		"chromaKey.color": "#00ff00",
		"chromaKey.tolerance": 10,
		"chromaKey.softness": 20,
		"chromaKey.spill": 30,
		"chromaKey.invert": false,
	};

	test("off (or an old clip without the params) is no key", () => {
		expect(resolveChromaKeyAtTime({ params: { ...params, "chromaKey.enabled": false }, animations: undefined, localTime: 0 })).toBeNull();
		expect(resolveChromaKeyAtTime({ params: {}, animations: undefined, localTime: 0 })).toBeNull();
		expect(resolveChromaKeyAtTime({ params: undefined, animations: undefined, localTime: 0 })).toBeNull();
	});

	test("the stored values, and a keyed tolerance at the time asked", () => {
		expect(resolveChromaKeyAtTime({ params, animations: undefined, localTime: 0 })).toEqual({
			color: { r: 0, g: 255, b: 0 },
			tolerance: 10,
			softness: 20,
			spill: 30,
			invert: false,
		});
		const animations: ElementAnimations = {
			"chromaKey.tolerance": {
				keys: [
					{ id: "a", time: mediaTime({ ticks: 0 }), value: 0, segmentToNext: "linear", tangentMode: "flat" },
					{ id: "b", time: mediaTime({ ticks: 2 * TICKS_PER_SECOND }), value: 80, segmentToNext: "linear", tangentMode: "flat" },
				],
			},
		};
		expect(resolveChromaKeyAtTime({ params, animations, localTime: TICKS_PER_SECOND })?.tolerance).toBeCloseTo(40, 6);
	});

	test("an unreadable colour or out-of-range numbers are held to the range", () => {
		expect(resolveChromaKeyAtTime({ params: { ...params, "chromaKey.color": "not a colour" }, animations: undefined, localTime: 0 })).toBeNull();
		const wild = resolveChromaKeyAtTime({ params: { ...params, "chromaKey.tolerance": 900, "chromaKey.softness": -5 }, animations: undefined, localTime: 0 });
		expect([wild?.tolerance, wild?.softness]).toEqual([100, 0]);
	});

	test("colours parse to 0 to 255 and the hash changes with every setting", () => {
		expect(parseKeyColor({ color: "#ff8000" })).toEqual({ r: 255, g: 128, b: 0 });
		const base = chromaKeyHash({ settings: GREEN });
		for (const change of [{ tolerance: 31 }, { softness: 21 }, { spill: 1 }, { invert: true }, { color: { r: 0, g: 254, b: 0 } }]) {
			expect(chromaKeyHash({ settings: { ...GREEN, ...change } })).not.toBe(base);
		}
		expect(CHROMA_KEY_DEFAULTS.enabled).toBe(false);
	});
});

describe("the keyed texture", () => {
	test("is a rendered texture that draws the frame, keys it and puts it back", () => {
		const calls: string[] = [];
		const image = { data: pixels([0, 255, 0, 255], [255, 0, 0, 255]) };
		const ctx = Object.assign(Object.create(null), {
			drawImage: () => calls.push("draw"),
			getImageData: () => {
				calls.push("get");
				return image;
			},
			putImageData: () => calls.push("put"),
		});
		const source: CanvasImageSource = Object.create(null);
		const texture = keyedSourceTexture({ id: "t", source, width: 2, height: 1, version: 7, settings: GREEN });
		if (texture.kind !== "rendered") throw new Error("expected a rendered texture");
		texture.draw(ctx);
		expect(calls).toEqual(["draw", "get", "put"]);
		expect([alphaOf({ data: image.data, pixel: 0 }), alphaOf({ data: image.data, pixel: 1 })]).toEqual([0, 255]);
	});

	test("its cache key follows the frame version and the key settings", () => {
		const source: CanvasImageSource = Object.create(null);
		const hash = ({ version, settings }: { version: number; settings: ChromaKeySettings }) => {
			const texture = keyedSourceTexture({ id: "t", source, width: 2, height: 1, version, settings });
			return texture.kind === "rendered" ? texture.contentHash : "";
		};
		expect(hash({ version: 1, settings: GREEN })).toBe(hash({ version: 1, settings: { ...GREEN } }));
		expect(hash({ version: 1, settings: GREEN })).not.toBe(hash({ version: 2, settings: GREEN }));
		expect(hash({ version: 1, settings: GREEN })).not.toBe(hash({ version: 1, settings: { ...GREEN, tolerance: 31 } }));
	});
});
