import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { StemName } from "@/services/stems/types";
import {
	DEFAULT_STEM_CHOICE,
	mergePersistedChoice,
	parseMarkerMode,
	parseStem,
	type MarkerMode,
	type StemChoice,
} from "./stem-choice";

/** A new key: no existing setting is read, rewritten or migrated. */
export const STEM_CHOICE_STORAGE_KEY = "ccut-auto-hits";

type StemChoiceState = StemChoice & {
	setStem: (stem: StemName) => void;
	setMode: (mode: MarkerMode) => void;
};

function browserStorage(): StateStorage {
	return window.localStorage;
}

/** The sticky "Auto hits" choice of the app (all projects), kept in localStorage. */
export function createStemChoiceStore({
	storage = browserStorage,
}: {
	storage?: () => StateStorage;
} = {}) {
	return create<StemChoiceState>()(
		persist(
			(set) => ({
				...DEFAULT_STEM_CHOICE,
				setStem: (stem) => set({ stem: parseStem(stem) }),
				setMode: (mode) => set({ mode: parseMarkerMode(mode) }),
			}),
			{
				name: STEM_CHOICE_STORAGE_KEY,
				version: 1,
				storage: createJSONStorage(storage),
				partialize: (state) => ({ stem: state.stem, mode: state.mode }),
				merge: (persisted, current) => mergePersistedChoice({ persisted, current }),
			},
		),
	);
}

export const useStemChoiceStore = createStemChoiceStore();
