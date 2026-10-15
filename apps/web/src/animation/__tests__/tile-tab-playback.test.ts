import { describe, expect, test } from "bun:test";
import type { VisibilityEntry, VisibilityObserver } from "@/animation/tiles/playback-handle";
import { TilePlaybackStore } from "@/animation/tiles/playback";
import {
	createTabTilePlayback,
	isVisibleFocus,
	tileInteraction,
	tileOrderKey,
} from "@/animation/tiles/tab-playback";

function fakeEnvironment() {
	const observers: { report: (entries: VisibilityEntry[]) => void; disconnected: boolean }[] = [];
	let watching = 0;
	return {
		createObserver: (report: (entries: VisibilityEntry[]) => void): VisibilityObserver => {
			const record = { report, disconnected: false };
			observers.push(record);
			return {
				observe: () => {},
				unobserve: () => {},
				disconnect: () => {
					record.disconnected = true;
				},
			};
		},
		watchReducedMotion: (onChange: (reduced: boolean) => void) => {
			watching += 1;
			onChange(false);
			return () => {
				watching -= 1;
			};
		},
		observers,
		watching: () => watching,
	};
}

describe("createTabTilePlayback: the Animation tab's playback, without React", () => {
	test("mounting connects the observers; the cleanup disconnects them", () => {
		const environment = fakeEnvironment();
		const tab = createTabTilePlayback(environment);
		expect(environment.observers).toHaveLength(0);
		const unmount = tab.mount();
		expect(environment.observers).toHaveLength(1);
		expect(environment.watching()).toBe(1);
		unmount();
		expect(environment.observers[0].disconnected).toBe(true);
		expect(environment.watching()).toBe(0);
	});

	test("the tile order comes from the key, so a new element type re-plans", () => {
		const environment = fakeEnvironment();
		const tab = createTabTilePlayback(environment);
		const node = {};
		tab.handle.observe({ id: "in:typewriter", node });
		tab.syncOrder({ orderKey: tileOrderKey({ order: ["in:fade", "in:typewriter"] }) });
		tab.mount();
		environment.observers[0].report([{ target: node, isIntersecting: true, intersectionRatio: 1 }]);
		expect(tab.handle.store.getPlayback("in:typewriter")).toBe("loop");
		// A video has no typewriter tile.
		tab.syncOrder({ orderKey: tileOrderKey({ order: ["in:fade"] }) });
		expect(tab.handle.store.getPlayback("in:typewriter")).toBe("still");
		tab.syncOrder({ orderKey: tileOrderKey({ order: [] }) });
		expect(tab.handle.store.getPlayback("in:fade")).toBe("still");
	});

	test("the order key round-trips the ids", () => {
		expect(tileOrderKey({ order: ["in:fade", "out:fade"] })).not.toBe(tileOrderKey({ order: ["in:fade"] }));
		expect(tileOrderKey({ order: [] })).toBe("");
	});
});

describe("isVisibleFocus: keyboard focus, not a mouse click", () => {
	test("follows :focus-visible", () => {
		expect(isVisibleFocus({ target: { matches: (selector) => selector === ":focus-visible" } })).toBe(true);
		expect(isVisibleFocus({ target: { matches: () => false } })).toBe(false);
	});

	test("an engine without :focus-visible counts every focus, so keyboard users keep it", () => {
		expect(
			isVisibleFocus({
				target: {
					matches: () => {
						throw new SyntaxError("unknown pseudo-class");
					},
				},
			}),
		).toBe(true);
		expect(isVisibleFocus({ target: {} })).toBe(true);
	});
});

describe("tileInteraction: pointer and focus feed the store", () => {
	function setup() {
		const store = new TilePlaybackStore({ cap: 0 });
		store.setOrder({ order: ["in:fade"] });
		store.setVisible({ id: "in:fade", isVisible: true });
		return { store, handlers: tileInteraction({ store, id: "in:fade" }) };
	}
	const keyboard = { currentTarget: { matches: () => true } };
	const mouse = { currentTarget: { matches: () => false } };

	test("hovering plays the tile, leaving stops it", () => {
		const { store, handlers } = setup();
		handlers.onPointerEnter();
		expect(store.getPlayback("in:fade")).toBe("loop");
		handlers.onPointerLeave();
		expect(store.getPlayback("in:fade")).toBe("still");
	});

	test("keyboard focus plays the tile until it blurs", () => {
		const { store, handlers } = setup();
		handlers.onFocus(keyboard);
		expect(store.getPlayback("in:fade")).toBe("loop");
		handlers.onBlur();
		expect(store.getPlayback("in:fade")).toBe("still");
	});

	test("a mouse click's focus does not keep the tile looping after the pointer leaves", () => {
		const { store, handlers } = setup();
		handlers.onPointerEnter();
		handlers.onFocus(mouse);
		handlers.onPointerLeave();
		expect(store.getPlayback("in:fade")).toBe("still");
	});

	test("the None tile (no id) and a static render (no store) do nothing", () => {
		const store = new TilePlaybackStore({ cap: 0 });
		store.setOrder({ order: ["in:fade"] });
		for (const handlers of [
			tileInteraction({ store, id: null }),
			tileInteraction({ store: undefined, id: "in:fade" }),
		]) {
			handlers.onPointerEnter();
			handlers.onFocus(keyboard);
		}
		expect(store.getPlayback("in:fade")).toBe("still");
	});
});
