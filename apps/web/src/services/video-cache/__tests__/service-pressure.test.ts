import { describe, expect, test } from "bun:test";
import { DECODER_QUEUE_FRAMES, DEFAULT_DECODER_LIMITS, READ_AHEAD_MAX_FRAMES } from "../frame-policy";
import { FrameStream, createFrameCacheCounters } from "../frame-stream";
import { MIN_KEPT_FRAME_BYTES } from "../drawn-frame-cache";
import { BUDGET_FLOOR_BYTES } from "../memory-budget";
import { DEFAULT_STREAM_LIMITS, type MemorySource, VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// What the cache holds under a memory budget: the decoders' own queues are
// counted, pressure gives back read-ahead and idle decoders, and the budget
// bounds the streams of a media.

type FakeVideo = ReturnType<typeof createFakeVideo>;

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const FPS = 30;
const FRAME_BYTES = { decoded: 1920 * 1080 * 1.5, drawn: 1920 * 1080 * 4 };

function createStream({ video }: { video: FakeVideo }) {
	const counters = createFrameCacheCounters();
	const stream = new FrameStream<FakeCanvas>({
		source: video.source,
		counters,
		now: () => 0,
		limits: DEFAULT_DECODER_LIMITS,
	});
	return { stream, counters };
}

function frameIndex(frame: { timestamp: number } | null): number | null {
	return frame ? Math.round(frame.timestamp * FPS) : null;
}

describe("FrameStream: memory it holds and gives back", () => {
	test("a running decoder counts its own queue of decoded frames; none without a decoder", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300, frameBytes: FRAME_BYTES });
		const { stream } = createStream({ video });
		expect(stream.decoderQueueBytes()).toBe(0);
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0 });
		expect(stream.decoderQueueBytes()).toBe(DECODER_QUEUE_FRAMES * FRAME_BYTES.decoded);
		stream.dispose();
		expect(stream.decoderQueueBytes()).toBe(0);
	});

	test("trimming keeps the first read-ahead frames up to the cap, closes the rest once, and returns the decoder", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300, frameBytes: FRAME_BYTES });
		const { stream, counters } = createStream({ video });
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0 });
		await settle();
		expect(stream.readAheadBytes()).toBe(READ_AHEAD_MAX_FRAMES * FRAME_BYTES.decoded);
		stream.trimReadAhead({ keepFrames: 2 });
		expect(stream.readAheadBytes()).toBe(2 * FRAME_BYTES.decoded);
		expect(stream.hasDecoder()).toBe(false);
		expect(stream.decoderQueueBytes()).toBe(0);
		expect(video.log.returned).toBe(1);
		expect(video.openFrames()).toBe(2);
		// The kept frames still answer, without a decoder.
		expect(frameIndex(await stream.frameAt({ time: video.timeOf(12), maxStaleSeconds: 0 }))).toBe(12);
		expect(counters.restarts).toBe(1);
		// Past them a new decoder starts, at the right frame.
		expect(frameIndex(await stream.frameAt({ time: video.timeOf(20), maxStaleSeconds: 0 }))).toBe(20);
		expect(counters.restarts).toBe(2);
		stream.dispose();
		await settle();
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
	});

	test("trimming a stream without a decoder or read-ahead changes nothing", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300, frameBytes: FRAME_BYTES });
		const { stream } = createStream({ video });
		stream.trimReadAhead({ keepFrames: 0 });
		expect(frameIndex(await stream.frameAt({ time: video.timeOf(5), maxStaleSeconds: 0 }))).toBe(5);
	});
});

function createCache({
	video,
	reading,
}: {
	video: FakeVideo;
	reading: { value: unknown };
}) {
	const clock = { now: 0 };
	const memory: MemorySource = {
		readMemory: async () => reading.value,
		mode: () => "balanced",
		deviceMemoryGiB: () => null,
	};
	const cache = new VideoCache<FakeCanvas>({
		openSource: async () => video.source,
		now: () => clock.now,
		memory,
	});
	const file = new File([], "m1");
	const ask = ({ index, key, scale }: { index: number; key: string; scale?: number }) =>
		cache.getFrameAt({
			mediaId: "m1",
			file,
			time: video.timeOf(index),
			streamKey: key,
			...(scale !== undefined && { scale }),
		});
	return { cache, clock, ask };
}

const ROOMY = {
	totalBytes: 15.3 * GiB,
	availableBytes: 6 * GiB,
	swapTotalBytes: 8 * GiB,
	swapFreeBytes: 8 * GiB,
	appBytes: 1.2 * GiB,
};
const PRESSED = { ...ROOMY, availableBytes: 0.5 * GiB };

describe("VideoCache: memory of the decoders", () => {
	test("used bytes count every running decoder's queue; the drawn-frame cache gets that much less", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, clock, ask } = createCache({ video, reading: { value: null } });
		for (let index = 0; index < 120; index++) {
			clock.now += 1000 / FPS;
			await ask({ index, key: "a", scale: 0.25 });
			await settle();
		}
		const stats = cache.getMemoryStats();
		const queue = DECODER_QUEUE_FRAMES * FRAME_BYTES.decoded;
		expect(stats.decoderQueueBytes).toBe(queue);
		expect(stats.usedBytes).toBeGreaterThanOrEqual(queue + stats.readAheadBytes);
		// The drawn-frame cache got the budget minus that queue (its frames are
		// charged at least MIN_KEPT_FRAME_BYTES, more than these 0.5 MB tiles hold).
		expect(stats.lruBytes).toBeLessThanOrEqual(stats.budgetBytes - queue);
		expect(stats.usedBytes).toBeLessThanOrEqual(stats.budgetBytes);
	});

	test("pressure trims the read-ahead of idle streams and returns their decoders; the next request past the kept frames restarts at the right frame", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900, frameBytes: FRAME_BYTES });
		const reading = { value: ROOMY as unknown };
		const { cache, clock, ask } = createCache({ video, reading });
		await cache.tickMemory();
		for (let index = 0; index < 30; index++) {
			clock.now += 1000 / FPS;
			await Promise.all([
				ask({ index, key: "a", scale: 0.25 }),
				ask({ index: 300 + index, key: "b", scale: 0.25 }),
			]);
			await settle();
		}
		expect(cache.getStats().decoders).toBe(2);
		const before = cache.getMemoryStats();
		reading.value = PRESSED;
		await cache.tickMemory();
		const after = cache.getMemoryStats();
		expect(after.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(cache.getStats().decoders).toBe(0);
		expect(after.decoderQueueBytes).toBe(0);
		expect(after.readAheadBytes).toBeLessThan(before.readAheadBytes);
		expect(after.usedBytes).toBeLessThanOrEqual(BUDGET_FLOOR_BYTES);
		const restarts = cache.getCounters().restarts;
		clock.now += 1000 / FPS;
		expect(frameIndex(await ask({ index: 45, key: "a", scale: 0.25 }))).toBe(45);
		expect(cache.getCounters().restarts).toBe(restarts + 1);
		expect(video.log.doubleClosed).toBe(0);
	});

	test("at the budget's floor a media keeps the streams that fit (two at 1/4 size): idle ones over that go, a third clip borrows", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900, frameBytes: FRAME_BYTES });
		const reading = { value: ROOMY as unknown };
		const { cache, clock, ask } = createCache({ video, reading });
		await cache.tickMemory();
		const draw = (step: number) =>
			Promise.all([
				ask({ index: 10 + step, key: "a", scale: 0.25 }),
				ask({ index: 300 + step, key: "b", scale: 0.25 }),
				ask({ index: 600 + step, key: "c", scale: 0.25 }),
			]);
		for (let step = 0; step < 3; step++) {
			clock.now += 1000 / FPS;
			await draw(step);
			await settle();
		}
		expect(cache.getStats().streams).toBe(3);
		reading.value = PRESSED;
		await cache.tickMemory();
		expect(cache.getStats().streams).toBe(2);
		for (let step = 3; step < 8; step++) {
			clock.now += 1000 / FPS;
			const answers = await draw(step);
			expect(answers.map(frameIndex)).toEqual([10 + step, 300 + step, 600 + step]);
			expect(cache.getStats().streams).toBe(2);
			await settle();
		}
		expect(cache.getCounters().borrows).toBeGreaterThan(0);
	});

	test("a busy stream is not disposed by pressure; it goes once idle", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900, frameBytes: FRAME_BYTES, decode: "manual" });
		const reading = { value: ROOMY as unknown };
		const { cache, ask } = createCache({ video, reading });
		await cache.tickMemory();
		// Exactly the first frame and a full read-ahead of 8 for each clip.
		video.release(18);
		// Full size: at the floor the file keeps one stream. "b" opens the first
		// stream: on a tie of last use it is the one to release.
		await Promise.all([ask({ index: 300, key: "b" }), ask({ index: 10, key: "a" })]);
		await settle();
		const pending = ask({ index: 320, key: "b" });
		await settle();
		reading.value = PRESSED;
		await cache.tickMemory();
		expect(cache.getStats().streams).toBe(1);
		video.release(1000);
		expect(frameIndex(await pending)).toBe(320);
	});
});

describe("VideoCache: two clips of one file at the budget's floor", () => {
	test("at preview size each keeps its own stream when both fit: no decoder start per draw", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900, frameBytes: FRAME_BYTES });
		const reading = { value: PRESSED as unknown };
		const { cache, clock, ask } = createCache({ video, reading });
		await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		for (let step = 0; step < 30; step++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all([
				ask({ index: 300 + step, key: "a", scale: 0.25 }),
				ask({ index: 351 + step, key: "b", scale: 0.25 }),
			]);
			expect(answers.map(frameIndex)).toEqual([300 + step, 351 + step]);
			await settle();
		}
		expect(cache.getStats().streams).toBe(2);
		// The first draw: the second stream opens once the first frames show their size.
		expect(cache.getCounters().restarts).toBeLessThanOrEqual(4);
		expect(cache.getMemoryStats().usedBytes).toBeLessThanOrEqual(BUDGET_FLOOR_BYTES);
	});
});

describe("VideoCache: stream limits", () => {
	test("8 streams per media and 12 in all by default (owner decision), the budget's cap below that", () => {
		expect(DEFAULT_STREAM_LIMITS).toMatchObject({ maxPerMedia: 8, maxTotal: 12 });
	});

	test("at the owner's 3 GB budget six clips of one file at preview size each keep their own stream", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 3000, frameBytes: FRAME_BYTES });
		const reading = { value: ROOMY as unknown };
		const { cache, clock, ask } = createCache({ video, reading });
		for (let tick = 0; tick < 26; tick++) await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBe(3 * GiB);
		for (let step = 0; step < 20; step++) {
			clock.now += 1000 / FPS;
			const answers = await Promise.all(
				Array.from({ length: 6 }, (_, clip) => ask({ index: 300 + clip * 51 + step, key: `c${clip}`, scale: 0.25 })),
			);
			expect(answers.map(frameIndex)).toEqual(Array.from({ length: 6 }, (_, clip) => 300 + clip * 51 + step));
			await settle();
		}
		expect(cache.getStats().streams).toBe(6);
		expect(cache.getCounters().borrows).toBe(0);
		expect(cache.getCounters().restarts).toBe(6);
	});
});

describe("VideoCache: kept frames are charged at least a minimum", () => {
	test("small kept frames count MIN_KEPT_FRAME_BYTES each, so the count stays bounded", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900, frameBytes: FRAME_BYTES });
		const { cache, clock, ask } = createCache({ video, reading: { value: null } });
		for (let index = 0; index < 400; index++) {
			clock.now += 1000 / FPS;
			await ask({ index, key: "a", scale: 1 / 16 });
			await settle();
		}
		const stats = cache.getMemoryStats();
		expect(MIN_KEPT_FRAME_BYTES).toBe(1 * MiB);
		expect(stats.lruFrames).toBeGreaterThan(10);
		expect(stats.lruBytes).toBe(stats.lruFrames * MIN_KEPT_FRAME_BYTES);
		expect(stats.lruFrames).toBeLessThanOrEqual(Math.floor(stats.budgetBytes / MIN_KEPT_FRAME_BYTES));
	});
});
