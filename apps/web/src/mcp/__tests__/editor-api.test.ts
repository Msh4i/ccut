import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { TimelineManager } from "@/core/managers/timeline-manager";
import { createMcpEditorApi } from "@/mcp/editor-api";
import { runMcpTool } from "@/mcp/tools";
import type { SceneTracks, TextElement, VideoElement } from "@/timeline";
import { buildElementFromMedia, buildTextElement } from "@/timeline/element-utils";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

// The real editor behind the tools, over a stand-in for the scene (like the keyframe command
// tests): every edit tool is exactly ONE undo step, and a refused edit changes and records nothing.

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function scene(): SceneTracks {
	const built = buildElementFromMedia({ mediaId: "m", mediaType: "video", name: "Clip", duration: mediaTime({ ticks: 10 * TICKS_PER_SECOND }), startTime: mediaTime({ ticks: 0 }) });
	if (built.type !== "video") throw new Error("video expected");
	const video: VideoElement = { id: "video", ...built };
	const builtText = buildTextElement({ raw: { duration: mediaTime({ ticks: 4 * TICKS_PER_SECOND }), params: { content: "Hi" } }, startTime: mediaTime({ ticks: 0 }) });
	if (builtText.type !== "text") throw new Error("text expected");
	const text: TextElement = { id: "text", ...builtText };
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [video] },
		overlay: [{ id: "over", name: "Text", type: "text", hidden: false, elements: [text] }],
		audio: [],
	};
}

function harness() {
	const state = { tracks: scene(), playhead: 0, selected: [] as Array<{ trackId: string; elementId: string }> };
	const editor: EditorCore = Object.create(EditorCore.prototype);
	Object.assign(editor, {
		scenes: {
			getActiveScene: () => ({ tracks: state.tracks }),
			getActiveSceneOrNull: () => ({ tracks: state.tracks }),
			updateSceneTracks: ({ tracks }: { tracks: SceneTracks }) => {
				state.tracks = tracks;
			},
		},
		selection: { getSnapshot: () => ({}), applySelectionPatch: () => ({}), restoreSnapshot: () => {}, getSelectedElements: () => state.selected },
		playback: { getCurrentTime: () => mediaTime({ ticks: state.playhead }), seek: ({ time }: { time: number }) => void (state.playhead = time), getIsPlaying: () => false, play: () => {}, pause: () => {} },
		project: { getActive: () => ({ metadata: { name: "P" }, settings: { canvasSize: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 } } }) },
		media: { getAssets: () => [{ id: "asset", name: "A", type: "video", duration: 5 }] },
	});
	Object.assign(editor, { timeline: new TimelineManager(editor), command: new CommandManager(editor) });
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	restores.push(() => spy.mockRestore());
	const api = createMcpEditorApi({ editor });
	const run = (...[tool, args]: [string, unknown]) => runMcpTool({ tool, args, api });
	return { state, editor, run };
}

const elementCount = ({ tracks }: { tracks: SceneTracks }) => [tracks.main, ...tracks.overlay, ...tracks.audio].reduce((sum, track) => sum + track.elements.length, 0);

describe("agent edits are one undo step each", () => {
	test("split_at: two clips from one, and one undo brings the original back", async () => {
		const { state, editor, run } = harness();
		const before = state.tracks;
		expect(await run("split_at", { seconds: 3, elementId: "video" })).toEqual({ split: 1 });
		expect(state.tracks.main.elements).toHaveLength(2);
		editor.command.undo();
		expect(state.tracks).toBe(before);
	});

	test("delete_element, set_property, set_text, add_keyframe and apply_keyframe_preset: each undone by a single undo", async () => {
		const { state, editor, run } = harness();
		for (const [tool, args] of [
			["delete_element", { elementId: "video" }],
			["set_property", { elementId: "video", property: "opacity", value: 0.5 }],
			["set_text", { elementId: "text", text: "Changed" }],
			["add_keyframe", { elementId: "video", property: "opacity", seconds: 2, value: 0.2 }],
			["apply_keyframe_preset", { elementId: "video", presetId: "zoom-in", seconds: 2 }],
		] as const) {
			const before = state.tracks;
			await run(tool, args);
			expect(state.tracks).not.toBe(before);
			editor.command.undo();
			expect(state.tracks).toBe(before);
		}
	});

	test("what the edits wrote is really there", async () => {
		const { state, run } = harness();
		await run("set_property", { elementId: "video", property: "opacity", value: 0.5 });
		expect(state.tracks.main.elements[0].params.opacity).toBe(0.5);
		await run("set_text", { elementId: "text", text: "Changed" });
		expect(state.tracks.overlay[0].elements[0].params.content).toBe("Changed");
		await run("apply_keyframe_preset", { elementId: "video", presetId: "zoom-in", seconds: 2 });
		expect(Object.keys(state.tracks.main.elements[0].animations ?? {})).toContain("transform.scaleX");
	});

	test("add_asset_to_timeline puts one clip in, undone in one step", async () => {
		const { state, editor, run } = harness();
		const before = state.tracks;
		const count = elementCount({ tracks: before });
		await run("add_asset_to_timeline", { assetId: "asset", startSeconds: 12 });
		expect(elementCount({ tracks: state.tracks })).toBe(count + 1);
		editor.command.undo();
		expect(state.tracks).toBe(before);
	});

	test("move_element moves a clip, one undo step", async () => {
		const { state, editor, run } = harness();
		const before = state.tracks;
		await run("move_element", { elementId: "video", startSeconds: 5 });
		expect(Number(state.tracks.main.elements[0].startTime)).toBe(5 * TICKS_PER_SECOND);
		editor.command.undo();
		expect(state.tracks).toBe(before);
	});

	test("a refused edit says why and changes nothing", async () => {
		const { state, run } = harness();
		const before = state.tracks;
		for (const [tool, args] of [
			["delete_element", { elementId: "ghost" }],
			["set_property", { elementId: "video", property: "nonsense", value: 1 }],
			["set_text", { elementId: "video", text: "x" }],
			["add_keyframe", { elementId: "video", property: "nonsense", seconds: 1, value: 1 }],
			["add_keyframe", { elementId: "video", property: "opacity", seconds: 99, value: 1 }],
			["apply_keyframe_preset", { elementId: "text", presetId: "volume-fade-in" }],
			["apply_keyframe_preset", { elementId: "video", presetId: "explode" }],
			["add_asset_to_timeline", { assetId: "ghost" }],
			["move_element", { elementId: "video", startSeconds: 1, trackId: "ghost" }],
		] as const) {
			await expect(run(tool, args)).rejects.toThrow();
		}
		expect(state.tracks).toBe(before);
	});

	test("read tools describe the project", async () => {
		const { run } = harness();
		expect(await run("list_elements", {})).toEqual([
			{ id: "text", trackId: "over", type: "text", name: expect.any(String), startSeconds: 0, durationSeconds: 4 },
			{ id: "video", trackId: "main", type: "video", name: "Clip", startSeconds: 0, durationSeconds: 10 },
		]);
		expect(await run("list_assets", {})).toEqual([{ id: "asset", name: "A", kind: "video", durationSeconds: 5 }]);
		expect(await run("get_project", {})).toMatchObject({ name: "P", width: 1920, fps: 30 });
	});
});
