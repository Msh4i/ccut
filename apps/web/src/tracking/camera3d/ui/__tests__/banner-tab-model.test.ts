import { describe, expect, test } from "bun:test";
import { CAMERA_TRACKER_NOT_READY_MESSAGE } from "../../session";
import { CAMERA_SOLVE_MESSAGES, CAMERA_TRACKER_BANNERS, DEFAULT_CAMERA_TRACKER_SETTINGS } from "../../types";
import { bannerAnnouncement, buildBanner } from "../banner-model";
import { buildTrackingTab, settingPatch, TAB_REASONS, TRACK_POINT_SIZE_RANGE } from "../tab-model";
import { buildData, buildDecoded, buildSolve, straightCamera } from "./fixtures";

const idle = { phase: "idle" } as const;

describe("banner over the preview", () => {
	test("analyzing and solving show whatever is selected, with the percent", () => {
		const analyzing = buildBanner({ phase: { phase: "analyzing", elementId: "other", progress: 0.424 }, active: null });
		expect(analyzing).toEqual({ kind: "analyzing", text: CAMERA_TRACKER_BANNERS.analyzing, percent: 42, elementId: "other" });
		const solving = buildBanner({ phase: { phase: "solving", elementId: "v", progress: 1.7 }, active: null });
		expect(solving).toEqual({ kind: "solving", text: CAMERA_TRACKER_BANNERS.solving, percent: 100, elementId: "v" });
		const odd = buildBanner({ phase: { phase: "solving", elementId: "v", progress: Number.NaN }, active: null });
		expect(odd?.kind === "solving" ? odd.percent : -1).toBe(0);
	});

	test("idle with no tracked clip active: nothing", () => {
		expect(buildBanner({ phase: idle, active: null })).toBeNull();
		expect(buildBanner({ phase: idle, active: { elementId: "v", data: null } })).toBeNull();
	});

	test("stale: Solve (or Analyze after an analysis setting changed), unless Hide Warning Banner", () => {
		expect(buildBanner({ phase: idle, active: { elementId: "v", data: buildData({ stale: "solve" }) } })).toEqual({
			kind: "stale", text: CAMERA_TRACKER_BANNERS.stale, actionLabel: "Solve", action: "resolve",
		});
		expect(buildBanner({ phase: idle, active: { elementId: "v", data: buildData({ stale: "analysis" }) } })).toEqual({
			kind: "stale", text: CAMERA_TRACKER_BANNERS.stale, actionLabel: "Analyze", action: "track",
		});
		const hidden = buildData({ stale: "solve", settings: { hideWarningBanner: true } });
		expect(buildBanner({ phase: idle, active: { elementId: "v", data: hidden } })).toBeNull();
	});

	test("failure: the stored message, else the last run's failed or busy message", () => {
		const failure = { reason: "no-texture" as const, message: CAMERA_SOLVE_MESSAGES["no-texture"] };
		expect(buildBanner({ phase: idle, active: { elementId: "v", data: buildData({ failure, hasSolve: false }) } })).toEqual({
			kind: "failed", text: CAMERA_SOLVE_MESSAGES["no-texture"],
		});
		expect(
			buildBanner({ phase: idle, active: { elementId: "v", data: null, outcome: { status: "failed", elementId: "v", message: "Boom." } } }),
		).toEqual({ kind: "failed", text: "Boom." });
		expect(
			buildBanner({ phase: idle, active: { elementId: "v", data: null, outcome: { status: "busy", elementId: "v", message: "Busy." } } }),
		).toEqual({ kind: "failed", text: "Busy." });
		expect(
			buildBanner({ phase: idle, active: { elementId: "v", data: null, outcome: { status: "cancelled", elementId: "v" } } }),
		).toBeNull();
	});

	test("a stale banner wins over an old failure (the settings changed since); a running job wins over both", () => {
		const failure = { reason: "diverged" as const, message: CAMERA_SOLVE_MESSAGES.diverged };
		const data = buildData({ failure, stale: "solve", hasSolve: false });
		expect(buildBanner({ phase: idle, active: { elementId: "v", data } })?.kind).toBe("stale");
		const running = buildBanner({ phase: { phase: "analyzing", elementId: "v", progress: 0 }, active: { elementId: "v", data } });
		expect(running?.kind).toBe("analyzing");
	});

	test("the live region announces the phase text only, never the percent", () => {
		const at = (progress: number) =>
			bannerAnnouncement(buildBanner({ phase: { phase: "analyzing", elementId: "v", progress }, active: null }));
		expect(at(0.1)).toBe(CAMERA_TRACKER_BANNERS.analyzing);
		expect(at(0.9)).toBe(at(0.1));
		expect(bannerAnnouncement(null)).toBe("");
		expect(bannerAnnouncement({ kind: "failed", text: "Boom." })).toBe("Boom.");
	});
});

describe("Tracking tab of a video clip", () => {
	const solve = buildSolve({
		cameras: [straightCamera([0, 0, -1000]), straightCamera([5, 0, -1000])],
		points: [
			{ trackId: 0, position: [0, 0, 0] },
			{ trackId: 1, position: [1, 0, 0] },
			{ trackId: 2, position: [0, 1, 0] },
		],
	});

	test("never tracked: Track Camera, controls locked until the first solve", () => {
		const tab = buildTrackingTab({ apiReady: true, elementId: "v", phase: idle, decoded: null });
		expect(tab.primary).toEqual({ label: "Track Camera", action: "track", enabled: true, reason: null });
		expect(tab.controls).toEqual({ enabled: false, reason: TAB_REASONS.notTracked });
		expect(tab.settings).toEqual(DEFAULT_CAMERA_TRACKER_SETTINGS);
		expect(tab.summary).toBeNull();
		expect(tab.createCamera.enabled).toBe(false);
		expect(tab.progress).toBeNull();
	});

	test("no engine registered: everything disabled with the not-ready message", () => {
		const tab = buildTrackingTab({ apiReady: false, elementId: "v", phase: idle, decoded: buildDecoded({ solve }) });
		expect(tab.primary.enabled).toBe(false);
		expect(tab.primary.reason).toBe(CAMERA_TRACKER_NOT_READY_MESSAGE);
		expect(tab.controls).toEqual({ enabled: false, reason: CAMERA_TRACKER_NOT_READY_MESSAGE });
		expect(tab.createCamera).toEqual({ enabled: false, reason: CAMERA_TRACKER_NOT_READY_MESSAGE });
	});

	test("solved: Analyze, summary, Method Used, Average Error with 2 decimals, Create Camera", () => {
		const tab = buildTrackingTab({ apiReady: true, elementId: "v", phase: idle, decoded: buildDecoded({ elementId: "v", solve }) });
		expect(tab.primary).toEqual({ label: "Analyze", action: "track", enabled: true, reason: null });
		expect(tab.summary).toBe("3 points, 2 frames");
		expect(tab.methodUsed).toBe("Typical");
		expect(tab.averageError).toBe("0.38 px");
		expect(tab.controls).toEqual({ enabled: true, reason: null });
		expect(tab.createCamera).toEqual({ enabled: true, reason: null });
		expect(tab.can3dSolved).toBe(true);
		expect(tab.showAngleOfView).toBe(false);
	});

	test("Specify Angle of View shows the angle field", () => {
		const data = buildData({ settings: { shotType: "specify-angle" } });
		const tab = buildTrackingTab({ apiReady: true, elementId: "v", phase: idle, decoded: buildDecoded({ data, solve }) });
		expect(tab.showAngleOfView).toBe(true);
	});

	test("running on this clip: Cancel and progress; controls locked", () => {
		const tab = buildTrackingTab({
			apiReady: true,
			elementId: "v",
			phase: { phase: "analyzing", elementId: "v", progress: 0.5 },
			decoded: buildDecoded({ solve }),
		});
		expect(tab.primary).toEqual({ label: "Cancel", action: "cancel", enabled: true, reason: null });
		expect(tab.progress).toEqual({ text: `${CAMERA_TRACKER_BANNERS.analyzing} 50%`, percent: 50 });
		expect(tab.controls).toEqual({ enabled: false, reason: TAB_REASONS.busy });
	});

	test("running on another clip: the button waits", () => {
		const tab = buildTrackingTab({
			apiReady: true,
			elementId: "v",
			phase: { phase: "solving", elementId: "other", progress: 0.5 },
			decoded: null,
		});
		expect(tab.primary).toEqual({ label: "Track Camera", action: "track", enabled: false, reason: TAB_REASONS.otherClip });
		expect(tab.progress).toBeNull();
	});

	test("failed: the message, no Create Camera, no 3D Solved", () => {
		const failure = { reason: "no-motion" as const, message: CAMERA_SOLVE_MESSAGES["no-motion"] };
		const data = buildData({ failure, hasSolve: false });
		const tab = buildTrackingTab({ apiReady: true, elementId: "v", phase: idle, decoded: buildDecoded({ data, solve: null }) });
		expect(tab.failure).toBe(CAMERA_SOLVE_MESSAGES["no-motion"]);
		expect(tab.createCamera).toEqual({ enabled: false, reason: TAB_REASONS.noSolve });
		expect(tab.can3dSolved).toBe(false);
		expect(tab.controls.enabled).toBe(true);
		const fromOutcome = buildTrackingTab({
			apiReady: true, elementId: "v", phase: idle, decoded: null,
			outcome: { status: "failed", elementId: "v", message: "Boom." },
		});
		expect(fromOutcome.failure).toBe("Boom.");
	});

	test("stale: shown in the tab even with Hide Warning Banner (that hides the preview banner only)", () => {
		const data = buildData({ stale: "analysis", settings: { hideWarningBanner: true } });
		const tab = buildTrackingTab({ apiReady: true, elementId: "v", phase: idle, decoded: buildDecoded({ data, solve }) });
		expect(tab.stale).toEqual({ text: CAMERA_TRACKER_BANNERS.stale, actionLabel: "Analyze", action: "track", enabled: true });
	});

	test("solve notices become sentences", () => {
		const noticed = {
			...solve,
			notices: [
				{ kind: "tripod-no-depth" as const },
				{ kind: "unsolved-frames" as const, count: 1 },
				{ kind: "unsolved-frames" as const, count: 4 },
				{ kind: "cut" as const, frame: 30 },
				{ kind: "high-error" as const, averageError: 3.456 },
			],
		};
		const tab = buildTrackingTab({ apiReady: true, elementId: "v", phase: idle, decoded: buildDecoded({ solve: noticed }) });
		expect(tab.notices).toEqual([
			"Tripod pan: no depth. Points are placed at a distance.",
			"1 frame could not be solved and holds the nearest solved camera.",
			"4 frames could not be solved and hold the nearest solved camera.",
			"Scene cut at analysis frame 30: only the longest scene was solved.",
			"Average error is high (3.46 px): placed layers may slide.",
		]);
	});
});

describe("settingPatch (a field's value -> a settings patch, validated)", () => {
	test("selects accept only their options", () => {
		expect(settingPatch({ key: "shotType", value: "variable-zoom" })).toEqual({ shotType: "variable-zoom" });
		expect(settingPatch({ key: "shotType", value: "zoom" })).toBeNull();
		expect(settingPatch({ key: "solveMethod", value: "tripod-pan" })).toEqual({ solveMethod: "tripod-pan" });
		expect(settingPatch({ key: "solveMethod", value: 3 })).toBeNull();
		expect(settingPatch({ key: "showTrackPoints", value: "2d-source" })).toEqual({ showTrackPoints: "2d-source" });
	});

	test("switches accept booleans only", () => {
		expect(settingPatch({ key: "renderTrackPoints", value: true })).toEqual({ renderTrackPoints: true });
		expect(settingPatch({ key: "detailedAnalysis", value: false })).toEqual({ detailedAnalysis: false });
		expect(settingPatch({ key: "autoDeleteAcrossTime", value: "yes" })).toBeNull();
		expect(settingPatch({ key: "hideWarningBanner", value: true })).toEqual({ hideWarningBanner: true });
	});

	test("numbers are finite and clamped to their range", () => {
		expect(settingPatch({ key: "horizontalAngleOfViewDeg", value: 200 })).toEqual({ horizontalAngleOfViewDeg: 179 });
		expect(settingPatch({ key: "horizontalAngleOfViewDeg", value: 0 })).toEqual({ horizontalAngleOfViewDeg: 1 });
		expect(settingPatch({ key: "trackPointSize", value: 150 })).toEqual({ trackPointSize: 150 });
		expect(settingPatch({ key: "trackPointSize", value: 5000 })).toEqual({ trackPointSize: TRACK_POINT_SIZE_RANGE.max });
		expect(settingPatch({ key: "targetSize", value: 1 })).toEqual({ targetSize: 10 });
		expect(settingPatch({ key: "targetSize", value: Number.NaN })).toBeNull();
		expect(settingPatch({ key: "targetSize", value: "50" })).toBeNull();
	});
});
