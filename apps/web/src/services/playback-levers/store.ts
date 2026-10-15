import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
	DEFAULT_PLAYBACK_LEVERS,
	type LeverKey,
	type PlaybackLevers,
	mergePersistedLevers,
} from "./levers";

/**
 * A key of its own: the Performance mode (`ccut-performance`) is neither read
 * nor rewritten, and an older build simply never looks here.
 */
export const PLAYBACK_LEVERS_STORAGE_KEY = "ccut-playback-levers";

type PlaybackLeversState = {
	levers: PlaybackLevers;
	setLever: (params: { key: LeverKey; on: boolean }) => void;
};

function browserStorage(): StateStorage {
	return window.localStorage;
}

/** The experimental playback levers of the app (all projects), kept in localStorage. */
export function createPlaybackLeversStore({
	storage = browserStorage,
}: {
	storage?: () => StateStorage;
} = {}) {
	return create<PlaybackLeversState>()(
		persist(
			(set) => ({
				levers: { ...DEFAULT_PLAYBACK_LEVERS },
				setLever: ({ key, on }) =>
					set((state) => ({ levers: { ...state.levers, [key]: on === true } })),
			}),
			{
				name: PLAYBACK_LEVERS_STORAGE_KEY,
				version: 1,
				storage: createJSONStorage(storage),
				partialize: (state) => ({ levers: state.levers }),
				merge: (persisted, current) => mergePersistedLevers({ persisted, current }),
			},
		),
	);
}

export const usePlaybackLeversStore = createPlaybackLeversStore();

/** For readers outside React (the renderer, the playback HUD). */
export function playbackLevers(): PlaybackLevers {
	return usePlaybackLeversStore.getState().levers;
}
