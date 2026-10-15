import { STICKER_CATEGORIES, isStickerCategory } from "@/stickers/categories";
import type { StickerCategory } from "@/stickers/types";
import { describeError, describeId } from "./describe-id";
import { loadImage } from "./image-load";
import { stickersRegistry } from "./registry";
import { resolveStickerId } from "./resolver";
import { registerDefaultStickerProviders } from "./providers";
import { parseStickerId } from "./sticker-id";
import type {
	StickerBrowseResult,
	StickerBrowseSection,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "./types";

const DEFAULT_BROWSE_LIMIT = 12;
/** The All tab's total across providers (a short list per provider). */
const DEFAULT_SEARCH_LIMIT = 100;
/**
 * A single category search has no ceiling: the picker shows the total and has
 * no "load more", so any cap would leave matches unreachable (the icon set
 * alone has 2,866 stickers).
 */
const NO_LIMIT = Number.POSITIVE_INFINITY;

function categoryLabel({ providerId }: { providerId: string }): string {
	return isStickerCategory(providerId)
		? STICKER_CATEGORIES[providerId]
		: providerId;
}

function providerErrorMessage({ providerId }: { providerId: string }): string {
	return `${categoryLabel({ providerId })} could not be loaded.`;
}

type ProviderOutcome<T> =
	| { status: "ok"; provider: StickerProvider; result: T }
	| { status: "failed"; provider: StickerProvider; message: string };

/**
 * Runs one provider call. A provider that throws is logged with its id and
 * becomes a "failed" outcome, so the caller can show it instead of dropping it.
 */
async function callProvider<T>({
	provider,
	action,
	run,
}: {
	provider: StickerProvider;
	action: string;
	run: () => Promise<T>;
}): Promise<ProviderOutcome<T>> {
	try {
		return { status: "ok", provider, result: await run() };
	} catch (reason) {
		console.error(`Sticker provider "${provider.id}" failed to ${action}:`, reason);
		return {
			status: "failed",
			provider,
			message: providerErrorMessage({ providerId: provider.id }),
		};
	}
}

function errorSection({
	provider,
	message,
}: {
	provider: StickerProvider;
	message: string;
}): StickerBrowseSection {
	return {
		id: provider.id,
		title: categoryLabel({ providerId: provider.id }),
		items: [],
		layout: "row",
		error: message,
	};
}

function mergeSearchResults({
	results,
}: {
	results: StickerSearchResult[];
}): StickerSearchResult {
	const deduplicatedItems = new Map<string, StickerItem>();
	let total = 0;
	let hasMore = false;

	for (const result of results) {
		total += result.total;
		hasMore = hasMore || result.hasMore;
		for (const item of result.items) {
			if (!deduplicatedItems.has(item.id)) {
				deduplicatedItems.set(item.id, item);
			}
		}
	}

	const failures = results.filter((result) => result.error !== undefined);
	return {
		items: Array.from(deduplicatedItems.values()),
		total,
		hasMore,
		// Only when nothing at all could be searched; partial results are results.
		...(failures.length > 0 && failures.length === results.length
			? { error: failures[0]?.error }
			: {}),
	};
}

function getProviders({
	injected,
}: {
	injected: StickerProvider[] | undefined;
}): StickerProvider[] {
	if (injected) {
		return injected;
	}
	registerDefaultStickerProviders({});
	return stickersRegistry.getAll();
}

function getProviderByCategory({
	category,
	providers,
}: {
	category: StickerCategory;
	providers: StickerProvider[];
}): StickerProvider | null {
	if (category === "all") {
		return null;
	}

	const provider = providers.find((candidate) => candidate.id === category);
	if (!provider) {
		console.warn(`No sticker provider is registered for category "${category}"`);
	}
	return provider ?? null;
}

function getEmptyBrowseResult(): StickerBrowseResult {
	return {
		sections: [],
	};
}

function getEmptySearchResult(): StickerSearchResult {
	return {
		items: [],
		total: 0,
		hasMore: false,
	};
}

function getStickerNameFromId({ stickerId }: { stickerId: string }): string {
	const stickerIdParts = stickerId.split(":");
	if (stickerIdParts.length <= 1) {
		return stickerId;
	}
	return (
		stickerIdParts.slice(1).join(":").split(":").pop()?.replaceAll("-", " ") ??
		stickerId
	);
}

async function toRecentStickerItem({
	stickerId,
	providers,
}: {
	stickerId: string;
	providers: StickerProvider[];
}): Promise<StickerItem | null> {
	try {
		const { providerId } = parseStickerId({ stickerId });
		const provider = providers.find((candidate) => candidate.id === providerId);
		const describedName = await provider
			?.describeSticker?.({ stickerId })
			.catch((reason: unknown) => {
				console.warn(
					`Could not look up the name of "${describeId({ value: stickerId })}": ${describeError({ error: reason })}`,
				);
				return null;
			});
		return {
			id: stickerId,
			provider: providerId,
			name: describedName ?? getStickerNameFromId({ stickerId }),
			previewUrl: resolveStickerId({
				stickerId,
				options: { width: 64, height: 64 },
			}),
			metadata: {},
		};
	} catch (reason) {
		console.warn(
			`Dropped "${describeId({ value: stickerId })}" from recently used stickers: ${describeError({ error: reason })}`,
		);
		return null;
	}
}

export async function searchStickers({
	query,
	category,
	limit,
	providers: injectedProviders,
}: {
	query: string;
	category: StickerCategory;
	/** Omitted: every match (category view) or a short list per provider (All). */
	limit?: number;
	/** Tests pass fake providers; the app uses the registered ones. */
	providers?: StickerProvider[];
}): Promise<StickerSearchResult> {
	const providers = getProviders({ injected: injectedProviders });

	const effectiveCategory = isStickerCategory(category) ? category : "all";
	if (effectiveCategory !== "all") {
		const provider = getProviderByCategory({
			category: effectiveCategory,
			providers,
		});
		if (!provider) {
			return getEmptySearchResult();
		}
		const outcome = await callProvider({
			provider,
			action: "search",
			run: () =>
				provider.search({ query, options: { limit: limit ?? NO_LIMIT } }),
		});
		return outcome.status === "ok"
			? outcome.result
			: { ...getEmptySearchResult(), error: outcome.message };
	}

	if (providers.length === 0) {
		return getEmptySearchResult();
	}

	const perProviderLimit = Math.max(
		1,
		Math.ceil(Math.min(limit ?? DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT) / providers.length),
	);
	const outcomes = await Promise.all(
		providers.map((provider) =>
			callProvider({
				provider,
				action: "search",
				run: () => provider.search({ query, options: { limit: perProviderLimit } }),
			}),
		),
	);

	return mergeSearchResults({
		results: outcomes.map((outcome) =>
			outcome.status === "ok"
				? outcome.result
				: { ...getEmptySearchResult(), error: outcome.message },
		),
	});
}

export async function searchAll({
	query,
	limit = DEFAULT_SEARCH_LIMIT,
	providers: injectedProviders,
}: {
	query: string;
	limit?: number;
	providers?: StickerProvider[];
}): Promise<StickerBrowseResult> {
	const providers = getProviders({ injected: injectedProviders });
	if (providers.length === 0) {
		return { sections: [] };
	}

	const perProviderLimit = Math.max(1, Math.ceil(limit / providers.length));
	const outcomes = await Promise.all(
		providers.map((provider) =>
			callProvider({
				provider,
				action: "search",
				run: () => provider.search({ query, options: { limit: perProviderLimit } }),
			}),
		),
	);

	const sections: StickerBrowseResult["sections"] = [];
	for (const outcome of outcomes) {
		if (outcome.status === "failed") {
			sections.push(errorSection({ provider: outcome.provider, message: outcome.message }));
			continue;
		}
		const { provider, result } = outcome;
		if (result.error) {
			sections.push(errorSection({ provider, message: result.error }));
			continue;
		}
		if (result.items.length === 0) {
			continue;
		}
		const category = provider.id as StickerCategory;
		sections.push({
			id: category,
			title: categoryLabel({ providerId: provider.id }),
			items: result.items,
			hasMore: result.hasMore,
			layout: "grid",
			// Cut short: "See all" opens the category tab, which repeats this search.
			...(result.hasMore
				? { action: { type: "see-all" as const, category } }
				: {}),
		});
	}

	return { sections };
}

export async function browseCategory({
	category,
	providers: injectedProviders,
}: {
	category: StickerCategory;
	providers?: StickerProvider[];
}): Promise<StickerBrowseResult> {
	const providers = getProviders({ injected: injectedProviders });

	const effectiveCategory = isStickerCategory(category) ? category : "all";
	if (effectiveCategory === "all") {
		return getEmptyBrowseResult();
	}

	const provider = getProviderByCategory({ category: effectiveCategory, providers });
	if (!provider) {
		return getEmptyBrowseResult();
	}

	const outcome = await callProvider({
		provider,
		action: "browse",
		run: () => provider.browse({ options: {} }),
	});
	return outcome.status === "ok"
		? outcome.result
		: { ...getEmptyBrowseResult(), error: outcome.message };
}

export async function browseAll({
	recentStickers,
	limit = DEFAULT_BROWSE_LIMIT,
	providers: injectedProviders,
}: {
	recentStickers: string[];
	limit?: number;
	providers?: StickerProvider[];
}): Promise<StickerBrowseResult> {
	const providers = getProviders({ injected: injectedProviders });

	// The name lookups and the provider catalogs do not depend on each other.
	const [recentResults, outcomes] = await Promise.all([
		Promise.all(
			recentStickers.map((stickerId) =>
				toRecentStickerItem({ stickerId, providers }),
			),
		),
		Promise.all(
			providers.map((provider) =>
				callProvider({
					provider,
					action: "browse",
					run: () => provider.browse({ options: { limit } }),
				}),
			),
		),
	]);

	const sections: StickerBrowseResult["sections"] = [];
	const recentItems = recentResults.filter(
		(item): item is StickerItem => item !== null,
	);

	if (recentItems.length > 0) {
		sections.push({
			id: "recent",
			title: "Recently used",
			items: recentItems.slice(0, limit),
			hasMore: recentItems.length > limit,
			layout: "row",
		});
	}

	for (const outcome of outcomes) {
		if (outcome.status === "failed") {
			sections.push(errorSection({ provider: outcome.provider, message: outcome.message }));
			continue;
		}
		const { provider, result } = outcome;
		if (result.error) {
			sections.push(errorSection({ provider, message: result.error }));
			continue;
		}
		const firstSection = result.sections[0];
		if (!firstSection || firstSection.items.length === 0) {
			continue;
		}

		const category = provider.id as StickerCategory;
		sections.push({
			...firstSection,
			id: category,
			title: categoryLabel({ providerId: provider.id }),
			layout: "row" as const,
			// Only when the row is cut short; a category shown in full has nothing more.
			...(firstSection.hasMore
				? {
						action: {
							type: "see-all" as const,
							category,
							sectionId: firstSection.id,
						},
					}
				: {}),
		});
	}

	return { sections };
}

/**
 * The natural size of a sticker's image. Rejects when the sticker cannot be
 * loaded (a broken id, a missing file, no answer in 10 s): adding it would put
 * an element on the timeline that renders as nothing.
 */
export async function resolveStickerIntrinsicSize({
	stickerId,
}: {
	stickerId: string;
}): Promise<{ width: number; height: number }> {
	const url = resolveStickerId({ stickerId });
	try {
		const image = await loadImage({ url });
		return { width: image.naturalWidth, height: image.naturalHeight };
	} catch (reason) {
		throw new Error(`Sticker "${describeId({ value: stickerId })}" could not be loaded`, {
			cause: reason,
		});
	}
}

export { resolveStickerId };
export { resolveQueryToRegions, getRegionLabel } from "./providers/flags";
export type {
	StickerBrowseResult,
	StickerBrowseSection,
	StickerCategory,
	StickerItem,
	StickerProvider,
	StickerResolveOptions,
	StickerSearchResult,
} from "./types";
