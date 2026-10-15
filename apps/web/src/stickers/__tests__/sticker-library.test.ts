import { afterAll, beforeAll, describe, expect, spyOn, test, type Mock } from "bun:test";
import { browseAll, browseCategory, searchAll, searchStickers } from "../index";
import { STICKER_CATEGORIES } from "../categories";
import { emojiProvider } from "../providers/emoji";
import { iconsProvider } from "../providers/icons";
import { useStickersStore } from "../stickers-store";
import { readEmojiIndexFromDisk, readIconsIndexFromDisk } from "./catalog-fixtures";

/**
 * Drives the real default providers through the public sticker API, the way
 * the picker does. The only fake is `fetch`, answering for the two index files
 * the way the app's own server would.
 */
const requestedUrls: string[] = [];
let fetchSpy: Mock<typeof fetch>;

beforeAll(() => {
	const files: Record<string, unknown> = {
		"/emoji/index.json": readEmojiIndexFromDisk(),
		"/icons/phosphor/index.json": readIconsIndexFromDisk(),
	};
	const fakeFetch = Object.assign(
		async (input: RequestInfo | URL) => {
			const url = String(input);
			requestedUrls.push(url);
			return url in files
				? new Response(JSON.stringify(files[url]))
				: new Response("not found", { status: 404 });
		},
		{ preconnect: () => {} },
	);
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
});

afterAll(() => {
	fetchSpy.mockRestore();
});

describe("sticker library through the public API", () => {
	test("the All tab shows a short row for emoji and icons, titled by category", async () => {
		const { sections } = await browseAll({ recentStickers: [] });
		const byId = new Map(sections.map((section) => [section.id, section]));

		for (const category of ["emoji", "icons", "flags", "shapes"] as const) {
			const section = byId.get(category);
			expect(section?.title).toBe(STICKER_CATEGORIES[category]);
			expect(section?.layout).toBe("row");
		}
		// "See all" only where the row is cut short.
		for (const category of ["emoji", "icons", "flags"] as const) {
			expect(byId.get(category)?.hasMore).toBe(true);
			expect(byId.get(category)?.action).toMatchObject({
				type: "see-all",
				category,
			});
		}
		expect(byId.get("emoji")?.action?.sectionId).toBe("all");
		expect(byId.get("icons")?.action?.sectionId).toBe("all");
		expect(byId.get("emoji")?.items).toHaveLength(12);
		expect(byId.get("icons")?.items).toHaveLength(12);
	});

	test("a row that already shows everything has no 'See all' entry (Shapes: 4 of 4)", async () => {
		const { sections } = await browseAll({ recentStickers: [] });
		const shapes = sections.find((section) => section.id === "shapes");
		expect(shapes?.hasMore).toBe(false);
		expect(shapes?.items.length).toBeGreaterThan(0);
		expect(shapes?.action).toBeUndefined();
	});

	test("fetches each index from its own same-origin URL, at most once", async () => {
		// The default providers keep their catalogs for the whole process, so a
		// test file that ran earlier in the same process may have loaded them
		// already (with its own fetch). Start cold and count only this test's
		// requests; otherwise the first load is invisible to this file's spy.
		emojiProvider.resetCatalog();
		iconsProvider.resetCatalog();
		requestedUrls.length = 0;

		await browseAll({ recentStickers: [] });
		await searchAll({ query: "kalp" });
		await browseAll({ recentStickers: [] });
		expect(requestedUrls.filter((url) => url === "/emoji/index.json").length).toBe(1);
		expect(requestedUrls.filter((url) => url === "/icons/phosphor/index.json").length).toBe(1);
		expect(requestedUrls.every((url) => url.startsWith("/"))).toBe(true);
	});

	test("the Emoji tab lists every group; the Icons tab every group, regular weight", async () => {
		const emoji = await browseCategory({ category: "emoji" });
		expect(emoji.sections).toHaveLength(readEmojiIndexFromDisk().groups.length);
		expect(emoji.sections.reduce((sum, section) => sum + section.items.length, 0)).toBe(1595);

		const icons = await browseCategory({ category: "icons" });
		expect(icons.sections).toHaveLength(readIconsIndexFromDisk().groups.length);
		const iconIds = icons.sections.flatMap((section) => section.items.map((item) => item.id));
		expect(iconIds).toHaveLength(readIconsIndexFromDisk().items.length);
		expect(iconIds.some((id) => id.endsWith("-fill"))).toBe(false);
	});

	test("a Turkish search in the Emoji tab finds the emoji", async () => {
		const result = await searchStickers({ query: "KIRMIZI KALP", category: "emoji" });
		expect(result.items[0].id).toBe("emoji:2764-fe0f");
		expect(result.items[0].previewUrl).toBe("/emoji/fluent-flat/2764-fe0f.svg");
	});

	test("a search in the All tab returns a section per matching provider", async () => {
		const { sections } = await searchAll({ query: "heart" });
		const ids = sections.map((section) => section.id);
		expect(ids).toContain("emoji");
		expect(ids).toContain("icons");
		const icons = sections.find((section) => section.id === "icons");
		expect(icons?.items[0].id).toBe("icons:heart");
		expect(icons?.title).toBe("Icons");
	});

	test("a search in the Icons tab reaches the fill variants", async () => {
		const result = await searchStickers({ query: "star fill", category: "icons" });
		expect(result.items[0].id).toBe("icons:star-fill");
	});

	test("'Recently used' names stickers like the picker tiles, not by a code point list", async () => {
		const { sections } = await browseAll({
			recentStickers: ["emoji:1f600", "emoji:1f468-200d-1f4bb", "icons:heart-fill", "flags:US"],
		});
		const recent = sections.find((section) => section.id === "recent");
		// The same names the picker tiles have: this is also what a clicked or
		// dragged "recent" sticker is called on the timeline.
		expect(recent?.items.map((item) => item.name)).toEqual([
			"Grinning face",
			"Man technologist",
			"Heart fill",
			"United States", // the grid's name for the flag (recents used to show the bare code, "US")
		]);
		expect(recent?.items.map((item) => item.previewUrl)).toEqual([
			"/emoji/fluent-flat/1f600.svg",
			"/emoji/fluent-flat/1f468-200d-1f4bb.svg",
			"/icons/phosphor/heart-fill.svg",
			"/flags/us.svg",
		]);
	});
});

describe("search results are all reachable, and the header total is true", () => {
	test("a category search returns every match, not the first 100", async () => {
		const cases = [
			{ query: "yüz", category: "emoji" as const, atLeast: 150 },
			{ query: "face", category: "emoji" as const, atLeast: 150 },
			{ query: "fill", category: "icons" as const, atLeast: 1000 },
			{ query: "arrow", category: "icons" as const, atLeast: 250 },
		];
		for (const { query, category, atLeast } of cases) {
			const result = await searchStickers({ query, category });
			expect(result.total).toBeGreaterThanOrEqual(atLeast);
			expect(result.items).toHaveLength(result.total);
			expect(result.hasMore).toBe(false);
		}
	});

	test("an explicit smaller limit is still honoured", async () => {
		const result = await searchStickers({ query: "face", category: "emoji", limit: 10 });
		expect(result.items).toHaveLength(10);
		expect(result.hasMore).toBe(true);
	});

	test("the picker store shows every match for the selected category", async () => {
		const store = useStickersStore;
		store.setState({ selectedCategory: "emoji", searchQuery: "yüz" });
		await store.getState().searchStickers({ query: "yüz" });
		const results = store.getState().searchResults;
		expect(results?.total).toBeGreaterThan(100);
		expect(results?.items).toHaveLength(results?.total ?? -1);

		store.setState({ selectedCategory: "icons" });
		await store.getState().searchStickers({ query: "fill" });
		const iconResults = store.getState().searchResults;
		expect(iconResults?.items).toHaveLength(iconResults?.total ?? -1);
		expect(iconResults?.total).toBeGreaterThan(1000);
		store.setState({ selectedCategory: "all", searchQuery: "", searchResults: null });
	});

	test("the All tab caps each provider but offers 'See all' for the ones cut short", async () => {
		const { sections } = await searchAll({ query: "face" });
		const emoji = sections.find((section) => section.id === "emoji");
		expect(emoji?.hasMore).toBe(true);
		expect(emoji?.action).toMatchObject({ type: "see-all", category: "emoji" });

		const shapesOrFlags = sections.filter((section) => !section.hasMore);
		for (const section of shapesOrFlags) {
			expect(section.action).toBeUndefined();
		}
	});
});

describe("a sticker has one name, wherever it is added from", () => {
	test("recent tiles carry exactly the names of the browse and search tiles", async () => {
		const everyTile = async (category: "emoji" | "icons") =>
			(await searchStickers({ query: "", category, limit: 10_000 })).items;
		const tiles = new Map(
			[...(await everyTile("emoji")), ...(await everyTile("icons"))].map((tile) => [tile.id, tile.name]),
		);

		const ids = ["emoji:1f525", "emoji:2764-fe0f", "icons:arrow-circle-up-right-fill", "icons:heart"];
		const { sections } = await browseAll({ recentStickers: ids, limit: 50 });
		const recent = sections.find((section) => section.id === "recent")?.items ?? [];

		expect(recent.map((item) => item.id)).toEqual(ids);
		expect(recent.map((item) => item.name)).toEqual(ids.map((id) => tiles.get(id) ?? "(not a tile)"));
		expect(recent.map((item) => item.name)).toEqual([
			"Fire",
			"Red heart",
			"Arrow circle up right fill",
			"Heart",
		]);
	});
});

describe("flags and shapes have one name as well: grid, search and recents agree", () => {
	test("recents carry the names of the tiles", async () => {
		const tilesOf = async (category: "flags" | "shapes") =>
			(await searchStickers({ query: "", category, limit: 10_000 })).items;
		const tiles = new Map([...(await tilesOf("flags")), ...(await tilesOf("shapes"))].map((tile) => [tile.id, tile.name]));

		const shapeTiles = await tilesOf("shapes");
		const ids = ["flags:US", "flags:TR", shapeTiles[0].id, shapeTiles[1].id];
		const { sections } = await browseAll({ recentStickers: ids, limit: 50 });
		const recent = sections.find((section) => section.id === "recent")?.items ?? [];
		expect(recent.map((item) => item.id)).toEqual(ids);
		expect(recent.map((item) => item.name)).toEqual(ids.map((id) => tiles.get(id) ?? "(not a tile)"));
		expect(recent.map((item) => item.name).slice(0, 2)).toEqual(["United States", "Turkey"]);
		expect(recent.map((item) => item.name).slice(2)).toEqual(shapeTiles.slice(0, 2).map((tile) => tile.name));
	});
});
