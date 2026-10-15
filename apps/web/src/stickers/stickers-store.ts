import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
	browseAll,
	browseCategory,
	searchAll,
	searchStickers as searchStickersFromProviders,
} from "@/stickers";
import type { StickerBrowseResult, StickerSearchResult } from "@/stickers";
import { isStickerCategory } from "@/stickers/categories";
import type { StickerCategory } from "@/stickers/types";
import { registerDefaultStickerProviders } from "@/stickers/providers";
import { stickersRegistry } from "@/stickers/registry";
import { parseStickerId } from "@/stickers/sticker-id";

const MAX_RECENT_STICKERS = 50;
/** The longest sticker id kept in the recents list (the real ones are under 60). */
const MAX_STICKER_ID_LENGTH = 120;
const BROWSE_FAILED_MESSAGE = "Couldn't load stickers.";
const SEARCH_FAILED_MESSAGE = "Couldn't search stickers.";

/** What the store asks of the sticker catalogs; tests pass fakes. */
export interface StickersApi {
	browseAll: typeof browseAll;
	browseCategory: typeof browseCategory;
	searchAll: typeof searchAll;
	searchStickers: typeof searchStickersFromProviders;
}

const defaultStickersApi: StickersApi = {
	browseAll,
	browseCategory,
	searchAll,
	searchStickers: searchStickersFromProviders,
};

function isValidStickerId(value: unknown): value is string {
	if (typeof value !== "string" || value.length > MAX_STICKER_ID_LENGTH) {
		return false;
	}

	try {
		const parsed = parseStickerId({ stickerId: value });
		return stickersRegistry.has(parsed.providerId);
	} catch {
		return false;
	}
}

function sanitizeRecentStickers({
	recentStickers,
}: {
	recentStickers: unknown;
}): string[] {
	registerDefaultStickerProviders({});

	if (!Array.isArray(recentStickers)) {
		return [];
	}

	const sanitized: string[] = [];
	for (const stickerId of recentStickers) {
		if (!isValidStickerId(stickerId)) {
			continue;
		}
		if (sanitized.includes(stickerId)) {
			continue;
		}
		sanitized.push(stickerId);
		if (sanitized.length >= MAX_RECENT_STICKERS) {
			break;
		}
	}

	return sanitized;
}

/**
 * The two settings that are saved, taken from whatever storage returned.
 * Storage is not trusted: another version, an extension or a hand edit can
 * leave anything there, so this runs on every start, not only when the
 * version number changes. Other keys are dropped on purpose.
 */
function sanitizePersistedSettings({ persisted }: { persisted: unknown }): {
	selectedCategory: StickerCategory;
	recentStickers: string[];
} {
	const saved =
		typeof persisted === "object" && persisted !== null && !Array.isArray(persisted)
			? persisted
			: {};
	const category = Reflect.get(saved, "selectedCategory");
	return {
		selectedCategory: isStickerCategory(category) ? category : "all",
		recentStickers: sanitizeRecentStickers({
			recentStickers: Reflect.get(saved, "recentStickers"),
		}),
	};
}

type ViewMode = "search" | "browse";

interface StickersStore {
	searchQuery: string;
	selectedCategory: StickerCategory;
	viewMode: ViewMode;
	searchResults: StickerSearchResult | null;
	browseContent: StickerBrowseResult | null;
	recentStickers: string[];
	isSearching: boolean;
	isBrowsing: boolean;
	/** Set when a catalog could not be loaded (not "no matches"); cleared by a retry. */
	loadError: string | null;
	/**
	 * The query the results on screen belong to. `searchQuery` is the text in
	 * the box, which runs ahead of the results while the user types; messages
	 * and labels about the results use this one.
	 */
	searchedQuery: string;

	setSearchQuery: ({ query }: { query: string }) => void;
	setSelectedCategory: ({ category }: { category: StickerCategory }) => void;
	searchStickers: ({ query }: { query: string }) => Promise<void>;
	browseStickers: () => Promise<void>;
	addToRecentStickers: ({ stickerId }: { stickerId: string }) => void;
	clearRecentStickers: () => void;
	/** Runs the current search or browse again (the Retry button). */
	retryLoad: () => Promise<void>;
}

export function createStickersStore({
	api = defaultStickersApi,
	storage,
}: {
	api?: StickersApi;
	/** Defaults to localStorage; tests pass an in-memory one. */
	storage?: StateStorage;
} = {}) {
	/**
	 * One counter for every request that fills the view: browse, search, a
	 * category change, clearing the query. Each starts by taking a new number,
	 * and only the call that still holds the latest number may write its answer
	 * or end the loading state; an older, slower answer is dropped.
	 */
	let requestVersion = 0;

	return create<StickersStore>()(
		persist(
			(set, get) => ({
				searchQuery: "",
				selectedCategory: "all",
				viewMode: "browse",

				searchResults: null,
				browseContent: null,
				recentStickers: [],

				isSearching: false,
				isBrowsing: false,
				loadError: null,
				searchedQuery: "",

				setSearchQuery: ({ query }) => set({ searchQuery: query }),

				setSelectedCategory: ({ category }) => {
					// The browse or search started below takes a new request number, which
					// is what makes whatever is still in flight for the old tab stale.
					set({
						selectedCategory: isStickerCategory(category) ? category : "all",
						browseContent: null,
						searchResults: null,
						searchedQuery: "",
						loadError: null,
						isSearching: false,
						isBrowsing: false,
					});

					const query = get().searchQuery.trim();
					if (query) {
						void get().searchStickers({ query });
						return;
					}

					void get().browseStickers();
				},

				searchStickers: async ({ query }: { query: string }) => {
					const version = ++requestVersion;
					const trimmedQuery = query.trim();
					if (!trimmedQuery) {
						set({
							searchResults: null,
							searchedQuery: "",
							viewMode: "browse",
							isSearching: false,
							loadError: null,
						});
						await get().browseStickers();
						return;
					}

					const category = get().selectedCategory;
					const selectedCategory = isStickerCategory(category)
						? category
						: "all";

					set({
						isSearching: true,
						isBrowsing: false,
						viewMode: "search",
						loadError: null,
					});
					try {
						if (selectedCategory === "all") {
							const browseContent = await api.searchAll({ query: trimmedQuery });
							if (version !== requestVersion) return;
							set({ browseContent, searchResults: null, searchedQuery: trimmedQuery });
						} else {
							const results = await api.searchStickers({
								query: trimmedQuery,
								category: selectedCategory,
							});
							if (version !== requestVersion) return;
							set({
								searchResults: results,
								searchedQuery: trimmedQuery,
								loadError: results.error ?? null,
							});
						}
					} catch (error) {
						if (version !== requestVersion) return;
						console.error("Search failed:", error);
						set({ searchResults: null, loadError: SEARCH_FAILED_MESSAGE });
					} finally {
						if (version === requestVersion) {
							set({ isSearching: false });
						}
					}
				},

				browseStickers: async () => {
					const version = ++requestVersion;
					const category = get().selectedCategory;
					const selectedCategory = isStickerCategory(category)
						? category
						: "all";

					set({
						isBrowsing: true,
						isSearching: false,
						viewMode: "browse",
						loadError: null,
					});
					try {
						const browseContent =
							selectedCategory === "all"
								? await api.browseAll({
										recentStickers: get().recentStickers,
									})
								: await api.browseCategory({
										category: selectedCategory,
									});

						if (version !== requestVersion) return;
						set({ browseContent, loadError: browseContent.error ?? null });
					} catch (error) {
						if (version !== requestVersion) return;
						console.error("Browse failed:", error);
						set({ browseContent: null, loadError: BROWSE_FAILED_MESSAGE });
					} finally {
						if (version === requestVersion) {
							set({ isBrowsing: false });
						}
					}
				},

				retryLoad: async () => {
					const query = get().searchQuery.trim();
					if (query) {
						await get().searchStickers({ query });
						return;
					}
					await get().browseStickers();
				},

				addToRecentStickers: ({ stickerId }: { stickerId: string }) => {
					const sanitizedStickerIds = sanitizeRecentStickers({
						recentStickers: [stickerId],
					});
					if (sanitizedStickerIds.length === 0) {
						return;
					}

					set((state) => {
						const recent = [
							sanitizedStickerIds[0],
							...state.recentStickers.filter((s) => s !== sanitizedStickerIds[0]),
						];
						return {
							recentStickers: recent.slice(0, MAX_RECENT_STICKERS),
						};
					});

					if (get().viewMode === "browse" && get().selectedCategory === "all") {
						void get().browseStickers();
					}
				},

				clearRecentStickers: () => {
					set({ recentStickers: [] });

					if (get().viewMode === "browse" && get().selectedCategory === "all") {
						void get().browseStickers();
					}
				},
			}),
			{
				name: "stickers-settings",
				version: 1,
				...(storage ? { storage: createJSONStorage(() => storage) } : {}),
				merge: (persisted, current) => ({
					...current,
					...sanitizePersistedSettings({ persisted }),
				}),
				migrate: (persistedState) => {
					if (
						typeof persistedState === "object" &&
						persistedState !== null &&
						"selectedCategory" in persistedState
					) {
						const typedState = persistedState as {
							selectedCategory?: string;
							recentStickers?: string[];
						};
						const category = typedState.selectedCategory ?? "all";
						return {
							...typedState,
							selectedCategory: isStickerCategory(category) ? category : "all",
							recentStickers: sanitizeRecentStickers({
								recentStickers: typedState.recentStickers ?? [],
							}),
						};
					}
					return persistedState;
				},
				partialize: (state) => ({
					selectedCategory: state.selectedCategory,
					recentStickers: state.recentStickers,
				}),
			},
		),
	);
}

export const useStickersStore = createStickersStore();
