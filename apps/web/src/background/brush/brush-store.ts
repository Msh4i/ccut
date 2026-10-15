import { create } from "zustand";
import type { BrushMode } from "./types";

/** The brush the owner holds while painting a cutout in the preview (not saved with the project). */
type BrushState = {
	/** Painting is on: the preview shows the brush instead of the transform handles. */
	active: boolean;
	mode: BrushMode;
	/** Share of the source width. */
	radius: number;
	hardness: number;
	feather: number;
	set: (patch: Partial<Omit<BrushState, "set">>) => void;
};

export const useBrushStore = create<BrushState>()((set) => ({
	active: false,
	mode: "remove",
	radius: 0.04,
	hardness: 0.8,
	feather: 0.2,
	set: (patch) => set(patch),
}));
