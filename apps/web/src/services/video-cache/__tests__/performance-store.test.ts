import { describe, expect, test } from "bun:test";
import type { StateStorage } from "zustand/middleware";
import { PERFORMANCE_STORAGE_KEY, createPerformanceStore } from "../performance-store";

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const storage: StateStorage = {
		getItem: (name) => values.get(name) ?? null,
		// Mirrors the Storage signature: setItem(name, value).
		setItem: (...[name, value]: [string, string]) => {
			values.set(name, value);
		},
		removeItem: (name) => {
			values.delete(name);
		},
	};
	return { storage, values };
}

describe("performance store", () => {
	test("defaults to high and stores a choice under its own new key only", () => {
		const { storage, values } = memoryStorage({ "assets-panel": "{\"state\":{}}" });
		const store = createPerformanceStore({ storage: () => storage });
		expect(store.getState().mode).toBe("high");
		store.getState().setMode("balanced");
		expect(store.getState().mode).toBe("balanced");
		expect([...values.keys()].sort()).toEqual(["assets-panel", PERFORMANCE_STORAGE_KEY]);
		expect(values.get("assets-panel")).toBe("{\"state\":{}}");
		expect(JSON.parse(values.get(PERFORMANCE_STORAGE_KEY) ?? "null")).toEqual({
			state: { mode: "balanced" },
			version: 1,
		});
	});

	test("a stored choice is read back; an unreadable one is the default (high)", () => {
		const stored = memoryStorage({
			[PERFORMANCE_STORAGE_KEY]: JSON.stringify({ state: { mode: "balanced" }, version: 1 }),
		});
		expect(createPerformanceStore({ storage: () => stored.storage }).getState().mode).toBe("balanced");
		const broken = memoryStorage({
			[PERFORMANCE_STORAGE_KEY]: JSON.stringify({ state: { mode: "warp" }, version: 1 }),
		});
		expect(createPerformanceStore({ storage: () => broken.storage }).getState().mode).toBe("high");
	});

	test("no storage at all (tests, server render) still works in memory", () => {
		const store = createPerformanceStore({
			storage: () => {
				throw new Error("localStorage is not available");
			},
		});
		store.getState().setMode("high");
		expect(store.getState().mode).toBe("high");
	});
});
