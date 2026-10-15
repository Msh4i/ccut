import type { LinkImportMode } from "./types";

const MAX_NAME_CODE_POINTS = 100;
// Direction marks and invisible format characters go (written as escapes on purpose).
const INVISIBLE_CHARS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// Characters Windows refuses in a file name, and both separators.
const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;

/** C0/C1 control characters (U+0000-U+001F, U+007F-U+009F) become spaces. */
function replaceControls({ text }: { text: string }): string {
	let out = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : char;
	}
	return out;
}

/**
 * The media asset's name: the video's title made safe as a file name (no separators,
 * controls or direction marks, one line, no leading/trailing dots or spaces, at most 100
 * code points), then the extension. Never empty.
 */
export function fileNameFor({
	title,
	ext,
	mode,
}: {
	title: string;
	ext: string;
	mode: LinkImportMode;
}): string {
	const cleaned = replaceControls({ text: title })
		.replace(INVISIBLE_CHARS, "")
		.replace(FORBIDDEN_CHARS, "-")
		.replace(/\s+/g, " ")
		.replace(/^[\s.]+|[\s.]+$/g, "");
	const bounded = Array.from(cleaned)
		.slice(0, MAX_NAME_CODE_POINTS)
		.join("")
		.replace(/[\s.]+$/, "");
	const base =
		bounded === "" ? (mode === "audio" ? "Imported audio" : "Imported video") : bounded;
	return `${base}.${ext}`;
}

/** The temporary file's name in the app's storage: random, nothing taken from the title. */
export function tempNameFor({
	ext,
	randomHex,
}: {
	ext: string;
	randomHex: () => string;
}): string {
	return `${randomHex()}.${ext}`;
}
