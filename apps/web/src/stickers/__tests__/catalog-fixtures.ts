import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path, { join, resolve } from "node:path";
import { parseEmojiIndex, type EmojiIndex } from "../providers/emoji-index";
import { parseIconsIndex, type IconsIndex } from "../providers/icons-index";

/** apps/web/public, where sticker assets live. */
export const PUBLIC_DIRECTORY = resolve(import.meta.dir, "../../../public");

export function readEmojiIndexFromDisk(): EmojiIndex {
	return parseEmojiIndex({
		value: JSON.parse(
			readFileSync(join(PUBLIC_DIRECTORY, "emoji", "index.json"), "utf8"),
		),
	});
}

export function readIconsIndexFromDisk(): IconsIndex {
	return parseIconsIndex({
		value: JSON.parse(
			readFileSync(
				join(PUBLIC_DIRECTORY, "icons", "phosphor", "index.json"),
				"utf8",
			),
		),
	});
}

/**
 * True when `candidate` is a path below `directory`. Uses `path.relative`, so
 * it understands the platform's own separators (backslashes on Windows), and
 * rejects the directory itself, sibling prefixes ("public-evil") and other
 * drives.
 */
export function isInsideDirectory({
	directory,
	candidate,
	pathApi = path,
}: {
	directory: string;
	candidate: string;
	pathApi?: Pick<typeof path, "relative" | "isAbsolute" | "sep">;
}): boolean {
	const relative = pathApi.relative(directory, candidate);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${pathApi.sep}`) &&
		!pathApi.isAbsolute(relative)
	);
}

/**
 * What the renderer ends up loading for a sticker URL: a same-origin path is a
 * file under public/, a data: URL carries the SVG itself. Anything else is
 * cross-origin and must never reach a sticker.
 */
export function loadSvgForUrl({ url }: { url: string }): string {
	if (url.startsWith("data:image/svg+xml")) {
		const payload = url.slice(url.indexOf(",") + 1);
		return url.includes(";base64,")
			? Buffer.from(payload, "base64").toString("utf8")
			: decodeURIComponent(payload);
	}
	if (url.startsWith("/") && !url.startsWith("//")) {
		const absolute = resolve(PUBLIC_DIRECTORY, decodeURIComponent(url.slice(1)));
		if (!isInsideDirectory({ directory: PUBLIC_DIRECTORY, candidate: absolute })) {
			throw new Error(`URL escapes public/: ${url}`);
		}
		return readFileSync(absolute, "utf8");
	}
	throw new Error(`Cross-origin or unsupported sticker URL: ${url}`);
}

/**
 * SHA-256 of a text file with line endings normalised to LF, so a checkout
 * that converts them (Windows autocrlf) does not change the hash.
 */
export function hashTextFile({ text }: { text: string }): string {
	return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

/** True for URLs that cannot taint the export canvas. */
export function isSameOriginOrInline({ url }: { url: string }): boolean {
	return (
		(url.startsWith("/") && !url.startsWith("//")) ||
		url.startsWith("data:") ||
		url.startsWith("blob:")
	);
}
