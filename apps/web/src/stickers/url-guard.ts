import { describeId } from "./describe-id";

/**
 * The last check on every URL a sticker provider returns. A sticker id comes
 * from saved projects, the clipboard and the recents list, so it is untrusted;
 * the URL it turns into is loaded by `<img>` and then copied onto the export
 * canvas. The desktop app adds its session token to every request of its own
 * origin, so "any path without .." is not good enough (`/api/...` and
 * `/_next/image?url=...` would be requests with credentials). This is an
 * allow-list: the three sticker folders, and the two inline images the shapes
 * provider makes.
 */

/** `/emoji/fluent-flat/<name>.svg`, `/icons/phosphor/<name>.svg`, `/flags/<name>.svg`: no query, no subfolder. */
const STICKER_FILE = /^\/(?:emoji\/fluent-flat|icons\/phosphor|flags)\/[A-Za-z0-9_-]+\.svg$/;

/** The canvas's `toDataURL("image/png")`. */
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_PNG_DATA_URL_LENGTH = 4_000_000;

/**
 * What the shapes provider falls back to where there is no canvas (server
 * render, a failed 2D context): a small SVG with a rectangle and a name.
 */
const SVG_DATA_URL_PREFIX = "data:image/svg+xml;charset=utf-8,";
const URI_COMPONENT = /^[A-Za-z0-9\-_.!~*'()%]+$/;
const MAX_SVG_DATA_URL_LENGTH = 4_096;
const FALLBACK_SVG_ELEMENTS = new Set(["svg", "rect", "text"]);
const FALLBACK_SVG_FORBIDDEN = /href|url\(|\bon[a-z]+\s*=|javascript:|<!|<\?|&/i;

function hasControlCharacter({ text }: { text: string }): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function isSafeSvgFallback({ url }: { url: string }): boolean {
	if (url.length > MAX_SVG_DATA_URL_LENGTH) {
		return false;
	}
	const encoded = url.slice(SVG_DATA_URL_PREFIX.length);
	if (!URI_COMPONENT.test(encoded)) {
		return false;
	}
	let svg: string;
	try {
		svg = decodeURIComponent(encoded);
	} catch {
		return false;
	}
	if (FALLBACK_SVG_FORBIDDEN.test(svg)) {
		return false;
	}
	const elements = [...svg.matchAll(/<\/?\s*([A-Za-z][\w:-]*)/g)].map(
		(match) => match[1],
	);
	return (
		elements.length > 0 &&
		elements.every((element) => FALLBACK_SVG_ELEMENTS.has(element))
	);
}

function isSafeStickerUrl({ url }: { url: unknown }): boolean {
	if (typeof url !== "string" || url === "" || hasControlCharacter({ text: url })) {
		return false;
	}
	if (url.startsWith(SVG_DATA_URL_PREFIX)) {
		return isSafeSvgFallback({ url });
	}
	if (url.startsWith("data:")) {
		return url.length <= MAX_PNG_DATA_URL_LENGTH && PNG_DATA_URL.test(url);
	}
	return STICKER_FILE.test(url);
}

/** Returns `url` when it is safe, otherwise throws (naming the sticker, never echoing the URL). */
export function assertSafeStickerUrl({
	url,
	stickerId,
}: {
	url: string;
	stickerId: string;
}): string {
	if (isSafeStickerUrl({ url })) {
		return url;
	}
	throw new Error(
		`Sticker provider returned an unsafe URL for "${describeId({ value: stickerId })}"`,
	);
}
