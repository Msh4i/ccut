import { describe, expect, mock, test } from "bun:test";
import { createSearchInput } from "../search-input";
import { revealTab } from "../tab-reveal";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("createSearchInput (the picker's search box)", () => {
	function setup({ delayMs = 30 } = {}) {
		const searches: string[] = [];
		const box = createSearchInput({
			search: ({ query }) => void searches.push(query),
			delayMs,
		});
		return { box, searches };
	}

	test("typing searches once, after the pause, with what was typed last", async () => {
		const { box, searches } = setup();
		for (const query of ["h", "he", "hea", "hear", "heart"]) box.input({ query });
		expect(searches).toEqual([]); // nothing searched while typing
		await sleep(90);
		expect(searches).toEqual(["heart"]);
	});

	test("emptying the box searches at once (to show the browse view) and drops the pending search", async () => {
		const { box, searches } = setup();
		box.input({ query: "heart" });
		box.input({ query: "" });
		expect(searches).toEqual([""]);
		await sleep(90);
		expect(searches).toEqual([""]); // the earlier "heart" never runs
	});

	test("a box holding only spaces counts as empty", async () => {
		const { box, searches } = setup();
		box.input({ query: "   " });
		expect(searches).toEqual(["   "]);
	});

	test("changing tab cancels the pending search (the store searches the new tab itself)", async () => {
		const { box, searches } = setup();
		box.input({ query: "heart" });
		box.cancelPending();
		await sleep(90);
		expect(searches).toEqual([]);
	});

	test("flushPending runs the waiting search now (the panel closes: a typed query is not lost)", async () => {
		const { box, searches } = setup();
		box.input({ query: "heart" });
		box.flushPending();
		expect(searches).toEqual(["heart"]);
		await sleep(90);
		expect(searches).toEqual(["heart"]); // not a second time
	});

	test("flushPending with nothing waiting does nothing", () => {
		const { box, searches } = setup();
		box.flushPending();
		expect(searches).toEqual([]);
	});

	test("it keeps working after a cancel", async () => {
		const { box, searches } = setup();
		box.input({ query: "a" });
		box.cancelPending();
		box.input({ query: "b" });
		await sleep(90);
		expect(searches).toEqual(["b"]);
	});
});

describe("revealTab (the active tab after a category change)", () => {
	function fakeTab() {
		return { scrollIntoView: mock((_options: ScrollIntoViewOptions) => {}), focus: mock((_options: FocusOptions) => {}) };
	}

	test("scrolls the tab into view without jumping the page", () => {
		const tab = fakeTab();
		revealTab({ tab, takeFocus: false });
		expect(tab.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
		expect(tab.focus).not.toHaveBeenCalled();
	});

	test("after 'See all' it also takes the focus, because the button that had it is gone", () => {
		const tab = fakeTab();
		revealTab({ tab, takeFocus: true });
		expect(tab.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(tab.focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	test("no tab (not rendered yet) is nothing to do", () => {
		expect(() => revealTab({ tab: null, takeFocus: true })).not.toThrow();
		expect(() => revealTab({ tab: undefined, takeFocus: false })).not.toThrow();
	});
});
