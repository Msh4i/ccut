import { describe, expect, test } from "bun:test";
import {
	createSearchDocument,
	foldSearchText,
	rankSearchEntries,
	scoreSearchDocument,
	tokenizeSearchText,
	type SearchDocument,
} from "../search-fold";

describe("foldSearchText", () => {
	test("folds the Turkish dotted and dotless I the way a Turkish user types them", () => {
		// "ISIK" typed with caps lock on is "ışık" in Turkish, not "isik".
		expect(foldSearchText({ text: "IŞIK" })).toBe("isik");
		expect(foldSearchText({ text: "ışık" })).toBe("isik");
		expect(foldSearchText({ text: "Işık" })).toBe("isik");
		expect(foldSearchText({ text: "İstanbul" })).toBe("istanbul");
		expect(foldSearchText({ text: "ISPARTA" })).toBe("isparta");
	});

	test("folds Turkish diacritics so ASCII keyboards still match", () => {
		expect(foldSearchText({ text: "ÇİÇEK" })).toBe("cicek");
		expect(foldSearchText({ text: "öğrenci" })).toBe("ogrenci");
		expect(foldSearchText({ text: "ÖĞRENCİ" })).toBe("ogrenci");
		expect(foldSearchText({ text: "güneş" })).toBe("gunes");
		expect(foldSearchText({ text: "ŞEKER" })).toBe("seker");
	});

	test("folds other Latin diacritics", () => {
		expect(foldSearchText({ text: "Café" })).toBe("cafe");
		expect(foldSearchText({ text: "piñata" })).toBe("pinata");
	});

	test("keeps digits, ASCII and emoji intact", () => {
		expect(foldSearchText({ text: "Heart 2" })).toBe("heart 2");
		expect(foldSearchText({ text: "😀" })).toBe("😀");
		expect(foldSearchText({ text: "" })).toBe("");
	});

	test("is idempotent", () => {
		const once = foldSearchText({ text: "ŞIĞÇÖÜİ" });
		expect(foldSearchText({ text: once })).toBe(once);
	});

	test("treats a decomposed dotted capital I like the precomposed one", () => {
		expect(foldSearchText({ text: "İstanbul" })).toBe("istanbul");
	});
});

describe("tokenizeSearchText", () => {
	test("splits on whitespace, hyphens and punctuation after folding", () => {
		expect(tokenizeSearchText({ text: "Arrow-Circle: Up/Right" })).toEqual([
			"arrow",
			"circle",
			"up",
			"right",
		]);
	});

	test("returns an empty list for blank or punctuation-only input", () => {
		expect(tokenizeSearchText({ text: "" })).toEqual([]);
		expect(tokenizeSearchText({ text: "  - : " })).toEqual([]);
	});
});

describe("scoreSearchDocument", () => {
	const heart = createSearchDocument({
		primary: ["red heart", "kırmızı kalp"],
		secondary: ["aşk", "sevgi", "love"],
	});

	function score({
		query,
		document = heart,
	}: {
		query: string;
		document?: SearchDocument;
	}) {
		return scoreSearchDocument({
			document,
			queryTokens: tokenizeSearchText({ text: query }),
		});
	}

	function scoreOrThrow({
		query,
		document = heart,
	}: {
		query: string;
		document?: SearchDocument;
	}): number {
		const value = score({ query, document });
		if (value === null) {
			throw new Error(`"${query}" should match`);
		}
		return value;
	}

	test("matches English and Turkish, case- and diacritic-insensitively", () => {
		expect(score({ query: "heart" })).not.toBeNull();
		expect(score({ query: "KALP" })).not.toBeNull();
		expect(score({ query: "KIRMIZI" })).not.toBeNull();
		expect(score({ query: "kirmizi" })).not.toBeNull();
		expect(score({ query: "ASK" })).not.toBeNull();
		expect(score({ query: "aşk" })).not.toBeNull();
	});

	test("matches word prefixes but not the middle of a word", () => {
		expect(score({ query: "hea" })).not.toBeNull();
		expect(score({ query: "art" })).toBeNull();
	});

	test("requires every query token to match", () => {
		expect(score({ query: "red love" })).not.toBeNull();
		expect(score({ query: "red banana" })).toBeNull();
	});

	test("ranks exact primary words ahead of prefixes and secondary words", () => {
		const exactPrimary = scoreOrThrow({ query: "heart" });
		const prefixPrimary = scoreOrThrow({ query: "hear" });
		const exactSecondary = scoreOrThrow({ query: "love" });
		const prefixSecondary = scoreOrThrow({ query: "lov" });
		expect(exactPrimary).toBeLessThan(prefixPrimary);
		expect(prefixPrimary).toBeLessThan(exactSecondary);
		expect(exactSecondary).toBeLessThan(prefixSecondary);
	});

	test("an empty token list matches nothing", () => {
		expect(scoreSearchDocument({ document: heart, queryTokens: [] })).toBeNull();
	});

	test("a query equal to a whole name outranks a word inside a longer name", () => {
		const fire = createSearchDocument({ primary: ["fire"], secondary: [] });
		const engine = createSearchDocument({ primary: ["fire engine"], secondary: [] });
		const wholeName = scoreOrThrow({ query: "fire", document: fire });
		const wordInName = scoreOrThrow({ query: "fire", document: engine });
		expect(wholeName).toBeLessThan(wordInName);
		// Folded, so the Turkish capital I still counts as the whole name.
		const turkish = createSearchDocument({ primary: ["kırmızı kalp"], secondary: [] });
		expect(scoreOrThrow({ query: "KIRMIZI KALP", document: turkish })).toBeLessThan(
			scoreOrThrow({ query: "kalp", document: turkish }),
		);
	});
});

describe("rankSearchEntries", () => {
	const entries = [
		{
			value: "late-keyword",
			document: createSearchDocument({ primary: ["moon"], secondary: ["star"] }),
		},
		{
			value: "early-prefix",
			document: createSearchDocument({ primary: ["starfish"], secondary: [] }),
		},
		{
			value: "exact-a",
			document: createSearchDocument({ primary: ["star"], secondary: [] }),
		},
		{
			value: "exact-b",
			document: createSearchDocument({ primary: ["big star"], secondary: [] }),
		},
		{
			value: "exact-c",
			document: createSearchDocument({ primary: ["star wars"], secondary: [] }),
		},
		{
			value: "no-match",
			document: createSearchDocument({ primary: ["sun"], secondary: [] }),
		},
	];

	test("orders by rank and keeps the original order for ties", () => {
		expect(rankSearchEntries({ entries, query: "star" })).toEqual([
			"exact-a",
			"exact-b",
			"exact-c",
			"early-prefix",
			"late-keyword",
		]);
	});

	test("returns nothing for blank or token-less queries", () => {
		expect(rankSearchEntries({ entries, query: "" })).toEqual([]);
		expect(rankSearchEntries({ entries, query: " .* " })).toEqual([]);
	});

	test("does not modify the entries it is given", () => {
		const before = entries.map((entry) => entry.value);
		rankSearchEntries({ entries, query: "star" });
		expect(entries.map((entry) => entry.value)).toEqual(before);
	});
});

describe("tie-breaking between equally good matches", () => {
	function order({
		entries,
		query,
	}: {
		entries: { value: string; primary: string[]; secondary?: string[] }[];
		query: string;
	}) {
		return rankSearchEntries({
			entries: entries.map((entry) => ({
				value: entry.value,
				document: createSearchDocument({
					primary: entry.primary,
					secondary: entry.secondary ?? [],
				}),
			})),
			query,
		});
	}

	test("a shorter matching name comes first, whatever the input order", () => {
		expect(
			order({
				query: "heart",
				entries: [
					{ value: "five-words", primary: ["smiling face with heart eyes"] },
					{ value: "three-words", primary: ["heart with arrow"] },
					{ value: "two-words", primary: ["red heart"] },
				],
			}),
		).toEqual(["two-words", "three-words", "five-words"]);
	});

	test("the name length that counts is that of the name that matched", () => {
		// "kalp" matches the long Turkish name word; the short English name is unrelated.
		expect(
			order({
				query: "kalp",
				entries: [
					{ value: "long-tr", primary: ["x", "kirmizi sevgi dolu kalp"] },
					{ value: "short-tr", primary: ["longer english name here", "iki kalp"] },
				],
			}),
		).toEqual(["short-tr", "long-tr"]);
	});

	test("a keyword that repeats the query beats a name-only match", () => {
		expect(
			order({
				query: "heart",
				entries: [
					{ value: "name-only", primary: ["sparkling heart"], secondary: ["sparkle"] },
					{ value: "name-and-keyword", primary: ["red heart"], secondary: ["heart"] },
				],
			}),
		).toEqual(["name-and-keyword", "name-only"]);
	});

	test("secondary-only matches are also ordered by name length", () => {
		expect(
			order({
				query: "smile",
				entries: [
					{ value: "five", primary: ["grinning face with big eyes"], secondary: ["smile"] },
					{ value: "two", primary: ["smiling face"], secondary: ["smile"] },
				],
			}),
		).toEqual(["two", "five"]);
	});

	test("never outweighs a better rank, however short the name", () => {
		expect(
			order({
				query: "star",
				entries: [
					{ value: "prefix-short", primary: ["starfish"] },
					{
						value: "exact-very-long",
						primary: [
							"one two three four five six seven eight nine ten eleven twelve star",
						],
					},
				],
			}),
		).toEqual(["exact-very-long", "prefix-short"]);
	});

	test("a whole-name match still beats everything", () => {
		expect(
			order({
				query: "heart",
				entries: [
					{ value: "name-and-keyword", primary: ["red heart"], secondary: ["heart"] },
					{ value: "whole", primary: ["heart"] },
				],
			}),
		).toEqual(["whole", "name-and-keyword"]);
	});
});
