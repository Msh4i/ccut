import { describe, expect, test } from "bun:test";
import type { FrameSource } from "../frame-stream";
import {
	BUDGET_FLOOR_BYTES,
	FALLBACK_BUDGET_BYTES,
		MODE_POLICIES,
	type PerformanceMode,
} from "../memory-budget";
import { type MemorySource, VideoCache } from "../service";
import { createFakeVideo, settle, type FakeCanvas } from "./fake-video";

type FakeVideo = ReturnType<typeof createFakeVideo>;

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const FPS = 30;
/** 1 MiB per drawn frame keeps the byte arithmetic of the tests readable. */
const FRAME_BYTES = { decoded: 0.5 * MiB, drawn: 1 * MiB };

const OWNER_READING = {
	totalBytes: 15.3 * GiB,
	availableBytes: 6 * GiB,
	swapTotalBytes: 8 * GiB,
	swapFreeBytes: 8 * GiB,
	appBytes: 1.2 * GiB,
};

function createMemoryCache({
	videos,
	withMemory = true,
}: {
	videos: Record<string, FakeVideo>;
	withMemory?: boolean;
}) {
	const clock = { now: 0 };
	const bridge: { reading: unknown; mode: PerformanceMode; fails: boolean } = {
		reading: null,
		mode: "balanced",
		fails: false,
	};
	const scheduled: { tick: (() => void) | null; starts: number; stops: number } = {
		tick: null,
		starts: 0,
		stops: 0,
	};
	const memory: MemorySource = {
		readMemory: async () => {
			if (bridge.fails) throw new Error("bridge gone");
			return bridge.reading;
		},
		mode: () => bridge.mode,
		deviceMemoryGiB: () => null,
		schedule: (tick) => {
			scheduled.tick = tick;
			scheduled.starts += 1;
			return () => {
				scheduled.stops += 1;
			};
		},
	};
	const cache = new VideoCache<FakeCanvas>({
		openSource: async ({ file }) => {
			const video = videos[file.name];
			if (!video) throw new Error(`no fake video ${file.name}`);
			return video.source;
		},
		now: () => clock.now,
		...(withMemory && { memory }),
	});
	const files = new Map(Object.keys(videos).map((name) => [name, new File([], name)]));
	const ask = ({ media = "m1", index, key }: { media?: string; index: number; key?: string }) => {
		const video = videos[media];
		const file = files.get(media);
		if (!video || !file) throw new Error(`no fake video ${media}`);
		return cache.getFrameAt({
			mediaId: media,
			file,
			time: video.timeOf(index),
			...(key !== undefined && { streamKey: key }),
		});
	};
	const play = async ({ from, to, key = "main", media = "m1" }: { from: number; to: number; key?: string; media?: string }) => {
		for (let index = from; index <= to; index++) {
			clock.now += 1000 / FPS;
			await ask({ media, index, key });
			await settle();
		}
	};
	return { cache, clock, bridge, scheduled, ask, play };
}

function indexOf({ frame }: { frame: { timestamp: number } | null }): number | null {
	return frame ? Math.round(frame.timestamp * FPS) : null;
}

describe("VideoCache memory: frames drawn a moment ago", () => {
	test("scrubbing back over a range just played shows it from memory: no decoder start, no new draw", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, ask, play } = createMemoryCache({ videos: { m1: video } });
		await play({ from: 30, to: 60 });
		const restarts = cache.getCounters().restarts;
		const draws = video.log.drawn.length;
		for (let index = 50; index >= 40; index--) {
			const frame = await ask({ index, key: "main" });
			expect(indexOf({ frame })).toBe(index);
			expect(frame?.canvas.frame).toBe(index);
		}
		expect(cache.getCounters().restarts).toBe(restarts);
		expect(video.log.drawn.length).toBe(draws);
		expect(cache.getCounters().lruHits).toBe(11);
		expect(video.log.opened.length).toBe(1);
	});

	test("a kept frame has its own canvas: playing on never draws over it", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { ask, play } = createMemoryCache({ videos: { m1: video } });
		await play({ from: 30, to: 60 });
		const kept = await ask({ index: 40, key: "main" });
		expect(kept?.canvas.frame).toBe(40);
		const drawsBefore = kept?.canvas.draws;
		await play({ from: 61, to: 150 });
		expect(kept?.canvas.frame).toBe(40);
		expect(kept?.canvas.draws).toBe(drawsBefore);
		expect(await ask({ index: 40, key: "main" })).toBe(kept);
	});

	test("an A/B cut back to source times another clip of the file just played hits memory, without a decoder", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, ask, play } = createMemoryCache({ videos: { m1: video } });
		await play({ from: 30, to: 60, key: "a" });
		for (let index = 40; index <= 45; index++) {
			expect(indexOf({ frame: await ask({ index, key: "b" }) })).toBe(index);
		}
		expect(video.log.opened.length).toBe(1);
		expect(cache.getStats().streams).toBe(1);
	});

	test("a replay served from memory still releases the stream of a clip unused for a few seconds", async () => {
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES }),
			m2: createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES }),
		};
		const { cache, clock, ask } = createMemoryCache({ videos });
		// a plays while b (another file) shows a still frame
		for (let index = 0; index <= 170; index++) {
			clock.now += 1000 / FPS;
			await Promise.all([ask({ index, key: "a" }), ask({ media: "m2", index: 10, key: "b" })]);
			await settle();
		}
		expect(cache.getStats().streams).toBe(2);
		// a replays from memory alone for more than five seconds
		for (let index = 0; index < 170; index++) {
			clock.now += 1000 / FPS;
			await ask({ index, key: "a" });
		}
		expect(cache.getCounters().lruHits).toBe(170);
		expect(cache.getStats().streams).toBe(1);
		expect(videos.m2.log.returned).toBe(1);
		expect(videos.m1.log.returned).toBe(0);
		// a's stream counts as used by those hits: another clip coming back does not release it
		await ask({ media: "m2", index: 20, key: "b" });
		expect(videos.m1.log.returned).toBe(0);
		expect(cache.getStats().streams).toBe(2);
	});

	test("every frame of a 60 Hz playhead over a 30 fps video is still drawn once", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache } = createMemoryCache({ videos: { m1: video } });
		const file = new File([], "m1");
		for (let tick = 0; tick < 120; tick++) {
			const frame = await cache.getFrameAt({ mediaId: "m1", file, time: tick / 60 + 1e-4, streamKey: "main" });
			expect(indexOf({ frame })).toBe(Math.floor(tick / 2));
			await settle();
		}
		expect(video.log.drawn).toEqual(Array.from({ length: 60 }, (_, index) => index));
	});
});

describe("VideoCache memory: the budget", () => {
	test("without a memory source (web build) the cache keeps the small fixed budget", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, play } = createMemoryCache({ videos: { m1: video }, withMemory: false });
		await play({ from: 0, to: 20 });
		expect(cache.getMemoryStats().budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
		await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
	});

	test("what the cache holds never goes over the budget while it plays", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, play } = createMemoryCache({ videos: { m1: video } });
		for (let chunk = 0; chunk < 10; chunk++) {
			await play({ from: chunk * 30, to: chunk * 30 + 29 });
			const stats = cache.getMemoryStats();
			expect(stats.usedBytes).toBeLessThanOrEqual(stats.budgetBytes);
		}
		expect(cache.getMemoryStats().lruFrames).toBeGreaterThan(200);
	});

	test("pressure while full: the cache gives the memory back within one tick", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, bridge, play } = createMemoryCache({ videos: { m1: video } });
		bridge.reading = OWNER_READING;
		for (let tick = 0; tick < 3; tick++) await cache.tickMemory();
		await play({ from: 0, to: 400 });
		const full = cache.getMemoryStats();
		expect(full.lruBytes).toBeGreaterThan(300 * MiB);
		bridge.reading = { ...OWNER_READING, availableBytes: 0.6 * GiB };
		await cache.tickMemory();
		const pressed = cache.getMemoryStats();
		expect(pressed.budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(pressed.reason).toBe("pressure");
		expect(pressed.usedBytes).toBeLessThanOrEqual(BUDGET_FLOOR_BYTES);
		expect(pressed.lruBytes).toBeLessThan(full.lruBytes);
	});

	test("the performance mode feeds the budget", async () => {
		const { cache, bridge } = createMemoryCache({ videos: {} });
		bridge.reading = OWNER_READING;
		bridge.mode = "high";
		for (let tick = 0; tick < 40; tick++) await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBeCloseTo(4 * GiB, -3);
		expect(cache.getMemoryStats().mode).toBe("high");
		bridge.mode = "balanced";
		await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBeCloseTo(3 * GiB, -3);
	});

	test("an export holds the kept frames down at once, not the budget the streams follow, and lets go after it", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, bridge, play } = createMemoryCache({ videos: { m1: video } });
		bridge.reading = OWNER_READING;
		for (let tick = 0; tick < 40; tick++) await cache.tickMemory();
		await play({ from: 0, to: 300 });
		const full = cache.getMemoryStats();
		expect(full.lruBytes).toBeGreaterThan(200 * MiB);

		const release = cache.holdBudgetAtMost({ capBytes: 256 * MiB });
		const held = cache.getMemoryStats();
		// The kept frames went at once; the budget (and with it the stream cap) is what it was.
		expect(held.lruBytes).toBeLessThan(full.lruBytes);
		expect(held.usedBytes).toBeLessThanOrEqual(256 * MiB);
		expect(held.budgetBytes).toBe(full.budgetBytes);
		// Playing on and a tick while the hold lasts keep the kept frames down.
		await play({ from: 301, to: 599 });
		await cache.tickMemory();
		expect(cache.getMemoryStats().usedBytes).toBeLessThanOrEqual(256 * MiB);
		expect(cache.getMemoryStats().budgetBytes).toBe(full.budgetBytes);

		release();
		await play({ from: 0, to: 300 });
		expect(cache.getMemoryStats().lruBytes).toBeGreaterThan(200 * MiB);
	});

	test("two holds: the smaller cap wins until it is released, then the other applies", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, bridge, play } = createMemoryCache({ videos: { m1: video } });
		bridge.reading = OWNER_READING;
		for (let tick = 0; tick < 40; tick++) await cache.tickMemory();
		const releaseLarge = cache.holdBudgetAtMost({ capBytes: 1 * GiB });
		const releaseSmall = cache.holdBudgetAtMost({ capBytes: 150 * MiB });
		await play({ from: 0, to: 300 });
		expect(cache.getMemoryStats().usedBytes).toBeLessThanOrEqual(150 * MiB);
		releaseSmall();
		await play({ from: 0, to: 300 });
		const afterSmall = cache.getMemoryStats();
		expect(afterSmall.lruBytes).toBeGreaterThan(150 * MiB);
		expect(afterSmall.usedBytes).toBeLessThanOrEqual(1 * GiB);
		releaseLarge();
	});

	test("a bridge that throws or answers nonsense is no reading; the third one in a row falls back", async () => {
		const { cache, bridge } = createMemoryCache({ videos: {} });
		bridge.reading = OWNER_READING;
		for (let tick = 0; tick < 40; tick++) await cache.tickMemory();
		const full = cache.getMemoryStats().budgetBytes;
		bridge.fails = true;
		await cache.tickMemory();
		bridge.fails = false;
		bridge.reading = { ...OWNER_READING, availableBytes: Number.NaN };
		await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBe(full);
		bridge.reading = "16 GB";
		await cache.tickMemory();
		expect(cache.getMemoryStats().budgetBytes).toBe(FALLBACK_BUDGET_BYTES);
		expect(cache.getMemoryStats().reason).toBe("no-reading");
	});

	test("a frame that cannot be drawn (a failed allocation) shrinks the budget at once", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		let failed = false;
		const failing: FakeVideo = {
			...video,
			source: {
				...video.source,
				openIterator: ({ startTime }) => {
					const iterator = video.source.openIterator({ startTime });
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
										if (!failed && frame.timestamp >= 40 / FPS) {
											failed = true;
											throw new Error("out of memory");
										}
										frame.drawInto(canvas);
									},
								},
							};
						},
					};
				},
			} satisfies FrameSource<FakeCanvas>,
		};
		const { cache, bridge, ask, play } = createMemoryCache({ videos: { m1: failing } });
		bridge.reading = OWNER_READING;
		for (let tick = 0; tick < 3; tick++) await cache.tickMemory();
		await play({ from: 30, to: 39 });
		expect(cache.getMemoryStats().budgetBytes).toBeGreaterThan(BUDGET_FLOOR_BYTES);
		await expect(ask({ index: 40, key: "main" })).rejects.toThrow("out of memory");
		expect(cache.getMemoryStats().budgetBytes).toBe(BUDGET_FLOOR_BYTES);
		expect(cache.getMemoryStats().reason).toBe("allocation-failure");
	});

	test("decode stalls (stale frames while playing) are reported and keep the read-ahead", async () => {
		const slow = createFakeVideo({ fps: FPS, frameCount: 600, decode: "manual", frameBytes: FRAME_BYTES });
		const fast = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, bridge, ask } = createMemoryCache({ videos: { m1: slow, m2: fast } });
		bridge.reading = OWNER_READING;
		await cache.tickMemory();
		slow.release(3);
		await ask({ index: 0, key: "main" });
		await settle();
		const file = new File([], "m1");
		for (const time of [4.5 / FPS, 4.6 / FPS, 4.7 / FPS]) {
			await cache.withPlaybackTolerance({
				maxStaleSeconds: 0.1,
				run: () => cache.getFrameAt({ mediaId: "m1", file, time, streamKey: "main" }),
			});
		}
		expect(cache.getCounters().stalePresents).toBe(3);
		await cache.tickMemory();
		expect(cache.getMemoryStats().reason).toBe("stall");
		expect(cache.getMemoryStats().readAheadSeconds).toBe(MODE_POLICIES.balanced.readAheadSeconds);
		await ask({ media: "m2", index: 0, key: "other" });
		await settle();
		await settle();
		expect(fast.openFrames()).toBeGreaterThan(2);
		// the next tick counts only its own stale frames: none, no stall
		await cache.tickMemory();
		expect(cache.getMemoryStats().reason).toBe("reading");
	});

	test("the read-ahead's share of the budget limits streams holding big frames", async () => {
		// 16 MiB per decoded frame: a quarter of the 256 MiB fallback budget is 4 frames
		const big = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: { decoded: 16 * MiB, drawn: 1 * MiB } });
		const { cache, ask } = createMemoryCache({ videos: { m1: big } });
		await ask({ index: 0, key: "main" });
		await settle();
		await settle();
		expect(big.openFrames()).toBe(4);
		expect(cache.getMemoryStats().readAheadBytes).toBe(4 * 16 * MiB);
	});

	test("a kept frame just shown is not drawn over right after the budget evicts it", async () => {
		// 8 MiB per drawn frame: at the floor nothing is kept
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: { decoded: 0.5 * MiB, drawn: 8 * MiB } });
		const { cache, bridge, ask, play } = createMemoryCache({ videos: { m1: video } });
		await play({ from: 30, to: 40 });
		const kept = await ask({ index: 32, key: "main" });
		expect(kept?.canvas.frame).toBe(32);
		// every other kept frame shown after it: frame 32 is evicted first, into the free list
		for (const index of [30, 31, 33, 34, 35, 36, 37, 38, 39]) {
			await ask({ index, key: "main" });
		}
		bridge.reading = { ...OWNER_READING, availableBytes: 0.5 * GiB };
		await cache.tickMemory();
		expect(cache.getMemoryStats().lruFrames).toBe(0);
		// the renderer may still upload it: the next two draws use other canvases
		await play({ from: 41, to: 42 });
		expect(kept?.canvas.frame).toBe(32);
		// past its quarantine it is a free canvas like the others: drawn over, or
		// dropped as a spare (the newest free canvas is reused first). The ten
		// evicted frames do not stay: one shown, three in quarantine, at most four
		// free (3 x 1 stream + 1).
		await play({ from: 43, to: 50 });
		const stats = cache.getMemoryStats();
		expect(stats.usedBytes - stats.readAheadBytes).toBeLessThanOrEqual(8 * 8 * MiB);
	});
});

describe("VideoCache memory: canvases of two streams of one media", () => {
	test("a canvas handed out is drawn over only after the render that got it (two draws, one of each stream)", async () => {
		// One render's worth of draws (QUARANTINE_RENDERS 1 x 2 streams); a render
		// that takes longer holds its canvases with a lease (service-lease.test.ts).
		// 64 MiB per drawn frame: the fallback budget keeps none, every canvas goes through the free list
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: { decoded: 0.5 * MiB, drawn: 64 * MiB } });
		const { cache, ask } = createMemoryCache({ videos: { m1: video } });
		const answers: FakeCanvas[] = [];
		for (let draw = 0; draw < 12; draw++) {
			const [a, b] = await Promise.all([
				ask({ index: 30 + draw, key: "a" }),
				ask({ index: 300 + draw, key: "b" }),
			]);
			if (!a || !b) throw new Error("frames expected");
			answers.push(a.canvas, b.canvas);
			await settle();
		}
		expect(cache.getMemoryStats().lruFrames).toBe(0);
		for (let end = 2; end <= answers.length; end++) {
			expect(new Set(answers.slice(end - 2, end)).size).toBe(2);
		}
		// and canvases are recycled, not created for every draw
		expect(new Set(answers).size).toBeLessThan(answers.length);
	});
});

describe("VideoCache memory: release", () => {
	test("clearVideo and clearAll release every kept frame and canvas", async () => {
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES }),
			m2: createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES }),
		};
		const { cache, play } = createMemoryCache({ videos });
		await play({ from: 0, to: 40 });
		await play({ from: 0, to: 40, media: "m2", key: "other" });
		expect(cache.getMemoryStats().lruFrames).toBeGreaterThan(70);
		cache.clearVideo({ mediaId: "m1" });
		const afterOne = cache.getMemoryStats();
		expect(afterOne.lruFrames).toBeGreaterThan(30);
		expect(afterOne.lruFrames).toBeLessThan(45);
		cache.clearAll();
		const afterAll = cache.getMemoryStats();
		expect(afterAll).toMatchObject({ lruFrames: 0, lruBytes: 0, usedBytes: 0, streams: 0 });
		for (const video of Object.values(videos)) {
			expect(video.openFrames()).toBe(0);
			expect(video.log.doubleClosed).toBe(0);
		}
	});

	test("memory readings start with the first request and stop on clearAll", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, bridge, scheduled, play } = createMemoryCache({ videos: { m1: video } });
		expect(scheduled.starts).toBe(0);
		await play({ from: 0, to: 3 });
		expect(scheduled.starts).toBe(1);
		bridge.reading = { ...OWNER_READING, availableBytes: 0.5 * GiB };
		scheduled.tick?.();
		await settle();
		expect(cache.getMemoryStats().reason).toBe("pressure");
		cache.clearAll();
		expect(scheduled.stops).toBe(1);
		await play({ from: 0, to: 1 });
		expect(scheduled.starts).toBe(2);
	});

	test("the numbers the playback HUD shows", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, frameBytes: FRAME_BYTES });
		const { cache, ask, play } = createMemoryCache({ videos: { m1: video } });
		await play({ from: 0, to: 20 });
		await ask({ index: 10, key: "main" });
		const stats = cache.getMemoryStats();
		expect(stats).toMatchObject({
			mode: "balanced",
			budgetBytes: FALLBACK_BUDGET_BYTES,
			lruHits: 1,
			streams: 1,
			restarts: 1,
			reason: "start",
		});
		expect(stats.lruFrames).toBe(20);
		expect(stats.lruBytes).toBe(20 * MiB);
		expect(stats.readAheadBytes).toBe(video.openFrames() * 0.5 * MiB);
		expect(stats.usedBytes).toBeGreaterThan(stats.lruBytes);
		expect(stats.availableBytes).toBeNull();
	});
});
