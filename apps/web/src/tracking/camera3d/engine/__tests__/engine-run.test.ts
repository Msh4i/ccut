import { afterEach, describe, expect, test } from "bun:test";
import { cancelInteraction } from "@/editor/cancel-interaction";
import type { VideoElement } from "@/timeline";
import { unpackTracks } from "@/tracking/camera3d/codec";
import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	useCameraTrackerSession,
	type CameraTrackerRunOutcome,
} from "@/tracking/camera3d/session";
import type { CameraTrackerData } from "@/tracking/camera3d/types";
import { mediaTimeFromSeconds } from "@/wasm";
import { CAMERA_ANALYSIS_PROFILES, MAX_ANALYSIS_FPS } from "../analysis";
import { CAMERA_TRACKER_MESSAGES } from "../engine";
import { normalizeCameraTracker } from "../normalize";
import { listElements, sceneOf, textLayer, textTrack, videoClip } from "./editor-harness";
import {
	CLIP_MEDIA,
	engineHarness,
	gate,
	slidingFrames,
	solveFor,
	type EngineHarness,
} from "./engine-harness";
import { trackerData } from "./fixtures";

let current: EngineHarness | null = null;
afterEach(() => {
	current?.dispose();
	current = null;
});

function start(options: Parameters<typeof engineHarness>[0] = {}): EngineHarness {
	current = engineHarness(options);
	return current;
}

function clipNow({ h, id = "clip" }: { h: EngineHarness; id?: string }): VideoElement | null {
	const found = listElements({ tracks: h.editor.state.tracks }).find((entry) => entry.element.id === id)?.element;
	return found && found.type === "video" ? found : null;
}

function storedData({ h }: { h: EngineHarness }): CameraTrackerData | undefined {
	return clipNow({ h })?.cameraTracker;
}

function outcomeOf({ id = "clip" }: { id?: string } = {}): CameraTrackerRunOutcome | undefined {
	return useCameraTrackerSession.getState().outcomes[id];
}

describe("trackCamera: a full run", () => {
	test("analyses uniform source times, solves, writes the data in one undo step", async () => {
		const h = start({
			tracks: sceneOf({ main: [videoClip({ duration: 0.4, trim: 2, rate: 1.5 })] }),
		});
		const outcome = await h.engine.trackCamera({ elementId: "clip" });
		expect(outcome).toEqual({ status: "solved", elementId: "clip" });
		expect(outcomeOf()).toEqual(outcome);

		// the clip shows source 2 .. 2.6 s (0.4 s at 1.5x): 18 frames at 30 fps, frame i at 2 + i / 30
		expect(h.decodeCalls).toHaveLength(1);
		const times = h.decodeCalls[0].sourceTimes;
		expect(times).toHaveLength(18);
		times.forEach((time, i) => expect(time).toBeCloseTo(2 + i / 30, 9));
		expect(h.decodeCalls[0].maxWidth).toBe(CAMERA_ANALYSIS_PROFILES.normal.width);

		const data = storedData({ h });
		if (!data) throw new Error("nothing written");
		expect(data).toMatchObject({
			version: 1,
			mediaId: "media-clip",
			frameWidth: 1920,
			frameHeight: 1080,
			deletedTrackIds: [],
			failure: null,
			stale: "none",
			groundPlaneSet: false,
		});
		expect(data.sourceStart).toBeCloseTo(2, 9);
		expect(data.tracks.frameCount).toBe(18);
		expect(data.tracks.fps).toBe(30);
		expect(data.tracks.width).toBe(160);
		expect(data.solve?.frameCount).toBe(18);
		// what was written is what load accepts
		expect(normalizeCameraTracker(JSON.parse(JSON.stringify(data)))).toEqual(data);
		// the solver got the source frame size and the tracks
		expect(h.solveCalls[0].input).toMatchObject({ frameWidth: 1920, frameHeight: 1080 });
		expect(h.solveCalls[0].input.tracks.frameCount).toBe(18);

		// phases: analysing with progress, solving, then idle
		const kinds = h.phases.map((phase) => phase.phase);
		expect(kinds[0]).toBe("analyzing");
		expect(kinds).toContain("solving");
		expect(kinds.at(-1)).toBe("idle");
		const analysing = h.phases.flatMap((phase) => (phase.phase === "analyzing" ? [phase.progress] : []));
		expect(analysing.at(-1)).toBeCloseTo(1, 9);
		expect(useCameraTrackerSession.getState().phase).toEqual({ phase: "idle" });
		expect(h.editor.state.paused).toBe(1);

		// one undo step takes the data away again
		h.editor.editor.command.undo();
		expect(storedData({ h })).toBeUndefined();
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});

	test("analysis rate is the media's, at most 30 fps; Detailed Analysis asks for the wider frame", async () => {
		const h = start({
			tracks: sceneOf({ main: [videoClip({ duration: 0.5, extra: { cameraTracker: trackerData({ overrides: { stale: "analysis", settings: { ...trackerData().settings, detailedAnalysis: true } } }) } })] }),
			media: { "media-clip": { ...CLIP_MEDIA, fps: 24 } },
		});
		await h.engine.trackCamera({ elementId: "clip" });
		expect(h.decodeCalls[0].sourceTimes).toHaveLength(12);
		expect(h.decodeCalls[0].sourceTimes[1]).toBeCloseTo(1 / 24, 12);
		expect(h.decodeCalls[0].maxWidth).toBe(CAMERA_ANALYSIS_PROFILES.detailed.width);
		expect(storedData({ h })?.settings.detailedAnalysis).toBe(true);
		expect(storedData({ h })?.stale).toBe("none");

		h.media["media-clip"] = { ...CLIP_MEDIA, fps: 60 };
		h.editor.state.tracks = sceneOf({ main: [videoClip({ duration: 0.5 })] });
		await h.engine.trackCamera({ elementId: "clip" });
		expect(h.decodeCalls[1].sourceTimes).toHaveLength(15);
		expect(MAX_ANALYSIS_FPS).toBe(30);

		h.media["media-clip"] = { ...CLIP_MEDIA, fps: undefined };
		h.editor.state.tracks = sceneOf({ main: [videoClip({ duration: 0.5 })] });
		await h.engine.trackCamera({ elementId: "clip" });
		expect(h.decodeCalls[2].sourceTimes).toHaveLength(15);
	});

	test("without a known picture size the analysis frame size is used", async () => {
		const h = start({ media: { "media-clip": { ...CLIP_MEDIA, width: undefined, height: undefined } } });
		h.editor.state.tracks = sceneOf({ main: [videoClip({ duration: 0.2 })] });
		await h.engine.trackCamera({ elementId: "clip" });
		expect(storedData({ h })).toMatchObject({ frameWidth: 160, frameHeight: 90 });
	});
});

describe("trackCamera: refusals", () => {
	test("no open project", async () => {
		const h = start();
		h.scene.open = false;
		const outcome = await h.engine.trackCamera({ elementId: "clip" });
		expect(outcome).toEqual({ status: "failed", elementId: "clip", message: CAMERA_TRACKER_NOT_READY_MESSAGE });
		expect(h.decodeCalls).toHaveLength(0);
	});

	test("not a video clip, or gone", async () => {
		const h = start({ tracks: sceneOf({ overlay: [textTrack({ elements: [textLayer()] })] }) });
		expect(await h.engine.trackCamera({ elementId: "text" })).toEqual({
			status: "failed",
			elementId: "text",
			message: CAMERA_TRACKER_MESSAGES.notVideo,
		});
		expect(await h.engine.trackCamera({ elementId: "nope" })).toMatchObject({ status: "failed" });
		expect(h.decodeCalls).toHaveLength(0);
	});

	test("the media file is not loaded", async () => {
		const h = start({ media: { "media-clip": { ...CLIP_MEDIA, file: null } } });
		const outcome = await h.engine.trackCamera({ elementId: "clip" });
		expect(outcome).toEqual({ status: "failed", elementId: "clip", message: CAMERA_TRACKER_MESSAGES.mediaMissing });
		expect(outcomeOf()).toEqual(outcome);
	});

	test("a clip shorter than a frame", async () => {
		const h = start({ tracks: sceneOf({ main: [videoClip({ duration: 0 })] }) });
		expect(await h.engine.trackCamera({ elementId: "clip" })).toMatchObject({ status: "failed" });
		expect(h.decodeCalls).toHaveLength(0);
	});

	test("a clip longer than what a project may store", async () => {
		const h = start({ tracks: sceneOf({ main: [videoClip({ duration: 3600 })] }) });
		expect(await h.engine.trackCamera({ elementId: "clip" })).toEqual({
			status: "failed",
			elementId: "clip",
			message: CAMERA_TRACKER_MESSAGES.tooLong,
		});
		expect(h.decodeCalls).toHaveLength(0);
	});
});

describe("trackCamera: cancel, busy, failures", () => {
	/** Frames that stop before frame `at`: `entered` runs there, then the decoder waits for `door`. */
	function gatedDecoder({ at, door, entered }: { at: number; door: Promise<void>; entered: () => void }) {
		return ({ sourceTimes }: { sourceTimes: number[] }) =>
			(async function* () {
				const frames = slidingFrames({ count: sourceTimes.length });
				for (let i = 0; i < frames.length; i++) {
					if (i === at) {
						entered();
						await door;
					}
					yield frames[i];
				}
			})();
	}

	test("Cancel mid-analysis writes nothing, records the cancel, ends idle", async () => {
		const door = gate();
		const entered = gate();
		const h = start({ decode: gatedDecoder({ at: 3, door: door.wait, entered: entered.open }) });
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		expect(h.engine.running).toBe(true);
		expect(useCameraTrackerSession.getState().phase.phase).toBe("analyzing");
		h.engine.cancel();
		expect(await run).toEqual({ status: "cancelled", elementId: "clip" });
		expect(storedData({ h })).toBeUndefined();
		expect(h.solveCalls).toHaveLength(0);
		expect(outcomeOf()).toEqual({ status: "cancelled", elementId: "clip" });
		expect(useCameraTrackerSession.getState().phase).toEqual({ phase: "idle" });
		expect(h.engine.running).toBe(false);
		expect(h.editor.editor.command.canUndo()).toBe(false);
		door.open();
	});

	test("Esc cancels the run too", async () => {
		const door = gate();
		const entered = gate();
		const h = start({ decode: gatedDecoder({ at: 2, door: door.wait, entered: entered.open }) });
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		expect(cancelInteraction()).toBe(true);
		expect((await run).status).toBe("cancelled");
		expect(storedData({ h })).toBeUndefined();
		door.open();
	});

	test("Cancel while solving writes nothing", async () => {
		const door = gate();
		const entered = gate();
		const h = start({
			solve: async ({ args }) => {
				entered.open();
				await door.wait;
				return args.signal?.aborted ? { status: "cancelled" } : { status: "solved", solve: solveFor({ args }) };
			},
		});
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		expect(useCameraTrackerSession.getState().phase.phase).toBe("solving");
		h.engine.cancel();
		door.open();
		expect((await run).status).toBe("cancelled");
		expect(storedData({ h })).toBeUndefined();
	});

	test("a solver that answers solved after a cancel still writes nothing", async () => {
		const door = gate();
		const entered = gate();
		const h = start({
			solve: async ({ args }) => {
				entered.open();
				await door.wait;
				return { status: "solved", solve: solveFor({ args }) };
			},
		});
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		h.engine.cancel();
		door.open();
		expect((await run).status).toBe("cancelled");
		expect(storedData({ h })).toBeUndefined();
	});

	test("one job at a time: a second run is told busy and changes nothing", async () => {
		const door = gate();
		const entered = gate();
		const h = start({
			tracks: sceneOf({ main: [videoClip(), videoClip({ id: "second", start: 4 })] }),
			decode: gatedDecoder({ at: 1, door: door.wait, entered: entered.open }),
		});
		const first = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		const busy = await h.engine.trackCamera({ elementId: "second" });
		expect(busy).toEqual({ status: "busy", elementId: "second", message: CAMERA_TRACKER_MESSAGES.busy });
		expect(outcomeOf({ id: "second" })).toBeUndefined();
		expect((await h.engine.resolve({ elementId: "clip" })).status).toBe("busy");
		door.open();
		expect((await first).status).toBe("solved");
		expect(h.decodeCalls).toHaveLength(1);
	});

	test("a failed solve writes nothing, records the message, and keeps the analysis for the next try", async () => {
		let fail = true;
		const h = start({
			solve: async ({ args }) =>
				fail
					? { status: "failed", reason: "no-motion", message: "The camera does not move: nothing to solve." }
					: { status: "solved", solve: solveFor({ args }) },
		});
		const outcome = await h.engine.trackCamera({ elementId: "clip" });
		expect(outcome).toEqual({ status: "failed", elementId: "clip", message: "The camera does not move: nothing to solve." });
		expect(outcomeOf()).toEqual(outcome);
		expect(storedData({ h })).toBeUndefined();
		expect(h.editor.editor.command.canUndo()).toBe(false);

		// the user picks Tripod Pan (a solve setting) and tries again: no second analysis
		h.engine.updateSettings({ elementId: "clip", patch: { solveMethod: "tripod-pan" } });
		fail = false;
		expect((await h.engine.trackCamera({ elementId: "clip" })).status).toBe("solved");
		expect(h.decodeCalls).toHaveLength(1);
		expect(h.solveCalls[1].input.settings.solveMethod).toBe("tripod-pan");
		expect(storedData({ h })?.settings.solveMethod).toBe("tripod-pan");
	});

	test("a solver that throws is a failure, not a crash", async () => {
		const h = start({
			solve: async () => {
				throw new Error("matrix exploded");
			},
		});
		const outcome = await h.engine.trackCamera({ elementId: "clip" });
		expect(outcome).toMatchObject({ status: "failed", message: CAMERA_TRACKER_MESSAGES.solverFailed });
		expect(useCameraTrackerSession.getState().phase).toEqual({ phase: "idle" });
	});

	test("a decoder that fails is a failure with its reason", async () => {
		const h = start({
			decode: () =>
				(async function* () {
					yield slidingFrames({ count: 1 })[0];
					throw new Error("Video codec not supported for decoding");
				})(),
		});
		const outcome = await h.engine.trackCamera({ elementId: "clip" });
		expect(outcome).toEqual({ status: "failed", elementId: "clip", message: "Video codec not supported for decoding" });
		expect(h.solveCalls).toHaveLength(0);
		expect(h.engine.running).toBe(false);
	});

	test("frames too small for the tracker", async () => {
		const h = start({
			decode: () => [{ w: 2, h: 2, data: new Uint8Array(4) }],
		});
		expect(await h.engine.trackCamera({ elementId: "clip" })).toEqual({
			status: "failed",
			elementId: "clip",
			message: CAMERA_TRACKER_MESSAGES.frameTooSmall,
		});
	});
});

describe("trackCamera: the clip changes under a run", () => {
	test("deleted mid-analysis: nothing written, the run stops", async () => {
		const door = gate();
		const entered = gate();
		let pulled = 0;
		const h = start({
			decode: ({ sourceTimes }) =>
				(async function* () {
					for (const frame of slidingFrames({ count: sourceTimes.length })) {
						pulled++;
						if (pulled === 4) {
							entered.open();
							await door.wait;
						}
						yield frame;
					}
				})(),
		});
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		h.editor.state.tracks = sceneOf({ main: [] });
		door.open();
		const outcome = await run;
		expect(outcome).toEqual({ status: "failed", elementId: "clip", message: CAMERA_TRACKER_MESSAGES.clipChanged });
		expect(h.solveCalls).toHaveLength(0);
		expect(pulled).toBeLessThan(12);
		// nothing to show it on: a deleted clip gets no outcome
		expect(outcomeOf()).toBeUndefined();
	});

	test("media replaced mid-solve: nothing written", async () => {
		const door = gate();
		const entered = gate();
		const h = start({
			solve: async ({ args }) => {
				entered.open();
				await door.wait;
				return { status: "solved", solve: solveFor({ args }) };
			},
		});
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		h.editor.state.tracks = sceneOf({ main: [videoClip({ mediaId: "other-media" })] });
		door.open();
		expect(await run).toEqual({ status: "failed", elementId: "clip", message: CAMERA_TRACKER_MESSAGES.clipChanged });
		expect(storedData({ h })).toBeUndefined();
		expect(outcomeOf()).toMatchObject({ status: "failed" });
	});

	test("the editor session ends mid-run: nothing written afterwards", async () => {
		const door = gate();
		const entered = gate();
		const h = start({
			solve: async ({ args }) => {
				entered.open();
				await door.wait;
				return { status: "solved", solve: solveFor({ args }) };
			},
		});
		const run = h.engine.trackCamera({ elementId: "clip" });
		await entered.wait;
		h.engine.dispose();
		door.open();
		expect((await run).status).toBe("cancelled");
		expect(storedData({ h })).toBeUndefined();
		expect(useCameraTrackerSession.getState().phase).toEqual({ phase: "idle" });
	});
});

describe("re-using the analysis", () => {
	test("Track Camera on a solved clip with nothing changed does nothing (keeps a Set Ground Plane)", async () => {
		const stored = trackerData({ frameCount: 6, overrides: { groundPlaneSet: true } });
		const h = start({ tracks: sceneOf({ main: [videoClip({ duration: 0.2, extra: { cameraTracker: stored } })] }) });
		expect(await h.engine.trackCamera({ elementId: "clip" })).toEqual({ status: "solved", elementId: "clip" });
		expect(h.decodeCalls).toHaveLength(0);
		expect(h.solveCalls).toHaveLength(0);
		expect(storedData({ h })).toBe(stored);
		expect(h.editor.editor.command.canUndo()).toBe(false);
	});

	test("Track Camera on a clip whose solve is stale solves again from the stored tracks (no decode)", async () => {
		const stored = trackerData({ frameCount: 6, overrides: { deletedTrackIds: [1, 2], stale: "solve" } });
		const h = start({ tracks: sceneOf({ main: [videoClip({ duration: 0.2, extra: { cameraTracker: stored } })] }) });
		expect((await h.engine.trackCamera({ elementId: "clip" })).status).toBe("solved");
		expect(h.decodeCalls).toHaveLength(0);
		expect([...(h.solveCalls[0].input.excludedTrackIds ?? [])]).toEqual([1, 2]);
		const data = storedData({ h });
		expect(data?.tracks).toBe(stored.tracks);
		expect(data?.deletedTrackIds).toEqual([1, 2]);
	});

	test("an analysis-stale, other-media or too-short stored analysis is redone", async () => {
		for (const [name, stored, clip] of [
			["stale", trackerData({ overrides: { stale: "analysis" } }), {}],
			["media", trackerData({ overrides: { mediaId: "old-media" } }), {}],
			["range", trackerData({ frameCount: 6 }), { duration: 3 }],
		] as const) {
			const h = start({
				tracks: sceneOf({ main: [videoClip({ duration: 0.2, ...clip, extra: { cameraTracker: stored } })] }),
			});
			expect((await h.engine.trackCamera({ elementId: "clip" })).status).toBe("solved");
			expect([name, h.decodeCalls.length]).toEqual([name, 1]);
			h.dispose();
			current = null;
		}
	});

	test("resolve solves from the stored tracks with the current settings; a missing analysis is refused", async () => {
		const stored = trackerData({ frameCount: 6, overrides: { stale: "solve", settings: { ...trackerData().settings, shotType: "variable-zoom" } } });
		const h = start({ tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: stored } }), videoClip({ id: "fresh", start: 5 })] }) });
		expect(await h.engine.resolve({ elementId: "clip" })).toEqual({ status: "solved", elementId: "clip" });
		expect(h.decodeCalls).toHaveLength(0);
		expect(h.solveCalls[0].input.settings.shotType).toBe("variable-zoom");
		expect(unpackTracks(stored.tracks)?.frameCount).toBe(h.solveCalls[0].input.tracks.frameCount);
		expect(storedData({ h })?.stale).toBe("none");
		expect(await h.engine.resolve({ elementId: "fresh" })).toEqual({
			status: "failed",
			elementId: "fresh",
			message: CAMERA_TRACKER_MESSAGES.noAnalysis,
		});
	});

	test("settings changed while solving: the result is written but marked stale", async () => {
		const door = gate();
		const entered = gate();
		const stored = trackerData({ frameCount: 6, overrides: { stale: "solve" } });
		const h = start({
			tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: stored } })] }),
			solve: async ({ args }) => {
				entered.open();
				await door.wait;
				return { status: "solved", solve: solveFor({ args }) };
			},
		});
		const run = h.engine.resolve({ elementId: "clip" });
		await entered.wait;
		h.engine.updateSettings({ elementId: "clip", patch: { shotType: "specify-angle" } });
		h.engine.deletePoints({ elementId: "clip", trackIds: [4] });
		door.open();
		expect((await run).status).toBe("solved");
		const data = storedData({ h });
		expect(data?.solve).not.toEqual(stored.solve);
		expect(data?.settings.shotType).toBe("specify-angle");
		expect(data?.deletedTrackIds).toEqual([4]);
		expect(data?.stale).toBe("solve");
	});

	test("the stored analysis replaced while solving (undo): the result is dropped", async () => {
		const door = gate();
		const entered = gate();
		const stored = trackerData({ frameCount: 6 });
		const h = start({
			tracks: sceneOf({ main: [videoClip({ extra: { cameraTracker: stored } })] }),
			solve: async ({ args }) => {
				entered.open();
				await door.wait;
				return { status: "solved", solve: solveFor({ args }) };
			},
		});
		const run = h.engine.resolve({ elementId: "clip" });
		await entered.wait;
		h.editor.state.tracks = sceneOf({ main: [videoClip({ extra: { cameraTracker: trackerData({ frameCount: 7 }) } })] });
		door.open();
		expect(await run).toMatchObject({ status: "failed", message: CAMERA_TRACKER_MESSAGES.clipChanged });
		expect(storedData({ h })?.tracks.frameCount).toBe(7);
	});
});

describe("timing helpers", () => {
	test("source time of the playhead maps to the analysis frame (trim, retime, offset)", async () => {
		const { analysisFrameAt } = await import("../engine");
		const clip = videoClip({ start: 10, trim: 3, rate: 2 });
		const data = trackerData({ overrides: { sourceStart: 3.5 } });
		// timeline 11 s = clip 1 s = source 3 + 2 = 5 s = 1.5 s after the analysis start = frame 45 at 30 fps
		expect(analysisFrameAt({ clip, data, time: mediaTimeFromSeconds({ seconds: 11 }) })).toBeCloseTo(45, 6);
	});
});
