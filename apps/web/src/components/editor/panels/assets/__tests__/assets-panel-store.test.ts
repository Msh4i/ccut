import { afterEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
import {
	TAB_KEYS,
	createAssetsPanelStore,
	getVisibleTabKeys,
	tabs,
	useAssetsPanelStore,
} from "../assets-panel-store";

/** An in-memory stand-in for the browser's localStorage, writing into `written`. */
function memoryLocalStorage({ written }: { written: Map<string, string> }) {
	// Frozen inline: the Storage API dictates these positional signatures.
	return Object.freeze({
		getItem: (key: string) => written.get(key) ?? null,
		setItem: (key: string, value: string) => void written.set(key, value),
		removeItem: (key: string) => void written.delete(key),
	});
}

describe("assets panel tab registry", () => {
	test("registers a tab definition for every tab key and nothing else", () => {
		expect(Object.keys(tabs).sort()).toEqual([...TAB_KEYS].sort());
	});

	test("every tab has an icon and a real, unique label", () => {
		const labels = TAB_KEYS.map((key) => tabs[key].label);

		for (const key of TAB_KEYS) {
			expect(typeof tabs[key].icon).toBe("function");
			expect(tabs[key].label.trim()).not.toBe("");
		}
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("opens on the first tab, so it is the fallback for a missing one", () => {
		expect(useAssetsPanelStore.getInitialState().activeTab).toBe(TAB_KEYS[0]);
	});
});

describe("assets panel persistence", () => {
	// A store of its own with an in-memory storage: the shared store is created
	// by whichever test file imports this module first (the order differs
	// between macOS and Linux), possibly before any window exists.
	test("never writes the active tab, so a removed tab cannot be restored", () => {
		const written = new Map<string, string>();
		const store = createAssetsPanelStore({
			storage: createJSONStorage(() => memoryLocalStorage({ written })),
		});
		const { setActiveTab, setMediaViewMode } = store.getState();
		setActiveTab(TAB_KEYS[TAB_KEYS.length - 1]);
		setMediaViewMode("list");

		const stored: unknown = JSON.parse(written.get("assets-panel") ?? "null");
		expect(stored).toMatchObject({ state: { mediaViewMode: "list" } });
		expect(stored).not.toMatchObject({
			state: { activeTab: expect.anything() },
		});
	});
});

describe("assets panel default storage", () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	afterEach(() => {
		if (originalWindow) {
			Object.defineProperty(globalThis, "window", originalWindow);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	});

	test("without a storage it persists to the browser's localStorage", () => {
		const written = new Map<string, string>();
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { localStorage: memoryLocalStorage({ written }) },
		});
		const store = createAssetsPanelStore();
		store.getState().setMediaViewMode("list");

		expect(JSON.parse(written.get("assets-panel") ?? "null")).toMatchObject({
			state: { mediaViewMode: "list" },
		});
	});
});

describe("assets panel tabs per build", () => {
	test("the hosted build shows every tab", () => {
		expect(getVisibleTabKeys({ isDesktop: false })).toEqual([...TAB_KEYS]);
	});

	test("the desktop build hides Sounds, whose online library it cannot reach", () => {
		const desktop = getVisibleTabKeys({ isDesktop: true });

		expect(desktop).not.toContain("sounds");
		expect(desktop).toEqual(TAB_KEYS.filter((key) => key !== "sounds"));
	});

	test("every visible tab has a definition, and the opening tab is visible in both builds", () => {
		for (const isDesktop of [true, false]) {
			const visible = getVisibleTabKeys({ isDesktop });

			for (const key of visible) expect(tabs[key]).toBeDefined();
			expect(visible).toContain(useAssetsPanelStore.getInitialState().activeTab);
		}
	});
});
