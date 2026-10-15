/**
 * Ctrl+Z around a stick and an Unstick (T4 review): the pin record is session
 * state and outlives the undo, but the element is stuck only while it has the
 * pin's keys. The undo is the real one (CommandManager and TimelineManager over
 * a stand-in for the scene); the section's view (`pinViewFor`, the function the
 * hook calls) and the preview controllers' `isPinned` are asked afterwards.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ScalarAnimationKey } from "@/animation/types";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { TimelineManager } from "@/core/managers/timeline-manager";
import { cameraPinOps } from "@/preview/camera-pin-ops";
import type { SceneTracks, TextElement, VideoElement } from "@/timeline";
import { findElementInTracks } from "@/tracking/host";
import { mediaTime } from "@/wasm";
import { IDLE_CAMERA_JOB, type CameraPinOutcome } from "../analysis-types";
import { CAMERA_PIN_PATHS, type CameraPinKeys } from "../pin-animations";
import { hostStateOf, type CameraPinRecord, type PinScene } from "../pin-element";
import { hasCameraPinKeys, isElementStuck, pinViewFor } from "../pin-target";
import { buildPinView, STICK_LABEL } from "../pin-view";
import { resetCameraPinStore, useCameraPinStore } from "../store";

const ticks = (value: number) => mediaTime({ ticks: value });

function keys({ values }: { values: number[] }): ScalarAnimationKey[] {
	return values.map((value, index) => ({
		id: `k-${index}-${value}`,
		time: ticks(100 + index * 200),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	}));
}

const CHANNELS: CameraPinKeys = {
	x: keys({ values: [10, 40, 80] }),
	y: keys({ values: [0, 5, 9] }),
	scaleX: keys({ values: [1, 1.1, 1.2] }),
	scaleY: keys({ values: [1, 1.1, 1.2] }),
	rotate: keys({ values: [0, 2, 4] }),
};
const RANGE = { start: ticks(100), end: ticks(500) };

/** Another segment of the same element (keys at 700, 800 and 900). */
function movedTo700({ name, written }: { name: string; written: ScalarAnimationKey[] }): ScalarAnimationKey[] {
	return written.map((key, index) => ({ ...key, id: `other-${name}-${index}`, time: ticks(700 + index * 100) }));
}
const OTHER_CHANNELS: CameraPinKeys = {
	x: movedTo700({ name: "x", written: CHANNELS.x }),
	y: movedTo700({ name: "y", written: CHANNELS.y }),
	scaleX: movedTo700({ name: "scaleX", written: CHANNELS.scaleX }),
	scaleY: movedTo700({ name: "scaleY", written: CHANNELS.scaleY }),
	rotate: movedTo700({ name: "rotate", written: CHANNELS.rotate }),
};
const OTHER_RANGE = { start: ticks(700), end: ticks(900) };

function video(): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		mediaId: "media-1",
		startTime: ticks(0),
		duration: ticks(5000),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: {},
	};
}

function text(): TextElement {
	return {
		id: "text-1",
		type: "text",
		name: "Title",
		startTime: ticks(0),
		duration: ticks(1000),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: { content: "Hello" },
	};
}

function scene(): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [video()] },
		overlay: [{ id: "text-track", name: "Text", type: "text", hidden: false, elements: [text()] }],
		audio: [],
	};
}

const PIN: CameraPinRecord = {
	elementId: "text-1",
	trackId: "text-track",
	analysisId: "analysis-1",
	hostElementId: "video-1",
	mode: "scene",
	model: "S",
	range: RANGE,
	host: hostStateOf(video()),
};

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
	resetCameraPinStore();
});

function createHarness() {
	const state = { tracks: scene() };
	const editor: EditorCore = Object.create(EditorCore.prototype);
	Object.assign(editor, {
		scenes: {
			getActiveScene: () => ({ tracks: state.tracks }),
			getActiveSceneOrNull: () => ({ tracks: state.tracks }),
			updateSceneTracks: ({ tracks: next }: { tracks: SceneTracks }) => {
				state.tracks = next;
			},
		},
		selection: { getSnapshot: () => ({}), applySelectionPatch: () => ({}), restoreSnapshot: () => {} },
		playback: { getCurrentTime: () => ticks(200) },
		// what `unstickElement` reads of the editor (readScene)
		media: { getAssets: () => [] },
		project: { getActive: () => ({ settings: { canvasSize: { width: 1920, height: 1080 } } }) },
	});
	Object.assign(editor, {
		timeline: new TimelineManager(editor),
		command: new CommandManager(editor),
	});
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	restores.push(() => spy.mockRestore());
	const pinScene = (): PinScene => ({
		tracks: state.tracks,
		canvasSize: { width: 1920, height: 1080 },
		mediaSize: () => undefined,
		playhead: ticks(200),
	});
	return { state, editor, pinScene };
}

const PINNED: CameraPinOutcome = {
	status: "pinned",
	elementId: "text-1",
	notices: [],
	lostFrame: null,
	cutTimes: [],
	mode: "scene",
	model: "S",
};

/** Stick as the engine does: the keys in one undo step, then the record in the store. */
function stick({
	editor,
	pin = PIN,
	outcome = PINNED,
}: {
	editor: EditorCore;
	pin?: CameraPinRecord;
	outcome?: CameraPinOutcome;
}) {
	editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: CHANNELS, range: RANGE });
	useCameraPinStore.getState().recordOutcome({ outcome, pin });
}

function unstick() {
	return useCameraPinStore.getState().unstick({ elementId: "text-1" });
}

/** What the section and the chip draw: the same function the hook calls, over the store and the scene. */
function sectionView({ pinScene }: { pinScene: () => PinScene }) {
	const { pins, job, outcomes, stickingElementId } = useCameraPinStore.getState();
	return pinViewFor({
		element: { id: "text-1", type: "text" },
		elementStartSeconds: 0,
		pins,
		job,
		outcomes,
		stickingElementId,
		busyRefused: false,
		scene: pinScene(),
	});
}

function keyed({ tracks }: { tracks: SceneTracks }): boolean {
	return hasCameraPinKeys({ animations: findElementInTracks({ tracks, elementId: "text-1" })?.element.animations });
}

describe("an undone stick is not stuck (Ctrl+Z goes back to state 1)", () => {
	test("after the stick the element is stuck everywhere", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		expect(sectionView({ pinScene }).state).toBe("stuck");
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(true);
	});

	test("after Ctrl+Z: the record stays, but the tab offers Stick again and a drag does not re-pin", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		editor.command.undo();

		// the session record is still there: only the keys tell the truth
		expect(useCameraPinStore.getState().pins["text-1"]).toBeDefined();
		const view = sectionView({ pinScene });
		expect(view.state).toBe("idle");
		expect(view.stuck).toBeNull();
		expect(view.canStick).toBe(true);
		expect(view.stickLabel).toBe(STICK_LABEL);
		expect(view.canUnstick).toBe(false);
		// the preview controllers see a loose element, so a drag commits as usual
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(false);
	});

	test("Ctrl+Y brings the keys back, and with them the stuck state", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		editor.command.undo();
		editor.command.redo();
		expect(sectionView({ pinScene }).state).toBe("stuck");
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(true);
	});
});

describe("Unstick and Ctrl+Z (the record outlives the Unstick, the keys decide)", () => {
	test("Unstick: idle, the look stays where it was, the record is kept", () => {
		const { editor, state, pinScene } = createHarness();
		stick({ editor });
		expect(unstick().status).toBe("unstuck");

		expect(keyed({ tracks: state.tracks })).toBe(false);
		expect(useCameraPinStore.getState().pins["text-1"]).toEqual(PIN);
		const view = sectionView({ pinScene });
		expect(view.state).toBe("idle");
		expect(view.canStick).toBe(true);
		expect(view.canUnstick).toBe(false);
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(false);
	});

	test("Unstick then Ctrl+Z: Stuck is back, with its keys and its Unstick, and a drag re-pins again", () => {
		const { editor, state, pinScene } = createHarness();
		stick({ editor });
		unstick();
		editor.command.undo();

		expect(keyed({ tracks: state.tracks })).toBe(true);
		const view = sectionView({ pinScene });
		expect(view.state).toBe("stuck");
		expect(view.stuck?.label).toBe("Stuck");
		expect(view.canUnstick).toBe(true);
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(true);
	});

	test("Unstick, Ctrl+Z, Ctrl+Y: idle again, the keys gone again", () => {
		const { editor, state, pinScene } = createHarness();
		stick({ editor });
		unstick();
		editor.command.undo();
		editor.command.redo();

		expect(keyed({ tracks: state.tracks })).toBe(false);
		expect(sectionView({ pinScene }).state).toBe("idle");
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(false);
	});

	test("Stick, Ctrl+Z, Ctrl+Y still works after all this (idle, then stuck)", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		editor.command.undo();
		expect(sectionView({ pinScene }).state).toBe("idle");
		editor.command.redo();
		expect(sectionView({ pinScene }).state).toBe("stuck");
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(true);
	});

	test("a second Unstick is an error and writes no undo step of its own", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		expect(unstick().status).toBe("unstuck");
		expect(unstick()).toMatchObject({ status: "error", error: "no-element" });

		// one Ctrl+Z undoes the first Unstick, not a no-op step of the second
		editor.command.undo();
		expect(sectionView({ pinScene }).state).toBe("stuck");
	});

	test("Unstick after Ctrl+Z of the stick is an error too (nothing to remove) and Ctrl+Y brings Stuck back", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		editor.command.undo();
		expect(unstick().status).toBe("error");
		expect(useCameraPinStore.getState().pins["text-1"]).toEqual(PIN);
		editor.command.redo();
		expect(sectionView({ pinScene }).state).toBe("stuck");
	});

	test("Stick again after an Unstick overwrites the record", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		unstick();
		stick({ editor, pin: { ...PIN, analysisId: "analysis-2" } });

		expect(useCameraPinStore.getState().pins["text-1"]?.analysisId).toBe("analysis-2");
		expect(sectionView({ pinScene }).state).toBe("stuck");
		// ...and its own Unstick works as the first did
		expect(unstick().status).toBe("unstuck");
		expect(sectionView({ pinScene }).state).toBe("idle");
	});

	test("keys of another segment stay after the Unstick: then the record is forgotten, nothing reads it as stuck", () => {
		const { editor, state, pinScene } = createHarness();
		editor.timeline.applyCameraPin({
			trackId: "text-track",
			elementId: "text-1",
			channels: OTHER_CHANNELS,
			range: OTHER_RANGE,
		});
		stick({ editor });
		expect(unstick().status).toBe("unstuck");

		expect(keyed({ tracks: state.tracks })).toBe(true);
		expect(useCameraPinStore.getState().pins["text-1"]).toBeUndefined();
		expect(useCameraPinStore.getState().outcomes["text-1"]).toBeUndefined();
		expect(sectionView({ pinScene }).state).toBe("idle");
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(false);
	});

	test("the pinned outcome is kept through the Unstick but its notices show only while stuck", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor, outcome: { ...PINNED, notices: ["cut"], cutTimes: [5.2] } });
		const cutNotice = "Scene cut at 0:05.2, stuck until there.";
		expect(sectionView({ pinScene }).notices.map((notice) => notice.text)).toEqual([cutNotice]);

		unstick();
		expect(useCameraPinStore.getState().outcomes["text-1"]?.status).toBe("pinned");
		expect(sectionView({ pinScene }).notices).toEqual([]);

		editor.command.undo();
		expect(sectionView({ pinScene }).notices.map((notice) => notice.text)).toEqual([cutNotice]);
	});

	test("Ctrl+Z of the stick hides the pinned notices as well", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor, outcome: { ...PINNED, notices: ["cut"], cutTimes: [5.2] } });
		editor.command.undo();
		expect(sectionView({ pinScene }).notices).toEqual([]);
		editor.command.redo();
		expect(sectionView({ pinScene }).notices).toHaveLength(1);
	});

	test("a failure outcome does not outlive the Unstick (it would show on an idle element)", () => {
		const { editor, pinScene } = createHarness();
		stick({ editor });
		useCameraPinStore.getState().recordOutcome({
			outcome: { status: "error", elementId: "text-1", error: "apply-failed", message: "Could not apply." },
		});
		unstick();
		expect(useCameraPinStore.getState().outcomes["text-1"]).toBeUndefined();
		expect(sectionView({ pinScene }).notices).toEqual([]);
	});

	test("forget drops the kept record, and the element of a deleted clip reads as not stuck meanwhile", () => {
		const { editor, state, pinScene } = createHarness();
		stick({ editor });
		unstick();
		state.tracks = { ...state.tracks, overlay: [] };
		expect(sectionView({ pinScene }).state).not.toBe("stuck");
		expect(cameraPinOps.isPinned({ elementId: "text-1" })).toBe(false);

		useCameraPinStore.getState().forget({ elementId: "text-1" });
		expect(useCameraPinStore.getState().pins).toEqual({});
		expect(useCameraPinStore.getState().outcomes).toEqual({});
	});
});

describe("hasCameraPinKeys / isElementStuck", () => {
	const all = Object.fromEntries(
		Object.values(CAMERA_PIN_PATHS).map((path) => [path, { keys: keys({ values: [1, 2] }) }]),
	);

	test("all five channels keyed is a pin's keys; none, or some missing, is not", () => {
		expect(hasCameraPinKeys({ animations: all })).toBe(true);
		expect(hasCameraPinKeys({ animations: undefined })).toBe(false);
		for (const path of Object.values(CAMERA_PIN_PATHS)) {
			const { [path]: _gone, ...rest } = all;
			expect(hasCameraPinKeys({ animations: rest })).toBe(false);
			expect(hasCameraPinKeys({ animations: { ...all, [path]: { keys: [] } } })).toBe(false);
		}
	});

	test("stuck needs the record, the element and its keys", () => {
		const tracks = scene();
		const keyed: SceneTracks = {
			...tracks,
			overlay: [
				{ id: "text-track", name: "Text", type: "text", hidden: false, elements: [{ ...text(), animations: all }] },
			],
		};
		expect(isElementStuck({ pins: { "text-1": PIN }, tracks: keyed, elementId: "text-1" })).toBe(true);
		expect(isElementStuck({ pins: {}, tracks: keyed, elementId: "text-1" })).toBe(false);
		expect(isElementStuck({ pins: { "text-1": PIN }, tracks, elementId: "text-1" })).toBe(false);
		expect(isElementStuck({ pins: { "text-1": PIN }, tracks: keyed, elementId: "gone" })).toBe(false);
		expect(isElementStuck({ pins: { "text-1": PIN }, tracks: null, elementId: "text-1" })).toBe(false);
	});

	test("the view: a record without keys draws as not stuck, and a running job still disables it", () => {
		const base = {
			element: { id: "text-1", type: "text" },
			pins: { "text-1": PIN },
			job: IDLE_CAMERA_JOB,
			outcomes: {},
			stickingElementId: null,
			hasVideoUnder: true,
		};
		expect(buildPinView({ ...base }).state).toBe("stuck");
		expect(buildPinView({ ...base, hasPinKeys: false }).state).toBe("idle");
		expect(buildPinView({ ...base, hasPinKeys: false, isPinCurrent: false }).state).toBe("idle");
	});
});
