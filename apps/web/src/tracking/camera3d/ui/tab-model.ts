import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	type CameraTrackerRunOutcome,
	type DecodedCameraTracker,
} from "../session";
import {
	CAMERA_TRACKER_BANNERS,
	DEFAULT_CAMERA_TRACKER_SETTINGS,
	type CameraSolveNotice,
	type CameraTrackerPhase,
	type CameraTrackerSettings,
	type ShotType,
	type SolveMethod,
	type SolveMethodUsed,
	type TrackPointDisplay,
} from "../types";
import type { ParamValue } from "@/params";
import { failureText, progressPercent, staleAction } from "./banner-model";
import { TARGET_SIZE_RANGE } from "./target";

/**
 * The Tracking tab of a video clip: AE's 3D Camera Tracker effect controls
 * (spec section 2) as a plain model; the component only draws it.
 */

export const TRACKING_TAB_DESCRIPTION =
	"Solves the 3D camera of this clip so text, solids, nulls and images can be placed in the scene.";

export const TAB_REASONS = {
	notTracked: "Track the camera first.",
	busy: "Wait until Track Camera finishes.",
	otherClip: "Another clip is being tracked. Wait until it finishes.",
	noSolve: "Solve the camera first.",
} as const;

export const SHOT_TYPE_OPTIONS: ReadonlyArray<{ value: ShotType; label: string }> = [
	{ value: "fixed-angle", label: "Fixed Angle of View" },
	{ value: "variable-zoom", label: "Variable Zoom" },
	{ value: "specify-angle", label: "Specify Angle of View" },
];

export const SOLVE_METHOD_OPTIONS: ReadonlyArray<{ value: SolveMethod; label: string }> = [
	{ value: "auto", label: "Auto Detect" },
	{ value: "typical", label: "Typical" },
	{ value: "mostly-flat", label: "Mostly Flat Scene" },
	{ value: "tripod-pan", label: "Tripod Pan" },
];

export const TRACK_POINT_DISPLAY_OPTIONS: ReadonlyArray<{
	value: TrackPointDisplay;
	label: string;
}> = [
	{ value: "2d-source", label: "2D Source" },
	{ value: "3d-solved", label: "3D Solved" },
];

const METHOD_USED_LABELS: Record<SolveMethodUsed, string> = {
	typical: "Typical",
	"mostly-flat": "Mostly Flat Scene",
	"tripod-pan": "Tripod Pan",
};

export interface Availability {
	enabled: boolean;
	reason: string | null;
}

export interface TrackingTabModel {
	primary: Availability & { label: "Track Camera" | "Analyze" | "Cancel"; action: "track" | "cancel" };
	/** This clip's run: the banner text with the percent. */
	progress: { text: string; percent: number } | null;
	/** "214 points, 152 frames" once solved. */
	summary: string | null;
	failure: string | null;
	/** Shown in the tab even with Hide Warning Banner (that option hides the preview banner only). */
	stale: {
		text: string;
		actionLabel: "Solve" | "Analyze";
		action: "resolve" | "track";
		enabled: boolean;
	} | null;
	notices: string[];
	settings: CameraTrackerSettings;
	controls: Availability;
	showAngleOfView: boolean;
	can3dSolved: boolean;
	createCamera: Availability;
	methodUsed: string | null;
	averageError: string | null;
}

export function noticeText(notice: CameraSolveNotice): string {
	switch (notice.kind) {
		case "tripod-no-depth":
			return "Tripod pan: no depth. Points are placed at a distance.";
		case "unsolved-frames":
			return notice.count === 1
				? "1 frame could not be solved and holds the nearest solved camera."
				: `${notice.count} frames could not be solved and hold the nearest solved camera.`;
		case "cut":
			return `Scene cut at analysis frame ${notice.frame}: only the longest scene was solved.`;
		case "high-error":
			return `Average error is high (${notice.averageError.toFixed(2)} px): placed layers may slide.`;
	}
}

/** Track Point Size (percent) the tab accepts. */
export const TRACK_POINT_SIZE_RANGE = { min: 10, max: 400 } as const;
/** Horizontal Angle of View (degrees) the contract accepts. */
export const ANGLE_OF_VIEW_RANGE = { min: 1, max: 179 } as const;

function optionValue<T extends string>({
	options,
	value,
}: {
	options: ReadonlyArray<{ value: T }>;
	value: ParamValue;
}): T | null {
	return options.find((option) => option.value === value)?.value ?? null;
}

function clampedNumber({
	value,
	range,
}: {
	value: ParamValue;
	range: { min: number; max: number };
}): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(range.max, Math.max(range.min, value));
}

/**
 * The settings patch for one field's new value, or `null` when the value
 * does not fit the field (wrong type, unknown option, not finite). Numbers
 * are clamped to the field's range.
 */
export function settingPatch({
	key,
	value,
}: {
	key: keyof CameraTrackerSettings;
	value: ParamValue;
}): Partial<CameraTrackerSettings> | null {
	switch (key) {
		case "shotType": {
			const shotType = optionValue({ options: SHOT_TYPE_OPTIONS, value });
			return shotType ? { shotType } : null;
		}
		case "solveMethod": {
			const solveMethod = optionValue({ options: SOLVE_METHOD_OPTIONS, value });
			return solveMethod ? { solveMethod } : null;
		}
		case "showTrackPoints": {
			const showTrackPoints = optionValue({ options: TRACK_POINT_DISPLAY_OPTIONS, value });
			return showTrackPoints ? { showTrackPoints } : null;
		}
		case "detailedAnalysis":
		case "autoDeleteAcrossTime":
		case "hideWarningBanner":
		case "renderTrackPoints":
			return typeof value === "boolean" ? { [key]: value } : null;
		case "horizontalAngleOfViewDeg": {
			const degrees = clampedNumber({ value, range: ANGLE_OF_VIEW_RANGE });
			return degrees === null ? null : { horizontalAngleOfViewDeg: degrees };
		}
		case "trackPointSize": {
			const size = clampedNumber({ value, range: TRACK_POINT_SIZE_RANGE });
			return size === null ? null : { trackPointSize: size };
		}
		case "targetSize": {
			const size = clampedNumber({ value, range: TARGET_SIZE_RANGE });
			return size === null ? null : { targetSize: size };
		}
	}
}

function countLabel({ count, noun }: { count: number; noun: string }): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const ENABLED: Availability = { enabled: true, reason: null };

function disabled(reason: string): Availability {
	return { enabled: false, reason };
}

export function buildTrackingTab({
	apiReady,
	elementId,
	phase,
	decoded,
	outcome,
}: {
	apiReady: boolean;
	elementId: string;
	phase: CameraTrackerPhase;
	decoded: DecodedCameraTracker | null;
	outcome?: CameraTrackerRunOutcome;
}): TrackingTabModel {
	const data = decoded?.data ?? null;
	const solve = decoded?.solve ?? null;
	const run = phase.phase === "idle" ? null : phase;
	const running = run !== null;
	const runHere = run !== null && run.elementId === elementId ? run : null;
	const runningHere = runHere !== null;
	const trackLabel = data ? "Analyze" : "Track Camera";

	let primary: TrackingTabModel["primary"];
	if (!apiReady) {
		primary = { label: trackLabel, action: "track", ...disabled(CAMERA_TRACKER_NOT_READY_MESSAGE) };
	} else if (runningHere) {
		primary = { label: "Cancel", action: "cancel", ...ENABLED };
	} else if (running) {
		primary = { label: trackLabel, action: "track", ...disabled(TAB_REASONS.otherClip) };
	} else {
		primary = { label: trackLabel, action: "track", ...ENABLED };
	}

	const blocked = !apiReady
		? CAMERA_TRACKER_NOT_READY_MESSAGE
		: running
			? TAB_REASONS.busy
			: null;
	const controls = blocked
		? disabled(blocked)
		: data
			? ENABLED
			: disabled(TAB_REASONS.notTracked);
	const createCamera = blocked
		? disabled(blocked)
		: solve
			? ENABLED
			: disabled(TAB_REASONS.noSolve);
	const stale = data ? staleAction(data) : null;
	const settings = data?.settings ?? DEFAULT_CAMERA_TRACKER_SETTINGS;
	const percent = runHere ? progressPercent(runHere.progress) : 0;

	return {
		primary,
		progress: runHere
			? { text: `${CAMERA_TRACKER_BANNERS[runHere.phase]} ${percent}%`, percent }
			: null,
		summary: solve
			? `${countLabel({ count: solve.points.length, noun: "point" })}, ${countLabel({ count: solve.cameras.length, noun: "frame" })}`
			: null,
		failure: failureText({ data, outcome }),
		stale: stale
			? { text: CAMERA_TRACKER_BANNERS.stale, ...stale, enabled: blocked === null }
			: null,
		notices: (solve?.notices ?? []).map(noticeText),
		settings,
		controls,
		showAngleOfView: settings.shotType === "specify-angle",
		can3dSolved: solve !== null,
		createCamera,
		methodUsed: solve ? METHOD_USED_LABELS[solve.methodUsed] : null,
		averageError: solve ? `${solve.averageError.toFixed(2)} px` : null,
	};
}
