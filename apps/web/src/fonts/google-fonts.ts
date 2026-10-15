import {
	clearFontManifestCache,
	getBundledFontFiles,
	loadBundledFont,
	loadFontManifest,
} from "@/fonts/bundled-fonts";
import { quoteFontFamily } from "@/fonts/font-family";
import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import { raceWithTimeout } from "@/fonts/with-timeout";

const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com/css2";
const FONT_ATLAS_PATH = "/fonts/font-atlas.json";
const FONT_CHUNK_PATH_PREFIX = "/fonts/font-chunk-";
const DEFAULT_WEIGHTS = [400, 700];
const LOAD_TIMEOUT_MS = 8000;

const fullLoaded = new Set<string>();
// Loads in progress, so a project open and a picker click for one family
// share a single set of FontFaces (or stylesheet) instead of registering two.
const inFlight = new Map<string, Promise<boolean>>();

let cachedAtlas: FontAtlas | null = null;
let atlasFetchPromise: Promise<FontAtlas | null> | null = null;

function isFontAtlas(data: unknown): data is FontAtlas {
	return (
		typeof data === "object" &&
		data !== null &&
		"fonts" in data &&
		typeof data.fonts === "object" &&
		data.fonts !== null
	);
}

export function getCachedFontAtlas(): FontAtlas | null {
	return cachedAtlas;
}

export function clearFontAtlasCache(): void {
	cachedAtlas = null;
	atlasFetchPromise = null;
	fullLoaded.clear();
	inFlight.clear();
	clearFontManifestCache();
}

/** Resolves null when the catalog cannot be read; a failure is never cached. */
export function loadFontAtlas(): Promise<FontAtlas | null> {
	if (cachedAtlas) return Promise.resolve(cachedAtlas);
	if (atlasFetchPromise) return atlasFetchPromise;

	atlasFetchPromise = fetch(FONT_ATLAS_PATH, {
		signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data: unknown = await response.json();
			if (!isFontAtlas(data)) throw new Error("Unexpected catalog format");
			cachedAtlas = data;
			preloadChunkImages({ atlas: data });
			return data;
		})
		.catch((error) => {
			console.warn("Font catalog unavailable:", error);
			atlasFetchPromise = null;
			return null;
		});

	return atlasFetchPromise;
}

function preloadChunkImages({ atlas }: { atlas: FontAtlas }): void {
	const maxChunk = Math.max(
		...Object.values(atlas.fonts).map((entry) => entry.ch),
	);
	for (let i = 0; i <= maxChunk; i++) {
		// hint browser to preload chunk images without blocking
		const img = new Image();
		img.src = `${FONT_CHUNK_PATH_PREFIX}${i}.avif`;
	}
}

/** Weights Google serves for a family; asking for others makes the whole
 * stylesheet request fail (400), which is the case for single-weight fonts. */
function pickWeights({
	entry,
	wanted,
}: {
	entry: FontAtlas["fonts"][string];
	wanted: number[];
}): number[] {
	const available = entry.s.filter((style) => /^\d+$/.test(style)).map(Number);
	const supported = wanted.filter((weight) => available.includes(weight));
	if (supported.length > 0) return supported;
	return available.length > 0 ? [available[0]] : wanted;
}

/**
 * Loads a catalog font: from the offline pack when it has the family (no
 * network), otherwise from Google. Resolves true only if the files or the
 * stylesheet loaded and the browser has the faces; false otherwise, leaving
 * nothing behind so a retry works. Names missing from the bundled catalog never
 * leave the machine, so a custom font's name cannot reach Google.
 */
export function loadFullFont({
	family,
	weights = DEFAULT_WEIGHTS,
}: {
	family: string;
	weights?: number[];
}): Promise<boolean> {
	if (fullLoaded.has(family)) return Promise.resolve(true);

	const key = `${family}|${weights.join(",")}`;
	const running = inFlight.get(key);
	if (running) return running;

	const load = loadFullFontNow({ family, weights }).finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, load);
	return load;
}

async function loadFullFontNow({
	family,
	weights,
}: {
	family: string;
	weights: number[];
}): Promise<boolean> {

	const atlas = await loadFontAtlas();
	if (
		!atlas ||
		SYSTEM_FONTS.has(family) ||
		!Object.hasOwn(atlas.fonts, family)
	) {
		return false;
	}

	const requestedWeights = pickWeights({
		entry: atlas.fonts[family],
		wanted: weights,
	});

	// With a readable manifest that has every wanted weight, the pack is the only
	// source: when its files fail, Google is not tried (offline it could only fail
	// too) and the failure is reported like any other. Otherwise (family or weight
	// not in the pack, manifest unreadable) the Google path below runs.
	const bundledFiles = getBundledFontFiles({
		manifest: await loadFontManifest(),
		family,
		weights: requestedWeights,
	});
	if (bundledFiles) {
		const isLoaded = await loadBundledFont({
			family,
			weights: requestedWeights,
			files: bundledFiles,
		});
		if (isLoaded) fullLoaded.add(family);
		return isLoaded;
	}

	const url = `${GOOGLE_FONTS_CSS}?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${requestedWeights.join(";")}&display=swap`;
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = url;
	const stylesheet = new Promise<boolean>((resolve) => {
		link.addEventListener("load", () => resolve(true), { once: true });
		link.addEventListener("error", () => resolve(false), { once: true });
	});
	document.head.appendChild(link);

	const fail = (): false => {
		link.remove();
		return false;
	};

	const linked = await raceWithTimeout({
		promise: stylesheet,
		ms: LOAD_TIMEOUT_MS,
	});
	if (linked.timedOut || !linked.value) return fail();

	try {
		const loaded = await raceWithTimeout({
			promise: Promise.all(
				requestedWeights.map((weight) =>
					document.fonts.load(
						`${weight} 16px ${quoteFontFamily({ fontFamily: family })}`,
					),
				),
			),
			ms: LOAD_TIMEOUT_MS,
		});
		if (loaded.timedOut || loaded.value.some((faces) => faces.length === 0)) {
			return fail();
		}
	} catch {
		return fail();
	}

	fullLoaded.add(family);
	return true;
}

/** Loads the catalog fonts among `families`; returns the ones that failed. */
export async function loadFonts({
	families,
}: {
	families: unknown[];
}): Promise<{ failed: string[] }> {
	const atlas = await loadFontAtlas();
	if (!atlas) return { failed: [] };

	const names = [...new Set(families)].filter(
		(family): family is string =>
			typeof family === "string" &&
			!SYSTEM_FONTS.has(family) &&
			Object.hasOwn(atlas.fonts, family),
	);
	const results = await Promise.allSettled(
		names.map((family) => loadFullFont({ family })),
	);
	return {
		failed: names.filter((_, i) => {
			const result = results[i];
			return result.status === "rejected" || !result.value;
		}),
	};
}
