export interface FontOption {
	value: string;
	label: string;
	category: "system" | "google" | "custom";
	weights?: number[];
	hasClassName?: boolean;
}

export interface GoogleFontMeta {
	family: string;
	category: string;
}

export interface FontAtlasEntry {
	x: number;
	y: number;
	w: number;
	ch: number;
	s: string[];
}

export interface FontAtlas {
	fonts: Record<string, FontAtlasEntry>;
}

/** One WOFF2 file of the offline pack (public/fonts/files/manifest.json). */
export interface BundledFontFile {
	weight: number;
	subset: string;
	/** Same-origin path under /fonts/files/. */
	url: string;
	unicodeRange: string;
	/** Hex sha256 of the file; the pack script writes it, the tests check it. */
	sha256?: string;
}

export interface BundledFont {
	/** Fontsource package id: @fontsource/<id>. */
	id: string;
	/** Exact version of that package the files came from. */
	version: string;
	weights: number[];
	files: BundledFontFile[];
}

/** Catalog family name -> its bundled files. */
export type FontManifest = Record<string, BundledFont>;

export type CustomFontFormat = "ttf" | "otf" | "woff" | "woff2";
export type CustomFontStyle = "normal" | "italic";

export interface CustomFontMeta {
	id: string;
	family: string;
	weight: number;
	style: CustomFontStyle;
	format: CustomFontFormat;
	fileName: string;
	size: number;
	addedAt: number;
}

export interface CustomFontRecord extends CustomFontMeta {
	schema: 1;
	data: ArrayBuffer;
}
