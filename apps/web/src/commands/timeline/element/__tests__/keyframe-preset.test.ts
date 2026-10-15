/**
 * ApplyKeyframePresetCommand: a preset becomes ordinary keyframes in one undo
 * step. Runs through the real CommandManager and TimelineManager over a
 * stand-in for the scene, like camera-pin.test.ts.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { isScalarChannel } from "@/animation/interpolation";
import { getChannel } from "@/animation/keyframes";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { TimelineManager } from "@/core/managers/timeline-manager";
import type {
	AudioElement,
	ImageElement,
	SceneTracks,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

const CLIP = 10 * TICKS_PER_SECOND;

function built({ type, id }: { type: "video" | "image" | "audio"; id: string }) {
	return {
		id,
		...buildElementFromMedia({
			mediaId: `media-${id}`,
			mediaType: type,
			name: id,
			duration: mediaTime({ ticks: CLIP }),
			startTime: mediaTime({ ticks: 2 * TICKS_PER_SECOND }),
		}),
	};
}

function videoClip(): VideoElement {
	const element = built({ type: "video", id: "video" });
	if (element.type !== "video") throw new Error("expected video");
	return element;
}

function imageClip(): ImageElement {
	const element = built({ type: "image", id: "image" });
	if (element.type !== "image") throw new Error("expected image");
	return element;
}

function audioClip(): AudioElement {
	const element = built({ type: "audio", id: "audio" });
	if (element.type !== "audio") throw new Error("expected audio");
	return element;
}

function scene(): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [videoClip()] },
		overlay: [{ id: "over", name: "Over", type: "video", muted: false, hidden: false, elements: [imageClip()] }],
		audio: [{ id: "sound", name: "Sound", type: "audio", muted: false, elements: [audioClip()] }],
	};
}

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function harness({ playhead }: { playhead: number }) {
	const state = { tracks: scene(), updates: 0 };
	const editor: EditorCore = Object.create(EditorCore.prototype);
	Object.assign(editor, {
		scenes: {
			getActiveScene: () => ({ tracks: state.tracks }),
			getActiveSceneOrNull: () => ({ tracks: state.tracks }),
			updateSceneTracks: ({ tracks }: { tracks: SceneTracks }) => {
				state.tracks = tracks;
				state.updates++;
			},
		},
		selection: { getSnapshot: () => ({}), applySelectionPatch: () => ({}), restoreSnapshot: () => {} },
		playback: { getCurrentTime: () => mediaTime({ ticks: playhead }) },
		project: { getActive: () => ({ settings: { canvasSize: { width: 1920, height: 1080 } } }) },
	});
	Object.assign(editor, { timeline: new TimelineManager(editor), command: new CommandManager(editor) });
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	restores.push(() => spy.mockRestore());
	const find = (id: string): TimelineElement => {
		for (const track of [state.tracks.main, ...state.tracks.overlay, ...state.tracks.audio]) {
			const found = track.elements.find((element) => element.id === id);
			if (found) return found;
		}
		throw new Error(`no element ${id}`);
	};
	return { state, editor, find };
}

function keyCount({ element, path }: { element: TimelineElement; path: string }): number {
	const channel = getChannel({ animations: element.animations, propertyPath: path });
	return channel && isScalarChannel(channel) ? channel.keys.length : 0;
}

describe("ApplyKeyframePresetCommand", () => {
	test("writes every channel of the preset in one history step, and undo / redo take all of it back / return it", () => {
		const { editor, find, state } = harness({ playhead: 0 });
		const original = state.tracks;
		editor.timeline.applyKeyframePreset({ targets: [{ trackId: "main", elementId: "video" }], presetId: "zoom-in", placement: "start", seconds: 3 });
		expect(keyCount({ element: find("video"), path: "transform.scaleX" })).toBe(2);
		expect(keyCount({ element: find("video"), path: "transform.scaleY" })).toBe(2);
		editor.command.undo();
		expect(state.tracks).toBe(original);
		expect(find("video").animations).toBeUndefined();
		editor.command.redo();
		expect(keyCount({ element: find("video"), path: "transform.scaleX" })).toBe(2);
		expect(keyCount({ element: find("video"), path: "transform.scaleY" })).toBe(2);
	});

	test("the playhead placement starts at the playhead, measured from the clip's start", () => {
		const playhead = 2 * TICKS_PER_SECOND + 4 * TICKS_PER_SECOND;
		const { editor, find } = harness({ playhead });
		editor.timeline.applyKeyframePreset({ targets: [{ trackId: "over", elementId: "image" }], presetId: "pulse", placement: "playhead", seconds: 1 });
		const channel = getChannel({ animations: find("image").animations, propertyPath: "transform.scaleX" });
		if (!channel || !isScalarChannel(channel)) throw new Error("no scale channel");
		expect(Number(channel.keys[0].time)).toBe(4 * TICKS_PER_SECOND);
		expect(Number(channel.keys[channel.keys.length - 1].time)).toBe(5 * TICKS_PER_SECOND);
	});

	test("audio presets write the volume of an audio clip", () => {
		const { editor, find } = harness({ playhead: 0 });
		editor.timeline.applyKeyframePreset({ targets: [{ trackId: "sound", elementId: "audio" }], presetId: "volume-fade-out", placement: "end", seconds: 2 });
		expect(keyCount({ element: find("audio"), path: "volume" })).toBe(2);
	});

	test("a preset the clip cannot take throws and leaves the scene and the history alone", () => {
		const { editor, state } = harness({ playhead: 0 });
		const original = state.tracks;
		expect(() =>
			editor.timeline.applyKeyframePreset({ targets: [{ trackId: "over", elementId: "image" }], presetId: "volume-fade-in", placement: "start", seconds: 1 }),
		).toThrow();
		expect(() =>
			editor.timeline.applyKeyframePreset({ targets: [{ trackId: "sound", elementId: "audio" }], presetId: "zoom-in", placement: "start", seconds: 1 }),
		).toThrow();
		expect(() =>
			editor.timeline.applyKeyframePreset({ targets: [{ trackId: "main", elementId: "missing" }], presetId: "zoom-in", placement: "start", seconds: 1 }),
		).toThrow();
		expect(state.tracks).toBe(original);
		expect(state.updates).toBe(0);
	});
});

describe("several selected clips", () => {
	const all = [
		{ trackId: "main", elementId: "video" },
		{ trackId: "over", elementId: "image" },
		{ trackId: "sound", elementId: "audio" },
	];

	test("a visual preset goes on every clip that can take it, as ONE undo step; the sound clip is skipped", () => {
		const { editor, find, state } = harness({ playhead: 0 });
		const original = state.tracks;
		const count = editor.timeline.applyKeyframePreset({ targets: all, presetId: "zoom-in", placement: "start", seconds: 2 });
		expect(count).toBe(2);
		expect(keyCount({ element: find("video"), path: "transform.scaleX" })).toBe(2);
		expect(keyCount({ element: find("image"), path: "transform.scaleX" })).toBe(2);
		expect(find("audio").animations).toBeUndefined();
		editor.command.undo();
		expect(state.tracks).toBe(original);
	});

	test("a volume preset goes on the sound and the video, not on the picture", () => {
		const { editor, find } = harness({ playhead: 0 });
		const count = editor.timeline.applyKeyframePreset({ targets: all, presetId: "volume-fade-in", placement: "start", seconds: 1 });
		expect(count).toBe(2);
		expect(keyCount({ element: find("audio"), path: "volume" })).toBe(2);
		expect(keyCount({ element: find("video"), path: "volume" })).toBe(2);
		expect(find("image").animations).toBeUndefined();
	});

	test("keyframes at the playhead for several clips are one undo step too", () => {
		const { editor, find, state } = harness({ playhead: 3 * TICKS_PER_SECOND });
		const original = state.tracks;
		const time = mediaTime({ ticks: TICKS_PER_SECOND });
		editor.timeline.upsertKeyframes({
			keyframes: [
				{ trackId: "over", elementId: "image", propertyPath: "opacity", time, value: 0.5 },
				{ trackId: "over", elementId: "image", propertyPath: "transform.rotate", time, value: 10 },
				{ trackId: "sound", elementId: "audio", propertyPath: "volume", time, value: -6 },
			],
		});
		expect(keyCount({ element: find("image"), path: "opacity" })).toBe(1);
		expect(keyCount({ element: find("audio"), path: "volume" })).toBe(1);
		editor.command.undo();
		expect(state.tracks).toBe(original);
	});
});
