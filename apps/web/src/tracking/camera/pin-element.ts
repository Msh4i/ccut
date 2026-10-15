import { getElementLocalTime } from "@/animation";
import { EditorCore } from "@/core";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics/types";
import { buildTransformFromParams, type Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { STICKER_INTRINSIC_SIZE_FALLBACK } from "@/stickers/intrinsic-size";
import { measureTextElement } from "@/text/measure-element";
import type { SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { isVisualElement } from "@/timeline/element-utils";
import {
	buildHostBoundsAt,
	findElementInTracks,
	hostRate,
	type HostTimingClip,
} from "@/tracking/host";
import { canvasToUv } from "@/tracking/projection";
import { mediaTimeToSeconds, TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import {
	classifyPin,
	perspectiveSuspected,
	qualityNotices,
	residualQuality,
	type ClassifyResult,
} from "./classify";
import {
	buildCameraPinKeys,
	type CameraPinKeys,
	type CameraPinRange,
} from "./pin-animations";
import { simplifyCameraPinChannels } from "./simplify-channels";
import { solvePin, trackedRange } from "./solve-pin";
import {
	buildCameraPinChannels,
	canvasToFramePoint,
	elementCorners,
	maxCornerGap,
	type CameraPinChannels,
	type LocalRect,
} from "./to-channels";
import type {
	CameraAnalysis,
	CameraNoticeKind,
	PinMode,
	PinModel,
	PinSolution,
} from "./types";

/** Seconds of slack when deciding whether a frame falls inside a clip. */
const TIME_EPSILON = 1e-6;
/** Plan decision 1: the homography is used when its closest scale-and-rotate puts the element's corners more than this many analysis px from the similarity's. */
const MODEL_GAP_FRAME_PX = 2;
/** A homography must have solved at least this share of what the similarity solved to be considered. */
const H_SOLVED_SHARE = 0.9;
/** Object mode needs at least this share of the pinned frames solved without a gap, or it has nothing to follow. */
const OBJECT_SOLVED_SHARE = 0.5;

/** "auto" lets the classifier look at what is under the pin. */
export type PinModeChoice = "auto" | PinMode;

export type CameraPinErrorCode =
	| "no-element"
	| "unsupported-element"
	| "no-video"
	| "no-box"
	| "bad-geometry"
	| "analysis-mismatch"
	| "analysis-cancelled"
	| "analysis-outside"
	| "stale-pin"
	| "apply-failed"
	/** The engine (slice T2) runs one analysis at a time. */
	| "busy"
	/** The host clip was deleted or re-mediaed while it was being analysed. */
	| "host-changed"
	/** The analysis itself failed (the decoder gave up, the frames are too small): the message says why. */
	| "analysis-failed";

/** What to tell the user, in the app's language. */
export const CAMERA_PIN_MESSAGES: Record<CameraPinErrorCode, string> = {
	"no-element": "This clip is not in the project.",
	"unsupported-element": "This kind of clip cannot be stuck to the scene.",
	"no-video": "There is no video under this clip.",
	"no-box": "The size of this clip could not be measured.",
	"bad-geometry": "This clip or the video under it has no size on the canvas.",
	"analysis-mismatch": "The analysis belongs to another video clip.",
	"analysis-cancelled": "The analysis was stopped before it was done.",
	"analysis-outside": "The analysed part of the video does not cover this clip.",
	"stale-pin": "The clip changed after sticking. Stick again.",
	"apply-failed": "The clip could not be updated.",
	busy: "Another clip is being analysed. Wait for it to finish or press Esc.",
	"host-changed": "The video under this clip was removed or changed while it was analysed.",
	"analysis-failed": "The video could not be analysed.",
};

export interface PinFailure {
	status: "error";
	error: CameraPinErrorCode;
	message: string;
}

function fail({
	error,
	message = CAMERA_PIN_MESSAGES[error],
}: {
	error: CameraPinErrorCode;
	message?: string;
}): PinFailure {
	return { status: "error", error, message };
}

// ---------------------------------------------------------------------------
// The pins registry (session only; the zustand store itself is slice T2)
// ---------------------------------------------------------------------------

/** What a host clip looked like, to the frames, when something was stuck to it. */
export interface PinHostState {
	mediaId: string;
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	rate: number;
}

/** One stuck element: what it follows, how, and which stretch of it the keys cover. */
export interface CameraPinRecord {
	elementId: string;
	trackId: string;
	analysisId: string;
	hostElementId: string;
	mode: PinMode;
	/** The model whose motion was written: "H" means its closest scale-and-rotate. */
	model: PinModel;
	/** The stretch of the element the pin wrote keys for, in ticks from its start. */
	range: CameraPinRange;
	host: PinHostState;
}

/** Pins by element id. One pin per element: a second pin on another stretch of it replaces the record, the keys of the first stay. */
export type CameraPins = Readonly<Record<string, CameraPinRecord>>;

export function hostStateOf(host: HostTimingClip): PinHostState {
	return {
		mediaId: host.mediaId,
		startTime: host.startTime,
		duration: host.duration,
		trimStart: host.trimStart,
		rate: hostRate({ host }),
	};
}

/**
 * Do the host's frames still sit where they did when the pin was written?
 * Keys are baked, so a moved, trimmed or retimed host leaves them behind
 * ("The clip changed after sticking"); a change that moves no frame (its
 * transform, effects) does not count.
 */
export function isPinCurrent({
	pin,
	host,
}: {
	pin: CameraPinRecord;
	host: HostTimingClip | null;
}): boolean {
	if (!host) return false;
	return (
		host.mediaId === pin.host.mediaId &&
		host.startTime === pin.host.startTime &&
		host.duration === pin.host.duration &&
		host.trimStart === pin.host.trimStart &&
		hostRate({ host }) === pin.host.rate
	);
}

export function pinOf({
	pins,
	elementId,
}: {
	pins: CameraPins;
	elementId: string;
}): CameraPinRecord | null {
	return pins[elementId] ?? null;
}

export function withPin({
	pins,
	pin,
}: {
	pins: CameraPins;
	pin: CameraPinRecord;
}): CameraPins {
	return { ...pins, [pin.elementId]: pin };
}

export function withoutPin({
	pins,
	elementId,
}: {
	pins: CameraPins;
	elementId: string;
}): CameraPins {
	if (!(elementId in pins)) return pins;
	const next = { ...pins };
	delete next[elementId];
	return next;
}

// ---------------------------------------------------------------------------
// What the planner reads
// ---------------------------------------------------------------------------

/** Plain data of the project the planner needs, so it runs without an editor. */
export interface PinScene {
	tracks: SceneTracks;
	canvasSize: { width: number; height: number };
	/** The picture size of a media asset, when known (otherwise the canvas size stands in, as for the host bounds elsewhere). */
	mediaSize: ({ mediaId }: { mediaId: string }) => { width: number; height: number } | undefined;
	/** The playhead, in ticks. */
	playhead: MediaTime;
}

function seconds(time: MediaTime): number {
	return mediaTimeToSeconds({ time });
}

function containFit({
	source,
	canvasSize,
}: {
	source: { width: number; height: number };
	canvasSize: { width: number; height: number };
}): LocalRect {
	const contain = Math.min(canvasSize.width / source.width, canvasSize.height / source.height);
	const width = source.width * contain;
	const height = source.height * contain;
	return { left: -width / 2, top: -height / 2, width, height };
}

/**
 * The element's box in its own unscaled space, the way the renderer lays it
 * out (the picture fitted into the canvas, centred on the element's origin).
 * Null for text: its box is the measured text, which only something that can
 * draw it can give.
 */
export function defaultElementBox({
	element,
	canvasSize,
	mediaSize,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	mediaSize: PinScene["mediaSize"];
}): LocalRect | null {
	switch (element.type) {
		case "image":
		case "video":
			return containFit({
				source: mediaSize({ mediaId: element.mediaId }) ?? canvasSize,
				canvasSize,
			});
		case "sticker":
			return containFit({
				source: {
					width: element.intrinsicWidth ?? STICKER_INTRINSIC_SIZE_FALLBACK,
					height: element.intrinsicHeight ?? STICKER_INTRINSIC_SIZE_FALLBACK,
				},
				canvasSize,
			});
		case "graphic":
			return containFit({
				source: { width: DEFAULT_GRAPHIC_SOURCE_SIZE, height: DEFAULT_GRAPHIC_SOURCE_SIZE },
				canvasSize,
			});
		default:
			return null;
	}
}

/** The measured box of a text clip. Needs a canvas to measure on, so null where there is none. */
function measureTextBox({
	element,
	canvasHeight,
	localTime,
}: {
	element: TimelineElement;
	canvasHeight: number;
	localTime: number;
}): LocalRect | null {
	if (element.type !== "text" || typeof document === "undefined") return null;
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return null;
	return measureTextElement({ element, canvasHeight, localTime, ctx }).visualRect;
}

/** The element's own transform (base params and animation, not the In/Out presets) at a timeline time. */
function transformAt({
	element,
	atSeconds,
}: {
	element: TimelineElement;
	atSeconds: number;
}): Transform {
	return resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime: getElementLocalTime({
			timelineTime: Math.round(atSeconds * TICKS_PER_SECOND),
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	});
}

function hostBoundsFn({
	scene,
	host,
}: {
	scene: PinScene;
	host: VideoElement;
}): (atSeconds: number) => ReturnType<ReturnType<typeof buildHostBoundsAt>> {
	const source = scene.mediaSize({ mediaId: host.mediaId }) ?? scene.canvasSize;
	return buildHostBoundsAt({
		host,
		canvasWidth: scene.canvasSize.width,
		canvasHeight: scene.canvasSize.height,
		sourceWidth: source.width,
		sourceHeight: source.height,
	});
}

// ---------------------------------------------------------------------------
// Host, window, pin frame
// ---------------------------------------------------------------------------

/**
 * The stretch of the timeline (seconds) where the element and the host's
 * picture are both on screen, or null when they never are at once.
 */
export function pinWindow({
	element,
	host,
}: {
	element: Pick<TimelineElement, "startTime" | "duration">;
	host: Pick<TimelineElement, "startTime" | "duration">;
}): { start: number; end: number } | null {
	const start = Math.max(seconds(element.startTime), seconds(host.startTime));
	const end = Math.min(
		seconds(element.startTime) + seconds(element.duration),
		seconds(host.startTime) + seconds(host.duration),
	);
	return end - start > TIME_EPSILON ? { start, end } : null;
}

/**
 * Where each analysis frame is on the timeline now. Frame `t` was taken from
 * the source second `sourceStart + t * rate0 / fps`, and the clip shows source
 * second `s` at `start + (s - trimStart) / rate`: it stays on its source frame
 * when the clip is moved, trimmed or retimed after the analysis.
 */
export function analysisFrameClock({
	analysis,
	host,
}: {
	analysis: Pick<CameraAnalysis, "sourceStart" | "rate0" | "tracks">;
	host: HostTimingClip;
}): {
	/** Timeline second of frame 0. */
	origin: number;
	/** Timeline seconds from one analysis frame to the next. */
	step: number;
	timeAt: (frame: number) => number;
	/** The (fractional) frame shown at a timeline second. */
	frameAt: (atSeconds: number) => number;
} {
	const rate = hostRate({ host });
	const origin =
		seconds(host.startTime) + (analysis.sourceStart - seconds(host.trimStart)) / rate;
	const step = analysis.rate0 / (analysis.tracks.fps * rate);
	return {
		origin,
		step,
		timeAt: (frame) => origin + frame * step,
		frameAt: (atSeconds) => (atSeconds - origin) / step,
	};
}

/**
 * The video a text, image, sticker or graphic sticks to: of the clips under
 * the element's track (the order the renderer stacks them in), the topmost
 * visible video that is on screen when the element is pinned and whose picture
 * holds the element's centre; failing that the topmost one on screen then;
 * failing that the topmost that meets the element at all. "When the element is
 * pinned" is the playhead held inside the element. Null when no video meets it.
 */
export function selectPinHost({
	scene,
	elementId,
	box,
}: {
	scene: PinScene;
	elementId: string;
	/** The element's own unscaled box; without it the centre test is skipped. */
	box: LocalRect | null;
}): { host: VideoElement; trackId: string } | null {
	const found = findElementInTracks({ tracks: scene.tracks, elementId });
	if (!found || !isVisualElement(found.element)) return null;
	const { element } = found;
	const order = [...scene.tracks.overlay, scene.tracks.main];
	const index = order.findIndex((track) => track.id === found.trackId);
	if (index < 0) return null;

	const start = seconds(element.startTime);
	const end = start + seconds(element.duration);
	const at = Math.min(Math.max(seconds(scene.playhead), start), end);

	const candidates: { host: VideoElement; trackId: string }[] = [];
	for (const track of order.slice(index + 1)) {
		if ("hidden" in track && track.hidden) continue;
		const videos = track.elements
			.filter((candidate): candidate is VideoElement => candidate.type === "video" && !candidate.hidden)
			.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
		for (const host of videos) {
			if (pinWindow({ element, host })) candidates.push({ host, trackId: track.id });
		}
	}

	const onScreen = candidates.filter(({ host }) => {
		const hostStart = seconds(host.startTime);
		return at >= hostStart - TIME_EPSILON && at <= hostStart + seconds(host.duration) + TIME_EPSILON;
	});
	const holding = box
		? onScreen.find(({ host }) => {
				const corners = elementCorners({
					bounds: box,
					look: transformAt({ element, atSeconds: at }),
					isText: element.type === "text",
					canvasSize: scene.canvasSize,
				});
				const centre = {
					x: corners.reduce((sum, c) => sum + c.x, 0) / 4,
					y: corners.reduce((sum, c) => sum + c.y, 0) / 4,
				};
				const bounds = hostBoundsFn({ scene, host })(at);
				if (bounds.width === 0 || bounds.height === 0) return false;
				const { u, v } = canvasToUv({ x: centre.x, y: centre.y, bounds });
				return u >= 0 && u <= 1 && v >= 0 && v <= 1;
			})
		: undefined;
	return holding ?? onScreen[0] ?? candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface CameraPinFrames {
	/** First and last analysis frame the keys cover, inclusive. */
	first: number;
	last: number;
	/** The pin frame: the playhead, held inside the window. */
	pin: number;
}

export interface PinnedPlan {
	status: "pinned";
	trackId: string;
	elementId: string;
	keys: CameraPinKeys;
	range: CameraPinRange;
	/** What to tell the user (kinds only: a cut's time is `cutTimes`, a loss's frame `lostFrame`). */
	notices: CameraNoticeKind[];
	/** The analysis frame tracking was first lost at (nearest the pin), when it was, for "lost the scene at ...". */
	lostFrame: number | null;
	/** Timeline seconds of the scene cuts that end the pin, for "Scene cut at 0:05.2". */
	cutTimes: number[];
	mode: PinMode;
	model: PinModel;
	classification: ClassifyResult;
	frames: CameraPinFrames;
	pin: CameraPinRecord;
}

/** The analysis says there is nothing to stick to (no texture, no motion): nothing is written. */
export interface NoKeysPlan {
	status: "no-keys";
	elementId: string;
	notices: CameraNoticeKind[];
	lostFrame: number | null;
	frames: CameraPinFrames;
}

export type CameraPinPlan = PinnedPlan | NoKeysPlan | PinFailure;

/**
 * Share of frames `first..last` the solver solved. `unbroken` counts only the
 * frames reached by an unbroken chain from the pin frame (`ok = 1`), not those
 * after a bridged gap (`ok = 2`).
 */
function solvedShare({
	solution,
	first,
	last,
	unbroken = false,
}: {
	solution: PinSolution;
	first: number;
	last: number;
	unbroken?: boolean;
}): number {
	let solved = 0;
	for (let t = first; t <= last; t++) {
		const state = solution.ok[t];
		solved += (unbroken ? state === 1 : state !== 0) ? 1 : 0;
	}
	return solved / (last - first + 1);
}

/**
 * Decides everything about sticking an element to the scene and builds the
 * keys, without writing them. In order: the host (`selectPinHost`; it has to
 * be the clip `analysis` was taken from), the frames of the element that are
 * also in the host and in the analysis, the pin frame (the playhead held in
 * them), the scene solved both ways from the pin frame (the similarity always,
 * the homography when the similarity's residual asks for it), the notices, the
 * mode (scene, or the object under the pin), which model to write (the
 * homography's closest scale-and-rotate only where it puts the element's
 * corners more than 2 px of the analysis frame from the similarity's), the
 * five channels, their simplification and the keyframes.
 *
 * A scene cut ends the pin: keys cover only the cut-free stretch around the
 * pin frame. No texture or no motion plans no keys. `look` sticks the element
 * as it is given instead of as it is now (a re-stick after a drag).
 */
export function planCameraPin({
	scene,
	elementId,
	analysis,
	box,
	mode = "auto",
	look,
	solve = solvePin,
}: {
	scene: PinScene;
	elementId: string;
	analysis: CameraAnalysis;
	/** The element's own unscaled box; defaults from its type (not for text). */
	box?: LocalRect | null;
	mode?: PinModeChoice;
	/** The element's transform at the pin frame; defaults to what it is now. */
	look?: Transform;
	/** The solver, replaceable to test what is done with its answers. */
	solve?: typeof solvePin;
}): CameraPinPlan {
	const found = findElementInTracks({ tracks: scene.tracks, elementId });
	if (!found) return fail({ error: "no-element" });
	const { trackId, element } = found;
	if (!isVisualElement(element)) return fail({ error: "unsupported-element" });
	const isText = element.type === "text";
	const elementBox =
		box ?? defaultElementBox({ element, canvasSize: scene.canvasSize, mediaSize: scene.mediaSize });
	if (!elementBox) return fail({ error: "no-box" });

	const selection = selectPinHost({ scene, elementId, box: elementBox });
	if (!selection) return fail({ error: "no-video" });
	const { host } = selection;
	if (analysis.hostElementId !== host.id || analysis.mediaId !== host.mediaId) {
		return fail({ error: "analysis-mismatch" });
	}
	// a cancelled analysis changes nothing: only a finished one is stuck to
	if (analysis.status !== "complete") return fail({ error: "analysis-cancelled" });

	// frames of the analysis that are in the element and on the host's screen time
	const { tracks } = analysis;
	const window = pinWindow({ element, host });
	const clock = analysisFrameClock({ analysis, host });
	if (!window) return fail({ error: "no-video" });
	const first = Math.max(0, Math.ceil((window.start - TIME_EPSILON - clock.origin) / clock.step));
	const last = Math.min(
		tracks.frameCount - 1,
		Math.floor((window.end + TIME_EPSILON - clock.origin) / clock.step),
	);
	if (first > last) return fail({ error: "analysis-outside" });
	const f0 = Math.min(
		Math.max(Math.round(clock.frameAt(seconds(scene.playhead))), first),
		last,
	);

	const frameWindow = { first, last };

	const hostAt = hostBoundsFn({ scene, host });
	const overlay = look ?? transformAt({ element, atSeconds: clock.timeAt(f0) });
	const frameSize = { w: tracks.w, h: tracks.h };
	const corners = elementCorners({
		bounds: elementBox,
		look: overlay,
		isText,
		canvasSize: scene.canvasSize,
	});
	const centre = {
		x: corners.reduce((sum, c) => sum + c.x, 0) / 4,
		y: corners.reduce((sum, c) => sum + c.y, 0) / 4,
	};

	try {
		const pinPoint = canvasToFramePoint({ point: centre, host: hostAt(clock.timeAt(f0)), frameSize });
		// the solver is asked for the element's frames only, and stops at a scene cut
		const solveRange = { lo: first, hi: last };
		const sceneSimilarity = solve({ tracks, f0, model: "S", mode: "scene", range: solveRange });
		const classification = classifyPin({ tracks, solution: sceneSimilarity, pin: pinPoint });
		const pinMode: PinMode =
			mode === "auto" ? (classification.isObject ? "object" : "scene") : mode;

		let qualitySolution = sceneSimilarity;
		let objectSolution: PinSolution | null = null;
		if (pinMode === "object") {
			objectSolution = solve({ tracks, f0, model: "S", mode: "object", pin: pinPoint, range: solveRange });
			qualitySolution = objectSolution;
		}
		const raw = qualityNotices({
			tracks,
			solution: qualitySolution,
			classification,
			window: frameWindow,
		});
		const kindsOf = new Set<CameraNoticeKind>(raw.map((n) => n.kind));
		// the frames the keys cover: from the first to the last the solver tracked
		const tracked = trackedRange({ tracks, solution: qualitySolution });
		const from = tracked.first;
		const to = tracked.last;
		const frames: CameraPinFrames = { first: from, last: to, pin: f0 };
		const cutTimes = raw.flatMap((n) => (n.kind === "cut" ? [clock.timeAt(n.frame)] : []));
		const lost = raw.find((n) => n.kind === "lost");
		const lostFrame = lost?.kind === "lost" ? lost.frame : null;

		const notices: CameraNoticeKind[] = [];
		const blocked: CameraNoticeKind[] = [];
		for (const notice of ["no-texture", "no-motion"] as const) {
			if (kindsOf.has(notice)) blocked.push(notice);
		}
		if (objectSolution && !blocked.includes("no-texture")) {
			const { lo, hi } = objectSolution.range;
			// features that drift into reach of the pin later do not make it followable from the start
			if (
				solvedShare({ solution: objectSolution, first: lo, last: hi, unbroken: true }) <
				OBJECT_SOLVED_SHARE
			) {
				blocked.unshift("no-texture");
			}
		}
		// nothing beyond the pin frame could be followed: there is nothing to write
		const followedNothing = from === to && first < last;
		notices.push(...blocked);
		if (cutTimes.length > 0) notices.push("cut");
		if (kindsOf.has("lost")) notices.push("lost");
		if (!blocked.includes("no-texture") && kindsOf.has("low-quality")) notices.push("low-quality");
		if (pinMode === "object" && classification.isObject) notices.push("object");
		if (blocked.length > 0 || followedNothing) {
			return { status: "no-keys", elementId, notices, lostFrame, frames };
		}

		const build = (solution: PinSolution): CameraPinChannels =>
			buildCameraPinChannels({
				maps: solution,
				first: from,
				last: to,
				frameTimeAt: clock.timeAt,
				frameSize,
				hostAt,
				overlay,
				bounds: elementBox,
				isText,
				canvasSize: scene.canvasSize,
			});

		let model: PinModel = "S";
		let channels = build(objectSolution ?? sceneSimilarity);
		if (pinMode === "scene" && perspectiveSuspected({ solution: sceneSimilarity }).suspected) {
			const homography = solve({ tracks, f0, model: "H", mode: "scene", range: solveRange });
			const { lo, hi } = sceneSimilarity.range;
			const solvedH = solvedShare({ solution: homography, first: lo, last: hi });
			const solvedS = solvedShare({ solution: sceneSimilarity, first: lo, last: hi });
			if (solvedH >= H_SOLVED_SHARE * solvedS) {
				// The similarity's residual is large over a perspective pan whatever the
				// video: the quality is what the better model still misfits by. Noisy
				// tracks misfit the homography too, so a real warning stays. Only a
				// KNOWN good homography drops it: no solved frame is no evidence, and
				// a homography fitted on under MIN_H_INLIERS_FOR_QUALITY inliers
				// over-fits the noise, so it is "unknown" as well. That holds whichever
				// model ends up written: when the written similarity is within
				// MODEL_GAP_FRAME_PX of the homography at the element's corners it is
				// as accurate there as the homography is.
				if (residualQuality({ tracks, solution: homography, window: frameWindow }) === "good") {
					const at = notices.indexOf("low-quality");
					if (at >= 0) notices.splice(at, 1);
				}
				const candidate = build(homography);
				const gap = maxCornerGap({
					a: channels,
					b: candidate,
					bounds: elementBox,
					isText,
					canvasSize: scene.canvasSize,
				});
				if (gap > MODEL_GAP_FRAME_PX * (scene.canvasSize.width / tracks.w)) {
					model = "H";
					channels = candidate;
				}
			}
		}

		const { keys, range } = buildCameraPinKeys({
			simplified: simplifyCameraPinChannels({ channels, bounds: elementBox, pinFrame: f0 }),
			elementStartSec: seconds(element.startTime),
			durationTicks: element.duration,
		});
		return {
			status: "pinned",
			trackId,
			elementId,
			keys,
			range,
			notices,
			lostFrame,
			cutTimes,
			mode: pinMode,
			model,
			classification,
			frames,
			pin: {
				elementId,
				trackId,
				analysisId: analysis.id,
				hostElementId: host.id,
				mode: pinMode,
				model,
				range,
				host: hostStateOf(host),
			},
		};
	} catch (error) {
		if (error instanceof RangeError) {
			return fail({ error: "bad-geometry", message: error.message });
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Entry points (they read and write the editor)
// ---------------------------------------------------------------------------

/** The active scene of the editor as the planner reads it, or null before a project is open. */
export function readScene(): PinScene | null {
	const editor = EditorCore.getInstance();
	const active = editor.scenes.getActiveSceneOrNull();
	if (!active) return null;
	const assets = editor.media.getAssets();
	return {
		tracks: active.tracks,
		canvasSize: editor.project.getActive().settings.canvasSize,
		mediaSize: ({ mediaId }) => {
			const asset = assets.find((candidate) => candidate.id === mediaId);
			return asset?.width && asset.height
				? { width: asset.width, height: asset.height }
				: undefined;
		},
		playhead: editor.playback.getCurrentTime(),
	};
}

/** The box to stick with: the one given, else from the element's type, text measured on a canvas where there is one. */
export function boxFor({
	scene,
	elementId,
	box,
}: {
	scene: PinScene;
	elementId: string;
	box: LocalRect | undefined;
}): LocalRect | null {
	if (box) return box;
	const found = findElementInTracks({ tracks: scene.tracks, elementId });
	if (!found) return null;
	return (
		defaultElementBox({
			element: found.element,
			canvasSize: scene.canvasSize,
			mediaSize: scene.mediaSize,
		}) ??
		measureTextBox({
			element: found.element,
			canvasHeight: scene.canvasSize.height,
			localTime: getElementLocalTime({
				timelineTime: scene.playhead,
				elementStartTime: found.element.startTime,
				elementDuration: found.element.duration,
			}),
		})
	);
}

/** Writes a pinned plan through the editor, as one undo step; anything else is returned as it is. */
function applyPlan({ plan }: { plan: CameraPinPlan }): CameraPinPlan {
	if (plan.status !== "pinned") return plan;
	try {
		EditorCore.getInstance().timeline.applyCameraPin({
			trackId: plan.trackId,
			elementId: plan.elementId,
			channels: plan.keys,
			range: plan.range,
		});
	} catch (error) {
		return fail({
			error: "apply-failed",
			message: error instanceof Error ? error.message : CAMERA_PIN_MESSAGES["apply-failed"],
		});
	}
	return plan;
}

/**
 * Sticks an element to the scene it sits over: finds the video under it, takes
 * the analysis of that video (`analysis`, made elsewhere), writes the five
 * transform channels over the frames the element shares with it, in one undo
 * step. The element looks the same at the playhead and from there moves, scales
 * and turns with the camera. A "pinned" result has been written; "no-keys" and
 * errors have changed nothing. `box` is the element's unscaled box when it
 * cannot be derived (measured text).
 */
export function stickToScene({
	elementId,
	analysis,
	mode,
	box,
}: {
	elementId: string;
	analysis: CameraAnalysis;
	mode?: PinModeChoice;
	box?: LocalRect;
}): CameraPinPlan {
	const scene = readScene();
	if (!scene) return fail({ error: "no-element" });
	const plan = planCameraPin({
		scene,
		elementId,
		analysis,
		box: boxFor({ scene, elementId, box }),
		mode,
	});
	return applyPlan({ plan });
}

/**
 * Sticks a stuck element again from the same analysis, after the user dragged,
 * scaled or turned it: `look` is how it looks now at the playhead, which is
 * kept, and the scene's motion is added from there (the same pin frame rule,
 * the pin's own mode unless `mode` says otherwise). Refused when the host was
 * moved, trimmed or retimed since ("stale-pin"). One undo step.
 */
export function repinElement({
	elementId,
	analysis,
	pin,
	look,
	mode,
	box,
}: {
	elementId: string;
	analysis: CameraAnalysis;
	pin: CameraPinRecord;
	look?: Transform;
	mode?: PinModeChoice;
	box?: LocalRect;
}): CameraPinPlan {
	const scene = readScene();
	if (!scene) return fail({ error: "no-element" });
	const host = findElementInTracks({ tracks: scene.tracks, elementId: pin.hostElementId })?.element;
	if (!host || host.type !== "video" || !isPinCurrent({ pin, host })) {
		return fail({ error: "stale-pin" });
	}
	const plan = planCameraPin({
		scene,
		elementId,
		analysis,
		box: boxFor({ scene, elementId, box }),
		mode: mode ?? pin.mode,
		look,
	});
	return applyPlan({ plan });
}

export type CameraUnstickResult = { status: "unstuck" } | PinFailure;

/**
 * Takes the pin off: removes its keys and leaves the element where it is at
 * the playhead. One undo step, which brings the pin back.
 */
export function unstickElement({
	elementId,
	pin,
}: {
	elementId: string;
	pin: CameraPinRecord;
}): CameraUnstickResult {
	const scene = readScene();
	const found = scene ? findElementInTracks({ tracks: scene.tracks, elementId }) : null;
	if (!found) return fail({ error: "no-element" });
	try {
		EditorCore.getInstance().timeline.removeCameraPin({
			trackId: found.trackId,
			elementId,
			range: pin.range,
		});
	} catch (error) {
		return fail({
			error: "apply-failed",
			message: error instanceof Error ? error.message : CAMERA_PIN_MESSAGES["apply-failed"],
		});
	}
	return { status: "unstuck" };
}
