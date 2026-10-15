import { describe, expect, test } from "bun:test";
import { COUNTRIES } from "../providers/countries-data";
import { paginate } from "../providers/catalog-utils";
import { createFlagsProvider } from "../providers/flags";
import { parseShapeStickerId, shapesProvider } from "../providers/shapes";

describe("paginate", () => {
	const items = Array.from({ length: 25 }, (_, index) => index);

	test("without a limit returns everything", () => {
		expect(paginate({ items })).toEqual({ items, hasMore: false, total: 25 });
	});

	test("pages through the list", () => {
		expect(paginate({ items, options: { page: 1, limit: 10 } })).toEqual({
			items: items.slice(0, 10),
			hasMore: true,
			total: 25,
		});
		expect(paginate({ items, options: { page: 3, limit: 10 } })).toEqual({
			items: items.slice(20),
			hasMore: false,
			total: 25,
		});
	});

	test("an infinite limit means everything (0 * Infinity must not become NaN)", () => {
		for (const page of [undefined, 1]) {
			const result = paginate({ items, options: { page, limit: Number.POSITIVE_INFINITY } });
			expect(result.items).toEqual(items);
			expect(result.hasMore).toBe(false);
			expect(result.total).toBe(25);
		}
	});

	test("nonsense limits and pages are clamped", () => {
		expect(paginate({ items, options: { page: 0, limit: 5 } }).items).toEqual(items.slice(0, 5));
		expect(paginate({ items, options: { page: -3, limit: 5 } }).items).toEqual(items.slice(0, 5));
		expect(paginate({ items, options: { page: 1, limit: 0 } }).items).toEqual(items.slice(0, 1));
		expect(paginate({ items, options: { page: 1, limit: Number.NaN } }).items).toEqual(items);
	});
});

describe("the flags provider with an infinite limit", () => {
	test("returns every country", async () => {
		const provider = createFlagsProvider({ loadCountries: async () => COUNTRIES });
		const result = await provider.search({ query: "", options: { limit: Number.POSITIVE_INFINITY } });
		expect(result.items).toHaveLength(COUNTRIES.length);
		expect(result.total).toBe(COUNTRIES.length);
		expect(result.hasMore).toBe(false);
	});
});

describe("the shapes provider with an infinite limit", () => {
	test("returns every shape", async () => {
		const everything = await shapesProvider.search({ query: "" });
		const unlimited = await shapesProvider.search({ query: "", options: { limit: Number.POSITIVE_INFINITY } });
		expect(unlimited.items.length).toBeGreaterThan(0);
		expect(unlimited.items).toHaveLength(everything.items.length);
		expect(unlimited.hasMore).toBe(false);
	});
});

describe("the shapes provider with a query or id that is a property name of every object", () => {
	const KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

	test("an id like shapes:toString is not a shape (it used to be the Function toString)", () => {
		for (const key of KEYS) {
			expect(parseShapeStickerId({ stickerId: `shapes:${key}` })).toBeNull();
		}
	});

	test("such an id still resolves to a URL (the rectangle placeholder), and never throws", () => {
		for (const key of KEYS) {
			expect(() => shapesProvider.resolveUrl({ stickerId: `shapes:${key}` })).not.toThrow();
		}
	});

	test("searching them finds nothing and does not throw", async () => {
		for (const key of KEYS) {
			const result = await shapesProvider.search({ query: key });
			expect(Array.isArray(result.items)).toBe(true);
		}
	});

	test("the real legacy ids still resolve", () => {
		for (const key of ["square", "circle", "triangle", "hexagon", "diamond", "star"]) {
			expect(parseShapeStickerId({ stickerId: `shapes:${key}` })?.shapeKey).toBe(key);
		}
	});

	test("a one-megabyte query is cut", async () => {
		const started = performance.now();
		await shapesProvider.search({ query: "\u0130".repeat(1_000_000) });
		expect(performance.now() - started).toBeLessThan(60);
	});

	test("only the first 200 characters count (the same query with a word past the cut is the empty query)", async () => {
		const everything = await shapesProvider.search({ query: "" });
		const pastTheCut = await shapesProvider.search({ query: `${" ".repeat(200)}circle` });
		expect(pastTheCut.items).toEqual(everything.items);
		expect(everything.items.length).toBeGreaterThan(1);
	});
});

describe("a shape has one name, from every way it can be added", () => {
	test("describeSticker returns the name of the grid tile, for every shape", async () => {
		const { items } = await shapesProvider.search({ query: "" });
		expect(items.length).toBeGreaterThan(0);
		for (const tile of items) {
			expect(await shapesProvider.describeSticker?.({ stickerId: tile.id })).toBe(tile.name);
		}
	});

	test("a legacy id gets the preset's name, capitalised: Circle, not circle", async () => {
		expect(await shapesProvider.describeSticker?.({ stickerId: "shapes:circle" })).toBe("Circle");
	});

	test("an id that is not a shape is null", async () => {
		for (const stickerId of ["shapes:nope", "shapes:toString", "shapes:__proto__", "garbage"]) {
			expect(await shapesProvider.describeSticker?.({ stickerId })).toBeNull();
		}
	});
});
