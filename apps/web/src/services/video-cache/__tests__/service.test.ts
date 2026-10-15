import { describe, expect, test } from "bun:test";
import type { FrameSource } from "../frame-stream";
import { VideoCache } from "../service";
import { createFakeVideo, settle, type FakeCanvas } from "./fake-video";

type FakeVideo = ReturnType<typeof createFakeVideo>;

/** `video` whose first frame cannot be drawn: `drawInto` throws once ("canvas lost"). */
function drawFailsOnce({ video }: { video: FakeVideo }): FakeVideo {
	let failed = false;
	const source: FrameSource<FakeCanvas> = {
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
							drawInto: (canvas) => {
								if (!failed) {
									failed = true;
									throw new Error("canvas lost");
								}
								frame.drawInto(canvas);
							},
						},
					};
				},
			};
		},
	};
	return { ...video, source };
}

function createCache({ videos }: { videos: FakeVideo[] }) {
	const opened: string[] = [];
	let nextVideo = 0;
	const cache = new VideoCache<FakeCanvas>({
		openSource: async ({ file }) => {
			opened.push(file.name);
			const video = videos[Math.min(nextVideo, videos.length - 1)];
			nextVideo += 1;
			return video.source;
		},
		now: () => 0,
	});
	return { cache, opened };
}

const FILE = new File([], "clip.mp4");

function request({
	cache,
	video,
	index,
}: {
	cache: VideoCache<FakeCanvas>;
	video: FakeVideo;
	index: number;
}) {
	return cache.getFrameAt({ mediaId: "clip", file: FILE, time: video.timeOf(index) });
}

function indexOf({
	video,
	frame,
}: {
	video: FakeVideo;
	frame: { timestamp: number } | null;
}): number | null {
	return frame ? Math.round(frame.timestamp * video.fps) : null;
}

describe("VideoCache: two layers of the same media in one render", () => {
	test("the blur backdrop and the video get the same frame, drawn once", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300 });
		const { cache } = createCache({ videos: [video] });
		for (const index of [0, 1, 2, 5]) {
			// resolve.ts asks for both in parallel: backdrop first, then the video
			const [backdrop, main] = await Promise.all([
				request({ cache, video, index }),
				request({ cache, video, index }),
			]);
			expect(backdrop).toBe(main);
			expect(indexOf({ video, frame: main })).toBe(index);
			await settle();
		}
		expect(video.log.drawn).toEqual([0, 1, 2, 5]);
	});
});

describe("VideoCache: superseded requests", () => {
	test("a request overtaken by a newer one before it runs returns the frame on the canvas without decoding", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
		const { cache } = createCache({ videos: [video] });
		const first = request({ cache, video, index: 0 });
		await settle();
		const overtaken = request({ cache, video, index: 5 });
		const latest = request({ cache, video, index: 50 });
		video.release(100);
		expect(indexOf({ video, frame: await first })).toBe(0);
		expect(indexOf({ video, frame: await overtaken })).toBe(0);
		expect(indexOf({ video, frame: await latest })).toBe(50);
		expect(video.log.drawn).toEqual([0, 50]);
	});
});

describe("VideoCache: playback tolerance", () => {
	test("requests made inside withPlaybackTolerance may show a slightly older decoded frame", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
		const { cache } = createCache({ videos: [video] });
		video.release(3);
		await request({ cache, video, index: 0 });
		await settle();
		const stale = await cache.withPlaybackTolerance({
			maxStaleSeconds: 0.1,
			run: () => request({ cache, video, index: 4 }),
		});
		expect(indexOf({ video, frame: stale })).toBe(2);
	});

	test("an exact request for the same time does not reuse a stale answer", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
		const { cache } = createCache({ videos: [video] });
		video.release(3);
		await request({ cache, video, index: 0 });
		await settle();
		await cache.withPlaybackTolerance({
			maxStaleSeconds: 0.1,
			run: () => request({ cache, video, index: 4 }),
		});
		let exact: number | null | undefined;
		void request({ cache, video, index: 4 }).then((frame) => {
			exact = indexOf({ video, frame });
		});
		await settle();
		expect(exact).toBeUndefined();
		video.release(10);
		await settle();
		expect(exact).toBe(4);
	});

	test("the tolerance only reaches requests made synchronously inside run", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
		const { cache } = createCache({ videos: [video] });
		video.release(3);
		await request({ cache, video, index: 0 });
		await settle();
		let late: number | null | undefined;
		void cache
			.withPlaybackTolerance({
				maxStaleSeconds: 0.1,
				run: async () => {
					await Promise.resolve();
					return request({ cache, video, index: 4 });
				},
			})
			.then((frame) => {
				late = indexOf({ video, frame });
			});
		await settle();
		// made after an await: exact, so it waits for frame 4
		expect(late).toBeUndefined();
		video.release(10);
		await settle();
		expect(late).toBe(4);
		// and the cache is exact again after run returned
		expect(cache.getPlaybackTolerance()).toBe(0);
	});

	test("the tolerance is restored when run throws", () => {
		const video = createFakeVideo();
		const { cache } = createCache({ videos: [video] });
		expect(() =>
			cache.withPlaybackTolerance({
				maxStaleSeconds: 0.1,
				run: () => {
					throw new Error("render failed");
				},
			}),
		).toThrow("render failed");
		expect(cache.getPlaybackTolerance()).toBe(0);
	});
});

describe("VideoCache: decoder errors", () => {
	test("a decoder error while a request waits does not block the requests after it", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual", failAtDelivery: 3 });
		const { cache } = createCache({ videos: [video] });
		video.release(3);
		await request({ cache, video, index: 0 });
		await settle();
		let waiting: number | null | undefined;
		void request({ cache, video, index: 9 }).then((frame) => {
			waiting = indexOf({ video, frame });
		});
		await settle();
		expect(waiting).toBeUndefined();
		// the decoder fails while that request waits
		video.release(1);
		await settle();
		expect(waiting).toBe(9);
		// a seek far away afterwards still gets its frame
		let later: number | null | undefined;
		void request({ cache, video, index: 150 }).then((frame) => {
			later = indexOf({ video, frame });
		});
		video.release(10);
		await settle();
		expect(later).toBe(150);
	});

	test("a request that got no frame is not answered with the same nothing the next time", async () => {
		// The decoder started for the request fails before its first frame.
		const video = createFakeVideo({ fps: 30, frameCount: 300, failAtDelivery: 0 });
		const { cache } = createCache({ videos: [video] });
		let first: number | null | undefined;
		void request({ cache, video, index: 5 }).then((frame) => {
			first = indexOf({ video, frame });
		});
		await settle();
		expect(first).toBeNull();
		expect(indexOf({ video, frame: await request({ cache, video, index: 5 }) })).toBe(5);
	});

	test("two requests for the same time made together share one answer, also when it is nothing", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, failAtDelivery: 0 });
		const { cache } = createCache({ videos: [video] });
		let answers: Array<unknown> | undefined;
		void Promise.all([
			request({ cache, video, index: 5 }),
			request({ cache, video, index: 5 }),
		]).then((frames) => {
			answers = frames;
		});
		await settle();
		expect(answers).toEqual([null, null]);
		expect(cache.getCounters().requests).toBe(1);
	});
});

describe("VideoCache: a request that rejected", () => {
	test("is not answered with the same rejection the next time: a retry for the same time is a fresh attempt", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300 });
		const { cache } = createCache({ videos: [drawFailsOnce({ video })] });
		await expect(request({ cache, video, index: 5 })).rejects.toThrow("canvas lost");
		const retry = await request({ cache, video, index: 5 });
		expect(retry).not.toBeNull();
		expect(cache.getCounters().requests).toBe(2);
	});

	test("two requests for the same time made together still share one rejection", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300 });
		const { cache } = createCache({ videos: [drawFailsOnce({ video })] });
		const outcomes = await Promise.allSettled([
			request({ cache, video, index: 5 }),
			request({ cache, video, index: 5 }),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
		expect(cache.getCounters().requests).toBe(1);
	});

	test("an older request that rejects does not make the newer request forget its shared answer", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
		const { cache } = createCache({ videos: [drawFailsOnce({ video })] });
		const older = request({ cache, video, index: 5 });
		const olderOutcome = older.then(
			() => "frame",
			() => "rejected",
		);
		// the older request runs and waits for the decoder
		await settle();
		const newer = request({ cache, video, index: 40 });
		video.release(1);
		expect(await olderOutcome).toBe("rejected");
		// the newer request still waits; its twin joins it
		const twin = request({ cache, video, index: 40 });
		video.release(100);
		expect(await twin).toBe(await newer);
		expect(cache.getCounters().requests).toBe(2);
	});
});

describe("VideoCache: an answer of nothing and newer requests", () => {
	test("an overtaken request that answers nothing does not make the newer request forget its shared answer", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
		const { cache } = createCache({ videos: [video] });
		// nothing is on a canvas yet, so the overtaken request answers null
		const overtaken = request({ cache, video, index: 5 });
		const newer = request({ cache, video, index: 40 });
		expect(await overtaken).toBeNull();
		// the newer request still waits for the decoder; its twin joins it
		const twin = request({ cache, video, index: 40 });
		video.release(100);
		expect(await twin).toBe(await newer);
		expect(cache.getCounters().requests).toBe(1);
	});

	test("an answer with a frame is still reused for the same time", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300 });
		const { cache } = createCache({ videos: [video] });
		const first = await request({ cache, video, index: 5 });
		expect(first).not.toBeNull();
		expect(await request({ cache, video, index: 5 })).toBe(first);
		expect(cache.getCounters().requests).toBe(1);
	});
});

describe("VideoCache: lifecycle", () => {
	test("clearVideo disposes the decoder; the next request opens the file again", async () => {
		const first = createFakeVideo();
		const second = createFakeVideo();
		const { cache, opened } = createCache({ videos: [first, second] });
		await request({ cache, video: first, index: 3 });
		await settle();
		cache.clearVideo({ mediaId: "clip" });
		expect(first.log.disposed).toBe(true);
		expect(first.openFrames()).toBe(0);
		expect(indexOf({ video: second, frame: await request({ cache, video: second, index: 7 }) })).toBe(7);
		expect(opened).toEqual(["clip.mp4", "clip.mp4"]);
	});

	test("a file that cannot be opened rejects, and the next request tries again", async () => {
		const video = createFakeVideo();
		let attempts = 0;
		const cache = new VideoCache<FakeCanvas>({
			openSource: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("no video track");
				return video.source;
			},
			now: () => 0,
		});
		await expect(
			cache.getFrameAt({ mediaId: "clip", file: FILE, time: 0 }),
		).rejects.toThrow("no video track");
		const frame = await cache.getFrameAt({ mediaId: "clip", file: FILE, time: video.timeOf(2) });
		expect(indexOf({ video, frame })).toBe(2);
	});

	test("counters add up over requests and are handed out as a copy", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 300 });
		const { cache } = createCache({ videos: [video] });
		await request({ cache, video, index: 0 });
		await settle();
		await request({ cache, video, index: 1 });
		// still inside frame 1, which is on the canvas already
		await cache.getFrameAt({ mediaId: "clip", file: FILE, time: 1.2 / 30 });
		const counters = cache.getCounters();
		expect(counters.restarts).toBe(1);
		expect(counters.readAheadHits).toBe(1);
		expect(counters.hits).toBe(1);
		expect(counters.draws).toBe(2);
		counters.draws = 99;
		expect(cache.getCounters().draws).toBe(2);
	});
});
