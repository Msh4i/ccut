import { describe, expect, test } from "bun:test";
import {
	buildIconId,
	buildIconSearchEntries,
	buildIconsIndex,
	expandIconRecords,
	isBrandIcon,
	isValidIconId,
	parseIconsIndex,
	searchIconEntries,
	type PhosphorCatalogEntry,
} from "../providers/icons-index";

function entry(
	overrides: Pick<PhosphorCatalogEntry, "name"> & Partial<PhosphorCatalogEntry>,
): PhosphorCatalogEntry {
	return {
		categories: ["objects"],
		figma_category: "system & devices",
		tags: [],
		...overrides,
	};
}

const CATALOG: PhosphorCatalogEntry[] = [
	entry({ name: "heart",
		categories: ["communications", "health & wellness"],
		figma_category: "health & wellness",
		tags: ["*new*", "love", "Like", "favorites", "like"],
	}),
	entry({ name: "heart-break",
		categories: ["communications"],
		figma_category: "communication",
		tags: ["sad", "love"],
	}),
	entry({ name: "calendar-heart",
		categories: ["office"],
		figma_category: "design",
		tags: ["date"],
	}),
	entry({ name: "arrow-up",
		categories: ["arrows"],
		figma_category: "arrows",
		tags: ["direction", "*updated*"],
	}),
	entry({ name: "github-logo",
		categories: ["brands", "development"],
		figma_category: "brands",
		tags: ["octocat"],
	}),
	entry({ name: "pix-logo", categories: ["commerce"], figma_category: "math & finance" }),
	entry({ name: "sketch-logo", categories: ["design"], figma_category: "brands" }),
	entry({ name: "x-logo", categories: ["brands"], figma_category: "brands" }),
	entry({ name: "parallelogram", categories: ["brands", "design"], figma_category: "design" }),
	entry({ name: "sparkle",
		categories: ["design"],
		figma_category: "design",
		tags: ["star"],
	}),
	entry({ name: "star",
		categories: ["games"],
		figma_category: "games",
		tags: ["favorite", "rate"],
	}),
];

describe("isBrandIcon", () => {
	test("flags company logos by category, Figma group or -logo name", () => {
		expect(isBrandIcon({ entry: entry({ name: "github-logo", categories: ["brands"] }) })).toBe(true);
		expect(isBrandIcon({ entry: entry({ name: "sketch-logo", figma_category: "brands" }) })).toBe(true);
		expect(isBrandIcon({ entry: entry({ name: "pix-logo" }) })).toBe(true);
		expect(isBrandIcon({ entry: entry({ name: "gitlab-logo-simple" }) })).toBe(true);
	});

	test("keeps ordinary icons", () => {
		expect(isBrandIcon({ entry: entry({ name: "heart" }) })).toBe(false);
		expect(isBrandIcon({ entry: entry({ name: "x-circle" }) })).toBe(false);
		expect(isBrandIcon({ entry: entry({ name: "catalog" }) })).toBe(false);
	});

	test("keeps parallelogram, a geometric shape Phosphor filed under brands", () => {
		expect(
			isBrandIcon({
				entry: entry({ name: "parallelogram", categories: ["brands", "design"] }),
			}),
		).toBe(false);
	});
});

describe("icon ids", () => {
	test("regular icons use the bare name, fill icons add -fill", () => {
		expect(buildIconId({ name: "heart", weight: "regular" })).toBe("heart");
		expect(buildIconId({ name: "heart", weight: "fill" })).toBe("heart-fill");
	});

	test("rejects ids that could escape the icon folder or are malformed", () => {
		for (const id of ["", "../heart", "heart/../x", "Heart", "heart.svg", "-heart", "heart-", "a--b", "-fill", "he art", "heart%2F"]) {
			expect(isValidIconId({ id })).toBe(false);
		}
		expect(isValidIconId({ id: "heart-fill" })).toBe(true);
		expect(isValidIconId({ id: "number-one" })).toBe(true);
	});
});

describe("buildIconsIndex", () => {
	const index = buildIconsIndex({ catalog: CATALOG });

	test("drops brand logos but keeps everything else, sorted by name", () => {
		expect(index.items.map((item) => item.n)).toEqual([
			"arrow-up",
			"calendar-heart",
			"heart",
			"heart-break",
			"parallelogram",
			"sparkle",
			"star",
		]);
	});

	test("groups by the single-valued Figma category, titled and sorted", () => {
		expect(index.groups).toEqual([
			"Arrows",
			"Communication",
			"Design",
			"Games",
			"Health & Wellness",
		]);
		const heart = index.items.find((item) => item.n === "heart");
		expect(index.groups[heart?.g ?? -1]).toBe("Health & Wellness");
	});

	test("merges tags and categories for search, lowercase, unique, without *markers*", () => {
		const heart = index.items.find((item) => item.n === "heart");
		expect(heart?.t).toEqual([
			"love",
			"like",
			"favorites",
			"communications",
			"health & wellness",
		]);
		const arrow = index.items.find((item) => item.n === "arrow-up");
		expect(arrow?.t).toEqual(["direction", "arrows"]);
	});

	test("is deterministic regardless of the input order", () => {
		const reversed = buildIconsIndex({ catalog: [...CATALOG].reverse() });
		expect(JSON.stringify(reversed)).toBe(JSON.stringify(index));
	});

	test("rejects duplicate names and unsafe names", () => {
		expect(() => buildIconsIndex({ catalog: [entry({ name: "heart" }), entry({ name: "heart" })] })).toThrow(/duplicate/i);
		expect(() => buildIconsIndex({ catalog: [entry({ name: "../evil" })] })).toThrow();
		expect(() => buildIconsIndex({ catalog: [entry({ name: "ends-with-fill" })] })).toThrow(/fill/);
	});
});

describe("expandIconRecords", () => {
	test("yields a regular and a fill record per icon, regular first", () => {
		const records = expandIconRecords({
			index: buildIconsIndex({ catalog: [entry({ name: "star" }), entry({ name: "heart" })] }),
		});
		expect(records.map((record) => record.id)).toEqual([
			"heart",
			"heart-fill",
			"star",
			"star-fill",
		]);
		expect(records.map((record) => record.weight)).toEqual([
			"regular",
			"fill",
			"regular",
			"fill",
		]);
	});
});

describe("searchIconEntries", () => {
	const entries = buildIconSearchEntries({
		index: buildIconsIndex({ catalog: CATALOG }),
	});
	const ids = (query: string) =>
		searchIconEntries({ entries, query }).map((record) => record.id);

	test("puts the icon named exactly like the query first, then its fill, then the rest", () => {
		// "calendar-heart" sorts before "heart" but only contains the word.
		expect(ids("heart")).toEqual([
			"heart",
			"heart-fill",
			"calendar-heart",
			"calendar-heart-fill",
			"heart-break",
			"heart-break-fill",
		]);
	});

	test("finds icons by tag or category", () => {
		expect(ids("octocat")).toEqual([]);
		expect(ids("love")).toEqual(["heart", "heart-fill", "heart-break", "heart-break-fill"]);
		expect(ids("date")).toEqual(["calendar-heart", "calendar-heart-fill"]);
		expect(ids("direction")).toEqual(["arrow-up", "arrow-up-fill"]);
		expect(ids("games")).toEqual(["star", "star-fill"]);
	});

	test("ranks a name match ahead of a tag match, whatever the alphabetical order", () => {
		// "sparkle" sorts before "star" but only has "star" as a tag.
		expect(ids("star")).toEqual(["star", "star-fill", "sparkle", "sparkle-fill"]);
	});

	test("ranks an exact tag ahead of a prefix tag", () => {
		// star has the tag "favorite", heart only "favorites".
		expect(ids("favorite").slice(0, 2)).toEqual(["star", "star-fill"]);
	});

	test("fill variants answer to fill, filled and solid; regular to outline", () => {
		const fills = ["heart-fill", "calendar-heart-fill", "heart-break-fill"];
		// "heart fill" names heart-fill exactly, so it leads.
		expect(ids("heart fill")).toEqual(fills);
		// The synonyms have no exact name, only the same set of matches.
		expect(ids("heart solid").sort()).toEqual([...fills].sort());
		expect(ids("heart filled").sort()).toEqual([...fills].sort());
		expect(ids("heart outline").sort()).toEqual(
			["heart", "calendar-heart", "heart-break"].sort(),
		);
	});

	test("matching is case-insensitive and ignores diacritics", () => {
		expect(ids("HEART")).toEqual(ids("heart"));
		expect(ids("hearT")).toEqual(ids("heart"));
	});

	test("returns nothing for blank or unknown queries", () => {
		expect(ids("")).toEqual([]);
		expect(ids("   ")).toEqual([]);
		expect(ids("zzzzqqq")).toEqual([]);
		expect(ids("github")).toEqual([]);
	});
});

describe("parseIconsIndex", () => {
	const valid = {
		version: 1 as const,
		source: { phosphorCore: "2.1.1" },
		groups: ["Arrows"],
		items: [{ n: "arrow-up", g: 0, t: ["direction"] }],
	};

	test("accepts a well-formed index and returns it unchanged", () => {
		expect(parseIconsIndex({ value: structuredClone(valid) })).toEqual(valid);
	});

	test("rejects anything that is not an index", () => {
		for (const value of [null, undefined, 5, "x", [], {}, { ...valid, version: 2 }, { ...valid, groups: [1] }, { ...valid, items: "x" }]) {
			expect(() => parseIconsIndex({ value })).toThrow();
		}
	});

	test("rejects malformed items", () => {
		const withItem = (item: unknown) => ({ ...valid, items: [item] });
		const good = valid.items[0];
		for (const item of [
			null,
			{ ...good, n: "../evil" },
			{ ...good, n: "Heart" },
			{ ...good, n: "heart-fill" },
			{ ...good, n: 5 },
			{ ...good, g: 1 },
			{ ...good, g: "0" },
			{ ...good, t: "tag" },
			{ ...good, t: [null] },
		]) {
			expect(() => parseIconsIndex({ value: withItem(item) })).toThrow();
		}
	});
});
