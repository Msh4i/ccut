import { create } from "zustand";
import type { SelectedKeyframeRef } from "@/animation/types";

/**
 * The keyframe curve menu: opened by a right click on any keyframe diamond
 * (timeline, toolbar, properties panel) and drawn once by `KeyframeCurveMenu`.
 */
export interface KeyframeCurveMenuRequest {
	/** Where the right click was, in viewport pixels. */
	x: number;
	y: number;
	trackId: string;
	elementId: string;
	/** The keyframes whose following segment the menu shapes (all on the same clip). */
	keyframes: SelectedKeyframeRef[];
}

interface KeyframeCurveMenuState {
	request: KeyframeCurveMenuRequest | null;
	open: (request: KeyframeCurveMenuRequest) => void;
	close: () => void;
}

export const useKeyframeCurveMenuStore = create<KeyframeCurveMenuState>()(
	(set) => ({
		request: null,
		open: (request) => set({ request }),
		close: () => set({ request: null }),
	}),
);
