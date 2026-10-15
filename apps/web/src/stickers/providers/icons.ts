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
	buildIconSearchEntries,
	expandIconRecords,
	isValidIconId,
	parseIconsIndex,
	searchIconEntries,
	type IconRecord,
	type IconSearchEntry,
	type IconsIndex,
} from "./icons-index";

const ICONS_PROVIDER_ID = "icons";
const DEFAULT_SEARCH_LIMIT = 100;
/** Same-origin files under public/: they must never taint the export canvas. */
const ICONS_BASE_URL = "/icons/phosphor";
const ICONS_INDEX_URL = "/icons/phosphor/index.json";
/** What a malformed id resolves to: a file that does not exist, so the image fails to load. */
const UNKNOWN_ICON_FILE = "unknown";

interface IconsCatalog {
	index: IconsIndex;
	records: IconRecord[];
	entries: IconSearchEntry[];
}

const ICONS_LOAD_ERROR = "The icon catalog could not be loaded.";

export type IconsIndexLoader = () => Promise<IconsIndex>;

async function fetchIconsIndex(): Promise<IconsIndex> {
	return parseIconsIndex({ value: await fetchJson({ url: ICONS_INDEX_URL }) });
}

function buildIconUrl({ id }: { id: string }): string {
	const fileName = isValidIconId({ id }) ? id : UNKNOWN_ICON_FILE;
	return `${ICONS_BASE_URL}/${fileName}.svg`;
}

/** The name every entry path uses: picker tile, "Recently used", timeline element. */
function buildIconName({ id }: { id: string }): string {
	return capitalizeFirst({ text: id.replaceAll("-", " ") });
}

function toStickerItem({
	record,
	groups,
}: {
	record: IconRecord;
	groups: string[];
}): StickerItem {
	return {
		id: buildStickerId({ providerId: ICONS_PROVIDER_ID, providerValue: record.id }),
		provider: ICONS_PROVIDER_ID,
		name: buildIconName({ id: record.id }),
		previewUrl: buildIconUrl({ id: record.id }),
		metadata: {
			icon: record.name,
			weight: record.weight,
			group: groups[record.group] ?? null,
		},
	};
}

/** `loadIndex` is injectable so tests do not need a server. */
export function createIconsProvider({
	loadIndex = fetchIconsIndex,
}: {
	loadIndex?: IconsIndexLoader;
} = {}): CatalogStickerProvider {
	const loadCatalog = createCatalogLoader<IconsCatalog>({
		label: "icons index",
		load: async () => {
			const index = await loadIndex();
			return {
				index,
				records: expandIconRecords({ index }),
				entries: buildIconSearchEntries({ index }),
			};
		},
	});

	return {
		id: ICONS_PROVIDER_ID,
		resetCatalog: loadCatalog.reset,
		async search({ query, options }): Promise<StickerSearchResult> {
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				return { items: [], total: 0, hasMore: false, error: ICONS_LOAD_ERROR };
			}
			const { index, records, entries } = loaded.value;
			const trimmedQuery = query.trim();
			const matches = trimmedQuery
				? searchIconEntries({ entries, query: trimmedQuery })
				: records;
			const paged = paginate({
				items: matches,
				options: { page: 1, limit: options?.limit ?? DEFAULT_SEARCH_LIMIT },
			});
			return {
				items: paged.items.map((record) => toStickerItem({ record, groups: index.groups })),
				total: paged.total,
				hasMore: paged.hasMore,
			};
		},
		async browse({ options }): Promise<StickerBrowseResult> {
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				return { sections: [], error: ICONS_LOAD_ERROR };
			}
			const { index, records } = loaded.value;
			// Browsing shows the regular weight only (half the tiles to draw);
			// fill variants are one search away ("heart fill").
			const regular = records.filter((record) => record.weight === "regular");
			if (regular.length === 0) {
				return { sections: [] };
			}

			// A limit means a single page (the "All" tab shows a short row).
			if (options?.limit !== undefined) {
				const paged = paginate({ items: regular, options });
				return {
					sections: [
						{
							id: "all",
							items: paged.items.map((record) => toStickerItem({ record, groups: index.groups })),
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
					items: regular
						.filter((record) => record.group === groupIndex)
						.map((record) => toStickerItem({ record, groups: index.groups })),
					layout: "grid" as const,
				})),
			};
		},
		resolveUrl({ stickerId }): string {
			const { providerValue } = parseStickerId({ stickerId });
			return buildIconUrl({ id: providerValue });
		},
		async describeSticker({ stickerId }): Promise<string | null> {
			try {
				const { providerValue } = parseStickerId({ stickerId });
				return isValidIconId({ id: providerValue })
					? buildIconName({ id: providerValue })
					: null;
			} catch {
				return null;
			}
		},
	};
}

export const iconsProvider = createIconsProvider();
