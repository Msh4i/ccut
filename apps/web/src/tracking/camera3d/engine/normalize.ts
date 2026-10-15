import type { ImageElement, SceneTracks, VideoElement } from "@/timeline";
import type { FeatureTracks } from "@/tracking/camera/types";
import { CODEC_LIMITS, unpackSolve, unpackTracks } from "../codec";
import {
	CAMERA_SOLVE_MESSAGES,
	DEFAULT_CAMERA_TRACKER_SETTINGS,
	type CameraSolve,
	type CameraSolveFailure,
	type CameraSolveNotice,
	type CameraTrackerData,
	type CameraTrackerSettings,
	type CameraTrackerStale,
	type PackedSolve,
	type PackedTracks,
	type ShotType,
	type SolveMethod,
	type SolveMethodUsed,
	type TrackPointDisplay,
} from "../types";
import { rememberDecodedParts } from "./decoded-cache";

/**
 * Load-time validation of `VideoElement.cameraTracker` (stored data is
 * untrusted input). A record that is unreadable in any way (damaged, over
 * the limits, written by a newer version) is moved to
 * `VideoElement.unusableCameraTracker`: the clip then looks untracked to
 * everything that reads `cameraTracker`, and the next save writes the record
 * back unchanged ({@link restoreUnusableCameraTrackers}), so a mismatch here
 * never deletes a user's analysis. The stored project is never rewritten at
 * load; the next save writes the normalised form of a readable record.
 */

/**
 * Sizes a stored analysis may have: the codec's own limits (one set of
 * numbers for the codec, this load check and the engine) and the media id's
 * length. The engine refuses to write anything bigger
 * ({@link tracksFitLoadLimits}), so a record it wrote is never dropped here.
 */
export const CAMERA_TRACKER_LOAD_LIMITS = {
	frameCount: CODEC_LIMITS.frameCount,
	trackCount: CODEC_LIMITS.trackCount,
	samples: CODEC_LIMITS.samples,
	mediaIdLength: 512,
} as const;

/** Does an analysis fit {@link CAMERA_TRACKER_LOAD_LIMITS}, so that a record made from it loads again? */
export function tracksFitLoadLimits({ tracks }: { tracks: FeatureTracks }): boolean {
	const limits = CAMERA_TRACKER_LOAD_LIMITS;
	return (
		tracks.frameCount <= limits.frameCount &&
		tracks.trackStart.length <= limits.trackCount &&
		tracks.xy.length / 2 <= limits.samples
	);
}

/** Ranges of the numeric effect controls; out-of-range values are clamped. */
export const CAMERA_TRACKER_SETTING_LIMITS = {
	horizontalAngleOfViewDeg: { min: 1, max: 179 },
	trackPointSize: { min: 1, max: 1000 },
	targetSize: { min: 1, max: 1000 },
} as const;

type NumericSettingKey = keyof typeof CAMERA_TRACKER_SETTING_LIMITS;
type BooleanSettingKey =
	| "detailedAnalysis"
	| "autoDeleteAcrossTime"
	| "hideWarningBanner"
	| "renderTrackPoints";

const SHOT_TYPES: readonly ShotType[] = ["fixed-angle", "variable-zoom", "specify-angle"];
const SOLVE_METHODS: readonly SolveMethod[] = ["auto", "typical", "mostly-flat", "tripod-pan"];
const METHODS_USED: readonly SolveMethodUsed[] = ["typical", "mostly-flat", "tripod-pan"];
const TRACK_POINT_DISPLAYS: readonly TrackPointDisplay[] = ["2d-source", "3d-solved"];
const STALE_VALUES: readonly CameraTrackerStale[] = ["none", "solve", "analysis"];
const FAILURES: readonly CameraSolveFailure[] = ["no-texture", "no-motion", "too-short", "diverged"];
const NUMERIC_SETTINGS: readonly NumericSettingKey[] = [
	"horizontalAngleOfViewDeg",
	"trackPointSize",
	"targetSize",
];
const SETTING_KEYS: readonly (keyof CameraTrackerSettings)[] = [
	"shotType",
	"horizontalAngleOfViewDeg",
	"solveMethod",
	"detailedAnalysis",
	"autoDeleteAcrossTime",
	"hideWarningBanner",
	"showTrackPoints",
	"renderTrackPoints",
	"trackPointSize",
	"targetSize",
];
const BOOLEAN_SETTINGS: readonly BooleanSettingKey[] = [
	"detailedAnalysis",
	"autoDeleteAcrossTime",
	"hideWarningBanner",
	"renderTrackPoints",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>({
	value,
	options,
}: {
	value: unknown;
	options: readonly T[];
}): T | undefined {
	return options.find((option) => option === value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** `value` when it is a whole number in 0..max, else `null`. */
function countOf({ value, max }: { value: unknown; max: number }): number | null {
	return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function clampSetting({ key, value }: { key: NumericSettingKey; value: number }): number {
	const { min, max } = CAMERA_TRACKER_SETTING_LIMITS[key];
	return Math.min(max, Math.max(min, value));
}

/**
 * The valid entries of a settings patch (the effect controls the UI sends):
 * unknown keys and invalid values are left out, numbers are clamped into
 * {@link CAMERA_TRACKER_SETTING_LIMITS}.
 */
export function sanitizeSettingsPatch(patch: unknown): Partial<CameraTrackerSettings> {
	if (!isRecord(patch)) return {};
	const out: Partial<CameraTrackerSettings> = {};
	const shotType = oneOf({ value: patch.shotType, options: SHOT_TYPES });
	if (shotType) out.shotType = shotType;
	const solveMethod = oneOf({ value: patch.solveMethod, options: SOLVE_METHODS });
	if (solveMethod) out.solveMethod = solveMethod;
	const showTrackPoints = oneOf({ value: patch.showTrackPoints, options: TRACK_POINT_DISPLAYS });
	if (showTrackPoints) out.showTrackPoints = showTrackPoints;
	for (const key of NUMERIC_SETTINGS) {
		const value = patch[key];
		if (isFiniteNumber(value)) out[key] = clampSetting({ key, value });
	}
	for (const key of BOOLEAN_SETTINGS) {
		const value = patch[key];
		if (typeof value === "boolean") out[key] = value;
	}
	return out;
}

/**
 * Stored settings: missing keys take the defaults, unknown keys are
 * ignored, finite numbers are clamped; a present value of the wrong kind
 * (bad enum, non-finite number, non-boolean switch) makes the whole record
 * invalid (`null`).
 */
export function normalizeCameraTrackerSettings(raw: unknown): CameraTrackerSettings | null {
	if (!isRecord(raw)) return null;
	const sanitized = sanitizeSettingsPatch(raw);
	for (const key of SETTING_KEYS) {
		if (raw[key] !== undefined && !(key in sanitized)) return null;
	}
	return { ...DEFAULT_CAMERA_TRACKER_SETTINGS, ...sanitized };
}

function normalizePackedTracks(raw: unknown): { packed: PackedTracks; tracks: FeatureTracks } | null {
	if (!isRecord(raw)) return null;
	const { width, height, fps, quantization, trackStart, trackLen, xy, cuts } = raw;
	const limits = CAMERA_TRACKER_LOAD_LIMITS;
	const frameCount = countOf({ value: raw.frameCount, max: limits.frameCount });
	const trackCount = countOf({ value: raw.trackCount, max: limits.trackCount });
	if (frameCount === null || frameCount < 1 || trackCount === null) return null;
	if (!isFiniteNumber(width) || !isFiniteNumber(height) || !isFiniteNumber(fps) || !isFiniteNumber(quantization)) {
		return null;
	}
	if (typeof trackStart !== "string" || typeof trackLen !== "string" || typeof xy !== "string") return null;
	if (!Array.isArray(cuts) || !cuts.every(isFiniteNumber)) return null;
	const packed: PackedTracks = {
		width,
		height,
		frameCount,
		fps,
		quantization,
		trackCount,
		trackStart,
		trackLen,
		xy,
		cuts: [...cuts],
	};
	const tracks = unpackTracks(packed);
	if (!tracks || tracks.xy.length / 2 > limits.samples) return null;
	return { packed, tracks };
}

function normalizeNotice(raw: unknown): CameraSolveNotice | null {
	if (!isRecord(raw)) return null;
	switch (raw.kind) {
		case "tripod-no-depth":
			return { kind: "tripod-no-depth" };
		case "unsolved-frames": {
			const count = countOf({ value: raw.count, max: CODEC_LIMITS.frameCount });
			return count === null ? null : { kind: "unsolved-frames", count };
		}
		case "cut": {
			const frame = countOf({ value: raw.frame, max: CODEC_LIMITS.frameCount });
			return frame === null ? null : { kind: "cut", frame };
		}
		case "high-error":
			return isFiniteNumber(raw.averageError) ? { kind: "high-error", averageError: raw.averageError } : null;
		default:
			return null;
	}
}

function normalizePackedSolve({
	raw,
	frameCount,
	trackCount,
	frameWidth,
	frameHeight,
}: {
	raw: unknown;
	frameCount: number;
	trackCount: number;
	frameWidth: number;
	frameHeight: number;
}): { packed: PackedSolve; solve: CameraSolve } | null {
	if (!isRecord(raw)) return null;
	const methodUsed = oneOf({ value: raw.methodUsed, options: METHODS_USED });
	if (!methodUsed || !Array.isArray(raw.notices)) return null;
	const notices: CameraSolveNotice[] = [];
	for (const item of raw.notices) {
		const notice = normalizeNotice(item);
		if (!notice) return null;
		notices.push(notice);
	}
	const { cameras, solved, pointIds, points, averageError } = raw;
	if (
		typeof cameras !== "string" ||
		typeof solved !== "string" ||
		typeof pointIds !== "string" ||
		typeof points !== "string" ||
		!isFiniteNumber(averageError)
	) {
		return null;
	}
	// one camera per analysis frame, imaging the clip's own picture
	if (raw.frameCount !== frameCount || raw.frameWidth !== frameWidth || raw.frameHeight !== frameHeight) return null;
	const packed: PackedSolve = {
		frameWidth,
		frameHeight,
		frameCount,
		cameras,
		solved,
		pointIds,
		points,
		methodUsed,
		averageError,
		notices,
	};
	const solve = unpackSolve(packed);
	if (!solve) return null;
	if (solve.points.some((point) => point.trackId >= trackCount)) return null;
	return { packed, solve };
}

function normalizeDeleted({ raw, trackCount }: { raw: unknown; trackCount: number }): number[] | null {
	if (!Array.isArray(raw) || raw.length > trackCount) return null;
	const ids = new Set<number>();
	for (const value of raw) {
		const id = countOf({ value, max: trackCount - 1 });
		if (id === null) return null;
		ids.add(id);
	}
	return [...ids].sort((a, b) => a - b);
}

/** `undefined` = invalid, `null` = no failure. The message is always the contract's text for the reason. */
function normalizeFailure(raw: unknown): CameraTrackerData["failure"] | undefined {
	if (raw === null) return null;
	if (!isRecord(raw)) return undefined;
	const reason = oneOf({ value: raw.reason, options: FAILURES });
	return reason ? { reason, message: CAMERA_SOLVE_MESSAGES[reason] } : undefined;
}

/** Plain-data deep equality (what a structured clone or JSON keeps). */
function samePlainData({ a, b }: { a: unknown; b: unknown }): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((value, index) => samePlainData({ a: value, b: b[index] }));
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => Object.hasOwn(b, key) && samePlainData({ a: a[key], b: b[key] }));
}

/** A guard: is a stored record already exactly `canonical`? */
function sameAs(canonical: CameraTrackerData): (raw: unknown) => raw is CameraTrackerData {
	return (raw): raw is CameraTrackerData => samePlainData({ a: raw, b: canonical });
}

function normalizeRecord(raw: unknown): CameraTrackerData | undefined {
	if (!isRecord(raw) || raw.version !== 1) return undefined;
	const { mediaId, sourceStart, frameWidth, frameHeight, groundPlaneSet } = raw;
	if (typeof mediaId !== "string" || mediaId.length === 0) return undefined;
	if (mediaId.length > CAMERA_TRACKER_LOAD_LIMITS.mediaIdLength) return undefined;
	if (!isFiniteNumber(sourceStart) || sourceStart < 0) return undefined;
	for (const size of [frameWidth, frameHeight]) {
		if (!isFiniteNumber(size) || size <= 0 || size > CODEC_LIMITS.frameSize) return undefined;
	}
	if (!isFiniteNumber(frameWidth) || !isFiniteNumber(frameHeight)) return undefined;
	if (typeof groundPlaneSet !== "boolean") return undefined;
	const stale = oneOf({ value: raw.stale, options: STALE_VALUES });
	if (!stale) return undefined;
	const failure = normalizeFailure(raw.failure);
	if (failure === undefined) return undefined;
	const settings = normalizeCameraTrackerSettings(raw.settings);
	if (!settings) return undefined;
	const tracks = normalizePackedTracks(raw.tracks);
	if (!tracks) return undefined;
	const deletedTrackIds = normalizeDeleted({ raw: raw.deletedTrackIds, trackCount: tracks.packed.trackCount });
	if (!deletedTrackIds) return undefined;
	let solve: { packed: PackedSolve; solve: CameraSolve } | null = null;
	if (raw.solve !== null) {
		solve = normalizePackedSolve({
			raw: raw.solve,
			frameCount: tracks.packed.frameCount,
			trackCount: tracks.packed.trackCount,
			frameWidth,
			frameHeight,
		});
		if (!solve) return undefined;
	}
	const canonical: CameraTrackerData = {
		version: 1,
		settings,
		mediaId,
		sourceStart,
		frameWidth,
		frameHeight,
		tracks: tracks.packed,
		deletedTrackIds,
		solve: solve ? solve.packed : null,
		failure,
		stale,
		groundPlaneSet,
	};
	const isCanonical = sameAs(canonical);
	const data = isCanonical(raw) ? raw : canonical;
	rememberDecodedParts({
		data,
		parts: { tracks: tracks.tracks, solve: solve ? solve.solve : null, deleted: new Set(deletedTrackIds) },
	});
	return data;
}

/**
 * A stored `cameraTracker` record checked and brought into its canonical
 * form, or `undefined` (unreadable) when anything about it is wrong: another
 * version, a non-finite number, an unknown enum value, packed arrays the
 * codec rejects or that break {@link CAMERA_TRACKER_LOAD_LIMITS}, a solve
 * that does not match its tracks. Never throws. A valid record comes back
 * as the same object.
 */
export function normalizeCameraTracker(raw: unknown): CameraTrackerData | undefined {
	try {
		return normalizeRecord(raw);
	} catch {
		return undefined;
	}
}

function normalizeElement(element: VideoElement | ImageElement): VideoElement | ImageElement {
	if (!element || element.type !== "video" || element.cameraTracker === undefined) return element;
	const raw: unknown = element.cameraTracker;
	const cameraTracker = normalizeCameraTracker(raw);
	if (cameraTracker === raw) return element;
	if (cameraTracker) return { ...element, cameraTracker };
	// stored data is untrusted: the id may be any value, and String() of an object can throw
	const id: unknown = element.id;
	console.warn(
		"[camera-tracker] Kept a Track Camera record this version cannot read; the clip is shown untracked and the record is saved back unchanged.",
		{ elementId: typeof id === "string" ? id.slice(0, 80) : typeof id },
	);
	const { cameraTracker: _unreadable, ...rest } = element;
	return { ...rest, unusableCameraTracker: raw };
}

function mapUnchanged<T>({ items, map }: { items: T[]; map: (item: T) => T }): T[] {
	let changed = false;
	const next = items.map((item) => {
		const mapped = map(item);
		if (mapped !== item) changed = true;
		return mapped;
	});
	return changed ? next : items;
}

/** Is `tracks` shaped well enough to walk? Loaded data is untrusted: a broken shape is not ours to fix. */
function walkable(tracks: SceneTracks): boolean {
	return (
		!!tracks &&
		Array.isArray(tracks.overlay) &&
		Array.isArray(tracks.audio) &&
		[...tracks.overlay, tracks.main].every((track) => Array.isArray(track?.elements))
	);
}

/** `map` applied to every video clip (main and overlay video tracks); untouched parts keep their identity. */
function mapVideoClips({
	tracks,
	map,
}: {
	tracks: SceneTracks;
	map: (element: VideoElement | ImageElement) => VideoElement | ImageElement;
}): SceneTracks {
	if (!walkable(tracks)) return tracks;
	const overlay = mapUnchanged({
		items: tracks.overlay,
		map: (track) => {
			if (track.type !== "video") return track;
			const elements = mapUnchanged({ items: track.elements, map });
			return elements === track.elements ? track : { ...track, elements };
		},
	});
	const mainElements = mapUnchanged({ items: tracks.main.elements, map });
	if (overlay === tracks.overlay && mainElements === tracks.main.elements) return tracks;
	return {
		...tracks,
		overlay,
		main: mainElements === tracks.main.elements ? tracks.main : { ...tracks.main, elements: mainElements },
	};
}

/**
 * Applies {@link normalizeCameraTracker} to every video clip (main and
 * overlay video tracks); untouched parts keep their identity. Camera
 * elements are kept whatever their source is (a missing source renders
 * with the default camera).
 */
export function normalizeSceneTracksCameraTracker({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return mapVideoClips({ tracks, map: normalizeElement });
}

function restoreElement(element: VideoElement | ImageElement): VideoElement | ImageElement {
	// an own property only: Object.prototype is not a stored record
	if (!element || element.type !== "video" || !Object.hasOwn(element, "unusableCameraTracker")) return element;
	const { unusableCameraTracker, ...rest } = element;
	// a record made after the load (the clip was tracked again) replaces the kept one
	if (rest.cameraTracker !== undefined) return rest;
	// the record is whatever was stored: it goes back as it came, not as a CameraTrackerData
	Reflect.set(rest, "cameraTracker", unusableCameraTracker);
	return rest;
}

/**
 * The tracks as they are stored: every clip's set-aside record (see
 * {@link normalizeSceneTracksCameraTracker}) goes back into `cameraTracker`,
 * the very object that was loaded, unless the clip was tracked again since.
 * Untouched parts keep their identity, so a project without such a record
 * is saved exactly as before.
 */
export function restoreUnusableCameraTrackers({ tracks }: { tracks: SceneTracks }): SceneTracks {
	return mapVideoClips({ tracks, map: restoreElement });
}
