import { describe, expect, test } from "bun:test";
import { type StreamLimits, VideoCache } from "../service";
import { createFakeVideo, settle, type FakeCanvas } from "./fake-video";

type FakeVideo = ReturnType<typeof createFakeVideo>;

/** One cache over fake videos, one per media id; `clock.now` drives the cache's time. */
function createCache({
	videos,
	streams,
}: {
	videos: Record<string, FakeVideo>;
	streams?: Partial<StreamLimits>;
}) {
	const clock = { now: 0 };
	const opened: string[] = [];
	const cache = new VideoCache<FakeCanvas>({
		openSource: async ({ file }) => {
			opened.push(file.name);
			const video = videos[file.name];
			if (!video) throw new Error(`no fake video ${file.name}`);
			return video.source;
		},
		now: () => clock.now,
		streams,
	});
	const files = new Map(Object.keys(videos).map((name) => [name, new File([], name)]));
	const ask = ({
		media,
		index,
		key,
	}: {
		media: string;
		index: number;
		key?: string;
	}) => {
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
	return { cache, clock, opened, ask };
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

const FPS = 30;
const FIVE_SECONDS = 5 * FPS;

describe("VideoCache streams: two clips of one media at different times", () => {
	test("picture-in-picture with stream keys: each clip gets its own frame in every draw, no restart per draw", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { cache, ask } = createCache({ videos: { m1: video } });
		for (let draw = 0; draw < 20; draw++) {
			const [main, pip] = await Promise.all([
				ask({ media: "m1", index: 30 + draw, key: "main" }),
				ask({ media: "m1", index: 30 + FIVE_SECONDS + draw, key: "pip" }),
			]);
			expect(indexOf({ video, frame: main })).toBe(30 + draw);
			expect(indexOf({ video, frame: pip })).toBe(30 + FIVE_SECONDS + draw);
			expect(main?.canvas).not.toBe(pip?.canvas);
			await settle();
		}
		// one decoder per clip, started once
		expect(cache.getCounters().restarts).toBe(2);
		expect(video.log.opened).toEqual([video.timeOf(30), video.timeOf(30 + FIVE_SECONDS)]);
		expect(cache.getStats().streams).toBe(2);
	});

	test("without stream keys the time window gives each clip its own stream too", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { cache, ask } = createCache({ videos: { m1: video } });
		for (let draw = 0; draw < 20; draw++) {
			const [main, pip] = await Promise.all([
				ask({ media: "m1", index: 30 + draw }),
				ask({ media: "m1", index: 30 + FIVE_SECONDS + draw }),
			]);
			expect(indexOf({ video, frame: main })).toBe(30 + draw);
			expect(indexOf({ video, frame: pip })).toBe(30 + FIVE_SECONDS + draw);
			await settle();
		}
		expect(cache.getCounters().restarts).toBe(2);
	});

	test("clips asked one after the other (no request overtakes another) do not restart a decoder per draw", async () => {
		for (const keyed of [true, false]) {
			const video = createFakeVideo({ fps: FPS, frameCount: 600 });
			const { cache, ask } = createCache({ videos: { m1: video } });
			for (let draw = 0; draw < 20; draw++) {
				const main = await ask({ media: "m1", index: 30 + draw, ...(keyed && { key: "main" }) });
				const pip = await ask({
					media: "m1",
					index: 30 + FIVE_SECONDS + draw,
					...(keyed && { key: "pip" }),
				});
				expect(indexOf({ video, frame: main })).toBe(30 + draw);
				expect(indexOf({ video, frame: pip })).toBe(30 + FIVE_SECONDS + draw);
				await settle();
			}
			expect(cache.getCounters().restarts).toBe(2);
		}
	});

	test("a new clip one second ahead of a clip still on screen opens its own stream instead of taking that one over", async () => {
		// Asked one after the other, so the main clip's stream is idle when
		// the PiP clip comes: still not its stream (only a split clip's cut is).
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { cache, clock, ask } = createCache({ videos: { m1: video } });
		for (let draw = 0; draw < 10; draw++) {
			clock.now += 1000 / 30;
			await ask({ media: "m1", index: 30 + draw, key: "main" });
			await settle();
			expect(indexOf({ video, frame: await ask({ media: "m1", index: 60 + draw, key: "pip" }) })).toBe(60 + draw);
			await settle();
		}
		expect(cache.getCounters().restarts).toBe(2);
		expect(video.log.opened).toEqual([video.timeOf(30), video.timeOf(60)]);
	});

	test("a new clip takes over the stream of a clip that left the screen instead of opening another one", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900 });
		const { cache, clock, ask } = createCache({ videos: { m1: video } });
		await Promise.all([
			ask({ media: "m1", index: 30, key: "a" }),
			ask({ media: "m1", index: 300, key: "b" }),
		]);
		await settle();
		// "b" plays on alone for a second: "a" has left the screen
		for (let step = 1; step <= 30; step++) {
			clock.now += 1000 / 30;
			await ask({ media: "m1", index: 300 + step, key: "b" });
			await settle();
		}
		expect(indexOf({ video, frame: await ask({ media: "m1", index: 600, key: "c" }) })).toBe(600);
		expect(cache.getStats().streams).toBe(2);
		expect(video.log.returned).toBe(1);
		// and "b" kept its decoder
		expect(video.log.opened).toEqual([video.timeOf(30), video.timeOf(300), video.timeOf(600)]);
		await settle();
		// "a" coming back does not take its old stream from "c"
		expect(indexOf({ video, frame: await ask({ media: "m1", index: 40, key: "a" }) })).toBe(40);
		await settle();
		const opened = video.log.opened.length;
		expect(indexOf({ video, frame: await ask({ media: "m1", index: 620, key: "c" }) })).toBe(620);
		expect(video.log.opened.length).toBe(opened);
	});

	test("without stream keys a second layer of the same draw goes to an idle stream before it joins a busy one", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { ask } = createCache({ videos: { m1: video } });
		await ask({ media: "m1", index: 300 });
		await settle();
		// a second stream half a second before the first one
		await ask({ media: "m1", index: 285 });
		await settle();
		const [first, second] = await Promise.all([
			ask({ media: "m1", index: 301 }),
			ask({ media: "m1", index: 304 }),
		]);
		expect(indexOf({ video, frame: first })).toBe(301);
		expect(indexOf({ video, frame: second })).toBe(304);
	});

	test("without stream keys a request for the time a busy stream was just asked for joins it", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { ask } = createCache({ videos: { m1: video } });
		await ask({ media: "m1", index: 300 });
		await settle();
		// a backward jump opens a second stream just before the first one
		await ask({ media: "m1", index: 270 });
		await settle();
		const [first, second] = await Promise.all([
			ask({ media: "m1", index: 315 }),
			ask({ media: "m1", index: 315 }),
		]);
		expect(second).toBe(first);
		expect(video.log.drawn.filter((index) => index === 315)).toEqual([315]);
	});

	test("a clip asked while another clip's request is pending never takes over that stream", async () => {
		// The PiP request used to overtake the main clip's request on the one
		// stream of the media, which then answered with the frame on the canvas.
		const video = createFakeVideo({ fps: FPS, frameCount: 600, decode: "manual" });
		const { ask } = createCache({ videos: { m1: video } });
		const main = ask({ media: "m1", index: 30, key: "main" });
		const pip = ask({ media: "m1", index: 40, key: "pip" });
		video.release(200);
		expect(indexOf({ video, frame: await main })).toBe(30);
		expect(indexOf({ video, frame: await pip })).toBe(40);
	});

	test("the blur backdrop and the video of one clip share one stream, one answer and one draw", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { cache, ask } = createCache({ videos: { m1: video } });
		for (const index of [30, 31, 32, 35]) {
			const [backdrop, main, pip] = await Promise.all([
				ask({ media: "m1", index, key: "main" }),
				ask({ media: "m1", index, key: "main" }),
				ask({ media: "m1", index: index + FIVE_SECONDS, key: "pip" }),
			]);
			expect(backdrop).toBe(main);
			expect(indexOf({ video, frame: main })).toBe(index);
			expect(indexOf({ video, frame: pip })).toBe(index + FIVE_SECONDS);
			await settle();
		}
		expect(video.log.drawn.filter((index) => index < 100)).toEqual([30, 31, 32, 35]);
		expect(cache.getStats().streams).toBe(2);
	});

	test("a split clip continues on the stream of the clip before it: no decoder start at the cut", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { cache, ask } = createCache({ videos: { m1: video } });
		for (let index = 30; index < 40; index++) {
			await ask({ media: "m1", index, key: "left" });
			await settle();
		}
		for (let index = 40; index < 50; index++) {
			expect(indexOf({ video, frame: await ask({ media: "m1", index, key: "right" }) })).toBe(index);
			await settle();
		}
		expect(video.log.opened).toEqual([video.timeOf(30)]);
		expect(cache.getStats().streams).toBe(1);
	});

	test("an overtaken request of one clip still answers with that clip's frame on the canvas", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600, decode: "manual" });
		const { ask } = createCache({ videos: { m1: video } });
		video.release(3);
		expect(indexOf({ video, frame: await ask({ media: "m1", index: 30, key: "main" }) })).toBe(30);
		await settle();
		// scrubbing the main clip: the first request is overtaken before it runs
		const overtaken = ask({ media: "m1", index: 45, key: "main" });
		const latest = ask({ media: "m1", index: 60, key: "main" });
		video.release(200);
		expect(indexOf({ video, frame: await overtaken })).toBe(30);
		expect(indexOf({ video, frame: await latest })).toBe(60);
		expect(video.log.drawn).toEqual([30, 60]);
	});
});

describe("VideoCache streams: bounds", () => {
	test("at most maxPerMedia streams for one media: a further clip takes over the stream of a clip gone for 600 ms of playback", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900 });
		const { cache, clock, ask } = createCache({ videos: { m1: video }, streams: { maxPerMedia: 2 } });
		await ask({ media: "m1", index: 30, key: "a" });
		await settle();
		await ask({ media: "m1", index: 300, key: "b" });
		await settle();
		expect(cache.getStats().streams).toBe(2);
		// "b" plays on alone for 0.6 s: "a" has left the screen
		for (let step = 1; step <= 18; step++) {
			clock.now += 1000 / 30;
			await ask({ media: "m1", index: 300 + step, key: "b" });
			await settle();
		}
		expect(indexOf({ video, frame: await ask({ media: "m1", index: 600, key: "c" }) })).toBe(600);
		await settle();
		expect(cache.getStats().streams).toBe(2);
		// "a"'s decoder was stopped for "c"
		expect(video.log.opened).toEqual([video.timeOf(30), video.timeOf(300), video.timeOf(600)]);
		expect(video.log.returned).toBe(1);
		// "c" owns it now: playing on needs no new decoder, nor does "b"
		clock.now += 1000 / 30;
		const [b, c] = await Promise.all([
			ask({ media: "m1", index: 319, key: "b" }),
			ask({ media: "m1", index: 601, key: "c" }),
		]);
		expect([indexOf({ video, frame: b }), indexOf({ video, frame: c })]).toEqual([319, 601]);
		expect(video.log.opened.length).toBe(3);
	});

	test("at most maxPerMedia streams for one media: with every clip on screen a further clip borrows a stream, its owner keeps it", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900 });
		const { cache, clock, ask } = createCache({ videos: { m1: video }, streams: { maxPerMedia: 2 } });
		for (let draw = 0; draw < 5; draw++) {
			clock.now += 1000 / 30;
			const answers = await Promise.all([
				ask({ media: "m1", index: 30 + draw, key: "a" }),
				ask({ media: "m1", index: 300 + draw, key: "b" }),
				ask({ media: "m1", index: 600 + draw, key: "c" }),
			]);
			expect(answers.map((frame) => indexOf({ video, frame }))).toEqual([30 + draw, 300 + draw, 600 + draw]);
			await settle();
		}
		expect(cache.getStats().streams).toBe(2);
		expect(cache.getCounters().borrows).toBe(5);
		// "b" kept its stream and decoder throughout; "a" and "c" take turns on the other
		expect(video.log.opened.filter((time) => time >= video.timeOf(300) && time < video.timeOf(400))).toEqual([
			video.timeOf(300),
		]);
	});

	test("at most maxTotal streams: the least recently used idle stream of another media is disposed with its decoder and frames", async () => {
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 300 }),
			m2: createFakeVideo({ fps: FPS, frameCount: 300 }),
			m3: createFakeVideo({ fps: FPS, frameCount: 300 }),
		};
		const { cache, clock, ask } = createCache({ videos, streams: { maxTotal: 2 } });
		await ask({ media: "m1", index: 10, key: "a" });
		await settle();
		await ask({ media: "m2", index: 10, key: "b" });
		await settle();
		expect(videos.m1.openFrames()).toBeGreaterThan(0);
		// "b" plays on alone for 0.6 s: the clip of m1 has left the screen
		for (let step = 1; step <= 18; step++) {
			clock.now += 1000 / 30;
			await ask({ media: "m2", index: 10 + step, key: "b" });
			await settle();
		}
		expect(indexOf({ video: videos.m3, frame: await ask({ media: "m3", index: 10, key: "c" }) })).toBe(10);
		await settle();
		expect(cache.getStats().streams).toBe(2);
		expect(videos.m1.log.returned).toBe(1);
		expect(videos.m1.openFrames()).toBe(0);
		expect(videos.m1.log.doubleClosed).toBe(0);
		expect(videos.m2.openFrames()).toBeGreaterThan(0);
	});

	test("streams of the same draw are never evicted: when every stream is busy the cap is exceeded instead", async () => {
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 300, decode: "manual" }),
			m2: createFakeVideo({ fps: FPS, frameCount: 300, decode: "manual" }),
		};
		const { cache, clock, ask } = createCache({ videos, streams: { maxTotal: 1 } });
		const first = ask({ media: "m1", index: 10, key: "a" });
		const second = ask({ media: "m2", index: 10, key: "b" });
		videos.m1.release(50);
		videos.m2.release(50);
		expect(indexOf({ video: videos.m1, frame: await first })).toBe(10);
		expect(indexOf({ video: videos.m2, frame: await second })).toBe(10);
		expect(videos.m1.log.returned).toBe(0);
		await settle();
		// both clips on screen: one stream each, over the total (soft)
		await ask({ media: "m2", index: 11, key: "b" });
		expect(cache.getStats().streams).toBe(2);
		// once the clip of m1 has left the screen, its idle stream goes
		for (let step = 2; step <= 19; step++) {
			clock.now += 1000 / 30;
			await ask({ media: "m2", index: 10 + step, key: "b" });
			await settle();
		}
		expect(cache.getStats().streams).toBe(1);
		expect(videos.m1.log.returned).toBe(1);
	});

	test("over the total, the stream a request was just given is never the one released", async () => {
		// m2 coming on screen lowers m1's quota to 1; both m1 streams were last
		// used at the same moment, and the first one is the clip's being asked.
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 900 }),
			m2: createFakeVideo({ fps: FPS, frameCount: 900 }),
		};
		const { ask } = createCache({ videos, streams: { maxTotal: 2, maxPerMedia: 2 } });
		for (let draw = 0; draw < 3; draw++) {
			const answers = await Promise.all([
				ask({ media: "m1", index: 30 + draw, key: "a" }),
				ask({ media: "m1", index: 300 + draw, key: "b" }),
				ask({ media: "m2", index: 30 + draw, key: "c" }),
			]);
			expect(answers.map((frame) => indexOf({ video: videos.m1, frame }))).toEqual([
				30 + draw,
				300 + draw,
				30 + draw,
			]);
			await settle();
		}
	});

	test("at most maxTotal streams: clips of more media on screen than the total keep one stream each", async () => {
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 300 }),
			m2: createFakeVideo({ fps: FPS, frameCount: 300 }),
			m3: createFakeVideo({ fps: FPS, frameCount: 300 }),
		};
		const { cache, clock, ask } = createCache({ videos, streams: { maxTotal: 2 } });
		for (let draw = 0; draw < 5; draw++) {
			clock.now += 1000 / 30;
			const answers = await Promise.all(
				(["m1", "m2", "m3"] as const).map((media) => ask({ media, index: 10 + draw, key: media })),
			);
			expect(answers.map((frame) => indexOf({ video: videos.m1, frame }))).toEqual([10 + draw, 10 + draw, 10 + draw]);
			await settle();
		}
		expect(cache.getStats().streams).toBe(3);
		expect(cache.getCounters().restarts).toBe(3);
	});

	test("a stream unused during a few seconds of playback is released; a pause does not count", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 900 });
		const { cache, clock, ask } = createCache({
			videos: { m1: video },
			streams: { releaseIdleAfterMs: 5000 },
		});
		await Promise.all([
			ask({ media: "m1", index: 30, key: "main" }),
			ask({ media: "m1", index: 30 + FIVE_SECONDS, key: "pip" }),
		]);
		await settle();
		// a 60 s pause, then the main clip plays alone for 4 s: pip stays
		clock.now += 60_000;
		for (let step = 1; step <= 120; step++) {
			clock.now += 1000 / 30;
			await ask({ media: "m1", index: 30 + step, key: "main" });
			await settle();
		}
		expect(cache.getStats().streams).toBe(2);
		expect(video.log.returned).toBe(0);
		// two more seconds of playback without it: released
		for (let step = 121; step <= 180; step++) {
			clock.now += 1000 / 30;
			await ask({ media: "m1", index: 30 + step, key: "main" });
			await settle();
		}
		expect(cache.getStats().streams).toBe(1);
		expect(video.log.returned).toBe(1);
		// its frames were closed: only the main stream's read-ahead is open
		expect(video.openFrames()).toBeLessThanOrEqual(8);
	});

	test("clearVideo stops every decoder of the media, closes every frame and disposes the file once", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 600 });
		const { cache, ask } = createCache({ videos: { m1: video } });
		for (let draw = 0; draw < 5; draw++) {
			await Promise.all([
				ask({ media: "m1", index: 30 + draw, key: "main" }),
				ask({ media: "m1", index: 30 + FIVE_SECONDS + draw, key: "pip" }),
				ask({ media: "m1", index: 30 + 2 * FIVE_SECONDS + draw, key: "third" }),
			]);
			await settle();
		}
		expect(video.log.opened.length).toBe(3);
		cache.clearVideo({ mediaId: "m1" });
		await settle();
		expect(video.log.returned).toBe(3);
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
		expect(video.log.disposals).toBe(1);
		expect(cache.getStats().streams).toBe(0);
	});

	test("a file cleared while it opens is disposed and its request answers nothing", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300 });
		let finishOpening: () => void = () => {};
		const opening = new Promise<void>((resolve) => {
			finishOpening = resolve;
		});
		const cache = new VideoCache<FakeCanvas>({
			openSource: async () => {
				await opening;
				return video.source;
			},
			now: () => 0,
		});
		const pending = cache.getFrameAt({
			mediaId: "m1",
			file: new File([], "m1"),
			time: video.timeOf(5),
			streamKey: "a",
		});
		cache.clearVideo({ mediaId: "m1" });
		finishOpening();
		expect(await pending).toBeNull();
		expect(video.log.disposals).toBe(1);
		expect(video.log.opened.length).toBe(0);
		expect(cache.getStats().media).toBe(0);
	});

	test("clearAll does the same for every media", async () => {
		const videos = {
			m1: createFakeVideo({ fps: FPS, frameCount: 300 }),
			m2: createFakeVideo({ fps: FPS, frameCount: 300 }),
		};
		const { cache, ask } = createCache({ videos });
		await Promise.all([
			ask({ media: "m1", index: 10, key: "a" }),
			ask({ media: "m1", index: 200, key: "b" }),
			ask({ media: "m2", index: 10, key: "c" }),
		]);
		await settle();
		cache.clearAll();
		await settle();
		for (const video of Object.values(videos)) {
			expect(video.openFrames()).toBe(0);
			expect(video.log.returned).toBe(video.log.opened.length);
			expect(video.log.disposals).toBe(1);
		}
	});
});
