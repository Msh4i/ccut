import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
	DEFAULT_PERFORMANCE_MODE,
	type PerformanceMode,
	mergePersistedPerformance,
	parsePerformanceMode,
} from "./performance-mode";

/** A new key: no existing setting is read, rewritten or migrated. */
export const PERFORMANCE_STORAGE_KEY = "ccut-performance";

type PerformanceState = {
	mode: PerformanceMode;
	setMode: (mode: PerformanceMode) => void;
};

function browserStorage(): StateStorage {
	return window.localStorage;
}

/** The "Performance" setting of the app (all projects), kept in localStorage. */
export function createPerformanceStore({
	storage = browserStorage,
}: {
	storage?: () => StateStorage;
} = {}) {
	return create<PerformanceState>()(
		persist(
			(set) => ({
				mode: DEFAULT_PERFORMANCE_MODE,
				setMode: (mode) => set({ mode: parsePerformanceMode(mode) }),
			}),
			{
				name: PERFORMANCE_STORAGE_KEY,
				version: 1,
				storage: createJSONStorage(storage),
				partialize: (state) => ({ mode: state.mode }),
				merge: (persisted, current) => mergePersistedPerformance({ persisted, current }),
			},
		),
	);
}

export const usePerformanceStore = createPerformanceStore();
