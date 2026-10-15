import { parse, wcagContrast } from "culori";
import type { PresetReveal } from "@/animation/presets";
import { quoteFontFamily } from "@/fonts/font-family";
import { buildGraphicPreviewUrl } from "@/graphics";
import type { MediaAsset } from "@/media/types";
import { safeResolveStickerId } from "@/stickers/resolver";
import { buildTextLayoutParamsFromElement } from "@/text/measure-element";
import type { TextFontStyle, TextFontWeight } from "@/text/primitives";
import { getVisibleLengths } from "@/text/reveal";
import type { VisualElement } from "@/timeline";

/** A tile shows this many characters of a text at most. */
export const TILE_TEXT_MAX_GRAPHEMES = 12;
const CUT_MARK = "…";
const EMPTY_TEXT_SAMPLE = "Aa";
/** The tile's dark background: `bg-[hsl(0_0%_4%)]` in `components/preset-tiles.tsx`. */
const TILE_BACKGROUND = "hsl(0 0% 4%)";
/** Below this contrast with the dark tile, text gets a light backdrop. */
const MIN_TEXT_CONTRAST = 3;
/** Size, in px, of the pictures a tile asks for (sticker, graphic preview) and draws. */
export const TILE_PICTURE_SIZE = 96;
const DEFAULT_VIDEO_ASPECT = 16 / 9;

export type TileContent =
	| {
			kind: "text";
			text: string;
			/** A CSS font-family value: the element's family, quoted, with a fallback. */
			fontFamily: string;
			fontWeight: TextFontWeight;
			fontStyle: TextFontStyle;
			color: string;
			needsLightBackdrop: boolean;
	  }
	| {
			kind: "picture";
			/** Null when there is nothing to show: the tile draws a placeholder box. */
			src: string | null;
			aspect: number;
	  };

function splitGraphemes(text: string): string[] {
	if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		return Array.from(segmenter.segment(text), ({ segment }) => segment);
	}
	return Array.from(text);
}

/**
 * The first few characters of a text, on one line, for a tile. A cut is made
 * between two graphemes (an emoji is never split) and marked with an ellipsis.
 * An empty text shows a font sample, so the tile is never blank.
 */
export function getTileText({ content }: { content: string }): string {
	const oneLine = content.replace(/\s+/g, " ").trim();
	if (oneLine === "") return EMPTY_TEXT_SAMPLE;
	const graphemes = splitGraphemes(oneLine);
	if (graphemes.length <= TILE_TEXT_MAX_GRAPHEMES) return oneLine;
	return `${graphemes.slice(0, TILE_TEXT_MAX_GRAPHEMES).join("").trimEnd()}${CUT_MARK}`;
}

/**
 * The part of a tile's text that is drawn under a reveal (typewriter, word
 * reveal), worked out by the renderer's own helper. The hidden part keeps its
 * place, so the text does not move while it types, as on the canvas.
 */
export function splitRevealedText({
	text,
	reveal,
}: {
	text: string;
	reveal: PresetReveal | undefined;
}): { shown: string; hidden: string } {
	if (!reveal) return { shown: text, hidden: "" };
	const [length] = getVisibleLengths({
		lines: [text],
		unit: reveal.unit,
		fraction: reveal.fraction,
	});
	return { shown: text.slice(0, length), hidden: text.slice(length) };
}

/**
 * Local picture URLs only: the thumbnails the app renders (data:image/...)
 * and the object URLs of loaded files (blob:). A project is stored data, so a
 * URL in it could point anywhere; the tile does not fetch such a URL.
 */
function localPictureUrl(url: string | undefined): string | null {
	if (typeof url !== "string") return null;
	return url.startsWith("data:image/") || url.startsWith("blob:") ? url : null;
}

function aspectOf({
	width,
	height,
	fallback,
}: {
	width: number | undefined;
	height: number | undefined;
	fallback: number;
}): number {
	if (
		typeof width === "number" &&
		typeof height === "number" &&
		Number.isFinite(width) &&
		Number.isFinite(height) &&
		width > 0 &&
		height > 0
	) {
		return width / height;
	}
	return fallback;
}

function graphicPreviewUrl({
	definitionId,
	params,
}: {
	definitionId: string;
	params: VisualElement["params"];
}): string | null {
	try {
		return buildGraphicPreviewUrl({ definitionId, params, size: TILE_PICTURE_SIZE });
	} catch {
		// A definition that no longer exists (an old or hand-edited project).
		return null;
	}
}

function textColor(value: unknown): { color: string; needsLightBackdrop: boolean } {
	// The renderer draws a colour that is not a string in white.
	const color = typeof value === "string" && parse(value) ? value : "#ffffff";
	return {
		color,
		needsLightBackdrop: wcagContrast(color, TILE_BACKGROUND) < MIN_TEXT_CONTRAST,
	};
}

/** What a tile shows for `element`: its text, or its poster frame. */
export function buildTileContent({
	element,
	mediaAsset,
}: {
	element: VisualElement;
	mediaAsset: MediaAsset | undefined;
}): TileContent {
	switch (element.type) {
		case "text": {
			const layout = buildTextLayoutParamsFromElement({ element });
			return {
				kind: "text",
				text: getTileText({ content: layout.content }),
				fontFamily: `${quoteFontFamily({ fontFamily: layout.fontFamily })}, sans-serif`,
				fontWeight: layout.fontWeight,
				fontStyle: layout.fontStyle,
				...textColor(element.params.color),
			};
		}
		case "video":
			return {
				kind: "picture",
				src: localPictureUrl(mediaAsset?.thumbnailUrl),
				aspect: aspectOf({
					width: mediaAsset?.width,
					height: mediaAsset?.height,
					fallback: DEFAULT_VIDEO_ASPECT,
				}),
			};
		case "image":
			return {
				kind: "picture",
				src:
					localPictureUrl(mediaAsset?.thumbnailUrl) ??
					localPictureUrl(mediaAsset?.url),
				aspect: aspectOf({
					width: mediaAsset?.width,
					height: mediaAsset?.height,
					fallback: DEFAULT_VIDEO_ASPECT,
				}),
			};
		case "sticker":
			return {
				kind: "picture",
				src: safeResolveStickerId({
					stickerId: element.stickerId,
					options: { width: TILE_PICTURE_SIZE, height: TILE_PICTURE_SIZE },
				}),
				aspect: aspectOf({
					width: element.intrinsicWidth,
					height: element.intrinsicHeight,
					fallback: 1,
				}),
			};
		case "graphic":
			return {
				kind: "picture",
				src: graphicPreviewUrl({
					definitionId: element.definitionId,
					params: element.params,
				}),
				aspect: 1,
			};
	}
}
