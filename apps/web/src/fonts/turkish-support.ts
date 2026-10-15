import { SYSTEM_FONTS } from "@/fonts/system-fonts";

const TURKISH_SUPPORT_PATH = "/fonts/turkish-support.json";
const LOAD_TIMEOUT_MS = 8000;

/** Catalog families whose Regular has ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü (see
 * scripts/generate-turkish-support.py for how the list is measured). */
export type TurkishSupport = ReadonlySet<string>;

let cached: TurkishSupport | null = null;
let fetchPromise: Promise<TurkishSupport | null> | null = null;

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every((item) => typeof item === "string");
}

export function getCachedTurkishSupport(): TurkishSupport | null {
	return cached;
}

export function clearTurkishSupportCache(): void {
	cached = null;
	fetchPromise = null;
}

/** Resolves null when the list cannot be read; a failure is never cached. */
export function loadTurkishSupport(): Promise<TurkishSupport | null> {
	if (cached) return Promise.resolve(cached);
	if (fetchPromise) return fetchPromise;

	fetchPromise = fetch(TURKISH_SUPPORT_PATH, {
		signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data: unknown = await response.json();
			if (!isStringArray(data)) throw new Error("Unexpected list format");
			cached = new Set(data);
			return cached;
		})
		.catch((error) => {
			console.warn("Turkish support list unavailable:", error);
			fetchPromise = null;
			return null;
		});

	return fetchPromise;
}

/** False while the list is unavailable: nothing is claimed that was not measured. */
export function isTurkishReady({
	family,
	support,
}: {
	family: string;
	support: TurkishSupport | null;
}): boolean {
	return support?.has(family) ?? false;
}

/**
 * Whether a font row shows the "TR" badge: a measured catalog font or a system
 * font (Arial and the like, known to have the letters). Never a custom font:
 * nobody measured it, and its name proves nothing. Without the list the
 * feature is off and nothing is badged.
 */
export function hasTurkishBadge({
	family,
	support,
	isCustom,
}: {
	family: string;
	support: TurkishSupport | null;
	isCustom: boolean;
}): boolean {
	if (isCustom || support === null) return false;
	return SYSTEM_FONTS.has(family) || isTurkishReady({ family, support });
}

/**
 * The "Turkish only" view: badged fonts, plus the two kinds that must not
 * vanish: custom fonts (they cannot be judged, so they are not hidden) and the
 * font in use. Unfiltered while the list is unavailable.
 */
export function filterTurkishOnly({
	names,
	support,
	customFamilies,
	selected,
}: {
	names: string[];
	support: TurkishSupport | null;
	customFamilies: ReadonlySet<string>;
	selected: string | undefined;
}): string[] {
	if (support === null) return names;
	return names.filter(
		(name) =>
			name === selected ||
			customFamilies.has(name) ||
			hasTurkishBadge({ family: name, support, isCustom: false }),
	);
}
