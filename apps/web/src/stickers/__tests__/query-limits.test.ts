import { describe, expect, test } from "bun:test";
import { createEmojiProvider } from "../providers/emoji";
import { createIconsProvider } from "../providers/icons";
import {
	MAX_QUERY_CHARS,
	MAX_QUERY_TOKENS,
	clampQuery,
	createSearchDocument,
	rankSearchEntries,
	tokenizeQuery,
} from "../search-fold";
import { readEmojiIndexFromDisk, readIconsIndexFromDisk } from "./catalog-fixtures";

// A pasted wall of text must not freeze the picker: the query is cut to 200
// characters, de-duplicated and limited to 8 words before any matching.

describe("clampQuery", () => {
	test("leaves short queries alone and cuts long ones", () => {
		expect(clampQuery({ query: "heart" })).toBe("heart");
		expect(clampQuery({ query: "a".repeat(5_000) })).toHaveLength(MAX_QUERY_CHARS);
	});

	test("never leaves half of an emoji at the cut", () => {
		const text = `${"a".repeat(MAX_QUERY_CHARS - 1)}\u{1F600}`; // the surrogate pair straddles the cut
		const clamped = clampQuery({ query: text });
		expect(clamped).toBe("a".repeat(MAX_QUERY_CHARS - 1));
		expect(/[\uD800-\uDBFF]$/.test(clamped)).toBe(false);
	});
});

describe("tokenizeQuery", () => {
	test("folds like the catalog text, de-duplicates, keeps order", () => {
		expect(tokenizeQuery({ text: "KALP kalp Kırmızı kirmizi KALP" })).toEqual(["kalp", "kirmizi"]);
	});

	test("keeps at most 8 different words", () => {
		const words = Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ");
		expect(tokenizeQuery({ text: words })).toEqual(
			Array.from({ length: MAX_QUERY_TOKENS }, (_, index) => `w${index}`),
		);
	});

	test("a 100 KB paste of 'a ' is one token and takes well under 200 ms", () => {
		const paste = "a ".repeat(50_000);
		const started = performance.now();
		const tokens = tokenizeQuery({ text: paste });
		expect(performance.now() - started).toBeLessThan(200);
		expect(tokens).toEqual(["a"]);
	});

	test("a 100 KB paste of distinct words keeps only the first eight within the cut", () => {
		const paste = Array.from({ length: 20_000 }, (_, index) => `word${index}`).join(" ");
		const tokens = tokenizeQuery({ text: paste });
		expect(tokens.length).toBeLessThanOrEqual(MAX_QUERY_TOKENS);
		expect(tokens[0]).toBe("word0");
	});

	test("blank and punctuation-only text has no tokens", () => {
		expect(tokenizeQuery({ text: "   ---  " })).toEqual([]);
	});
});

describe("searching with a hostile query", () => {
	const entries = [
		{ value: "a", document: createSearchDocument({ primary: ["a"], secondary: [] }) },
		{ value: "b", document: createSearchDocument({ primary: ["b"], secondary: [] }) },
	];

	test("rankSearchEntries is fast and still answers on a 100 KB paste", () => {
		const started = performance.now();
		expect(rankSearchEntries({ entries, query: "a ".repeat(50_000) })).toEqual(["a"]);
		expect(performance.now() - started).toBeLessThan(200);
	});

	test("the emoji and icon providers answer a 100 KB paste in under 200 ms", async () => {
		const emoji = createEmojiProvider({ loadIndex: async () => readEmojiIndexFromDisk() });
		const icons = createIconsProvider({ loadIndex: async () => readIconsIndexFromDisk() });
		await emoji.search({ query: "heart" }); // load the catalogs first: only matching is timed
		await icons.search({ query: "heart" });

		for (const query of ["a ".repeat(50_000), "\u{1F600}".repeat(50_000), `heart ${"x ".repeat(50_000)}`]) {
			for (const provider of [emoji, icons]) {
				const started = performance.now();
				await provider.search({ query });
				expect(performance.now() - started).toBeLessThan(200);
			}
		}
	});
});

describe("a pasted run of emoji is cut like any other query", () => {
	test("only the first 200 characters count: an emoji beyond the cut is not searched", async () => {
		const provider = createEmojiProvider({ loadIndex: async () => readEmojiIndexFromDisk() });
		// 100 grinning faces fill the 200 UTF-16 units exactly; the fire comes after.
		const paste = `${"\u{1F600}".repeat(100)}\u{1F525}`;
		const { items } = await provider.search({ query: paste });
		expect(items.map((item) => item.id)).toEqual(["emoji:1f600"]);
	});
});
