import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import {
	MAX_BEATS_PER_CLIP,
	normalizeBeats,
	normalizeSceneTracksBeats,
} from "@/timeline/beats/normalize";
import { mediaTime, type MediaTime } from "@/wasm";

function ticks(values: number[]): MediaTime[] {
	return values.map((ticks) => mediaTime({ ticks }));
}

describe("normalizeBeats", () => {
	test("returns a valid ascending array untouched (same reference)", () => {
		const beats = ticks([0, 10, 25, 1000]);
		expect(normalizeBeats({ raw: beats })).toBe(beats);
	});

	test("sorts, drops duplicates and keeps whole non-negative ticks", () => {
		expect(normalizeBeats({ raw: [30, 10, 10, 20, 0] })).toEqual(
			ticks([0, 10, 20, 30]),
		);
	});

	test("drops NaN, Infinity, floats, negatives, strings and other junk", () => {
		const raw = [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -4, "7", null, {}, 9, 2 ** 60];
		expect(normalizeBeats({ raw })).toEqual(ticks([9]));
	});

	test("drops holes in a sparse array", () => {
		const raw: number[] = [5];
		raw[2] = 8;
		expect(normalizeBeats({ raw })).toEqual(ticks([5, 8]));
	});

	test("anything that is not an array has no beats", () => {
		for (const raw of ["abc", 5, {}, null, undefined, { length: 3, 0: 1 }]) {
			expect(normalizeBeats({ raw })).toBeUndefined();
		}
	});

	test("an array with nothing usable has no beats, so the clip reads as not analysed", () => {
		expect(normalizeBeats({ raw: [] })).toBeUndefined();
		expect(normalizeBeats({ raw: [Number.NaN, "x"] })).toBeUndefined();
	});

	test("keeps only the first MAX_BEATS_PER_CLIP beats of an oversized list", () => {
		const raw = Array.from({ length: MAX_BEATS_PER_CLIP + 500 }, (_, i) => i * 3);
		const beats = normalizeBeats({ raw });
		expect(beats?.length).toBe(MAX_BEATS_PER_CLIP);
		expect(beats?.[0]).toBe(mediaTime({ ticks: 0 }));
		expect(beats?.[MAX_BEATS_PER_CLIP - 1]).toBe(
			mediaTime({ ticks: (MAX_BEATS_PER_CLIP - 1) * 3 }),
		);
	});

	test("rejects an absurdly long array without iterating it", () => {
		const raw: number[] = [];
		raw.length = 2 ** 31;
		const start = performance.now();
		expect(normalizeBeats({ raw })).toBeUndefined();
		expect(performance.now() - start).toBeLessThan(50);
	});
});

// Stored projects can hold any value in `beats`, so it is written untyped.
function audio(beats: unknown): UploadAudioElement {
	const element: UploadAudioElement = {
		id: "a1",
		type: "audio",
		sourceType: "upload",
		mediaId: "m1",
		name: "Song",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
	if (beats !== undefined) Reflect.set(element, "beats", beats);
	return element;
}

function video(beats: unknown): VideoElement {
	const element: VideoElement = {
		id: "v1",
		type: "video",
		mediaId: "m2",
		name: "Clip",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 100 }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
	if (beats !== undefined) Reflect.set(element, "beats", beats);
	return element;
}

function sceneTracks({
	main,
	audioElements,
}: {
	main: VideoElement[];
	audioElements: UploadAudioElement[];
}): SceneTracks {
	const mainTrack: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		elements: main,
		muted: false,
		hidden: false,
	};
	const audioTrack: AudioTrack = {
		id: "audio",
		name: "Audio",
		type: "audio",
		elements: audioElements,
		muted: false,
	};
	return { overlay: [], main: mainTrack, audio: [audioTrack] };
}

describe("normalizeSceneTracksBeats", () => {
	test("returns the very same tracks object when every beat list is valid", () => {
		const tracks = sceneTracks({
			main: [video(ticks([1, 2])), video(undefined)],
			audioElements: [audio(ticks([5]))],
		});
		expect(normalizeSceneTracksBeats({ tracks })).toBe(tracks);
	});

	test("repairs corrupt beat lists on audio and video clips", () => {
		const tracks = sceneTracks({
			main: [video([9, Number.NaN, 3])],
			audioElements: [audio("not an array")],
		});
		const fixed = normalizeSceneTracksBeats({ tracks });
		expect(fixed.main.elements[0]).toMatchObject({ beats: ticks([3, 9]) });
		expect(fixed.audio[0].elements[0].beats).toBeUndefined();
	});

	test("leaves untouched clips and tracks as they were", () => {
		const good = video(ticks([1, 2]));
		const tracks = sceneTracks({
			main: [good, video([Number.NaN, 4])],
			audioElements: [audio(ticks([5]))],
		});
		const fixed = normalizeSceneTracksBeats({ tracks });
		expect(fixed.main.elements[0]).toBe(good);
		expect(fixed.audio).toBe(tracks.audio);
		expect(fixed.audio[0]).toBe(tracks.audio[0]);
	});

	test("hands back structurally broken tracks as they are instead of throwing", () => {
		// Straight from storage, so it can be any shape.
		for (const json of [
			"{}",
			'{"overlay":[],"audio":[]}',
			'{"overlay":[],"main":{},"audio":[]}',
			'{"overlay":"x","main":{"elements":[]},"audio":[]}',
			'{"overlay":[],"main":{"elements":[]},"audio":[null]}',
			'{"overlay":[{"type":"video"}],"main":{"elements":[]},"audio":[]}',
		]) {
			const tracks = JSON.parse(json);
			expect(normalizeSceneTracksBeats({ tracks })).toBe(tracks);
		}
	});

	test("skips a null element in an otherwise normal track", () => {
		const tracks = JSON.parse(
			'{"overlay":[],"main":{"elements":[null]},"audio":[]}',
		);
		expect(normalizeSceneTracksBeats({ tracks })).toBe(tracks);
	});

	test("does not mutate its input", () => {
		const tracks = sceneTracks({
			main: [video([9, 3])],
			audioElements: [],
		});
		const before = JSON.stringify(tracks);
		normalizeSceneTracksBeats({ tracks });
		expect(JSON.stringify(tracks)).toBe(before);
	});
});
