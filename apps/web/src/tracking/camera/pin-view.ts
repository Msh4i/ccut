import type { PinMode } from "./types";
import type { CameraAnalysisJob, CameraPinOutcome } from "./analysis-types";
import {
	CAMERA_PIN_MESSAGES,
	type CameraPinRecord,
	type CameraPins,
} from "./pin-element";
import { mediaTimeToSeconds } from "@/wasm";

/**
 * What the "Stick to scene" section and the preview chip show, as plain data
 * (the pattern of `stickers/view-logic.ts`): the components only draw it.
 * Texts are the app's language (English), word for word from plan section d.
 */

const OVERLAY_TYPES = ["text", "image", "sticker", "graphic"] as const;

export type PinOverlayType = (typeof OVERLAY_TYPES)[number];

/** Only these kinds of clip stick to a video's scene (the Tracking tab is theirs alone). */
export function isPinOverlayType(type: string): type is PinOverlayType {
	return (OVERLAY_TYPES as readonly string[]).includes(type);
}

/** The chip shows next to a selected overlay clip, except while its text is being edited in place. */
export function shouldShowPinChip({
	elementType,
	isEditingText,
}: {
	elementType: string | null;
	isEditingText: boolean;
}): boolean {
	return elementType !== null && isPinOverlayType(elementType) && !isEditingText;
}

export const STICK_LABEL = "Stick to scene";
export const CANCEL_LABEL = "Cancel";
export const UNSTICK_LABEL = "Unstick";
export const USE_SCENE_LABEL = "Use scene";
export const BUSY_ELSEWHERE_REASON = "Another clip is being analysed.";
/** Screen readers hear the start and the end of a run, not every percent. */
export const ANALYSING_ANNOUNCEMENT = "Analysing...";
export const CANCELLED_ANNOUNCEMENT = "Analysis cancelled.";

const MODE_LABELS: Record<PinMode, string> = {
	scene: "Scene",
	object: "Moving object",
};

export const PIN_FOLLOW_OPTIONS: readonly { mode: PinMode; label: string }[] = [
	{ mode: "scene", label: MODE_LABELS.scene },
	{ mode: "object", label: MODE_LABELS.object },
];

const NOTICE_TEXTS = {
	"no-texture": "Not enough detail in this clip to follow the scene.",
	"no-motion": "No camera movement in this clip, nothing to stick to.",
	"low-quality": "Video quality is low, the stick may drift.",
	// The UI has no frame-to-time mapping (the analysis holds the clock), so the
	// loss is told without its time.
	lost: "Lost track of the scene part of the way, stuck until there.",
	object: "This spot moves differently from the scene: following the object.",
	cutWithoutTime: "Scene cut, stuck until there.",
} as const;

export type PinNoticeAction = { kind: "use-scene"; label: string };

export interface PinNotice {
	id: string;
	text: string;
	action: PinNoticeAction | null;
}

export type PinViewState = "idle" | "disabled" | "analysing" | "stuck" | "stale";

export interface PinView {
	state: PinViewState;
	stickLabel: string;
	canStick: boolean;
	/** Why Stick is unavailable, when it is. */
	disabledReason: string | null;
	progress: { percent: number; label: string; cancelLabel: string } | null;
	/** Set while the element is stuck and its host is unchanged. */
	stuck: {
		label: string;
		mode: PinMode;
		modeLabel: string;
		summary: string;
	} | null;
	followOptions: readonly { mode: PinMode; label: string }[];
	canUnstick: boolean;
	/** "Follow" and "Use scene" start a run: not while one is in flight. */
	canChangeMode: boolean;
	notices: PinNotice[];
	/** For the polite live region: the start and the end of a run, never the percentage. */
	announcement: string;
}

export interface PinViewInput {
	element: { id: string; type: string };
	pins: CameraPins;
	job: CameraAnalysisJob;
	outcomes: Readonly<Record<string, CameraPinOutcome>>;
	/** The element whose stick is in flight (the store's `stickingElementId`). */
	stickingElementId: string | null;
	/** Whether a video lies under the element (`selectPinHost` found one). */
	hasVideoUnder: boolean;
	/** False when the pin's host was moved, trimmed or retimed since. Default true. */
	isPinCurrent?: boolean;
	/** The element's start on the timeline, for the stuck range. Default 0. */
	elementStartSeconds?: number;
	/**
	 * False when the element no longer has the pin's keys (the stick was undone):
	 * the record alone does not make it stuck, and the pinned outcome's notices
	 * stay hidden (failures and other outcomes still show). Default true.
	 */
	hasPinKeys?: boolean;
	/** The engine refused this element's stick as busy during the run in flight (the store's `busyRefusedIds`). */
	busyRefused?: boolean;
}

/** m:ss.s, truncated to a tenth so 59.96 never reads 0:60.0. */
export function formatPinTime({ seconds }: { seconds: number }): string {
	const tenths = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds * 10 + 1e-6)) : 0;
	const minutes = Math.floor(tenths / 600);
	const rest = (tenths % 600) / 10;
	return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

function percentOf({ progress }: { progress: number }): number {
	if (!Number.isFinite(progress)) return 0;
	return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

function notice({
	id,
	text,
	action = null,
}: {
	id: string;
	text: string;
	action?: PinNoticeAction | null;
}): PinNotice {
	return { id, text, action };
}

function busyNotice(): PinNotice {
	return notice({ id: "error:busy", text: CAMERA_PIN_MESSAGES.busy });
}

function noticesOf({
	outcome,
}: {
	outcome: CameraPinOutcome | undefined;
}): PinNotice[] {
	if (!outcome) return [];
	if (outcome.status === "cancelled") return [];
	// "busy" is about the run in flight, not the element: it is shown from `busyRefused` while that run lasts
	if (outcome.status === "error" && outcome.error === "busy") return [];
	if (outcome.status === "error") {
		return [
			notice({
				id: `error:${outcome.error}`,
				text: outcome.message || CAMERA_PIN_MESSAGES[outcome.error],
			}),
		];
	}
	const kinds = [...new Set(outcome.notices)];
	const cutTimes =
		outcome.status === "pinned" ? [...outcome.cutTimes].sort((a, b) => a - b) : [];
	const result: PinNotice[] = [];
	for (const kind of kinds) {
		switch (kind) {
			case "cut":
				if (cutTimes.length === 0) {
					result.push(notice({ id: "cut", text: NOTICE_TEXTS.cutWithoutTime }));
				}
				for (const time of cutTimes) {
					result.push(
						notice({
							id: `cut:${time}`,
							text: `Scene cut at ${formatPinTime({ seconds: time })}, stuck until there.`,
						}),
					);
				}
				break;
			case "object":
				result.push(
					notice({
						id: "object",
						text: NOTICE_TEXTS.object,
						action:
							outcome.status === "pinned" && outcome.mode === "object"
								? { kind: "use-scene", label: USE_SCENE_LABEL }
								: null,
					}),
				);
				break;
			default:
				result.push(notice({ id: kind, text: NOTICE_TEXTS[kind] }));
		}
	}
	return result;
}

/**
 * What the end of a run is announced as. A stick that ends stuck or with a
 * notice is told by those regions; only a cancel shows nothing else.
 */
function endAnnouncement({ outcome }: { outcome: CameraPinOutcome | undefined }): string {
	return outcome?.status === "cancelled" ? CANCELLED_ANNOUNCEMENT : "";
}

function stuckSummary({
	pin,
	elementStartSeconds,
}: {
	pin: CameraPinRecord;
	elementStartSeconds: number;
}): string {
	const start = elementStartSeconds + mediaTimeToSeconds({ time: pin.range.start });
	const end = elementStartSeconds + mediaTimeToSeconds({ time: pin.range.end });
	return `Stuck ${formatPinTime({ seconds: start })} - ${formatPinTime({ seconds: end })} (${MODE_LABELS[pin.mode]})`;
}

export function buildPinView({
	element,
	pins,
	job,
	outcomes,
	stickingElementId,
	hasVideoUnder,
	isPinCurrent = true,
	elementStartSeconds = 0,
	hasPinKeys = true,
	busyRefused = false,
}: PinViewInput): PinView {
	// an undone stick leaves the record without its keys: that element is not stuck
	const pin = hasPinKeys ? (pins[element.id] ?? null) : null;
	const isRunning = job.state === "running";
	const isMine = isRunning && stickingElementId === element.id;
	const outcome = outcomes[element.id];

	const base = {
		stickLabel: STICK_LABEL,
		followOptions: PIN_FOLLOW_OPTIONS,
		progress: null,
		stuck: null,
		canUnstick: false,
		canStick: false,
		canChangeMode: !isRunning,
		disabledReason: null,
		notices: [] as PinNotice[],
		announcement: isRunning ? "" : endAnnouncement({ outcome }),
	};

	if (isMine) {
		const percent = percentOf({ progress: job.progress });
		return {
			...base,
			state: "analysing",
			progress: { percent, label: `Analysing... ${percent}%`, cancelLabel: CANCEL_LABEL },
			announcement: ANALYSING_ANNOUNCEMENT,
		};
	}

	const stale: PinNotice[] =
		pin && !isPinCurrent
			? [notice({ id: "stale", text: CAMERA_PIN_MESSAGES["stale-pin"] })]
			: [];
	// A pinned outcome describes keys that an undo took away: none of it shows on an element that is not stuck
	const shownOutcome = hasPinKeys || outcome?.status !== "pinned" ? outcome : undefined;
	const outcomeNotices = noticesOf({ outcome: shownOutcome }).filter(
		(candidate) => !(stale.length > 0 && candidate.id === "error:stale-pin"),
	);
	const busy = isRunning && busyRefused ? [busyNotice()] : [];
	const notices = [...busy, ...stale, ...outcomeNotices];

	let disabledReason: string | null = null;
	if (!isPinOverlayType(element.type)) {
		disabledReason = CAMERA_PIN_MESSAGES["unsupported-element"];
	} else if (isRunning) {
		disabledReason = BUSY_ELSEWHERE_REASON;
	} else if (!hasVideoUnder) {
		disabledReason = CAMERA_PIN_MESSAGES["no-video"];
	}

	if (pin && !isPinCurrent) {
		return {
			...base,
			state: "stale",
			canStick: disabledReason === null,
			disabledReason,
			canUnstick: !isRunning,
			notices,
		};
	}

	if (pin) {
		return {
			...base,
			state: "stuck",
			stuck: {
				label: "Stuck",
				mode: pin.mode,
				modeLabel: MODE_LABELS[pin.mode],
				summary: stuckSummary({ pin, elementStartSeconds }),
			},
			canUnstick: !isRunning,
			disabledReason: isRunning ? BUSY_ELSEWHERE_REASON : null,
			notices,
		};
	}

	return {
		...base,
		state: disabledReason ? "disabled" : "idle",
		canStick: disabledReason === null,
		disabledReason,
		notices,
	};
}
