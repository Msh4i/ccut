import { IDLE_CAMERA_JOB, type CameraAnalysisJob, type CameraPinOutcome } from "@/tracking/camera/analysis-types";
import type { CameraPinRecord } from "@/tracking/camera/pin-element";
import { buildPinView, type PinView, type PinViewInput } from "@/tracking/camera/pin-view";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

export const ELEMENT = { id: "text-1", type: "text" } as const;

export const PIN: CameraPinRecord = {
	elementId: ELEMENT.id,
	trackId: "track-1",
	analysisId: "analysis-1",
	hostElementId: "video-1",
	mode: "scene",
	model: "S",
	range: { start: ZERO_MEDIA_TIME, end: mediaTimeFromSeconds({ seconds: 8.4 }) },
	host: {
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		rate: 1,
	},
};

export const RUNNING: CameraAnalysisJob = { state: "running", hostElementId: "video-1", progress: 0.62 };

export function pinned(overrides: Partial<Extract<CameraPinOutcome, { status: "pinned" }>> = {}): CameraPinOutcome {
	return {
		status: "pinned",
		elementId: ELEMENT.id,
		notices: [],
		lostFrame: null,
		cutTimes: [],
		mode: "scene",
		model: "S",
		...overrides,
	};
}

export function viewOf(overrides: Partial<PinViewInput> = {}): PinView {
	return buildPinView({
		element: ELEMENT,
		pins: {},
		job: IDLE_CAMERA_JOB,
		outcomes: {},
		stickingElementId: null,
		hasVideoUnder: true,
		...overrides,
	});
}

/** Every state the plan shows, by name. */
export const STATES: Record<string, PinView> = {
	idle: viewOf(),
	"no video": viewOf({ hasVideoUnder: false }),
	analysing: viewOf({ job: RUNNING, stickingElementId: ELEMENT.id }),
	stuck: viewOf({ pins: { [ELEMENT.id]: PIN } }),
	"stuck, object": viewOf({ pins: { [ELEMENT.id]: { ...PIN, mode: "object" } } }),
	stale: viewOf({ pins: { [ELEMENT.id]: PIN }, isPinCurrent: false }),
	"no texture": viewOf({
		outcomes: { [ELEMENT.id]: { status: "no-keys", elementId: ELEMENT.id, notices: ["no-texture"], lostFrame: null } },
	}),
	"no motion": viewOf({
		outcomes: { [ELEMENT.id]: { status: "no-keys", elementId: ELEMENT.id, notices: ["no-motion"], lostFrame: null } },
	}),
	cut: viewOf({
		pins: { [ELEMENT.id]: PIN },
		outcomes: { [ELEMENT.id]: pinned({ notices: ["cut"], cutTimes: [5.2] }) },
	}),
	"low quality": viewOf({
		pins: { [ELEMENT.id]: PIN },
		outcomes: { [ELEMENT.id]: pinned({ notices: ["low-quality"] }) },
	}),
	lost: viewOf({
		pins: { [ELEMENT.id]: PIN },
		outcomes: { [ELEMENT.id]: pinned({ notices: ["lost"], lostFrame: 12 }) },
	}),
	object: viewOf({
		pins: { [ELEMENT.id]: { ...PIN, mode: "object" } },
		outcomes: { [ELEMENT.id]: pinned({ notices: ["object"], mode: "object" }) },
	}),
	"object, another clip running": viewOf({
		pins: { [ELEMENT.id]: { ...PIN, mode: "object" } },
		outcomes: { [ELEMENT.id]: pinned({ notices: ["object"], mode: "object" }) },
		job: RUNNING,
		stickingElementId: "another-clip",
	}),
	"not ready": viewOf({
		outcomes: {
			[ELEMENT.id]: {
				status: "error",
				elementId: ELEMENT.id,
				error: "apply-failed",
				message: "Stick to scene is not ready in this build.",
			},
		},
	}),
};
