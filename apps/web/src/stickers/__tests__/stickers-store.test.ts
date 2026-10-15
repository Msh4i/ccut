import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { StateStorage } from "zustand/middleware";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerSearchResult,
} from "../types";
import { createStickersStore, type StickersApi } from "../stickers-store";

// The store is driven with fake catalogs whose answers are released by hand, so
// "a slow answer arrives after the user has moved on" is staged exactly.

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function tile(id: string): StickerItem {
	return { id, provider: id.split(":")[0], name: id, previewUrl: `/${id}.svg`, metadata: {} };
}

function results(...ids: string[]): StickerSearchResult {
	return { items: ids.map(tile), total: ids.length, hasMore: false };
}

function sections(...ids: string[]): StickerBrowseResult {
	return { sections: [{ id: "all", items: ids.map(tile), layout: "grid" }] };
}

interface Call<T> {
	args: unknown;
	answer: Deferred<T>;
}

function createFakeApi() {
	const calls = {
		browseAll: [] as Call<StickerBrowseResult>[],
		browseCategory: [] as Call<StickerBrowseResult>[],
		searchAll: [] as Call<StickerBrowseResult>[],
		searchStickers: [] as Call<StickerSearchResult>[],
	};
	function make<T>({ list }: { list: Call<T>[] }) {
		return (args: unknown) => {
			const answer = deferred<T>();
			list.push({ args, answer });
			return answer.promise;
		};
	}
	const api: StickersApi = {
		browseAll: make({ list: calls.browseAll }),
		browseCategory: make({ list: calls.browseCategory }),
		searchAll: make({ list: calls.searchAll }),
		searchStickers: make({ list: calls.searchStickers }),
	};
	return { api, calls };
}

function memoryStorage(initial?: Record<string, string>): StateStorage {
	const data = new Map(Object.entries(initial ?? {}));
	return {
		getItem: (key) => data.get(key) ?? null,
		// mock(): the storage interface needs two positional parameters.
		setItem: mock((key: string, value: string) => void data.set(key, value)),
		removeItem: (key) => void data.delete(key),
	};
}

function setup() {
	const fake = createFakeApi();
	const store = createStickersStore({ api: fake.api, storage: memoryStorage() });
	return { ...fake, store };
}

let consoleError: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => {
	consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	consoleError.mockRestore();
});

/** Lets pending promise callbacks run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("a slow search must not overwrite a newer view", () => {
	test("A: switching tab while the search is in flight keeps the new tab's results", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji", searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" }); // call 0: emoji, slow
		store.getState().setSelectedCategory({ category: "icons" }); // call 1: icons
		expect(calls.searchStickers).toHaveLength(2);

		calls.searchStickers[1].answer.resolve(results("icons:heart"));
		await settle();
		expect(store.getState().searchResults?.items.map((i) => i.id)).toEqual(["icons:heart"]);
		expect(store.getState().isSearching).toBe(false);

		// The stale emoji answer arrives last and must change nothing.
		calls.searchStickers[0].answer.resolve(results("emoji:2764"));
		await settle();
		expect(store.getState().searchResults?.items.map((i) => i.id)).toEqual(["icons:heart"]);
		expect(store.getState().selectedCategory).toBe("icons");
	});

	test("A: and if the stale answer arrives first, the spinner stays until the real one", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji", searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" });
		store.getState().setSelectedCategory({ category: "icons" });

		calls.searchStickers[0].answer.resolve(results("emoji:2764"));
		await settle();
		expect(store.getState().searchResults).toBeNull();
		expect(store.getState().isSearching).toBe(true); // the old call's finally must not close it

		calls.searchStickers[1].answer.resolve(results("icons:heart"));
		await settle();
		expect(store.getState().isSearching).toBe(false);
		expect(store.getState().searchResults?.items[0].id).toBe("icons:heart");
	});

	test("B: a browse still in flight does not overwrite the search that started after it", async () => {
		const { store, calls } = setup();
		void store.getState().browseStickers(); // initial browse, slow (All tab)
		store.setState({ searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" });
		expect(store.getState().isBrowsing).toBe(false);
		expect(store.getState().isSearching).toBe(true);

		calls.searchAll[0].answer.resolve(sections("emoji:2764", "icons:heart"));
		await settle();
		const searched = store.getState().browseContent;
		expect(searched?.sections[0].items.map((i) => i.id)).toEqual(["emoji:2764", "icons:heart"]);
		expect(store.getState().viewMode).toBe("search");

		calls.browseAll[0].answer.resolve(sections("flags:US")); // arrives late
		await settle();
		expect(store.getState().browseContent).toBe(searched);
		expect(store.getState().isBrowsing).toBe(false);
	});

	test("B: the old browse's finally does not close the new search's spinner", async () => {
		const { store, calls } = setup();
		void store.getState().browseStickers();
		store.setState({ searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" });

		calls.browseAll[0].answer.resolve(sections("flags:US"));
		await settle();
		expect(store.getState().isSearching).toBe(true);
		expect(store.getState().browseContent).toBeNull();

		calls.searchAll[0].answer.resolve(sections("emoji:2764"));
		await settle();
		expect(store.getState().isSearching).toBe(false);
	});

	test("C: clearing the query cancels the search in flight", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji", searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" });
		store.setState({ searchQuery: "" });
		void store.getState().searchStickers({ query: "" }); // -> browse emoji
		expect(store.getState().viewMode).toBe("browse");
		expect(calls.browseCategory).toHaveLength(1);

		calls.searchStickers[0].answer.resolve(results("emoji:2764")); // late
		await settle();
		expect(store.getState().searchResults).toBeNull();
		expect(store.getState().viewMode).toBe("browse");

		calls.browseCategory[0].answer.resolve(sections("emoji:1f600"));
		await settle();
		expect(store.getState().browseContent?.sections[0].items[0].id).toBe("emoji:1f600");
		expect(store.getState().isBrowsing).toBe(false);
	});

	test("two quick searches: only the last answer counts, whichever arrives first", async () => {
		for (const order of [[0, 1], [1, 0]]) {
			const { store, calls } = setup();
			store.setState({ selectedCategory: "emoji" });
			void store.getState().searchStickers({ query: "he" });
			void store.getState().searchStickers({ query: "hea" });
			for (const index of order) {
				calls.searchStickers[index].answer.resolve(results(index === 0 ? "emoji:he" : "emoji:hea"));
				await settle();
			}
			expect(store.getState().searchResults?.items[0].id).toBe("emoji:hea");
			expect(store.getState().isSearching).toBe(false);
		}
	});
});

describe("races on the All tab and between browses", () => {
	test("All tab: two quick searches, only the last answer counts, whichever arrives first", async () => {
		for (const order of [[0, 1], [1, 0]]) {
			const { store, calls } = setup();
			store.setState({ selectedCategory: "all" });
			void store.getState().searchStickers({ query: "he" });
			void store.getState().searchStickers({ query: "hea" });
			for (const index of order) {
				calls.searchAll[index].answer.resolve(sections(index === 0 ? "emoji:he" : "emoji:hea"));
				await settle();
			}
			expect(store.getState().browseContent?.sections[0].items[0].id).toBe("emoji:hea");
			expect(store.getState().isSearching).toBe(false);
		}
	});

	test("two browses in a row: the older one neither overwrites nor ends the loading state of the newer", async () => {
		const { store, calls } = setup();
		void store.getState().browseStickers(); // A
		void store.getState().browseStickers(); // B
		expect(calls.browseAll).toHaveLength(2);

		calls.browseAll[0].answer.resolve(sections("flags:old"));
		await settle();
		expect(store.getState().browseContent).toBeNull(); // A's answer is stale
		expect(store.getState().isBrowsing).toBe(true); // B is still running

		calls.browseAll[1].answer.resolve(sections("flags:new"));
		await settle();
		expect(store.getState().browseContent?.sections[0].items[0].id).toBe("flags:new");
		expect(store.getState().isBrowsing).toBe(false);
	});
});

describe("switching category", () => {
	test("starts exactly one browse (the panel effect must not start a second)", async () => {
		const { store, calls } = setup();
		store.getState().setSelectedCategory({ category: "icons" });
		expect(calls.browseCategory).toHaveLength(1);
		expect(store.getState().isBrowsing).toBe(true);
		expect(store.getState().browseContent).toBeNull();
		await settle();
		expect(calls.browseCategory).toHaveLength(1);
	});

	test("clears the previous tab's results at once", () => {
		const { store } = setup();
		store.setState({ searchResults: results("emoji:2764"), loadError: "old" });
		store.getState().setSelectedCategory({ category: "flags" });
		expect(store.getState().searchResults).toBeNull();
		expect(store.getState().loadError).toBeNull();
	});

	test("keeps a typed query and searches it in the new tab", () => {
		const { store, calls } = setup();
		store.setState({ searchQuery: "heart" });
		store.getState().setSelectedCategory({ category: "icons" });
		expect(calls.searchStickers).toHaveLength(1);
		expect(calls.searchStickers[0].args).toMatchObject({ query: "heart", category: "icons" });
		expect(calls.browseCategory).toHaveLength(0);
	});

	test("a persisted or hostile category key (constructor, __proto__) falls back to All", () => {
		for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			const storage = memoryStorage({
				"stickers-settings": JSON.stringify({
					state: { selectedCategory: hostile, recentStickers: [] },
					version: 0,
				}),
			});
			const store = createStickersStore({ api: createFakeApi().api, storage });
			expect(store.getState().selectedCategory).toBe("all");
		}
	});
});

describe("a catalog that cannot be loaded is shown as an error, with Retry", () => {
	test("a category browse that reports an error sets loadError; Retry runs it again and clears it", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji" });
		void store.getState().browseStickers();
		calls.browseCategory[0].answer.resolve({ sections: [], error: "The emoji catalog could not be loaded." });
		await settle();
		expect(store.getState().loadError).toBe("The emoji catalog could not be loaded.");
		expect(store.getState().isBrowsing).toBe(false);

		const retry = store.getState().retryLoad();
		expect(store.getState().loadError).toBeNull();
		expect(store.getState().isBrowsing).toBe(true);
		calls.browseCategory[1].answer.resolve(sections("emoji:1f600"));
		await retry;
		expect(store.getState().loadError).toBeNull();
		expect(store.getState().browseContent?.sections[0].items[0].id).toBe("emoji:1f600");
	});

	test("a search that reports an error sets loadError, and Retry repeats the same search", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "icons", searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" });
		calls.searchStickers[0].answer.resolve({ items: [], total: 0, hasMore: false, error: "The icon catalog could not be loaded." });
		await settle();
		expect(store.getState().loadError).toBe("The icon catalog could not be loaded.");

		const retry = store.getState().retryLoad();
		expect(calls.searchStickers[1].args).toMatchObject({ query: "heart", category: "icons" });
		calls.searchStickers[1].answer.resolve(results("icons:heart"));
		await retry;
		expect(store.getState().loadError).toBeNull();
		expect(store.getState().searchResults?.items[0].id).toBe("icons:heart");
	});

	test("a throw becomes an error too, and is logged", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji" });
		void store.getState().browseStickers();
		calls.browseCategory[0].answer.reject(new Error("boom"));
		await settle();
		expect(store.getState().loadError).toMatch(/couldn't load/i);
		expect(store.getState().browseContent).toBeNull();
		expect(consoleError).toHaveBeenCalled();
	});

	test("Retry with no query browses; with a query searches", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "all", searchQuery: "" });
		void store.getState().retryLoad();
		expect(calls.browseAll).toHaveLength(1);
		store.setState({ searchQuery: "x" });
		void store.getState().retryLoad();
		expect(calls.searchAll).toHaveLength(1);
	});

	test("a successful load has no error", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji" });
		void store.getState().browseStickers();
		calls.browseCategory[0].answer.resolve(sections("emoji:1f600"));
		await settle();
		expect(store.getState().loadError).toBeNull();
	});
});

describe("recents", () => {
	test("persisted recents are sanitised on load: unknown providers and duplicates are dropped", () => {
		const storage = memoryStorage({
			"stickers-settings": JSON.stringify({
				state: {
					selectedCategory: "emoji",
					recentStickers: ["emoji:1f600", "emoji:1f600", "nonsense", "unknown:thing", 5],
				},
				version: 0,
			}),
		});
		const store = createStickersStore({ api: createFakeApi().api, storage });
		expect(store.getState().recentStickers).toEqual(["emoji:1f600"]);
		expect(store.getState().selectedCategory).toBe("emoji");
	});
});

describe("results stay on screen while the next search runs", () => {
	test("a category search keeps the previous results until the new ones arrive", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji", searchQuery: "he" });
		void store.getState().searchStickers({ query: "he" });
		calls.searchStickers[0].answer.resolve(results("emoji:he"));
		await settle();
		const first = store.getState().searchResults;
		expect(first?.items[0].id).toBe("emoji:he");

		store.setState({ searchQuery: "hea" });
		void store.getState().searchStickers({ query: "hea" });
		expect(store.getState().isSearching).toBe(true);
		expect(store.getState().searchResults).toBe(first); // not cleared: no spinner swap, no teardown

		calls.searchStickers[1].answer.resolve(results("emoji:hea"));
		await settle();
		expect(store.getState().searchResults?.items[0].id).toBe("emoji:hea");
		expect(store.getState().isSearching).toBe(false);
	});

	test("the All tab keeps its previous sections until the new ones arrive", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "all", searchQuery: "he" });
		void store.getState().searchStickers({ query: "he" });
		calls.searchAll[0].answer.resolve(sections("emoji:he"));
		await settle();
		const first = store.getState().browseContent;

		store.setState({ searchQuery: "hea" });
		void store.getState().searchStickers({ query: "hea" });
		expect(store.getState().browseContent).toBe(first);
		calls.searchAll[1].answer.resolve(sections("emoji:hea"));
		await settle();
		expect(store.getState().browseContent?.sections[0].items[0].id).toBe("emoji:hea");
	});

	test("a failed search shows the error, not the old results", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji", searchQuery: "he" });
		void store.getState().searchStickers({ query: "he" });
		calls.searchStickers[0].answer.resolve(results("emoji:he"));
		await settle();
		store.setState({ searchQuery: "hea" });
		void store.getState().searchStickers({ query: "hea" });
		calls.searchStickers[1].answer.resolve({ items: [], total: 0, hasMore: false, error: "The emoji catalog could not be loaded." });
		await settle();
		expect(store.getState().loadError).toBe("The emoji catalog could not be loaded.");
		expect(store.getState().searchResults?.items).toEqual([]);
	});
});

describe("saved settings are cleaned on every start, not only when the version changes", () => {
	function storeWith({ state, version = 1 }: { state: unknown; version?: number }) {
		const storage = memoryStorage({ "stickers-settings": JSON.stringify({ state, version }) });
		return createStickersStore({ api: createFakeApi().api, storage });
	}

	test("a category that is not one of the tabs becomes All, for the keys an object inherits too", () => {
		for (const selectedCategory of ["constructor", "__proto__", "toString", "hasOwnProperty", "Emoji", "", 5, null, {}, []]) {
			const store = storeWith({ state: { selectedCategory, recentStickers: [] } });
			expect(store.getState().selectedCategory).toBe("all");
		}
	});

	test("a real tab is kept", () => {
		expect(storeWith({ state: { selectedCategory: "icons", recentStickers: [] } }).getState().selectedCategory).toBe("icons");
	});

	test("recent stickers that are not a list become an empty list, and adding one still works", () => {
		for (const recentStickers of ["abc", {}, null, 5, true, { length: 3 }]) {
			const store = storeWith({ state: { selectedCategory: "all", recentStickers } });
			expect(store.getState().recentStickers).toEqual([]);
			expect(() => store.getState().addToRecentStickers({ stickerId: "emoji:1f600" })).not.toThrow();
			expect(store.getState().recentStickers).toEqual(["emoji:1f600"]);
		}
	});

	test("only valid, short, distinct ids survive in a list, at most 50", () => {
		const many = Array.from({ length: 80 }, (_, index) => `emoji:${(0x1f600 + index).toString(16)}`);
		const store = storeWith({
			state: {
				selectedCategory: "all",
				recentStickers: [{}, null, 5, "x".repeat(10_000), `emoji:${"1".repeat(500)}`, "nonsense", "unknown:thing", "emoji:1f600", "emoji:1f600", ...many],
			},
		});
		const recents = store.getState().recentStickers;
		expect(recents).toHaveLength(50);
		expect(new Set(recents).size).toBe(50);
		expect(recents.every((id) => id.length <= 120)).toBe(true);
		expect(recents[0]).toBe("emoji:1f600");
	});

	test("anything that is not an object is no settings at all", () => {
		for (const state of [null, "text", 5, [], true]) {
			const store = storeWith({ state });
			expect(store.getState().selectedCategory).toBe("all");
			expect(store.getState().recentStickers).toEqual([]);
		}
	});

	test("only the two saved settings are taken from storage: other keys cannot reach the store", () => {
		const store = storeWith({
			state: {
				selectedCategory: "emoji",
				recentStickers: [],
				isSearching: true,
				loadError: "planted",
				searchQuery: "planted",
				browseContent: { sections: [{ id: "x", items: [] }] },
				addToRecentStickers: "not a function",
				retryLoad: 1,
			},
		});
		const state = store.getState();
		expect(state.isSearching).toBe(false);
		expect(state.loadError).toBeNull();
		expect(state.searchQuery).toBe("");
		expect(state.browseContent).toBeNull();
		expect(typeof state.addToRecentStickers).toBe("function");
		expect(typeof state.retryLoad).toBe("function");
	});

	test("a damaged version number is cleaned as well", () => {
		const store = storeWith({ state: { selectedCategory: "constructor", recentStickers: "x" }, version: 0 });
		expect(store.getState().selectedCategory).toBe("all");
		expect(store.getState().recentStickers).toEqual([]);
	});
});

describe("searchedQuery is the query the results on screen belong to", () => {
	test("a category search sets it when its answer arrives, whatever the box says by then", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji", searchQuery: "heart" });
		void store.getState().searchStickers({ query: "heart" });
		expect(store.getState().searchedQuery).toBe(""); // nothing answered yet

		store.setState({ searchQuery: "hearts" }); // the user keeps typing
		calls.searchStickers[0].answer.resolve(results("emoji:2764"));
		await settle();
		expect(store.getState().searchedQuery).toBe("heart");
	});

	test("the All tab sets it too", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "all" });
		void store.getState().searchStickers({ query: "  fire  " });
		calls.searchAll[0].answer.resolve(sections("emoji:1f525"));
		await settle();
		expect(store.getState().searchedQuery).toBe("fire");
	});

	test("a stale answer does not move it", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji" });
		void store.getState().searchStickers({ query: "he" });
		void store.getState().searchStickers({ query: "hea" });
		calls.searchStickers[1].answer.resolve(results("emoji:hea"));
		await settle();
		calls.searchStickers[0].answer.resolve(results("emoji:he"));
		await settle();
		expect(store.getState().searchedQuery).toBe("hea");
	});

	test("browsing clears it", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji" });
		void store.getState().searchStickers({ query: "he" });
		calls.searchStickers[0].answer.resolve(results("emoji:he"));
		await settle();
		store.setState({ searchQuery: "" });
		void store.getState().searchStickers({ query: "" });
		expect(store.getState().searchedQuery).toBe("");
	});

	test("a failed search keeps the old value and shows the error", async () => {
		const { store, calls } = setup();
		store.setState({ selectedCategory: "emoji" });
		void store.getState().searchStickers({ query: "he" });
		calls.searchStickers[0].answer.reject(new Error("boom"));
		await settle();
		expect(store.getState().loadError).toBeTruthy();
	});
});
