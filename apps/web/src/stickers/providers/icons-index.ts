/**
 * Pure logic for the icon catalog (Phosphor Icons, regular and fill weights):
 * which icons ship, the compact index in `public/icons/phosphor/index.json`,
 * sticker id handling and search. No DOM, no network, no filesystem, so the
 * generator script (`scripts/generate-icons.ts`) and the sticker provider
 * share it.
 */

import {
	createSearchDocument,
	rankSearchEntries,
	type RankableEntry,
} from "../search-fold";
import { getOrThrow, isRecord, readStringArray } from "./catalog-utils";

/** The fields of `@phosphor-icons/core`'s catalog entries we use. */
export interface PhosphorCatalogEntry {
	name: string;
	categories: readonly string[];
	figma_category: string;
	tags: readonly string[];
}

export type IconWeight = "regular" | "fill";

/** `n` is the Phosphor icon name, `g` indexes `groups`, `t` are search tags. */
export interface IconsIndexItem {
	n: string;
	g: number;
	t: string[];
}

export interface IconsIndex {
	version: 1;
	/** Pinned upstream package the data came from. */
	source?: { phosphorCore: string };
	groups: string[];
	items: IconsIndexItem[];
}

/** One sticker: an icon at one weight. */
export interface IconRecord {
	/** Sticker id value and SVG file name: `heart` or `heart-fill`. */
	id: string;
	name: string;
	weight: IconWeight;
	group: number;
}

const FILL_SUFFIX = "-fill";
const ICON_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOGO_NAME_PATTERN = /-logo(?:-|$)/;
const BRAND_CATEGORY = "brands";

/**
 * Phosphor files `parallelogram` (a plain geometric shape) under brands;
 * every other brands entry is a company logo.
 */
const BRAND_CATEGORY_EXCEPTIONS = new Set(["parallelogram"]);

const WEIGHT_KEYWORDS: Record<IconWeight, string[]> = {
	regular: ["regular", "outline"],
	fill: ["filled", "solid"],
};

/**
 * Company and product logos are not shipped: they carry trademark risk and
 * are outside what the sticker library is for. Phosphor marks them with the
 * "brands" category, and names them `*-logo`.
 */
export function isBrandIcon({ entry }: { entry: PhosphorCatalogEntry }): boolean {
	if (BRAND_CATEGORY_EXCEPTIONS.has(entry.name)) {
		return false;
	}
	return (
		entry.categories.includes(BRAND_CATEGORY) ||
		entry.figma_category === BRAND_CATEGORY ||
		LOGO_NAME_PATTERN.test(entry.name)
	);
}

export function isValidIconId({ id }: { id: string }): boolean {
	return ICON_ID_PATTERN.test(id);
}

export function buildIconId({
	name,
	weight,
}: {
	name: string;
	weight: IconWeight;
}): string {
	return weight === "fill" ? `${name}${FILL_SUFFIX}` : name;
}

function toGroupTitle({ category }: { category: string }): string {
	return category
		.split(" ")
		.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
		.join(" ");
}

function collectTags({ entry }: { entry: PhosphorCatalogEntry }): string[] {
	const tags = new Set<string>();
	for (const raw of [...entry.tags, ...entry.categories]) {
		const tag = raw.trim().toLowerCase();
		if (tag && !tag.startsWith("*")) {
			tags.add(tag);
		}
	}
	return [...tags];
}

/**
 * Deterministic: independent of the catalog order. Icons are grouped by
 * Phosphor's single-valued Figma category and sorted by name.
 */
export function buildIconsIndex({
	catalog,
}: {
	catalog: PhosphorCatalogEntry[];
}): IconsIndex {
	const kept = catalog.filter((entry) => !isBrandIcon({ entry }));

	const seenNames = new Set<string>();
	for (const { name } of kept) {
		if (!isValidIconId({ id: name })) {
			throw new Error(`Unsafe icon name: "${name}"`);
		}
		if (name.endsWith(FILL_SUFFIX)) {
			throw new Error(
				`Icon name "${name}" is ambiguous with the fill variant of "${name.slice(0, -FILL_SUFFIX.length)}"`,
			);
		}
		if (seenNames.has(name)) {
			throw new Error(`Duplicate icon name: ${name}`);
		}
		seenNames.add(name);
	}

	const groups = [
		...new Set(kept.map((entry) => toGroupTitle({ category: entry.figma_category }))),
	].sort();
	const groupIndex = new Map(groups.map((group, index) => [group, index]));

	const items = [...kept]
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((entry) => ({
			n: entry.name,
			g: getOrThrow({
				map: groupIndex,
				key: toGroupTitle({ category: entry.figma_category }),
			}),
			t: collectTags({ entry }),
		}));

	return { version: 1, groups, items };
}

function parseIconsIndexItem({
	raw,
	groupCount,
}: {
	raw: unknown;
	groupCount: number;
}): IconsIndexItem {
	if (!isRecord(raw)) {
		throw new Error("Icons index item must be an object");
	}
	const { n, g } = raw;
	if (typeof n !== "string" || !isValidIconId({ id: n }) || n.endsWith(FILL_SUFFIX)) {
		throw new Error(`Invalid icon name in index: ${String(n)}`);
	}
	if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g >= groupCount) {
		throw new Error(`Icon ${n} points at a missing group`);
	}
	return { n, g, t: readStringArray({ value: raw.t, label: `Icon ${n} tags` }) };
}

/**
 * Validates the parsed `index.json` before the provider trusts it: names end
 * up in URLs, so anything malformed is rejected rather than half-used.
 */
export function parseIconsIndex({ value }: { value: unknown }): IconsIndex {
	if (!isRecord(value) || value.version !== 1) {
		throw new Error("Not an icons index (expected version 1)");
	}
	const groups = readStringArray({ value: value.groups, label: "Icons index groups" });
	if (!Array.isArray(value.items)) {
		throw new Error("Icons index items must be an array");
	}
	const items = value.items.map((raw: unknown) =>
		parseIconsIndexItem({ raw, groupCount: groups.length }),
	);

	const { source } = value;
	const parsedSource =
		isRecord(source) && typeof source.phosphorCore === "string"
			? { phosphorCore: source.phosphorCore }
			: undefined;
	return {
		version: 1,
		...(parsedSource ? { source: parsedSource } : {}),
		groups,
		items,
	};
}

/** Regular first, then fill, for every icon in index order. */
export function expandIconRecords({ index }: { index: IconsIndex }): IconRecord[] {
	return index.items.flatMap((item) =>
		(["regular", "fill"] as const).map((weight) => ({
			id: buildIconId({ name: item.n, weight }),
			name: item.n,
			weight,
			group: item.g,
		})),
	);
}

export type IconSearchEntry = RankableEntry<IconRecord>;

export function buildIconSearchEntries({
	index,
}: {
	index: IconsIndex;
}): IconSearchEntry[] {
	const tagsByName = new Map(index.items.map((item) => [item.n, item.t]));
	return expandIconRecords({ index }).map((record) => ({
		value: record,
		document: createSearchDocument({
			// A fill icon also answers to the plain icon name ("heart" finds
			// heart and heart-fill together), and to "heart fill" on its own.
			primary: record.weight === "fill" ? [record.id, record.name] : [record.id],
			secondary: [
				...(tagsByName.get(record.name) ?? []),
				...WEIGHT_KEYWORDS[record.weight],
			],
		}),
	}));
}

/** Best matches first; equally ranked matches keep the index order. */
export function searchIconEntries({
	entries,
	query,
}: {
	entries: IconSearchEntry[];
	query: string;
}): IconRecord[] {
	return rankSearchEntries({ entries, query });
}
