import { describe, expect, test } from "bun:test";
import type { StateStorage } from "zustand/middleware";
import { DEFAULT_PLAYBACK_LEVERS, parseLevers } from "../levers";
import { PLAYBACK_LEVERS_STORAGE_KEY, createPlaybackLeversStore } from "../store";

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const storage: StateStorage = {
		getItem: (name) => values.get(name) ?? null,
		setItem: (...[name, value]: [string, string]) => {
			values.set(name, value);
		},
		removeItem: (name) => {
			values.delete(name);
		},
	};
	return { storage, values };
}

const stored = (state: unknown) =>
	memoryStorage({ [PLAYBACK_LEVERS_STORAGE_KEY]: JSON.stringify({ state, version: 1 }) });

describe("parseLevers", () => {
	test("only an exact true turns a lever on; everything else is off", () => {
		expect(parseLevers({ decodeWorker: true, bitmapUpload: false, displayResolution: true })).toEqual({
			decodeWorker: true,
			bitmapUpload: false,
			displayResolution: true,
		});
		for (const value of [undefined, null, 1, "true", "yes", {}, [true], 0]) {
			expect(parseLevers({ decodeWorker: value, bitmapUpload: value, displayResolution: value })).toEqual(
				DEFAULT_PLAYBACK_LEVERS,
			);
		}
		for (const levers of [undefined, null, "on", 7, true]) {
			expect(parseLevers(levers)).toEqual(DEFAULT_PLAYBACK_LEVERS);
		}
	});
});

describe("playback levers store", () => {
	test("all off by default; a switch is stored under its own key, nothing else is written", () => {
		const { storage, values } = memoryStorage({ "ccut-performance": "{\"state\":{\"mode\":\"high\"},\"version\":1}" });
		const store = createPlaybackLeversStore({ storage: () => storage });
		expect(store.getState().levers).toEqual(DEFAULT_PLAYBACK_LEVERS);
		store.getState().setLever({ key: "displayResolution", on: true });
		expect(store.getState().levers).toEqual({ ...DEFAULT_PLAYBACK_LEVERS, displayResolution: true });
		expect(values.get("ccut-performance")).toBe("{\"state\":{\"mode\":\"high\"},\"version\":1}");
		expect(JSON.parse(values.get(PLAYBACK_LEVERS_STORAGE_KEY) ?? "null")).toEqual({
			state: { levers: { ...DEFAULT_PLAYBACK_LEVERS, displayResolution: true } },
			version: 1,
		});
	});

	test("stored levers are read back; partial, garbage or missing data reads as off", () => {
		const on = { decodeWorker: true, bitmapUpload: true, displayResolution: true };
		expect(createPlaybackLeversStore({ storage: () => stored({ levers: on }).storage }).getState().levers).toEqual(on);
		expect(
			createPlaybackLeversStore({ storage: () => stored({ levers: { displayResolution: "1" } }).storage }).getState()
				.levers,
		).toEqual(DEFAULT_PLAYBACK_LEVERS);
		expect(
			createPlaybackLeversStore({ storage: () => stored({ levers: { bitmapUpload: true } }).storage }).getState()
				.levers,
		).toEqual({ ...DEFAULT_PLAYBACK_LEVERS, bitmapUpload: true });
		expect(createPlaybackLeversStore({ storage: () => stored({}).storage }).getState().levers).toEqual(
			DEFAULT_PLAYBACK_LEVERS,
		);
		const broken = memoryStorage({ [PLAYBACK_LEVERS_STORAGE_KEY]: "not json" });
		expect(createPlaybackLeversStore({ storage: () => broken.storage }).getState().levers).toEqual(
			DEFAULT_PLAYBACK_LEVERS,
		);
	});
});
