/**
 * What the UI asks the project before drawing "Stick to scene" (slice T4):
 * does a video lie under the element, and has the pinned host stayed put.
 */
import { describe, expect, test } from "bun:test";
import type { ScalarAnimationKey } from "@/animation/types";
import type { OverlayTrack, SceneTracks, TextElement, VideoElement } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";
import { hostStateOf, type CameraPinRecord, type PinScene } from "../pin-element";
import { IDLE_CAMERA_JOB, type CameraAnalysisJob, type CameraPinOutcome } from "../analysis-types";
import { CAMERA_PIN_PATHS } from "../pin-animations";
import { pinTargetState, pinViewFor } from "../pin-target";

const sec = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });

function video({ id = "v1", start = 0, duration = 5, hidden = false }: { id?: string; start?: number; duration?: number; hidden?: boolean } = {}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "m1",
		startTime: sec(start),
		duration: sec(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
		hidden,
	};
}

function title(): TextElement {
	return {
		id: "t1",
		type: "text",
		name: "t1",
		startTime: sec(1),
		duration: sec(3),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: "Hello" },
	};
}

function tracks({ main = [video()], overlay = [] }: { main?: VideoElement[]; overlay?: OverlayTrack[] } = {}): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: main },
		overlay: [
			{ id: "text-track", name: "Text", type: "text", hidden: false, elements: [title()] },
			...overlay,
		],
		audio: [],
	};
}

function scene({ tracks: sceneTracks, playhead = 2 }: { tracks: SceneTracks; playhead?: number }): PinScene {
	return {
		tracks: sceneTracks,
		canvasSize: { width: 1920, height: 1080 },
		mediaSize: () => undefined,
		playhead: sec(playhead),
	};
}

function pinFor({ host }: { host: VideoElement }): CameraPinRecord {
	return {
		elementId: "t1",
		trackId: "text-track",
		analysisId: "a1",
		hostElementId: host.id,
		mode: "scene",
		model: "S",
		range: { start: ZERO_MEDIA_TIME, end: sec(3) },
		host: hostStateOf(host),
	};
}

describe("pinTargetState", () => {
	test("a video under the element's track is a target", () => {
		const result = pinTargetState({ scene: scene({ tracks: tracks() }), elementId: "t1", pin: null });
		expect(result.hasVideoUnder).toBe(true);
	});

	test("no video, or a hidden one, leaves nothing to stick to", () => {
		expect(pinTargetState({ scene: scene({ tracks: tracks({ main: [] }) }), elementId: "t1", pin: null }).hasVideoUnder).toBe(false);
		expect(
			pinTargetState({ scene: scene({ tracks: tracks({ main: [video({ hidden: true })] }) }), elementId: "t1", pin: null }).hasVideoUnder,
		).toBe(false);
	});

	test("a video that does not meet the element in time is not a target", () => {
		const late = tracks({ main: [video({ start: 10, duration: 2 })] });
		expect(pinTargetState({ scene: scene({ tracks: late }), elementId: "t1", pin: null }).hasVideoUnder).toBe(false);
	});

	test("an element that is gone has no target", () => {
		expect(pinTargetState({ scene: scene({ tracks: tracks() }), elementId: "nope", pin: null }).hasVideoUnder).toBe(false);
	});

	test("a pin whose element has no keys (the stick was undone) has no pin keys", () => {
		const host = video();
		const result = pinTargetState({ scene: scene({ tracks: tracks() }), elementId: "t1", pin: pinFor({ host }) });
		expect(result.hasPinKeys).toBe(false);
		expect(pinTargetState({ scene: scene({ tracks: tracks() }), elementId: "t1", pin: null }).hasPinKeys).toBe(false);
	});

	test("without a pin the host cannot have changed", () => {
		expect(pinTargetState({ scene: scene({ tracks: tracks() }), elementId: "t1", pin: null }).isPinCurrent).toBe(true);
	});

	test("a pin is current while its host is where it was", () => {
		const host = video();
		const result = pinTargetState({ scene: scene({ tracks: tracks({ main: [host] }) }), elementId: "t1", pin: pinFor({ host }) });
		expect(result.isPinCurrent).toBe(true);
	});

	test("a moved, trimmed or removed host makes the pin stale", () => {
		const host = video();
		const pin = pinFor({ host });
		const moved = tracks({ main: [video({ start: 1 })] });
		expect(pinTargetState({ scene: scene({ tracks: moved }), elementId: "t1", pin }).isPinCurrent).toBe(false);
		const shorter = tracks({ main: [video({ duration: 4 })] });
		expect(pinTargetState({ scene: scene({ tracks: shorter }), elementId: "t1", pin }).isPinCurrent).toBe(false);
		const gone = tracks({ main: [] });
		expect(pinTargetState({ scene: scene({ tracks: gone }), elementId: "t1", pin }).isPinCurrent).toBe(false);
	});
});

describe("pinViewFor (what the section and the chip draw: every input reaches the view)", () => {
	const key = (index: number): ScalarAnimationKey => ({
		id: `k${index}`,
		time: sec(index),
		value: index,
		segmentToNext: "linear",
		tangentMode: "flat",
	});
	const pinKeys = Object.fromEntries(Object.values(CAMERA_PIN_PATHS).map((path) => [path, { keys: [key(0), key(3)] }]));
	const stuckTracks = ({ main = [video()] }: { main?: VideoElement[] } = {}): SceneTracks => ({
		...tracks({ main }),
		overlay: [{ id: "text-track", name: "Text", type: "text", hidden: false, elements: [{ ...title(), animations: pinKeys }] }],
	});
	const RUNNING_ELSEWHERE: CameraAnalysisJob = { state: "running", hostElementId: "v1", progress: 0.5 };
	const PINNED: CameraPinOutcome = {
		status: "pinned",
		elementId: "t1",
		notices: ["cut"],
		lostFrame: null,
		cutTimes: [2.5],
		mode: "scene",
		model: "S",
	};

	function viewOf({
		sceneTracks = tracks(),
		pin = null,
		job = IDLE_CAMERA_JOB,
		outcomes = {},
		busyRefused = false,
		elementStartSeconds = 0,
		stickingElementId = null,
		withScene = true,
	}: {
		sceneTracks?: SceneTracks;
		pin?: CameraPinRecord | null;
		job?: CameraAnalysisJob;
		outcomes?: Readonly<Record<string, CameraPinOutcome>>;
		busyRefused?: boolean;
		elementStartSeconds?: number;
		stickingElementId?: string | null;
		withScene?: boolean;
	} = {}) {
		return pinViewFor({
			element: { id: "t1", type: "text" },
			elementStartSeconds,
			pins: pin ? { t1: pin } : {},
			job,
			outcomes,
			stickingElementId,
			busyRefused,
			scene: withScene ? scene({ tracks: sceneTracks }) : null,
		});
	}

	test("a record with its keys on the element is stuck, with the range from the element's start", () => {
		const host = video();
		const result = viewOf({ sceneTracks: stuckTracks(), pin: pinFor({ host }), elementStartSeconds: 1 });
		expect(result.state).toBe("stuck");
		expect(result.stuck?.summary).toBe("Stuck 0:01.0 - 0:04.0 (Scene)");
	});

	test("a record whose keys are gone (Ctrl+Z) is idle: the keys are read from the project", () => {
		const host = video();
		const result = viewOf({ sceneTracks: tracks(), pin: pinFor({ host }), outcomes: { t1: PINNED } });
		expect(result.state).toBe("idle");
		expect(result.canUnstick).toBe(false);
		expect(result.notices).toEqual([]);
	});

	test("a pin whose host moved is stale: the host is read from the project", () => {
		const host = video();
		const moved = stuckTracks({ main: [video({ start: 1 })] });
		expect(viewOf({ sceneTracks: moved, pin: pinFor({ host }) }).state).toBe("stale");
	});

	test("no video under the clip disables Stick: the video is read from the project", () => {
		const result = viewOf({ sceneTracks: tracks({ main: [] }) });
		expect(result.state).toBe("disabled");
		expect(result.disabledReason).toBe("There is no video under this clip.");
	});

	test("a busy refusal shows while another run lasts: busyRefused reaches the view", () => {
		const shown = viewOf({ job: RUNNING_ELSEWHERE, busyRefused: true });
		expect(shown.notices.map((notice) => notice.id)).toEqual(["error:busy"]);
		expect(viewOf({ job: RUNNING_ELSEWHERE, busyRefused: false }).notices).toEqual([]);
	});

	test("the job disables Stick when another clip's run is in flight", () => {
		expect(viewOf({ job: RUNNING_ELSEWHERE }).canStick).toBe(false);
		expect(viewOf({ job: RUNNING_ELSEWHERE }).state).toBe("disabled");
	});

	test("the element's own run shows its progress: stickingElementId reaches the view", () => {
		const own = viewOf({ job: RUNNING_ELSEWHERE, stickingElementId: "t1" });
		expect(own.state).toBe("analysing");
		expect(own.progress?.percent).toBe(50);
	});

	test("the outcome's notices show while the element is stuck: the outcomes reach the view", () => {
		const stuck = viewOf({ sceneTracks: stuckTracks(), pin: pinFor({ host: video() }), outcomes: { t1: PINNED } });
		expect(stuck.notices.map((notice) => notice.id)).toEqual(["cut:2.5"]);
	});

	test("the element is the one asked about: another element's record does not make it stuck", () => {
		const result = pinViewFor({
			element: { id: "t1", type: "text" },
			elementStartSeconds: 0,
			pins: { other: { ...pinFor({ host: video() }), elementId: "other" } },
			job: IDLE_CAMERA_JOB,
			outcomes: {},
			stickingElementId: null,
			busyRefused: false,
			scene: scene({ tracks: stuckTracks() }),
		});
		expect(result.state).toBe("idle");
	});

	test("without a scene (none open) nothing can be stuck and there is no video to stick to", () => {
		const result = viewOf({ withScene: false });
		expect(result.state).toBe("disabled");
		expect(result.canStick).toBe(false);
		expect(viewOf({ withScene: false, pin: pinFor({ host: video() }) }).state).toBe("disabled");
	});
});
