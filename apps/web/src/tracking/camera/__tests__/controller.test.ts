import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cancelInteraction } from "@/editor/cancel-interaction";
import type { Transform } from "@/rendering";
import type { OverlayTrack, SceneTracks, TextElement, VideoElement } from "@/timeline";
import type { GrayFrame } from "@/tracking/types";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import type { CameraAnalysisJob, CameraPinOutcome } from "../analysis-types";
import { AnalysisCache } from "../analysis-cache";
import { type AnalysisOutcome, analyze } from "../analysis-service";
import {
	type CameraPinControllerDeps,
	type CameraPinEditor,
	type CameraPinPlanLike,
	createCameraPinController,
	installCameraPinController,
	MEDIA_FILE_MISSING_MESSAGE,
	NOT_STUCK_MESSAGE,
} from "../controller";
import {
	CAMERA_PIN_MESSAGES,
	type CameraPinErrorCode,
	type CameraPinRecord,
	type PinScene,
} from "../pin-element";
import { buildPinView } from "../pin-view";
import { registerCameraPinController, resetCameraPinStore, useCameraPinStore } from "../store";
import { fakeAnalysis } from "./analysis-fixtures";

const IDLE_JOB: CameraAnalysisJob = { state: "idle", hostElementId: null, progress: 0 };

const sec = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });
const FILE = new File([], "clip.mp4");
const CANVAS = { width: 1920, height: 1080 };

// ---------------------------------------------------------------------------
// Scene fixtures
// ---------------------------------------------------------------------------

function video({
	id = "main-video",
	mediaId = "m-main",
	start = 0,
	duration = 10,
	trim = 0,
	rate,
}: {
	id?: string;
	mediaId?: string;
	start?: number;
	duration?: number;
	trim?: number;
	rate?: number;
} = {}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: sec(trim),
		trimEnd: sec(0),
		params: {},
		hidden: false,
		...(rate === undefined ? {} : { retime: { rate } }),
	};
}

function title({ id = "title", start = 1, duration = 3 }: { id?: string; start?: number; duration?: number } = {}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: sec(0),
		trimEnd: sec(0),
		params: { content: "Hello" },
	};
}

function textTrack({ elements }: { elements: TextElement[] }): OverlayTrack {
	return { id: "text-track", name: "text-track", type: "text", hidden: false, elements };
}

function tracksOf({ main = [video()], overlay = [textTrack({ elements: [title()] })] }: { main?: VideoElement[]; overlay?: OverlayTrack[] } = {}): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: main },
		overlay,
		audio: [],
	};
}

function pinnedPlan({
	elementId = "title",
	analysisId = "id-1",
	mode = "scene",
}: {
	elementId?: string;
	analysisId?: string;
	mode?: "scene" | "object";
} = {}): CameraPinPlanLike {
	const pin: CameraPinRecord = {
		elementId,
		trackId: "text-track",
		analysisId,
		hostElementId: "main-video",
		mode,
		model: "S",
		range: { start: sec(0), end: sec(3) },
		host: { mediaId: "m-main", startTime: sec(0), duration: sec(10), trimStart: sec(0), rate: 1 },
	};
	return {
		status: "pinned",
		elementId,
		notices: ["low-quality"],
		lostFrame: 7,
		cutTimes: [3.5],
		mode,
		model: "S",
		pin,
	};
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type AnalyzeArgs = Parameters<CameraPinControllerDeps["analyze"]>[0];

interface Harness {
	controller: ReturnType<typeof createCameraPinController>;
	state: { tracks: SceneTracks; playhead: number; file: File | null };
	paused: () => number;
	analyzeCalls: AnalyzeArgs[];
	stickCalls: Parameters<CameraPinControllerDeps["stick"]>[0][];
	repinCalls: Parameters<CameraPinControllerDeps["repin"]>[0][];
	/** The store's job as the fake analysis saw it when it started. */
	jobsSeen: CameraAnalysisJob[];
	/** Lets a gated analysis go on. */
	release: () => void;
}

function harness({
	tracks = tracksOf(),
	analysis = ({ window }: AnalyzeArgs): AnalysisOutcome => ({
		status: "complete",
		analysis: fakeAnalysis({
			id: "id-1",
			hostElementId: "main-video",
			mediaId: "m-main",
			sourceStart: window.start,
			frameCount: Math.round((window.end - window.start) * 30),
		}),
	}),
	stick = () => pinnedPlan(),
	repin = () => pinnedPlan({ analysisId: "id-1" }),
	gate = false,
	midRun,
	readTracks,
	ignoreSignal = false,
}: {
	tracks?: SceneTracks;
	analysis?: (args: AnalyzeArgs) => AnalysisOutcome | Promise<AnalysisOutcome>;
	stick?: CameraPinControllerDeps["stick"];
	repin?: CameraPinControllerDeps["repin"];
	/** Hold the fake analysis until `release` is called: every call, or the calls (0-based) the function picks. */
	gate?: boolean | ((index: number) => boolean);
	/** Runs inside the fake analysis, before its first progress report. */
	midRun?: (args: AnalyzeArgs) => void;
	/** The scene's tracks from elsewhere (a fake editor), instead of the harness' own. */
	readTracks?: () => SceneTracks;
	/** The fake analysis answers as if it never looked at the abort signal. */
	ignoreSignal?: boolean;
} = {}): Harness {
	const state = {
		tracks,
		playhead: 2,
		file: FILE as File | null,
	};
	const tracksNow = readTracks ?? (() => state.tracks);
	let pausedCount = 0;
	let release = () => {};
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	const analyzeCalls: AnalyzeArgs[] = [];
	const stickCalls: Harness["stickCalls"] = [];
	const repinCalls: Harness["repinCalls"] = [];
	const jobsSeen: CameraAnalysisJob[] = [];
	const deps: CameraPinControllerDeps = {
		readScene: (): PinScene => ({
			tracks: tracksNow(),
			canvasSize: CANVAS,
			mediaSize: () => ({ width: 1920, height: 1080 }),
			playhead: sec(state.playhead),
		}),
		pause: () => {
			pausedCount++;
		},
		getProjectFps: () => 30,
		mediaFile: ({ mediaId }) => (mediaId === "m-main" ? state.file : null),
		analyze: async (args) => {
			const index = analyzeCalls.length;
			analyzeCalls.push(args);
			jobsSeen.push(useCameraPinStore.getState().job);
			midRun?.(args);
			args.onProgress?.({ fraction: 0.5 });
			if (typeof gate === "function" ? gate(index) : gate) await opened;
			if (args.signal.aborted && !ignoreSignal) return { status: "cancelled" };
			return analysis(args);
		},
		stick: (args) => {
			stickCalls.push(args);
			return stick(args);
		},
		repin: (args) => {
			repinCalls.push(args);
			return repin(args);
		},
	};
	return {
		controller: createCameraPinController({ deps }),
		state,
		paused: () => pausedCount,
		analyzeCalls,
		stickCalls,
		repinCalls,
		jobsSeen,
		release: () => release(),
	};
}

function store() {
	return useCameraPinStore.getState();
}

/** Lets the gated analysis start (the controller awaits it after pausing and publishing the job). */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

const PINNED_OUTCOME: CameraPinOutcome = {
	status: "pinned",
	elementId: "title",
	notices: ["low-quality"],
	lostFrame: 7,
	cutTimes: [3.5],
	mode: "scene",
	model: "S",
};

describe("createCameraPinController: stick", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	test("pauses, publishes the job, analyses the window under the element, sticks and records the pin", async () => {
		const h = harness();
		const outcome = await h.controller.stick({ elementId: "title" });

		expect(h.paused()).toBe(1);
		expect(h.analyzeCalls).toHaveLength(1);
		const [args] = h.analyzeCalls;
		expect(args.hostElementId).toBe("main-video");
		expect(args.host.mediaId).toBe("m-main");
		expect(args.file).toBe(FILE);
		expect(args.window).toEqual({ start: 1, end: 4 });
		expect(args.projectFps).toBe(30);
		// the job belonged to the host while it ran, and took the progress reports
		expect(h.jobsSeen[0]).toEqual({ state: "running", hostElementId: "main-video", progress: 0 });

		expect(outcome).toEqual(PINNED_OUTCOME);
		expect(h.stickCalls).toHaveLength(1);
		expect(h.stickCalls[0].elementId).toBe("title");
		expect(h.stickCalls[0].analysis.id).toBe("id-1");
		expect(h.stickCalls[0].mode).toBeUndefined();

		const state = store();
		expect(state.outcomes.title).toEqual(outcome);
		expect(state.pins.title?.analysisId).toBe("id-1");
		expect(state.job).toEqual({ state: "idle", hostElementId: null, progress: 0 });
		expect(h.controller.cache.byId({ analysisId: "id-1" })).not.toBeNull();
	});

	test("the progress reports reach the job", async () => {
		const seen: { job: CameraAnalysisJob | null } = { job: null };
		const h = harness({
			// runs after the fake's progress report of 0.5
			analysis: ({ window }) => {
				seen.job = store().job;
				return {
					status: "complete",
					analysis: fakeAnalysis({ id: "id-1", hostElementId: "main-video", mediaId: "m-main", sourceStart: window.start, frameCount: 90 }),
				};
			},
		});
		await h.controller.stick({ elementId: "title" });
		expect(seen.job).toEqual({ state: "running", hostElementId: "main-video", progress: 0.5 });
	});

	test("a second stick on the same host is served from the cache: no job, no pause", async () => {
		const h = harness();
		await h.controller.stick({ elementId: "title" });
		const again = await h.controller.stick({ elementId: "title", mode: "object" });
		expect(again.status).toBe("pinned");
		expect(h.analyzeCalls).toHaveLength(1);
		expect(h.paused()).toBe(1);
		expect(h.stickCalls).toHaveLength(2);
		expect(h.stickCalls[1].mode).toBe("object");
		expect(h.stickCalls[1].analysis).toBe(h.stickCalls[0].analysis);
	});

	test("a cached analysis that does not cover the element's window is not used", async () => {
		const h = harness({ tracks: tracksOf({ overlay: [textTrack({ elements: [title({ id: "title", start: 1, duration: 3 }), title({ id: "late", start: 6, duration: 2 })] })] }) });
		await h.controller.stick({ elementId: "title" });
		await h.controller.stick({ elementId: "late" });
		expect(h.analyzeCalls).toHaveLength(2);
		expect(h.analyzeCalls[1].window).toEqual({ start: 6, end: 8 });
	});

	test("a no-keys plan is reported as such and records no pin", async () => {
		const h = harness({
			stick: ({ elementId }) => ({
				status: "no-keys",
				elementId,
				notices: ["no-motion"],
				lostFrame: null,
				frames: { first: 0, last: 10, pin: 3 },
			}),
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toEqual({ status: "no-keys", elementId: "title", notices: ["no-motion"], lostFrame: null });
		expect(store().pins).toEqual({});
		expect(store().outcomes.title).toEqual(outcome);
	});

	test("every plan failure comes out with its code and message", async () => {
		const codes: CameraPinErrorCode[] = [
			"no-element",
			"unsupported-element",
			"no-video",
			"no-box",
			"bad-geometry",
			"analysis-mismatch",
			"analysis-cancelled",
			"analysis-outside",
			"stale-pin",
			"apply-failed",
			"busy",
			"host-changed",
			"analysis-failed",
		];
		expect(Object.keys(CAMERA_PIN_MESSAGES).sort()).toEqual([...codes].sort());
		for (const error of codes) {
			resetCameraPinStore();
			const h = harness({
				stick: () => ({ status: "error", error, message: CAMERA_PIN_MESSAGES[error] }),
			});
			const outcome = await h.controller.stick({ elementId: "title" });
			expect(outcome).toEqual({
				status: "error",
				error,
				message: CAMERA_PIN_MESSAGES[error],
				elementId: "title",
			});
			expect(store().pins).toEqual({});
			expect(store().job.state).toBe("idle");
		}
	});

	test("cancel stops the job: no keys, no pin, nothing cached, the job idle", async () => {
		const h = harness({ gate: true });
		const run = h.controller.stick({ elementId: "title" });
		await settle();
		expect(store().job.state).toBe("running");

		h.controller.cancel();
		h.release();
		const outcome = await run;

		expect(outcome).toEqual({ status: "cancelled", elementId: "title" });
		expect(h.stickCalls).toHaveLength(0);
		expect(store().pins).toEqual({});
		expect(h.controller.cache.size).toBe(0);
		expect(store().job).toEqual({ state: "idle", hostElementId: null, progress: 0 });
		expect(store().outcomes.title).toEqual(outcome);
	});

	test("an analysis that finishes after the stop, ignoring the signal, is still a cancel: nothing cached, nothing stuck", async () => {
		const h = harness({ gate: true, ignoreSignal: true });
		const run = h.controller.stick({ elementId: "title" });
		await settle();

		h.controller.cancel();
		h.release();
		const outcome = await run;

		expect(outcome).toEqual({ status: "cancelled", elementId: "title" });
		expect(h.stickCalls).toHaveLength(0);
		expect(h.controller.cache.size).toBe(0);
		expect(store().pins).toEqual({});
		expect(store().job).toEqual({ state: "idle", hostElementId: null, progress: 0 });
		expect(h.controller.running).toBe(false);
	});

	test("an analysis that fails after the stop is a cancel too: the user asked for a stop, not for an error", async () => {
		const h = harness({
			gate: true,
			ignoreSignal: true,
			analysis: () => ({ status: "error", error: "decode-failed", message: "Input has been disposed." }),
		});
		const run = h.controller.stick({ elementId: "title" });
		await settle();

		h.controller.cancel();
		h.release();
		expect(await run).toEqual({ status: "cancelled", elementId: "title" });
	});

	test("the store's cancel reaches the controller when it is registered", async () => {
		const h = harness({ gate: true });
		registerCameraPinController(h.controller);
		const run = store().stick({ elementId: "title" });
		await settle();
		store().cancel();
		h.release();
		expect((await run).status).toBe("cancelled");
	});

	test("Esc stops the job and stays handled until the analysis has really stopped", async () => {
		const h = harness({ gate: true });
		const run = h.controller.stick({ elementId: "title" });
		await settle();

		expect(cancelInteraction()).toBe(true);
		// a second Esc while the decoder is still stopping must not fall through to other handlers
		expect(cancelInteraction()).toBe(true);

		h.release();
		const outcome = await run;
		expect(outcome.status).toBe("cancelled");
		expect(cancelInteraction()).toBe(false);
	});

	test("the Esc registration is released after a run that was not cancelled", async () => {
		const h = harness();
		await h.controller.stick({ elementId: "title" });
		expect(cancelInteraction()).toBe(false);
	});

	test("a second stick while a job runs is refused, the running one finishes", async () => {
		const h = harness({ gate: true });
		const first = h.controller.stick({ elementId: "title" });
		await settle();

		const second = await h.controller.stick({ elementId: "title" });
		expect(second).toEqual({
			status: "error",
			error: "busy",
			message: CAMERA_PIN_MESSAGES.busy,
			elementId: "title",
		});
		expect(h.paused()).toBe(1);
		expect(h.analyzeCalls).toHaveLength(1);
		expect(store().job.state).toBe("running");

		h.release();
		expect((await first).status).toBe("pinned");
		expect(store().job.state).toBe("idle");
	});

	test("a decoder that never answers does not hold the engine: Esc ends the run and the next stick is not busy", async () => {
		const h = harness();
		let decodes = 0;
		const decoder = ({ answer }: { answer: () => Promise<IteratorResult<GrayFrame>> }): AsyncIterable<GrayFrame> => ({
			[Symbol.asyncIterator]: () => ({ next: answer }),
		});
		const engine = createCameraPinController({
			deps: {
				...h.controller.deps,
				analyze: (args) =>
					analyze({
						...args,
						deps: {
							decode: () => {
								decodes++;
								return decoder({
									// the first decode is silent for good, the second one fails at once
									answer: () =>
										decodes === 1
											? new Promise<IteratorResult<GrayFrame>>(() => {})
											: Promise.reject(new Error("second boom")),
								});
							},
							now: () => 0,
							yieldToUi: async () => {},
							newId: () => "id-real",
						},
					}),
			},
		});

		const first = engine.stick({ elementId: "title" });
		await settle();
		expect(engine.running).toBe(true);
		expect(cancelInteraction()).toBe(true);
		expect(await first).toEqual({ status: "cancelled", elementId: "title" });
		expect(engine.running).toBe(false);
		expect(store().job).toEqual(IDLE_JOB);
		expect(cancelInteraction()).toBe(false);

		const second = await engine.stick({ elementId: "title" });
		expect(second).toEqual({ status: "error", error: "analysis-failed", message: "second boom", elementId: "title" });
		expect(decodes).toBe(2);
	}, 2000);

	test("the host deleted while analysing: the run is aborted, the result dropped, an error reported", async () => {
		const h = harness({
			midRun: () => {
				h.state.tracks = tracksOf({ main: [] });
			},
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(h.analyzeCalls[0].signal.aborted).toBe(true);
		expect(outcome).toEqual({
			status: "error",
			error: "host-changed",
			message: CAMERA_PIN_MESSAGES["host-changed"],
			elementId: "title",
		});
		expect(h.stickCalls).toHaveLength(0);
		expect(h.controller.cache.size).toBe(0);
		expect(store().job.state).toBe("idle");
	});

	test("the host swapped to other media while analysing counts as changed too", async () => {
		const h = harness({
			midRun: () => {
				h.state.tracks = tracksOf({ main: [video({ mediaId: "m-other" })] });
			},
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toMatchObject({ status: "error", error: "host-changed" });
		expect(h.controller.cache.size).toBe(0);
	});

	test("the host deleted after the last progress report, before the analysis returns: result dropped", async () => {
		const h = harness({
			analysis: ({ window }) => {
				h.state.tracks = tracksOf({ main: [] });
				return {
					status: "complete",
					analysis: fakeAnalysis({ id: "id-1", hostElementId: "main-video", mediaId: "m-main", sourceStart: window.start, frameCount: 90 }),
				};
			},
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toMatchObject({ status: "error", error: "host-changed" });
		expect(h.stickCalls).toHaveLength(0);
		expect(h.controller.cache.size).toBe(0);
	});

	test("an analysis failure is reported with the analysis' message, and the job is idle again", async () => {
		const h = harness({
			analysis: () => ({ status: "error", error: "decode-failed", message: "Video codec not supported for decoding" }),
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toEqual({
			status: "error",
			error: "analysis-failed",
			message: "Video codec not supported for decoding",
			elementId: "title",
		});
		expect(store().job.state).toBe("idle");
		expect(store().pins).toEqual({});
		expect(h.controller.cache.size).toBe(0);
	});

	test("an analysis that throws is reported, not thrown, and the job is idle again", async () => {
		const h = harness({
			analysis: () => {
				throw new Error("worker died");
			},
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toEqual({ status: "error", error: "analysis-failed", message: "worker died", elementId: "title" });
		expect(store().job).toEqual({ state: "idle", hostElementId: null, progress: 0 });
		expect(cancelInteraction()).toBe(false);
	});

	test("a pause that throws is reported, not thrown: the engine is idle, Esc released, the next stick runs", async () => {
		const h = harness();
		let pauses = 0;
		const engine = createCameraPinController({
			deps: {
				...h.controller.deps,
				pause: () => {
					pauses++;
					if (pauses === 1) throw new Error("playback broke");
				},
			},
		});
		const outcome = await engine.stick({ elementId: "title" });
		expect(outcome).toEqual({ status: "error", error: "analysis-failed", message: "playback broke", elementId: "title" });
		expect(engine.running).toBe(false);
		expect(store().job).toEqual({ state: "idle", hostElementId: null, progress: 0 });
		expect(cancelInteraction()).toBe(false);
		expect((await engine.stick({ elementId: "title" })).status).toBe("pinned");
	});

	test("a stick that throws is reported as apply-failed, and the job is idle again", async () => {
		const h = harness({
			stick: () => {
				throw new Error("no timeline");
			},
		});
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toEqual({ status: "error", error: "apply-failed", message: "no timeline", elementId: "title" });
		expect(store().job.state).toBe("idle");
	});

	test("an element with no video under it is refused before any job", async () => {
		const h = harness({ tracks: tracksOf({ main: [] }) });
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toEqual({
			status: "error",
			error: "no-video",
			message: CAMERA_PIN_MESSAGES["no-video"],
			elementId: "title",
		});
		expect(h.paused()).toBe(0);
		expect(h.analyzeCalls).toHaveLength(0);
	});

	test("a video that never meets the element in time is no video under it", async () => {
		const h = harness({ tracks: tracksOf({ main: [video({ start: 6, duration: 4 })] }) });
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toMatchObject({ status: "error", error: "no-video" });
	});

	test("an element that is not in the project", async () => {
		const h = harness();
		const outcome = await h.controller.stick({ elementId: "ghost" });
		expect(outcome).toEqual({
			status: "error",
			error: "no-element",
			message: CAMERA_PIN_MESSAGES["no-element"],
			elementId: "ghost",
		});
	});

	test("the bottom video has nothing under it: no-video (a video over another video could be stuck)", async () => {
		const h = harness();
		const outcome = await h.controller.stick({ elementId: "main-video" });
		expect(outcome).toMatchObject({ status: "error", error: "no-video" });
		expect(h.analyzeCalls).toHaveLength(0);
	});

	test("an audio clip cannot be stuck", async () => {
		const tracks = tracksOf();
		tracks.audio = [
			{
				id: "audio-track",
				name: "audio-track",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "song",
						type: "audio",
						sourceType: "upload",
						name: "song",
						mediaId: "m-song",
						startTime: sec(0),
						duration: sec(5),
						trimStart: sec(0),
						trimEnd: sec(0),
						params: {},
					},
				],
			},
		];
		const h = harness({ tracks });
		const outcome = await h.controller.stick({ elementId: "song" });
		expect(outcome).toMatchObject({ status: "error", error: "unsupported-element" });
	});

	test("without the editor's scene, no-element", async () => {
		const h = harness();
		const deps: CameraPinControllerDeps = { ...h.controller.deps, readScene: () => null };
		const outcome = await createCameraPinController({ deps }).stick({ elementId: "title" });
		expect(outcome).toMatchObject({ status: "error", error: "no-element" });
	});

	test("the host's media file not loaded is an analysis failure with a clear message", async () => {
		const h = harness();
		h.state.file = null;
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(outcome).toEqual({
			status: "error",
			error: "analysis-failed",
			message: MEDIA_FILE_MISSING_MESSAGE,
			elementId: "title",
		});
		expect(h.paused()).toBe(0);
	});
});

/** Two titles over the one video: "title" at 1..4 s and "late" at 6..8 s, so neither window covers the other. */
function twoTitles(): SceneTracks {
	return tracksOf({
		overlay: [textTrack({ elements: [title({ id: "title", start: 1, duration: 3 }), title({ id: "late", start: 6, duration: 2 })] })],
	});
}

describe("createCameraPinController: a running job and the cache", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	test("a stick served from the cache goes ahead while another element is being analysed", async () => {
		const h = harness({ tracks: twoTitles(), gate: (index) => index === 1 });
		await h.controller.stick({ elementId: "title" });
		const late = h.controller.stick({ elementId: "late" });
		await settle();
		expect(h.controller.running).toBe(true);

		const again = await h.controller.stick({ elementId: "title", mode: "object" });
		expect(again.status).toBe("pinned");
		expect(h.stickCalls).toHaveLength(2);
		expect(h.stickCalls[1].mode).toBe("object");
		// the other analysis did not notice
		expect(h.analyzeCalls).toHaveLength(2);
		expect(store().job.state).toBe("running");

		h.release();
		expect((await late).status).toBe("pinned");
		expect(store().job).toEqual(IDLE_JOB);
	});

	test("a repin from the cached analysis goes ahead while another element is being analysed", async () => {
		const h = harness({ tracks: twoTitles(), gate: (index) => index === 1, repin: () => pinnedPlan({ analysisId: "id-1", mode: "object" }) });
		await h.controller.stick({ elementId: "title" });
		const late = h.controller.stick({ elementId: "late" });
		await settle();

		const repinned = await h.controller.repin({ elementId: "title" });
		expect(repinned).toEqual({ ...PINNED_OUTCOME, mode: "object" });
		expect(h.repinCalls).toHaveLength(1);
		expect(store().job.state).toBe("running");

		h.release();
		await late;
	});

	test("a stick that needs a new analysis is refused as busy, and the element keeps the outcome and pin it had", async () => {
		const h = harness({ tracks: twoTitles(), gate: (index) => index === 1 });
		await h.controller.stick({ elementId: "title" });
		expect(store().outcomes.title).toEqual(PINNED_OUTCOME);
		h.controller.cache.clear();

		const late = h.controller.stick({ elementId: "late" });
		await settle();
		const refused = await h.controller.stick({ elementId: "title" });
		expect(refused).toEqual({ status: "error", error: "busy", message: CAMERA_PIN_MESSAGES.busy, elementId: "title" });
		expect(h.analyzeCalls).toHaveLength(2);
		expect(store().outcomes.title).toEqual(PINNED_OUTCOME);
		expect(store().pins.title?.analysisId).toBe("id-1");

		h.release();
		await late;
	});

	test("a busy refusal is not recorded for an element that has no outcome yet", async () => {
		const h = harness({ tracks: twoTitles(), gate: (index) => index === 0 });
		const first = h.controller.stick({ elementId: "title" });
		await settle();
		const refused = await h.controller.stick({ elementId: "late" });
		expect(refused).toMatchObject({ status: "error", error: "busy" });
		expect(store().outcomes.late).toBeUndefined();

		h.release();
		await first;
	});

	test("a repin that needs a new analysis is refused as busy and leaves the pin and its outcome alone", async () => {
		const h = harness({ tracks: twoTitles(), gate: (index) => index === 1 });
		await h.controller.stick({ elementId: "title" });
		h.controller.cache.clear();
		const late = h.controller.stick({ elementId: "late" });
		await settle();

		const refused = await h.controller.repin({ elementId: "title" });
		expect(refused).toMatchObject({ status: "error", error: "busy" });
		expect(h.repinCalls).toHaveLength(0);
		expect(store().outcomes.title).toEqual(PINNED_OUTCOME);
		expect(store().pins.title?.analysisId).toBe("id-1");

		h.release();
		await late;
	});

	test("a plan failure other than busy is still recorded as the element's outcome", async () => {
		const h = harness({ stick: () => ({ status: "error", error: "stale-pin", message: CAMERA_PIN_MESSAGES["stale-pin"] }) });
		const outcome = await h.controller.stick({ elementId: "title" });
		expect(store().outcomes.title).toEqual(outcome);
	});
});

describe("createCameraPinController: repin", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	const look: Transform = { scaleX: 1.2, scaleY: 1.2, position: { x: 10, y: -5 }, rotate: 3 };

	test("repins from the cached analysis at once: no job, no pause, the record replaced", async () => {
		const h = harness({ repin: () => pinnedPlan({ analysisId: "id-1", mode: "object" }) });
		await h.controller.stick({ elementId: "title" });
		const outcome = await h.controller.repin({ elementId: "title", look });

		expect(outcome).toEqual({ ...PINNED_OUTCOME, mode: "object" });
		expect(h.analyzeCalls).toHaveLength(1);
		expect(h.paused()).toBe(1);
		expect(h.repinCalls).toHaveLength(1);
		expect(h.repinCalls[0].elementId).toBe("title");
		expect(h.repinCalls[0].analysis.id).toBe("id-1");
		expect(h.repinCalls[0].pin.analysisId).toBe("id-1");
		expect(h.repinCalls[0].look).toBe(look);
		expect(store().pins.title?.mode).toBe("object");
		expect(store().outcomes.title).toEqual(outcome);
	});

	test("repins from the pin's own analysis, even when a newer one of the same host is cached", async () => {
		const h = harness();
		await h.controller.stick({ elementId: "title" });
		const first = h.controller.cache.byId({ analysisId: "id-1" });
		if (!first) throw new Error("the stick's analysis should be cached");
		h.controller.cache.put({ analysis: { ...first, id: "newer" } });

		await h.controller.repin({ elementId: "title", look });
		expect(h.analyzeCalls).toHaveLength(1);
		expect(h.repinCalls[0].analysis.id).toBe("id-1");
	});

	test("an element that is not stuck cannot be repinned", async () => {
		const h = harness();
		const outcome = await h.controller.repin({ elementId: "title", look });
		expect(outcome).toEqual({ status: "error", error: "no-element", message: NOT_STUCK_MESSAGE, elementId: "title" });
		expect(h.repinCalls).toHaveLength(0);
	});

	test("with the analysis gone from the cache, the host is analysed again and the pin re-solved from that", async () => {
		const h = harness({
			analysis: ({ window }) => ({
				status: "complete",
				analysis: fakeAnalysis({
					id: `id-${h.analyzeCalls.length}`,
					hostElementId: "main-video",
					mediaId: "m-main",
					sourceStart: window.start,
					frameCount: 90,
				}),
			}),
		});
		await h.controller.stick({ elementId: "title" });
		h.controller.cache.clear();

		const outcome = await h.controller.repin({ elementId: "title", look });
		expect(outcome.status).toBe("pinned");
		expect(h.analyzeCalls).toHaveLength(2);
		expect(h.paused()).toBe(2);
		expect(h.repinCalls[0].analysis.id).toBe("id-2");
		expect(h.repinCalls[0].pin.analysisId).toBe("id-1");
	});

	test("a repin failure (stale pin) comes out with its message and keeps the old record", async () => {
		const h = harness({
			repin: () => ({ status: "error", error: "stale-pin", message: CAMERA_PIN_MESSAGES["stale-pin"] }),
		});
		await h.controller.stick({ elementId: "title" });
		const outcome = await h.controller.repin({ elementId: "title" });
		expect(outcome).toEqual({
			status: "error",
			error: "stale-pin",
			message: CAMERA_PIN_MESSAGES["stale-pin"],
			elementId: "title",
		});
		expect(store().pins.title?.analysisId).toBe("id-1");
	});

	test("a repin while a job runs is refused", async () => {
		const h = harness({ gate: (index) => index === 1 });
		await h.controller.stick({ elementId: "title" });
		h.controller.cache.clear();
		const first = h.controller.repin({ elementId: "title" });
		await settle();
		const second = await h.controller.repin({ elementId: "title" });
		expect(second).toMatchObject({ status: "error", error: "busy" });
		h.release();
		await first;
	});

	test("a repin that throws is reported as apply-failed", async () => {
		const h = harness({
			repin: () => {
				throw new Error("boom");
			},
		});
		await h.controller.stick({ elementId: "title" });
		const outcome = await h.controller.repin({ elementId: "title" });
		expect(outcome).toEqual({ status: "error", error: "apply-failed", message: "boom", elementId: "title" });
		expect(store().job.state).toBe("idle");
	});
});

// ---------------------------------------------------------------------------
// Installation in the editor
// ---------------------------------------------------------------------------

function fakeEditor({ tracks = tracksOf(), projectId = "project-1" }: { tracks?: SceneTracks; projectId?: string } = {}) {
	// one listener set per manager, as the editor has
	const managers = [new Set<() => void>(), new Set<() => void>(), new Set<() => void>()];
	const state = { tracks, projectId: projectId as string | null, paused: 0 };
	const subscribeTo = (listeners: Set<() => void>) => (listener: () => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const editor: CameraPinEditor = {
		playback: {
			pause: () => {
				state.paused++;
			},
		},
		project: {
			subscribe: subscribeTo(managers[0]),
			getActiveOrNull: () =>
				state.projectId === null
					? null
					: { metadata: { id: state.projectId }, settings: { fps: { numerator: 30, denominator: 1 } } },
		},
		timeline: { subscribe: subscribeTo(managers[1]) },
		scenes: { subscribe: subscribeTo(managers[2]), getScenes: () => [{ tracks: state.tracks }] },
		media: { getAssets: () => [{ id: "m-main", file: FILE }] },
	};
	return {
		editor,
		state,
		/** The timeline changed (what a deletion or move raises). */
		notify: () => {
			for (const listener of managers[1]) listener();
		},
		listenerCount: () => managers.reduce((sum, listeners) => sum + listeners.size, 0),
	};
}

/** The engine installed on a fake editor, its analysis and plans faked, its cache in view. */
function installed({ gate = false }: { gate?: boolean } = {}) {
	const fake = fakeEditor();
	const h = harness({ gate, readTracks: () => fake.state.tracks });
	const cache = new AnalysisCache();
	const teardown = installCameraPinController({
		editor: fake.editor,
		cache,
		deps: {
			readScene: h.controller.deps.readScene,
			analyze: h.controller.deps.analyze,
			stick: h.controller.deps.stick,
			repin: h.controller.deps.repin,
		},
	});
	return { fake, h, cache, teardown };
}

describe("a disposed engine", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	test("a run that ends after the disposal writes nothing to the store, yet frees its own resources", async () => {
		const h = harness({ gate: true });
		const run = h.controller.stick({ elementId: "title" });
		await settle();
		expect(store().job.state).toBe("running");

		h.controller.dispose();
		// the session moved on: another engine's job and a finished outcome are in the store now
		const nextJob: CameraAnalysisJob = { state: "running", hostElementId: "other-host", progress: 0.3 };
		store().setJob(nextJob);
		h.release();
		const outcome = await run;

		expect(outcome).toEqual({ status: "cancelled", elementId: "title" });
		expect(store().outcomes).toEqual({});
		expect(store().pins).toEqual({});
		expect(store().job).toEqual(nextJob);
		expect(h.controller.running).toBe(false);
		expect(cancelInteraction()).toBe(false);
		expect(h.controller.cache.size).toBe(0);
		expect(h.stickCalls).toHaveLength(0);
	});

	test("its progress reports no longer reach the store", async () => {
		const h = harness({ gate: true });
		const run = h.controller.stick({ elementId: "title" });
		await settle();
		h.controller.dispose();
		store().setJob(IDLE_JOB);

		h.analyzeCalls[0].onProgress?.({ fraction: 0.9 });
		expect(store().job).toEqual(IDLE_JOB);
		h.release();
		await run;
	});

	test("an analysis served from the cache is not stuck once the engine is disposed, and the earlier outcome stays", async () => {
		const h = harness();
		await h.controller.stick({ elementId: "title" });
		expect(h.stickCalls).toHaveLength(1);

		const run = h.controller.stick({ elementId: "title" });
		h.controller.dispose();
		expect(await run).toEqual({ status: "cancelled", elementId: "title" });
		expect(h.stickCalls).toHaveLength(1);
		expect(store().outcomes.title).toEqual(PINNED_OUTCOME);
	});

	test("a request that fails on a disposed engine is answered but not recorded", async () => {
		const h = harness();
		h.controller.dispose();
		const outcome = await h.controller.stick({ elementId: "ghost" });
		expect(outcome).toMatchObject({ status: "error", error: "no-element", elementId: "ghost" });
		expect(store().outcomes).toEqual({});
	});

	test("a repin that finds its analysis in the cache is not written once the engine is disposed", async () => {
		const h = harness();
		await h.controller.stick({ elementId: "title" });
		const first = h.controller.cache.byId({ analysisId: "id-1" });
		if (!first) throw new Error("the stick's analysis should be cached");
		// the pin's own analysis is gone, another one of the same host window is there
		h.controller.cache.clear();
		h.controller.cache.put({ analysis: { ...first, id: "newer" } });

		const run = h.controller.repin({ elementId: "title" });
		h.controller.dispose();
		expect(await run).toEqual({ status: "cancelled", elementId: "title" });
		expect(h.repinCalls).toHaveLength(0);
		expect(store().outcomes.title).toEqual(PINNED_OUTCOME);
	});

	test("a failure that comes after the disposal is not recorded either", async () => {
		const h = harness({ gate: true, ignoreSignal: true, analysis: () => ({ status: "error", error: "decode-failed", message: "late boom" }) });
		const run = h.controller.stick({ elementId: "title" });
		await settle();
		h.controller.dispose();
		h.release();
		await run;
		expect(store().outcomes).toEqual({});
	});

	test("dispose ends a run that is in flight and leaves the job idle at once", async () => {
		const h = harness({ gate: true });
		const run = h.controller.stick({ elementId: "title" });
		await settle();
		h.controller.dispose();
		expect(h.analyzeCalls[0].signal.aborted).toBe(true);
		expect(store().job).toEqual(IDLE_JOB);
		h.release();
		await run;
	});

	test("disposing an idle engine leaves the store alone", () => {
		const h = harness();
		const other: CameraAnalysisJob = { state: "running", hostElementId: "other-host", progress: 0.3 };
		store().setJob(other);
		h.controller.dispose();
		expect(store().job).toEqual(other);
	});
});

describe("installCameraPinController", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	test("registers a controller the store's actions reach, with the editor's pause and media", async () => {
		const { fake, h, teardown } = installed();
		const outcome = await store().stick({ elementId: "title" });
		expect(outcome.status).toBe("pinned");
		expect(fake.state.paused).toBe(1);
		expect(h.analyzeCalls[0].file).toBe(FILE);
		expect(h.analyzeCalls[0].projectFps).toBe(30);
		teardown();
	});

	test("teardown unregisters, unsubscribes and stops a running job", async () => {
		const { fake, h, teardown } = installed({ gate: true });
		expect(fake.listenerCount()).toBe(3);
		const run = store().stick({ elementId: "title" });
		await settle();

		teardown();
		h.release();
		expect((await run).status).toBe("cancelled");
		expect(fake.listenerCount()).toBe(0);
		const after = await store().stick({ elementId: "title" });
		expect(after).toMatchObject({ status: "error", error: "apply-failed" });
	});

	test("teardown leaves the job idle at once, not when the stopped run notices", async () => {
		const { h, teardown } = installed({ gate: true });
		const run = store().stick({ elementId: "title" });
		await settle();
		expect(store().job.state).toBe("running");

		teardown();
		expect(store().job).toEqual(IDLE_JOB);
		h.release();
		await run;
		expect(store().job).toEqual(IDLE_JOB);
	});

	test("the run a teardown stopped does not reset the job of the engine installed after it", async () => {
		const old = installed({ gate: true });
		const oldRun = store().stick({ elementId: "title" });
		await settle();
		old.teardown();

		const next = installed({ gate: true });
		const nextRun = store().stick({ elementId: "title" });
		await settle();
		expect(store().job).toEqual({ state: "running", hostElementId: "main-video", progress: 0.5 });

		// the old run ends now, after the new one has started
		old.h.release();
		expect((await oldRun).status).toBe("cancelled");
		expect(store().job).toEqual({ state: "running", hostElementId: "main-video", progress: 0.5 });

		next.h.release();
		expect((await nextRun).status).toBe("pinned");
		expect(store().job).toEqual(IDLE_JOB);
		next.teardown();
	});

	test("a moved, trimmed or retimed host keeps its analysis; a deleted or re-mediaed one loses it", async () => {
		const { fake, cache, teardown } = installed();
		await store().stick({ elementId: "title" });
		expect(cache.size).toBe(1);

		fake.state.tracks = tracksOf({ main: [video({ start: 0.5, trim: 0.25, rate: 1.5 })] });
		fake.notify();
		expect(cache.size).toBe(1);

		fake.state.tracks = tracksOf({ main: [video({ mediaId: "m-other" })] });
		fake.notify();
		expect(cache.size).toBe(0);

		fake.state.tracks = tracksOf();
		await store().stick({ elementId: "title" });
		expect(cache.size).toBe(1);
		fake.state.tracks = tracksOf({ main: [] });
		fake.notify();
		expect(cache.size).toBe(0);
		teardown();
	});

	test("a project change clears the cache and forgets the pins and outcomes", async () => {
		const { fake, h, cache, teardown } = installed();
		await store().stick({ elementId: "title" });
		expect(Object.keys(store().pins)).toEqual(["title"]);

		fake.state.projectId = "project-2";
		fake.notify();
		expect(cache.size).toBe(0);
		expect(store().pins).toEqual({});
		expect(store().outcomes).toEqual({});

		await store().stick({ elementId: "title" });
		expect(h.analyzeCalls).toHaveLength(2);
		teardown();
	});

	test("teardown ends the session: the pins and outcomes go with the cache", async () => {
		const { teardown } = installed();
		await store().stick({ elementId: "title" });
		expect(Object.keys(store().pins)).toEqual(["title"]);

		teardown();
		expect(store().pins).toEqual({});
		expect(store().outcomes).toEqual({});
	});

	test("installing again tears the earlier installation down", () => {
		const first = fakeEditor();
		const second = fakeEditor();
		const h = harness();
		const deps = {
			readScene: h.controller.deps.readScene,
			analyze: h.controller.deps.analyze,
			stick: h.controller.deps.stick,
			repin: h.controller.deps.repin,
		};
		installCameraPinController({ editor: first.editor, deps });
		const teardown = installCameraPinController({ editor: second.editor, deps });
		expect(first.listenerCount()).toBe(0);
		expect(second.listenerCount()).toBe(3);
		teardown();
		expect(second.listenerCount()).toBe(0);
	});
});

describe("CAMERA_PIN_MESSAGES", () => {
	test("the engine's codes have messages in the app's language", () => {
		expect(CAMERA_PIN_MESSAGES.busy).toMatch(/analys/i);
		expect(CAMERA_PIN_MESSAGES["host-changed"]).toMatch(/video/i);
		expect(CAMERA_PIN_MESSAGES["analysis-failed"]).toMatch(/analys/i);
	});
});

// ---------------------------------------------------------------------------
// The store and the view with the real engine (T4 review, items 2 and 3)
// ---------------------------------------------------------------------------

describe("the store with the real engine: a busy refusal during a run", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	function viewFor({ elementId }: { elementId: string }) {
		const state = store();
		return buildPinView({
			element: { id: elementId, type: "text" },
			pins: state.pins,
			job: state.job,
			outcomes: state.outcomes,
			stickingElementId: state.stickingElementId,
			hasVideoUnder: true,
			busyRefused: elementId in state.busyRefusedIds,
		});
	}

	test("a second clip's stick is refused as busy and the running clip keeps its progress and Cancel", async () => {
		const h = harness({ tracks: twoTitles(), gate: true });
		registerCameraPinController(h.controller);
		const first = store().stick({ elementId: "title" });
		await settle();
		expect(store().job.state).toBe("running");
		expect(store().stickingElementId).toBe("title");

		const refused = await store().stick({ elementId: "late" });
		expect(refused).toMatchObject({ status: "error", error: "busy" });
		expect(h.analyzeCalls).toHaveLength(1);
		// the marker of the running clip survives the refusal
		expect(store().stickingElementId).toBe("title");
		const running = viewFor({ elementId: "title" });
		expect(running.state).toBe("analysing");
		expect(running.progress?.cancelLabel).toBe("Cancel");
		// while the run lasts, nothing may start another one
		const other = viewFor({ elementId: "late" });
		expect(other.canChangeMode).toBe(false);
		expect(other.notices.map((notice) => notice.text)).toEqual([CAMERA_PIN_MESSAGES.busy]);

		h.release();
		expect((await first).status).toBe("pinned");
		expect(store().stickingElementId).toBeNull();
		expect(viewFor({ elementId: "late" }).canChangeMode).toBe(true);
	});

	test("asking again for the clip that is running does not take its progress away", async () => {
		const h = harness({ gate: true });
		registerCameraPinController(h.controller);
		const first = store().stick({ elementId: "title" });
		await settle();
		const again = await store().repin({ elementId: "title" });
		expect(again.status).toBe("error");
		expect(store().stickingElementId).toBe("title");
		expect(viewFor({ elementId: "title" }).state).toBe("analysing");

		h.release();
		await first;
		expect(store().stickingElementId).toBeNull();
	});

	test("busy is shown only while the run lasts and never replaces the clip's earlier notices", async () => {
		const h = harness({
			tracks: twoTitles(),
			gate: (index) => index === 1,
			stick: (args) => pinnedPlan({ elementId: args.elementId }),
		});
		registerCameraPinController(h.controller);
		await store().stick({ elementId: "late" });
		const earlier = viewFor({ elementId: "late" }).notices.map((notice) => notice.id);
		expect(earlier).toEqual(["low-quality"]);
		h.controller.cache.clear();

		const run = store().stick({ elementId: "title" });
		await settle();
		const refused = await store().stick({ elementId: "late" });
		expect(refused).toMatchObject({ status: "error", error: "busy" });
		expect(viewFor({ elementId: "late" }).notices.map((notice) => notice.id)).toEqual(["error:busy", ...earlier]);

		h.release();
		await run;
		expect(store().job.state).toBe("idle");
		// the run is over: the refusal is gone, the earlier notices are back as they were
		expect(viewFor({ elementId: "late" }).notices.map((notice) => notice.id)).toEqual(earlier);
		expect(store().outcomes.late?.status).toBe("pinned");
	});
});
