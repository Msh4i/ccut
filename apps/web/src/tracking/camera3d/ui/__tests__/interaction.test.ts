import { describe, expect, test } from "bun:test";
import { projectToCanvas } from "@/scene3d/camera";
import type { Target, Vec3, ViewCamera } from "@/scene3d/types";
import type { ImageElement, TimelineElement, VideoElement } from "@/timeline";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { CAMERA_TRACKER_NOT_READY_MESSAGE } from "../../session";
import {
	DRAG_THRESHOLD_PX,
	LASSO_MAX_POINTS,
	contextMenuSubject,
	dragGesture,
	pointKeyAction,
	pressGesture,
	releaseGesture,
	runFeedback,
	showHoverTarget,
	trackCameraPlan,
	TRACK_CAMERA_MESSAGES,
} from "../interaction";
import { movedTargetCenter, targetMoveOffset, targetWithCenter } from "../target";

describe("pointer gestures", () => {
	const press = pressGesture({ at: { x: 100, y: 100 }, screen: { x: 10, y: 10 }, shift: false, alt: false });

	test("a press released without moving is a click at the press point", () => {
		expect(releaseGesture(press)).toEqual({ kind: "click", at: { x: 100, y: 100 }, shift: false });
		const small = dragGesture({ gesture: press, at: { x: 101, y: 101 }, screen: { x: 10 + DRAG_THRESHOLD_PX - 1, y: 10 } });
		expect(releaseGesture(small).kind).toBe("click");
	});

	test("moving past the threshold starts a marquee; release gives the rectangle", () => {
		const moved = dragGesture({ gesture: press, at: { x: 140, y: 90 }, screen: { x: 30, y: 8 } });
		expect(moved.kind).toBe("marquee");
		const further = dragGesture({ gesture: moved, at: { x: 160, y: 130 }, screen: { x: 40, y: 20 } });
		expect(releaseGesture(further)).toEqual({ kind: "rect", from: { x: 100, y: 100 }, to: { x: 160, y: 130 }, shift: false });
	});

	test("Alt at the press makes it a lasso; the path closes into a polygon", () => {
		const altPress = pressGesture({ at: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, shift: true, alt: true });
		let gesture = dragGesture({ gesture: altPress, at: { x: 10, y: 0 }, screen: { x: 10, y: 0 } });
		expect(gesture.kind).toBe("lasso");
		gesture = dragGesture({ gesture, at: { x: 10, y: 10 }, screen: { x: 10, y: 10 } });
		gesture = dragGesture({ gesture, at: { x: 10.5, y: 10 }, screen: { x: 10.5, y: 10 } });
		gesture = dragGesture({ gesture, at: { x: 0, y: 10 }, screen: { x: 0, y: 10 } });
		expect(releaseGesture(gesture)).toEqual({
			kind: "polygon",
			polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
			shift: true,
		});
	});

	test("the lasso path is bounded", () => {
		let gesture = pressGesture({ at: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, shift: false, alt: true });
		for (let i = 1; i <= LASSO_MAX_POINTS + 50; i++) {
			gesture = dragGesture({ gesture, at: { x: i * 5, y: 0 }, screen: { x: i * 5, y: 0 } });
		}
		const end = releaseGesture(gesture);
		expect(end.kind === "polygon" ? end.polygon.length : 0).toBe(LASSO_MAX_POINTS);
	});

	test("idle stays idle", () => {
		expect(dragGesture({ gesture: { kind: "idle" }, at: { x: 1, y: 1 }, screen: { x: 1, y: 1 } })).toEqual({ kind: "idle" });
		expect(releaseGesture({ kind: "idle" })).toEqual({ kind: "none" });
	});
});

describe("which target shows, and what a right-click opens", () => {
	test("the hovered triangle's target replaces the selection's, unless the pointer is on the selection's target or the triangle is already selected", () => {
		expect(showHoverTarget({ hoveredIds: [1, 2, 3], selection: [], pointerInSelectionTarget: false })).toBe(true);
		expect(showHoverTarget({ hoveredIds: [1, 2, 3], selection: [4], pointerInSelectionTarget: true })).toBe(false);
		expect(showHoverTarget({ hoveredIds: [1, 2, 3], selection: [1, 2, 3, 9], pointerInSelectionTarget: false })).toBe(false);
		expect(showHoverTarget({ hoveredIds: null, selection: [], pointerInSelectionTarget: false })).toBe(false);
	});

	test("right-click: the selection's target, else a hovered triangle (selected first), else the preview's own menu", () => {
		expect(contextMenuSubject({ pointerInSelectionTarget: true, hoveredIds: [1, 2, 3], selection: [5] })).toEqual({ kind: "selection" });
		expect(contextMenuSubject({ pointerInSelectionTarget: false, hoveredIds: [3, 1, 2], selection: [5] })).toEqual({ kind: "triangle", trackIds: [1, 2, 3] });
		expect(contextMenuSubject({ pointerInSelectionTarget: false, hoveredIds: null, selection: [5] })).toBeNull();
		expect(contextMenuSubject({ pointerInSelectionTarget: true, hoveredIds: null, selection: [] })).toBeNull();
	});
});

describe("keys while track points are selected", () => {
	const base = { hasSelection: true, isTyping: false, ctrl: false, meta: false, alt: false };
	test("Delete and Backspace delete the points instead of the clip", () => {
		expect(pointKeyAction({ ...base, key: "Delete" })).toBe("delete");
		expect(pointKeyAction({ ...base, key: "Backspace" })).toBe("delete");
	});
	test("not without a selection, while typing, with modifiers, or for other keys", () => {
		expect(pointKeyAction({ ...base, key: "Delete", hasSelection: false })).toBeNull();
		expect(pointKeyAction({ ...base, key: "Delete", isTyping: true })).toBeNull();
		expect(pointKeyAction({ ...base, key: "Delete", ctrl: true })).toBeNull();
		expect(pointKeyAction({ ...base, key: "Backspace", meta: true })).toBeNull();
		expect(pointKeyAction({ ...base, key: "Delete", alt: true })).toBeNull();
		expect(pointKeyAction({ ...base, key: "x" })).toBeNull();
	});
});

describe("the track-camera action", () => {
	const video: VideoElement = {
		id: "v", type: "video", name: "v", mediaId: "m", startTime: ZERO_MEDIA_TIME, duration: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME, trimEnd: ZERO_MEDIA_TIME, params: {},
	};
	const image: ImageElement = { ...video, id: "i", type: "image" };
	const idle = { phase: "idle" } as const;
	const plan = ({
		selected,
		apiReady = true,
		phase = idle,
	}: {
		selected: TimelineElement[];
		apiReady?: boolean;
		phase?: Parameters<typeof trackCameraPlan>[0]["phase"];
	}) => trackCameraPlan({ selected, apiReady, phase });

	test("runs on the one selected video clip", () => {
		expect(plan({ selected: [video] })).toEqual({ kind: "run", elementId: "v" });
	});
	test("explains why it cannot run", () => {
		expect(plan({ selected: [video], apiReady: false })).toEqual({ kind: "message", message: CAMERA_TRACKER_NOT_READY_MESSAGE });
		expect(plan({ selected: [] })).toEqual({ kind: "message", message: TRACK_CAMERA_MESSAGES.selectVideo });
		expect(plan({ selected: [image] })).toEqual({ kind: "message", message: TRACK_CAMERA_MESSAGES.selectVideo });
		expect(plan({ selected: [video, video] })).toEqual({ kind: "message", message: TRACK_CAMERA_MESSAGES.selectVideo });
		expect(plan({ selected: [video], phase: { phase: "analyzing", elementId: "x", progress: 0 } })).toEqual({
			kind: "message",
			message: TRACK_CAMERA_MESSAGES.busy,
		});
	});
});

describe("feedback after a run", () => {
	test("solved, failed (the banner and tab show it) and cancelled: no toast", () => {
		expect(runFeedback({ outcome: { status: "solved", elementId: "v" } })).toBeNull();
		expect(runFeedback({ outcome: { status: "failed", elementId: "v", message: "No." } })).toBeNull();
		expect(runFeedback({ outcome: { status: "cancelled", elementId: "v" } })).toBeNull();
	});
	test("busy: tell the user; a thrown error: an error toast with its message", () => {
		expect(runFeedback({ outcome: { status: "busy", elementId: "v", message: "Busy." } })).toEqual({ kind: "info", message: "Busy." });
		expect(runFeedback({ error: new Error("decoder lost") })).toEqual({ kind: "error", message: "Track Camera stopped: decoder lost" });
		expect(runFeedback({ error: "weird" })).toEqual({ kind: "error", message: "Track Camera stopped." });
	});
	test("layer creation: a failure is an error toast", () => {
		expect(runFeedback({ created: { status: "failed", message: "No room." } })).toEqual({ kind: "error", message: "No room." });
		expect(runFeedback({ created: { status: "created", elementIds: ["a"], cameraElementId: null } })).toBeNull();
	});
});

describe("moving the target along its plane", () => {
	const view: ViewCamera = {
		kind: "tracked", rotation: [1, 0, 0, 0], position: [0, -300, -1000], focalPx: 1000,
		frameWidth: 1920, frameHeight: 1080, frameToCanvas: [0.5, 0, 0, 0, 0.5, 0],
	};
	const center: Vec3 = [100, 200, 600];
	const normal: Vec3 = [0, -1, 0];
	const target: Target = { center, normal, radius: 40 };
	const canvasOf = (point: Vec3) => {
		const projected = projectToCanvas({ view, point });
		if (!projected) throw new Error("behind");
		return projected;
	};

	test("the grabbed point follows the pointer; the centre keeps its offset and stays on the plane", () => {
		const grab = canvasOf([120, 200, 610]);
		const offset = targetMoveOffset({ target, view, canvasPoint: grab });
		expect(offset).not.toBeNull();
		if (!offset) return;
		expect(offset[0]).toBeCloseTo(-20, 6);
		expect(offset[2]).toBeCloseTo(-10, 6);
		const moved = movedTargetCenter({ target, view, canvasPoint: canvasOf([320, 200, 910]), offset });
		expect(moved).not.toBeNull();
		if (!moved) return;
		expect(moved[0]).toBeCloseTo(300, 6);
		expect(moved[1]).toBeCloseTo(200, 6);
		expect(moved[2]).toBeCloseTo(900, 6);
	});

	test("a pointer above the horizon misses the floor: no move", () => {
		expect(movedTargetCenter({ target, view, canvasPoint: { x: 480, y: 0 }, offset: [0, 0, 0] })).toBeNull();
		expect(targetMoveOffset({ target, view, canvasPoint: { x: 480, y: 0 } })).toBeNull();
	});

	test("targetWithCenter keeps the plane and recomputes the radius at the new distance", () => {
		const moved = targetWithCenter({ target, center: [100, 200, 2600], camera: view, targetSize: 100 });
		expect(moved?.normal).toEqual(normal);
		expect(moved?.center).toEqual([100, 200, 2600]);
		const near = targetWithCenter({ target, center, camera: view, targetSize: 100 });
		expect(moved && near ? moved.radius > near.radius : false).toBe(true);
		expect(targetWithCenter({ target, center: view.position, camera: view, targetSize: 100 })).toBeNull();
	});
});
