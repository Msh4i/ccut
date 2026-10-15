import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineDragData } from "@/timeline/drag";

// Every tile uses the same 1x1 transparent image as its drag ghost. It used to
// be created on every render of every tile (2,000 tiles on the Emoji tab).

mock.module("@/editor/use-editor", () => ({
	useEditor: () => ({
		playback: { getCurrentTime: () => 0 },
		timeline: { dragSource: { begin: () => {}, end: () => {} } },
	}),
}));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installWindowWithCountingImage() {
	const created: { src: string }[] = [];
	class CountingImage {
		src = "";
		constructor() {
			created.push(this);
		}
	}
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { Image: CountingImage },
	});
	return created;
}

afterEach(() => {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

describe("getEmptyDragImage", () => {
	test("creates the image once, however many tiles ask", async () => {
		const created = installWindowWithCountingImage();
		const { getEmptyDragImage } = await import(`../drag-image?once=${Math.random()}`);
		const first = getEmptyDragImage();
		for (let tile = 0; tile < 2000; tile++) {
			expect(getEmptyDragImage()).toBe(first);
		}
		expect(created).toHaveLength(1);
		expect(created[0].src).toStartWith("data:image/gif;base64,");
	});

	test("without a window (server render) it returns null and creates nothing", async () => {
		Reflect.deleteProperty(globalThis, "window");
		const { getEmptyDragImage } = await import(`../drag-image?server=${Math.random()}`);
		expect(getEmptyDragImage()).toBeNull();
	});

	test("a server that later gets a window still works (nothing was cached as null)", async () => {
		Reflect.deleteProperty(globalThis, "window");
		const { getEmptyDragImage } = await import(`../drag-image?late=${Math.random()}`);
		expect(getEmptyDragImage()).toBeNull();
		const created = installWindowWithCountingImage();
		expect(getEmptyDragImage()).not.toBeNull();
		expect(created).toHaveLength(1);
	});
});

describe("DraggableItem", () => {
	const dragData: TimelineDragData = { id: "emoji:1f600", type: "sticker", name: "Grinning face", stickerId: "emoji:1f600" };

	test("rendering a tile creates no Image at all", async () => {
		const created = installWindowWithCountingImage();
		const { DraggableItem } = await import("../draggable-item");
		for (let render = 0; render < 20; render++) {
			renderToStaticMarkup(<DraggableItem name="Grinning face" preview={<i />} dragData={dragData} shouldShowLabel={false} />);
		}
		expect(created).toHaveLength(0);
	});
});
