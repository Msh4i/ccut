import { describe, expect, test } from "bun:test";
import { DEFAULT_DECODER_LIMITS } from "../frame-policy";
import { type FrameSource, FrameStream, createFrameCacheCounters } from "../frame-stream";
import { VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// While a stream shows a frame drawn smaller than the video (the preview
// playing), it keeps that frame's decoded picture: pausing then redraws it at
// full size without a decoder restart. The kept picture is closed exactly once.

type FakeVideo = ReturnType<typeof createFakeVideo>;

const FPS = 30;
const DECODED = 1920 * 1080 * 1.5;

function createStream({ video, source = video.source }: { video: FakeVideo; source?: FrameSource<FakeCanvas> }) {
	const counters = createFrameCacheCounters();
	const stream = new FrameStream<FakeCanvas>({
		source,
		counters,
		now: () => 0,
		limits: DEFAULT_DECODER_LIMITS,
	});
	return { stream, counters };
}

function frameIndex(frame: { timestamp: number } | null): number | null {
	return frame ? Math.round(frame.timestamp * FPS) : null;
}

describe("FrameStream: the decoded frame of a small shown frame is kept", () => {
	test("pausing after preview playback redraws the kept frame at full size: no restart, one redraw, same timestamp", async () => {
		const video = createFakeVideo({ fps: FPS, keyframeInterval: 30 });
		const { stream, counters } = createStream({ video });
		const playing = await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0.09, scale: 0.25 });
		await settle();
		const restarts = counters.restarts;
		const opened = video.log.opened.length;
		const paused = await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0, scale: 1 });
		expect(paused).not.toBe(playing);
		expect(paused?.scale).toBe(1);
		expect(paused?.canvas.scale).toBe(1);
		expect(paused?.canvas.frame).toBe(40);
		expect(paused?.timestamp).toBe(playing?.timestamp ?? Number.NaN);
		expect(counters.restarts).toBe(restarts);
		expect(counters.redraws).toBe(1);
		expect(video.log.opened.length).toBe(opened);
		// The full-size frame is kept no more.
		expect(stream.heldDecodedBytes()).toBe(stream.readAheadBytes());
	});

	test("the kept frame counts in the decoded bytes the stream holds; a frame shown at full size is not kept", async () => {
		const video = createFakeVideo({ fps: FPS });
		const { stream } = createStream({ video });
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		expect(stream.heldDecodedBytes()).toBe(stream.readAheadBytes() + DECODED);
		await stream.frameAt({ time: video.timeOf(11), maxStaleSeconds: 0, scale: 1 });
		await settle();
		expect(stream.heldDecodedBytes()).toBe(stream.readAheadBytes());
		stream.dispose();
	});

	test("the kept frame is closed exactly once: on the next present, on a restart, on dispose", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { stream } = createStream({ video });
		for (let index = 10; index < 20; index++) {
			await stream.frameAt({ time: video.timeOf(index), maxStaleSeconds: 0, scale: 0.25 });
			await settle();
		}
		// A jump back restarts the decoder.
		await stream.frameAt({ time: video.timeOf(2), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		stream.dispose();
		await settle();
		expect(video.log.doubleClosed).toBe(0);
		expect(video.openFrames()).toBe(0);
	});

	test("a redraw whose draw fails releases its canvas and decodes the frame again", async () => {
		const video = createFakeVideo({ fps: FPS });
		let draws = 0;
		const source: FrameSource<FakeCanvas> = {
			...video.source,
			openIterator: (args) => {
				const iterator = video.source.openIterator(args);
				return {
					...iterator,
					next: async () => {
						const result = await iterator.next();
						if (result.done) return result;
						const frame = result.value;
						return {
							done: false,
							value: {
								...frame,
								drawInto: (canvas: FakeCanvas) => {
									draws += 1;
									// The second draw of the first decoded frame (the redraw) fails.
									if (draws === 2) throw new Error("canvas lost");
									frame.drawInto(canvas);
								},
							},
						};
					},
				};
			},
		};
		const { stream, counters } = createStream({ video, source });
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		const canvases = video.log.canvases;
		const paused = await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 1 });
		expect(frameIndex(paused)).toBe(10);
		expect(paused?.scale).toBe(1);
		expect(counters.redraws).toBe(0);
		expect(counters.restarts).toBe(2);
		// The canvas of the failed redraw went back and was drawn by the restart.
		expect(video.log.canvases).toBe(canvases + 1);
		stream.dispose();
		await settle();
		expect(video.log.doubleClosed).toBe(0);
		expect(video.openFrames()).toBe(0);
	});

	test("pressure gives the kept frame back with the read-ahead", async () => {
		const video = createFakeVideo({ fps: FPS });
		const { stream } = createStream({ video });
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		stream.trimReadAhead({ keepFrames: 0 });
		expect(stream.heldDecodedBytes()).toBe(0);
		stream.dispose();
		await settle();
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
	});
});

describe("FrameStream: no kept frame when the read-ahead policy says so", () => {
	test("keepDecoded false (memory pressure): the small shown frame's decoded frame is closed at once", async () => {
		const video = createFakeVideo({ fps: FPS });
		const stream = new FrameStream<FakeCanvas>({
			source: video.source,
			counters: createFrameCacheCounters(),
			now: () => 0,
			limits: DEFAULT_DECODER_LIMITS,
			readAhead: () => ({ seconds: 0, maxBytes: Number.POSITIVE_INFINITY, keepDecoded: false }),
		});
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		expect(stream.keptDecodedBytes()).toBe(0);
		stream.dispose();
	});
});

describe("VideoCache: the kept decoded frame in memory", () => {
	test("under memory pressure streams keep no decoded frame", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const GiB = 1024 ** 3;
		const cache = new VideoCache<FakeCanvas>({
			openSource: async () => video.source,
			now: () => 0,
			memory: {
				readMemory: async () => ({
					totalBytes: 4 * GiB,
					availableBytes: 0.5 * GiB,
					swapTotalBytes: 0,
					swapFreeBytes: 0,
					appBytes: GiB,
				}),
				mode: () => "balanced",
				deviceMemoryGiB: () => null,
			},
		});
		await cache.tickMemory();
		const file = new File([], "m1");
		await cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(10), streamKey: "a", scale: 0.25 });
		await settle();
		expect(cache.getMemoryStats().reason).toBe("pressure");
		expect(cache.getMemoryStats().keptDecodedBytes).toBe(0);
		cache.clearAll();
	});

	test("used bytes count each stream's kept frame", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => 0 });
		const file = new File([], "m1");
		await cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(10), streamKey: "a", scale: 0.25 });
		await settle();
		const stats = cache.getMemoryStats();
		expect(stats.keptDecodedBytes).toBe(DECODED);
		const canvases = cache.getStats().streams;
		expect(canvases).toBe(1);
		expect(stats.usedBytes).toBeGreaterThanOrEqual(
			stats.readAheadBytes + stats.decoderQueueBytes + stats.keptDecodedBytes,
		);
		cache.clearAll();
	});
});
