import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	BufferTarget,
	MkvOutputFormat,
	Output,
	TextSubtitleSource,
} from "mediabunny";
import {
	EXPORT_CHANNELS,
	EXPORT_SAMPLE_RATE,
	createTimelineAudioBuffer,
	timelineHasAudio,
} from "@/media/audio";
import {
	FakeAudioContext,
	ONE_SECOND,
	audioAsset,
	libraryAudio,
	toneBuffer,
	tracksWith,
	uploadAudio,
	videoAsset,
	videoClip,
} from "./audio-fixtures";

// createTimelineAudioBuffer must tell its caller which audio it could not read
// (the export then stops) instead of leaving those clips silent without a word.
// Web Audio is faked; mediabunny's Input is the real one, reading real bytes.

const originalFetch = globalThis.fetch;
function stubFetch(respond: (url: string) => Promise<Response>) {
	globalThis.fetch = Object.assign(async (input: string | URL | Request) => respond(String(input)), {
		preconnect: () => {},
	});
}

beforeEach(() => {
	FakeAudioContext.decode = async () => {
		throw new Error("decode not configured");
	};
	Reflect.set(globalThis, "window", { AudioContext: FakeAudioContext });
});
afterEach(() => {
	Reflect.set(globalThis, "window", undefined);
	globalThis.fetch = originalFetch;
});

const DURATION = ONE_SECOND * 2;

describe("export audio format", () => {
	test("the mix is 44.1 kHz stereo, and the constants the AAC preflight uses are those", async () => {
		expect(EXPORT_SAMPLE_RATE).toBe(44100);
		expect(EXPORT_CHANNELS).toBe(2);
		FakeAudioContext.decode = async () => toneBuffer({ seconds: 1 });

		const { buffer } = await createTimelineAudioBuffer({
			tracks: tracksWith({ audio: [uploadAudio({ id: "a", name: "Song", mediaId: "m" })] }),
			mediaAssets: [audioAsset({ id: "m" })],
			duration: DURATION,
		});

		expect(buffer?.sampleRate).toBe(EXPORT_SAMPLE_RATE);
		expect(buffer?.numberOfChannels).toBe(EXPORT_CHANNELS);
		expect(buffer?.length).toBe(2 * EXPORT_SAMPLE_RATE);
	});
});

describe("createTimelineAudioBuffer: what it could not read", () => {
	test("a timeline without audio clips gives no buffer and nothing skipped", async () => {
		const result = await createTimelineAudioBuffer({ tracks: tracksWith({}), mediaAssets: [], duration: DURATION });

		expect(result).toEqual({ buffer: null, skipped: [] });
	});

	test("clips that all decode are mixed, and nothing is skipped", async () => {
		FakeAudioContext.decode = async () => toneBuffer({ seconds: 1 });

		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({ audio: [uploadAudio({ id: "a", name: "Song", mediaId: "m" })] }),
			mediaAssets: [audioAsset({ id: "m" })],
			duration: DURATION,
		});

		expect(skipped).toEqual([]);
		expect(buffer?.getChannelData(0)[100]).toBeCloseTo(0.25, 5);
		expect(buffer?.getChannelData(0)[EXPORT_SAMPLE_RATE + 100]).toBe(0);
	});

	test("a clip whose audio cannot be decoded is reported with its name and the reason, and is not mixed", async () => {
		FakeAudioContext.decode = async () => {
			throw new Error("Unable to decode audio data");
		};

		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({ audio: [uploadAudio({ id: "a", name: "Broken song", mediaId: "m" })] }),
			mediaAssets: [audioAsset({ id: "m" })],
			duration: DURATION,
		});

		expect(result).toEqual({ buffer: null, skipped: [{ name: "Broken song", reason: "Unable to decode audio data" }] });
	});

	test("when one clip fails and another works, the working one is still mixed and only the failing one is reported", async () => {
		FakeAudioContext.decode = async (data) => {
			if (data.byteLength === 7) throw new Error("bad codec");
			return toneBuffer({ seconds: 1 });
		};

		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				audio: [
					uploadAudio({ id: "good", name: "Good", mediaId: "good-media" }),
					uploadAudio({ id: "bad", name: "Bad", mediaId: "bad-media" }),
				],
			}),
			mediaAssets: [audioAsset({ id: "good-media" }), audioAsset({ id: "bad-media", bytes: 7 })],
			duration: DURATION,
		});

		expect(skipped).toEqual([{ name: "Bad", reason: "bad codec" }]);
		expect(buffer?.getChannelData(0)[10]).toBeCloseTo(0.25, 5);
	});

	test("an upload clip whose media file is not in the project is reported as missing", async () => {
		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({ audio: [uploadAudio({ id: "a", name: "Orphan", mediaId: "gone" })] }),
			mediaAssets: [],
			duration: DURATION,
		});

		expect(result.buffer).toBeNull();
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.name).toBe("Orphan");
		expect(result.skipped[0]?.reason).toContain("missing");
	});

	test("a library clip whose download fails (HTTP error, or no network) is reported with the reason", async () => {
		for (const [respond, expected] of [
			[async () => new Response("nope", { status: 404 }), "404"],
			[
				async () => {
					throw new Error("Failed to fetch");
				},
				"Failed to fetch",
			],
		] as const) {
			stubFetch(respond);

			const result = await createTimelineAudioBuffer({
				tracks: tracksWith({ audio: [libraryAudio({ id: "lib", name: "Library song" })] }),
				mediaAssets: [],
				duration: DURATION,
			});

			expect(result.buffer).toBeNull();
			expect(result.skipped[0]?.name).toBe("Library song");
			expect(result.skipped[0]?.reason).toContain(expected);
		}
	});

	test("a library clip that already holds its decoded buffer needs no download and is mixed", async () => {
		stubFetch(async () => {
			throw new Error("must not be called");
		});

		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({ audio: [libraryAudio({ id: "lib", name: "Cached", buffer: toneBuffer({ seconds: 1, value: 0.5 }) })] }),
			mediaAssets: [],
			duration: DURATION,
		});

		expect(skipped).toEqual([]);
		expect(buffer?.getChannelData(1)[5]).toBeCloseTo(0.5, 5);
	});

	test("a video file that mediabunny cannot read is reported, not silently left out", async () => {
		const file = new File([new Uint8Array(64).fill(3)], "holiday.mp4", { type: "video/mp4" });

		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({ video: [videoClip({ id: "v", name: "Holiday", mediaId: "vm" })] }),
			mediaAssets: [videoAsset({ id: "vm", file })],
			duration: DURATION,
		});

		expect(result.buffer).toBeNull();
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.name).toBe("Holiday");
		expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
	});

	test("a video known to have no audio is not a clip with audio at all: nothing to read, nothing reported", async () => {
		const file = new File([new Uint8Array(64).fill(3)], "silent.mp4", { type: "video/mp4" });
		const tracks = tracksWith({ video: [videoClip({ id: "v", name: "Silent", mediaId: "vm" })] });
		const mediaAssets = [videoAsset({ id: "vm", file, hasAudio: false })];

		const result = await createTimelineAudioBuffer({ tracks, mediaAssets, duration: DURATION });

		expect(result).toEqual({ buffer: null, skipped: [] });
		expect(timelineHasAudio({ tracks, mediaAssets })).toBe(false);
	});
});

describe("createTimelineAudioBuffer: a video file without an audio track", () => {
	let videoWithoutAudio: File;
	beforeAll(async () => {
		// A real Matroska file with a subtitle track and no audio track.
		const target = new BufferTarget();
		const output = new Output({ format: new MkvOutputFormat(), target });
		const subtitles = new TextSubtitleSource("webvtt");
		output.addSubtitleTrack(subtitles);
		await output.start();
		await subtitles.add("WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n");
		subtitles.close();
		await output.finalize();
		if (!target.buffer) throw new Error("no file");
		videoWithoutAudio = new File([target.buffer], "screen.mkv", { type: "video/x-matroska" });
	});

	test("is a silent clip when the asset does not say it has audio (older assets): not an error", async () => {
		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({ video: [videoClip({ id: "v", name: "Screen", mediaId: "vm" })] }),
			mediaAssets: [videoAsset({ id: "vm", file: videoWithoutAudio })],
			duration: DURATION,
		});

		expect(result).toEqual({ buffer: null, skipped: [] });
	});

	test("is reported when the asset was imported as having audio, because the file contradicts it", async () => {
		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({ video: [videoClip({ id: "v", name: "Screen", mediaId: "vm" })] }),
			mediaAssets: [videoAsset({ id: "vm", file: videoWithoutAudio, hasAudio: true })],
			duration: DURATION,
		});

		expect(result.buffer).toBeNull();
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.name).toBe("Screen");
		expect(result.skipped[0]?.reason).toContain("no audio track");
	});
});

describe("createTimelineAudioBuffer: a file whose audio track holds no samples", () => {
	function emptyWav(): File {
		// A valid WAV header (16-bit stereo, 44.1 kHz) that declares 0 bytes of audio.
		const header = new DataView(new ArrayBuffer(44));
		const text = ({ offset, value }: { offset: number; value: string }) => {
			for (let index = 0; index < value.length; index++) header.setUint8(offset + index, value.charCodeAt(index));
		};
		text({ offset: 0, value: "RIFF" });
		header.setUint32(4, 36, true);
		text({ offset: 8, value: "WAVE" });
		text({ offset: 12, value: "fmt " });
		header.setUint32(16, 16, true);
		header.setUint16(20, 1, true);
		header.setUint16(22, 2, true);
		header.setUint32(24, 44100, true);
		header.setUint32(28, 44100 * 4, true);
		header.setUint16(32, 4, true);
		header.setUint16(34, 16, true);
		text({ offset: 36, value: "data" });
		header.setUint32(40, 0, true);
		return new File([header.buffer], "empty.wav", { type: "video/mp4" });
	}

	test("is reported: the file claims audio, and none can be read from it", async () => {
		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({ video: [videoClip({ id: "v", name: "Empty audio", mediaId: "vm" })] }),
			mediaAssets: [videoAsset({ id: "vm", file: emptyWav() })],
			duration: DURATION,
		});

		expect(result.buffer).toBeNull();
		expect(result.skipped).toEqual([{ name: "Empty audio", reason: "the audio track has no samples" }]);
	});
});
