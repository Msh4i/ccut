import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import {
	clearTurkishSupportCache,
	filterTurkishOnly,
	getCachedTurkishSupport,
	hasTurkishBadge,
	isTurkishReady,
	loadTurkishSupport,
} from "../turkish-support";
import { stubGlobals } from "./stub-globals";

const PUBLIC_FONTS = new URL("../../../public/fonts/", import.meta.url);

function readPublicJson({ name }: { name: string }): unknown {
	return JSON.parse(readFileSync(new URL(name, PUBLIC_FONTS), "utf8"));
}

let response: () => Promise<unknown> = async () => ({
	ok: true,
	json: async () => ["Roboto", "Lobster"],
});
let fetchCalls: string[] = [];
let lastFetchSignal: AbortSignal | undefined;
let restoreGlobals: () => void = () => {};

beforeEach(() => {
	clearTurkishSupportCache();
	response = async () => ({ ok: true, json: async () => ["Roboto", "Lobster"] });
	fetchCalls = [];
	restoreGlobals = stubGlobals({
		stubs: {
			fetch: async (url: string, init?: { signal?: AbortSignal }) => {
				fetchCalls.push(url);
				lastFetchSignal = init?.signal;
				return response();
			},
		},
	});
});

afterEach(() => {
	restoreGlobals();
	clearTurkishSupportCache();
});

describe("loadTurkishSupport", () => {
	it("loads the bundled list once and serves it from the cache afterwards", async () => {
		const [first, second] = await Promise.all([
			loadTurkishSupport(),
			loadTurkishSupport(),
		]);
		const third = await loadTurkishSupport();

		expect(first).toEqual(new Set(["Roboto", "Lobster"]));
		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(getCachedTurkishSupport()).toBe(first);
		expect(fetchCalls).toEqual(["/fonts/turkish-support.json"]);
	});

	it("gives up on a request that never answers after 8 seconds", async () => {
		const timeout = new AbortController();
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(
			timeout.signal,
		);
		await loadTurkishSupport();

		expect(timeoutSpy).toHaveBeenCalledWith(8000);
		expect(lastFetchSignal).toBe(timeout.signal);
		timeoutSpy.mockRestore();
	});

	it("resolves null instead of throwing when the request fails, and tries again next time", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		response = async () => {
			throw new Error("offline");
		};
		expect(await loadTurkishSupport()).toBeNull();
		expect(getCachedTurkishSupport()).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);

		response = async () => ({ ok: true, json: async () => ["Roboto"] });
		expect(await loadTurkishSupport()).toEqual(new Set(["Roboto"]));
		expect(fetchCalls).toHaveLength(2);
		warn.mockRestore();
	});

	it("treats an HTTP error or a malformed list as unavailable", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const bodies: unknown[] = [null, {}, "Roboto", ["Roboto", 7], [["Roboto"]]];

		response = async () => ({ ok: false, status: 404 });
		expect(await loadTurkishSupport()).toBeNull();
		for (const body of bodies) {
			response = async () => ({ ok: true, json: async () => body });
			expect(await loadTurkishSupport()).toBeNull();
		}
		expect(warn).toHaveBeenCalledTimes(bodies.length + 1);
		warn.mockRestore();
	});

	it("accepts an empty list", async () => {
		response = async () => ({ ok: true, json: async () => [] });
		expect(await loadTurkishSupport()).toEqual(new Set());
	});
});

describe("isTurkishReady", () => {
	const support = new Set(["Roboto", "Press Start 2P"]);

	it("is true only for families on the list, matched exactly", () => {
		expect(isTurkishReady({ family: "Roboto", support })).toBe(true);
		expect(isTurkishReady({ family: "Press Start 2P", support })).toBe(true);
		expect(isTurkishReady({ family: "Lato", support })).toBe(false);
		expect(isTurkishReady({ family: "roboto", support })).toBe(false);
		expect(isTurkishReady({ family: "Roboto ", support })).toBe(false);
		expect(isTurkishReady({ family: "", support })).toBe(false);
	});

	it("is false for names that only look like keys, and while the list is unavailable", () => {
		expect(isTurkishReady({ family: "toString", support })).toBe(false);
		expect(isTurkishReady({ family: "__proto__", support })).toBe(false);
		expect(isTurkishReady({ family: "Roboto", support: null })).toBe(false);
	});
});

describe("hasTurkishBadge", () => {
	const support = new Set(["Roboto", "Lobster"]);
	const badge = ({
		family,
		isCustom = false,
		list = support,
	}: {
		family: string;
		isCustom?: boolean;
		list?: Set<string> | null;
	}) => hasTurkishBadge({ family, support: list, isCustom });

	it("badges measured catalog fonts and the known system fonts", () => {
		expect(badge({ family: "Roboto" })).toBe(true);
		for (const family of [
			"Arial",
			"Helvetica",
			"Times New Roman",
			"Courier New",
			"Verdana",
			"Georgia",
			"serif",
			"sans-serif",
			"monospace",
		]) {
			expect(badge({ family })).toBe(true);
		}
	});

	it("never badges a custom font, even one named like a measured font", () => {
		expect(badge({ family: "Roboto", isCustom: true })).toBe(false);
		expect(badge({ family: "Arial", isCustom: true })).toBe(false);
		expect(badge({ family: "My Font", isCustom: true })).toBe(false);
	});

	it("does not badge catalog fonts missing from the list, nor anything while the list is unavailable", () => {
		expect(badge({ family: "Lato" })).toBe(false);
		expect(badge({ family: "Arial", list: null })).toBe(false);
		expect(badge({ family: "Roboto", list: null })).toBe(false);
	});
});

describe("filterTurkishOnly", () => {
	const support = new Set(["Roboto", "Lobster"]);
	const names = ["Arial", "Lato", "Lobster", "Mine", "Orbitron", "Roboto", "serif"];
	const filter = ({
		selected,
		list = support,
		custom = ["Mine"],
	}: {
		selected?: string;
		list?: Set<string> | null;
		custom?: string[];
	} = {}) =>
		filterTurkishOnly({
			names,
			support: list,
			customFamilies: new Set(custom),
			selected,
		});

	it("keeps badged fonts, system fonts and custom fonts, in the original order", () => {
		expect(filter()).toEqual(["Arial", "Lobster", "Mine", "Roboto", "serif"]);
	});

	it("keeps the font in use even when it is not Turkish-ready", () => {
		expect(filter({ selected: "Orbitron" })).toEqual([
			"Arial",
			"Lobster",
			"Mine",
			"Orbitron",
			"Roboto",
			"serif",
		]);
	});

	it("does not invent a font that is not in the list", () => {
		expect(filter({ selected: "Not Listed" })).toEqual(filter());
	});

	it("does not filter at all while the list is unavailable", () => {
		expect(filter({ list: null })).toEqual(names);
	});

	it("lets a name through as custom only when it is one", () => {
		expect(filter({ custom: [] })).toEqual(["Arial", "Lobster", "Roboto", "serif"]);
	});
});

describe("the bundled list", () => {
	const names = readPublicJson({ name: "turkish-support.json" });
	const atlas = readPublicJson({ name: "font-atlas.json" });

	function asStrings({ value }: { value: unknown }): string[] {
		if (!Array.isArray(value)) throw new Error("not an array");
		return value.map((item) => {
			if (typeof item !== "string") throw new Error("not a string");
			return item;
		});
	}

	function atlasFamilies(): string[] {
		if (typeof atlas !== "object" || atlas === null || !("fonts" in atlas)) {
			throw new Error("unexpected catalog");
		}
		const { fonts } = atlas;
		return typeof fonts === "object" && fonts !== null ? Object.keys(fonts) : [];
	}

	it("is a sorted list of unique catalog families", () => {
		const list = asStrings({ value: names });
		const catalog = new Set(atlasFamilies());

		expect(new Set(list).size).toBe(list.length);
		expect(list).toEqual([...list].sort());
		expect(list.filter((family) => !catalog.has(family))).toEqual([]);
	});

	it("keeps the measured result: most of the catalog, minus fonts missing letters", () => {
		const list = new Set(asStrings({ value: names }));

		expect(list.size).toBe(1354);
		for (const family of ["Inter", "Roboto", "Pacifico", "Bebas Neue", "Cinzel"]) {
			expect(list.has(family)).toBe(true);
		}
		// Measured without ğ ş İ (Fredoka, Lato, Lilita One) or without any latin-ext.
		for (const family of ["Lato", "Fredoka", "Lilita One", "Orbitron", "Chewy"]) {
			expect(list.has(family)).toBe(false);
		}
	});
});
