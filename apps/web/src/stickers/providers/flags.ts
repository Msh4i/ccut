import { buildStickerId, parseStickerId } from "../sticker-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";
import { clampQuery } from "../search-fold";
import { createCatalogLoader, paginate } from "./catalog-utils";
import { REGIONS, REGION_GROUPS } from "./countries-data";
import type { CountryRecord, RegionId } from "./countries-data";

const FLAGS_PROVIDER_ID = "flags";
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_FLAGS_BASE_URL = "/flags";

function getFlagsBaseUrl(): string {
	return DEFAULT_FLAGS_BASE_URL.replace(/\/$/, "");
}

function buildFlagUrl({ code }: { code: string }): string {
	const normalizedCode = code.toLowerCase();
	return `${getFlagsBaseUrl()}/${encodeURIComponent(normalizedCode)}.svg`;
}

export type CountriesLoader = () => Promise<CountryRecord[]>;

const loadCountriesDataset: CountriesLoader = () =>
	import("./countries-data").then((m) => m.COUNTRIES);

function toStickerItem({ country }: { country: CountryRecord }): StickerItem {
	const normalizedCode = country.code.toUpperCase();
	return {
		id: buildStickerId({
			providerId: FLAGS_PROVIDER_ID,
			providerValue: normalizedCode,
		}),
		provider: FLAGS_PROVIDER_ID,
		name: country.name,
		previewUrl: buildFlagUrl({ code: normalizedCode }),
		metadata: {
			code: normalizedCode,
			region: country.region ?? null,
			languages: country.languages ?? [],
			flagColors: country.flag_colors ?? [],
		},
	};
}

function normalizeQuery({ query }: { query: string }): string {
	return clampQuery({ query }).trim().toLowerCase();
}

function findMatchingRegions({
	query,
}: {
	query: string;
}): (typeof REGIONS)[number][] {
	return REGIONS.filter(
		(r) =>
			r.id.toLowerCase() === query ||
			r.aliases.some((alias) => alias === query),
	);
}

export function resolveQueryToRegions({
	query,
}: {
	query: string;
}): Set<RegionId> | null {
	// Own keys only: "constructor" or "__proto__" typed in the box is not a group.
	const group = Object.hasOwn(REGION_GROUPS, query) ? REGION_GROUPS[query] : undefined;
	if (group) {
		return new Set(group);
	}

	const matched = findMatchingRegions({ query });
	return matched.length > 0 ? new Set(matched.map((r) => r.id)) : null;
}

export function getRegionLabel({ query }: { query: string }): string {
	if (Object.hasOwn(REGION_GROUPS, query) && REGION_GROUPS[query]) {
		return query
			.split(" ")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
	}

	const matched = findMatchingRegions({ query });
	return matched[0]?.id ?? query;
}

function filterCountriesByQuery({
	countries,
	query,
}: {
	countries: CountryRecord[];
	query: string;
}): CountryRecord[] {
	if (!query) {
		return countries;
	}

	const regionIds = resolveQueryToRegions({ query });

	if (regionIds) {
		return countries.filter((country) => country.region && regionIds.has(country.region));
	}

	return countries.filter((country) => {
		const normalizedName = country.name.toLowerCase();
		const normalizedCode = country.code.toLowerCase();
		return normalizedName.includes(query) || normalizedCode.includes(query);
	});
}

function paginateCountries({
	countries,
	options,
}: {
	countries: CountryRecord[];
	options?: { page?: number; limit?: number };
}): { items: CountryRecord[]; hasMore: boolean; total: number } {
	return paginate({ items: countries, options });
}

const FLAGS_LOAD_ERROR = "The flags could not be loaded.";

/** `loadCountries` is injectable so tests can fail it. */
export function createFlagsProvider({
	loadCountries = loadCountriesDataset,
}: {
	loadCountries?: CountriesLoader;
} = {}): StickerProvider {
	const loadCatalog = createCatalogLoader<CountryRecord[]>({
		label: "flags dataset",
		load: loadCountries,
	});

	return {
		id: FLAGS_PROVIDER_ID,
		async search({
			query,
			options,
		}: {
			query: string;
			options?: { limit?: number };
		}): Promise<StickerSearchResult> {
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				return { items: [], total: 0, hasMore: false, error: FLAGS_LOAD_ERROR };
			}
			const normalizedQuery = normalizeQuery({ query });
			const filteredCountries = filterCountriesByQuery({
				countries: loaded.value,
				query: normalizedQuery,
			});
			const paged = paginateCountries({
				countries: filteredCountries,
				options: {
					page: 1,
					limit: options?.limit ?? DEFAULT_SEARCH_LIMIT,
				},
			});
			return {
				items: paged.items.map((country) => toStickerItem({ country })),
				total: paged.total,
				hasMore: paged.hasMore,
			};
		},
		async browse({
			options,
		}: {
			options?: { page?: number; limit?: number };
		}): Promise<StickerBrowseResult> {
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				return { sections: [], error: FLAGS_LOAD_ERROR };
			}
			const paged = paginateCountries({ countries: loaded.value, options });
			return {
				sections: [
					{
						id: "all",
						items: paged.items.map((country) => toStickerItem({ country })),
						hasMore: paged.hasMore,
						layout: "grid",
					},
				],
			};
		},
		resolveUrl({
			stickerId,
		}: {
			stickerId: string;
			options?: { width?: number; height?: number };
		}): string {
			const { providerValue } = parseStickerId({ stickerId });
			return buildFlagUrl({ code: providerValue });
		},
		async describeSticker({ stickerId }): Promise<string | null> {
			let code: string;
			try {
				code = parseStickerId({ stickerId }).providerValue.toUpperCase();
			} catch {
				return null;
			}
			const loaded = await loadCatalog();
			if (loaded.status === "failed") {
				// Unknown while the dataset is down: the caller names it from the id.
				return null;
			}
			return (
				loaded.value.find((country) => country.code.toUpperCase() === code)
					?.name ?? null
			);
		},
	};
}

export const flagsProvider = createFlagsProvider();
