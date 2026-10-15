import { describe, expect, spyOn, test } from "bun:test";
import {
	TILE_TEXT_MAX_GRAPHEMES,
	buildTileContent,
	getTileText,
	splitRevealedText,
} from "@/animation/tiles/content";
import type { MediaAsset } from "@/media/types";
import type {
	GraphicElement,
	ImageElement,
	StickerElement,
	TextElement,
	VideoElement,
} from "@/timeline";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

const BASE = {
	id: "element",
	name: "Clip",
	duration: mediaTime({ ticks: 1000 }),
	startTime: ZERO_MEDIA_TIME,
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
};

function textElement(params: TextElement["params"]): TextElement {
	return { ...BASE, type: "text", params };
}

function videoElement(): VideoElement {
	return { ...BASE, type: "video", mediaId: "asset", params: {} };
}

function imageElement(): ImageElement {
	return { ...BASE, type: "image", mediaId: "asset", params: {} };
}

function asset(fields: Partial<MediaAsset>): MediaAsset {
	return {
		id: "asset",
		name: "clip.mp4",
		type: "video",
		file: new File([], "clip.mp4"),
		...fields,
	};
}

const THUMBNAIL = "data:image/jpeg;base64,AAAA";

describe("getTileText: a few characters of the element's own text", () => {
	test("short text is shown whole", () => {
		expect(getTileText({ content: "Summer sale" })).toBe("Summer sale");
	});

	test("line breaks and runs of spaces become single spaces", () => {
		expect(getTileText({ content: "  Big\n\nnews \t now " })).toBe("Big news now");
	});

	test("long text is cut to a few characters and marked as cut", () => {
		const text = getTileText({ content: "The quick brown fox jumps" });
		expect(text).toBe("The quick br…");
		expect([...text].length).toBe(TILE_TEXT_MAX_GRAPHEMES + 1);
	});

	test("the cut never leaves a space before the mark", () => {
		expect(getTileText({ content: "Hello world and more" })).toBe("Hello world…");
	});

	test("the cut never splits a character made of several code points", () => {
		const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		const text = getTileText({ content: family.repeat(TILE_TEXT_MAX_GRAPHEMES + 3) });
		expect(text).toBe(`${family.repeat(TILE_TEXT_MAX_GRAPHEMES)}…`);
	});

	test("empty text shows a font sample instead of an empty tile", () => {
		expect(getTileText({ content: "" })).toBe("Aa");
		expect(getTileText({ content: " \n " })).toBe("Aa");
	});
});

describe("splitRevealedText: the renderer's reveal helper on the tile's text", () => {
	test("without a reveal the whole text shows", () => {
		expect(splitRevealedText({ text: "Summer sale", reveal: undefined })).toEqual({
			shown: "Summer sale",
			hidden: "",
		});
	});

	test("typewriter shows whole graphemes", () => {
		expect(
			splitRevealedText({ text: "Summer sale", reveal: { unit: "grapheme", fraction: 0.5 } }),
		).toEqual({ shown: "Summe", hidden: "r sale" });
	});

	test("word reveal shows whole words", () => {
		expect(
			splitRevealedText({ text: "Summer sale", reveal: { unit: "word", fraction: 0.5 } }),
		).toEqual({ shown: "Summer", hidden: " sale" });
		expect(
			splitRevealedText({ text: "Summer sale", reveal: { unit: "word", fraction: 0 } }),
		).toEqual({ shown: "", hidden: "Summer sale" });
	});
});

describe("buildTileContent for a text element", () => {
	test("its text, font and colour", () => {
		expect(
			buildTileContent({
				element: textElement({
					content: "Summer sale",
					fontFamily: "Georgia",
					color: "#ffd166",
					fontWeight: "bold",
					fontStyle: "italic",
				}),
				mediaAsset: undefined,
			}),
		).toEqual({
			kind: "text",
			text: "Summer sale",
			fontFamily: '"Georgia", sans-serif',
			fontWeight: "bold",
			fontStyle: "italic",
			color: "#ffd166",
			needsLightBackdrop: false,
		});
	});

	test("missing or broken values fall back like the renderer does", () => {
		const content = buildTileContent({
			element: textElement({ content: 5, fontFamily: true, color: 7 }),
			mediaAsset: undefined,
		});
		expect(content).toMatchObject({
			kind: "text",
			text: "Default text",
			fontFamily: '"Arial", sans-serif',
			fontWeight: "normal",
			fontStyle: "normal",
			color: "#ffffff",
		});
	});

	test("a colour the browser cannot read falls back to white", () => {
		const content = buildTileContent({
			element: textElement({ content: "Hi", color: "not-a-colour; background: red" }),
			mediaAsset: undefined,
		});
		expect(content).toMatchObject({ color: "#ffffff", needsLightBackdrop: false });
	});

	test("a font family is quoted and cleaned, never raw CSS", () => {
		const content = buildTileContent({
			element: textElement({ content: "Hi", fontFamily: 'Evil", serif; x' }),
			mediaAsset: undefined,
		});
		expect(content).toMatchObject({ fontFamily: '"Evil\\", serif; x", sans-serif' });
	});

	test("dark text gets a light backdrop so it can be read on the tile", () => {
		for (const color of ["#000000", "#1a1a2e", "rgb(20, 20, 20)"]) {
			expect(
				buildTileContent({ element: textElement({ content: "Hi", color }), mediaAsset: undefined }),
			).toMatchObject({ needsLightBackdrop: true });
		}
		for (const color of ["#ffffff", "#ffd166", "#ff4d4d"]) {
			expect(
				buildTileContent({ element: textElement({ content: "Hi", color }), mediaAsset: undefined }),
			).toMatchObject({ needsLightBackdrop: false });
		}
	});
});

describe("buildTileContent for clips: the poster frame", () => {
	test("a video shows its asset's thumbnail, in the asset's aspect", () => {
		expect(
			buildTileContent({
				element: videoElement(),
				mediaAsset: asset({ thumbnailUrl: THUMBNAIL, width: 1920, height: 1080 }),
			}),
		).toEqual({ kind: "picture", src: THUMBNAIL, aspect: 1920 / 1080 });
	});

	test("a video without a thumbnail (or without its asset) gets the placeholder", () => {
		expect(
			buildTileContent({ element: videoElement(), mediaAsset: asset({ url: "blob:video" }) }),
		).toMatchObject({ kind: "picture", src: null });
		expect(buildTileContent({ element: videoElement(), mediaAsset: undefined })).toEqual({
			kind: "picture",
			src: null,
			aspect: 16 / 9,
		});
	});

	test("an image shows its thumbnail, or the image itself", () => {
		expect(
			buildTileContent({
				element: imageElement(),
				mediaAsset: asset({ type: "image", thumbnailUrl: THUMBNAIL, url: "blob:image" }),
			}),
		).toMatchObject({ src: THUMBNAIL });
		expect(
			buildTileContent({
				element: imageElement(),
				mediaAsset: asset({ type: "image", url: "blob:image", width: 600, height: 900 }),
			}),
		).toEqual({ kind: "picture", src: "blob:image", aspect: 600 / 900 });
	});

	test("only local picture URLs are used: a stored remote URL is not fetched", () => {
		for (const thumbnailUrl of [
			"https://example.com/pixel.png",
			"javascript:alert(1)",
			"data:text/html,<b>x</b>",
			"/api/health",
		]) {
			expect(
				buildTileContent({ element: videoElement(), mediaAsset: asset({ thumbnailUrl }) }),
			).toMatchObject({ src: null });
		}
	});

	test("a sticker shows its sticker image, in its stored aspect", () => {
		const sticker: StickerElement = {
			...BASE,
			type: "sticker",
			stickerId: "emoji:1f525",
			intrinsicWidth: 200,
			intrinsicHeight: 100,
			params: {},
		};
		expect(buildTileContent({ element: sticker, mediaAsset: undefined })).toEqual({
			kind: "picture",
			src: "/emoji/fluent-flat/1f525.svg",
			aspect: 2,
		});
	});

	test("a sticker that cannot be resolved gets the placeholder", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const sticker: StickerElement = {
			...BASE,
			type: "sticker",
			stickerId: "unknown:thing",
			params: {},
		};
		expect(buildTileContent({ element: sticker, mediaAsset: undefined })).toEqual({
			kind: "picture",
			src: null,
			aspect: 1,
		});
		warn.mockRestore();
	});

	test("a graphic shows its preview; an unknown one gets the placeholder", () => {
		const graphic: GraphicElement = {
			...BASE,
			type: "graphic",
			definitionId: "rectangle",
			params: {},
		};
		const content = buildTileContent({ element: graphic, mediaAsset: undefined });
		expect(content).toMatchObject({ kind: "picture", aspect: 1 });
		expect(content.kind === "picture" && content.src?.startsWith("data:image/")).toBe(true);
		expect(
			buildTileContent({
				element: { ...graphic, definitionId: "gone" },
				mediaAsset: undefined,
			}),
		).toEqual({ kind: "picture", src: null, aspect: 1 });
	});
});
