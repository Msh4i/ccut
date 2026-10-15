import { GENERIC_FONT_FAMILIES } from "./system-fonts";

const MAX_LISTED_NAMES = 5;
const MAX_LISTED_NAME_LENGTH = 40;

// Control, format (zero-width, bidi), surrogate, private-use characters and
// line/paragraph separators. A single U+000C in a family name makes
// `document.fonts.load` throw a SyntaxError, so these never reach the browser.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

export function stripUnsafeFontNameChars({ name }: { name: string }): string {
	// Saved projects are untrusted data: a corrupt family can be any JSON value.
	if (typeof name !== "string") return "";
	return name.normalize("NFC").replace(UNSAFE_NAME_CHARS, "");
}

/**
 * Formats a family name for a CSS/canvas font string. Names are cleaned,
 * quoted and escaped (a name ending in a backslash would otherwise swallow the
 * closing quote and make the browser drop the whole declaration). Generic
 * keywords stay bare: quoted, "serif" would be looked up as a family called
 * "serif".
 */
export function quoteFontFamily({
	fontFamily,
}: {
	fontFamily: string;
}): string {
	const name = stripUnsafeFontNameChars({ name: fontFamily });
	if (GENERIC_FONT_FAMILIES.has(name)) return name;
	return `"${name.replace(/["\\]/g, "\\$&")}"`;
}

/** Names for a toast: untrusted text, so bounded in count and length. */
export function formatFontNameList({ names }: { names: string[] }): string {
	const shown = names.slice(0, MAX_LISTED_NAMES).map((name) => {
		const clean = stripUnsafeFontNameChars({ name });
		return clean.length > MAX_LISTED_NAME_LENGTH
			? `${clean.slice(0, MAX_LISTED_NAME_LENGTH - 1)}\u2026`
			: clean;
	});
	const hidden = names.length - shown.length;
	return hidden > 0
		? `${shown.join(", ")} and ${hidden} more`
		: shown.join(", ");
}
