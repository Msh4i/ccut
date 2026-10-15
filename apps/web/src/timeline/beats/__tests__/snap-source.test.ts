import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { getBeatSnapPoints } from "@/timeline/beats/snap-source";
import { resolveTimelineSnap } from "@/timeline/snapping";
import { mediaTime, type MediaTime } from "@/wasm";

const SECOND = 120000;

function ticks(values: number[]): MediaTime[] {
	return values.map((ticks) => mediaTime({ ticks }));
}

function buildAudio(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "audio-1",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		name: "Song",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 10 * SECOND }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		...overrides,
	};
}

function buildVideo(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		mediaId: "media-2",
		name: "Clip",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 10 * SECOND }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
		...overrides,
	};
}

function buildTracks({
	main = [],
	audio = [],
}: {
	main?: VideoElement[];
	audio?: UploadAudioElement[];
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
		id: "audio-track",
		name: "Audio",
		type: "audio",
		elements: audio,
		muted: false,
	};
	return { overlay: [], main: mainTrack, audio: [audioTrack] };
}

describe("getBeatSnapPoints", () => {
	test("returns no points when nothing was analysed", () => {
		const tracks = buildTracks({ main: [buildVideo()], audio: [buildAudio()] });
		expect(getBeatSnapPoints({ tracks })).toEqual([]);
	});

	test("emits one beat point per visible beat, at timeline time", () => {
		const tracks = buildTracks({
			audio: [
				buildAudio({
					startTime: mediaTime({ ticks: 4 * SECOND }),
					beats: ticks([0, SECOND, 2 * SECOND]),
				}),
			],
		});
		expect(getBeatSnapPoints({ tracks })).toEqual([
			...ticks([4 * SECOND, 5 * SECOND, 6 * SECOND]).map((time) => ({
				time,
				type: "beat" as const,
				elementId: "audio-1",
				trackId: "audio-track",
			})),
		]);
	});

	test("only snaps to beats inside the visible window", () => {
		const tracks = buildTracks({
			main: [
				buildVideo({
					trimStart: mediaTime({ ticks: 2 * SECOND }),
					duration: mediaTime({ ticks: 2 * SECOND }),
					beats: ticks([SECOND, 2 * SECOND, 3 * SECOND, 4 * SECOND]),
				}),
			],
		});
		expect(getBeatSnapPoints({ tracks }).map((point) => point.time)).toEqual(
			ticks([0, SECOND]),
		);
	});

	test("collects beats from every track", () => {
		const tracks = buildTracks({
			main: [buildVideo({ beats: ticks([SECOND]) })],
			audio: [buildAudio({ beats: ticks([2 * SECOND]) })],
		});
		const points = getBeatSnapPoints({ tracks });
		expect(points.map((point) => [point.elementId, point.time])).toEqual([
			["video-1", mediaTime({ ticks: SECOND })],
			["audio-1", mediaTime({ ticks: 2 * SECOND })],
		]);
	});

	test("skips excluded elements", () => {
		const tracks = buildTracks({
			main: [buildVideo({ beats: ticks([SECOND]) })],
			audio: [buildAudio({ beats: ticks([2 * SECOND]) })],
		});
		const points = getBeatSnapPoints({
			tracks,
			excludeElementIds: new Set(["video-1"]),
		});
		expect(points.map((point) => point.elementId)).toEqual(["audio-1"]);
	});

	test("an edited clip is not served from a stale cache", () => {
		const element = buildAudio({ beats: ticks([0, SECOND, 2 * SECOND]) });
		const before = getBeatSnapPoints({ tracks: buildTracks({ audio: [element] }) });
		expect(before.map((point) => point.time)).toEqual(
			ticks([0, SECOND, 2 * SECOND]),
		);

		const moved = { ...element, startTime: mediaTime({ ticks: 5 * SECOND }) };
		const after = getBeatSnapPoints({ tracks: buildTracks({ audio: [moved] }) });
		expect(after.map((point) => point.time)).toEqual(
			ticks([5 * SECOND, 6 * SECOND, 7 * SECOND]),
		);
	});

	test("the same clip on another track reports that track, not the cached one", () => {
		const element = buildVideo({ beats: ticks([SECOND]) });
		const onMain = buildTracks({ main: [element] });
		const onOverlay: SceneTracks = {
			...buildTracks({}),
			overlay: [{ ...onMain.main, id: "overlay-1", elements: [element] }],
		};
		expect(getBeatSnapPoints({ tracks: onMain })[0].trackId).toBe("main");
		expect(getBeatSnapPoints({ tracks: onOverlay })[0].trackId).toBe("overlay-1");
		expect(getBeatSnapPoints({ tracks: onMain })[0].trackId).toBe("main");
	});

	test("stored garbage in beats never throws", () => {
		const element = buildAudio();
		Reflect.set(element, "beats", [Number.NaN, "x", SECOND, -1]);
		const points = getBeatSnapPoints({ tracks: buildTracks({ audio: [element] }) });
		expect(points.map((point) => point.time)).toEqual(ticks([SECOND]));
	});

	test("feeds resolveTimelineSnap: nearest beat inside the threshold wins", () => {
		const tracks = buildTracks({
			audio: [buildAudio({ beats: ticks([SECOND, 2 * SECOND, 3 * SECOND]) })],
		});
		const snapPoints = getBeatSnapPoints({ tracks });

		const near = resolveTimelineSnap({
			targetTime: mediaTime({ ticks: 2 * SECOND + 300 }),
			snapPoints,
			maxSnapDistance: 500,
		});
		expect(near.snappedTime).toBe(mediaTime({ ticks: 2 * SECOND }));
		expect(near.snapPoint?.type).toBe("beat");

		const far = resolveTimelineSnap({
			targetTime: mediaTime({ ticks: 2 * SECOND + 600 }),
			snapPoints,
			maxSnapDistance: 500,
		});
		expect(far.snapPoint).toBeNull();
		expect(far.snappedTime).toBe(mediaTime({ ticks: 2 * SECOND + 600 }));
	});
});
