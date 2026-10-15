import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineDragData } from "@/timeline/drag";

// DraggableItem is shared by the sticker, sound, text and effect tiles. Only
// the editor singleton and the browser's Image are replaced; the component,
// Button and AspectRatio are the real ones.

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
		value: { Image: class { src = ""; } },
	});
});
afterAll(() => {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

const { DraggableItem } = await import("../draggable-item");

const DRAG_DATA: TimelineDragData = {
	id: "emoji:2764-fe0f",
	type: "sticker",
	name: "Red heart",
	stickerId: "emoji:2764-fe0f",
};

function render(props: Partial<Parameters<typeof DraggableItem>[0]> = {}) {
	return renderToStaticMarkup(
		<DraggableItem
			name="Red heart"
			preview={<span data-testid="preview" />}
			dragData={DRAG_DATA}
			{...props}
		/>,
	);
}

describe("DraggableItem add button", () => {
	test("is named after the tile, so a screen reader hears what it adds", () => {
		expect(render()).toContain('aria-label="Add Red heart"');
	});

	test("shows when it has keyboard focus, not only on hover", () => {
		const html = render();
		expect(html).toContain("group-hover:opacity-100");
		expect(html).toContain("focus-visible:opacity-100");
	});

	test("is a real, focusable button", () => {
		expect(render()).toMatch(/<button[^>]*aria-label="Add Red heart"/);
	});

	test("every tile kind gets the label, because it is derived from the name", () => {
		expect(render({ name: "Kick drum.wav", shouldShowLabel: true })).toContain(
			'aria-label="Add Kick drum.wav"',
		);
	});
});

describe("DraggableItem tile title", () => {
	test("a tile without a visible label carries its name as a tooltip", () => {
		const html = render({ shouldShowLabel: false });
		expect(html).toContain('title="Red heart"');
	});

	test("a tile that shows its label does not repeat it as an extra tooltip on the wrapper", () => {
		const html = render({ shouldShowLabel: true });
		// The label span keeps its own title; the wrapper adds none.
		expect(html.match(/title="Red heart"/g)).toHaveLength(1);
		expect(html).toContain('<span class="sr-only">Red heart</span>');
	});

	test("the compact variant is unchanged: name as text, no add button", () => {
		const html = render({ variant: "compact" });
		expect(html).toContain("Red heart");
		expect(html).not.toContain("aria-label=");
	});
});
