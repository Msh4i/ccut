/**
 * "Stick to scene" without a screen (slice T3, plan section c "Secimler"): which
 * video the element sticks to, which part of the clip is covered, where the
 * pin frame is, what the user is told, and that the keys written play back to
 * the scene's motion. Feature tracks are built from exact motion (no frames
 * rendered), so these run in milliseconds; the analysis is injected.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getElementLocalTime } from "@/animation";
import type { PresetAnimations } from "@/animation/presets";
import type { ScalarChannel } from "@/animation/types";
import { CommandManager } from "@/core/managers/commands";
import { TimelineManager } from "@/core/managers/timeline-manager";
import { EditorCore } from "@/core";
import { buildTransformFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type {
	ImageElement,
	OverlayTrack,
	SceneTracks,
	StickerElement,
	TextElement,
	VideoElement,
} from "@/timeline";
import { trackedSourceStart } from "@/tracking/host";
import { mediaTimeFromSeconds, mediaTimeToSeconds, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { getScalarChannel } from "../pin-animations";
import { createRng, gaussianSample } from "../random";
import { applySim } from "../similarity";
import { solvePin } from "../solve-pin";
import type { CameraAnalysis, FeatureTracks } from "../types";
import {
	analysisFrameClock,
	CAMERA_PIN_MESSAGES,
	defaultElementBox,
	hostStateOf,
	isPinCurrent,
	pinOf,
	pinWindow,
	planCameraPin,
	repinElement,
	selectPinHost,
	stickToScene,
	unstickElement,
	withoutPin,
	withPin,
	type CameraPinPlan,
	type CameraPinRecord,
	type PinScene,
} from "../pin-element";
import { buildTracks, scatterPoints } from "./camera-fixtures";
import {
	CANVAS,
	exactSimilaritySolution,
	fillHost,
	frameToCanvas,
	posePath,
	renderedCorners,
	similarityWorldTruth,
	type ElementSpec,
	type Look,
	type Pt,
} from "./pin-fixtures";

const sec = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });
const FPS = 30;
const FRAMES = 150;

// ---------------------------------------------------------------------------
// Scene fixtures
// ---------------------------------------------------------------------------

function video({
	id = "main-video",
	mediaId = "m-main",
	start = 0,
	duration = 5,
	trim = 0,
	rate,
	hidden = false,
	params = {},
}: {
	id?: string;
	mediaId?: string;
	start?: number;
	duration?: number;
	trim?: number;
	rate?: number;
	hidden?: boolean;
	params?: VideoElement["params"];
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
		params,
		hidden,
		...(rate === undefined ? {} : { retime: { rate } }),
	};
}

function title({
	id = "title",
	start = 1,
	duration = 3,
	params = {},
	overrides = {},
}: {
	id?: string;
	start?: number;
	duration?: number;
	params?: TextElement["params"];
	overrides?: Partial<TextElement>;
} = {}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: sec(0),
		trimEnd: sec(0),
		params: { content: "Hello", opacity: 0.9, ...params },
		...overrides,
	};
}

function videoTrack({
	id,
	elements,
	hidden = false,
}: {
	id: string;
	elements: VideoElement[];
	hidden?: boolean;
}): OverlayTrack {
	return { id, name: id, type: "video", muted: false, hidden, elements };
}

function textTrack({ id = "text-track", elements }: { id?: string; elements: TextElement[] }): OverlayTrack {
	return { id, name: id, type: "text", hidden: false, elements };
}

function scene({
	overlay = [],
	main = [video()],
}: {
	overlay?: OverlayTrack[];
	main?: VideoElement[];
} = {}): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: main },
		overlay,
		audio: [],
	};
}

function pinScene({
	tracks,
	playhead = 2,
}: {
	tracks: SceneTracks;
	playhead?: number;
}): PinScene {
	return {
		tracks,
		canvasSize: { width: CANVAS.width, height: CANVAS.height },
		mediaSize: () => ({ width: 1920, height: 1080 }),
		playhead: sec(playhead),
	};
}

const BOX = { left: -100, top: -50, width: 200, height: 100 };
const TEXT_SPEC: ElementSpec = { rect: BOX, isText: true };

// ---------------------------------------------------------------------------
// Feature tracks of exact motion
// ---------------------------------------------------------------------------

const clockOf = ({ n }: { n: number }) => Array.from({ length: n }, (_, t) => t);

/** Features riding an exact similarity camera; `noise` adds a seeded jitter in px@480. */
function similarityTracks({
	poses = posePath({ kind: "combo", n: FRAMES }),
	count = 90,
	seed = 3,
	noise = 0,
	avoid,
}: {
	poses?: ReturnType<typeof posePath>;
	count?: number;
	seed?: number;
	noise?: number;
	avoid?: { x: number; y: number; radius: number };
} = {}): FeatureTracks {
	const n = poses.length;
	const solution = exactSimilaritySolution({ poses, f0: 0 });
	const random = createRng({ seed: seed + 100 });
	const base = scatterPoints({ count: count * 2, seed })
		.filter((p) => !avoid || Math.hypot(p.x - avoid.x, p.y - avoid.y) > avoid.radius)
		.slice(0, count);
	const jitter = base.map(() =>
		clockOf({ n }).map(() => ({ x: noise * gaussianSample({ random }), y: noise * gaussianSample({ random }) })),
	);
	return buildTracks({
		frameCount: n,
		specs: base.map((p, i) => ({
			start: 0,
			end: n - 1,
			positionAt: (t) => {
				const q = applySim({
					map: {
						ar: solution.maps[4 * t],
						ai: solution.maps[4 * t + 1],
						br: solution.maps[4 * t + 2],
						bi: solution.maps[4 * t + 3],
					},
					x: p.x,
					y: p.y,
				});
				return { x: q.x + jitter[i][t].x, y: q.y + jitter[i][t].y };
			},
		})),
	});
}

function analysisOf({
	tracks,
	hostId = "main-video",
	mediaId = "m-main",
	sourceStart = 0,
	rate0 = 1,
	id = "analysis-1",
}: {
	tracks: FeatureTracks;
	hostId?: string;
	mediaId?: string;
	sourceStart?: number;
	rate0?: number;
	id?: string;
}): CameraAnalysis {
	return {
		id,
		hostElementId: hostId,
		mediaId,
		sourceStart,
		rate0,
		tracks,
		status: "complete",
	};
}

function planOf({
	tracks,
	analysis,
	playhead = 2,
	mode,
	look,
	box = BOX,
}: {
	tracks: SceneTracks;
	analysis: CameraAnalysis;
	playhead?: number;
	mode?: "auto" | "scene" | "object";
	look?: Look;
	box?: typeof BOX;
}): CameraPinPlan {
	return planCameraPin({
		scene: pinScene({ tracks, playhead }),
		elementId: "title",
		analysis,
		box,
		mode,
		look,
	});
}

function pinned(plan: CameraPinPlan) {
	if (plan.status !== "pinned") throw new Error(`expected a pin, got ${plan.status}`);
	return plan;
}

const STANDARD = () => scene({ overlay: [textTrack({ elements: [title()] })] });

// ---------------------------------------------------------------------------
// Editor stand-in
// ---------------------------------------------------------------------------

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function createHarness({ tracks, playhead = 2 }: { tracks: SceneTracks; playhead?: number }) {
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
		selection: { getSnapshot: () => ({}), applySelectionPatch: () => ({}), restoreSnapshot: () => {} },
		playback: { getCurrentTime: () => sec(state.playhead) },
		project: { getActive: () => ({ settings: { canvasSize: { width: CANVAS.width, height: CANVAS.height } } }) },
		media: {
			getAssets: () => [
				{ id: "m-main", width: 1920, height: 1080 },
				{ id: "m-logo", width: 800, height: 400 },
			],
		},
	});
	Object.assign(editor, {
		timeline: new TimelineManager(editor),
		command: new CommandManager(editor),
	});
	const spy = spyOn(EditorCore, "getInstance").mockReturnValue(editor);
	restores.push(() => spy.mockRestore());
	const element = (id = "title") => {
		for (const track of [...state.tracks.overlay, state.tracks.main]) {
			const found = track.elements.find((candidate) => candidate.id === id);
			if (found) return found;
		}
		throw new Error(`no element ${id}`);
	};
	return { state, editor, element };
}

function lookOf({ element, seconds }: { element: ReturnType<ReturnType<typeof createHarness>["element"]>; seconds: number }): Look {
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime: getElementLocalTime({
			timelineTime: Math.round(seconds * TICKS_PER_SECOND),
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	});
	return transform;
}

// ---------------------------------------------------------------------------
// Host selection
// ---------------------------------------------------------------------------

describe("which video the element sticks to", () => {
	const select = ({ tracks, playhead = 2, id = "title" }: { tracks: SceneTracks; playhead?: number; id?: string }) =>
		selectPinHost({ scene: pinScene({ tracks, playhead }), elementId: id, box: BOX })?.host.id ?? null;

	test("the video of the main track, when it is the only one", () => {
		expect(select({ tracks: STANDARD() })).toBe("main-video");
	});

	test("the topmost video under the element whose picture holds the element's centre", () => {
		const upper = video({ id: "upper", mediaId: "m-up", duration: 5 });
		const lower = video({ id: "lower", mediaId: "m-low", duration: 5 });
		const tracks = scene({
			overlay: [
				textTrack({ elements: [title()] }),
				videoTrack({ id: "v-upper", elements: [upper] }),
				videoTrack({ id: "v-lower", elements: [lower] }),
			],
		});
		expect(select({ tracks })).toBe("upper");
	});

	test("a video above the element's track is not a host", () => {
		const above = video({ id: "above", mediaId: "m-above" });
		const tracks = scene({
			overlay: [videoTrack({ id: "v-above", elements: [above] }), textTrack({ elements: [title()] })],
		});
		expect(select({ tracks })).toBe("main-video");
	});

	test("a video whose picture does not hold the element's centre gives way to one that does", () => {
		// 960 wide, shifted far to the right: the element is at the centre of the canvas
		const shifted = video({
			id: "shifted",
			mediaId: "m-shifted",
			params: { "transform.positionX": 1200, "transform.scaleX": 0.5, "transform.scaleY": 0.5 },
		});
		const tracks = scene({
			overlay: [textTrack({ elements: [title()] }), videoTrack({ id: "v-shifted", elements: [shifted] })],
		});
		expect(select({ tracks })).toBe("main-video");
	});

	test("when no picture holds the centre, the topmost visible video is taken", () => {
		const away = (id: string) =>
			video({ id, mediaId: `m-${id}`, params: { "transform.positionX": 1500, "transform.scaleX": 0.3, "transform.scaleY": 0.3 } });
		const tracks = scene({
			main: [away("bottom")],
			overlay: [textTrack({ elements: [title()] }), videoTrack({ id: "v-up", elements: [away("up")] })],
		});
		expect(select({ tracks })).toBe("up");
	});

	test("a picture that moves is judged where it is when the element is pinned (animated position)", () => {
		const moving = video({
			id: "moving",
			mediaId: "m-moving",
			params: { "transform.scaleX": 0.4, "transform.scaleY": 0.4 },
		});
		moving.animations = {
			"transform.positionX": {
				keys: [
					{ id: "a", time: sec(0), value: 1500, segmentToNext: "linear", tangentMode: "flat" },
					{ id: "b", time: sec(5), value: 0, segmentToNext: "linear", tangentMode: "flat" },
				],
			},
		};
		const tracks = scene({
			overlay: [textTrack({ elements: [title()] }), videoTrack({ id: "v-moving", elements: [moving] })],
		});
		// early the picture is off to the side, late it is over the centre
		expect(select({ tracks, playhead: 1.05 })).toBe("main-video");
		expect(select({ tracks, playhead: 3.9 })).toBe("moving");
	});

	test("hidden videos and hidden tracks are skipped", () => {
		const hiddenVideo = video({ id: "hidden-video", mediaId: "m-h", hidden: true });
		const inHiddenTrack = video({ id: "in-hidden-track", mediaId: "m-ht" });
		const tracks = scene({
			overlay: [
				textTrack({ elements: [title()] }),
				videoTrack({ id: "v-h", elements: [hiddenVideo] }),
				videoTrack({ id: "v-ht", elements: [inHiddenTrack], hidden: true }),
			],
		});
		expect(select({ tracks })).toBe("main-video");
	});

	test("a video that is not on screen at the pin moment but overlaps the clip is still better than none", () => {
		const late = video({ id: "late", mediaId: "m-late", start: 3, duration: 2 });
		const tracks = scene({
			main: [video({ id: "gone", mediaId: "m-gone", start: 20, duration: 1 })],
			overlay: [textTrack({ elements: [title({ start: 1, duration: 3 })] }), videoTrack({ id: "v-late", elements: [late] })],
		});
		// at 2 s only "late" is not there yet (3 s on): it is the only one that meets the clip at all
		expect(select({ tracks, playhead: 2 })).toBe("late");
	});

	test("a visible one wins over a better placed one that is not there at the pin moment", () => {
		const late = video({ id: "late", mediaId: "m-late", start: 3.5, duration: 1.5 });
		const tracks = scene({
			overlay: [textTrack({ elements: [title({ start: 1, duration: 3.5 })] }), videoTrack({ id: "v-late", elements: [late] })],
		});
		expect(select({ tracks, playhead: 2 })).toBe("main-video");
	});

	test("a playhead outside the element is taken as the nearest end of the element", () => {
		const late = video({ id: "late", mediaId: "m-late", start: 3.5, duration: 1.5 });
		const tracks = scene({
			main: [video({ id: "early", mediaId: "m-early", start: 0, duration: 3 })],
			overlay: [textTrack({ elements: [title({ start: 1, duration: 3.5 })] }), videoTrack({ id: "v-late", elements: [late] })],
		});
		expect(select({ tracks, playhead: 0 })).toBe("early");
		expect(select({ tracks, playhead: 4.9 })).toBe("late");
	});

	test("a playhead after the element is judged at the element's last moment, not where the playhead is", () => {
		// the picture sits over the canvas centre until 4 s, then slides away
		const sliding = video({ id: "sliding", mediaId: "m-sliding", params: { "transform.scaleX": 0.4, "transform.scaleY": 0.4 } });
		sliding.animations = {
			"transform.positionX": {
				keys: [
					{ id: "a", time: sec(0), value: 0, segmentToNext: "linear", tangentMode: "flat" },
					{ id: "b", time: sec(4), value: 0, segmentToNext: "linear", tangentMode: "flat" },
					{ id: "c", time: sec(5), value: 1500, segmentToNext: "linear", tangentMode: "flat" },
				],
			},
		};
		const tracks = scene({
			overlay: [textTrack({ elements: [title({ start: 1, duration: 3 })] }), videoTrack({ id: "v-sliding", elements: [sliding] })],
		});
		expect(select({ tracks, playhead: 4.9 })).toBe("sliding");
	});

	test("no video under the element: nothing", () => {
		const noVideo = scene({ main: [], overlay: [textTrack({ elements: [title()] })] });
		expect(select({ tracks: noVideo })).toBeNull();
		const apart = scene({
			main: [video({ start: 10, duration: 2 })],
			overlay: [textTrack({ elements: [title()] })],
		});
		expect(select({ tracks: apart })).toBeNull();
	});

	test("an element on the main track has nothing under it; an unknown element has no host", () => {
		const onMain = scene({ main: [video()] });
		expect(select({ tracks: onMain, id: "main-video" })).toBeNull();
		expect(select({ tracks: STANDARD(), id: "ghost" })).toBeNull();
	});

	test("the answer is the same every time", () => {
		const tracks = STANDARD();
		expect(select({ tracks })).toBe(select({ tracks }));
	});
});

// ---------------------------------------------------------------------------
// Window and pin frame
// ---------------------------------------------------------------------------

describe("the part of the clip that gets pinned", () => {
	const element = title({ start: 2, duration: 5 });

	test("it is the element's span inside the host's visible span", () => {
		const window = pinWindow({ element, host: video({ start: 0, duration: 5 }) });
		expect(window?.start).toBeCloseTo(2, 9);
		expect(window?.end).toBeCloseTo(5, 9);
		const wholeHost = pinWindow({ element: title({ start: 0, duration: 20 }), host: video({ start: 1, duration: 3 }) });
		expect(wholeHost?.start).toBeCloseTo(1, 9);
		expect(wholeHost?.end).toBeCloseTo(4, 9);
	});

	test("clips that do not meet have no window; touching ends do not count", () => {
		expect(pinWindow({ element, host: video({ start: 8, duration: 1 }) })).toBeNull();
		expect(pinWindow({ element, host: video({ start: 7, duration: 1 }) })).toBeNull();
	});

	test("an analysis frame sits where the source frame it was taken from is shown now (trim, retime, move)", () => {
		const cases = [
			{ host: video({ start: 4, duration: 10, trim: 1 }), sourceStart: 1, rate0: 1 },
			{ host: video({ start: 0, duration: 10, trim: 0.5, rate: 2 }), sourceStart: 0.5, rate0: 2 },
			// the clip was sped up after the analysis: the frames bunch together
			{ host: video({ start: 3, duration: 10, trim: 2, rate: 2 }), sourceStart: 2, rate0: 1 },
			{ host: video({ start: 3, duration: 10, trim: 2, rate: 0.5 }), sourceStart: 2.4, rate0: 0.5 },
			// moved, head-trimmed, right-trimmed: each frame stays on its source frame
			{ host: video({ start: 9, duration: 10, trim: 1 }), sourceStart: 3, rate0: 1 },
			{ host: video({ start: 5.5, duration: 10, trim: 2.5 }), sourceStart: 3, rate0: 1 },
			{ host: video({ start: 4, duration: 3, trim: 1 }), sourceStart: 3, rate0: 1 },
			{ host: video({ start: 6, duration: 10, trim: 2, rate: 1.5 }), sourceStart: 3, rate0: 1 },
		];
		for (const { host, sourceStart, rate0 } of cases) {
			const analysis = analysisOf({ tracks: similarityTracks(), sourceStart, rate0, hostId: host.id });
			const clock = analysisFrameClock({ analysis, host });
			const rate = host.retime?.rate ?? 1;
			for (const t of [0, 1, 37, 100, FRAMES - 1]) {
				// the source second the clip shows at that timeline second is the one the frame was taken from
				const shown = mediaTimeToSeconds({ time: host.trimStart }) + (clock.timeAt(t) - mediaTimeToSeconds({ time: host.startTime })) * rate;
				expect(shown).toBeCloseTo(sourceStart + (t * rate0) / FPS, 9);
				expect(clock.frameAt(clock.timeAt(t))).toBeCloseTo(t, 9);
			}
		}
		expect(trackedSourceStart({ host: video({ trim: 1, rate: 2 }), clipStartSec: 2 })).toBe(5);
	});

	test("the pin frame is the playhead's frame inside the window", () => {
		const tracks = similarityTracks();
		const analysis = analysisOf({ tracks });
		const host = video({ start: 0, duration: 5 });
		const plan = pinned(planOf({ tracks: scene({ main: [host], overlay: [textTrack({ elements: [title({ start: 2, duration: 5 })] })] }), analysis, playhead: 3 }));
		expect(plan.frames.pin).toBe(90);
		expect(plan.frames.first).toBe(60);
		expect(plan.frames.last).toBe(FRAMES - 1);
	});

	test("a playhead before or after the window pins at the nearest end", () => {
		const tracks = similarityTracks();
		const analysis = analysisOf({ tracks });
		const layout = scene({ overlay: [textTrack({ elements: [title({ start: 2, duration: 2 })] })] });
		const before = pinned(planOf({ tracks: layout, analysis, playhead: 0.4 }));
		expect(before.frames.pin).toBe(60);
		expect(before.frames.first).toBe(60);
		const after = pinned(planOf({ tracks: layout, analysis, playhead: 4.8 }));
		expect(after.frames.pin).toBe(120);
		expect(after.frames.last).toBe(120);
	});

	test("with a trimmed and sped-up host the window follows the source frames", () => {
		const tracks = similarityTracks();
		// host starts at 1 s on the timeline, shows source from 2 s on, at double speed: a source second takes half a second
		const host = video({ start: 1, duration: 2.5, trim: 2, rate: 2 });
		const analysis = analysisOf({ tracks, sourceStart: 2, rate0: 2 });
		const layout = scene({ main: [host], overlay: [textTrack({ elements: [title({ start: 1.5, duration: 3 })] })] });
		const plan = pinned(planOf({ tracks: layout, analysis, playhead: 2 }));
		// frame t is at 1 + t / 30 s (rate0 = rate); the host ends at 3.5 s, the element starts at 1.5 s
		expect(plan.frames.first).toBe(15);
		expect(plan.frames.last).toBe(75);
		expect(plan.frames.pin).toBe(30);
		// keys are relative to the element's start
		expect(mediaTimeToSeconds({ time: plan.range.start })).toBeCloseTo(0, 9);
		expect(mediaTimeToSeconds({ time: plan.range.end })).toBeCloseTo(2, 9);
	});

	test("frames after the end of what the host still shows (trimmed since) are not keyed", () => {
		const tracks = similarityTracks();
		const layout = scene({
			main: [video({ start: 0, duration: 3 })],
			overlay: [textTrack({ elements: [title({ start: 1, duration: 3 })] })],
		});
		const plan = pinned(planOf({ tracks: layout, analysis: analysisOf({ tracks }), playhead: 2 }));
		// the element runs 1..4 s but the host ends at 3 s
		expect(plan.frames.first).toBe(30);
		expect(plan.frames.last).toBe(90);
	});

	test("frames before the start of what the host still shows (trimmed since) are not keyed", () => {
		const tracks = similarityTracks();
		// analysed from the source's start; the clip now begins 1 s into the source and sits at 1 s on the timeline
		const host = video({ start: 1, duration: 5, trim: 1 });
		const layout = scene({ main: [host], overlay: [textTrack({ elements: [title({ start: 0.5, duration: 3.5 })] })] });
		const plan = pinned(planOf({ tracks: layout, analysis: analysisOf({ tracks, sourceStart: 0 }), playhead: 2 }));
		// frame t is at t / 30 s; the host shows from 1 s on, the element from 0.5 s
		expect(plan.frames.first).toBe(30);
		expect(plan.frames.last).toBe(120);
	});

	test("an analysis that stops short only covers its own frames", () => {
		const tracks = similarityTracks({ poses: posePath({ kind: "pan", n: 60 }) });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 1.5 }));
		expect(plan.frames.first).toBe(30);
		expect(plan.frames.last).toBe(59);
		expect(plan.frames.pin).toBe(45);
	});

	test("an analysis of frames that never meet the clip is an error", () => {
		const tracks = similarityTracks({ poses: posePath({ kind: "pan", n: 30 }) });
		const plan = planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks, sourceStart: 50 }) });
		expect(plan.status).toBe("error");
		if (plan.status === "error") {
			expect(plan.error).toBe("analysis-outside");
			expect(plan.message).toBe(CAMERA_PIN_MESSAGES["analysis-outside"]);
		}
	});
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("what cannot be stuck", () => {
	const tracks = similarityTracks();

	test("no video under the clip: the plan's message, nothing planned", () => {
		const plan = planOf({
			tracks: scene({ main: [], overlay: [textTrack({ elements: [title()] })] }),
			analysis: analysisOf({ tracks }),
		});
		expect(plan).toMatchObject({ status: "error", error: "no-video", message: "There is no video under this clip." });
	});

	test("an unknown clip, an audio clip", () => {
		const analysis = analysisOf({ tracks });
		expect(
			planCameraPin({ scene: pinScene({ tracks: STANDARD() }), elementId: "ghost", analysis, box: BOX }),
		).toMatchObject({ status: "error", error: "no-element" });
		const withAudio: SceneTracks = {
			...STANDARD(),
			audio: [
				{
					id: "a-track",
					name: "a",
					type: "audio",
					muted: false,
					elements: [
						{
							id: "song",
							type: "audio",
							name: "song",
							sourceType: "upload",
							mediaId: "m-a",
							startTime: sec(0),
							duration: sec(5),
							trimStart: sec(0),
							trimEnd: sec(0),
							params: {},
						},
					],
				},
			],
		};
		expect(
			planCameraPin({ scene: pinScene({ tracks: withAudio }), elementId: "song", analysis, box: BOX }),
		).toMatchObject({ status: "error", error: "unsupported-element" });
	});

	test("an analysis of another clip or of other media", () => {
		expect(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks, hostId: "someone-else" }) })).toMatchObject({
			status: "error",
			error: "analysis-mismatch",
		});
		expect(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks, mediaId: "m-other" }) })).toMatchObject({
			status: "error",
			error: "analysis-mismatch",
		});
	});

	test("an analysis that was cancelled is not stuck to: nothing is written", () => {
		const cancelled: CameraAnalysis = { ...analysisOf({ tracks }), status: "cancelled" };
		expect(planOf({ tracks: STANDARD(), analysis: cancelled })).toMatchObject({
			status: "error",
			error: "analysis-cancelled",
		});
		const { state, editor } = createHarness({ tracks: STANDARD() });
		expect(stickToScene({ elementId: "title", analysis: cancelled, box: BOX })).toMatchObject({
			status: "error",
			error: "analysis-cancelled",
		});
		expect(state.updates).toBe(0);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("text without a measured box", () => {
		const plan = planCameraPin({
			scene: pinScene({ tracks: STANDARD() }),
			elementId: "title",
			analysis: analysisOf({ tracks }),
		});
		expect(plan).toMatchObject({ status: "error", error: "no-box" });
	});

	test("every error has a plain message", () => {
		for (const message of Object.values(CAMERA_PIN_MESSAGES)) {
			expect(message.length).toBeGreaterThan(10);
			expect(message.endsWith(".")).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

describe("the element's box", () => {
	const canvasSize = { width: 1920, height: 1080 };
	const mediaSize = ({ mediaId }: { mediaId: string }) =>
		mediaId === "wide" ? { width: 3840, height: 1080 } : undefined;

	test("an image fits the canvas the way the renderer does (contain)", () => {
		const image: ImageElement = { id: "i", type: "image", name: "i", mediaId: "wide", startTime: sec(0), duration: sec(1), trimStart: sec(0), trimEnd: sec(0), params: {} };
		expect(defaultElementBox({ element: image, canvasSize, mediaSize })).toEqual({ left: -960, top: -270, width: 1920, height: 540 });
		const unknown: ImageElement = { ...image, mediaId: "unknown" };
		expect(defaultElementBox({ element: unknown, canvasSize, mediaSize })).toEqual({ left: -960, top: -540, width: 1920, height: 1080 });
	});

	test("a sticker uses its own size, 200 when it has none, a graphic 512", () => {
		const sticker: StickerElement = { id: "s", type: "sticker", name: "s", stickerId: "x", intrinsicWidth: 100, intrinsicHeight: 50, startTime: sec(0), duration: sec(1), trimStart: sec(0), trimEnd: sec(0), params: {} };
		// contain on a 1920x1080 canvas: 100x50 grows 19.2 times before it is as wide as the canvas
		const box = defaultElementBox({ element: sticker, canvasSize, mediaSize });
		expect(box?.width).toBeCloseTo(1920, 9);
		expect(box?.height).toBeCloseTo(960, 9);
		const bare: StickerElement = { ...sticker, intrinsicWidth: undefined, intrinsicHeight: undefined };
		expect(defaultElementBox({ element: bare, canvasSize, mediaSize })?.width).toBeCloseTo(1080, 9);
	});

	test("text has to be measured by whoever can draw it", () => {
		expect(defaultElementBox({ element: title(), canvasSize, mediaSize })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The scene's motion on the element
// ---------------------------------------------------------------------------

describe("the keys play back to the scene's motion", () => {
	test("a text pinned at the playhead stays glued to a camera that pans, zooms and rolls", () => {
		const poses = posePath({ kind: "combo", n: FRAMES });
		const tracks = similarityTracks({ poses });
		const { editor, element } = createHarness({ tracks: STANDARD(), playhead: 2 });
		const analysis = analysisOf({ tracks });
		const outcome = stickToScene({ elementId: "title", analysis, box: BOX });
		expect(outcome.status).toBe("pinned");
		if (outcome.status !== "pinned") return;
		expect(outcome.model).toBe("S");
		expect(outcome.mode).toBe("scene");
		expect(outcome.notices).toEqual([]);
		expect(editor.command.canUndo()).toBe(true);

		const f0 = outcome.frames.pin;
		expect(f0).toBe(60);
		const truth = similarityWorldTruth({ poses, f0, host: fillHost });
		const clock = analysisFrameClock({ analysis, host: video() });
		const start = renderedCorners({ spec: TEXT_SPEC, look: { position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotate: 0 } });
		let worst = 0;
		for (let t = outcome.frames.first; t <= outcome.frames.last; t++) {
			const got = renderedCorners({ spec: TEXT_SPEC, look: lookOf({ element: element(), seconds: clock.timeAt(t) }) });
			for (let k = 0; k < 4; k++) {
				const want = truth.canvasAt({ t, c: start[k] });
				worst = Math.max(worst, Math.hypot(got[k].x - want.x, got[k].y - want.y));
			}
		}
		// the simplification budget is 0.5 px; the exact tracks add nothing
		expect(worst).toBeLessThanOrEqual(0.5);
	});

	test("the element keeps its own look at the pin frame, with a base scale, rotation and offset", () => {
		const poses = posePath({ kind: "combo", n: FRAMES });
		const tracks = similarityTracks({ poses });
		const base = { "transform.positionX": 150, "transform.positionY": -60, "transform.scaleX": 1.5, "transform.scaleY": 1.5, "transform.rotate": 20 };
		const { element } = createHarness({ tracks: scene({ overlay: [textTrack({ elements: [title({ params: base })] })] }), playhead: 2 });
		const analysis = analysisOf({ tracks });
		const outcome = stickToScene({ elementId: "title", analysis, box: BOX });
		if (outcome.status !== "pinned") throw new Error("expected a pin");
		const clock = analysisFrameClock({ analysis, host: video() });
		const atPin = lookOf({ element: element(), seconds: clock.timeAt(outcome.frames.pin) });
		expect(atPin.position.x).toBeCloseTo(150, 6);
		expect(atPin.position.y).toBeCloseTo(-60, 6);
		expect(atPin.scaleX).toBeCloseTo(1.5, 9);
		expect(atPin.rotate).toBeCloseTo(20, 6);
		// and it moves with the scene elsewhere
		const spec: ElementSpec = { rect: BOX, isText: true };
		const overlay: Look = { position: { x: 150, y: -60 }, scaleX: 1.5, scaleY: 1.5, rotate: 20 };
		const truth = similarityWorldTruth({ poses, f0: outcome.frames.pin, host: fillHost });
		const start = renderedCorners({ spec, look: overlay });
		let worst = 0;
		for (let t = outcome.frames.first; t <= outcome.frames.last; t += 3) {
			const got = renderedCorners({ spec, look: lookOf({ element: element(), seconds: clock.timeAt(t) }) });
			for (let k = 0; k < 4; k++) {
				const want = truth.canvasAt({ t, c: start[k] });
				worst = Math.max(worst, Math.hypot(got[k].x - want.x, got[k].y - want.y));
			}
		}
		expect(worst).toBeLessThanOrEqual(0.5);
	});

	test("an image on its own track follows a mirrored host the same way (rotation reversed)", () => {
		const poses = posePath({ kind: "roll", n: FRAMES });
		const tracks = similarityTracks({ poses });
		const mirrored = video({ params: { "transform.scaleX": -1 } });
		const layout = scene({ main: [mirrored], overlay: [textTrack({ elements: [title()] })] });
		const plan = pinned(planOf({ tracks: layout, analysis: analysisOf({ tracks }) }));
		const rotate = plan.keys.rotate.map((k) => k.value);
		// the camera rolls from +10 to -10 degrees; in a mirror image the title rolls the other way
		// (plain: -15.2 .. +4.3 around the pin frame, mirrored: -4.3 .. +15.2)
		expect(Math.max(...rotate)).toBeGreaterThan(9);
		expect(Math.min(...rotate)).toBeGreaterThan(-5);
	});

	test("the result is deterministic", () => {
		const tracks = similarityTracks({ noise: 0.3 });
		const a = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }) }));
		const b = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }) }));
		const shape = (plan: typeof a) =>
			(["x", "y", "scaleX", "scaleY", "rotate"] as const).map((name) => plan.keys[name].map((k) => [k.time, k.value]));
		expect(shape(a)).toEqual(shape(b));
		expect(a.range).toEqual(b.range);
	});

	test("the pin record says what was stuck to what", () => {
		const tracks = similarityTracks();
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }) }));
		expect(plan.pin).toEqual({
			elementId: "title",
			trackId: "text-track",
			analysisId: "analysis-1",
			hostElementId: "main-video",
			mode: "scene",
			model: "S",
			range: plan.range,
			host: hostStateOf(video()),
		});
	});
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

describe("what the user is told", () => {
	test("not enough texture: nothing is written", () => {
		const tracks = buildTracks({
			frameCount: FRAMES,
			specs: Array.from({ length: 4 }, (_, i) => ({
				start: 0,
				end: FRAMES - 1,
				positionAt: (t: number): Pt => ({ x: 100 + 60 * i - t * 0.5, y: 100 + 20 * i }),
			})),
		});
		const plan = planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }) });
		expect(plan.status).toBe("no-keys");
		expect(plan.status === "no-keys" && plan.notices).toEqual(["no-texture"]);
	});

	test("a camera that does not move: nothing is written", () => {
		const tracks = similarityTracks({ poses: Array.from({ length: FRAMES }, () => posePath({ kind: "pan", n: 2 })[0]) });
		const plan = planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }) });
		expect(plan.status).toBe("no-keys");
		expect(plan.status === "no-keys" && plan.notices).toEqual(["no-motion"]);
	});

	test("nothing reaches the project for either, through stickToScene", () => {
		for (const tracks of [
			similarityTracks({ poses: Array.from({ length: FRAMES }, () => posePath({ kind: "pan", n: 2 })[0]) }),
			buildTracks({ frameCount: FRAMES, specs: [] }),
		]) {
			const { editor, state, element } = createHarness({ tracks: STANDARD() });
			const before = element();
			const outcome = stickToScene({ elementId: "title", analysis: analysisOf({ tracks }), box: BOX });
			expect(outcome.status).toBe("no-keys");
			expect(state.updates).toBe(0);
			expect(element()).toBe(before);
			expect(element().animations).toBeUndefined();
			expect(editor.command.canUndo()).toBe(false);
		}
	});

	test("a noisy clip is stuck but with a warning", () => {
		const tracks = similarityTracks({ noise: 1.1, count: 120 });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }) }));
		expect(plan.notices).toContain("low-quality");
	});

	test("a clean pin has no notices", () => {
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks: similarityTracks() }) }));
		expect(plan.notices).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Scene cuts
// ---------------------------------------------------------------------------

describe("a scene cut ends the pin", () => {
	function cutTracks({ cutAt }: { cutAt: number }): FeatureTracks {
		const poses = posePath({ kind: "combo", n: FRAMES });
		const solution = exactSimilaritySolution({ poses, f0: 0 });
		const map = (t: number) => ({
			ar: solution.maps[4 * t],
			ai: solution.maps[4 * t + 1],
			br: solution.maps[4 * t + 2],
			bi: solution.maps[4 * t + 3],
		});
		const first = scatterPoints({ count: 80, seed: 3 });
		const second = scatterPoints({ count: 80, seed: 4 });
		return buildTracks({
			frameCount: FRAMES,
			cuts: [cutAt],
			specs: [
				...first.map((p) => ({ start: 0, end: cutAt - 1, positionAt: (t: number) => applySim({ map: map(t), x: p.x, y: p.y }) })),
				...second.map((p) => ({ start: cutAt, end: FRAMES - 1, positionAt: (t: number) => applySim({ map: map(t), x: p.x, y: p.y }) })),
			],
		});
	}

	// the element covers frames 30..119 (1..4 s); the cut is at frame 90 (3 s)
	test("keys stop at the cut when the pin frame is before it", () => {
		const tracks = cutTracks({ cutAt: 90 });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 1.5 }));
		expect(plan.frames.first).toBe(30);
		expect(plan.frames.last).toBe(89);
		expect(plan.notices).toContain("cut");
		expect(plan.cutTimes).toHaveLength(1);
		expect(plan.cutTimes[0]).toBeCloseTo(3, 9);
		// the last key is the last frame before the cut, relative to the element's start (1 s)
		expect(mediaTimeToSeconds({ time: plan.range.end })).toBeCloseTo(89 / FPS - 1, 4);
	});

	test("keys start at the cut when the pin frame is after it", () => {
		const tracks = cutTracks({ cutAt: 90 });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 3.5 }));
		expect(plan.frames.first).toBe(90);
		expect(plan.frames.last).toBe(120);
		expect(plan.notices).toContain("cut");
		expect(mediaTimeToSeconds({ time: plan.range.start })).toBeCloseTo(2, 9);
	});

	test("a cut outside the pinned span is not mentioned", () => {
		const tracks = cutTracks({ cutAt: 140 });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 1.5 }));
		expect(plan.frames.last).toBe(120);
		expect(plan.notices).not.toContain("cut");
		expect(plan.cutTimes).toEqual([]);
	});

	test("the second scene is a pin of its own: the first one's keys stay as they were", () => {
		const tracks = cutTracks({ cutAt: 90 });
		const analysis = analysisOf({ tracks });
		const { element, state, editor } = createHarness({ tracks: STANDARD(), playhead: 1.5 });
		const first = stickToScene({ elementId: "title", analysis, box: BOX });
		expect(first.status).toBe("pinned");
		const positionKeys = () =>
			getScalarChannel({ animations: element().animations, path: "transform.positionX" })?.keys ?? [];
		const afterFirst = positionKeys();

		state.playhead = 3.5;
		const second = stickToScene({ elementId: "title", analysis, box: BOX });
		expect(second.status).toBe("pinned");
		const afterSecond = positionKeys();
		// every key of the first pin is still there, the same key
		expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
		expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
		// and the second pin's keys all lie after the first's
		const firstEnd = afterFirst[afterFirst.length - 1].time;
		for (const key of afterSecond.slice(afterFirst.length)) expect(key.time).toBeGreaterThan(firstEnd);
		expect(state.updates).toBe(2);
		editor.command.undo();
		expect(positionKeys()).toEqual(afterFirst);
	});
});

// ---------------------------------------------------------------------------
// Frames the solver could not follow
// ---------------------------------------------------------------------------

describe("frames the tracking could not follow", () => {
	/** The same camera path with features alive only in the given spans of frames (none in between). */
	function spanTracks({ spans }: { spans: [number, number][] }): FeatureTracks {
		const poses = posePath({ kind: "combo", n: FRAMES });
		const solution = exactSimilaritySolution({ poses, f0: 0 });
		const map = (t: number) => ({
			ar: solution.maps[4 * t],
			ai: solution.maps[4 * t + 1],
			br: solution.maps[4 * t + 2],
			bi: solution.maps[4 * t + 3],
		});
		return buildTracks({
			frameCount: FRAMES,
			specs: spans.flatMap(([start, end], k) =>
				scatterPoints({ count: 80, seed: 40 + k }).map((p) => ({
					start,
					end,
					positionAt: (t: number) => applySim({ map: map(t), x: p.x, y: p.y }),
				})),
			),
		});
	}

	// the element covers frames 30..120; the playhead at 1.5 s is frame 45
	test("a gap with no way across is bridged: the keys run through it, and the plan says where tracking was lost", () => {
		const tracks = spanTracks({
			spans: [
				[0, 59],
				[62, 149],
			],
		});
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 1.5 }));
		expect(plan.frames).toEqual({ first: 30, last: 120, pin: 45 });
		expect(plan.notices).toContain("lost");
		expect(plan.lostFrame).toBe(60);
		expect(plan.notices).not.toContain("no-texture");
		// the last key is at the end of the element's frames: nothing was cut short
		expect(mediaTimeToSeconds({ time: plan.range.end })).toBeCloseTo(120 / FPS - 1, 4);
	});

	test("tracking lost for good ends the keys at the last frame it followed", () => {
		const tracks = spanTracks({ spans: [[0, 89]] });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 1.5 }));
		expect(plan.frames.last).toBe(89);
		expect(plan.lostFrame).toBe(90);
		expect(plan.notices).toEqual(["lost"]);
		expect(mediaTimeToSeconds({ time: plan.range.end })).toBeCloseTo(89 / FPS - 1, 4);
	});

	test("nothing followed beyond the pin frame writes nothing, and says it was lost", () => {
		// plenty of features, all in a 20 px patch: they cannot define the camera
		const poses = posePath({ kind: "pan", n: FRAMES });
		const solution = exactSimilaritySolution({ poses, f0: 0 });
		const tracks = buildTracks({
			frameCount: FRAMES,
			specs: scatterPoints({ count: 60, seed: 8 }).map((p) => ({
				start: 0,
				end: FRAMES - 1,
				positionAt: (t: number) =>
					applySim({
						map: {
							ar: solution.maps[4 * t],
							ai: solution.maps[4 * t + 1],
							br: solution.maps[4 * t + 2],
							bi: solution.maps[4 * t + 3],
						},
						x: 100 + (p.x % 20),
						y: 80 + (p.y % 20),
					}),
			})),
		});
		const plan = planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), playhead: 1.5 });
		expect(plan.status).toBe("no-keys");
		expect(plan.status === "no-keys" && plan.notices).toEqual(["lost"]);
		expect(plan.status === "no-keys" && plan.lostFrame).toBe(46);
	});

	test("the solver is asked for the element's frames only", () => {
		const asked: ({ lo: number; hi: number } | undefined)[] = [];
		const spy: typeof solvePin = (args) => {
			asked.push(args.range);
			return solvePin(args);
		};
		planCameraPin({
			scene: pinScene({ tracks: STANDARD(), playhead: 1.5 }),
			elementId: "title",
			analysis: analysisOf({ tracks: similarityTracks() }),
			box: BOX,
			solve: spy,
		});
		expect(asked[0]).toEqual({ lo: 30, hi: 120 });
	});

	test("a clean pin names no lost frame", () => {
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks: similarityTracks() }) }));
		expect(plan.lostFrame).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Model and mode
// ---------------------------------------------------------------------------

/** A pinhole camera yawing by `yawMaxDeg` over a flat distant scene: the features move by a homography. */
function perspectiveTracks({ yawMaxDeg, hfovDeg = 60, count = 120, n = FRAMES, seed = 5, noise = 0 }: { yawMaxDeg: number; hfovDeg?: number; count?: number; n?: number; seed?: number; noise?: number }) {
	const w = 480;
	const h = 270;
	const focal = w / 2 / Math.tan((hfovDeg * Math.PI) / 360);
	const point = ({ t, x, y }: { t: number; x: number; y: number }): Pt => {
		const yaw = (yawMaxDeg * (Math.PI / 180) * t) / (n - 1);
		const d0 = x - w / 2;
		const d1 = y - h / 2;
		const x3 = d0 * Math.cos(yaw) + focal * Math.sin(yaw);
		const z3 = -d0 * Math.sin(yaw) + focal * Math.cos(yaw);
		return { x: w / 2 + (focal * x3) / z3, y: h / 2 + (focal * d1) / z3 };
	};
	const base = scatterPoints({ count, seed });
	const random = createRng({ seed: seed + 100 });
	const jitter = base.map(() =>
		clockOf({ n }).map(() => ({ x: noise * gaussianSample({ random }), y: noise * gaussianSample({ random }) })),
	);
	const tracks = buildTracks({
		frameCount: n,
		specs: base.map((p, i) => ({
			start: 0,
			end: n - 1,
			positionAt: (t: number) => {
				const q = point({ t, x: p.x, y: p.y });
				return { x: q.x + jitter[i][t].x, y: q.y + jitter[i][t].y };
			},
		})),
	});
	return { tracks, point };
}

describe("which motion model is written", () => {
	const largeText = { left: -200, top: -100, width: 400, height: 200 };

	test("a camera that only pans and rolls: the similarity", () => {
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks: similarityTracks() }), box: largeText }));
		expect(plan.model).toBe("S");
	});

	test("a pan over a flat scene and a large title: the homography's closest scale-and-rotate", () => {
		const { tracks, point } = perspectiveTracks({ yawMaxDeg: 10 });
		const analysis = analysisOf({ tracks });
		const layout = () => scene({ overlay: [textTrack({ elements: [title({ start: 0, duration: 5 })] })] });
		const plan = pinned(planOf({ tracks: layout(), analysis, box: largeText, playhead: 0 }));
		expect(plan.model).toBe("H");

		// and that is the better one: the corners follow the true motion within a few px@1920
		const { element } = createHarness({ tracks: layout(), playhead: 0 });
		const outcome = stickToScene({ elementId: "title", analysis, box: largeText });
		if (outcome.status !== "pinned") throw new Error("expected a pin");
		expect(outcome.frames.pin).toBe(0);
		const clock = analysisFrameClock({ analysis, host: video() });
		const spec: ElementSpec = { rect: largeText, isText: true };
		const start = renderedCorners({ spec, look: { position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotate: 0 } });
		let worst = 0;
		let compared = 0;
		for (let t = outcome.frames.first; t <= outcome.frames.last; t++) {
			const got = renderedCorners({ spec, look: lookOf({ element: element(), seconds: clock.timeAt(t) }) });
			for (let k = 0; k < 4; k++) {
				// the pin frame is frame 0: a corner's frame pixel moves by the camera's true homography
				const x0 = (start[k].x / CANVAS.width) * 480 - 0.5;
				const y0 = (start[k].y / CANVAS.height) * 270 - 0.5;
				const want = frameToCanvas({ p: point({ t, x: x0, y: y0 }), bounds: fillHost(0) });
				worst = Math.max(worst, Math.hypot(got[k].x - want.x, got[k].y - want.y));
				compared++;
			}
		}
		expect(compared).toBeGreaterThan(400);
		// the similarity would be 16 px off here (plan M3); the plan measured 4 px for the closest scale-and-rotate
		expect(worst).toBeLessThanOrEqual(8);
	});

	test("the same pan with a small element: the similarity is as good, so it stays", () => {
		const { tracks } = perspectiveTracks({ yawMaxDeg: 10 });
		const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), box: { left: -10, top: -5, width: 20, height: 10 }, playhead: 1 }));
		expect(plan.model).toBe("S");
	});

	describe("the quality notice judges the motion that is written, not the similarity's misfit (B3 of the window e2e)", () => {
		const layout = () => scene({ overlay: [textTrack({ elements: [title({ start: 0, duration: 5 })] })] });

		test("a clean pan over a flat scene with a large title (homography written): no 'Video quality is low'", () => {
			for (const yawMaxDeg of [10, 12, 15]) {
				const { tracks } = perspectiveTracks({ yawMaxDeg });
				const plan = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks }), box: largeText, playhead: 0 }));
				expect(plan.model).toBe("H");
				expect(plan.notices).not.toContain("low-quality");
				expect(plan.notices).toEqual([]);
			}
		});

		test("a clean pan with a dense but not huge feature set (40) still drops it: 40 inliers are enough evidence", () => {
			for (const seed of [1, 2, 3]) {
				const { tracks } = perspectiveTracks({ yawMaxDeg: 12, count: 40, seed });
				const plan = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks }), box: largeText, playhead: 0 }));
				expect(plan.notices).toEqual([]);
			}
		});

		test("few features and sigma 0.4 noise over a perspective pan: the homography over-fits, the warning stays (the review's M1)", () => {
			// With 12-14 features the homography (8 degrees of freedom) fits the noise
			// away: median residual 0.47-0.58 px against 0.9 for the similarity, 8-14
			// inliers. The same noise with 120 features warns (residual ~1.0), so
			// dropping the warning here was a false all-clear. Below 20 median inliers
			// the homography does not vouch for the video.
			for (const count of [12, 14]) {
				for (let seed = 1; seed <= 8; seed++) {
					const { tracks } = perspectiveTracks({ yawMaxDeg: 12, noise: 0.4, count, seed });
					const plan = planOf({ tracks: layout(), analysis: analysisOf({ tracks }), box: largeText, playhead: 0 });
					expect(plan.status).toBe("pinned");
					expect(plan.status === "pinned" && plan.notices).toContain("low-quality");
				}
			}
		});

		test("the same few features with a small element (similarity written): the warning stays too", () => {
			for (let seed = 1; seed <= 4; seed++) {
				const { tracks } = perspectiveTracks({ yawMaxDeg: 12, noise: 0.4, count: 12, seed });
				const plan = planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), box: { left: -10, top: -5, width: 20, height: 10 }, playhead: 1 });
				expect(plan.status).toBe("pinned");
				expect(plan.status === "pinned" && plan.notices).toContain("low-quality");
			}
		});

		test("the same clean pan with a small element (similarity written): the perspective is not low quality either", () => {
			const { tracks } = perspectiveTracks({ yawMaxDeg: 10 });
			const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), box: { left: -10, top: -5, width: 20, height: 10 }, playhead: 1 }));
			expect(plan.model).toBe("S");
			expect(plan.notices).toEqual([]);
		});

		test("a noisy clip that also has perspective still warns: the homography does not fit the noise away", () => {
			const { tracks } = perspectiveTracks({ yawMaxDeg: 12, noise: 1.1 });
			const plan = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks }), box: largeText, playhead: 0 }));
			expect(plan.notices).toContain("low-quality");
			const small = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks }), box: { left: -10, top: -5, width: 20, height: 10 }, playhead: 1 }));
			expect(small.notices).toContain("low-quality");
		});

		test("a noisy clip without perspective warns as before (no homography is solved for it)", () => {
			const plan = pinned(planOf({ tracks: STANDARD(), analysis: analysisOf({ tracks: similarityTracks({ noise: 1.1, count: 120 }) }) }));
			expect(plan.notices).toContain("low-quality");
		});
	});

	test("a homography that cannot be solved never wins, however far it is from the similarity", () => {
		const { tracks } = perspectiveTracks({ yawMaxDeg: 10 });
		const layout = scene({ overlay: [textTrack({ elements: [title({ start: 0, duration: 5 })] })] });
		const failing: typeof solvePin = (args) => {
			const solution = solvePin(args);
			if (args.model !== "H") return solution;
			// a solve that gave up: no frame solved, every map the identity
			solution.ok.fill(0);
			return solution;
		};
		const plan = pinned(
			planCameraPin({
				scene: pinScene({ tracks: layout, playhead: 0 }),
				elementId: "title",
				analysis: analysisOf({ tracks }),
				box: largeText,
				solve: failing,
			}),
		);
		expect(plan.model).toBe("S");
	});

	test("the homography is solved only when the similarity's residual asks for it", () => {
		const asked: string[] = [];
		const spy: typeof solvePin = (args) => {
			asked.push(`${args.model}-${args.mode}`);
			return solvePin(args);
		};
		planCameraPin({
			scene: pinScene({ tracks: STANDARD() }),
			elementId: "title",
			analysis: analysisOf({ tracks: similarityTracks() }),
			box: largeText,
			solve: spy,
		});
		expect(asked).toEqual(["S-scene"]);
		asked.length = 0;
		planCameraPin({
			scene: pinScene({ tracks: STANDARD(), playhead: 1 }),
			elementId: "title",
			analysis: analysisOf({ tracks: perspectiveTracks({ yawMaxDeg: 10 }).tracks }),
			box: largeText,
			solve: spy,
		});
		expect(asked).toEqual(["S-scene", "H-scene"]);
	});
});

describe("on a moving object, or the scene", () => {
	// the pin is on the frame's middle; eight features sit around it and drift on their own
	const PIN = { x: 239.5, y: 134.5 };
	function objectTracks(): FeatureTracks {
		const poses = posePath({ kind: "pan", n: FRAMES });
		const solution = exactSimilaritySolution({ poses, f0: 0 });
		const map = (t: number) => ({
			ar: solution.maps[4 * t],
			ai: solution.maps[4 * t + 1],
			br: solution.maps[4 * t + 2],
			bi: solution.maps[4 * t + 3],
		});
		const background = scatterPoints({ count: 160, seed: 3 })
			.filter((p) => Math.hypot(p.x - PIN.x, p.y - PIN.y) > 80)
			.slice(0, 90);
		const cluster = Array.from({ length: 8 }, (_, i) => ({
			x: PIN.x + 14 * Math.cos((i / 8) * 2 * Math.PI),
			y: PIN.y + 14 * Math.sin((i / 8) * 2 * Math.PI),
		}));
		return buildTracks({
			frameCount: FRAMES,
			specs: [
				...background.map((p) => ({ start: 0, end: FRAMES - 1, positionAt: (t: number) => applySim({ map: map(t), x: p.x, y: p.y }) })),
				...cluster.map((p) => ({
					start: 0,
					end: FRAMES - 1,
					positionAt: (t: number) => {
						const q = applySim({ map: map(t), x: p.x, y: p.y });
						return { x: q.x + 0.6 * t, y: q.y + 0.3 * t };
					},
				})),
			],
		});
	}
	const layout = () => scene({ overlay: [textTrack({ elements: [title({ start: 0, duration: 5 })] })] });

	test("auto: a pin on something that moves by itself follows the object and says so", () => {
		const plan = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks: objectTracks() }), playhead: 0 }));
		expect(plan.mode).toBe("object");
		expect(plan.notices).toContain("object");
		expect(plan.classification.isObject).toBe(true);
		expect(plan.pin.mode).toBe("object");
		// the title drifts with the object: by the last frame it is 0.6 x 149 x 4 canvas px further right than the pan alone
		const last = plan.keys.x[plan.keys.x.length - 1].value;
		const scene0 = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks: objectTracks() }), playhead: 0, mode: "scene" }));
		const sceneLast = scene0.keys.x[scene0.keys.x.length - 1].value;
		expect(last - sceneLast).toBeGreaterThan(0.5 * 149 * 4);
		expect(last - sceneLast).toBeLessThan(0.7 * 149 * 4);
	});

	test("scene on request: the object is ignored, and the warning goes", () => {
		const plan = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks: objectTracks() }), playhead: 0, mode: "scene" }));
		expect(plan.mode).toBe("scene");
		expect(plan.notices).not.toContain("object");
	});

	test("object on request, on a pin the classifier thinks is the background", () => {
		const tracks = similarityTracks({ count: 200 });
		const plan = planOf({ tracks: layout(), analysis: analysisOf({ tracks }), playhead: 0, mode: "object" });
		expect(plan.status).toBe("pinned");
		if (plan.status === "pinned") {
			expect(plan.mode).toBe("object");
			expect(plan.notices).not.toContain("object");
		}
	});

	test("object mode with nothing nearby to follow says there is no texture and writes nothing", () => {
		// features only far from the pin: the object weights find no one
		const poses = posePath({ kind: "pan", n: FRAMES });
		const tracks = similarityTracks({ poses, count: 20, seed: 9, avoid: { ...PIN, radius: 150 } });
		const plan = planOf({ tracks: layout(), analysis: analysisOf({ tracks }), playhead: 0, mode: "object" });
		expect(plan.status).toBe("no-keys");
		expect(plan.status === "no-keys" && plan.notices).toContain("no-texture");
	});

	test("a camera that is still while an object moves is not 'no motion' in object mode", () => {
		const background = scatterPoints({ count: 160, seed: 3 })
			.filter((p) => Math.hypot(p.x - PIN.x, p.y - PIN.y) > 80)
			.slice(0, 90);
		const cluster = Array.from({ length: 8 }, (_, i) => ({
			x: PIN.x + 14 * Math.cos((i / 8) * 2 * Math.PI),
			y: PIN.y + 14 * Math.sin((i / 8) * 2 * Math.PI),
		}));
		const tracks = buildTracks({
			frameCount: FRAMES,
			specs: [
				...background.map((p) => ({ start: 0, end: FRAMES - 1, positionAt: () => p })),
				...cluster.map((p) => ({ start: 0, end: FRAMES - 1, positionAt: (t: number) => ({ x: p.x + 0.5 * t, y: p.y }) })),
			],
		});
		const plan = pinned(planOf({ tracks: layout(), analysis: analysisOf({ tracks }), playhead: 0 }));
		expect(plan.mode).toBe("object");
		expect(plan.notices).not.toContain("no-motion");
		expect(plan.keys.x[plan.keys.x.length - 1].value).toBeGreaterThan(0.4 * 149 * 4);
	});
});

// ---------------------------------------------------------------------------
// Through the editor: apply, re-stick, unstick
// ---------------------------------------------------------------------------

describe("stickToScene writes through the editor", () => {
	test("one undo step, opacity and presets untouched, other animations kept", () => {
		const tracks = similarityTracks();
		const opacity: ScalarChannel = {
			keys: [
				{ id: "o1", time: sec(0), value: 1, segmentToNext: "linear", tangentMode: "flat" },
				{ id: "o2", time: sec(3), value: 0.2, segmentToNext: "linear", tangentMode: "flat" },
			],
		};
		const presets: PresetAnimations = { in: { id: "slide-left", duration: sec(0.2) } };
		const { editor, element, state } = createHarness({
			tracks: scene({
				overlay: [textTrack({ elements: [title({ overrides: { animations: { opacity }, presetAnimations: presets } })] })],
			}),
		});
		const original = state.tracks;
		const outcome = stickToScene({ elementId: "title", analysis: analysisOf({ tracks }), box: BOX });
		expect(outcome.status).toBe("pinned");
		expect(element().animations?.opacity).toBe(opacity);
		const written = element();
		if (written.type !== "text") throw new Error("expected the text element");
		expect(written.presetAnimations).toBe(presets);
		expect(element().params.opacity).toBe(0.9);
		expect(state.updates).toBe(1);
		editor.command.undo();
		expect(state.tracks).toBe(original);
	});

	test("errors come back as values and change nothing", () => {
		const { state, editor } = createHarness({ tracks: scene({ main: [], overlay: [textTrack({ elements: [title()] })] }) });
		const outcome = stickToScene({ elementId: "title", analysis: analysisOf({ tracks: similarityTracks() }), box: BOX });
		expect(outcome).toMatchObject({ status: "error", error: "no-video", message: "There is no video under this clip." });
		expect(state.updates).toBe(0);
		expect(editor.command.canUndo()).toBe(false);
	});
});

describe("stickToScene with other kinds of clip", () => {
	test("an image is stuck with the box its picture has, and moves by the rule for images", () => {
		const poses = posePath({ kind: "combo", n: FRAMES });
		const tracks = similarityTracks({ poses });
		const logo: ImageElement = {
			id: "logo",
			type: "image",
			name: "logo",
			mediaId: "m-logo",
			startTime: sec(1),
			duration: sec(3),
			trimStart: sec(0),
			trimEnd: sec(0),
			params: {
				"transform.positionX": 100,
				"transform.positionY": -40,
				"transform.scaleX": 0.3,
				"transform.scaleY": 0.2,
				"transform.rotate": 12,
			},
		};
		const layout = scene({
			overlay: [{ id: "img-track", name: "img", type: "video", muted: false, hidden: false, elements: [logo] }],
		});
		const { element } = createHarness({ tracks: layout, playhead: 2 });
		const analysis = analysisOf({ tracks });
		const outcome = stickToScene({ elementId: "logo", analysis });
		expect(outcome.status).toBe("pinned");
		if (outcome.status !== "pinned") return;
		expect(outcome.trackId).toBe("img-track");
		// 800 x 400 fitted into 1920 x 1080 is 1920 x 960
		const spec: ElementSpec = { rect: { left: -960, top: -480, width: 1920, height: 960 }, isText: false };
		const overlay: Look = { position: { x: 100, y: -40 }, scaleX: 0.3, scaleY: 0.2, rotate: 12 };
		const clock = analysisFrameClock({ analysis, host: video() });
		const truth = similarityWorldTruth({ poses, f0: outcome.frames.pin, host: fillHost });
		const start = renderedCorners({ spec, look: overlay });
		let worst = 0;
		for (let t = outcome.frames.first; t <= outcome.frames.last; t++) {
			const got = renderedCorners({ spec, look: lookOf({ element: element("logo"), seconds: clock.timeAt(t) }) });
			for (let k = 0; k < 4; k++) {
				const want = truth.canvasAt({ t, c: start[k] });
				worst = Math.max(worst, Math.hypot(got[k].x - want.x, got[k].y - want.y));
			}
		}
		expect(worst).toBeLessThanOrEqual(0.5);
	});

	test("text that cannot be measured (no canvas here) is refused, not guessed", () => {
		const { state, editor } = createHarness({ tracks: STANDARD() });
		const outcome = stickToScene({ elementId: "title", analysis: analysisOf({ tracks: similarityTracks() }) });
		expect(outcome).toMatchObject({ status: "error", error: "no-box" });
		expect(state.updates).toBe(0);
		expect(editor.command.canUndo()).toBe(false);
	});
});

describe("re-stick after the user moved, scaled or turned the element", () => {
	function stuck() {
		const poses = posePath({ kind: "combo", n: FRAMES });
		const tracks = similarityTracks({ poses });
		const analysis = analysisOf({ tracks });
		const harness = createHarness({ tracks: STANDARD(), playhead: 2 });
		const outcome = stickToScene({ elementId: "title", analysis, box: BOX });
		if (outcome.status !== "pinned") throw new Error("expected a pin");
		return { ...harness, poses, analysis, pin: outcome.pin, outcome };
	}

	test("the new look is kept at the playhead and the scene's motion is added from there", () => {
		const { element, poses, analysis, pin, state } = stuck();
		const clock = analysisFrameClock({ analysis, host: video() });
		const moved: Look = { position: { x: 120, y: 80 }, scaleX: 2, scaleY: 2, rotate: 30 };
		const result = repinElement({ elementId: "title", analysis, pin, look: moved, box: BOX });
		expect(result.status).toBe("pinned");
		if (result.status !== "pinned") return;
		expect(state.updates).toBe(2);
		const atPin = lookOf({ element: element(), seconds: clock.timeAt(result.frames.pin) });
		expect(atPin.position.x).toBeCloseTo(120, 6);
		expect(atPin.position.y).toBeCloseTo(80, 6);
		expect(atPin.scaleX).toBeCloseTo(2, 9);
		expect(atPin.rotate).toBeCloseTo(30, 6);
		const truth = similarityWorldTruth({ poses, f0: result.frames.pin, host: fillHost });
		const start = renderedCorners({ spec: TEXT_SPEC, look: moved });
		let worst = 0;
		for (let t = result.frames.first; t <= result.frames.last; t += 2) {
			const got = renderedCorners({ spec: TEXT_SPEC, look: lookOf({ element: element(), seconds: clock.timeAt(t) }) });
			for (let k = 0; k < 4; k++) {
				const want = truth.canvasAt({ t, c: start[k] });
				worst = Math.max(worst, Math.hypot(got[k].x - want.x, got[k].y - want.y));
			}
		}
		expect(worst).toBeLessThanOrEqual(0.5);
	});

	test("it is one undo step, which brings the earlier pin back", () => {
		const { editor, element, analysis, pin, state } = stuck();
		const before = state.tracks;
		repinElement({ elementId: "title", analysis, pin, look: { position: { x: 5, y: 5 }, scaleX: 1, scaleY: 1, rotate: 0 }, box: BOX });
		expect(state.tracks).not.toBe(before);
		editor.command.undo();
		expect(state.tracks).toBe(before);
		expect(element().animations?.["transform.positionX"]).toBeDefined();
	});

	test("without a new look it re-solves the same thing (idempotent within the budget)", () => {
		const { element, analysis, pin } = stuck();
		const clock = analysisFrameClock({ analysis, host: video() });
		const spec = TEXT_SPEC;
		const sample = () =>
			Array.from({ length: 12 }, (_, i) => {
				const corners = renderedCorners({ spec, look: lookOf({ element: element(), seconds: clock.timeAt(40 + i * 8) }) });
				return corners;
			});
		const before = sample();
		const result = repinElement({ elementId: "title", analysis, pin, box: BOX });
		expect(result.status).toBe("pinned");
		const after = sample();
		for (let i = 0; i < before.length; i++) {
			for (let k = 0; k < 4; k++) {
				expect(Math.hypot(before[i][k].x - after[i][k].x, before[i][k].y - after[i][k].y)).toBeLessThanOrEqual(1);
			}
		}
	});

	test("a pin whose clip changed afterwards is refused", () => {
		const { state, analysis, pin } = stuck();
		const [host] = state.tracks.main.elements;
		if (host.type !== "video") throw new Error("expected the host video");
		const moved: VideoElement = { ...host, startTime: sec(0.5) };
		state.tracks = { ...state.tracks, main: { ...state.tracks.main, elements: [moved] } };
		const result = repinElement({ elementId: "title", analysis, pin, box: BOX });
		expect(result).toMatchObject({ status: "error", error: "stale-pin", message: "The clip changed after sticking. Stick again." });
		expect(state.updates).toBe(1);
	});
});

describe("unstick", () => {
	test("the element stays where it is at the playhead, one undo step brings the pin back", () => {
		const tracks = similarityTracks();
		const analysis = analysisOf({ tracks });
		const { editor, element, state } = createHarness({ tracks: STANDARD(), playhead: 2 });
		const outcome = stickToScene({ elementId: "title", analysis, box: BOX });
		if (outcome.status !== "pinned") throw new Error("expected a pin");
		// the playhead moves along: unstick where the element is by then
		state.playhead = 3;
		const before = lookOf({ element: element(), seconds: 3 });
		const stuckTracks = state.tracks;
		const result = unstickElement({ elementId: "title", pin: outcome.pin });
		expect(result.status).toBe("unstuck");
		const after = lookOf({ element: element(), seconds: 3 });
		expect(after.position.x).toBeCloseTo(before.position.x, 9);
		expect(after.position.y).toBeCloseTo(before.position.y, 9);
		expect(after.scaleX).toBeCloseTo(before.scaleX, 9);
		expect((after.rotate - before.rotate) % 360).toBeCloseTo(0, 9);
		expect(element().animations).toBeUndefined();
		editor.command.undo();
		expect(state.tracks).toBe(stuckTracks);
	});

	test("an element that is gone", () => {
		const { state } = createHarness({ tracks: STANDARD() });
		const pin: CameraPinRecord = {
			elementId: "ghost",
			trackId: "text-track",
			analysisId: "x",
			hostElementId: "main-video",
			mode: "scene",
			model: "S",
			range: { start: sec(0), end: sec(1) },
			host: hostStateOf(video()),
		};
		expect(unstickElement({ elementId: "ghost", pin })).toMatchObject({ status: "error", error: "no-element" });
		expect(state.updates).toBe(0);
	});
});

describe("the pins registry", () => {
	const record = ({ id, analysisId = "a" }: { id: string; analysisId?: string }): CameraPinRecord => ({
		elementId: id,
		trackId: "t",
		analysisId,
		hostElementId: "main-video",
		mode: "scene",
		model: "S",
		range: { start: sec(0), end: sec(2) },
		host: hostStateOf(video()),
	});

	test("add, replace and remove without touching what was there", () => {
		const empty = {};
		const one = withPin({ pins: empty, pin: record({ id: "a" }) });
		const two = withPin({ pins: one, pin: record({ id: "b" }) });
		const replaced = withPin({ pins: two, pin: record({ id: "a", analysisId: "newer" }) });
		expect(empty).toEqual({});
		expect(Object.keys(two).sort()).toEqual(["a", "b"]);
		expect(one).toEqual({ a: record({ id: "a" }) });
		expect(pinOf({ pins: replaced, elementId: "a" })?.analysisId).toBe("newer");
		const gone = withoutPin({ pins: replaced, elementId: "a" });
		expect(pinOf({ pins: gone, elementId: "a" })).toBeNull();
		expect(pinOf({ pins: gone, elementId: "b" })).not.toBeNull();
		expect(withoutPin({ pins: gone, elementId: "nothing" })).toBe(gone);
	});

	test("a pin is current while its host plays the same frames in the same place", () => {
		const host = video({ start: 1, duration: 5, trim: 0.5, rate: 2 });
		const pin = { ...record({ id: "a" }), host: hostStateOf(host) };
		expect(isPinCurrent({ pin, host })).toBe(true);
		expect(isPinCurrent({ pin, host: { ...host, startTime: sec(1.5) } })).toBe(false);
		expect(isPinCurrent({ pin, host: { ...host, duration: sec(4) } })).toBe(false);
		expect(isPinCurrent({ pin, host: { ...host, trimStart: sec(0.6) } })).toBe(false);
		expect(isPinCurrent({ pin, host: { ...host, retime: { rate: 1.5 } } })).toBe(false);
		expect(isPinCurrent({ pin, host: { ...host, mediaId: "m-new" } })).toBe(false);
		// a change that does not move frames is not a change
		const restyled: VideoElement = { ...host, params: { "transform.scaleX": 2 } };
		expect(isPinCurrent({ pin, host: restyled })).toBe(true);
		expect(isPinCurrent({ pin, host: null })).toBe(false);
	});
});
