import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StickerItem } from "../types";

// The picker's real markup (StickersView, tabs, grids, tiles). Only the editor
// singleton and the browser's Image are replaced.

mock.module("@/editor/use-editor", () => ({
	useEditor: () => ({
		playback: { getCurrentTime: () => 0 },
		timeline: { dragSource: { begin: () => {}, end: () => {} } },
	}),
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeAll(() => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			Image: class { src = ""; },
			location: { href: "http://localhost/", origin: "http://localhost" },
		},
	});
});
afterAll(() => {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

const { LoadErrorView, ProgressiveStickerGrid, SearchResultsView, StickerSection, StickersView } = await import(
	"../components/assets-view"
);

function tile(index: number): StickerItem {
	return {
		id: `emoji:${(0x1f600 + index).toString(16)}`,
		provider: "emoji",
		name: `Emoji ${index}`,
		previewUrl: `/emoji/fluent-flat/${(0x1f600 + index).toString(16)}.svg`,
		metadata: {},
	};
}

function renderPicker({ sections }: { sections: { id: string; items: StickerItem[] }[] }) {
	return renderToStaticMarkup(
		<>
			{sections.map((section) => (
				<StickerSection
					key={section.id}
					section={{ ...section, layout: "grid" }}
					onClearRecent={() => {}}
					onSeeAll={() => {}}
					onRetry={() => {}}
				/>
			))}
		</>,
	);
}

function openingTag({ html, pattern }: { html: string; pattern: RegExp }): string {
	return pattern.exec(html)?.[0] ?? "";
}

describe("category tabs at a narrow panel width", () => {
	const html = renderToStaticMarkup(<StickersView />);
	const tablist = openingTag({ html, pattern: /<div[^>]*role="tablist"[^>]*>/ });

	test("lists the five categories in order", () => {
		const labels = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1]);
		expect(labels).toEqual(["All", "Emoji", "Icons", "Flags", "Shapes"]);
	});

	test("the tab bar scrolls sideways with no visible scrollbar", () => {
		expect(tablist).toContain("overflow-x-auto");
		expect(tablist).toContain("scrollbar-hidden");
	});

	test("the active underline keeps its look inside the scroller (measured in Chromium)", () => {
		// overflow clips the trigger's -mb-px overlap of the list border, which
		// thins the underline; the border moves into the scroller as an inset shadow.
		expect(tablist).toContain("border-b-0");
		expect(tablist).toContain("pb-px");
		expect(tablist).toContain("[box-shadow:inset_0_-1px_0_0_var(--border)]");
	});

	test("tabs keep their width instead of squeezing their labels", () => {
		const triggers = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
		expect(triggers).toHaveLength(5);
		for (const trigger of triggers) {
			expect(trigger).toContain("shrink-0");
		}
	});
});

describe("big sticker grids", () => {
	const big = Array.from({ length: 100 }, (_, index) => tile(index));
	const small = Array.from({ length: 6 }, (_, index) => tile(200 + index));

	function gridTags({ html }: { html: string }) {
		return html.match(/<div class="grid gap-2[^"]*"[^>]*>/g) ?? [];
	}

	test("a long grid skips rendering while it is off screen, with a placeholder height", () => {
		const grids = gridTags({ html: renderPicker({ sections: [{ id: "people", items: big }] }) });
		expect(grids).toHaveLength(1);
		expect(grids[0]).toContain("[content-visibility:auto]");
		expect(grids[0]).toContain("[contain-intrinsic-block-size:auto_600px]");
	});

	test("a short grid is left alone: a placeholder would be taller than the grid", () => {
		const grids = gridTags({ html: renderPicker({ sections: [{ id: "few", items: small }] }) });
		expect(grids).toHaveLength(1);
		expect(grids[0]).not.toContain("content-visibility");
		expect(grids[0]).not.toContain("contain-intrinsic");
	});

	test("only the long grids of a mixed tab are affected", () => {
		const grids = gridTags({
			html: renderPicker({
				sections: [
					{ id: "people", items: big },
					{ id: "few", items: small },
				],
			}),
		});
		expect(grids.map((grid) => grid.includes("content-visibility"))).toEqual([true, false]);
	});

	test("every tile of a long grid is still in the markup (nothing is virtualised away)", () => {
		const html = renderPicker({ sections: [{ id: "people", items: big }] });
		expect(html.match(/aria-label="Add Emoji \d+"/g)).toHaveLength(100);
	});
});

describe("tab bar keyboard focus (the scroller must not clip the focus ring)", () => {
	const html = renderToStaticMarkup(<StickersView />);
	const tablist = openingTag({ html, pattern: /<div[^>]*role="tablist"[^>]*>/ });
	const triggers = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];

	test("the bar clips vertically, so the ring has to stay inside each tab", () => {
		expect(tablist).toContain("overflow-y-hidden");
	});

	test("every tab draws its focus ring inside its own box", () => {
		expect(triggers).toHaveLength(5);
		for (const trigger of triggers) {
			expect(trigger).toContain("focus-visible:ring-inset");
			expect(trigger).toContain("focus-visible:ring-offset-0");
			expect(trigger).not.toContain("focus-visible:ring-offset-2");
			expect(trigger).toContain("focus-visible:ring-2"); // still a visible 2px ring
		}
	});
});

describe("search box", () => {
	const html = renderToStaticMarkup(<StickersView />);
	const input = openingTag({ html, pattern: /<input[^>]*>/ });

	test("has an accessible name and a 200 character limit", () => {
		expect(input).toContain('aria-label="Search stickers"');
		expect(input).toContain('maxLength="200"');
	});
});

describe("load errors are visible and retryable", () => {
	test("LoadErrorView: says what happened and offers Retry", () => {
		const html = renderToStaticMarkup(
			<LoadErrorView message="The emoji catalog could not be loaded." onRetry={() => {}} />,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Couldn&#x27;t load stickers");
		expect(html).toContain("The emoji catalog could not be loaded.");
		expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
		expect(html).not.toContain("No stickers found");
	});

	test("a provider row that failed stays on the All tab, with its message and one Retry that retries all", () => {
		const html = renderToStaticMarkup(
			<StickerSection
				section={{ id: "emoji", title: "Emoji", items: [], layout: "row", error: "The emoji catalog could not be loaded." }}
				onClearRecent={() => {}}
				onSeeAll={() => {}}
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain("Emoji");
		expect(html).toContain("The emoji catalog could not be loaded.");
		// Several failed rows must not be several alerts (the single status region
		// announces it), and the label says what the button does: it retries all.
		expect(html).not.toContain('role="alert"');
		expect(html).toMatch(/<button[^>]*aria-label="Retry loading stickers"[^>]*>Retry<\/button>/);
	});

	test("a healthy section has no alert", () => {
		const html = renderPicker({ sections: [{ id: "flags", items: [tile(1)] }] });
		expect(html).not.toContain('role="alert"');
	});
});

describe("See all", () => {
	test("is named after the section it opens", () => {
		const html = renderToStaticMarkup(
			<StickerSection
				section={{
					id: "emoji",
					title: "Emoji",
					items: [tile(1)],
					layout: "row",
					action: { type: "see-all", category: "emoji" },
				}}
				onClearRecent={() => {}}
				onSeeAll={() => {}}
				onRetry={() => {}}
			/>,
		);
		expect(html).toMatch(/<button[^>]*aria-label="See all Emoji"[^>]*>See all<\/button>/);
	});
});

describe("search results", () => {
	const many = Array.from({ length: 2000 }, (_, index) => tile(index));
	const tilesIn = (html: string) => (html.match(/aria-label="Add Emoji \d+"/g) ?? []).length;

	test("the visible count is plain text (the one live region announces it), singular for one", () => {
		const one = renderToStaticMarkup(<SearchResultsView results={{ items: many.slice(0, 1), total: 1 }} regionLabel={null} isSearching={false} />);
		expect(one).toContain("1 result<");
		expect(one).not.toContain("1 results");
		expect(one).not.toContain('role="status"');
		const five = renderToStaticMarkup(<SearchResultsView results={{ items: many.slice(0, 5), total: 5 }} regionLabel={null} isSearching={false} />);
		expect(five).toContain("5 results<");
	});

	test("while a new search runs the old results stay, dimmed, and the region is marked busy", () => {
		const busy = renderToStaticMarkup(<SearchResultsView results={{ items: many.slice(0, 3), total: 3 }} regionLabel={null} isSearching />);
		expect(busy).toContain('aria-busy="true"');
		expect(busy).toContain("opacity-60");
		const idle = renderToStaticMarkup(<SearchResultsView results={{ items: many.slice(0, 3), total: 3 }} regionLabel={null} isSearching={false} />);
		expect(idle).toContain('aria-busy="false"');
		expect(idle).not.toContain("opacity-60");
	});

	test("2,000 results draw about 200 tiles first, not all at once", () => {
		const html = renderToStaticMarkup(<SearchResultsView results={{ items: many, total: 2000 }} regionLabel={null} isSearching={false} />);
		expect(html).toContain("2000 results");
		expect(tilesIn(html)).toBe(200);
		expect(html).toContain("data-sticker-sentinel");
	});

	test("a short list is drawn whole, with no sentinel", () => {
		const html = renderToStaticMarkup(<ProgressiveStickerGrid items={many.slice(0, 150)} />);
		expect(tilesIn(html)).toBe(150);
		expect(html).not.toContain("data-sticker-sentinel");
	});

	test("exactly 200 results need no sentinel either", () => {
		const html = renderToStaticMarkup(<ProgressiveStickerGrid items={many.slice(0, 200)} />);
		expect(tilesIn(html)).toBe(200);
		expect(html).not.toContain("data-sticker-sentinel");
	});

	test("the tiles drawn are the first ones, in order", () => {
		const html = renderToStaticMarkup(<ProgressiveStickerGrid items={many} />);
		const names = [...html.matchAll(/aria-label="Add (Emoji \d+)"/g)].map((match) => match[1]);
		expect(names[0]).toBe("Emoji 0");
		expect(names[199]).toBe("Emoji 199");
		expect(names).toHaveLength(200);
	});
});

describe("the picker's live region and tab panel", () => {
	const html = renderToStaticMarkup(<StickersView />);

	test("there is exactly one polite live region, always in the page", () => {
		expect(html.match(/role="status"/g)).toHaveLength(1);
		expect(html).toMatch(/<div[^>]*role="status"[^>]*aria-live="polite"[^>]*>/);
	});

	test("the scroller is the tab panel of the active tab, so the tab's aria-controls points at something", () => {
		const panel = openingTag({ html, pattern: /<div[^>]*role="tabpanel"[^>]*>/ });
		expect(panel).toContain("overflow-y-auto");
		const panelId = /\bid="([^"]+)"/.exec(panel)?.[1];
		const active = openingTag({ html, pattern: /<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>/ });
		expect(panelId).toBeTruthy();
		expect(active).toContain(`aria-controls="${panelId}"`);
	});

	test("the panel's focus ring stays inside it (it is a scroller)", () => {
		const panel = openingTag({ html, pattern: /<div[^>]*role="tabpanel"[^>]*>/ });
		expect(panel).toContain("focus-visible:ring-inset");
	});
});

describe("long browse sections are drawn in parts too (the Emoji and Icons tabs hold 1,600 and 2,900 tiles)", () => {
	const tilesIn = (html: string) => (html.match(/aria-label="Add Emoji \d+"/g) ?? []).length;

	test("a section of 500 draws 200 first, with a marker for the rest", () => {
		const html = renderPicker({ sections: [{ id: "people", items: Array.from({ length: 500 }, (_, index) => tile(index)) }] });
		expect(tilesIn(html)).toBe(200);
		expect(html).toContain("data-sticker-sentinel");
	});

	test("a section of 200 or fewer is drawn whole", () => {
		const html = renderPicker({ sections: [{ id: "few", items: Array.from({ length: 200 }, (_, index) => tile(index)) }] });
		expect(tilesIn(html)).toBe(200);
		expect(html).not.toContain("data-sticker-sentinel");
	});
});

describe("Clear and See all are named after their section", () => {
	test("Clear on the recently used row says what it clears", () => {
		const html = renderToStaticMarkup(
			<StickerSection section={{ id: "recent", title: "Recently used", items: [tile(1)], layout: "row" }} onClearRecent={() => {}} onSeeAll={() => {}} onRetry={() => {}} />,
		);
		expect(html).toMatch(/<button[^>]*aria-label="Clear Recently used"[^>]*>Clear<\/button>/);
	});
});
