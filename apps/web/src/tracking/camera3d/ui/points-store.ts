import { create } from "zustand";
import type { Vec3 } from "@/scene3d/types";
import type { Selection } from "./selection";

/**
 * UI state of the track points overlay (not saved, not undoable, like AE's
 * point selection): which clip's points are selected and where the user
 * dragged the selection's target.
 */
interface CameraPointsState {
	elementId: string | null;
	selection: Selection;
	/** The selection's target centre after a drag (world); `null` = the centroid. */
	centerOverride: Vec3 | null;
	select(args: { elementId: string; selection: Selection }): void;
	moveTarget(args: { center: Vec3 }): void;
	/** Back to the centroid (the solve's world changed: re-solve, Set Ground Plane and Origin). */
	resetTargetCenter(): void;
	/** The selection when it belongs to `elementId`, else none. */
	selectionFor(args: { elementId: string }): Selection;
	clear(): void;
}

const EMPTY: Selection = [];

function sameIds({ a, b }: { a: Selection; b: Selection }): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

export const useCameraPointsStore = create<CameraPointsState>()((set, get) => ({
	elementId: null,
	selection: EMPTY,
	centerOverride: null,
	select: ({ elementId, selection }) =>
		set((state) => {
			const unchanged =
				state.elementId === elementId && sameIds({ a: state.selection, b: selection });
			if (unchanged) return state;
			return { elementId, selection, centerOverride: null };
		}),
	moveTarget: ({ center }) => set({ centerOverride: center }),
	resetTargetCenter: () =>
		set((state) => (state.centerOverride === null ? state : { centerOverride: null })),
	selectionFor: ({ elementId }) => {
		const state = get();
		return state.elementId === elementId ? state.selection : EMPTY;
	},
	clear: () => set({ elementId: null, selection: EMPTY, centerOverride: null }),
}));
