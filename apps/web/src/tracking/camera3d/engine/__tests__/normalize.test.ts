import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { encodeBase64, packInt32, packSolve } from "@/tracking/camera3d/codec";
import { DEFAULT_CAMERA_TRACKER_SETTINGS } from "@/tracking/camera3d/types";
import type { SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import {
	CAMERA_TRACKER_LOAD_LIMITS,
	normalizeCameraTracker,
	normalizeSceneTracksCameraTracker,
	restoreUnusableCameraTrackers,
} from "../normalize";
import { sceneOf, textLayer, textTrack, videoClip, cameraLayer, cameraTrack } from "./editor-harness";
import { sceneSolve, trackerData } from "./fixtures";

/** A deep copy through JSON, like data that went through storage and came back as plain objects. */
function stored(value: unknown): Record<string, unknown> {
	const copy: unknown = JSON.parse(JSON.stringify(value));
	if (!copy || typeof copy !== "object" || Array.isArray(copy)) throw new Error("not an object");
	return Object.fromEntries(Object.entries(copy));
}

function withField({ key, value }: { key: string; value: unknown }): Record<string, unknown> {
	return { ...stored(trackerData()), [key]: value };
}

function withSetting({ key, value }: { key: string; value: unknown }): Record<string, unknown> {
	const data = stored(trackerData());
	return { ...data, settings: { ...stored(data.settings), [key]: value } };
}

function withTracks(patch: Record<string, unknown>): Record<string, unknown> {
	const data = stored(trackerData());
	return { ...data, tracks: { ...stored(data.tracks), ...patch } };
}

function withSolve(patch: Record<string, unknown>): Record<string, unknown> {
	const data = stored(trackerData());
	return { ...data, solve: { ...stored(data.solve), ...patch } };
}

describe("normalizeCameraTracker: what the engine wrote comes back", () => {
	test("a valid record is kept as it is (same object)", () => {
		const data = trackerData();
		expect(normalizeCameraTracker(data)).toBe(data);
	});

	test("a JSON round trip of a valid record is accepted and equal", () => {
		const data = trackerData();
		expect(normalizeCameraTracker(stored(data))).toEqual(data);
	});

	test("a record without a solve (analysis only) and with deleted points is valid", () => {
		const data = trackerData({ overrides: { solve: null, deletedTrackIds: [1, 3], stale: "solve" } });
		expect(normalizeCameraTracker(data)).toBe(data);
	});

	test("a failure is kept with the contract's message, whatever text was stored", () => {
		const result = normalizeCameraTracker(
			withField({ key: "failure", value: { reason: "no-motion", message: "<img src=x onerror=alert(1)>" } }),
		);
		expect(result?.failure).toEqual({
			reason: "no-motion",
			message: "The camera does not move: nothing to solve.",
		});
	});

	test("unknown settings keys are ignored, missing ones defaulted, numbers clamped into range", () => {
		const data = stored(trackerData());
		const settings = stored(data.settings);
		delete settings.targetSize;
		delete settings.hideWarningBanner;
		const result = normalizeCameraTracker({
			...data,
			settings: { ...settings, futureOption: 7, trackPointSize: 1e9, horizontalAngleOfViewDeg: 0 },
		});
		expect(result?.settings).toEqual({
			...DEFAULT_CAMERA_TRACKER_SETTINGS,
			trackPointSize: 1000,
			horizontalAngleOfViewDeg: 1,
		});
		expect(Object.keys(result?.settings ?? {})).not.toContain("futureOption");
	});

	test("unknown top-level keys are not carried on", () => {
		const result = normalizeCameraTracker({ ...stored(trackerData()), extra: { huge: "x".repeat(10) } });
		expect(result).toBeDefined();
		expect(Object.keys(result ?? {})).not.toContain("extra");
	});

	test("duplicated deleted ids are merged and sorted", () => {
		const result = normalizeCameraTracker(withField({ key: "deletedTrackIds", value: [3, 1, 3] }));
		expect(result?.deletedTrackIds).toEqual([1, 3]);
	});
});

describe("normalizeCameraTracker: hostile stored data is rejected, never thrown", () => {
	const hostile: Array<[string, unknown]> = [
		["not an object", "camera"],
		["null", null],
		["an array", []],
		["wrong version", withField({ key: "version", value: 2 })],
		["missing version", withField({ key: "version", value: undefined })],
		["empty mediaId", withField({ key: "mediaId", value: "" })],
		["mediaId not a string", withField({ key: "mediaId", value: 7 })],
		["mediaId absurdly long", withField({ key: "mediaId", value: "m".repeat(5000) })],
		["NaN sourceStart", withField({ key: "sourceStart", value: Number.NaN })],
		["Infinity sourceStart", withField({ key: "sourceStart", value: Number.POSITIVE_INFINITY })],
		["negative sourceStart", withField({ key: "sourceStart", value: -1 })],
		["zero frame width", withField({ key: "frameWidth", value: 0 })],
		["huge frame height", withField({ key: "frameHeight", value: 1e9 })],
		["bad stale", withField({ key: "stale", value: "maybe" })],
		["groundPlaneSet not boolean", withField({ key: "groundPlaneSet", value: "yes" })],
		["bad failure reason", withField({ key: "failure", value: { reason: "nope", message: "x" } })],
		["failure not an object", withField({ key: "failure", value: "x" })],
		["deleted ids not a list", withField({ key: "deletedTrackIds", value: "1,2" })],
		["deleted id out of range", withField({ key: "deletedTrackIds", value: [999] })],
		["deleted id negative", withField({ key: "deletedTrackIds", value: [-1] })],
		["deleted id fractional", withField({ key: "deletedTrackIds", value: [1.5] })],
		["settings missing", withField({ key: "settings", value: undefined })],
		["bad shot type", withSetting({ key: "shotType", value: "dolly" })],
		["bad solve method", withSetting({ key: "solveMethod", value: 1 })],
		["bad track point display", withSetting({ key: "showTrackPoints", value: "4d" })],
		["boolean setting as string", withSetting({ key: "detailedAnalysis", value: "true" })],
		["non-finite angle", withSetting({ key: "horizontalAngleOfViewDeg", value: null })],
		["tracks missing", withField({ key: "tracks", value: null })],
		["tracks bad base64", withTracks({ xy: "%%%%" })],
		["tracks short xy", withTracks({ xy: encodeBase64(new Uint8Array(4)) })],
		["tracks count lies", withTracks({ trackCount: 9 })],
		["tracks frame count over the load limit", withTracks({ frameCount: CAMERA_TRACKER_LOAD_LIMITS.frameCount + 1 })],
		["tracks without frames", withTracks({ frameCount: 0, trackCount: 0, trackStart: "", trackLen: "", xy: "" })],
		["track running past the end", withTracks({ trackStart: packInt32([0, 0, 0, 0, 0, 0, 0, 4]) })],
		["tracks fps NaN", withTracks({ fps: Number.NaN })],
		["tracks cuts not numbers", withTracks({ cuts: ["a"] })],
		["solve frame count differs from the tracks", withSolve({ frameCount: 5 })],
		["solve frame size differs from the clip's", withSolve({ frameWidth: 1280 })],
		["solve bad method", withSolve({ methodUsed: "auto" })],
		["solve NaN error", withSolve({ averageError: Number.NaN })],
		["solve point id past the tracks", withSolve({ pointIds: packInt32([0, 1, 2, 3, 4, 5, 6, 99]) })],
		["solve bad notice", withSolve({ notices: [{ kind: "explode" }] })],
		[
			"solve point error infinite",
			{
				...stored(trackerData()),
				solve: stored(
					packSolve({
						...sceneSolve().solve,
						points: sceneSolve().solve.points.map((point) => ({ ...point, error: Number.POSITIVE_INFINITY })),
					}),
				),
			},
		],
		["solve cameras truncated", withSolve({ cameras: encodeBase64(new Uint8Array(8)) })],
		["solve not an object", withField({ key: "solve", value: 3 })],
	];

	for (const [name, raw] of hostile) {
		test(name, () => {
			expect(() => normalizeCameraTracker(raw)).not.toThrow();
			expect(normalizeCameraTracker(raw)).toBeUndefined();
		});
	}

	test("NaN inside the packed solve cameras is rejected", () => {
		const data = stored(trackerData());
		const solve = stored(data.solve);
		const floats = new Float32Array(6 * 8).fill(Number.NaN);
		const bytes = new Uint8Array(floats.buffer);
		expect(normalizeCameraTracker({ ...data, solve: { ...solve, cameras: encodeBase64(bytes) } })).toBeUndefined();
	});

	test("a getter that throws inside the stored record does not crash load", () => {
		const raw = stored(trackerData());
		Object.defineProperty(raw, "settings", {
			get() {
				throw new Error("hostile getter");
			},
		});
		expect(normalizeCameraTracker(raw)).toBeUndefined();
	});
});

/** The scene the way storage hands it out: `clip` plus other video, text and camera elements. */
function tracksWith({ clip }: { clip: VideoElement }): SceneTracks {
	return sceneOf({
		main: [clip],
		overlay: [
			{ id: "overlay-video", name: "v", type: "video", muted: false, hidden: false, elements: [videoClip({ id: "o" })] },
			textTrack({ elements: [textLayer()] }),
			cameraTrack({ elements: [cameraLayer({ sourceElementId: "" }), cameraLayer({ id: "c2", sourceElementId: "gone" })] }),
		],
	});
}

function videoOf(element: TimelineElement): VideoElement {
	if (element.type !== "video") throw new Error("expected a video clip");
	return element;
}

/** A clip whose stored `cameraTracker` is `raw`, whatever that is. */
function storedClip({ raw, id = "clip" }: { raw: unknown; id?: string }): VideoElement {
	const clip = videoClip({ id });
	Reflect.set(clip, "cameraTracker", raw);
	return clip;
}

function silenceWarnings() {
	const calls: unknown[][] = [];
	const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		calls.push(args);
	});
	return { calls, restore: () => spy.mockRestore() };
}

let warnings: ReturnType<typeof silenceWarnings> | null = null;
beforeEach(() => {
	warnings = silenceWarnings();
});
afterEach(() => {
	warnings?.restore();
	warnings = null;
});

describe("normalizeSceneTracksCameraTracker", () => {
	test("valid data and clips without data keep the tracks object", () => {
		const tracks = tracksWith({ clip: videoClip({ extra: { cameraTracker: trackerData() } }) });
		expect(normalizeSceneTracksCameraTracker({ tracks })).toBe(tracks);
		const plain = tracksWith({ clip: videoClip() });
		expect(normalizeSceneTracksCameraTracker({ tracks: plain })).toBe(plain);
		expect(warnings?.calls).toEqual([]);
	});

	test("a valid record that is not canonical is brought into its canonical form on the clip", () => {
		const raw = { ...stored(trackerData()), extra: { huge: "x".repeat(10) } };
		const result = normalizeSceneTracksCameraTracker({ tracks: tracksWith({ clip: storedClip({ raw }) }) });
		const clip = videoOf(result.main.elements[0]);
		expect(clip.cameraTracker).toEqual(trackerData());
		expect("unusableCameraTracker" in clip).toBe(false);
		expect(warnings?.calls).toEqual([]);
	});

	test("overlay video clips are normalised too", () => {
		const tracks = tracksWith({ clip: videoClip() });
		const overlayClip = tracks.overlay[0].elements[0];
		Reflect.set(overlayClip, "cameraTracker", "garbage");
		const result = normalizeSceneTracksCameraTracker({ tracks });
		expect("cameraTracker" in result.overlay[0].elements[0]).toBe(false);
		expect(Reflect.get(result.overlay[0].elements[0], "unusableCameraTracker")).toBe("garbage");
		expect(result.overlay[1]).toBe(tracks.overlay[1]);
	});

	test("camera elements with a missing or empty source stay as they are", () => {
		const tracks = tracksWith({ clip: videoClip() });
		const result = normalizeSceneTracksCameraTracker({ tracks });
		expect(result.overlay[2]).toBe(tracks.overlay[2]);
	});

	test("broken track shapes are left alone instead of throwing", () => {
		// JSON.parse gives untyped data, like a stored record
		const broken = JSON.parse('{"overlay":"x","main":null,"audio":[]}');
		expect(() => normalizeSceneTracksCameraTracker({ tracks: broken })).not.toThrow();
		const noMain = JSON.parse('{"overlay":[],"audio":[]}');
		expect(normalizeSceneTracksCameraTracker({ tracks: noMain })).toBe(noMain);
	});
});

describe("an unreadable record is set aside on the clip, never dropped", () => {
	const unreadable: Array<[string, unknown]> = [
		["a malformed record", { version: 1, settings: "x" }],
		["a record of a newer version", { ...stored(trackerData()), version: 2, futureOnly: { lens: [1, 2, 3] } }],
		["a damaged analysis", withTracks({ xy: "%%%%" })],
		["a string", "<script>"],
		["null", null],
	];

	for (const [name, raw] of unreadable) {
		test(`${name}: kept as the very same object, out of the field every consumer reads`, () => {
			const tracks = tracksWith({ clip: storedClip({ raw }) });
			const clip = videoOf(normalizeSceneTracksCameraTracker({ tracks }).main.elements[0]);
			expect("cameraTracker" in clip).toBe(false);
			expect(clip.unusableCameraTracker).toBe(raw);
			const { unusableCameraTracker: _kept, ...rest } = clip;
			expect(rest).toEqual(videoClip());
		});
	}

	test("the record is left untouched and the load says so once", () => {
		const raw = { ...stored(trackerData()), version: 2 };
		const before = JSON.stringify(raw);
		normalizeSceneTracksCameraTracker({ tracks: tracksWith({ clip: storedClip({ raw, id: "tracked" }) }) });
		expect(JSON.stringify(raw)).toBe(before);
		expect(warnings?.calls).toHaveLength(1);
		expect(String(warnings?.calls[0]?.[0])).toContain("camera-tracker");
		expect(warnings?.calls[0]).toContainEqual({ elementId: "tracked" });
	});

	test("a set-aside clip is stable: normalising the result again changes nothing and stays quiet", () => {
		const first = normalizeSceneTracksCameraTracker({
			tracks: tracksWith({ clip: storedClip({ raw: { ...stored(trackerData()), version: 2 } }) }),
		});
		expect(normalizeSceneTracksCameraTracker({ tracks: first })).toBe(first);
		expect(warnings?.calls).toHaveLength(1);
	});

	test("a clip id that cannot be turned into text does not stop the load: the record is still set aside, and the load says so", () => {
		// stored data is untrusted: String() of this object throws a TypeError
		const hostileId: unknown = JSON.parse('{"toString":1,"valueOf":1}');
		const clip = storedClip({ raw: "garbage" });
		Reflect.set(clip, "id", hostileId);
		const result = videoOf(normalizeSceneTracksCameraTracker({ tracks: tracksWith({ clip }) }).main.elements[0]);
		expect("cameraTracker" in result).toBe(false);
		expect(result.unusableCameraTracker).toBe("garbage");
		expect(warnings?.calls).toHaveLength(1);
		expect(warnings?.calls[0]).toContainEqual({ elementId: "object" });
	});

	test("one bad clip does not touch the good record of another", () => {
		const good = trackerData();
		const tracks = tracksWith({ clip: storedClip({ raw: "bad" }) });
		Reflect.set(tracks.overlay[0].elements[0], "cameraTracker", good);
		const result = normalizeSceneTracksCameraTracker({ tracks });
		expect(result.overlay[0]).toBe(tracks.overlay[0]);
	});
});

describe("restoreUnusableCameraTrackers: the save side of the set-aside", () => {
	function loadedWith({ raw }: { raw: unknown }): SceneTracks {
		return normalizeSceneTracksCameraTracker({ tracks: tracksWith({ clip: storedClip({ raw }) }) });
	}

	test("the record goes back into cameraTracker, the very same object, and nothing else changes", () => {
		const raw = { ...stored(trackerData()), version: 2 };
		const loaded = loadedWith({ raw });
		const saved = restoreUnusableCameraTrackers({ tracks: loaded });
		const clip = videoOf(saved.main.elements[0]);
		const restored: unknown = clip.cameraTracker;
		expect(restored).toBe(raw);
		expect("unusableCameraTracker" in clip).toBe(false);
		const { cameraTracker: _restored, ...rest } = clip;
		expect(rest).toEqual(videoClip());
		expect(saved.overlay).toBe(loaded.overlay);
		// the loaded state itself is not changed
		expect("unusableCameraTracker" in loaded.main.elements[0]).toBe(true);
	});

	test("a null or string record goes back too", () => {
		for (const raw of [null, "<script>", 0]) {
			const clip = restoreUnusableCameraTrackers({ tracks: loadedWith({ raw }) }).main.elements[0];
			expect(Reflect.get(clip, "cameraTracker")).toBe(raw);
		}
	});

	test("tracks without a set-aside record keep their identity (every normal save)", () => {
		const plain = tracksWith({ clip: videoClip() });
		expect(restoreUnusableCameraTrackers({ tracks: plain })).toBe(plain);
		const tracked = tracksWith({ clip: videoClip({ extra: { cameraTracker: trackerData() } }) });
		expect(restoreUnusableCameraTrackers({ tracks: tracked })).toBe(tracked);
	});

	test("a clip tracked again after the load saves the new record, not the old one", () => {
		const loaded = loadedWith({ raw: { ...stored(trackerData()), version: 2 } });
		const fresh = trackerData({ overrides: { stale: "solve" } });
		const retracked = { ...videoOf(loaded.main.elements[0]), cameraTracker: fresh };
		const saved = restoreUnusableCameraTrackers({ tracks: { ...loaded, main: { ...loaded.main, elements: [retracked] } } });
		const clip = videoOf(saved.main.elements[0]);
		expect(clip.cameraTracker).toBe(fresh);
		expect("unusableCameraTracker" in clip).toBe(false);
	});

	test("a record that a clip does not own itself is not restored: Object.prototype cannot add a tracker to every clip", () => {
		const plain = tracksWith({ clip: videoClip() });
		const saved = (() => {
			Reflect.set(Object.prototype, "unusableCameraTracker", "polluted");
			try {
				return restoreUnusableCameraTrackers({ tracks: plain });
			} finally {
				Reflect.deleteProperty(Object.prototype, "unusableCameraTracker");
			}
		})();
		expect(saved).toBe(plain);
		expect(Object.hasOwn(videoOf(saved.main.elements[0]), "cameraTracker")).toBe(false);
	});

	test("overlay video clips are restored too", () => {
		const tracks = tracksWith({ clip: videoClip() });
		Reflect.set(tracks.overlay[0].elements[0], "cameraTracker", "garbage");
		const saved = restoreUnusableCameraTrackers({ tracks: normalizeSceneTracksCameraTracker({ tracks }) });
		expect(Reflect.get(saved.overlay[0].elements[0], "cameraTracker")).toBe("garbage");
		expect("unusableCameraTracker" in saved.overlay[0].elements[0]).toBe(false);
	});

	test("broken track shapes are left alone instead of throwing", () => {
		const broken = JSON.parse('{"overlay":"x","main":null,"audio":[]}');
		expect(() => restoreUnusableCameraTrackers({ tracks: broken })).not.toThrow();
		expect(restoreUnusableCameraTrackers({ tracks: broken })).toBe(broken);
	});
});
