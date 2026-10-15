/**
 * Pure logic for the emoji catalog: parsing the Unicode CLDR annotations,
 * building the compact index that ships in `public/emoji/index.json`, and
 * searching it. No DOM, no network, so both the generator script
 * (`scripts/generate-emoji.ts`) and the sticker provider use it.
 */

import {
	clampQuery,
	createSearchDocument,
	rankSearchEntries,
	type RankableEntry,
} from "../search-fold";
import { getOrThrow, isRecord, readStringArray } from "./catalog-utils";

export interface FluentEmojiMetadata {
	cldr?: string;
	glyph: string;
	group: string;
	keywords?: string[];
	tts?: string;
	unicode: string;
}

export interface FluentEmojiRecord {
	/** Folder name in the Fluent repository, e.g. "Grinning face". */
	folder: string;
	metadata: FluentEmojiMetadata;
}

export interface CldrAnnotations {
	/** Short name (the `tts` annotation) by emoji, U+FE0F removed from keys. */
	names: Map<string, string>;
	/** Search keywords by emoji. */
	keywords: Map<string, string[]>;
	/** File position of each emoji. CLDR lists emoji in the standard order. */
	order: Map<string, number>;
}

/**
 * Compact on purpose (1,595 items): `id` doubles as the SVG file name,
 * `n`/`k` are the English name and keywords, `tr`/`kt` the Turkish ones,
 * `g` indexes `EmojiIndex.groups`.
 */
export interface EmojiIndexItem {
	id: string;
	n: string;
	tr?: string;
	g: number;
	k: string[];
	kt: string[];
}

export interface EmojiIndex {
	version: 1;
	/** Pinned upstream commits the data came from. */
	source?: { fluentEmoji: string; cldr: string };
	groups: string[];
	items: EmojiIndexItem[];
}

const VARIATION_SELECTOR_16 = "️";
const UNICODE_ID_PATTERN = /^[0-9a-f]+(?:-[0-9a-f]+)*$/;
const MAX_CODE_POINT = 0x10ffff;

/** Unicode's standard group order; unknown groups go after these. */
const CANONICAL_GROUP_ORDER = [
	"Smileys & Emotion",
	"People & Body",
	"Animals & Nature",
	"Food & Drink",
	"Travel & Places",
	"Activities",
	"Objects",
	"Symbols",
	"Flags",
];

const ANNOTATION_PATTERN = /<annotation\b([^>]*)>([^<]*)<\/annotation>/g;
const CP_ATTRIBUTE_PATTERN = /\bcp="([^"]*)"/;
const TYPE_ATTRIBUTE_PATTERN = /\btype="([^"]*)"/;
const XML_ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;

const NAMED_XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function decodeXmlEntities({ text }: { text: string }): string {
	return text.replace(XML_ENTITY_PATTERN, (match, entity: string) => {
		const lowerEntity = entity.toLowerCase();
		if (lowerEntity in NAMED_XML_ENTITIES) {
			return NAMED_XML_ENTITIES[lowerEntity];
		}
		const codePoint =
			lowerEntity[1] === "x"
				? Number.parseInt(lowerEntity.slice(2), 16)
				: Number.parseInt(lowerEntity.slice(1), 10);
		return Number.isInteger(codePoint) &&
			codePoint >= 0 &&
			codePoint <= MAX_CODE_POINT
			? String.fromCodePoint(codePoint)
			: match;
	});
}

function normalizeCldrKey({ glyph }: { glyph: string }): string {
	return glyph.replaceAll(VARIATION_SELECTOR_16, "");
}

function uniqueWithout({
	values,
	exclude,
}: {
	values: string[];
	exclude: string | undefined;
}): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || trimmed === exclude || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

export function parseCldrAnnotations({
	xml,
}: {
	xml: string;
}): CldrAnnotations {
	const names = new Map<string, string>();
	const keywords = new Map<string, string[]>();
	const order = new Map<string, number>();

	for (const match of xml.matchAll(ANNOTATION_PATTERN)) {
		const attributes = match[1];
		const cpMatch = CP_ATTRIBUTE_PATTERN.exec(attributes);
		if (!cpMatch) {
			continue;
		}
		const key = normalizeCldrKey({
			glyph: decodeXmlEntities({ text: cpMatch[1] }),
		});
		const text = decodeXmlEntities({ text: match[2] });
		const type = TYPE_ATTRIBUTE_PATTERN.exec(attributes)?.[1];

		if (!order.has(key)) {
			order.set(key, order.size);
		}
		if (type === "tts") {
			names.set(key, text.trim());
		} else {
			keywords.set(
				key,
				uniqueWithout({ values: text.split("|"), exclude: undefined }),
			);
		}
	}

	return { names, keywords, order };
}

/**
 * `annotations/*.xml` has the base emoji; `annotationsDerived/*.xml` has the
 * derived sequences (hair colours, keycaps, direction variants). Base wins
 * where both exist, and derived-only emoji sort after every base emoji.
 */
export function mergeCldrAnnotations({
	base,
	derived,
}: {
	base: CldrAnnotations;
	derived: CldrAnnotations;
}): CldrAnnotations {
	const names = new Map([...derived.names, ...base.names]);
	const keywords = new Map([...derived.keywords, ...base.keywords]);
	const order = new Map(base.order);
	for (const [key, position] of derived.order) {
		if (!order.has(key)) {
			order.set(key, base.order.size + position);
		}
	}
	return { names, keywords, order };
}

const FLUENT_ASSET_FOLDER_PATTERN = /^assets\/([^/]+)\//;

/**
 * A folder name becomes part of a download URL and a cache file path, so only
 * the characters the real names use are allowed: letters (also accented),
 * digits, spaces, "-", "!" and "'", starting with a letter or digit. That
 * leaves out ".", "..", separators, backslashes and control characters.
 */
const SAFE_FOLDER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} !'-]*$/u;

export function isSafeFluentFolderName({ name }: { name: string }): boolean {
	return SAFE_FOLDER_NAME.test(name);
}

/** Emoji folder names under `assets/` in the Fluent repository tree. */
export function listFluentFolders({ paths }: { paths: string[] }): string[] {
	const folders = new Set<string>();
	for (const path of paths) {
		const folder = FLUENT_ASSET_FOLDER_PATTERN.exec(path)?.[1];
		if (!folder) {
			continue;
		}
		if (!isSafeFluentFolderName({ name: folder })) {
			throw new Error(`Unsafe Fluent folder name: "${folder.slice(0, 80)}"`);
		}
		folders.add(folder);
	}
	return [...folders].sort();
}

/**
 * The Flat-style SVG of an emoji's default skin tone. Emoji without skin tones
 * keep it at `<folder>/Flat/`, the others at `<folder>/Default/Flat/`.
 */
export function pickDefaultFlatSvgPath({
	paths,
	folder,
}: {
	paths: string[];
	folder: string;
}): string | null {
	const directPrefix = `assets/${folder}/Flat/`;
	const defaultTonePrefix = `assets/${folder}/Default/Flat/`;
	const isFlatSvg = ({ path, prefix }: { path: string; prefix: string }) =>
		path.startsWith(prefix) &&
		path.endsWith(".svg") &&
		!path.slice(prefix.length).includes("/");

	return (
		paths.find((path) => isFlatSvg({ path, prefix: directPrefix })) ??
		paths.find((path) => isFlatSvg({ path, prefix: defaultTonePrefix })) ??
		null
	);
}

export function fluentUnicodeToId({ unicode }: { unicode: string }): string {
	const id = unicode.trim().toLowerCase().split(/\s+/).join("-");
	if (!isValidEmojiId({ id })) {
		throw new Error(`Invalid Fluent unicode value: "${unicode}"`);
	}
	return id;
}

export function isValidEmojiId({ id }: { id: string }): boolean {
	if (!UNICODE_ID_PATTERN.test(id)) {
		return false;
	}
	return id
		.split("-")
		.every((hex) => Number.parseInt(hex, 16) <= MAX_CODE_POINT);
}

/** The emoji character(s) for an id; returns the id itself when it is malformed. */
export function idToGlyph({ id }: { id: string }): string {
	if (!isValidEmojiId({ id })) {
		return id;
	}
	return String.fromCodePoint(
		...id.split("-").map((hex) => Number.parseInt(hex, 16)),
	);
}

interface PreparedEmoji {
	item: Omit<EmojiIndexItem, "g">;
	group: string;
	order: number;
}

function requireText({
	value,
	field,
	folder,
}: {
	value: string | undefined;
	field: string;
	folder: string;
}): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Fluent emoji "${folder}" has no ${field}`);
	}
	return value;
}

function prepareEmoji({
	record,
	cldr,
}: {
	record: FluentEmojiRecord;
	cldr: CldrAnnotations;
}): PreparedEmoji {
	const { folder, metadata } = record;
	const glyph = requireText({ value: metadata.glyph, field: "glyph", folder });
	const group = requireText({ value: metadata.group, field: "group", folder });
	const unicode = requireText({
		value: metadata.unicode,
		field: "unicode",
		folder,
	});

	const key = normalizeCldrKey({ glyph });
	const name = (metadata.tts || metadata.cldr || folder).trim().toLowerCase();
	const trName = cldr.names.get(key) || undefined;

	return {
		item: {
			id: fluentUnicodeToId({ unicode }),
			n: name,
			...(trName ? { tr: trName } : {}),
			k: uniqueWithout({ values: metadata.keywords ?? [], exclude: name }),
			kt: uniqueWithout({
				values: cldr.keywords.get(key) ?? [],
				exclude: trName,
			}),
		},
		group,
		order: cldr.order.get(key) ?? Number.MAX_SAFE_INTEGER,
	};
}

function orderGroups({ groups }: { groups: Set<string> }): string[] {
	const canonical = CANONICAL_GROUP_ORDER.filter((group) => groups.has(group));
	const unknown = [...groups]
		.filter((group) => !CANONICAL_GROUP_ORDER.includes(group))
		.sort();
	return [...canonical, ...unknown];
}

/**
 * Deterministic: the result does not depend on the order of `fluent` (the
 * repository folders are alphabetical, which is useless in a picker). Items
 * are grouped in Unicode's group order and follow CLDR's order inside a group.
 */
export function buildEmojiIndex({
	fluent,
	cldr,
}: {
	fluent: FluentEmojiRecord[];
	cldr: CldrAnnotations;
}): EmojiIndex {
	const prepared = fluent.map((record) => prepareEmoji({ record, cldr }));

	const seenIds = new Set<string>();
	for (const { item } of prepared) {
		if (seenIds.has(item.id)) {
			throw new Error(`Duplicate emoji id: ${item.id}`);
		}
		seenIds.add(item.id);
	}

	const groups = orderGroups({
		groups: new Set(prepared.map((entry) => entry.group)),
	});
	const groupIndex = new Map(groups.map((group, index) => [group, index]));

	const sorted = prepared
		.map((entry) => ({
			...entry,
			groupRank: getOrThrow({ map: groupIndex, key: entry.group }),
		}))
		.sort((a, b) => {
			if (a.groupRank !== b.groupRank) {
				return a.groupRank - b.groupRank;
			}
			if (a.order !== b.order) {
				return a.order < b.order ? -1 : 1;
			}
			return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
		});

	return {
		version: 1,
		groups,
		items: sorted.map((entry) => ({ ...entry.item, g: entry.groupRank })),
	};
}

function parseEmojiIndexItem({
	raw,
	groupCount,
}: {
	raw: unknown;
	groupCount: number;
}): EmojiIndexItem {
	if (!isRecord(raw)) {
		throw new Error("Emoji index item must be an object");
	}
	const { id, n, tr, g } = raw;
	if (typeof id !== "string" || !isValidEmojiId({ id })) {
		throw new Error(`Invalid emoji id in index: ${String(id)}`);
	}
	if (typeof n !== "string" || n === "") {
		throw new Error(`Emoji ${id} has no name`);
	}
	if (tr !== undefined && typeof tr !== "string") {
		throw new Error(`Emoji ${id} has a non-text Turkish name`);
	}
	if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g >= groupCount) {
		throw new Error(`Emoji ${id} points at a missing group`);
	}
	return {
		id,
		n,
		...(tr === undefined ? {} : { tr }),
		g,
		k: readStringArray({ value: raw.k, label: `Emoji ${id} keywords` }),
		kt: readStringArray({ value: raw.kt, label: `Emoji ${id} Turkish keywords` }),
	};
}

/**
 * Validates the parsed `index.json` before the provider trusts it: ids end up
 * in URLs, so anything malformed is rejected rather than half-used.
 */
export function parseEmojiIndex({ value }: { value: unknown }): EmojiIndex {
	if (!isRecord(value) || value.version !== 1) {
		throw new Error("Not an emoji index (expected version 1)");
	}
	const groups = readStringArray({ value: value.groups, label: "Emoji index groups" });
	if (!Array.isArray(value.items)) {
		throw new Error("Emoji index items must be an array");
	}
	const items = value.items.map((raw: unknown) =>
		parseEmojiIndexItem({ raw, groupCount: groups.length }),
	);

	const { source } = value;
	const parsedSource =
		isRecord(source) &&
		typeof source.fluentEmoji === "string" &&
		typeof source.cldr === "string"
			? { fluentEmoji: source.fluentEmoji, cldr: source.cldr }
			: undefined;
	return {
		version: 1,
		...(parsedSource ? { source: parsedSource } : {}),
		groups,
		items,
	};
}

export type EmojiSearchEntry = RankableEntry<EmojiIndexItem>;

export function buildEmojiSearchEntries({
	index,
}: {
	index: EmojiIndex;
}): EmojiSearchEntry[] {
	return index.items.map((item) => ({
		value: item,
		document: createSearchDocument({
			primary: item.tr ? [item.n, item.tr] : [item.n],
			secondary: [...item.k, ...item.kt],
		}),
	}));
}

const SKIN_TONE_MODIFIERS = /[\u{1F3FB}-\u{1F3FF}]/gu;
const KEYCAP = "\u20E3";
const WORD_CLUSTER = /^[\p{L}\p{N}\p{M}]+$/u;
const WHITESPACE_CLUSTER = /^\s+$/u;

function splitGraphemes({ text }: { text: string }): string[] {
	if (typeof Intl.Segmenter === "function") {
		return Array.from(
			new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
			(part) => part.segment,
		);
	}
	return Array.from(text);
}

/**
 * The emoji the user typed or pasted, one grapheme cluster each, or null when
 * the query is text. Text (letters, digits, accents) always searches by name;
 * a query made only of symbol clusters (and keycaps, which contain a digit)
 * looks up those emoji instead.
 */
function readGlyphQuery({ query }: { query: string }): string[] | null {
	const clusters = splitGraphemes({ text: clampQuery({ query }) }).filter(
		(cluster) => !WHITESPACE_CLUSTER.test(cluster),
	);
	if (clusters.length === 0) {
		return null;
	}
	const isGlyph = (cluster: string) =>
		cluster.includes(KEYCAP) || !WORD_CLUSTER.test(cluster);
	return clusters.every(isGlyph) ? clusters : null;
}

function normalizeGlyph({ glyph }: { glyph: string }): string {
	return glyph.replaceAll(VARIATION_SELECTOR_16, "");
}

const glyphLookupCache = new WeakMap<
	EmojiSearchEntry[],
	Map<string, EmojiIndexItem>
>();

function getGlyphLookup({
	entries,
}: {
	entries: EmojiSearchEntry[];
}): Map<string, EmojiIndexItem> {
	const cached = glyphLookupCache.get(entries);
	if (cached) {
		return cached;
	}
	const lookup = new Map(
		entries.map((entry) => [
			normalizeGlyph({ glyph: idToGlyph({ id: entry.value.id }) }),
			entry.value,
		]),
	);
	glyphLookupCache.set(entries, lookup);
	return lookup;
}

function searchByGlyph({
	entries,
	glyphs,
}: {
	entries: EmojiSearchEntry[];
	glyphs: string[];
}): EmojiIndexItem[] {
	const lookup = getGlyphLookup({ entries });
	const found = new Map<string, EmojiIndexItem>();
	for (const glyph of glyphs) {
		const exact = normalizeGlyph({ glyph });
		// Fluent ships the default skin tone only: 👋🏽 falls back to 👋.
		const item =
			lookup.get(exact) ?? lookup.get(exact.replace(SKIN_TONE_MODIFIERS, ""));
		if (item) {
			found.set(item.id, item);
		}
	}
	return [...found.values()];
}

/**
 * Best matches first; equally ranked matches keep the index order. A query
 * that is an emoji (typed or pasted) finds that emoji.
 */
export function searchEmojiEntries({
	entries,
	query,
}: {
	entries: EmojiSearchEntry[];
	query: string;
}): EmojiIndexItem[] {
	const glyphs = readGlyphQuery({ query });
	if (glyphs) {
		return searchByGlyph({ entries, glyphs });
	}
	return rankSearchEntries({ entries, query });
}
