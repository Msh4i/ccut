import { afterEach, describe, expect, test } from "bun:test";
import type { FeatureTracks } from "@/tracking/camera/types";
import { CODEC_LIMITS, packTracks } from "@/tracking/camera3d/codec";
import { CAMERA_TRACKER_MESSAGES } from "../engine";
import { CAMERA_TRACKER_LOAD_LIMITS, normalizeCameraTracker, tracksFitLoadLimits } from "../normalize";
import { MAX_ANALYSIS_FPS } from "../analysis";
import { sceneOf, videoClip } from "./editor-harness";
import { engineHarness, type EngineHarness } from "./engine-harness";
import { trackerData } from "./fixtures";

/**
 * One clip's record is rewritten by every autosave, so its size is bounded,
 * and what the engine may write is exactly what a load accepts.
 */

/** Tracks with `lens[i]` samples in track i (all starting at frame 0), nothing else filled in. */
function bareTracks({ frameCount, lens }: { frameCount: number; lens: number[] }): FeatureTracks {
	const trackStart = new Int32Array(lens.length);
	const trackLen = Int32Array.from(lens);
	const trackOffset = new Int32Array(lens.length);
	let samples = 0;
	for (let i = 0; i < lens.length; i++) {
		trackOffset[i] = samples * 2;
		samples += lens[i];
	}
	return {
		w: 480,
		h: 270,
		frameCount,
		fps: 30,
		trackStart,
		trackLen,
		trackOffset,
		xy: new Float32Array(samples * 2),
		liveOffsets: new Int32Array(frameCount + 1),
		liveIds: new Int32Array(0),
		cuts: [],
		stats: { lostFraction: new Float32Array(frameCount), cutNcc: [] },
	};
}

/** The record the engine would write for `tracks` (no solve: the tracks alone decide the limits). */
function recordFor({ tracks }: { tracks: FeatureTracks }) {
	return { ...trackerData(), tracks: packTracks(tracks), solve: null, deletedTrackIds: [] };
}

describe("the limits of a stored analysis", () => {
	test("codec, load check and engine share one set of numbers", () => {
		expect(CAMERA_TRACKER_LOAD_LIMITS.frameCount).toBe(CODEC_LIMITS.frameCount);
		expect(CAMERA_TRACKER_LOAD_LIMITS.trackCount).toBe(CODEC_LIMITS.trackCount);
		expect(CAMERA_TRACKER_LOAD_LIMITS.samples).toBe(CODEC_LIMITS.samples);
		// the solver writes at most one point per track
		expect(CODEC_LIMITS.points).toBe(CODEC_LIMITS.trackCount);
	});

	test("they keep a record at about 16 MB of samples and under 32 MB in all", () => {
		expect(CODEC_LIMITS.frameCount).toBeLessThanOrEqual(20_000);
		expect(CODEC_LIMITS.samples).toBeLessThanOrEqual(3_000_000);
		// base64 of: an Int16 pair per sample, two Int32 per track, an Int32 and four Float32 per point, eight Float32 and a byte per frame
		const rawBytes =
			CODEC_LIMITS.samples * 4 + CODEC_LIMITS.trackCount * 8 + CODEC_LIMITS.points * 20 + CODEC_LIMITS.frameCount * 33;
		expect(Math.ceil(rawBytes / 3) * 4).toBeLessThan(32_000_000);
	});
});

describe("what the engine may write is what a load accepts", () => {
	const limits = CAMERA_TRACKER_LOAD_LIMITS;
	const cases: Array<{ name: string; frameCount: number; lens: () => number[]; fits: boolean }> = [
		{ name: "samples at the limit", frameCount: 20, lens: () => new Array<number>(limits.trackCount).fill(limits.samples / limits.trackCount), fits: true },
		{
			name: "one sample over the limit",
			frameCount: 20,
			lens: () => {
				const lens = new Array<number>(limits.trackCount).fill(limits.samples / limits.trackCount);
				lens[0]++;
				return lens;
			},
			fits: false,
		},
		{ name: "tracks at the limit", frameCount: 20, lens: () => new Array<number>(limits.trackCount).fill(1), fits: true },
		{ name: "one track over the limit", frameCount: 20, lens: () => new Array<number>(limits.trackCount + 1).fill(1), fits: false },
		{ name: "frames at the limit", frameCount: limits.frameCount, lens: () => [1], fits: true },
		{ name: "one frame over the limit", frameCount: limits.frameCount + 1, lens: () => [1], fits: false },
	];

	for (const { name, frameCount, lens, fits } of cases) {
		test(`${name}: engine check and load agree`, () => {
			// refuse before building anything big when the limits are not the small ones
			expect(limits.samples).toBeLessThanOrEqual(3_000_000);
			const tracks = bareTracks({ frameCount, lens: lens() });
			expect(tracksFitLoadLimits({ tracks })).toBe(fits);
			const loaded = normalizeCameraTracker(recordFor({ tracks }));
			expect(loaded !== undefined).toBe(fits);
		});
	}

	test("a record at the sample limit is about 16 MB of samples and well under 32 MB", () => {
		expect(limits.samples).toBeLessThanOrEqual(3_000_000);
		const lens = new Array<number>(limits.trackCount).fill(limits.samples / limits.trackCount);
		const record = recordFor({ tracks: bareTracks({ frameCount: 20, lens }) });
		expect(record.tracks.xy.length).toBeGreaterThan(15_000_000);
		expect(record.tracks.xy.length).toBeLessThan(17_000_000);
		expect(JSON.stringify(record).length).toBeLessThan(24_000_000);
	});
});

describe("Track Camera refuses a clip that would not fit, with a message that says what to do", () => {
	let current: EngineHarness | null = null;
	afterEach(() => {
		current?.dispose();
		current = null;
	});

	/** A clip whose analysis has exactly `frames` frames at the media's 30 fps. */
	function clipOf({ frames }: { frames: number }) {
		return videoClip({ duration: (frames - 0.5) / MAX_ANALYSIS_FPS });
	}

	test("the frame message names the frame limit and the remedy, and does not promise a length in minutes", () => {
		const message = CAMERA_TRACKER_MESSAGES.tooLong;
		expect(message).toContain(String(CAMERA_TRACKER_LOAD_LIMITS.frameCount));
		expect(message).toMatch(/trim/i);
		// the sample limit usually binds first, so a clip under the frame limit can still be too large
		expect(message).toMatch(/too large to save/i);
		expect(message).not.toMatch(/\d\s*minutes/i);
	});

	test("the size message says the analysis found too many feature points, and to trim the clip or use the Normal analysis", () => {
		const message = CAMERA_TRACKER_MESSAGES.tooLarge;
		expect(message).toMatch(/too many feature points/i);
		expect(message).toMatch(/trim/i);
		expect(message).toMatch(/Normal/);
	});

	test("a clip of exactly the most frames is analysed, one frame more is refused before any decoding", async () => {
		current = engineHarness({
			tracks: sceneOf({ main: [clipOf({ frames: CAMERA_TRACKER_LOAD_LIMITS.frameCount })] }),
			decode: () => [],
		});
		await current.engine.trackCamera({ elementId: "clip" });
		expect(current.decodeCalls).toHaveLength(1);
		current.dispose();

		current = engineHarness({
			tracks: sceneOf({ main: [clipOf({ frames: CAMERA_TRACKER_LOAD_LIMITS.frameCount + 1 })] }),
		});
		expect(await current.engine.trackCamera({ elementId: "clip" })).toEqual({
			status: "failed",
			elementId: "clip",
			message: CAMERA_TRACKER_MESSAGES.tooLong,
		});
		expect(current.decodeCalls).toHaveLength(0);
	});

	test("an analysis over the sample limit is refused after it, writes nothing and does not solve", async () => {
		const original = CAMERA_TRACKER_LOAD_LIMITS.samples;
		current = engineHarness();
		const before = current.editor.state.tracks;
		try {
			// the real tracker finds a few samples; one allowed sample is enough to be over
			Reflect.set(CAMERA_TRACKER_LOAD_LIMITS, "samples", 1);
			const outcome = await current.engine.trackCamera({ elementId: "clip" });
			expect(outcome).toEqual({ status: "failed", elementId: "clip", message: CAMERA_TRACKER_MESSAGES.tooLarge });
		} finally {
			Reflect.set(CAMERA_TRACKER_LOAD_LIMITS, "samples", original);
		}
		expect(current.solveCalls).toHaveLength(0);
		expect(current.editor.state.tracks).toBe(before);
		expect(current.editor.editor.command.canUndo()).toBe(false);
	});
});
