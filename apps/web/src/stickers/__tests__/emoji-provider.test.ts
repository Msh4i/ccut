import { describe, expect, spyOn, test } from "bun:test";
import { createEmojiProvider } from "../providers/emoji";
import type { EmojiIndex } from "../providers/emoji-index";
import { readEmojiIndexFromDisk } from "./catalog-fixtures";

const REAL_INDEX = readEmojiIndexFromDisk();

function createProvider() {
	let loads = 0;
	const provider = createEmojiProvider({
		loadIndex: async () => {
			loads++;
			return REAL_INDEX;
		},
	});
	return { provider, loadCount: () => loads };
}

async function searchIds({
	provider,
	query,
}: {
	provider: ReturnType<typeof createEmojiProvider>;
	query: string;
}) {
	const result = await provider.search({ query });
	return result.items.map((item) => item.id);
}

describe("emoji provider search", () => {
	test("finds emoji by Turkish name, case-insensitively with dotted and dotless I", async () => {
		const { provider } = createProvider();
		const lower = await searchIds({ provider, query: "kırmızı kalp" });
		const upper = await searchIds({ provider, query: "KIRMIZI KALP" });
		const ascii = await searchIds({ provider, query: "kirmizi kalp" });
		expect(lower).toContain("emoji:2764-fe0f");
		expect(upper).toEqual(lower);
		expect(ascii).toEqual(lower);
	});

	test("finds emoji by English name and keyword", async () => {
		const { provider } = createProvider();
		expect(await searchIds({ provider, query: "red heart" })).toContain("emoji:2764-fe0f");
		expect(await searchIds({ provider, query: "grin" })).toContain("emoji:1f600");
	});

	test("puts the exact emoji first for a common word", async () => {
		const { provider } = createProvider();
		const ids = await searchIds({ provider, query: "fire" });
		expect(ids[0]).toBe("emoji:1f525");
	});

	test("folds Turkish diacritics: 'gunes' finds the sun, 'GÜNEŞ' too", async () => {
		const { provider } = createProvider();
		const ascii = await searchIds({ provider, query: "gunes" });
		expect(ascii.length).toBeGreaterThan(0);
		expect(await searchIds({ provider, query: "GÜNEŞ" })).toEqual(ascii);
		expect(ascii).toContain("emoji:2600-fe0f");
	});

	test("reports total and hasMore against the limit", async () => {
		const { provider } = createProvider();
		const result = await provider.search({
			query: "yüz",
			options: { limit: 5 },
		});
		expect(result.items).toHaveLength(5);
		expect(result.total).toBeGreaterThan(5);
		expect(result.hasMore).toBe(true);

		const all = await provider.search({
			query: "kalp",
			options: { limit: 10_000 },
		});
		expect(all.hasMore).toBe(false);
		expect(all.items).toHaveLength(all.total);
	});

	test("returns well-formed sticker items", async () => {
		const { provider } = createProvider();
		const { items } = await provider.search({ query: "fire" });
		const fire = items[0];
		expect(fire.provider).toBe("emoji");
		expect(fire.previewUrl).toBe("/emoji/fluent-flat/1f525.svg");
		expect(fire.name).toBe("Fire");
		expect(fire.metadata.glyph).toBe("\u{1F525}");
		expect(fire.metadata.group).toBe("Travel & Places");
	});

	test("an empty query lists everything up to the limit", async () => {
		const { provider } = createProvider();
		const result = await provider.search({ query: "  ", options: { limit: 7 } });
		expect(result.items).toHaveLength(7);
		expect(result.total).toBe(REAL_INDEX.items.length);
	});

	test("punctuation-only and unmatched queries return nothing", async () => {
		const { provider } = createProvider();
		expect(await searchIds({ provider, query: "..." })).toEqual([]);
		expect(await searchIds({ provider, query: "zzzzqqqq" })).toEqual([]);
	});

	test("copes with 10k-character and hostile queries", async () => {
		const { provider } = createProvider();
		expect(await searchIds({ provider, query: "a".repeat(10_000) })).toEqual([]);
		expect(await searchIds({ provider, query: "'; DROP TABLE emoji; --" })).toEqual([]);
		expect(await searchIds({ provider, query: "<script>alert(1)</script>" })).toEqual([]);
	});
});

describe("emoji provider relevance", () => {
	async function topIds({ query, count }: { query: string; count: number }) {
		const { provider } = createProvider();
		return (await searchIds({ provider, query })).slice(0, count);
	}

	test("'heart' puts the red heart in the top 3, not buried behind smileys", async () => {
		expect(await topIds({ query: "heart", count: 3 })).toContain("emoji:2764-fe0f");
	});

	test("'smile' puts the plain smiling face in the top 3", async () => {
		expect(await topIds({ query: "smile", count: 3 })).toContain("emoji:263a-fe0f");
	});

	test("'kalp' puts the anatomical heart (named exactly 'kalp') first, then only hearts", async () => {
		const { provider } = createProvider();
		const { items } = await provider.search({ query: "kalp", options: { limit: 10 } });
		expect(items[0].id).toBe("emoji:1fac0");
		// Eight equally plain "<colour or kind> kalp" hearts follow, red heart among them.
		expect(items.every((item) => item.name.toLowerCase().includes("heart"))).toBe(true);
	});

	test("'KALP' and 'kalp' rank identically", async () => {
		expect(await topIds({ query: "KALP", count: 10 })).toEqual(
			await topIds({ query: "kalp", count: 10 }),
		);
	});

	test("an exact name still comes first: 'fire', 'dog', 'star'", async () => {
		expect((await topIds({ query: "fire", count: 1 }))[0]).toBe("emoji:1f525");
		expect((await topIds({ query: "dog", count: 1 }))[0]).toBe("emoji:1f415");
		expect((await topIds({ query: "star", count: 1 }))[0]).toBe("emoji:2b50");
	});
});

describe("emoji provider glyph search (typing or pasting an emoji)", () => {
	const ids = async (query: string) => {
		const { provider } = createProvider();
		return searchIds({ provider, query });
	};

	test("finds the sticker for a pasted emoji", async () => {
		expect(await ids("\u{1F600}")).toEqual(["emoji:1f600"]);
		expect(await ids("\u{1F525}")).toEqual(["emoji:1f525"]);
	});

	test("ignores the variation selector: with or without it", async () => {
		expect(await ids("\u2764")).toEqual(["emoji:2764-fe0f"]);
		expect(await ids("\u2764\uFE0F")).toEqual(["emoji:2764-fe0f"]);
		expect(await ids("\u263A")).toEqual(["emoji:263a-fe0f"]);
	});

	test("finds ZWJ sequences, flags and keycaps", async () => {
		expect(await ids("\u{1F468}\u200D\u{1F4BB}")).toEqual(["emoji:1f468-200d-1f4bb"]);
		expect(await ids("\u{1F3F3}\uFE0F\u200D\u{1F308}")).toEqual(["emoji:1f3f3-fe0f-200d-1f308"]);
		expect(await ids("1\uFE0F\u20E3")).toEqual(["emoji:0031-fe0f-20e3"]);
	});

	test("a skin tone the catalog does not ship falls back to the default tone", async () => {
		expect(await ids("\u{1F44B}\u{1F3FD}")).toEqual(["emoji:1f44b"]);
	});

	test("several pasted emoji give each one, in order, without duplicates", async () => {
		expect(await ids("\u{1F600} \u2764\uFE0F\u{1F600}")).toEqual([
			"emoji:1f600",
			"emoji:2764-fe0f",
		]);
	});

	test("an emoji the catalog does not have finds nothing", async () => {
		// U+E000 is a private-use symbol: emoji-like to the query reader, in no catalog.
		expect(await ids("\uE000")).toEqual([]);
		expect(await ids("\u{1F9FF}\u{E0067}")).toEqual([]);
	});

	test("letters still search by text, and punctuation alone finds nothing", async () => {
		expect(await ids("fire")).toContain("emoji:1f525");
		expect(await ids("?!")).toEqual([]);
	});
});

describe("emoji provider browse", () => {
	test("returns one grid section per group holding every emoji exactly once", async () => {
		const { provider } = createProvider();
		const { sections } = await provider.browse({});
		expect(sections.map((section) => section.title)).toEqual(REAL_INDEX.groups);
		expect(sections.every((section) => section.layout === "grid")).toBe(true);

		const ids = sections.flatMap((section) => section.items.map((item) => item.id));
		expect(ids).toHaveLength(REAL_INDEX.items.length);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
	});

	test("with a limit returns a single page section (used by the All tab)", async () => {
		const { provider } = createProvider();
		const first = await provider.browse({ options: { limit: 12 } });
		expect(first.sections).toHaveLength(1);
		expect(first.sections[0].items).toHaveLength(12);
		expect(first.sections[0].hasMore).toBe(true);

		const second = await provider.browse({ options: { limit: 12, page: 2 } });
		expect(second.sections[0].items[0].id).toBe(`emoji:${REAL_INDEX.items[12].id}`);
	});

	test("an empty catalog browses to no sections", async () => {
		const empty: EmojiIndex = { version: 1, groups: [], items: [] };
		const provider = createEmojiProvider({ loadIndex: async () => empty });
		expect((await provider.browse({})).sections).toEqual([]);
		expect((await provider.browse({ options: { limit: 12 } })).sections).toEqual([]);
	});
});

describe("emoji provider loading", () => {
	test("loads the index once, lazily, however many calls", async () => {
		const { provider, loadCount } = createProvider();
		expect(loadCount()).toBe(0);
		await Promise.all([
			provider.search({ query: "fire" }),
			provider.search({ query: "kalp" }),
			provider.browse({}),
		]);
		await provider.search({ query: "yüz" });
		expect(loadCount()).toBe(1);
	});

	test("resetCatalog drops the loaded index: the next call loads it again, then shares that", async () => {
		const { provider, loadCount } = createProvider();
		await provider.search({ query: "fire" });
		expect(loadCount()).toBe(1);

		provider.resetCatalog();
		expect(loadCount()).toBe(1); // lazy: nothing loads until the next call
		await provider.browse({});
		await provider.search({ query: "kalp" });
		expect(loadCount()).toBe(2);
	});

	test("a catalog that cannot be loaded is an error, not an empty result; Retry recovers", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const provider = createEmojiProvider({
			loadIndex: async () => {
				attempts++;
				if (attempts <= 3) {
					throw new Error("offline");
				}
				return REAL_INDEX;
			},
		});

		const failedSearch = await provider.search({ query: "fire" });
		expect(failedSearch).toMatchObject({ items: [], total: 0, hasMore: false });
		expect(failedSearch.error).toMatch(/emoji/i);

		const failedBrowse = await provider.browse({});
		expect(failedBrowse.sections).toEqual([]);
		expect(failedBrowse.error).toMatch(/emoji/i);

		// Without the catalog the name is unknown: null, so the caller derives one
		// from the id instead of storing a glyph as the element's name for good.
		expect(await provider.describeSticker?.({ stickerId: "emoji:1f600" })).toBeNull();

		expect(consoleError).toHaveBeenCalledTimes(3);
		expect(String(consoleError.mock.calls[0]?.[0])).toContain("emoji");

		const recovered = await provider.search({ query: "fire" });
		expect(recovered.error).toBeUndefined();
		expect(recovered.items.length).toBeGreaterThan(0);
		expect(attempts).toBe(4);
		consoleError.mockRestore();
	});

	test("a search with no matches has no error", async () => {
		const { provider } = createProvider();
		const result = await provider.search({ query: "zzzzqqqq" });
		expect(result.items).toEqual([]);
		expect(result.error).toBeUndefined();
	});
});

describe("emoji provider resolveUrl", () => {
	const { provider } = createProvider();
	const resolve = (stickerId: string) => provider.resolveUrl({ stickerId });

	test("maps an id to the same-origin SVG file", () => {
		expect(resolve("emoji:1f600")).toBe("/emoji/fluent-flat/1f600.svg");
		expect(resolve("emoji:1f468-200d-1f4bb")).toBe(
			"/emoji/fluent-flat/1f468-200d-1f4bb.svg",
		);
	});

	test("normalises case", () => {
		expect(resolve("emoji:1F600")).toBe("/emoji/fluent-flat/1f600.svg");
	});

	test("cannot be steered out of the emoji folder", () => {
		for (const value of ["../../etc/passwd", "..%2f..%2fsecret", "a/b", "1f600.svg?x=1", "https://evil.example/x"]) {
			expect(resolve(`emoji:${value}`)).toBe("/emoji/fluent-flat/unknown.svg");
		}
	});

	test("describeSticker returns the very name the picker tile has, for every emoji", async () => {
		const { sections } = await provider.browse({});
		const tiles = sections.flatMap((section) => section.items);
		expect(tiles).toHaveLength(REAL_INDEX.items.length);
		for (const tile of tiles) {
			expect(await provider.describeSticker?.({ stickerId: tile.id })).toBe(tile.name);
		}
		expect(await provider.describeSticker?.({ stickerId: "emoji:1f600" })).toBe("Grinning face");
	});

	test("describeSticker falls back to the glyph for a valid id the catalog lacks, null otherwise", async () => {
		// Well formed (valid code point) but not in the index.
		expect(await provider.describeSticker?.({ stickerId: "emoji:10ffff" })).toBe("\u{10FFFF}");
		expect(await provider.describeSticker?.({ stickerId: "emoji:not-hex" })).toBeNull();
		expect(await provider.describeSticker?.({ stickerId: "garbage" })).toBeNull();
	});
});
