import { describe, expect, spyOn, test } from "bun:test";
import { createIconsProvider } from "../providers/icons";
import type { IconsIndex } from "../providers/icons-index";
import { readIconsIndexFromDisk } from "./catalog-fixtures";

const REAL_INDEX = readIconsIndexFromDisk();

function createProvider() {
	let loads = 0;
	const provider = createIconsProvider({
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
	limit,
}: {
	provider: ReturnType<typeof createIconsProvider>;
	query: string;
	limit?: number;
}) {
	const result = await provider.search({ query, options: { limit } });
	return result.items.map((item) => item.id);
}

describe("icons provider search", () => {
	test("finds an icon by name, regular before fill", async () => {
		const { provider } = createProvider();
		const ids = await searchIds({ provider, query: "heart" });
		expect(ids.slice(0, 2)).toEqual(["icons:heart", "icons:heart-fill"]);
	});

	test("finds icons by Phosphor tag", async () => {
		const { provider } = createProvider();
		// "home" is a tag of the house icon, not part of its name.
		const ids = await searchIds({ provider, query: "home" });
		expect(ids).toContain("icons:house");
	});

	test("finds icons by category word", async () => {
		const { provider } = createProvider();
		expect((await searchIds({ provider, query: "weather" })).length).toBeGreaterThan(5);
	});

	test("fill variants are reached with fill, filled or solid", async () => {
		const { provider } = createProvider();
		const filled = await searchIds({ provider, query: "heart fill" });
		expect(filled[0]).toBe("icons:heart-fill");
		expect(filled.every((id) => id.endsWith("-fill"))).toBe(true);
		expect(await searchIds({ provider, query: "heart solid" })).toContain("icons:heart-fill");
		expect(await searchIds({ provider, query: "heart outline" })).not.toContain("icons:heart-fill");
	});

	test("matching ignores case", async () => {
		const { provider } = createProvider();
		expect(await searchIds({ provider, query: "HEART" })).toEqual(await searchIds({ provider, query: "heart" }));
	});

	test("returns well-formed sticker items", async () => {
		const { provider } = createProvider();
		const { items } = await provider.search({ query: "heart fill" });
		const heartFill = items[0];
		expect(heartFill.id).toBe("icons:heart-fill");
		expect(heartFill.provider).toBe("icons");
		expect(heartFill.previewUrl).toBe("/icons/phosphor/heart-fill.svg");
		expect(heartFill.name).toBe("Heart fill");
		expect(heartFill.metadata.weight).toBe("fill");
	});

	test("never returns company logos", async () => {
		const { provider } = createProvider();
		for (const query of ["github", "logo", "facebook", "google", "twitter", "youtube"]) {
			const ids = await searchIds({ provider, query: query, limit: 1000 });
			expect(ids.filter((id) => id.includes("logo"))).toEqual([]);
		}
	});

	test("respects the limit and reports totals", async () => {
		const { provider } = createProvider();
		const result = await provider.search({ query: "arrow", options: { limit: 10 } });
		expect(result.items).toHaveLength(10);
		expect(result.total).toBeGreaterThan(10);
		expect(result.hasMore).toBe(true);
	});

	test("blank, unmatched and hostile queries are safe", async () => {
		const { provider } = createProvider();
		expect(await searchIds({ provider, query: "zzzzqqqq" })).toEqual([]);
		expect(await searchIds({ provider, query: "../../etc/passwd" })).toEqual([]);
		expect(await searchIds({ provider, query: "a".repeat(10_000) })).toEqual([]);
		const blank = await provider.search({ query: "", options: { limit: 3 } });
		expect(blank.items).toHaveLength(3);
		expect(blank.total).toBe(REAL_INDEX.items.length * 2);
	});
});

describe("icons provider browse", () => {
	test("returns one grid section per group, regular icons only, each once", async () => {
		const { provider } = createProvider();
		const { sections } = await provider.browse({});
		expect(sections.map((section) => section.title)).toEqual(REAL_INDEX.groups);

		const ids = sections.flatMap((section) => section.items.map((item) => item.id));
		expect(ids).toHaveLength(REAL_INDEX.items.length);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.some((id) => id.endsWith("-fill"))).toBe(false);
	});

	test("with a limit returns a single page section (used by the All tab)", async () => {
		const { provider } = createProvider();
		const { sections } = await provider.browse({ options: { limit: 12 } });
		expect(sections).toHaveLength(1);
		expect(sections[0].items).toHaveLength(12);
		expect(sections[0].hasMore).toBe(true);
	});

	test("an empty catalog browses to no sections", async () => {
		const empty: IconsIndex = { version: 1, groups: [], items: [] };
		const provider = createIconsProvider({ loadIndex: async () => empty });
		expect((await provider.browse({})).sections).toEqual([]);
		expect((await provider.browse({ options: { limit: 12 } })).sections).toEqual([]);
	});
});

describe("icons provider loading", () => {
	test("loads the index once, lazily", async () => {
		const { provider, loadCount } = createProvider();
		expect(loadCount()).toBe(0);
		await Promise.all([provider.search({ query: "heart" }), provider.browse({})]);
		await provider.search({ query: "star" });
		expect(loadCount()).toBe(1);
	});

	test("resetCatalog drops the loaded index: the next call loads it again, then shares that", async () => {
		const { provider, loadCount } = createProvider();
		await provider.search({ query: "heart" });
		expect(loadCount()).toBe(1);

		provider.resetCatalog();
		expect(loadCount()).toBe(1); // lazy: nothing loads until the next call
		await provider.browse({});
		await provider.search({ query: "star" });
		expect(loadCount()).toBe(2);
	});

	test("a catalog that cannot be loaded is an error, not an empty result; Retry recovers", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const provider = createIconsProvider({
			loadIndex: async () => {
				attempts++;
				if (attempts <= 2) {
					throw new Error("offline");
				}
				return REAL_INDEX;
			},
		});

		const failedSearch = await provider.search({ query: "heart" });
		expect(failedSearch).toMatchObject({ items: [], total: 0, hasMore: false });
		expect(failedSearch.error).toMatch(/icon/i);

		const failedBrowse = await provider.browse({});
		expect(failedBrowse.sections).toEqual([]);
		expect(failedBrowse.error).toMatch(/icon/i);

		expect(consoleError).toHaveBeenCalledTimes(2);
		expect(String(consoleError.mock.calls[0]?.[0])).toContain("icons");

		const recovered = await provider.search({ query: "heart" });
		expect(recovered.error).toBeUndefined();
		expect(recovered.items.length).toBeGreaterThan(0);
		consoleError.mockRestore();
	});

	test("an icon name needs no catalog, so describeSticker works while it is down", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const provider = createIconsProvider({
			loadIndex: async () => {
				throw new Error("offline");
			},
		});
		expect(await provider.describeSticker?.({ stickerId: "icons:heart-fill" })).toBe("Heart fill");
		consoleError.mockRestore();
	});

	test("a search with no matches has no error", async () => {
		const { provider } = createProvider();
		const result = await provider.search({ query: "zzzzqqqq" });
		expect(result.items).toEqual([]);
		expect(result.error).toBeUndefined();
	});
});

describe("icons provider resolveUrl", () => {
	const { provider } = createProvider();
	const resolve = (stickerId: string) => provider.resolveUrl({ stickerId });

	test("maps ids to same-origin SVG files", () => {
		expect(resolve("icons:heart")).toBe("/icons/phosphor/heart.svg");
		expect(resolve("icons:heart-fill")).toBe("/icons/phosphor/heart-fill.svg");
	});

	test("cannot be steered out of the icons folder", () => {
		for (const value of ["../../etc/passwd", "..%2f..%2fsecret", "a/b", "heart.svg?x=1", "https://evil.example/x"]) {
			expect(resolve(`icons:${value}`)).toBe("/icons/phosphor/unknown.svg");
		}
	});
});

describe("icons provider describeSticker", () => {
	const { provider } = createProvider();

	test("returns the very name the picker tile has, for every icon and weight", async () => {
		const found = await provider.search({ query: "", options: { limit: 10_000 } });
		expect(found.items).toHaveLength(REAL_INDEX.items.length * 2);
		for (const tile of found.items) {
			expect(await provider.describeSticker?.({ stickerId: tile.id })).toBe(tile.name);
		}
		expect(await provider.describeSticker?.({ stickerId: "icons:heart-fill" })).toBe("Heart fill");
	});

	test("returns null for ids that are not icon ids", async () => {
		expect(await provider.describeSticker?.({ stickerId: "icons:../x" })).toBeNull();
		expect(await provider.describeSticker?.({ stickerId: "garbage" })).toBeNull();
	});
});
