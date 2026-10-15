import { describe, expect, test } from "bun:test";
import { MIN_KEPT_FRAME_BYTES } from "../drawn-frame-cache";
import type { FrameSource } from "../frame-stream";
import { VideoCache } from "../service";
import { createFakeVideo, drawnOnce, settle, type FakeCanvas } from "./fake-video";

// The cache serves each request at the scale it asks for (the preview while it
// plays asks for about the on-screen size, everything else for full size).

type FakeVideo = ReturnType<typeof createFakeVideo>;

const MiB = 1024 ** 2;
const FILE = new File([], "clip.mp4");

function createCache({ video }: { video: FakeVideo }) {
	const cache = new VideoCache<FakeCanvas>({
		openSource: async () => video.source,
		now: () => 0,
	});
	const ask = ({
		index,
		scale,
		key = "main",
	}: {
		index: number;
		scale?: number;
		key?: string;
	}) =>
		cache.getFrameAt({
			mediaId: "clip",
			file: FILE,
			time: video.timeOf(index),
			streamKey: key,
			...(scale !== undefined && { scale }),
		});
	return { cache, ask };
}

describe("VideoCache: frame scale", () => {
	test("a request without a scale (export, snapshot, thumbnail) gets a full-size frame", async () => {
		const video = createFakeVideo();
		const { ask } = createCache({ video });
		const frame = await ask({ index: 3 });
		expect(frame?.scale).toBe(1);
		expect(frame?.canvas.scale).toBe(1);
		expect(video.log.canvasScales).toEqual([1]);
	});

	test("a scaled request gets a canvas of that scale and the media's display size", async () => {
		const video = createFakeVideo({ displaySize: { width: 1080, height: 1920 } });
		const { ask } = createCache({ video });
		const frame = await ask({ index: 3, scale: 0.25 });
		expect(frame?.canvas.scale).toBe(0.25);
		expect(frame?.displayWidth).toBe(1080);
		expect(frame?.displayHeight).toBe(1920);
	});

	test("the display size can be read once the media is open, not before", async () => {
		const video = createFakeVideo({ displaySize: { width: 1280, height: 720 } });
		const { cache, ask } = createCache({ video });
		expect(cache.peekDisplaySize({ mediaId: "clip" })).toBeNull();
		await ask({ index: 0 });
		expect(cache.peekDisplaySize({ mediaId: "clip" })).toEqual({ width: 1280, height: 720 });
		expect(cache.peekDisplaySize({ mediaId: "other" })).toBeNull();
		cache.clearVideo({ mediaId: "clip" });
		expect(cache.peekDisplaySize({ mediaId: "clip" })).toBeNull();
	});

	test("an unusable scale is full size", async () => {
		const video = createFakeVideo();
		const { ask } = createCache({ video });
		expect((await ask({ index: 0, scale: Number.NaN }))?.scale).toBe(1);
		await settle();
		expect((await ask({ index: 1, scale: 0 }))?.scale).toBe(1);
	});
});

describe("VideoCache: one clip asked at two scales in one render (video and blur backdrop)", () => {
	test("the larger scale wins whichever asked first: one draw, one frame for both", async () => {
		for (const order of [
			[0.25, 0.5],
			[0.5, 0.25],
			[0.5, 0.5],
		]) {
			const video = createFakeVideo();
			const { ask } = createCache({ video });
			const [first, second] = await Promise.all(
				order.map((scale) => ask({ index: 4, scale })),
			);
			expect(first).toBe(second);
			expect(first?.scale).toBe(Math.max(...order));
			expect(video.log.drawn).toEqual([4]);
		}
	});

	test("a request that already started is shared only with an equal or smaller scale", async () => {
		const video = createFakeVideo({ decode: "manual" });
		const { ask } = createCache({ video });
		const small = ask({ index: 4, scale: 0.25 });
		await settle();
		// the first one is waiting for the decoder now: a full-size request cannot join it
		const small2 = ask({ index: 4, scale: 0.25 });
		const full = ask({ index: 4, scale: 1 });
		video.release(50);
		const [a, b, c] = await Promise.all([small, small2, full]);
		expect(a).toBe(b);
		expect(a?.scale).toBe(0.25);
		expect(c?.scale).toBe(1);
		expect(c).not.toBe(a);
	});

	test("the frame of the previous time never answers a request that was raised", async () => {
		const video = createFakeVideo();
		const { ask } = createCache({ video });
		await ask({ index: 3, scale: 0.25 });
		await settle();
		const [backdrop, main] = await Promise.all([
			ask({ index: 4, scale: 0.25 }),
			ask({ index: 4, scale: 0.5 }),
		]);
		expect(Math.round((backdrop?.timestamp ?? 0) * video.fps)).toBe(4);
		expect(backdrop).toBe(main);
	});
});

describe("VideoCache: kept frames and scale", () => {
	async function playSmall({ ask }: { ask: ReturnType<typeof createCache>["ask"] }) {
		for (let index = 0; index < 12; index++) {
			await ask({ index, scale: 0.25 });
			await settle();
		}
	}

	test("scrubbing back to a frame drawn small finds it for a small request", async () => {
		const video = createFakeVideo({ frameBytes: { decoded: 0.5 * MiB, drawn: 1 * MiB } });
		const { cache, ask } = createCache({ video });
		await playSmall({ ask });
		const before = cache.getCounters().lruHits;
		const drawn = video.log.drawn.length;
		const back = await ask({ index: 5, scale: 0.25 });
		expect(cache.getCounters().lruHits).toBe(before + 1);
		expect(back?.scale).toBe(0.25);
		expect(video.log.drawn.length).toBe(drawn);
	});

	test("the same frame at full size is not found there: it is decoded again", async () => {
		const video = createFakeVideo({ frameBytes: { decoded: 0.5 * MiB, drawn: 1 * MiB } });
		const { cache, ask } = createCache({ video });
		await playSmall({ ask });
		const before = cache.getCounters().lruHits;
		const back = await ask({ index: 5, scale: 1 });
		expect(cache.getCounters().lruHits).toBe(before);
		expect(back?.scale).toBe(1);
		expect(Math.round((back?.timestamp ?? 0) * video.fps)).toBe(5);
	});

	test("kept frames and live canvases are accounted at their own size, kept ones at least MIN_KEPT_FRAME_BYTES", async () => {
		const video = createFakeVideo({ frameBytes: { decoded: 0.5 * MiB, drawn: 1 * MiB } });
		const { cache, ask } = createCache({ video });
		await playSmall({ ask });
		const small = cache.getMemoryStats();
		expect(small.lruFrames).toBeGreaterThan(0);
		// a sixteenth of the area at 0.25: the 1 MiB frame costs 1/16 MiB, charged
		// the minimum in the drawn-frame cache
		expect(small.lruBytes).toBeCloseTo(small.lruFrames * Math.max(MIN_KEPT_FRAME_BYTES, MiB / 16), 0);
		// live canvases at their own size
		expect(small.usedBytes - small.decoderQueueBytes - small.readAheadBytes - small.keptDecodedBytes).toBe(
			video.log.canvases * MiB / 16,
		);
	});
});

describe("VideoCache: a failed redraw at full size", () => {
	test("answers with the smaller frame, and the next full-size request for that time tries again", async () => {
		const video = createFakeVideo();
		let opens = 0;
		const source: FrameSource<FakeCanvas> = {
			...video.source,
			openIterator: (args) => {
				opens += 1;
				// the decoder of the paused redraw cannot start
				if (opens === 2) throw new Error("seek failed");
				return video.source.openIterator(args);
			},
		};
		// the kept small frame cannot be drawn again: the redraw needs the decoder
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => drawnOnce({ source }), now: () => 0 });
		const ask = ({ scale, maxStaleSeconds }: { scale: number; maxStaleSeconds: number }) =>
			cache.withPlaybackTolerance({
				maxStaleSeconds,
				run: () =>
					cache.getFrameAt({
						mediaId: "clip",
						file: FILE,
						time: video.timeOf(10),
						streamKey: "main",
						scale,
					}),
			});
		const playing = await ask({ scale: 0.25, maxStaleSeconds: 0.1 });
		await settle();
		const paused = await ask({ scale: 1, maxStaleSeconds: 0 });
		expect(paused).toBe(playing);
		await settle();
		// e.g. the paused preview drawn again after an edit: not the same soft answer
		const again = await ask({ scale: 1, maxStaleSeconds: 0 });
		expect(again?.scale).toBe(1);
		expect(again?.timestamp).toBe(playing?.timestamp ?? Number.NaN);
		expect(opens).toBe(3);
	});
});

describe("VideoCache: a request overtaken before it ran, and scale", () => {
	// A request a newer one of the same stream overtook before it ran answers
	// with the frame on the canvas without decoding (scrubbing). Scrub requests
	// are exact (tolerance 0, render-gate.ts previewFrameTolerance) but at the
	// preview's scale; the final pictures (a paused frame, a snapshot, a
	// thumbnail, an export) ask for full size.
	function manualCache() {
		const video = createFakeVideo({ decode: "manual" });
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => 0 });
		const ask = ({
			index,
			scale,
			maxStaleSeconds,
		}: {
			index: number;
			scale: number;
			maxStaleSeconds: number;
		}) =>
			cache.withPlaybackTolerance({
				maxStaleSeconds,
				run: () =>
					cache.getFrameAt({
						mediaId: "clip",
						file: FILE,
						time: video.timeOf(index),
						streamKey: "main",
						scale,
					}),
			});
		const indexOf = (frame: { timestamp: number } | null) =>
			frame ? Math.round(frame.timestamp * video.fps) : null;
		return { video, ask, indexOf };
	}

	test("a full-size exact request (a paused frame, a snapshot) is not answered by a frame drawn smaller", async () => {
		const { video, ask } = manualCache();
		const played = ask({ index: 10, scale: 0.25, maxStaleSeconds: 0.1 });
		video.release(1);
		expect((await played)?.scale).toBe(0.25);
		await settle();
		// a scrub request at 0.5 for the same frame waits for its decoder ...
		const scrub = ask({ index: 10, scale: 0.5, maxStaleSeconds: 0 });
		await settle();
		// ... the full-size request queues behind it, and the playing preview's
		// next draw overtakes that one before it runs
		const paused = ask({ index: 10, scale: 1, maxStaleSeconds: 0 });
		const next = ask({ index: 11, scale: 0.25, maxStaleSeconds: 0.1 });
		video.release(50);
		expect((await scrub)?.scale).toBe(0.5);
		const full = await paused;
		expect(full?.scale).toBe(1);
		expect(Math.round((full?.timestamp ?? 0) * video.fps)).toBe(10);
		expect(await next).not.toBeNull();
	});

	test("an overtaken scrub request keeps the shortcut: the smaller frame on the canvas, no decode", async () => {
		const { video, ask, indexOf } = manualCache();
		const scrubbed = ask({ index: 10, scale: 0.25, maxStaleSeconds: 0 });
		video.release(1);
		await scrubbed;
		await settle();
		const waiting = ask({ index: 20, scale: 0.25, maxStaleSeconds: 0 });
		await settle();
		// further along a scale animation the layer needs a larger bucket
		const overtaken = ask({ index: 25, scale: 0.5, maxStaleSeconds: 0 });
		const newest = ask({ index: 30, scale: 0.5, maxStaleSeconds: 0 });
		video.release(100);
		expect(indexOf(await waiting)).toBe(20);
		const answer = await overtaken;
		expect(indexOf(answer)).toBe(20);
		expect(answer?.scale).toBe(0.25);
		expect((await newest)?.scale).toBe(0.5);
		expect(video.log.drawn).toEqual([10, 20, 30]);
	});

	test("an overtaken playing request keeps the shortcut too, also at full size", async () => {
		const { video, ask, indexOf } = manualCache();
		const played = ask({ index: 10, scale: 0.25, maxStaleSeconds: 0.1 });
		video.release(1);
		await played;
		await settle();
		const waiting = ask({ index: 20, scale: 0.25, maxStaleSeconds: 0 });
		await settle();
		// zoomed in while playing: full size, with the playback tolerance
		const overtaken = ask({ index: 25, scale: 1, maxStaleSeconds: 0.1 });
		const newest = ask({ index: 30, scale: 1, maxStaleSeconds: 0.1 });
		video.release(100);
		const shown = await waiting;
		const answer = await overtaken;
		// the frame the previous request drew, as it was drawn
		expect(answer).toBe(shown);
		expect(indexOf(answer)).toBe(20);
		expect(answer?.scale).toBe(0.25);
		expect((await newest)?.scale).toBe(1);
	});
});

describe("VideoCache: clips of one media shown at different sizes", () => {
	// Picture-in-picture copies of one file at three sizes while playing: every
	// clip draws at its own scale. 4K frames at the fallback budget, so the frame
	// LRU keeps nothing and every canvas goes back through the free lists. The
	// budget allows one 4K stream (`streamCapForBudget`): the clips borrow it.
	async function playThreeClips({ scales }: { scales: number[] }) {
		const video = createFakeVideo({
			frameCount: 3000,
			frameBytes: { decoded: 3840 * 2160 * 1.5, drawn: 3840 * 2160 * 4 },
		});
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => 0 });
		const clips = scales.map((scale, order) => ({ key: `clip-${order}`, start: order * 1000, scale }));
		for (let draw = 0; draw < 50; draw++) {
			await Promise.all(
				clips.map((clip) =>
					cache.getFrameAt({
						mediaId: "clip",
						file: FILE,
						time: video.timeOf(clip.start + draw),
						streamKey: clip.key,
						scale: clip.scale,
					}),
				),
			);
			await settle();
		}
		return { video, cache };
	}

	test("three clips at three sizes reuse their canvases instead of making one per draw", async () => {
		const { video, cache } = await playThreeClips({ scales: [0.25, 0.5, 1] });
		expect(cache.getStats().streams).toBe(1);
		expect(video.log.drawn).toHaveLength(150);
		// before: 150 canvases for 150 draws (two sizes kept their free canvases,
		// the third dropped them); room for three sizes alone: 27
		expect(video.log.canvases).toBeLessThanOrEqual(15);
	});

	test("showing the clips smaller never keeps more memory than showing them at full size", async () => {
		const mixed = await playThreeClips({ scales: [0.25, 0.5, 1] });
		const full = await playThreeClips({ scales: [1, 1, 1] });
		// room for three sizes alone: 445 MiB against 419 MiB at full size
		expect(mixed.cache.getMemoryStats().usedBytes).toBeLessThan(full.cache.getMemoryStats().usedBytes);
	});

	test("the room is bounded by the media's streams: a size one clip left behind holds no memory", async () => {
		// 8K frames: whatever the sizes, the frame LRU of the fallback budget keeps
		// nothing at the end, so only the canvas pools differ
		async function playThrough({ scales }: { scales: number[] }) {
			const video = createFakeVideo({
				frameCount: 3000,
				frameBytes: { decoded: 7680 * 4320 * 1.5, drawn: 7680 * 4320 * 4 },
			});
			const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => 0 });
			let index = 0;
			for (const scale of scales) {
				for (let draw = 0; draw < 10; draw++) {
					await cache.getFrameAt({
						mediaId: "clip",
						file: FILE,
						time: video.timeOf(index),
						streamKey: "main",
						scale,
					});
					index += 1;
					await settle();
				}
			}
			const stats = cache.getMemoryStats();
			expect(stats.lruBytes).toBe(0);
			return stats.usedBytes;
		}
		// one stream: room for two sizes; the first size's canvases are gone either way
		expect(await playThrough({ scales: [1, 0.5, 0.25] })).toBe(
			await playThrough({ scales: [0.125, 0.5, 0.25] }),
		);
	});
});

describe("VideoCache: memory of sizes no clip draws any more (W1 review R)", () => {
	// Three clips of one 4K file at the fallback budget (256 MiB), 10 renders
	// per scale bucket. Numbers from the fake decoder: before = the branch
	// before this fix, base = before preview resolution (which churned a canvas
	// per draw instead of keeping free ones). Memory here is what the sizes
	// hold outside the drawn-frame cache (canvases shown and free, the
	// read-ahead): the decoders' own queues (counted since P4, 100 MiB per 4K
	// decoder) and the kept frames (which got more of the budget once the
	// canvas quarantine went from 3 to 1 render) are left out, so the bounds
	// stay the ones of the W1 review; the total stays within the budget.
	const WALK = [0.25, Math.SQRT1_2 / 2, 0.5, Math.SQRT1_2, 1, 0.25];
	function canvasBytes(cache: VideoCache<FakeCanvas>): number {
		const stats = cache.getMemoryStats();
		expect(stats.usedBytes).toBeLessThanOrEqual(stats.budgetBytes + stats.decoderQueueBytes);
		return stats.usedBytes - stats.decoderQueueBytes - stats.lruBytes;
	}
	async function playClips({
		renders,
		scaleOf,
	}: {
		renders: number;
		scaleOf: ({ clip, render }: { clip: number; render: number }) => number;
	}) {
		const video = createFakeVideo({
			frameCount: 6000,
			frameBytes: { decoded: 3840 * 2160 * 1.5, drawn: 3840 * 2160 * 4 },
		});
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => 0 });
		let peakBytes = 0;
		for (let render = 0; render < renders; render++) {
			await Promise.all(
				[0, 1, 2].map((clip) =>
					cache.getFrameAt({
						mediaId: "clip",
						file: FILE,
						time: video.timeOf(clip * 2000 + render),
						streamKey: `clip-${clip}`,
						scale: scaleOf({ clip, render }),
					}),
				),
			);
			await settle();
			peakBytes = Math.max(peakBytes, canvasBytes(cache));
		}
		return { canvases: video.log.canvases, usedBytes: canvasBytes(cache), peakBytes };
	}

	test("one clip zooms through the buckets while two keep theirs: the sizes it left give their memory back", async () => {
		const others = [Math.SQRT1_2 / 2, 0.5];
		const run = await playClips({
			renders: 60,
			scaleOf: ({ clip, render }) => (clip === 0 ? WALK[Math.floor(render / 10)] : others[clip - 1]),
		});
		// before: 293 MiB at the end, 348 at the peak; base: 97 and 190 (136 canvases)
		expect(run.usedBytes).toBeLessThanOrEqual(125 * MiB);
		expect(run.peakBytes).toBeLessThanOrEqual(245 * MiB);
		// 24 canvases with a quarantine of 3 renders, 46 with 1 (smaller free
		// lists: more canvases made and destroyed, less memory held).
		expect(run.canvases).toBeLessThanOrEqual(50);
	});

	test("all three clips zoom up and back to 0.25: the large sizes give their memory back", async () => {
		const run = await playClips({ renders: 60, scaleOf: ({ render }) => WALK[Math.floor(render / 10)] });
		// before: 647 MiB at the end, 696 at the peak; base: 409 and 577
		expect(run.usedBytes).toBeLessThanOrEqual(110 * MiB);
		expect(run.peakBytes).toBeLessThanOrEqual(560 * MiB);
	});

	test("three clips at three fixed sizes keep their low churn and memory", async () => {
		const sizes = [0.25, 0.5, 1];
		const run = await playClips({ renders: 50, scaleOf: ({ clip }) => sizes[clip] });
		// base: 150 canvases, 152 MiB
		expect(run.canvases).toBeLessThanOrEqual(15);
		expect(run.usedBytes).toBeLessThanOrEqual(210 * MiB);
	});
});

describe("VideoCache: a request raised by one that joined it", () => {
	// Two requests for the same time made together share one answer, drawn at
	// the larger scale of the two (a clip and its blur backdrop, or a scrub
	// request and the paused redraw right after it).
	test("raised to full size and then overtaken, it is still not answered by a frame drawn smaller", async () => {
		const video = createFakeVideo({ decode: "manual" });
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => video.source, now: () => 0 });
		const ask = ({ index, scale, maxStaleSeconds }: { index: number; scale: number; maxStaleSeconds: number }) =>
			cache.withPlaybackTolerance({
				maxStaleSeconds,
				run: () =>
					cache.getFrameAt({ mediaId: "clip", file: FILE, time: video.timeOf(index), streamKey: "main", scale }),
			});
		const played = ask({ index: 10, scale: 0.25, maxStaleSeconds: 0.1 });
		video.release(1);
		await played;
		await settle();
		const waiting = ask({ index: 20, scale: 0.25, maxStaleSeconds: 0 });
		await settle();
		// a scrub request at 0.5, the paused request at full size joins and raises it,
		// then the playing preview's next draw overtakes both
		const scrub = ask({ index: 25, scale: 0.5, maxStaleSeconds: 0 });
		const paused = ask({ index: 25, scale: 1, maxStaleSeconds: 0 });
		const next = ask({ index: 26, scale: 0.25, maxStaleSeconds: 0.1 });
		video.release(200);
		await waiting;
		const [shared, full] = await Promise.all([scrub, paused]);
		await next;
		expect(full).toBe(shared);
		expect(full?.scale).toBe(1);
		expect(Math.round((full?.timestamp ?? 0) * video.fps)).toBe(25);
	});

	test("raised to full size, a smaller answer (a failed redraw) is not shared with the next request for that time", async () => {
		const video = createFakeVideo();
		let opens = 0;
		const source: FrameSource<FakeCanvas> = {
			...video.source,
			openIterator: (args) => {
				opens += 1;
				// the full-size redraw cannot start the first time
				if (opens === 2) throw new Error("seek failed");
				return video.source.openIterator(args);
			},
		};
		// the kept small frame cannot be drawn again: the redraw needs the decoder
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => drawnOnce({ source }), now: () => 0 });
		const ask = ({ scale, maxStaleSeconds }: { scale: number; maxStaleSeconds: number }) =>
			cache.withPlaybackTolerance({
				maxStaleSeconds,
				run: () =>
					cache.getFrameAt({ mediaId: "clip", file: FILE, time: video.timeOf(10), streamKey: "main", scale }),
			});
		const played = await ask({ scale: 0.25, maxStaleSeconds: 0.1 });
		await settle();
		// a scrub request at 0.25 and the paused request at full size, together
		const [scrub, paused] = await Promise.all([
			ask({ scale: 0.25, maxStaleSeconds: 0 }),
			ask({ scale: 1, maxStaleSeconds: 0 }),
		]);
		expect(paused).toBe(scrub);
		expect(paused).toBe(played);
		await settle();
		// the next full-size request for that time tries the decoder again
		const again = await ask({ scale: 1, maxStaleSeconds: 0 });
		expect(again?.scale).toBe(1);
		expect(opens).toBe(3);
	});
});
