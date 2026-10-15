import { describe, expect, test } from "bun:test";
import type { StateStorage } from "zustand/middleware";
import {
	DEFAULT_STEM_CHOICE,
	mergePersistedChoice,
	stemChoiceLabel,
} from "../stem-choice";
import { STEM_CHOICE_STORAGE_KEY, createStemChoiceStore } from "../stem-choice-store";

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

describe("the sticky Auto hits choice", () => {
	test("starts on drums / every hit, and a change is stored under its own new key only", () => {
		const { storage, values } = memoryStorage({ "other-setting": "{}" });
		const store = createStemChoiceStore({ storage: () => storage });
		expect(store.getState().stem).toBe("drums");
		expect(store.getState().mode).toBe("hits");
		store.getState().setStem("vocals");
		store.getState().setMode("beats");
		expect([...values.keys()].sort()).toEqual([STEM_CHOICE_STORAGE_KEY, "other-setting"]);
		expect(JSON.parse(values.get(STEM_CHOICE_STORAGE_KEY) ?? "null")).toEqual({
			state: { stem: "vocals", mode: "beats" },
			version: 1,
		});
	});

	test("the choice survives a restart: a new store reads what the old one wrote", () => {
		const { storage } = memoryStorage();
		const first = createStemChoiceStore({ storage: () => storage });
		first.getState().setStem("bass");
		const second = createStemChoiceStore({ storage: () => storage });
		expect(second.getState().stem).toBe("bass");
		expect(second.getState().mode).toBe("hits");
	});

	test("an unknown or hand-edited value never reaches the detector, one bad field keeps the other", () => {
		expect(
			mergePersistedChoice({ persisted: { stem: "guitar", mode: "beats" }, current: DEFAULT_STEM_CHOICE }),
		).toEqual({ stem: "drums", mode: "beats" });
		expect(mergePersistedChoice({ persisted: "junk", current: DEFAULT_STEM_CHOICE })).toEqual(DEFAULT_STEM_CHOICE);
		const broken = memoryStorage({ [STEM_CHOICE_STORAGE_KEY]: "{not json" });
		expect(createStemChoiceStore({ storage: () => broken.storage }).getState().stem).toBe("drums");
	});

	test("the button names the current stem and what it marks", () => {
		expect(stemChoiceLabel({ choice: { stem: "drums", mode: "hits" } })).toBe("Auto hits: Drums");
		expect(stemChoiceLabel({ choice: { stem: "other", mode: "beats" } })).toBe("Auto beat grid: Other");
	});
});
