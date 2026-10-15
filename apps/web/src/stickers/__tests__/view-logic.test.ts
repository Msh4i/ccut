import { describe, expect, test } from "bun:test";
import {
	PROGRESSIVE_INITIAL_COUNT,
	PROGRESSIVE_STEP,
	formatResultCount,
	getContentState,
	getEmptyMessage,
	getStatusMessage,
	horizontalScrollTarget,
	revealMore,
	shouldStartInitialBrowse,
} from "../view-logic";

describe("revealMore (a long result list is drawn in parts)", () => {
	test("adds one step, never beyond the total", () => {
		expect(revealMore({ visible: 200, total: 2000 })).toBe(200 + PROGRESSIVE_STEP);
		expect(revealMore({ visible: 1900, total: 2000 })).toBe(2000);
		expect(revealMore({ visible: 2000, total: 2000 })).toBe(2000);
		expect(revealMore({ visible: 0, total: 50 })).toBe(50);
	});

	test("revealing until done shows every item exactly once, nothing lost", () => {
		const total = 2866;
		let visible = PROGRESSIVE_INITIAL_COUNT;
		const seen = [visible];
		// Bounded on purpose: a wrong revealMore must fail this test, not hang it.
		for (let round = 0; round < 50 && visible < total; round++) {
			visible = revealMore({ visible, total });
			seen.push(visible);
		}
		expect(seen.length).toBeLessThan(50);
		expect(visible).toBe(total);
		expect(seen.every((value, index) => index === 0 || value > seen[index - 1])).toBe(true);
		expect(seen.length).toBe(Math.ceil((total - PROGRESSIVE_INITIAL_COUNT) / PROGRESSIVE_STEP) + 1);
	});

	test("starts with about 200 tiles", () => {
		expect(PROGRESSIVE_INITIAL_COUNT).toBe(200);
	});
});

describe("shouldStartInitialBrowse (the panel effect must not duplicate the store's browse)", () => {
	const base = { viewMode: "browse" as const, hasBrowseContent: false, isBrowsing: false, loadError: null };

	test("starts when nothing is loaded and nothing is loading", () => {
		expect(shouldStartInitialBrowse(base)).toBe(true);
	});

	test("does not start while a browse is already running (a category change just started one)", () => {
		expect(shouldStartInitialBrowse({ ...base, isBrowsing: true })).toBe(false);
	});

	test("does not start when content is there, in search mode, or after a failure (Retry is the user's)", () => {
		expect(shouldStartInitialBrowse({ ...base, hasBrowseContent: true })).toBe(false);
		expect(shouldStartInitialBrowse({ ...base, viewMode: "search" })).toBe(false);
		expect(shouldStartInitialBrowse({ ...base, loadError: "Couldn't load stickers." })).toBe(false);
	});
});

describe("horizontalScrollTarget (mouse wheel over the tab bar)", () => {
	const overflowing = { deltaX: 0, deltaY: 100, deltaMode: 0, scrollLeft: 0, scrollWidth: 500, clientWidth: 300 };

	test("a vertical wheel scrolls the overflowing bar sideways", () => {
		expect(horizontalScrollTarget(overflowing)).toBe(100);
		expect(horizontalScrollTarget({ ...overflowing, deltaY: -50, scrollLeft: 120 })).toBe(70);
	});

	test("never scrolls past either end", () => {
		expect(horizontalScrollTarget({ ...overflowing, scrollLeft: 150 })).toBe(200);
		expect(horizontalScrollTarget({ ...overflowing, deltaY: -500, scrollLeft: 30 })).toBe(0);
	});

	test("leaves the wheel alone when nothing overflows", () => {
		expect(horizontalScrollTarget({ ...overflowing, scrollWidth: 300 })).toBeNull();
		expect(horizontalScrollTarget({ ...overflowing, scrollWidth: 200, clientWidth: 300 })).toBeNull();
	});

	test("leaves a sideways gesture (a trackpad) to the browser", () => {
		expect(horizontalScrollTarget({ ...overflowing, deltaX: 30 })).toBeNull();
	});

	test("leaves it alone at an end, so the page can take the wheel", () => {
		expect(horizontalScrollTarget({ ...overflowing, scrollLeft: 200 })).toBeNull();
		expect(horizontalScrollTarget({ ...overflowing, deltaY: -100, scrollLeft: 0 })).toBeNull();
	});

	test("ignores a wheel without movement", () => {
		expect(horizontalScrollTarget({ ...overflowing, deltaY: 0 })).toBeNull();
	});

	test("line-based wheels (deltaMode 1) move further than pixel ones", () => {
		const lines = horizontalScrollTarget({ ...overflowing, deltaY: 3, deltaMode: 1 });
		expect(lines).toBeGreaterThan(3);
	});
});

describe("getContentState", () => {
	const base = {
		viewMode: "browse" as const,
		selectedCategory: "emoji",
		isSearching: false,
		isBrowsing: false,
		loadError: null,
		hasSearchResults: false,
		hasBrowseSections: false,
	};

	test("a load error wins over everything", () => {
		expect(getContentState({ ...base, loadError: "x", hasBrowseSections: true })).toBe("error");
		expect(getContentState({ ...base, viewMode: "search", loadError: "x", hasSearchResults: true })).toBe("error");
	});

	test("browsing: spinner while loading with nothing to show, then sections, or empty", () => {
		expect(getContentState({ ...base, isBrowsing: true })).toBe("spinner");
		expect(getContentState({ ...base, isBrowsing: true, hasBrowseSections: true })).toBe("sections");
		expect(getContentState({ ...base, hasBrowseSections: true })).toBe("sections");
		expect(getContentState(base)).toBe("empty");
	});

	test("searching keeps the previous results on screen instead of swapping the grid for a spinner", () => {
		const searching = { ...base, viewMode: "search" as const, isSearching: true };
		expect(getContentState({ ...searching, hasSearchResults: true })).toBe("results");
		expect(getContentState(searching)).toBe("spinner");
	});

	test("search finished: results, or 'no results' for a category, or sections on the All tab", () => {
		const done = { ...base, viewMode: "search" as const };
		expect(getContentState({ ...done, hasSearchResults: true })).toBe("results");
		expect(getContentState(done)).toBe("no-results");
		expect(getContentState({ ...done, selectedCategory: "all", hasBrowseSections: true })).toBe("sections");
		expect(getContentState({ ...done, selectedCategory: "all" })).toBe("empty");
	});

	test("All tab search shows the previous sections while the next search runs", () => {
		const state = { ...base, viewMode: "search" as const, selectedCategory: "all", isSearching: true };
		expect(getContentState({ ...state, hasBrowseSections: true })).toBe("sections");
		expect(getContentState(state)).toBe("spinner");
	});
});

describe("the wheel and the browser's own zoom", () => {
	const overflowing = { deltaX: 0, deltaY: 100, deltaMode: 0, scrollLeft: 0, scrollWidth: 500, clientWidth: 300 };

	test("Ctrl or Meta with the wheel is pinch-zoom or page zoom: left to the browser", () => {
		expect(horizontalScrollTarget({ ...overflowing, ctrlKey: true })).toBeNull();
		expect(horizontalScrollTarget({ ...overflowing, metaKey: true })).toBeNull();
		expect(horizontalScrollTarget({ ...overflowing, ctrlKey: false, metaKey: false })).toBe(100);
	});
});

describe("formatResultCount", () => {
	test("says '1 result', not '1 results'", () => {
		expect(formatResultCount({ total: 0 })).toBe("0 results");
		expect(formatResultCount({ total: 1 })).toBe("1 result");
		expect(formatResultCount({ total: 2 })).toBe("2 results");
		expect(formatResultCount({ total: 1595 })).toBe("1595 results");
	});
});

describe("getStatusMessage (the one live region of the picker)", () => {
	const base = { state: "results" as const, viewMode: "search" as const, isSearching: false, total: 5, sectionCount: 0, hasSectionErrors: false, loadError: null };

	test("says Searching while a search runs, even with the previous results still on screen", () => {
		expect(getStatusMessage({ ...base, isSearching: true })).toBe("Searching…");
	});

	test("then the count of the new results", () => {
		expect(getStatusMessage(base)).toBe("5 results");
		expect(getStatusMessage({ ...base, total: 1 })).toBe("1 result");
	});

	test("no matches", () => {
		expect(getStatusMessage({ ...base, state: "no-results", total: 0 })).toBe("No stickers found");
	});

	test("an All-tab search names how many categories answered", () => {
		expect(getStatusMessage({ ...base, state: "sections", sectionCount: 3 })).toBe("Found stickers in 3 categories");
		expect(getStatusMessage({ ...base, state: "sections", sectionCount: 1 })).toBe("Found stickers in 1 category");
	});

	test("a load error is announced, and so is a section that failed", () => {
		expect(getStatusMessage({ ...base, state: "error", loadError: "The emoji catalog could not be loaded." })).toBe("The emoji catalog could not be loaded.");
		expect(getStatusMessage({ ...base, viewMode: "browse", state: "sections", hasSectionErrors: true })).toBe("Some stickers could not be loaded");
	});

	test("browsing is silent", () => {
		expect(getStatusMessage({ ...base, viewMode: "browse", state: "sections" })).toBe("");
		expect(getStatusMessage({ ...base, viewMode: "browse", state: "spinner", isSearching: false })).toBe("");
	});
});

describe("getEmptyMessage", () => {
	test("names the query that was searched, not the text now in the box", () => {
		expect(getEmptyMessage({ viewMode: "search", selectedCategory: "emoji", searchedQuery: "zzzz" })).toBe('No stickers found for "zzzz"');
	});

	test("browse: all tab, or a category by name", () => {
		expect(getEmptyMessage({ viewMode: "browse", selectedCategory: "all", searchedQuery: "" })).toBe("No stickers available yet.");
		expect(getEmptyMessage({ viewMode: "browse", selectedCategory: "emoji", searchedQuery: "" })).toBe("No stickers available in emoji yet.");
	});

	test("a category that is not a tab (a damaged setting) is a message, not a crash", () => {
		for (const selectedCategory of ["constructor", "__proto__", "toString", "", "nope"]) {
			expect(() => getEmptyMessage({ viewMode: "browse", selectedCategory, searchedQuery: "" })).not.toThrow();
			expect(getEmptyMessage({ viewMode: "browse", selectedCategory, searchedQuery: "" })).toBe("No stickers available here yet.");
		}
	});

	test("a long query is cut in the message", () => {
		expect(getEmptyMessage({ viewMode: "search", selectedCategory: "emoji", searchedQuery: "q".repeat(5000) }).length).toBeLessThan(300);
	});
});
