/**
 * ApplyCameraPinCommand and RemoveCameraPinCommand (slice T3): five channels in
 * one undo step, only the pinned stretch changes, Unstick leaves no jump. They
 * run through the real CommandManager and TimelineManager over a stand-in for
 * the scene, so the undo and redo steps are the real ones.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PresetAnimations } from "@/animation/presets";
import type {
	ElementAnimations,
	ScalarAnimationKey,
	ScalarChannel,
} from "@/animation/types";
import {
	ApplyCameraPinCommand,
	RemoveCameraPinCommand,
} from "@/commands/timeline/element/keyframes/apply-camera-pin";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { TimelineManager } from "@/core/managers/timeline-manager";
import { buildTransformFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type {
	AudioElement,
	SceneTracks,
	TextElement,
	VideoElement,
} from "@/timeline";
import {
	CAMERA_PIN_PATHS,
	getScalarChannel,
	type CameraPinKeys,
	type CameraPinRange,
} from "@/tracking/camera/pin-animations";
import { mediaTime, type MediaTime } from "@/wasm";

const NAMES = ["x", "y", "scaleX", "scaleY", "rotate"] as const;
let nextId = 0;

function key({ ticks, value }: { ticks: number; value: number }): ScalarAnimationKey {
	return {
		id: `key-${nextId++}`,
		time: mediaTime({ ticks }),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function keys({ at }: { at: [number, number][] }): ScalarAnimationKey[] {
	return at.map(([ticks, value]) => key({ ticks, value }));
}

function pin({
	x,
	y = x,
	scaleX = [],
	scaleY = scaleX,
	rotate = [],
}: {
	x: [number, number][];
	y?: [number, number][];
	scaleX?: [number, number][];
	scaleY?: [number, number][];
	rotate?: [number, number][];
}): CameraPinKeys {
	const fill = (given: [number, number][]) => (given.length > 0 ? given : x.map(([t]) => [t, 1] as [number, number]));
	return {
		x: keys({ at: x }),
		y: keys({ at: y }),
		scaleX: keys({ at: fill(scaleX) }),
		scaleY: keys({ at: fill(scaleY) }),
		rotate: keys({ at: rotate.length > 0 ? rotate : x.map(([t]) => [t, 0] as [number, number]) }),
	};
}

function range({ start, end }: { start: number; end: number }): CameraPinRange {
	return { start: mediaTime({ ticks: start }), end: mediaTime({ ticks: end }) };
}

const ELEMENT_DURATION = mediaTime({ ticks: 1000 });

function video(): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		mediaId: "media-1",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 5000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function text(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: "text-1",
		type: "text",
		name: "Title",
		startTime: mediaTime({ ticks: 400 }),
		duration: ELEMENT_DURATION,
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {
			content: "Hello",
			opacity: 0.8,
			"transform.positionX": 10,
			"transform.positionY": -20,
			"transform.scaleX": 1.5,
			"transform.scaleY": 1.5,
			"transform.rotate": 15,
		},
		...overrides,
	};
}

function audio(): AudioElement {
	return {
		id: "audio-1",
		type: "audio",
		name: "Song",
		sourceType: "upload",
		mediaId: "media-2",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 5000 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function sceneWith({ element }: { element: TextElement }): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [video()] },
		overlay: [{ id: "text-track", name: "Text", type: "text", hidden: false, elements: [element] }],
		audio: [{ id: "audio-track", name: "Audio", type: "audio", muted: false, elements: [audio()] }],
	};
}

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function createHarness({ tracks, playhead = 0 }: { tracks: SceneTracks; playhead?: number }) {
	const state = { tracks, updates: 0, playhead };
	const editor: EditorCore = Object.create(EditorCore.prototype);
	Object.assign(editor, {
		scenes: {
			getActiveScene: () => ({ tracks: state.tracks }),
			getActiveSceneOrNull: () => ({ tracks: state.tracks }),
			updateSceneTracks: ({ tracks: next }: { tracks: SceneTracks }) => {
				state.tracks = next;
				state.updates++;
			},
		},
		selection: {
			getSnapshot: () => ({}),
			applySelectionPatch: () => ({}),
			restoreSnapshot: () => {},
		},
		playback: { getCurrentTime: () => mediaTime({ ticks: state.playhead }) },
	});
	Object.assign(editor, {
		timeline: new TimelineManager(editor),
		command: new CommandManager(editor),
	});
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	restores.push(() => spy.mockRestore());
	const element = () => {
		const found = state.tracks.overlay[0].elements[0];
		if (found.type !== "text") throw new Error("expected the text element");
		return found;
	};
	return { state, editor, element };
}

function channelOf({ element, path }: { element: TextElement; path: string }): ScalarChannel | undefined {
	return getScalarChannel({ animations: element.animations, path });
}

function textIn({ tracks }: { tracks: SceneTracks }): TextElement {
	const found = tracks.overlay[0].elements[0];
	if (found.type !== "text") throw new Error("expected the text element");
	return found;
}

/** The element's transform at a local time, the way the renderer resolves it. */
function lookAt({ element, localTime }: { element: TextElement; localTime: number }) {
	return resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime,
	});
}

const INSIDE = range({ start: 100, end: 500 });
const PIN = () =>
	pin({
		x: [[100, 11.5], [300, 25.25], [500, 40]],
		y: [[100, -21], [300, -30.5], [500, -41]],
		scaleX: [[100, 1.5], [300, 1.8], [500, 2.1]],
		scaleY: [[100, 1.5], [300, 1.7], [500, 2.3]],
		rotate: [[100, 15], [300, 100], [500, 460.5]],
	});

describe("ApplyCameraPinCommand", () => {
	test("writes the five channels, with decimals, linear and flat", () => {
		const { editor, element } = createHarness({ tracks: sceneWith({ element: text() }) });
		editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: PIN(), range: INSIDE });
		for (const name of NAMES) {
			const channel = channelOf({ element: element(), path: CAMERA_PIN_PATHS[name] });
			expect(channel?.keys).toHaveLength(3);
			for (const k of channel?.keys ?? []) {
				expect(k.segmentToNext).toBe("linear");
				expect(k.tangentMode).toBe("flat");
			}
		}
		expect(channelOf({ element: element(), path: "transform.positionX" })?.keys.map((k) => k.value)).toEqual([
			11.5, 25.25, 40,
		]);
		expect(lookAt({ element: element(), localTime: 200 }).position.x).toBe(18.375);
		expect(lookAt({ element: element(), localTime: 500 }).rotate).toBe(460.5);
	});

	test("one undo step restores the previous animations exactly, redo applies again", () => {
		const before = text({
			animations: {
				"transform.positionX": { keys: keys({ at: [[0, 1], [50, 2], [700, 3]] }) },
				opacity: { keys: keys({ at: [[0, 1], [900, 0.4]] }) },
			},
		});
		const { editor, state, element } = createHarness({ tracks: sceneWith({ element: before }) });
		const original = state.tracks;
		const originalSnapshot = structuredClone(original);

		editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: PIN(), range: INSIDE });
		const applied = state.tracks;
		expect(applied).not.toEqual(original);

		editor.command.undo();
		expect(state.tracks).toEqual(originalSnapshot);
		expect(state.tracks).toBe(original);
		expect(editor.command.canUndo()).toBe(false);

		editor.command.redo();
		expect(state.tracks).toEqual(applied);
		expect(channelOf({ element: element(), path: "transform.rotate" })?.keys).toHaveLength(3);
	});

	test("it is exactly one history entry for all five channels", () => {
		const { editor, state } = createHarness({ tracks: sceneWith({ element: text() }) });
		editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: PIN(), range: INSIDE });
		expect(state.updates).toBe(1);
		editor.command.undo();
		expect(state.updates).toBe(2);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("only keys inside the pinned stretch change; the rest are the same keys", () => {
		const outside = keys({ at: [[0, -1], [50, -2], [620, -3], [900, -4]] });
		const animations: ElementAnimations = {};
		for (const name of NAMES) {
			animations[CAMERA_PIN_PATHS[name]] = { keys: keys({ at: [[0, -1], [50, -2], [620, -3], [900, -4]] }) };
		}
		// two more keys inside the pinned stretch, which the pin replaces
		animations["transform.positionX"] = { keys: [...outside, ...keys({ at: [[200, 77], [450, 78]] })] };
		const before = text({ animations });
		const { editor, element } = createHarness({ tracks: sceneWith({ element: before }) });
		editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: PIN(), range: INSIDE });

		const x = channelOf({ element: element(), path: "transform.positionX" });
		expect<number[] | undefined>(x?.keys.map((k) => k.time)).toEqual([0, 50, 100, 300, 500, 620, 900]);
		for (const ticks of [0, 50, 620, 900]) {
			const was = outside.find((k) => k.time === ticks);
			expect(x?.keys.find((k) => k.time === ticks)).toEqual(was);
		}
		// holds outside the keys of the pin: the channel plays the same before and after
		expect(lookAt({ element: element(), localTime: 0 }).position.x).toBe(-1);
		expect(lookAt({ element: element(), localTime: 900 }).position.x).toBe(-4);
	});

	test("opacity, its animation, the other params and the presets are untouched", () => {
		const opacityChannel: ScalarChannel = { keys: keys({ at: [[0, 1], [900, 0.2]] }) };
		const presets: PresetAnimations = {
			in: { id: "slide-left", duration: mediaTime({ ticks: 100 }) },
			out: { id: "zoom", duration: mediaTime({ ticks: 80 }) },
		};
		const before = text({ animations: { opacity: opacityChannel }, presetAnimations: presets });
		const { editor, element } = createHarness({ tracks: sceneWith({ element: before }) });
		editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: PIN(), range: INSIDE });
		expect(element().animations?.opacity).toBe(opacityChannel);
		expect(element().presetAnimations).toBe(presets);
		expect(element().params).toBe(before.params);
		expect(element().params.opacity).toBe(0.8);
		expect(element().startTime).toBe(before.startTime);
		expect(element().duration).toBe(before.duration);
	});

	test("a second pin on another segment leaves the first as it was", () => {
		const { editor, element } = createHarness({ tracks: sceneWith({ element: text() }) });
		editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: PIN(), range: INSIDE });
		const afterFirst = element();
		editor.timeline.applyCameraPin({
			trackId: "text-track",
			elementId: "text-1",
			channels: pin({ x: [[700, 60], [800, 61], [900, 62]], rotate: [[700, 470], [800, 475], [900, 480]] }),
			range: range({ start: 700, end: 900 }),
		});
		for (const name of NAMES) {
			const path = CAMERA_PIN_PATHS[name];
			expect(channelOf({ element: element(), path })?.keys.slice(0, 3)).toEqual(channelOf({ element: afterFirst, path })?.keys);
		}
		// the first pin plays the same inside its own stretch
		for (const ticks of [100, 200, 300, 400, 500]) {
			expect(lookAt({ element: element(), localTime: ticks })).toEqual(lookAt({ element: afterFirst, localTime: ticks }));
		}
		// two undos take both away, in order
		editor.command.undo();
		expect(element()).toEqual(afterFirst);
		editor.command.undo();
		expect(element().animations).toBeUndefined();
	});

	describe("a pin that cannot be applied", () => {
		test("a track that is not in the scene throws, changes nothing and leaves no history", () => {
			const { editor, state } = createHarness({ tracks: sceneWith({ element: text() }) });
			const original = state.tracks;
			expect(() =>
				editor.timeline.applyCameraPin({ trackId: "nowhere", elementId: "text-1", channels: PIN(), range: INSIDE }),
			).toThrow(/track "nowhere"/);
			expect(state.updates).toBe(0);
			expect(state.tracks).toBe(original);
			expect(editor.command.canUndo()).toBe(false);
		});

		test("an element that is not on that track", () => {
			const { editor, state } = createHarness({ tracks: sceneWith({ element: text() }) });
			expect(() =>
				editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "ghost", channels: PIN(), range: INSIDE }),
			).toThrow(/element "ghost"/);
			expect(state.updates).toBe(0);
			expect(editor.command.canUndo()).toBe(false);
		});

		test("an element with no transform (audio)", () => {
			const { editor, state } = createHarness({ tracks: sceneWith({ element: text() }) });
			expect(() =>
				editor.timeline.applyCameraPin({ trackId: "audio-track", elementId: "audio-1", channels: PIN(), range: INSIDE }),
			).toThrow(/cannot be moved/);
			expect(state.updates).toBe(0);
		});

		test("keys outside the range, or an empty channel, are refused before anything is written", () => {
			const { editor, state } = createHarness({ tracks: sceneWith({ element: text() }) });
			const stray = PIN();
			stray.x = keys({ at: [[50, 1], [500, 2]] });
			expect(() =>
				editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: stray, range: INSIDE }),
			).toThrow();
			const empty = PIN();
			empty.rotate = [];
			expect(() =>
				editor.timeline.applyCameraPin({ trackId: "text-track", elementId: "text-1", channels: empty, range: INSIDE }),
			).toThrow();
			expect(state.updates).toBe(0);
			expect(editor.command.canUndo()).toBe(false);
		});

		test("the command itself refuses too, without touching the scene", () => {
			const { editor, state } = createHarness({ tracks: sceneWith({ element: text() }) });
			const command = new ApplyCameraPinCommand({ trackId: "x", elementId: "y", channels: PIN(), range: INSIDE });
			expect(() => command.execute()).toThrow();
			command.undo();
			expect(state.updates).toBe(0);
			expect(editor.command.canUndo()).toBe(false);
		});
	});
});

describe("RemoveCameraPinCommand", () => {
	const PLAYHEAD_LOCAL = 300;
	const PLAYHEAD = 400 + PLAYHEAD_LOCAL;

	function pinned({ playhead = PLAYHEAD }: { playhead?: number } = {}) {
		const harness = createHarness({
			tracks: sceneWith({
				element: text({ animations: { opacity: { keys: keys({ at: [[0, 1], [900, 0.3]] }) } } }),
			}),
			playhead,
		});
		harness.editor.timeline.applyCameraPin({
			trackId: "text-track",
			elementId: "text-1",
			channels: PIN(),
			range: INSIDE,
		});
		return harness;
	}

	test("the element does not jump at the playhead, and no pin channel is left", () => {
		const { editor, element } = pinned();
		const before = lookAt({ element: element(), localTime: PLAYHEAD_LOCAL });
		editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "text-1", range: INSIDE });
		const after = lookAt({ element: element(), localTime: PLAYHEAD_LOCAL });
		expect(after.position).toEqual(before.position);
		expect(after.scaleX).toBe(before.scaleX);
		expect(after.scaleY).toBe(before.scaleY);
		// 100 degrees is 100 degrees
		expect(after.rotate).toBe(before.rotate);
		for (const name of NAMES) {
			expect(channelOf({ element: element(), path: CAMERA_PIN_PATHS[name] })).toBeUndefined();
		}
		// the look is now the base, held the whole clip long, decimals kept
		expect(element().params["transform.positionX"]).toBe(25.25);
		expect(element().params["transform.positionY"]).toBe(-30.5);
		expect(lookAt({ element: element(), localTime: 0 })).toEqual(before);
		expect(lookAt({ element: element(), localTime: 900 })).toEqual(before);
	});

	test("a rotation past a full turn is kept as the same look", () => {
		const { editor, element, state } = pinned({ playhead: 400 + 500 });
		const before = lookAt({ element: element(), localTime: 500 });
		expect(before.rotate).toBe(460.5);
		editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "text-1", range: INSIDE });
		const after = lookAt({ element: element(), localTime: 500 });
		// 460.5 degrees is 100.5 once the turn is taken out, the field's range is -360..360
		expect(after.rotate).toBeCloseTo(100.5, 9);
		expect((after.rotate - before.rotate) % 360).toBeCloseTo(0, 9);
		expect(state.updates).toBe(2);
	});

	test("opacity, its animation and the other params stay", () => {
		const { editor, element } = pinned();
		const opacity = element().animations?.opacity;
		editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "text-1", range: INSIDE });
		expect(element().animations?.opacity).toBe(opacity);
		expect(element().params.opacity).toBe(0.8);
		expect(element().params.content).toBe("Hello");
	});

	test("it is one undo step, which brings the pin back exactly", () => {
		const { editor, state } = pinned();
		const stuck = state.tracks;
		const stuckSnapshot = structuredClone(stuck);
		editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "text-1", range: INSIDE });
		expect(state.tracks).not.toEqual(stuckSnapshot);
		editor.command.undo();
		expect(state.tracks).toEqual(stuckSnapshot);
		expect(state.tracks).toBe(stuck);
		// the one undo took only the unstick: the pin is still one step down
		expect(editor.command.canUndo()).toBe(true);
		editor.command.redo();
		expect(channelOf({ element: textIn({ tracks: state.tracks }), path: "transform.positionX" })).toBeUndefined();
	});

	test("with a second pin on another segment, only the asked segment goes", () => {
		const { editor, element } = pinned();
		editor.timeline.applyCameraPin({
			trackId: "text-track",
			elementId: "text-1",
			channels: pin({ x: [[700, 60], [900, 62]], rotate: [[700, 470], [900, 480]] }),
			range: range({ start: 700, end: 900 }),
		});
		const second = channelOf({ element: element(), path: "transform.positionX" })?.keys.filter((k) => k.time >= 700);
		const before = lookAt({ element: element(), localTime: PLAYHEAD_LOCAL });
		editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "text-1", range: INSIDE });
		expect(channelOf({ element: element(), path: "transform.positionX" })?.keys.filter((k) => k.time >= 700)).toEqual(second);
		for (const ticks of [100, 200, 300, 400, 500]) {
			expect(lookAt({ element: element(), localTime: ticks }).position).toEqual(before.position);
		}
		expect(lookAt({ element: element(), localTime: 800 }).position.x).toBeCloseTo(61, 9);
	});

	test("an element that was never pinned is left alone", () => {
		const { editor, element } = createHarness({ tracks: sceneWith({ element: text() }), playhead: 700 });
		const before = element();
		editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "text-1", range: INSIDE });
		expect(element()).toEqual(before);
	});

	test("a missing track or element throws and writes nothing", () => {
		const { editor, state } = pinned();
		const writes = state.updates;
		expect(() => editor.timeline.removeCameraPin({ trackId: "nowhere", elementId: "text-1", range: INSIDE })).toThrow(
			/track "nowhere"/,
		);
		expect(() => editor.timeline.removeCameraPin({ trackId: "text-track", elementId: "ghost", range: INSIDE })).toThrow(
			/element "ghost"/,
		);
		expect(state.updates).toBe(writes);
	});

	test("the command takes the playhead as a timeline time", () => {
		const { state } = pinned();
		const editor = EditorCore.getInstance();
		const command = new RemoveCameraPinCommand({
			trackId: "text-track",
			elementId: "text-1",
			range: INSIDE,
			playhead: mediaTime({ ticks: 400 + 100 }) as MediaTime,
		});
		command.execute();
		const element = textIn({ tracks: state.tracks });
		expect(element.params["transform.positionX"]).toBe(11.5);
		command.undo();
		expect(editor.scenes.getActiveScene().tracks.overlay[0].elements[0].params["transform.positionX"]).toBe(10);
	});
});
