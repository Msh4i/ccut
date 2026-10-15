/**
 * What the "Stick to scene" section and the preview chip show, as plain data
 * (slice T4, plan section d): the button state, the progress and the notices,
 * word for word.
 */
import { describe, expect, test } from "bun:test";
import { IDLE_CAMERA_JOB, type CameraAnalysisJob, type CameraPinOutcome } from "../analysis-types";
import { CAMERA_PIN_MESSAGES, type CameraPinErrorCode, type CameraPinRecord } from "../pin-element";
import {
	buildPinView,
	formatPinTime,
	isPinOverlayType,
	shouldShowPinChip,
	type PinViewInput,
} from "../pin-view";
import { CAMERA_PIN_NOT_READY_MESSAGE } from "../store";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

const ticks = (seconds: number) => mediaTimeFromSeconds({ seconds });

function pinRecord(overrides: Partial<CameraPinRecord> = {}): CameraPinRecord {
	return {
		elementId: "text-1",
		trackId: "track-1",
		analysisId: "analysis-1",
		hostElementId: "video-1",
		mode: "scene",
		model: "S",
		range: { start: ZERO_MEDIA_TIME, end: ticks(8.4) },
		host: {
			mediaId: "media-1",
			startTime: ZERO_MEDIA_TIME,
			duration: ticks(10),
			trimStart: ZERO_MEDIA_TIME,
			rate: 1,
		},
		...overrides,
	};
}

function pinnedOutcome(overrides: Partial<Extract<CameraPinOutcome, { status: "pinned" }>> = {}): CameraPinOutcome {
	return {
		status: "pinned",
		elementId: "text-1",
		notices: [],
		lostFrame: null,
		cutTimes: [],
		mode: "scene",
		model: "S",
		...overrides,
	};
}

function view(overrides: Partial<PinViewInput> = {}) {
	return buildPinView({
		element: { id: "text-1", type: "text" },
		pins: {},
		job: IDLE_CAMERA_JOB,
		outcomes: {},
		stickingElementId: null,
		hasVideoUnder: true,
		...overrides,
	});
}

function isErrorCode(value: string): value is CameraPinErrorCode {
	return value in CAMERA_PIN_MESSAGES;
}

const RUNNING: CameraAnalysisJob = { state: "running", hostElementId: "video-1", progress: 0.624 };

describe("isPinOverlayType (the Tracking tab is for overlays only)", () => {
	test("text, image, sticker and graphic stick; video and audio do not", () => {
		for (const type of ["text", "image", "sticker", "graphic"]) {
			expect(isPinOverlayType(type)).toBe(true);
		}
		for (const type of ["video", "audio", "effect", ""]) {
			expect(isPinOverlayType(type)).toBe(false);
		}
	});
});

describe("shouldShowPinChip", () => {
	test("for a selected overlay clip", () => {
		for (const elementType of ["text", "image", "sticker", "graphic"]) {
			expect(shouldShowPinChip({ elementType, isEditingText: false })).toBe(true);
		}
	});

	test("not for a video, audio, effect or nothing selected", () => {
		for (const elementType of ["video", "audio", "effect", null]) {
			expect(shouldShowPinChip({ elementType, isEditingText: false })).toBe(false);
		}
	});

	test("not while the text is being edited in place", () => {
		expect(shouldShowPinChip({ elementType: "text", isEditingText: true })).toBe(false);
	});
});

describe("formatPinTime (m:ss.s, truncated to a tenth like the timeline clock)", () => {
	test("formats minutes, seconds and tenths", () => {
		expect(formatPinTime({ seconds: 0 })).toBe("0:00.0");
		expect(formatPinTime({ seconds: 5.2 })).toBe("0:05.2");
		expect(formatPinTime({ seconds: 8.4 })).toBe("0:08.4");
		expect(formatPinTime({ seconds: 65.04 })).toBe("1:05.0");
		expect(formatPinTime({ seconds: 600 })).toBe("10:00.0");
	});

	test("never rolls a rounded value to 60 seconds, never goes negative", () => {
		expect(formatPinTime({ seconds: 59.96 })).toBe("0:59.9");
		expect(formatPinTime({ seconds: -3 })).toBe("0:00.0");
		expect(formatPinTime({ seconds: Number.NaN })).toBe("0:00.0");
	});
});

describe("the button states", () => {
	test("idle: a video lies under the element, nothing is stuck", () => {
		const result = view();
		expect(result.state).toBe("idle");
		expect(result.stickLabel).toBe("Stick to scene");
		expect(result.canStick).toBe(true);
		expect(result.disabledReason).toBeNull();
		expect(result.progress).toBeNull();
		expect(result.stuck).toBeNull();
		expect(result.canUnstick).toBe(false);
		expect(result.notices).toEqual([]);
	});

	test("disabled with the reason when there is no video under the clip", () => {
		const result = view({ hasVideoUnder: false });
		expect(result.state).toBe("disabled");
		expect(result.canStick).toBe(false);
		expect(result.disabledReason).toBe("There is no video under this clip.");
		expect(result.disabledReason).toBe(CAMERA_PIN_MESSAGES["no-video"]);
	});

	test("disabled for a kind of clip that cannot be stuck", () => {
		const result = view({ element: { id: "v1", type: "video" } });
		expect(result.state).toBe("disabled");
		expect(result.disabledReason).toBe(CAMERA_PIN_MESSAGES["unsupported-element"]);
	});

	test("analysing: the percentage is rounded, Cancel is offered", () => {
		const result = view({ job: RUNNING, stickingElementId: "text-1" });
		expect(result.state).toBe("analysing");
		expect(result.progress).toEqual({ percent: 62, label: "Analysing... 62%", cancelLabel: "Cancel" });
		expect(result.canStick).toBe(false);
	});

	test("progress is clamped to 0..100 and survives NaN", () => {
		const at = (progress: number) =>
			view({ job: { ...RUNNING, progress }, stickingElementId: "text-1" }).progress?.label;
		expect(at(-1)).toBe("Analysing... 0%");
		expect(at(7)).toBe("Analysing... 100%");
		expect(at(Number.NaN)).toBe("Analysing... 0%");
	});

	test("another clip's analysis disables this one's button with a reason (one run at a time)", () => {
		const result = view({ job: RUNNING, stickingElementId: "other-1" });
		expect(result.state).toBe("disabled");
		expect(result.progress).toBeNull();
		expect(result.disabledReason).toBe("Another clip is being analysed.");
	});

	test("a running job that nobody here started also disables (no Cancel for what this element did not start)", () => {
		const result = view({ job: RUNNING, stickingElementId: null });
		expect(result.state).toBe("disabled");
		expect(result.disabledReason).toBe("Another clip is being analysed.");
	});

	test("stuck: shows the range, the mode and Unstick", () => {
		const result = view({ pins: { "text-1": pinRecord() } });
		expect(result.state).toBe("stuck");
		expect(result.stuck).toEqual({
			label: "Stuck",
			mode: "scene",
			modeLabel: "Scene",
			summary: "Stuck 0:00.0 - 0:08.4 (Scene)",
		});
		expect(result.canUnstick).toBe(true);
		expect(result.canStick).toBe(false);
	});

	test("the range is read from the clip's own start (ticks from the start of the element)", () => {
		const result = view({
			pins: { "text-1": pinRecord({ range: { start: ticks(1), end: ticks(3.5) } }) },
			elementStartSeconds: 2,
		});
		expect(result.stuck?.summary).toBe("Stuck 0:03.0 - 0:05.5 (Scene)");
	});

	test("object mode is named Moving object", () => {
		const result = view({ pins: { "text-1": pinRecord({ mode: "object" }) } });
		expect(result.stuck?.mode).toBe("object");
		expect(result.stuck?.modeLabel).toBe("Moving object");
		expect(result.stuck?.summary).toBe("Stuck 0:00.0 - 0:08.4 (Moving object)");
	});

	test("the Follow choice offers Scene and Moving object, in that order", () => {
		expect(view({ pins: { "text-1": pinRecord() } }).followOptions).toEqual([
			{ mode: "scene", label: "Scene" },
			{ mode: "object", label: "Moving object" },
		]);
	});

	test("a pin on another element does not make this one stuck", () => {
		const result = view({ pins: { "text-2": pinRecord({ elementId: "text-2" }) } });
		expect(result.state).toBe("idle");
		expect(result.stuck).toBeNull();
	});

	test("stuck while a re-stick runs: shows the progress, not the stuck line", () => {
		const result = view({
			pins: { "text-1": pinRecord() },
			job: RUNNING,
			stickingElementId: "text-1",
		});
		expect(result.state).toBe("analysing");
		expect(result.canUnstick).toBe(false);
	});

	test("a stuck element whose host changed offers to stick again and keeps Unstick", () => {
		const result = view({ pins: { "text-1": pinRecord() }, isPinCurrent: false });
		expect(result.state).toBe("stale");
		expect(result.canStick).toBe(true);
		expect(result.canUnstick).toBe(true);
		expect(result.stuck).toBeNull();
		expect(result.notices.map((notice) => notice.text)).toEqual([
			"The clip changed after sticking. Stick again.",
		]);
	});

	test("with no video under it any more, a stale pin is still stale, not disabled (Unstick must stay reachable)", () => {
		const result = view({ pins: { "text-1": pinRecord() }, isPinCurrent: false, hasVideoUnder: false });
		expect(result.canUnstick).toBe(true);
		expect(result.canStick).toBe(false);
		expect(result.disabledReason).toBe("There is no video under this clip.");
	});
});

describe("notices (exact texts from the plan)", () => {
	const textsOf = (outcome: CameraPinOutcome) =>
		view({ outcomes: { "text-1": outcome } }).notices.map((notice) => notice.text);

	test("no-texture and no-motion come with the no-keys outcome", () => {
		expect(textsOf({ status: "no-keys", elementId: "text-1", notices: ["no-texture"], lostFrame: null })).toEqual([
			"Not enough detail in this clip to follow the scene.",
		]);
		expect(textsOf({ status: "no-keys", elementId: "text-1", notices: ["no-motion"], lostFrame: null })).toEqual([
			"No camera movement in this clip, nothing to stick to.",
		]);
	});

	test("a scene cut names its time from cutTimes", () => {
		expect(textsOf(pinnedOutcome({ notices: ["cut"], cutTimes: [5.2] }))).toEqual([
			"Scene cut at 0:05.2, stuck until there.",
		]);
		expect(textsOf(pinnedOutcome({ notices: ["cut"], cutTimes: [75.5] }))).toEqual([
			"Scene cut at 1:15.5, stuck until there.",
		]);
	});

	test("two cuts give two notices in time order; a cut with no time still says so", () => {
		expect(textsOf(pinnedOutcome({ notices: ["cut"], cutTimes: [9, 5.2] }))).toEqual([
			"Scene cut at 0:05.2, stuck until there.",
			"Scene cut at 0:09.0, stuck until there.",
		]);
		expect(textsOf(pinnedOutcome({ notices: ["cut"], cutTimes: [] }))).toEqual([
			"Scene cut, stuck until there.",
		]);
	});

	test("low quality is a warning, the stick still applies", () => {
		expect(textsOf(pinnedOutcome({ notices: ["low-quality"] }))).toEqual([
			"Video quality is low, the stick may drift.",
		]);
	});

	test("lost tracking: the UI has no frame-to-time mapping, so the text says 'part of the way'", () => {
		expect(textsOf(pinnedOutcome({ notices: ["lost"], lostFrame: 142 }))).toEqual([
			"Lost track of the scene part of the way, stuck until there.",
		]);
	});

	test("object mode explains itself and offers Use scene", () => {
		const result = view({
			outcomes: { "text-1": pinnedOutcome({ notices: ["object"], mode: "object" }) },
			pins: { "text-1": pinRecord({ mode: "object" }) },
		});
		expect(result.notices).toEqual([
			{
				id: "object",
				text: "This spot moves differently from the scene: following the object.",
				action: { kind: "use-scene", label: "Use scene" },
			},
		]);
	});

	test("the object notice has no Use scene once the scene is what is followed", () => {
		const result = view({
			outcomes: { "text-1": pinnedOutcome({ notices: ["object"], mode: "scene" }) },
		});
		expect(result.notices.every((notice) => notice.action === null)).toBe(true);
	});

	test("several notices keep the engine's order and appear once each", () => {
		expect(
			textsOf(pinnedOutcome({ notices: ["low-quality", "cut", "low-quality"], cutTimes: [5.2] })),
		).toEqual(["Video quality is low, the stick may drift.", "Scene cut at 0:05.2, stuck until there."]);
	});

	test("every failure shows its own message (busy only while a run lasts, see below)", () => {
		const entries = Object.entries(CAMERA_PIN_MESSAGES);
		expect(entries.length).toBe(13);
		for (const [error, message] of entries) {
			if (!isErrorCode(error)) throw new Error(`unknown code ${error}`);
			if (error === "busy") continue;
			expect(textsOf({ status: "error", elementId: "text-1", error, message })).toEqual([message]);
		}
	});

	test("a failure with an empty message falls back to the code's message", () => {
		expect(textsOf({ status: "error", elementId: "text-1", error: "no-video", message: "" })).toEqual([
			CAMERA_PIN_MESSAGES["no-video"],
		]);
	});

	test("not ready: the engine is not registered, the message is shown as a notice and the button stays usable", () => {
		const result = view({
			outcomes: {
				"text-1": {
					status: "error",
					elementId: "text-1",
					error: "apply-failed",
					message: CAMERA_PIN_NOT_READY_MESSAGE,
				},
			},
		});
		expect(result.state).toBe("idle");
		expect(result.canStick).toBe(true);
		expect(result.notices.map((notice) => notice.text)).toEqual([CAMERA_PIN_NOT_READY_MESSAGE]);
	});

	test("a cancelled run says nothing (the element is untouched)", () => {
		expect(textsOf({ status: "cancelled", elementId: "text-1" })).toEqual([]);
	});

	test("notices of another element's outcome are not shown", () => {
		const result = view({
			outcomes: { "text-2": pinnedOutcome({ elementId: "text-2", notices: ["low-quality"] }) },
		});
		expect(result.notices).toEqual([]);
	});

	test("notices are hidden while a run is in progress", () => {
		const result = view({
			job: RUNNING,
			stickingElementId: "text-1",
			outcomes: { "text-1": pinnedOutcome({ notices: ["low-quality"] }) },
		});
		expect(result.notices).toEqual([]);
	});

	test("a stale pin shows its notice first, then the outcome's", () => {
		const result = view({
			pins: { "text-1": pinRecord() },
			isPinCurrent: false,
			outcomes: { "text-1": pinnedOutcome({ notices: ["low-quality"] }) },
		});
		expect(result.notices.map((notice) => notice.text)).toEqual([
			"The clip changed after sticking. Stick again.",
			"Video quality is low, the stick may drift.",
		]);
	});

	test("a stale error outcome and the stale pin do not repeat the same sentence", () => {
		const result = view({
			pins: { "text-1": pinRecord() },
			isPinCurrent: false,
			outcomes: {
				"text-1": {
					status: "error",
					elementId: "text-1",
					error: "stale-pin",
					message: CAMERA_PIN_MESSAGES["stale-pin"],
				},
			},
		});
		expect(result.notices.map((notice) => notice.text)).toEqual([CAMERA_PIN_MESSAGES["stale-pin"]]);
	});
});

describe("T4 review: mode changes, busy and announcements", () => {
	test("Follow and Use scene are offered only while no run is in flight", () => {
		const stuck = { pins: { "text-1": pinRecord() } };
		expect(view(stuck).canChangeMode).toBe(true);
		expect(view({ ...stuck, job: RUNNING }).canChangeMode).toBe(false);
		expect(view({ job: RUNNING, stickingElementId: "text-1" }).canChangeMode).toBe(false);
	});

	test("a busy outcome left from before is not a notice once the run is over", () => {
		const busy: CameraPinOutcome = {
			status: "error",
			elementId: "text-1",
			error: "busy",
			message: CAMERA_PIN_MESSAGES.busy,
		};
		expect(view({ outcomes: { "text-1": busy } }).notices).toEqual([]);
	});

	test("a busy refusal shows while the run lasts, before the element's own notices", () => {
		const outcomes = { "text-1": pinnedOutcome({ notices: ["lost"] }) };
		const pins = { "text-1": pinRecord() };
		const during = view({ outcomes, pins, job: RUNNING, busyRefused: true });
		expect(during.notices.map((notice) => notice.id)).toEqual(["error:busy", "lost"]);
		expect(during.notices[0]?.text).toBe(CAMERA_PIN_MESSAGES.busy);
		// the run is over: whatever the flag says, only the element's notices remain
		expect(view({ outcomes, pins, busyRefused: true }).notices.map((notice) => notice.id)).toEqual(["lost"]);
	});

	test("screen readers hear the start and a cancel, never the percentage", () => {
		const analysing = view({ job: RUNNING, stickingElementId: "text-1" });
		expect(analysing.announcement).toBe("Analysing...");
		expect(view({ job: { ...RUNNING, progress: 0.9 }, stickingElementId: "text-1" }).announcement).toBe(
			analysing.announcement,
		);
		expect(view({ outcomes: { "text-1": { status: "cancelled", elementId: "text-1" } } }).announcement).toBe(
			"Analysis cancelled.",
		);
		expect(view().announcement).toBe("");
	});
});

describe("an undone stick shows none of the pinned outcome's notices", () => {
	const noisy = pinnedOutcome({ notices: ["cut", "object", "low-quality", "lost"], cutTimes: [5.2], mode: "object" });
	const pins = { "text-1": pinRecord({ mode: "object" }) };

	test("with the keys there, the notices show (and Use scene is offered)", () => {
		const result = view({ outcomes: { "text-1": noisy }, pins, hasPinKeys: true });
		expect(result.notices.map((notice) => notice.id)).toEqual(["cut:5.2", "object", "low-quality", "lost"]);
		expect(result.notices.some((notice) => notice.action?.kind === "use-scene")).toBe(true);
	});

	test("without the keys (Ctrl+Z of the stick): no notice, no Use scene, the element is idle", () => {
		const result = view({ outcomes: { "text-1": noisy }, pins, hasPinKeys: false });
		expect(result.notices).toEqual([]);
		expect(result.state).toBe("idle");
		expect(result.canStick).toBe(true);
	});

	test("the same without a record at all", () => {
		expect(view({ outcomes: { "text-1": noisy }, hasPinKeys: false }).notices).toEqual([]);
	});

	test("only the pinned outcome is hidden: a failure or a no-keys outcome still tells why", () => {
		const failed: CameraPinOutcome = {
			status: "error",
			elementId: "text-1",
			error: "no-video",
			message: CAMERA_PIN_MESSAGES["no-video"],
		};
		const noKeys: CameraPinOutcome = { status: "no-keys", elementId: "text-1", notices: ["no-motion"], lostFrame: null };
		expect(view({ outcomes: { "text-1": failed }, hasPinKeys: false }).notices.map((notice) => notice.id)).toEqual([
			"error:no-video",
		]);
		expect(view({ outcomes: { "text-1": noKeys }, hasPinKeys: false }).notices.map((notice) => notice.id)).toEqual([
			"no-motion",
		]);
	});

	test("a busy refusal during a run still shows", () => {
		const result = view({ outcomes: { "text-1": noisy }, hasPinKeys: false, job: RUNNING, busyRefused: true });
		expect(result.notices.map((notice) => notice.id)).toEqual(["error:busy"]);
	});
});
