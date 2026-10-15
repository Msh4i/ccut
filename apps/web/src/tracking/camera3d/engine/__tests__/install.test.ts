import { afterEach, describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	getCameraTrackerApi,
	useCameraTrackerSession,
} from "@/tracking/camera3d/session";
import { CAMERA_TRACKER_MESSAGES } from "../engine";
import { installCameraTrackerEngine, type CameraTrackerEditor } from "../install";
import { solverUnavailable, SOLVER_UNAVAILABLE_MESSAGE } from "../solver-placeholder";
import { sceneOf, videoClip } from "./editor-harness";
import { gate, slidingFrames } from "./engine-harness";

type Channel = "project" | "timeline" | "scenes";

function fakeEditor({ tracks = sceneOf() }: { tracks?: SceneTracks } = {}) {
	const listeners: Record<Channel, Set<() => void>> = {
		project: new Set(),
		timeline: new Set(),
		scenes: new Set(),
	};
	const state = { projectId: "p1" as string | null, tracks, paused: 0, file: null as File | null };
	const on = (channel: Channel) => (listener: () => void) => {
		listeners[channel].add(listener);
		return () => {
			listeners[channel].delete(listener);
		};
	};
	const editor: CameraTrackerEditor = {
		playback: {
			pause: () => {
				state.paused++;
			},
			getCurrentTime: () => tracks.main.elements[0]?.startTime ?? sceneOf().main.elements[0].startTime,
		},
		project: {
			subscribe: on("project"),
			getActiveOrNull: () =>
				state.projectId === null
					? null
					: { metadata: { id: state.projectId }, settings: { canvasSize: { width: 1920, height: 1080 } } },
		},
		timeline: {
			subscribe: on("timeline"),
			setCameraTracker: () => {},
			deleteTrackPoints: () => false,
			setGroundPlane: () => {},
			createTrackedLayers: () => ({ elementIds: [], cameraElementId: null }),
		},
		scenes: {
			subscribe: on("scenes"),
			getActiveSceneOrNull: () => ({ tracks: state.tracks }),
			getScenes: () => [{ tracks: state.tracks }],
		},
		media: {
			getAssets: () =>
				state.file
					? [{ id: "media-clip", file: state.file, type: "video" as const, name: "clip.mp4", width: 1920, height: 1080, fps: 30 }]
					: [],
		},
	};
	const notify = (channel: Channel) => {
		for (const listener of listeners[channel]) listener();
	};
	const listening = () => listeners.project.size + listeners.timeline.size + listeners.scenes.size;
	return { editor, state, notify, listening };
}

const teardowns: Array<() => void> = [];
afterEach(() => {
	for (const teardown of teardowns.splice(0)) teardown();
	useCameraTrackerSession.setState({ phase: { phase: "idle" }, outcomes: {} });
});

function install(options: Parameters<typeof installCameraTrackerEngine>[0]): () => void {
	const teardown = installCameraTrackerEngine(options);
	teardowns.push(teardown);
	return teardown;
}

describe("installCameraTrackerEngine", () => {
	test("registers the API for the session and unregisters on teardown", () => {
		const fake = fakeEditor();
		const teardown = install({ editor: fake.editor, solveCamera: solverUnavailable });
		expect(getCameraTrackerApi()).not.toBeNull();
		expect(fake.listening()).toBe(3);
		teardown();
		expect(getCameraTrackerApi()).toBeNull();
		expect(fake.listening()).toBe(0);
		teardown();
	});

	test("installing again replaces the earlier engine (hot reload)", () => {
		const first = fakeEditor();
		const second = fakeEditor();
		const oldTeardown = install({ editor: first.editor, solveCamera: solverUnavailable });
		const oldApi = getCameraTrackerApi();
		install({ editor: second.editor, solveCamera: solverUnavailable });
		expect(getCameraTrackerApi()).not.toBe(oldApi);
		expect(first.listening()).toBe(0);
		oldTeardown();
		expect(getCameraTrackerApi()).not.toBeNull();
	});

	test("reads the clip and its media from the editor", async () => {
		const fake = fakeEditor();
		install({ editor: fake.editor, solveCamera: solverUnavailable });
		const api = getCameraTrackerApi();
		expect(await api?.trackCamera({ elementId: "clip" })).toEqual({
			status: "failed",
			elementId: "clip",
			message: CAMERA_TRACKER_MESSAGES.mediaMissing,
		});
		fake.state.projectId = null;
		expect(await api?.trackCamera({ elementId: "clip" })).toEqual({
			status: "failed",
			elementId: "clip",
			message: CAMERA_TRACKER_NOT_READY_MESSAGE,
		});
	});

	test("the placeholder solver fails clearly and nothing is written", async () => {
		const fake = fakeEditor({ tracks: sceneOf({ main: [videoClip({ duration: 0.2 })] }) });
		fake.state.file = new File([], "clip.mp4");
		const writes: string[] = [];
		fake.editor.timeline.setCameraTracker = () => {
			writes.push("set");
		};
		install({
			editor: fake.editor,
			solveCamera: solverUnavailable,
			deps: { decode: ({ sourceTimes }) => (async function* () { yield* slidingFrames({ count: sourceTimes.length }); })(), yieldToUi: () => Promise.resolve() },
		});
		const outcome = await getCameraTrackerApi()?.trackCamera({ elementId: "clip" });
		expect(outcome).toEqual({ status: "failed", elementId: "clip", message: SOLVER_UNAVAILABLE_MESSAGE });
		expect(writes).toEqual([]);
		expect(fake.state.paused).toBe(1);
	});

	test("a deleted clip's outcome goes, another project's session goes entirely", async () => {
		const fake = fakeEditor({ tracks: sceneOf({ main: [videoClip(), videoClip({ id: "other", start: 5 })] }) });
		install({ editor: fake.editor, solveCamera: solverUnavailable });
		const api = getCameraTrackerApi();
		await api?.trackCamera({ elementId: "clip" });
		await api?.trackCamera({ elementId: "other" });
		expect(Object.keys(useCameraTrackerSession.getState().outcomes).sort()).toEqual(["clip", "other"]);

		fake.state.tracks = sceneOf({ main: [videoClip({ id: "other", start: 5 })] });
		fake.notify("timeline");
		expect(Object.keys(useCameraTrackerSession.getState().outcomes)).toEqual(["other"]);

		fake.state.projectId = "p2";
		fake.notify("project");
		expect(useCameraTrackerSession.getState().outcomes).toEqual({});
	});

	test("teardown stops a running job and forgets the session's outcomes", async () => {
		const fake = fakeEditor({ tracks: sceneOf({ main: [videoClip({ duration: 0.2 }), videoClip({ id: "other", start: 5 })] }) });
		fake.state.file = new File([], "clip.mp4");
		const door = gate();
		const entered = gate();
		const teardown = install({
			editor: fake.editor,
			solveCamera: solverUnavailable,
			deps: {
				decode: () =>
					(async function* () {
						entered.open();
						await door.wait;
						yield* slidingFrames({ count: 1 });
					})(),
				yieldToUi: () => Promise.resolve(),
			},
		});
		const api = getCameraTrackerApi();
		await api?.trackCamera({ elementId: "missing" });
		useCameraTrackerSession.getState().recordOutcome({ status: "cancelled", elementId: "other" });
		const run = api?.trackCamera({ elementId: "clip" });
		await entered.wait;
		expect(useCameraTrackerSession.getState().phase.phase).toBe("analyzing");
		teardown();
		expect(useCameraTrackerSession.getState().phase).toEqual({ phase: "idle" });
		expect(useCameraTrackerSession.getState().outcomes).toEqual({});
		expect((await run)?.status).toBe("cancelled");
		door.open();
	});
});
