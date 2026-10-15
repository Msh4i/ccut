import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeAudioBuffer } from "@/export/__tests__/fake-audio-buffer";
import { EXPORT_SAMPLE_RATE, createTimelineAudioBuffer } from "@/media/audio";
import {
	FakeAudioContext,
	FakeOfflineAudioContext,
	ONE_SECOND,
	audioAsset,
	libraryAudio,
	pcmFile,
	toneBuffer,
	tracksWith,
	uploadAudio,
	videoAsset,
	videoClip,
} from "./audio-fixtures";

// How often the export decodes a file's audio. Clips cut from one file must
// share one decode: a decode per clip, all alive at once, took the renderer of
// the owner's 75-clip project past its memory limit (round 5e/6). Web Audio is
// faked; mediabunny reads real PCM bytes.

const originalFetch = globalThis.fetch;
const originalOfflineAudioContext = Reflect.get(globalThis, "OfflineAudioContext");
const originalAudioBuffer = Reflect.get(globalThis, "AudioBuffer");
let decodes = 0;

beforeEach(() => {
	decodes = 0;
	FakeOfflineAudioContext.created = 0;
	FakeOfflineAudioContext.events = [];
	FakeAudioContext.decode = async () => {
		decodes += 1;
		// Quiet, so that clips stacked at one time stay under the master limiter.
		return toneBuffer({ seconds: 1, value: 0.1 });
	};
	Reflect.set(globalThis, "window", { AudioContext: FakeAudioContext });
	Reflect.set(globalThis, "OfflineAudioContext", FakeOfflineAudioContext);
	Reflect.set(globalThis, "AudioBuffer", FakeAudioBuffer);
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	Reflect.set(globalThis, "window", undefined);
	Reflect.set(globalThis, "OfflineAudioContext", originalOfflineAudioContext);
	Reflect.set(globalThis, "AudioBuffer", originalAudioBuffer);
});

const DURATION = ONE_SECOND * 4;

describe("clips of one file share one decode", () => {
	test("three audio clips of one audio file decode it once", async () => {
		const { skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				audio: [
					uploadAudio({ id: "a1", name: "Cut 1", mediaId: "m" }),
					uploadAudio({ id: "a2", name: "Cut 2", mediaId: "m" }),
					uploadAudio({ id: "a3", name: "Cut 3", mediaId: "m" }),
				],
			}),
			mediaAssets: [audioAsset({ id: "m" })],
			duration: DURATION,
		});

		expect(skipped).toEqual([]);
		expect(decodes).toBe(1);
	});

	test("three video clips of one video file decode its audio once", async () => {
		const file = pcmFile({ frames: 44100, channels: 2, value: ({ frame }) => frame % 100 });

		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				video: [
					videoClip({ id: "v1", name: "Cut 1", mediaId: "vm" }),
					videoClip({ id: "v2", name: "Cut 2", mediaId: "vm", startTicks: ONE_SECOND }),
					videoClip({ id: "v3", name: "Cut 3", mediaId: "vm", startTicks: 2 * ONE_SECOND }),
				],
			}),
			mediaAssets: [videoAsset({ id: "vm", file })],
			duration: DURATION,
		});

		expect(skipped).toEqual([]);
		expect(buffer).not.toBeNull();
		expect(FakeOfflineAudioContext.created).toBe(1);
	});

	test("two video clips of one unreadable file are both reported", async () => {
		const file = new File([new Uint8Array(64).fill(3)], "broken.mp4", { type: "video/mp4" });

		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({
				video: [
					videoClip({ id: "v1", name: "Broken 1", mediaId: "vm" }),
					videoClip({ id: "v2", name: "Broken 2", mediaId: "vm", startTicks: ONE_SECOND }),
				],
			}),
			mediaAssets: [videoAsset({ id: "vm", file })],
			duration: DURATION,
		});

		expect(result.buffer).toBeNull();
		expect(result.skipped.map(({ name }) => name)).toEqual(["Broken 1", "Broken 2"]);
		expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
		expect(result.skipped[1]?.reason).toBe(result.skipped[0]?.reason);
	});
});

describe("library clips of one sound share one download and decode", () => {
	// After a reload a library clip has no decoded buffer (it is not saved), so
	// the export fetches and decodes its sound.
	let fetches: string[] = [];
	beforeEach(() => {
		fetches = [];
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request) => {
				fetches.push(String(input));
				return new Response(new Uint8Array(32));
			},
			{ preconnect: () => {} },
		);
	});

	test("three clips of one sound fetch and decode it once; another sound is fetched on its own", async () => {
		const song = "https://example.test/song.mp3";
		const other = "https://example.test/other.mp3";

		const { skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				audio: [
					libraryAudio({ id: "l1", name: "Song 1", sourceUrl: song }),
					libraryAudio({ id: "l2", name: "Song 2", sourceUrl: song }),
					libraryAudio({ id: "l3", name: "Song 3", sourceUrl: song }),
					libraryAudio({ id: "l4", name: "Other", sourceUrl: other }),
				],
			}),
			mediaAssets: [],
			duration: DURATION,
		});

		expect(skipped).toEqual([]);
		expect(fetches).toEqual([song, other]);
		expect(decodes).toBe(2);
	});

	test("every clip of a sound that cannot be downloaded is reported", async () => {
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request) => {
				fetches.push(String(input));
				return new Response("gone", { status: 404 });
			},
			{ preconnect: () => {} },
		);
		const song = "https://example.test/song.mp3";

		const result = await createTimelineAudioBuffer({
			tracks: tracksWith({
				audio: [
					libraryAudio({ id: "l1", name: "Song 1", sourceUrl: song }),
					libraryAudio({ id: "l2", name: "Song 2", sourceUrl: song }),
				],
			}),
			mediaAssets: [],
			duration: DURATION,
		});

		expect(result.buffer).toBeNull();
		expect(fetches).toEqual([song]);
		expect(result.skipped.map(({ name }) => name)).toEqual(["Song 1", "Song 2"]);
		expect(result.skipped[1]?.reason).toContain("404");
	});
});

describe("files are decoded one after another", () => {
	test("three different audio files: a decode starts only when the one before it has ended", async () => {
		const log: string[] = [];
		FakeAudioContext.decode = async (data) => {
			log.push(`start ${data.byteLength}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			log.push(`end ${data.byteLength}`);
			return toneBuffer({ seconds: 1, value: 0.1 });
		};

		const { skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				audio: [
					uploadAudio({ id: "a1", name: "One", mediaId: "m1" }),
					uploadAudio({ id: "a2", name: "Two", mediaId: "m2" }),
					uploadAudio({ id: "a3", name: "Three", mediaId: "m3" }),
				],
			}),
			mediaAssets: [audioAsset({ id: "m1", bytes: 11 }), audioAsset({ id: "m2", bytes: 12 }), audioAsset({ id: "m3", bytes: 13 })],
			duration: DURATION,
		});

		expect(skipped).toEqual([]);
		expect(log).toEqual(["start 11", "end 11", "start 12", "end 12", "start 13", "end 13"]);
	});

	test("a video's audio is decoded to its end before the next file's decode starts", async () => {
		FakeAudioContext.decode = async () => {
			FakeOfflineAudioContext.events.push("audio-decode");
			return toneBuffer({ seconds: 1, value: 0.1 });
		};
		const file = pcmFile({ frames: 44100, channels: 2, value: ({ frame }) => frame % 100 });

		await createTimelineAudioBuffer({
			tracks: tracksWith({
				video: [videoClip({ id: "v", name: "Video", mediaId: "vm" })],
				audio: [uploadAudio({ id: "a", name: "Song", mediaId: "m" })],
			}),
			mediaAssets: [videoAsset({ id: "vm", file }), audioAsset({ id: "m" })],
			duration: DURATION,
		});

		expect(FakeOfflineAudioContext.events).toEqual(["render-start", "render-end", "audio-decode"]);
	});

	test("a file that fails does not stop the files after it", async () => {
		FakeAudioContext.decode = async (data) => {
			if (data.byteLength === 7) throw new Error("bad codec");
			return toneBuffer({ seconds: 1, value: 0.1 });
		};

		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				audio: [
					uploadAudio({ id: "bad", name: "Bad", mediaId: "bad-media" }),
					uploadAudio({ id: "good", name: "Good", mediaId: "good-media" }),
				],
			}),
			mediaAssets: [audioAsset({ id: "bad-media", bytes: 7 }), audioAsset({ id: "good-media" })],
			duration: DURATION,
		});

		expect(skipped).toEqual([{ name: "Bad", reason: "bad codec" }]);
		expect(buffer?.getChannelData(0)[10]).toBeCloseTo(0.1, 6);
	});
});

describe("the mix of a video's audio is sample for sample its file", () => {
	// 3 s of 3-channel 16-bit PCM: mediabunny hands it over in 65 chunks, and the
	// export keeps the first two channels. Every frame has its own value.
	const FRAMES = 3 * 44100 + 7;
	const sample = ({ channel, frame }: { channel: number; frame: number }) =>
		((frame * 7 + channel * 3001) % 20000) - 10000;
	const file = pcmFile({ frames: FRAMES, channels: 3, value: sample });

	test("two clips of one file, each trimmed, hold exactly the file's samples at their place", async () => {
		const { buffer, skipped } = await createTimelineAudioBuffer({
			tracks: tracksWith({
				video: [
					videoClip({ id: "v1", name: "Cut 1", mediaId: "vm", trimStartTicks: ONE_SECOND / 2 }),
					videoClip({ id: "v2", name: "Cut 2", mediaId: "vm", startTicks: ONE_SECOND, trimStartTicks: 2 * ONE_SECOND - 1200 }),
				],
			}),
			mediaAssets: [videoAsset({ id: "vm", file })],
			duration: 2 * ONE_SECOND,
		});

		expect(skipped).toEqual([]);
		if (!buffer) throw new Error("no mix");
		expect(buffer.length).toBe(2 * EXPORT_SAMPLE_RATE);
		let worst = 0;
		let compared = 0;
		for (let channel = 0; channel < 2; channel++) {
			const mixed = buffer.getChannelData(channel);
			for (let index = 0; index < buffer.length; index++) {
				// Clip 1 starts its source at 0.5 s; clip 2 at 1.99 s and runs out of
				// source after 1.01 s (the file is 3 s): silence after that.
				const inClipOne = index < EXPORT_SAMPLE_RATE;
				const sourceFrame = inClipOne ? index + EXPORT_SAMPLE_RATE / 2 : index - EXPORT_SAMPLE_RATE + 2 * EXPORT_SAMPLE_RATE - 441;
				const expected = sourceFrame < FRAMES ? sample({ channel, frame: sourceFrame }) / 32768 : 0;
				worst = Math.max(worst, Math.abs(mixed[index] - expected));
				compared += 1;
			}
		}
		expect(compared).toBe(4 * EXPORT_SAMPLE_RATE);
		// One step of 16-bit audio is 3e-5: a frame or channel off by one is far above this.
		expect(worst).toBeLessThan(1e-6);
	});

	test("a mono file is heard the same on both channels", async () => {
		const mono = pcmFile({ frames: 44100, channels: 1, value: ({ frame }) => (frame % 500) - 250 });

		const { buffer } = await createTimelineAudioBuffer({
			tracks: tracksWith({ video: [videoClip({ id: "v", name: "Mono", mediaId: "vm" })] }),
			mediaAssets: [videoAsset({ id: "vm", file: mono })],
			duration: ONE_SECOND,
		});

		if (!buffer) throw new Error("no mix");
		for (const index of [0, 1, 499, 12345, 44099]) {
			const expected = ((index % 500) - 250) / 32768;
			expect(buffer.getChannelData(0)[index]).toBeCloseTo(expected, 6);
			expect(buffer.getChannelData(1)[index]).toBeCloseTo(expected, 6);
		}
	});
});
