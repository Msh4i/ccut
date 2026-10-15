import type { TimelineElement } from "@/timeline";
import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	type CameraTrackerRunOutcome,
	type CreateTrackedLayersOutcome,
} from "../session";
import type { CameraTrackerPhase } from "../types";
import type { Point2 } from "./delaunay";
import type { Selection } from "./selection";

/**
 * Pointer and keyboard decisions of the track points overlay (AE: click,
 * Shift-click, marquee, Alt lasso, right-click on the target, Delete).
 * Points are in canvas pixels; `screen` points (client pixels) only decide
 * when a press becomes a drag, so the threshold does not depend on zoom.
 */

/** A press becomes a drag (marquee or lasso) after moving this far on screen. */
export const DRAG_THRESHOLD_PX = 3;
/** The lasso records a new vertex after this much movement on screen. */
const LASSO_MIN_STEP_PX = 2;
/** Upper bound of the lasso path (memory and hit-test cost). */
export const LASSO_MAX_POINTS = 4000;

export type Gesture =
	| { kind: "idle" }
	| { kind: "press"; start: Point2; startScreen: Point2; shift: boolean; alt: boolean }
	| { kind: "marquee"; start: Point2; current: Point2; shift: boolean }
	| { kind: "lasso"; path: Point2[]; lastScreen: Point2; shift: boolean };

export type GestureEnd =
	| { kind: "none" }
	| { kind: "click"; at: Point2; shift: boolean }
	| { kind: "rect"; from: Point2; to: Point2; shift: boolean }
	| { kind: "polygon"; polygon: Point2[]; shift: boolean };

export function pressGesture({
	at,
	screen,
	shift,
	alt,
}: {
	at: Point2;
	screen: Point2;
	shift: boolean;
	alt: boolean;
}): Gesture {
	return { kind: "press", start: at, startScreen: screen, shift, alt };
}

function screenDistance({ a, b }: { a: Point2; b: Point2 }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dragGesture({
	gesture,
	at,
	screen,
}: {
	gesture: Gesture;
	at: Point2;
	screen: Point2;
}): Gesture {
	switch (gesture.kind) {
		case "idle":
			return gesture;
		case "press":
			if (screenDistance({ a: screen, b: gesture.startScreen }) < DRAG_THRESHOLD_PX) {
				return gesture;
			}
			return gesture.alt
				? { kind: "lasso", path: [gesture.start, at], lastScreen: screen, shift: gesture.shift }
				: { kind: "marquee", start: gesture.start, current: at, shift: gesture.shift };
		case "marquee":
			return { ...gesture, current: at };
		case "lasso":
			if (
				gesture.path.length >= LASSO_MAX_POINTS ||
				screenDistance({ a: screen, b: gesture.lastScreen }) < LASSO_MIN_STEP_PX
			) {
				return gesture;
			}
			return { ...gesture, path: [...gesture.path, at], lastScreen: screen };
	}
}

export function releaseGesture(gesture: Gesture): GestureEnd {
	switch (gesture.kind) {
		case "idle":
			return { kind: "none" };
		case "press":
			return { kind: "click", at: gesture.start, shift: gesture.shift };
		case "marquee":
			return { kind: "rect", from: gesture.start, to: gesture.current, shift: gesture.shift };
		case "lasso":
			return { kind: "polygon", polygon: gesture.path, shift: gesture.shift };
	}
}

/**
 * AE shows the target of the triangle under the pointer; the selection's
 * own target stays when the pointer is on it (so it can be dragged or
 * right-clicked) or when the triangle's points are all selected already.
 */
export function showHoverTarget({
	hoveredIds,
	selection,
	pointerInSelectionTarget,
}: {
	hoveredIds: readonly number[] | null;
	selection: Selection;
	pointerInSelectionTarget: boolean;
}): boolean {
	if (!hoveredIds || pointerInSelectionTarget) return false;
	return !hoveredIds.every((id) => selection.includes(id));
}

export type ContextMenuSubject =
	| { kind: "selection" }
	| { kind: "triangle"; trackIds: Selection };

/**
 * What a right-click opens the target menu for: the selection's target
 * under the pointer, else the hovered triangle (its points get selected
 * first, as in AE). `null`: the preview's own menu opens instead.
 */
export function contextMenuSubject({
	pointerInSelectionTarget,
	hoveredIds,
	selection,
}: {
	pointerInSelectionTarget: boolean;
	hoveredIds: readonly number[] | null;
	selection: Selection;
}): ContextMenuSubject | null {
	if (pointerInSelectionTarget && selection.length > 0) return { kind: "selection" };
	if (hoveredIds) return { kind: "triangle", trackIds: [...hoveredIds].sort((a, b) => a - b) };
	return null;
}

/**
 * Delete or Backspace with track points selected deletes the points (AE),
 * not the selected clip: the overlay takes the key before the editor's
 * shortcut does.
 */
export function pointKeyAction({
	key,
	hasSelection,
	isTyping,
	ctrl,
	meta,
	alt,
}: {
	key: string;
	hasSelection: boolean;
	isTyping: boolean;
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
}): "delete" | null {
	if (!hasSelection || isTyping || ctrl || meta || alt) return null;
	return key === "Delete" || key === "Backspace" ? "delete" : null;
}

/**
 * What to tell the user after a run or a layer creation. A failed solve is
 * shown by the banner and the Tracking tab (the engine records it), so it
 * gets no toast; a busy engine, a thrown error or a failed creation do.
 */
export function runFeedback({
	outcome,
	created,
	error,
}: {
	outcome?: CameraTrackerRunOutcome;
	created?: CreateTrackedLayersOutcome;
	error?: unknown;
}): { kind: "info" | "error"; message: string } | null {
	if (error !== undefined) {
		return {
			kind: "error",
			message:
				error instanceof Error && error.message
					? `Track Camera stopped: ${error.message}`
					: "Track Camera stopped.",
		};
	}
	if (outcome?.status === "busy") return { kind: "info", message: outcome.message };
	if (created?.status === "failed") return { kind: "error", message: created.message };
	return null;
}

export const TRACK_CAMERA_MESSAGES = {
	selectVideo: "Select one video clip to track the camera.",
	busy: "Track Camera is already running. Wait until it finishes.",
} as const;

/** The `track-camera` action (command palette, shortcut if the user binds one). */
export function trackCameraPlan({
	selected,
	apiReady,
	phase,
}: {
	selected: readonly TimelineElement[];
	apiReady: boolean;
	phase: CameraTrackerPhase;
}): { kind: "run"; elementId: string } | { kind: "message"; message: string } {
	if (!apiReady) return { kind: "message", message: CAMERA_TRACKER_NOT_READY_MESSAGE };
	if (selected.length !== 1 || selected[0].type !== "video") {
		return { kind: "message", message: TRACK_CAMERA_MESSAGES.selectVideo };
	}
	if (phase.phase !== "idle") return { kind: "message", message: TRACK_CAMERA_MESSAGES.busy };
	return { kind: "run", elementId: selected[0].id };
}
