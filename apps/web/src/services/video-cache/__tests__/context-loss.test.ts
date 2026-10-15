import { describe, expect, test } from "bun:test";
import { DEFAULT_DECODER_LIMITS } from "../frame-policy";
import { FrameStream, createFrameCacheCounters } from "../frame-stream";
import { watchContextLoss } from "../mediabunny-source";
import { VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// The GPU process lost the canvases' contents (a GPU reset, the process
// restarted): every drawn frame is blank. Kept frames are forgotten and the
// frames streams show are drawn again before they are handed out.

const FPS = 30;

function frameIndex(frame: { timestamp: number } | null): number | null {
	return frame ? Math.round(frame.timestamp * FPS) : null;
}

describe("FrameStream.invalidatePresented", () => {
	test("forgets the frame it shows and its decoder: the same time is decoded and drawn again", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300 });
		const counters = createFrameCacheCounters();
		const stream = new FrameStream<FakeCanvas>({
			source: video.source,
			counters,
			now: () => 0,
			limits: DEFAULT_DECODER_LIMITS,
		});
		const first = await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0 });
		await settle();
		expect(frameIndex(first)).toBe(40);
		stream.invalidatePresented();
		expect(stream.getPresented()).toBeNull();
		expect(stream.hasDecoder()).toBe(false);
		expect(stream.readAheadBytes()).toBe(0);
		const drawn = video.log.drawn.length;
		const again = await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0 });
		expect(frameIndex(again)).toBe(40);
		expect(video.log.drawn.length).toBe(drawn + 1);
		expect(counters.restarts).toBe(2);
		stream.dispose();
		await settle();
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
	});
});

describe("FrameStream.invalidatePresented, repeated", () => {
	test("the forgotten frame's canvas goes back to the pool: canvases are reused, not leaked", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300 });
		const stream = new FrameStream<FakeCanvas>({
			source: video.source,
			counters: createFrameCacheCounters(),
			now: () => 0,
			limits: DEFAULT_DECODER_LIMITS,
		});
		for (let round = 0; round < 12; round++) {
			expect(frameIndex(await stream.frameAt({ time: video.timeOf(40 + round), maxStaleSeconds: 0 }))).toBe(40 + round);
			stream.invalidatePresented();
		}
		// The stream's own pool: three canvases in turn (quarantine 3).
		expect(video.log.canvases).toBeLessThanOrEqual(4);
		stream.dispose();
	});
});

describe("VideoCache.dropDrawnFrames", () => {
	test("empties the drawn-frame cache and makes every stream draw its frame again; no frame closed twice", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const clock = { now: 0 };
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => clock.now });
		const file = new File([], "m1");
		const ask = ({ index, key }: { index: number; key: string }) =>
			cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(index), streamKey: key, scale: 0.25 });
		for (let index = 0; index < 20; index++) {
			clock.now += 1000 / FPS;
			await Promise.all([ask({ index, key: "a" }), ask({ index: 300 + index, key: "b" })]);
			await settle();
		}
		expect(cache.getMemoryStats().lruFrames).toBeGreaterThan(0);
		const drawn = video.log.drawn.length;
		const hits = cache.getCounters().lruHits;

		cache.dropDrawnFrames();
		expect(cache.getMemoryStats().lruFrames).toBe(0);
		expect(cache.getStats().decoders).toBe(0);
		// The frames on screen are drawn again, at the same times.
		const [a, b] = await Promise.all([ask({ index: 19, key: "a" }), ask({ index: 319, key: "b" })]);
		expect([frameIndex(a), frameIndex(b)]).toEqual([19, 319]);
		expect(video.log.drawn.length).toBe(drawn + 2);
		// Scrubbing back finds nothing kept: decoded and drawn again.
		await settle();
		expect(frameIndex(await ask({ index: 5, key: "a" }))).toBe(5);
		expect(cache.getCounters().lruHits).toBe(hits);
		cache.clearAll();
		await settle();
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
	});
});

describe("VideoCache: a canvas the source reports lost", () => {
	test("drops the drawn frames of every media", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const reported: Array<() => void> = [];
		const cache = new VideoCache<FakeCanvas>({
			openSource: async ({ onCanvasLost }) => {
				reported.push(onCanvasLost);
				return video.source;
			},
			now: () => 0,
		});
		const file = new File([], "m1");
		for (let index = 0; index < 12; index++) {
			await cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(index), streamKey: "a", scale: 0.25 });
			await settle();
		}
		expect(cache.getMemoryStats().lruFrames).toBeGreaterThan(0);
		expect(reported).toHaveLength(1);
		for (const lost of reported) lost();
		await settle();
		expect(cache.getMemoryStats().lruFrames).toBe(0);
		expect(cache.getStats().decoders).toBe(0);
		cache.clearAll();
	});
});

describe("VideoCache: canvases lost together", () => {
	test("N reports in one task drop the drawn frames once; a later report drops them again", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const reported: Array<() => void> = [];
		const cache = new VideoCache<FakeCanvas>({
			openSource: async ({ onCanvasLost }) => {
				reported.push(onCanvasLost);
				return video.source;
			},
			now: () => 0,
		});
		const file = new File([], "m1");
		let drops = 0;
		const drop = cache.dropDrawnFrames.bind(cache);
		cache.dropDrawnFrames = () => {
			drops += 1;
			drop();
		};
		await cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(1), streamKey: "a", scale: 0.25 });
		const [lost] = reported;
		for (let canvas = 0; canvas < 5; canvas++) lost?.();
		expect(drops).toBe(0);
		await settle();
		expect(drops).toBe(1);
		lost?.();
		await settle();
		expect(drops).toBe(2);
		cache.clearAll();
	});
});

describe("watchContextLoss", () => {
	test("calls back each time the canvas loses its context (a recycled canvas can lose it again)", () => {
		const canvas = new EventTarget();
		let lost = 0;
		watchContextLoss({
			canvas,
			onLost: () => {
				lost += 1;
			},
		});
		canvas.dispatchEvent(new Event("contextlost"));
		canvas.dispatchEvent(new Event("contextlost"));
		expect(lost).toBe(2);
	});

	test("without a callback nothing is watched", () => {
		const canvas = new EventTarget();
		expect(() => watchContextLoss({ canvas, onLost: undefined })).not.toThrow();
		canvas.dispatchEvent(new Event("contextlost"));
	});
});
