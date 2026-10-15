import { quoteFontFamily } from "@/fonts/font-family";
import type { BundledFontFile, FontManifest } from "@/fonts/types";
import { raceWithTimeout } from "@/fonts/with-timeout";

const FONT_MANIFEST_PATH = "/fonts/files/manifest.json";
const LOAD_TIMEOUT_MS = 8000;

// The manifest is our own static file, but it is still data from the network
// layer: only same-origin pack files may ever reach FontFace (so no request
// leaves the machine and nothing can break out of the url(...) string).
const BUNDLED_URL = /^\/fonts\/files\/[\w-]+\/[\w-]+\.woff2$/;
const UNICODE_RANGE =
	/^U\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?(,U\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?)*$/;

let cachedManifest: FontManifest | null = null;
let manifestPromise: Promise<FontManifest | null> | null = null;

export function clearFontManifestCache(): void {
	cachedManifest = null;
	manifestPromise = null;
}

/** Entries are checked one by one when used (`getBundledFontFiles`). */
function isFontManifest(data: unknown): data is FontManifest {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}

function isBundledFile(value: unknown): value is BundledFontFile {
	return (
		typeof value === "object" &&
		value !== null &&
		"weight" in value &&
		typeof value.weight === "number" &&
		"subset" in value &&
		typeof value.subset === "string" &&
		"url" in value &&
		typeof value.url === "string" &&
		BUNDLED_URL.test(value.url) &&
		"unicodeRange" in value &&
		typeof value.unicodeRange === "string" &&
		UNICODE_RANGE.test(value.unicodeRange)
	);
}

/** Resolves null when the pack's manifest cannot be read; a failure is never cached. */
export function loadFontManifest(): Promise<FontManifest | null> {
	if (cachedManifest) return Promise.resolve(cachedManifest);
	if (manifestPromise) return manifestPromise;

	manifestPromise = fetch(FONT_MANIFEST_PATH, {
		signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data: unknown = await response.json();
			if (!isFontManifest(data)) throw new Error("Unexpected manifest format");
			cachedManifest = data;
			return data;
		})
		.catch((error) => {
			console.warn("Bundled fonts unavailable:", error);
			manifestPromise = null;
			return null;
		});

	return manifestPromise;
}

/**
 * The pack files of `family` for exactly `weights`, or null when the family is
 * not bundled or a wanted weight is not: the caller then uses another source.
 */
export function getBundledFontFiles({
	manifest,
	family,
	weights,
}: {
	manifest: FontManifest | null;
	family: string;
	weights: number[];
}): BundledFontFile[] | null {
	if (!manifest || weights.length === 0 || !Object.hasOwn(manifest, family)) {
		return null;
	}
	const entry: unknown = manifest[family];
	if (typeof entry !== "object" || entry === null || !("files" in entry)) {
		return null;
	}
	const { files } = entry;
	if (!Array.isArray(files) || !files.every(isBundledFile)) return null;

	const wanted = files.filter((file) => weights.includes(file.weight));
	return weights.every((weight) => wanted.some((file) => file.weight === weight))
		? wanted
		: null;
}

/**
 * Registers pack files with the browser, no network involved. Resolves true
 * only when every file loaded and the browser then finds faces for each
 * weight; false otherwise, leaving nothing registered so a retry works.
 */
export async function loadBundledFont({
	family,
	weights,
	files,
}: {
	family: string;
	weights: number[];
	files: BundledFontFile[];
}): Promise<boolean> {
	let faces: FontFace[];

	// Every face is loaded now, not on first use: a canvas draws a missing glyph
	// of a lazy latin-ext face (ğ ş İ) in the fallback font on the first frame.
	try {
		faces = files.map(
			(file) =>
				new FontFace(family, `url(${file.url}) format('woff2')`, {
					weight: String(file.weight),
					unicodeRange: file.unicodeRange,
					display: "swap",
				}),
		);
		const loaded = await raceWithTimeout({
			promise: Promise.all(faces.map((face) => face.load())),
			ms: LOAD_TIMEOUT_MS,
		});
		if (loaded.timedOut) return false;
	} catch {
		return false;
	}

	for (const face of faces) document.fonts.add(face);
	const fail = (): false => {
		for (const face of faces) document.fonts.delete(face);
		return false;
	};

	try {
		const found = await raceWithTimeout({
			promise: Promise.all(
				weights.map((weight) =>
					document.fonts.load(
						`${weight} 16px ${quoteFontFamily({ fontFamily: family })}`,
					),
				),
			),
			ms: LOAD_TIMEOUT_MS,
		});
		if (found.timedOut || found.value.some((matched) => matched.length === 0)) {
			return fail();
		}
	} catch {
		return fail();
	}
	return true;
}
