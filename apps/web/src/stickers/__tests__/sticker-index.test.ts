import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	browseAll,
	browseCategory,
	resolveStickerIntrinsicSize,
	searchAll,
	searchStickers,
} from "../index";
import { STICKER_CATEGORIES, isStickerCategory } from "../categories";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";

// index.ts joins the providers for the picker. These tests use fake providers,
// so a provider that fails, rejects or is slow can be staged exactly.

function item({ provider, n }: { provider: string; n: number }): StickerItem {
	return {
		id: `${provider}:item-${n}`,
		provider,
		name: `Item ${n}`,
		previewUrl: `/${provider}/item-${n}.svg`,
		metadata: {},
	};
}

interface FakeProviderOptions {
	id: string;
	count?: number;
	searchError?: string;
	browseError?: string;
	rejectWith?: unknown;
	describe?: (stickerId: string) => Promise<string | null>;
	onBrowse?: () => void;
}

function fakeProvider({
	id,
	count = 3,
	searchError,
	browseError,
	rejectWith,
	describe: describeSticker,
	onBrowse,
}: FakeProviderOptions): StickerProvider {
	const items = Array.from({ length: count }, (_, index) => item({ provider: id, n: index }));
	return {
		id,
		async search({ options }): Promise<StickerSearchResult> {
			if (rejectWith !== undefined) throw rejectWith;
			if (searchError) return { items: [], total: 0, hasMore: false, error: searchError };
			const limit = options?.limit ?? items.length;
			return { items: items.slice(0, limit), total: items.length, hasMore: limit < items.length };
		},
		async browse({ options }): Promise<StickerBrowseResult> {
			onBrowse?.();
			if (rejectWith !== undefined) throw rejectWith;
			if (browseError) return { sections: [], error: browseError };
			const limit = options?.limit ?? items.length;
			return { sections: [{ id: "all", items: items.slice(0, limit), hasMore: limit < items.length, layout: "grid" }] };
		},
		resolveUrl: ({ stickerId }) => `/${stickerId.replace(":", "/")}.svg`,
		...(describeSticker ? { describeSticker: ({ stickerId }) => describeSticker(stickerId) } : {}),
	};
}

let consoleError: ReturnType<typeof spyOn<Console, "error">>;
let consoleWarn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
	consoleError = spyOn(console, "error").mockImplementation(() => {});
	consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	consoleError.mockRestore();
	consoleWarn.mockRestore();
});

describe("a provider that cannot be loaded does not vanish from the All tab", () => {
	test("browse: its section stays, empty, with the error", async () => {
		const providers = [
			fakeProvider({ id: "emoji", browseError: "The emoji catalog could not be loaded." }),
			fakeProvider({ id: "flags" }),
		];
		const { sections } = await browseAll({ recentStickers: [], providers });
		expect(sections.map((section) => section.id)).toEqual(["emoji", "flags"]);
		expect(sections[0]).toMatchObject({
			id: "emoji",
			title: "Emoji",
			items: [],
			error: "The emoji catalog could not be loaded.",
		});
		expect(sections[1].error).toBeUndefined();
		expect(sections[1].items.length).toBeGreaterThan(0);
	});

	test("search: same", async () => {
		const providers = [
			fakeProvider({ id: "emoji", searchError: "The emoji catalog could not be loaded." }),
			fakeProvider({ id: "icons" }),
		];
		const { sections } = await searchAll({ query: "x", providers });
		expect(sections.map((section) => section.id)).toEqual(["emoji", "icons"]);
		expect(sections[0]).toMatchObject({ items: [], error: "The emoji catalog could not be loaded." });
	});

	test("a provider with no stickers and no error is still skipped (logos, an empty search)", async () => {
		const providers = [fakeProvider({ id: "logos", count: 0 }), fakeProvider({ id: "flags" })];
		expect((await browseAll({ recentStickers: [], providers })).sections.map((s) => s.id)).toEqual(["flags"]);
		expect((await searchAll({ query: "x", providers })).sections.map((s) => s.id)).toEqual(["flags"]);
	});

	test("a provider that throws is logged with its id and shown as an error too", async () => {
		const providers = [fakeProvider({ id: "emoji", rejectWith: new Error("boom") }), fakeProvider({ id: "flags" })];
		const browsed = await browseAll({ recentStickers: [], providers });
		expect(browsed.sections[0]).toMatchObject({ id: "emoji", items: [], error: "Emoji could not be loaded." });
		expect(browsed.sections[1].id).toBe("flags");
		const searched = await searchAll({ query: "x", providers });
		expect(searched.sections[0]).toMatchObject({ id: "emoji", error: "Emoji could not be loaded." });

		const logged = consoleError.mock.calls.map((call) => String(call[0]));
		expect(logged.filter((message) => message.includes('"emoji"'))).toHaveLength(2);
		expect(consoleError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
	});
});

describe("category views report a failure", () => {
	test("browseCategory returns the provider's error", async () => {
		const providers = [fakeProvider({ id: "emoji", browseError: "The emoji catalog could not be loaded." })];
		expect(await browseCategory({ category: "emoji", providers })).toEqual({
			sections: [],
			error: "The emoji catalog could not be loaded.",
		});
	});

	test("browseCategory turns a throwing provider into an error (and logs it)", async () => {
		const providers = [fakeProvider({ id: "emoji", rejectWith: new Error("boom") })];
		const result = await browseCategory({ category: "emoji", providers });
		expect(result).toEqual({ sections: [], error: "Emoji could not be loaded." });
		expect(consoleError).toHaveBeenCalledTimes(1);
	});

	test("searchStickers passes the error on, and turns a throw into one", async () => {
		const failing = [fakeProvider({ id: "icons", searchError: "The icon catalog could not be loaded." })];
		expect((await searchStickers({ query: "x", category: "icons", providers: failing })).error).toBe(
			"The icon catalog could not be loaded.",
		);
		const throwing = [fakeProvider({ id: "icons", rejectWith: new Error("boom") })];
		const result = await searchStickers({ query: "x", category: "icons", providers: throwing });
		expect(result).toMatchObject({ items: [], total: 0, hasMore: false, error: "Icons could not be loaded." });
		expect(consoleError).toHaveBeenCalledTimes(1);
	});

	test("a category nobody provides is empty, and says so in the log", async () => {
		const result = await browseCategory({ category: "emoji", providers: [] });
		expect(result).toEqual({ sections: [] });
		expect(consoleWarn).toHaveBeenCalledTimes(1);
		expect(String(consoleWarn.mock.calls[0]?.[0])).toContain("emoji");
	});
});

describe("category search has no ceiling", () => {
	test("returns every match, however many", async () => {
		const providers = [fakeProvider({ id: "icons", count: 5_000 })];
		const result = await searchStickers({ query: "s", category: "icons", providers });
		expect(result.items).toHaveLength(5_000);
		expect(result.total).toBe(5_000);
		expect(result.hasMore).toBe(false);
	});

	test("an explicit limit is still honoured", async () => {
		const providers = [fakeProvider({ id: "icons", count: 50 })];
		const result = await searchStickers({ query: "s", category: "icons", limit: 10, providers });
		expect(result.items).toHaveLength(10);
		expect(result.hasMore).toBe(true);
	});

	test("the All tab still caps each provider", async () => {
		const providers = [fakeProvider({ id: "emoji", count: 500 }), fakeProvider({ id: "icons", count: 500 })];
		const { sections } = await searchAll({ query: "s", providers });
		expect(sections[0].items).toHaveLength(50);
		expect(sections[0].hasMore).toBe(true);
	});
});

describe("category keys are own properties only", () => {
	test("isStickerCategory accepts the tabs and nothing inherited", () => {
		for (const key of Object.keys(STICKER_CATEGORIES)) {
			expect(isStickerCategory(key)).toBe(true);
		}
		for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "", "Emoji", 5, null, undefined]) {
			expect(isStickerCategory(value)).toBe(false);
		}
	});
});

describe("browseAll does its independent work at the same time", () => {
	test("provider browsing starts while 'Recently used' names are still being looked up", async () => {
		let browseStartedAt = Number.POSITIVE_INFINITY;
		let describeFinishedAt = 0;
		const providers = [
			fakeProvider({
				id: "emoji",
				onBrowse: () => {
					browseStartedAt = Date.now();
				},
				describe: async () => {
					await new Promise((done) => setTimeout(done, 80));
					describeFinishedAt = Date.now();
					return "Fire";
				},
			}),
		];
		const { sections } = await browseAll({ recentStickers: ["emoji:1f525"], providers });
		expect(sections[0].id).toBe("recent");
		expect(sections[0].items[0].name).toBe("Fire");
		expect(browseStartedAt).toBeLessThan(describeFinishedAt - 40);
	});

	test("a recent whose provider is unknown or whose lookup fails is logged, not fatal", async () => {
		const providers = [
			fakeProvider({
				id: "emoji",
				describe: async () => {
					throw new Error("lookup failed");
				},
			}),
		];
		const { sections } = await browseAll({
			recentStickers: ["emoji:1f525", "nonsense", "unknown:thing"],
			providers,
		});
		// emoji:1f525 keeps its id-derived name; the unparseable and unknown ones are dropped.
		const recent = sections.find((section) => section.id === "recent");
		expect(recent?.items.map((entry) => entry.id)).toEqual(["emoji:1f525"]);
		expect(consoleWarn.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});

describe("resolveStickerIntrinsicSize", () => {
	const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");

	class FakeImage {
		static outcome: "load" | "error" | "hang" = "load";
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		naturalWidth = 640;
		naturalHeight = 480;
		set src(url: string) {
			if (url === "") return;
			queueMicrotask(() => {
				if (FakeImage.outcome === "load") this.onload?.();
				if (FakeImage.outcome === "error") this.onerror?.();
			});
		}
	}

	function installFakeImage() {
		Object.defineProperty(globalThis, "Image", { configurable: true, writable: true, value: FakeImage });
	}
	afterEach(() => {
		if (originalImage) Object.defineProperty(globalThis, "Image", originalImage);
		else Reflect.deleteProperty(globalThis, "Image");
	});

	test("reads the natural size of a sticker that loads", async () => {
		installFakeImage();
		FakeImage.outcome = "load";
		expect(await resolveStickerIntrinsicSize({ stickerId: "flags:US" })).toEqual({ width: 640, height: 480 });
	});

	test("rejects for a sticker that cannot be loaded, instead of inventing 200 x 200", async () => {
		installFakeImage();
		FakeImage.outcome = "error";
		await expect(resolveStickerIntrinsicSize({ stickerId: "emoji:zzz" })).rejects.toThrow(/emoji:zzz/);
	});

	test("rejects for an id that does not resolve at all", async () => {
		installFakeImage();
		await expect(resolveStickerIntrinsicSize({ stickerId: "logos:anything" })).rejects.toThrow();
	});
});
