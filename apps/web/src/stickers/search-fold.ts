/**
 * Shared text folding and scoring for the offline sticker catalogs (emoji and
 * icons). Both the catalog text and the user's query go through
 * `foldSearchText`, so they only need to agree after folding.
 */

const COMBINING_MARKS = /\p{M}/gu;
const NON_WORD_CHARACTERS = /[^\p{L}\p{N}]+/u;

/** The query is a whole name ("fire" for the emoji named "fire"). */
const RANK_WHOLE_NAME = -2;
/**
 * An exact name word that the keywords repeat ("heart" in the name "red heart"
 * and in its keyword list): the entry is about that word, not just mentions it.
 */
const RANK_PRIMARY_EXACT_CONFIRMED = -0.5;
const RANK_PRIMARY_EXACT = 0;
const RANK_PRIMARY_PREFIX = 1;
const RANK_SECONDARY_EXACT = 2;
const RANK_SECONDARY_PREFIX = 3;

/**
 * Lowercases with Turkish rules (so "I" becomes dotless "ı" and "İ" becomes
 * "i"), strips diacritics (ç ğ ş ö ü and other Latin accents) and finally maps
 * the dotless "ı" to "i" (it has no Unicode decomposition). Result: "IŞIK",
 * "ışık" and "isik" all fold to "isik".
 */
export function foldSearchText({ text }: { text: string }): string {
	return text
		.toLocaleLowerCase("tr")
		.normalize("NFD")
		.replace(COMBINING_MARKS, "")
		.replaceAll("ı", "i");
}

/** A query longer than this is cut: nobody types 200 characters of search. */
export const MAX_QUERY_CHARS = 200;
/** Words beyond these are ignored (each one is matched against every entry). */
export const MAX_QUERY_TOKENS = 8;

const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/** The query as searched: at most MAX_QUERY_CHARS, without half an emoji at the cut. */
export function clampQuery({ query }: { query: string }): string {
	if (query.length <= MAX_QUERY_CHARS) {
		return query;
	}
	const cut = query.slice(0, MAX_QUERY_CHARS);
	return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The words of a user query: cut to MAX_QUERY_CHARS first (a 100 KB paste must
 * not be tokenised), folded like the catalog text, de-duplicated and limited
 * to MAX_QUERY_TOKENS.
 */
export function tokenizeQuery({ text }: { text: string }): string[] {
	return [
		...new Set(tokenizeSearchText({ text: clampQuery({ query: text }) })),
	].slice(0, MAX_QUERY_TOKENS);
}

export function tokenizeSearchText({ text }: { text: string }): string[] {
	return foldSearchText({ text })
		.split(NON_WORD_CHARACTERS)
		.filter((token) => token.length > 0);
}

/** Names longer than this stop counting, so the tie-break stays below 0.5. */
const MAX_COUNTED_NAME_WORDS = 49;
const NAME_WORD_WEIGHT = 0.01;

/**
 * `primary` words (names) outrank `secondary` words (keywords, tags).
 * All words are stored folded. `names` are the whole primary names, folded and
 * joined with single spaces; `nameWords` are the same names as word lists.
 */
export interface SearchDocument {
	primary: string[];
	secondary: string[];
	names: string[];
	nameWords: string[][];
}

export function createSearchDocument({
	primary,
	secondary,
}: {
	primary: string[];
	secondary: string[];
}): SearchDocument {
	const nameWords = primary
		.map((text) => tokenizeSearchText({ text }))
		.filter((words) => words.length > 0);
	return {
		primary: nameWords.flat(),
		secondary: secondary.flatMap((text) => tokenizeSearchText({ text })),
		names: nameWords.map((words) => words.join(" ")),
		nameWords,
	};
}

function rankToken({
	document,
	token,
}: {
	document: SearchDocument;
	token: string;
}): number | null {
	if (document.primary.includes(token)) {
		return document.secondary.includes(token)
			? RANK_PRIMARY_EXACT_CONFIRMED
			: RANK_PRIMARY_EXACT;
	}
	if (document.primary.some((word) => word.startsWith(token))) {
		return RANK_PRIMARY_PREFIX;
	}
	if (document.secondary.includes(token)) {
		return RANK_SECONDARY_EXACT;
	}
	if (document.secondary.some((word) => word.startsWith(token))) {
		return RANK_SECONDARY_PREFIX;
	}
	return null;
}

/**
 * Word count of the shortest name that the query hits (all names when only the
 * keywords matched): "red heart" is a plainer answer to "heart" than
 * "smiling face with heart-eyes".
 */
function countMatchedNameWords({
	document,
	queryTokens,
}: {
	document: SearchDocument;
	queryTokens: string[];
}): number {
	const hit = document.nameWords.filter((words) =>
		queryTokens.some((token) => words.some((word) => word.startsWith(token))),
	);
	const pool = hit.length > 0 ? hit : document.nameWords;
	if (pool.length === 0) {
		return 0;
	}
	return Math.min(MAX_COUNTED_NAME_WORDS, Math.min(...pool.map((words) => words.length)));
}

/**
 * Every query token must match the start of some word of the document.
 * Returns a rank (lower is better) or null when the document does not match.
 * A query that is exactly one of the document's names beats every other match.
 * Matches of the same rank are separated by the length of the matching name
 * (a fraction of a rank step, so it never reorders different ranks).
 */
export function scoreSearchDocument({
	document,
	queryTokens,
}: {
	document: SearchDocument;
	queryTokens: string[];
}): number | null {
	if (queryTokens.length === 0) {
		return null;
	}
	const nameLength = countMatchedNameWords({ document, queryTokens });
	if (document.names.includes(queryTokens.join(" "))) {
		return RANK_WHOLE_NAME + nameLength * NAME_WORD_WEIGHT;
	}

	let total = 0;
	for (const token of queryTokens) {
		const rank = rankToken({ document, token });
		if (rank === null) {
			return null;
		}
		total += rank;
	}
	return total + nameLength * NAME_WORD_WEIGHT;
}

export interface RankableEntry<T> {
	value: T;
	document: SearchDocument;
}

/** Best matches first; equally ranked matches keep the order of `entries`. */
export function rankSearchEntries<T>({
	entries,
	query,
}: {
	entries: RankableEntry<T>[];
	query: string;
}): T[] {
	const queryTokens = tokenizeQuery({ text: query });
	if (queryTokens.length === 0) {
		return [];
	}

	const matches: { value: T; score: number; position: number }[] = [];
	entries.forEach((entry, position) => {
		const score = scoreSearchDocument({
			document: entry.document,
			queryTokens,
		});
		if (score !== null) {
			matches.push({ value: entry.value, score, position });
		}
	});

	return matches
		.sort((a, b) => a.score - b.score || a.position - b.position)
		.map((match) => match.value);
}
