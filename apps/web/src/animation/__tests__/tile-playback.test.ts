import { describe, expect, test } from "bun:test";
import {
	TILE_ANIMATION_CAP,
	TILE_STILL_PROGRESS,
	TilePlaybackStore,
	planTilePlayback,
	type TilePlayback,
} from "@/animation/tiles/playback";

const ORDER = ["in:a", "in:b", "in:c", "in:d", "in:e", "out:a", "out:b"];

function plan({
	visible = ORDER,
	hovered = null,
	focused = null,
	reducedMotion = false,
	cap = 4,
	order = ORDER,
}: {
	visible?: string[];
	hovered?: string | null;
	focused?: string | null;
	reducedMotion?: boolean;
	cap?: number;
	order?: string[];
}) {
	return planTilePlayback({
		order,
		visible: new Set(visible),
		hovered,
		focused,
		reducedMotion,
		cap,
	});
}

function playing({
	result,
	kind = "loop",
}: {
	result: Map<string, TilePlayback>;
	kind?: TilePlayback;
}): string[] {
	return [...result].filter(([, playback]) => playback === kind).map(([id]) => id);
}

describe("planTilePlayback: which tiles animate", () => {
	test("the cap is 4 and the still frame is half way", () => {
		expect(TILE_ANIMATION_CAP).toBe(4);
		expect(TILE_STILL_PROGRESS).toBe(0.5);
	});

	test("with nothing hovered, the first visible tiles in order loop, up to the cap", () => {
		const result = plan({});
		expect(playing({ result })).toEqual(["in:a", "in:b", "in:c", "in:d"]);
		expect(playing({ result, kind: "still" })).toEqual(["in:e", "out:a", "out:b"]);
	});

	test("every tile in the order gets an answer, and nothing else does", () => {
		const result = plan({ visible: [...ORDER, "ghost"], hovered: "ghost", focused: "ghost" });
		expect([...result.keys()]).toEqual(ORDER);
	});

	test("only visible tiles loop on their own, in document order whatever order they became visible in", () => {
		const result = plan({ visible: ["out:b", "in:e", "in:b"] });
		expect(playing({ result })).toEqual(["in:b", "in:e", "out:b"]);
	});

	test("the hovered tile always animates and takes one of the slots", () => {
		const result = plan({ hovered: "out:a" });
		expect(playing({ result })).toEqual(["in:a", "in:b", "in:c", "out:a"]);
	});

	test("the hovered tile animates even when it is not reported visible", () => {
		const result = plan({ visible: ["in:a"], hovered: "out:b" });
		expect(playing({ result })).toEqual(["in:a", "out:b"]);
	});

	test("the focused tile animates while it is visible", () => {
		expect(playing({ result: plan({ focused: "in:e" }) })).toEqual(["in:a", "in:b", "in:c", "in:e"]);
	});

	test("a focused tile that scrolled away (or whose panel is hidden) stops", () => {
		expect(playing({ result: plan({ visible: ["in:a"], focused: "out:b" }) })).toEqual(["in:a"]);
	});

	test("hovered and focused both animate, the rest fill the cap", () => {
		expect(playing({ result: plan({ hovered: "out:b", focused: "in:e" }) })).toEqual([
			"in:a",
			"in:b",
			"in:e",
			"out:b",
		]);
	});

	test("the same tile hovered and focused counts once", () => {
		expect(playing({ result: plan({ hovered: "in:e", focused: "in:e" }) })).toEqual([
			"in:a",
			"in:b",
			"in:c",
			"in:e",
		]);
	});

	test("hovered and focused animate even past the cap", () => {
		expect(playing({ result: plan({ cap: 1, hovered: "in:d", focused: "in:e" }) })).toEqual(["in:d", "in:e"]);
		expect(playing({ result: plan({ cap: 0, hovered: "in:d" }) })).toEqual(["in:d"]);
	});

	test("a cap of 0 animates nothing on its own", () => {
		expect(playing({ result: plan({ cap: 0 }) })).toEqual([]);
	});

	test("a broken cap is read safely", () => {
		expect(playing({ result: plan({ cap: Number.NaN }) })).toEqual([]);
		expect(playing({ result: plan({ cap: -3 }) })).toEqual([]);
		expect(playing({ result: plan({ cap: 2.7 }) })).toEqual(["in:a", "in:b"]);
		expect(playing({ result: plan({ cap: Number.POSITIVE_INFINITY }) })).toEqual([]);
	});

	test("nothing visible and nothing hovered: everything is still", () => {
		expect(playing({ result: plan({ visible: [] }), kind: "still" })).toEqual(ORDER);
	});
});

describe("planTilePlayback with reduced motion", () => {
	test("nothing loops, not even visible tiles", () => {
		const result = plan({ reducedMotion: true });
		expect(playing({ result })).toEqual([]);
		expect(playing({ result, kind: "still" })).toEqual(ORDER);
	});

	test("the hovered tile plays once", () => {
		const result = plan({ reducedMotion: true, hovered: "in:c" });
		expect(playing({ result, kind: "once" })).toEqual(["in:c"]);
		expect(playing({ result })).toEqual([]);
	});

	test("the focused (visible) tile plays once", () => {
		expect(playing({ result: plan({ reducedMotion: true, focused: "out:a" }), kind: "once" })).toEqual(["out:a"]);
	});
});

describe("TilePlaybackStore", () => {
	function createStore() {
		const store = new TilePlaybackStore({ cap: 2 });
		store.setOrder({ order: ["a", "b", "c"] });
		let notified = 0;
		store.subscribe(() => {
			notified += 1;
		});
		return { store, notifications: () => notified };
	}

	test("a tile nobody has seen yet is still", () => {
		const { store } = createStore();
		expect(store.getPlayback("a")).toBe("still");
		expect(store.getPlayback("unknown")).toBe("still");
	});

	test("visibility starts the loops, up to the cap", () => {
		const { store } = createStore();
		for (const id of ["a", "b", "c"]) store.setVisible({ id, isVisible: true });
		expect(["a", "b", "c"].map((id) => store.getPlayback(id))).toEqual(["loop", "loop", "still"]);
		store.setVisible({ id: "a", isVisible: false });
		expect(["a", "b", "c"].map((id) => store.getPlayback(id))).toEqual(["still", "loop", "loop"]);
	});

	test("listeners hear about changes of the plan only", () => {
		const { store, notifications } = createStore();
		store.setVisible({ id: "a", isVisible: true });
		expect(notifications()).toBe(1);
		store.setVisible({ id: "a", isVisible: true });
		store.setVisible({ id: "c", isVisible: false });
		expect(notifications()).toBe(1);
		store.setVisible({ id: "b", isVisible: true });
		store.setVisible({ id: "c", isVisible: true });
		// c is visible but over the cap: the plan did not change.
		expect(notifications()).toBe(2);
	});

	test("a leave from another tile does not clear the hovered one", () => {
		const { store } = createStore();
		store.setHovered({ id: "c", isHovered: true });
		store.setHovered({ id: "a", isHovered: false });
		expect(store.getPlayback("c")).toBe("loop");
		store.setHovered({ id: "c", isHovered: false });
		expect(store.getPlayback("c")).toBe("still");
	});

	test("focus works the same way", () => {
		const { store } = createStore();
		store.setVisible({ id: "c", isVisible: true });
		store.setFocused({ id: "c", isFocused: true });
		store.setFocused({ id: "b", isFocused: false });
		expect(store.getPlayback("c")).toBe("loop");
		store.setFocused({ id: "c", isFocused: false });
		expect(store.getPlayback("c")).toBe("loop");
		store.setVisible({ id: "c", isVisible: false });
		expect(store.getPlayback("c")).toBe("still");
	});

	test("reduced motion turns loops into a single play on hover", () => {
		const { store } = createStore();
		store.setVisible({ id: "a", isVisible: true });
		store.setHovered({ id: "b", isHovered: true });
		store.setReducedMotion({ reducedMotion: true });
		expect(store.getPlayback("a")).toBe("still");
		expect(store.getPlayback("b")).toBe("once");
		store.setReducedMotion({ reducedMotion: false });
		expect(store.getPlayback("a")).toBe("loop");
	});

	test("a tile that goes away is forgotten: hovered, focused and visible", () => {
		const { store } = createStore();
		store.setVisible({ id: "a", isVisible: true });
		store.setHovered({ id: "a", isHovered: true });
		store.setFocused({ id: "a", isFocused: true });
		store.forget({ id: "a" });
		store.setOrder({ order: ["a", "b", "c"] });
		expect(store.getPlayback("a")).toBe("still");
	});

	test("a new order (another element type) re-plans", () => {
		const { store } = createStore();
		for (const id of ["a", "b", "c"]) store.setVisible({ id, isVisible: true });
		store.setOrder({ order: ["c", "b", "a"] });
		expect(["a", "b", "c"].map((id) => store.getPlayback(id))).toEqual(["still", "loop", "loop"]);
	});

	test("unsubscribed listeners hear nothing", () => {
		const store = new TilePlaybackStore({ cap: 2 });
		store.setOrder({ order: ["a"] });
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});
		unsubscribe();
		unsubscribe();
		store.setVisible({ id: "a", isVisible: true });
		expect(calls).toBe(0);
		expect(store.getPlayback("a")).toBe("loop");
	});
});

describe("TilePlaybackStore: pause all", () => {
	function setup() {
		const store = new TilePlaybackStore({ cap: 4 });
		store.setOrder({ order: ORDER });
		for (const id of ORDER) store.setVisible({ id, isVisible: true });
		return store;
	}
	const modes = (store: TilePlaybackStore) => ORDER.map((id) => store.getPlayback(id));

	test("paused: no tile loops on its own; hover and focus play one pass; resuming loops again", () => {
		const store = setup();
		expect(modes(store).filter((mode) => mode === "loop")).toHaveLength(4);
		store.setPaused({ paused: true });
		expect(modes(store).every((mode) => mode === "still")).toBe(true);
		store.setHovered({ id: "in:c", isHovered: true });
		expect(store.getPlayback("in:c")).toBe("once");
		expect(store.getPlayback("in:a")).toBe("still");
		store.setHovered({ id: "in:c", isHovered: false });
		store.setPaused({ paused: false });
		expect(modes(store).filter((mode) => mode === "loop")).toHaveLength(4);
	});

	test("subscribers hear a pause change even when every tile was already still; a repeated value is silent", () => {
		const store = new TilePlaybackStore({ cap: 4 });
		let heard = 0;
		store.subscribe(() => {
			heard += 1;
		});
		store.setPaused({ paused: true });
		expect(heard).toBe(1);
		expect(store.getPaused()).toBe(true);
		store.setPaused({ paused: true });
		expect(heard).toBe(1);
	});
});
