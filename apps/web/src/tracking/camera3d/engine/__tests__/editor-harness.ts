import { spyOn } from "bun:test";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { TimelineManager } from "@/core/managers/timeline-manager";
import type { MediaAsset } from "@/media/types";
import type {
	CameraElement,
	CameraTrack,
	GraphicTrack,
	OverlayTrack,
	SceneTracks,
	TextElement,
	TextTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTimeFromSeconds, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * A stand-in for the editor with the REAL TimelineManager and CommandManager
 * over an in-memory scene, so commands, undo and redo run as in the app.
 * `restore` puts `EditorCore.getInstance` back.
 */
export interface EditorHarness {
	editor: EditorCore;
	state: {
		tracks: SceneTracks;
		playhead: MediaTime;
		assets: MediaAsset[];
		canvas: { width: number; height: number };
		paused: number;
	};
	restore: () => void;
}

export const sec = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });

export function videoClip({
	id = "clip",
	mediaId = "media-clip",
	start = 0,
	duration = 4,
	trim = 0,
	rate,
	extra = {},
}: {
	id?: string;
	mediaId?: string;
	start?: number;
	duration?: number;
	trim?: number;
	rate?: number;
	extra?: Partial<VideoElement>;
} = {}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: sec(trim),
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		hidden: false,
		...(rate === undefined ? {} : { retime: { rate } }),
		...extra,
	};
}

export function textLayer({
	id = "text",
	start = 0,
	duration = 4,
	params = {},
}: {
	id?: string;
	start?: number;
	duration?: number;
	params?: TextElement["params"];
} = {}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: "Hello", ...params },
	};
}

export function cameraLayer({
	id = "camera",
	sourceElementId = "clip",
	start = 0,
	duration = 4,
	hidden,
}: {
	id?: string;
	sourceElementId?: string;
	start?: number;
	duration?: number;
	hidden?: boolean;
} = {}): CameraElement {
	return {
		id,
		type: "camera",
		name: id,
		sourceElementId,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		...(hidden === undefined ? {} : { hidden }),
	};
}

export function textTrack({ id = "text-track", elements }: { id?: string; elements: TextElement[] }): TextTrack {
	return { id, name: id, type: "text", hidden: false, elements };
}

export function cameraTrack({ id = "camera-track", elements }: { id?: string; elements: CameraElement[] }): CameraTrack {
	return { id, name: id, type: "camera", hidden: false, elements };
}

export function graphicTrack({ id = "graphic-track", elements }: { id?: string; elements: GraphicTrack["elements"] }): GraphicTrack {
	return { id, name: id, type: "graphic", hidden: false, elements };
}

export function sceneOf({
	main = [videoClip()],
	overlay = [],
}: {
	main?: VideoElement[];
	overlay?: OverlayTrack[];
} = {}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: main,
	};
	return { main: mainTrack, overlay, audio: [] };
}

export function createEditorHarness({
	tracks = sceneOf(),
	assets = [],
	canvas = { width: 1920, height: 1080 },
}: {
	tracks?: SceneTracks;
	assets?: MediaAsset[];
	canvas?: { width: number; height: number };
} = {}): EditorHarness {
	const state: EditorHarness["state"] = {
		tracks,
		playhead: ZERO_MEDIA_TIME,
		assets,
		canvas,
		paused: 0,
	};
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const editor: EditorCore = Object.create(EditorCore.prototype);
	Object.assign(editor, {
		scenes: {
			getActiveScene: () => ({ tracks: state.tracks }),
			getActiveSceneOrNull: () => ({ tracks: state.tracks }),
			getScenes: () => [{ tracks: state.tracks }],
			updateSceneTracks: ({ tracks: next }: { tracks: SceneTracks }) => {
				state.tracks = next;
				for (const listener of listeners) listener();
			},
			subscribe,
		},
		selection: {
			getSnapshot: () => ({}),
			applySelectionPatch: () => ({}),
			restoreSnapshot: () => {},
		},
		playback: {
			getCurrentTime: () => state.playhead,
			pause: () => {
				state.paused++;
			},
		},
		media: { getAssets: () => state.assets },
		project: {
			getActive: () => ({ settings: { canvasSize: state.canvas } }),
			getActiveOrNull: () => ({
				metadata: { id: "project" },
				settings: { canvasSize: state.canvas, fps: { numerator: 30, denominator: 1 } },
			}),
			updateSettings: () => {},
			subscribe,
		},
	});
	Object.assign(editor, {
		timeline: new TimelineManager(editor),
		command: new CommandManager(editor),
	});
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	return { editor, state, restore: () => spy.mockRestore() };
}

/** Every element of the scene with the track it is on, top to bottom. */
export function listElements({ tracks }: { tracks: SceneTracks }) {
	return [...tracks.overlay, tracks.main, ...tracks.audio].flatMap((track) =>
		track.elements.map((element) => ({ trackId: track.id, trackType: track.type, element })),
	);
}
