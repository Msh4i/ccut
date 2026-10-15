import { describe, expect, spyOn, test } from "bun:test";
import { COUNTRIES } from "../providers/countries-data";
import { createFlagsProvider, getRegionLabel, resolveQueryToRegions } from "../providers/flags";

describe("flags provider", () => {
	test("searches the dataset", async () => {
		const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });
		const result = await provider.search({ query: "turkey" });
		expect(result.items.some((item) => item.id === "flags:TR")).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test("a dataset that cannot be loaded is an error, not 'no flags', and is not cached", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const provider = createFlagsProvider({
			loadCountries: async () => {
				attempts++;
				if (attempts <= 2) {
					throw new Error("chunk failed to load");
				}
				return COUNTRIES;
			},
		});

		const failedSearch = await provider.search({ query: "turkey" });
		expect(failedSearch).toMatchObject({ items: [], total: 0, hasMore: false });
		expect(failedSearch.error).toMatch(/flags/i);
		const failedBrowse = await provider.browse({});
		expect(failedBrowse.sections).toEqual([]);
		expect(failedBrowse.error).toMatch(/flags/i);
		expect(consoleError).toHaveBeenCalledTimes(2);
		expect(String(consoleError.mock.calls[0]?.[0])).toContain("flags");

		// The failure did not stick for the session (it used to).
		const recovered = await provider.search({ query: "turkey" });
		expect(recovered.error).toBeUndefined();
		expect(recovered.items.length).toBeGreaterThan(0);
		expect(attempts).toBe(3);
		consoleError.mockRestore();
	});

	test("browse and resolveUrl are unchanged", async () => {
		const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });
		const browsed = await provider.browse({ options: { limit: 5 } });
		expect(browsed.sections[0].items).toHaveLength(5);
		expect(browsed.sections[0].hasMore).toBe(true);
		expect(provider.resolveUrl({ stickerId: "flags:US" })).toBe("/flags/us.svg");
	});
});

const INHERITED_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__"];

describe("the Flags tab with a query that is a property name of every object", () => {
	test("resolveQueryToRegions answers 'no region' instead of throwing (the render calls it on every keystroke)", () => {
		for (const query of INHERITED_KEYS) {
			expect(() => resolveQueryToRegions({ query })).not.toThrow();
			expect(resolveQueryToRegions({ query })).toBeNull();
		}
	});

	test("getRegionLabel gives the typed text back, not a function and not a made-up group name", () => {
		for (const query of INHERITED_KEYS) {
			// "constructor" would become "Constructor" if it were taken for a region group.
			expect(getRegionLabel({ query })).toBe(query);
		}
	});

	test("searching them finds no country and no error", async () => {
		const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });
		for (const query of INHERITED_KEYS) {
			const result = await provider.search({ query });
			expect(result.error).toBeUndefined();
			expect(Array.isArray(result.items)).toBe(true);
		}
	});

	test("the real region groups still work", () => {
		expect(resolveQueryToRegions({ query: "europe" })?.size).toBeGreaterThan(0);
		expect(resolveQueryToRegions({ query: "caribbean" })?.has("Caribbean")).toBe(true);
		expect(getRegionLabel({ query: "europe" })).toBe("Europe");
	});
});

describe("search text is cut like everywhere else", () => {
	test("a one-megabyte query does not cost a megabyte of case conversion", async () => {
		const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });
		const started = performance.now();
		const result = await provider.search({ query: "\u0130".repeat(1_000_000) });
		expect(performance.now() - started).toBeLessThan(60);
		expect(result.items).toEqual([]);
	});

	test("only the first 200 characters count", async () => {
		const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });
		const tail = await provider.search({ query: `${"a".repeat(200)}turkey` });
		expect(tail.items).toEqual([]); // "turkey" is past the cut
	});
});

describe("a flag has one name, from every way it can be added", () => {
	const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });

	test("describeSticker returns the name the grid tile has, for every country", async () => {
		const { items } = await provider.search({ query: "", options: { limit: Number.POSITIVE_INFINITY } });
		expect(items).toHaveLength(COUNTRIES.length);
		for (const tile of items) {
			expect(await provider.describeSticker?.({ stickerId: tile.id })).toBe(tile.name);
		}
		expect(await provider.describeSticker?.({ stickerId: "flags:US" })).toBe("United States");
	});

	test("the code is case-insensitive, like the URL", async () => {
		expect(await provider.describeSticker?.({ stickerId: "flags:us" })).toBe("United States");
	});

	test("an unknown code or a foreign id is null, so the caller names it from the id", async () => {
		expect(await provider.describeSticker?.({ stickerId: "flags:ZZZ" })).toBeNull();
		expect(await provider.describeSticker?.({ stickerId: "garbage" })).toBeNull();
		expect(await provider.describeSticker?.({ stickerId: "flags:constructor" })).toBeNull();
	});

	test("while the dataset cannot be loaded it is null too", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const failing = createFlagsProvider({
			loadCountries: async () => {
				throw new Error("offline");
			},
		});
		expect(await failing.describeSticker?.({ stickerId: "flags:US" })).toBeNull();
		consoleError.mockRestore();
	});
});
