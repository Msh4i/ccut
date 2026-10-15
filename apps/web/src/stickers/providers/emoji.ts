import { buildStickerId, parseStickerId } from "../sticker-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerSearchResult,
} from "../types";
import {
	capitalizeFirst,
	createCatalogLoader,
	type CatalogStickerProvider,
	fetchJson,
	paginate,
	slugify,
} from "./catalog-utils";
import {
	buildEmojiSearchEntries,
	idToGlyph,
	isValidEmojiId,
	parseEmojiIndex,
	searchEmojiEntries,
	type EmojiIndex,
	type EmojiIndexItem,
	type EmojiSearchEntry,
} from "./emoji-index";

const EMOJI_PROVIDER_ID = "emoji";
const DEFAULT_SEARCH_LIMIT = 100;
/** Same-origin files under public/: they must never taint the export canvas. */
const EMOJI_BASE_URL = "/emoji/fluent-flat";
const EMOJI_INDEX_URL = "/emoji/index.json";
/** What a malformed id resolves to: a file that does not exist, so the image fails to load. */
const UNKNOWN_EMOJI_FILE = "unknown";

interface EmojiCatalog {
	index: EmojiIndex;
	entries: EmojiSearchEntry[];
}

const EMOJI_LOAD_ERROR = "The emoji catalog could not be loaded.";

export type EmojiIndexLoader = () => Promise<EmojiIndex>;

async function fetchEmojiIndex(): Promise<EmojiIndex> {
	return parseEmojiIndex({ value: await fetchJson({ url: EMOJI_INDEX_URL }) });
}

function buildEmojiUrl({ id }: { id: string }): string {
	const normalizedId = id.toLowerCase();
	const fileName = isValidEmojiId({ id: normalizedId })
		? normalizedId
		: UNKNOWN_EMOJI_FILE;
	return `${EMOJI_BASE_URL}/${fileName}.svg`;
}

/** The name every entry path uses: picker tile, "Recently used", timeline element. */
function buildEmojiName({ item }: { item: EmojiIndexItem }): string {
	return capitalizeFirst({ text: item.n });
}

function toStickerItem({
	item,
	groups,
}: {
	item: EmojiIndexItem;
	groups: string[];
}): StickerItem {
	return {
		id: buildStickerId({ providerId: EMOJI_PROVIDER_ID, providerValue: item.id }),
		provider: EMOJI_PROVIDER_ID,
		name: buildEmojiName({ item }),
		previewUrl: buildEmojiUrl({ id: item.id }),
		metadata: {
			glyph: idToGlyph({ id: item.id }),
			group: groups[item.g] ?? null,
			nameTr: item.tr ?? null,
		},
	};
}

/** `loadIndex` is injectable so tests do not need a server. */
export function createEmojiProvider({
	loadIndex = fetchEmojiIndex,
}: {
	loadIndex?: EmojiIndexLoader;
} = {}): CatalogStickerProvider {
	const loadCatalog = createCatalogLoader<EmojiCatalog>({
		label: "emoji index",
		load: async () => {
			const index = await loadIndex();
			return { index, entries: buildEmojiSearchEntries({ index }) };
		},
	});

	return {
		id: EMOJI_PROVIDER_ID,
		resetCatalog: loadCatalog.reset,
		async search({ query, options }): Promise<StickerSearchResult> {
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				return { items: [], total: 0, hasMore: false, error: EMOJI_LOAD_ERROR };
			}
			const { index, entries } = loaded.value;
			const trimmedQuery = query.trim();
			const matches = trimmedQuery
				? searchEmojiEntries({ entries, query: trimmedQuery })
				: index.items;
			const paged = paginate({
				items: matches,
				options: { page: 1, limit: options?.limit ?? DEFAULT_SEARCH_LIMIT },
			});
			return {
				items: paged.items.map((item) => toStickerItem({ item, groups: index.groups })),
				total: paged.total,
				hasMore: paged.hasMore,
			};
		},
		async browse({ options }): Promise<StickerBrowseResult> {
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				return { sections: [], error: EMOJI_LOAD_ERROR };
			}
			const { index } = loaded.value;
			if (index.items.length === 0) {
				return { sections: [] };
			}

			// A limit means a single page (the "All" tab shows a short row).
			if (options?.limit !== undefined) {
				const paged = paginate({ items: index.items, options });
				return {
					sections: [
						{
							id: "all",
							items: paged.items.map((item) => toStickerItem({ item, groups: index.groups })),
							hasMore: paged.hasMore,
							layout: "grid",
						},
					],
				};
			}

			return {
				sections: index.groups.map((title, groupIndex) => ({
					id: slugify({ text: title }),
					title,
					items: index.items
						.filter((item) => item.g === groupIndex)
						.map((item) => toStickerItem({ item, groups: index.groups })),
					layout: "grid" as const,
				})),
			};
		},
		resolveUrl({ stickerId }): string {
			const { providerValue } = parseStickerId({ stickerId });
			return buildEmojiUrl({ id: providerValue });
		},
		async describeSticker({ stickerId }): Promise<string | null> {
			let id: string;
			try {
				id = parseStickerId({ stickerId }).providerValue.toLowerCase();
			} catch {
				return null;
			}
			if (!isValidEmojiId({ id })) {
				return null;
			}
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				// Unknown, not "the glyph": the caller names the element from its id
				// instead of storing a glyph as its name for good.
				return null;
			}
			const item = loaded.value.index.items.find((candidate) => candidate.id === id);
			// A well formed id the catalog lacks (an older save): the glyph still reads.
			return item ? buildEmojiName({ item }) : idToGlyph({ id });
		},
	};
}

export const emojiProvider = createEmojiProvider();
