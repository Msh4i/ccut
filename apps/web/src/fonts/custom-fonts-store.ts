import { create } from "zustand";
import type { CustomFontMeta } from "./types";

/** `failed`: the browser rejected the stored file at startup. Runtime state,
 * never persisted. Kept so the font stays visible and can be deleted. */
export type CustomFontEntry = CustomFontMeta & { failed?: boolean };

interface CustomFontsState {
	fonts: CustomFontEntry[];
	/**
	 * Bumped once per import batch, per delete and after startup registration,
	 * so views holding rendered text can redraw. Known gap: the compositor
	 * caches text textures by a hash with no font identity (contentHash in
	 * services/renderer/compositor/frame-descriptor.ts), so swapping between
	 * fonts with identical metrics can keep the old raster until text changes.
	 */
	version: number;
	isImporting: boolean;
	/** Reading the font library from IndexedDB failed. */
	loadError: boolean;
}

export const useCustomFontsStore = create<CustomFontsState>(() => ({
	fonts: [],
	version: 0,
	isImporting: false,
	loadError: false,
}));

/** Unique family names, and the families none of whose styles registered. */
export function groupCustomFamilies({ fonts }: { fonts: CustomFontEntry[] }): {
	families: string[];
	failed: Set<string>;
} {
	const families = [...new Set(fonts.map((font) => font.family))].sort();
	const failed = new Set(
		families.filter((family) =>
			fonts.every((font) => font.family !== family || font.failed),
		),
	);
	return { families, failed };
}
