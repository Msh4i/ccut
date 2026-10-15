import type { STICKER_CATEGORIES } from "@/stickers/categories";

export type StickerCategory = keyof typeof STICKER_CATEGORIES;

export interface StickerItem {
	id: string;
	provider: string;
	name: string;
	previewUrl: string;
	metadata: Record<string, unknown>;
}

export interface StickerSearchResult {
	items: StickerItem[];
	total: number;
	hasMore: boolean;
	/**
	 * Set when the catalog could not be loaded. That is not "no matches": the
	 * picker shows the message and a Retry button instead of an empty result.
	 */
	error?: string;
}

export interface StickerBrowseSection {
	id: string;
	title?: string;
	items: StickerItem[];
	hasMore?: boolean;
	layout?: "grid" | "row";
	/** The provider behind this section could not be loaded (items is empty). */
	error?: string;
	action?: {
		type: "see-all";
		category?: StickerCategory;
		sectionId?: string;
	};
}

export interface StickerBrowseResult {
	sections: StickerBrowseSection[];
	/** Set when the catalog of a single category could not be loaded. */
	error?: string;
}

export interface StickerProviderSearchOptions {
	limit?: number;
}

export interface StickerProviderBrowseOptions {
	page?: number;
	limit?: number;
}

export interface StickerResolveOptions {
	width?: number;
	height?: number;
}

export interface StickerProvider {
	id: string;
	search({
		query,
		options,
	}: {
		query: string;
		options?: StickerProviderSearchOptions;
	}): Promise<StickerSearchResult>;
	browse({
		options,
	}: {
		options?: StickerProviderBrowseOptions;
	}): Promise<StickerBrowseResult>;
	resolveUrl({
		stickerId,
		options,
	}: {
		stickerId: string;
		options?: StickerResolveOptions;
	}): string;
	/**
	 * The display name of a sticker when only its id is known (the "Recently
	 * used" row). Must be the name the provider's own tiles carry, so a sticker
	 * has one name wherever it is added from. null when the id is not one of
	 * this provider's; must not throw.
	 */
	describeSticker?({
		stickerId,
	}: {
		stickerId: string;
	}): Promise<string | null>;
}
