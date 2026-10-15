import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { VideoElement } from "@/timeline";
import { mediaTime } from "@/wasm";

// The production video path reads through mediabunny, which needs real media
// and WebCodecs. These tests swap it for a fake Input/AudioBufferSink.

type FakeChunk = Pick<
	AudioBuffer,
	"numberOfChannels" | "length" | "sampleRate" | "getChannelData"
>;

const calls = {
	inputs: [] as FakeInput[],
	disposed: 0,
	bufferCalls: [] as Array<[number | undefined, number | undefined]>,
	generatorsClosed: 0,
	pulled: 0,
};
const scenario: {
	track: object | null;
	chunks: () => Iterable<FakeChunk>;
	failOnBuffers: boolean;
} = { track: {}, chunks: () => [], failOnBuffers: false };

class FakeBlobSource {
	constructor(readonly file: File) {}
}

class FakeInput {
	constructor(readonly options: { source: FakeBlobSource; formats: unknown }) {
		calls.inputs.push(this);
	}
	async getPrimaryAudioTrack() {
		return scenario.track;
	}
	dispose() {
		calls.disposed++;
	}
}

class FakeAudioBufferSink {
	constructor(readonly track: object) {}
	// eslint-disable-next-line opencut/prefer-object-params -- mirrors mediabunny's signature
	async *buffers(startTimestamp?: number, endTimestamp?: number) {
		calls.bufferCalls.push([startTimestamp, endTimestamp]);
		if (scenario.failOnBuffers) throw new Error("decoder blew up");
		try {
			for (const chunk of scenario.chunks()) {
				calls.pulled++;
				yield { buffer: chunk, timestamp: 0, duration: 0 };
			}
		} finally {
			calls.generatorsClosed++;
		}
	}
}

// Copied by value: bun patches the module namespace in place when it is mocked, so
// the namespace object itself would hand the fakes back in afterAll and leak them
// into every test file that runs later.
const actual = { ...(await import("mediabunny")) };
mock.module("mediabunny", () => ({
	...actual,
	Input: FakeInput,
	BlobSource: FakeBlobSource,
	AudioBufferSink: FakeAudioBufferSink,
}));
const { BEAT_MAX_DURATION_SECONDS, decodeElementForBeats } = await import(
	"@/media/beat-audio"
);

afterAll(() => {
	mock.module("mediabunny", () => actual);
});

beforeEach(() => {
	calls.inputs = [];
	calls.disposed = 0;
	calls.bufferCalls = [];
	calls.generatorsClosed = 0;
	calls.pulled = 0;
	scenario.track = {};
	scenario.chunks = () => [];
	scenario.failOnBuffers = false;
});

const SOURCE_RATE = 8000;

function oneSecond(): FakeChunk {
	const channel = new Float32Array(SOURCE_RATE);
	return {
		numberOfChannels: 1,
		length: SOURCE_RATE,
		sampleRate: SOURCE_RATE,
		getChannelData: () => channel,
	};
}

function* endless(): Generator<FakeChunk> {
	for (;;) yield oneSecond();
}

function* seconds(count: number): Generator<FakeChunk> {
	for (let i = 0; i < count; i++) yield oneSecond();
}

const element: VideoElement = {
	id: "video-1",
	type: "video",
	mediaId: "media-1",
	name: "Clip",
	startTime: mediaTime({ ticks: 0 }),
	duration: mediaTime({ ticks: 120000 }),
	trimStart: mediaTime({ ticks: 0 }),
	trimEnd: mediaTime({ ticks: 0 }),
	params: {},
};

function videoAsset(): MediaAsset {
	return {
		id: "media-1",
		name: "clip.mp4",
		type: "video",
		file: new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" }),
	};
}

describe("decodeElementForBeats: video files (streamed through mediabunny)", () => {
	test("reads the audio track from the start up to one second past the cap", async () => {
		scenario.chunks = () => seconds(3);
		await decodeElementForBeats({ element, mediaAsset: videoAsset() });
		expect(calls.bufferCalls).toEqual([[0, BEAT_MAX_DURATION_SECONDS + 1]]);
		expect(BEAT_MAX_DURATION_SECONDS + 1).toBe(1801);
	});

	test("decodes the streamed audio to mono and releases the input", async () => {
		scenario.chunks = () => seconds(3);
		const mediaAsset = videoAsset();
		const result = await decodeElementForBeats({ element, mediaAsset });

		if (!result.ok) throw new Error(result.reason);
		expect(result.sampleRate).toBe(SOURCE_RATE);
		expect(result.samples.length).toBe(3 * SOURCE_RATE);
		expect(calls.inputs.length).toBe(1);
		expect(calls.inputs[0].options.source.file).toBe(mediaAsset.file);
		expect(calls.disposed).toBe(1);
	});

	test("stops reading and releases the input as soon as the track is too long", async () => {
		scenario.chunks = () => endless();
		const result = await decodeElementForBeats({ element, mediaAsset: videoAsset() });

		expect(result).toEqual({ ok: false, reason: "too-long" });
		// Chunk 1801 is the first one past 30 minutes; nothing after it is read.
		expect(calls.pulled).toBe(BEAT_MAX_DURATION_SECONDS + 1);
		expect(calls.generatorsClosed).toBe(1);
		expect(calls.disposed).toBe(1);
	});

	test("honours the abort signal while streaming, and still releases the input", async () => {
		const controller = new AbortController();
		scenario.chunks = function* () {
			for (let i = 1; ; i++) {
				if (i === 5) controller.abort();
				yield oneSecond();
			}
		};
		await expect(
			decodeElementForBeats({
				element,
				mediaAsset: videoAsset(),
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });

		expect(calls.pulled).toBe(5);
		expect(calls.generatorsClosed).toBe(1);
		expect(calls.disposed).toBe(1);
	});

	test("an already aborted signal never opens the file", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			decodeElementForBeats({
				element,
				mediaAsset: videoAsset(),
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls.inputs).toEqual([]);
	});

	test("a video without an audio track is unreadable and the input is released", async () => {
		scenario.track = null;
		const result = await decodeElementForBeats({ element, mediaAsset: videoAsset() });
		expect(result).toEqual({ ok: false, reason: "unreadable" });
		expect(calls.bufferCalls).toEqual([]);
		expect(calls.disposed).toBe(1);
	});

	test("a decoder failure is unreadable and the input is released", async () => {
		scenario.failOnBuffers = true;
		const result = await decodeElementForBeats({ element, mediaAsset: videoAsset() });
		expect(result).toEqual({ ok: false, reason: "unreadable" });
		expect(calls.disposed).toBe(1);
	});

	test("a video with no audio chunks yields empty samples, not a crash", async () => {
		scenario.chunks = () => [];
		const result = await decodeElementForBeats({ element, mediaAsset: videoAsset() });
		if (!result.ok) throw new Error(result.reason);
		expect(result.samples.length).toBe(0);
		expect(calls.disposed).toBe(1);
	});
});
