import { describe, expect, test } from "bun:test";
import { DEFAULT_DECODER_LIMITS } from "../frame-policy";
import { type FrameSource, FrameStream, createFrameCacheCounters } from "../frame-stream";
import { createFakeVideo, drawnOnce, settle, type FakeCanvas } from "./fake-video";

// The preview asks for frames at about their on-screen size while it plays
// (scale < 1) and at full size when paused; the exporter always asks for full
// size. A frame answers a request only if its canvas was drawn at that scale
// or larger.

type FakeVideo = ReturnType<typeof createFakeVideo>;

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

function ask({
	stream,
	video,
	index,
	scale,
	maxStaleSeconds = 0,
}: {
	stream: FrameStream<FakeCanvas>;
	video: FakeVideo;
	index: number;
	scale?: number;
	maxStaleSeconds?: number;
}) {
	return stream.frameAt({ time: video.timeOf(index), maxStaleSeconds, scale });
}

describe("FrameStream: frames at a scale", () => {
	test("a request without a scale draws at the display size (what export and snapshot get)", async () => {
		const video = createFakeVideo({ displaySize: { width: 1920, height: 1080 } });
		const { stream } = createStream({ video });
		const frame = await ask({ stream, video, index: 3 });
		expect(frame?.scale).toBe(1);
		expect(frame?.canvas.scale).toBe(1);
		expect(video.log.canvasScales).toEqual([1]);
		expect(frame?.displayWidth).toBe(1920);
		expect(frame?.displayHeight).toBe(1080);
	});

	test("a scaled request draws into a canvas of that scale and still reports the display size", async () => {
		const video = createFakeVideo({ displaySize: { width: 1920, height: 1080 } });
		const { stream } = createStream({ video });
		const frame = await ask({ stream, video, index: 3, scale: 0.25 });
		expect(frame?.scale).toBe(0.25);
		expect(frame?.canvas.scale).toBe(0.25);
		expect(frame?.displayWidth).toBe(1920);
		expect(frame?.displayHeight).toBe(1080);
	});

	test("an unusable scale is full size", async () => {
		const video = createFakeVideo();
		const { stream } = createStream({ video });
		for (const [index, scale] of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY].entries()) {
			const frame = await ask({ stream, video, index, scale });
			expect(frame?.scale).toBe(1);
			await settle();
		}
	});

	test("the frame on the canvas answers the same time again when it is at least as large", async () => {
		const video = createFakeVideo();
		const { stream, counters } = createStream({ video });
		const small = await ask({ stream, video, index: 4, scale: 0.5 });
		const again = await ask({ stream, video, index: 4, scale: 0.5 });
		const smaller = await ask({ stream, video, index: 4, scale: 0.25 });
		expect(again).toBe(small);
		expect(smaller).toBe(small);
		expect(counters.hits).toBe(2);
		expect(video.log.drawn).toEqual([4]);
	});

	test("a frame drawn small is not the answer to a full-size request: its kept decoded frame is drawn again", async () => {
		const video = createFakeVideo({ keyframeInterval: 30 });
		const { stream, counters } = createStream({ video });
		const playing = await ask({ stream, video, index: 40, scale: 0.25 });
		await settle();
		const restartsBefore = counters.restarts;
		const paused = await ask({ stream, video, index: 40, scale: 1 });
		expect(paused).not.toBe(playing);
		expect(paused?.scale).toBe(1);
		expect(paused?.canvas.scale).toBe(1);
		expect(paused?.timestamp).toBe(playing?.timestamp ?? Number.NaN);
		expect(counters.restarts).toBe(restartsBefore);
		expect(counters.redraws).toBe(1);
		// the paused frame is full size now: asking again for any scale hits it
		const hitsBefore = counters.hits;
		expect(await ask({ stream, video, index: 40, scale: 0.25 })).toBe(paused);
		expect(await ask({ stream, video, index: 40, scale: 1 })).toBe(paused);
		expect(counters.hits).toBe(hitsBefore + 2);
		expect(video.log.drawn.slice(-2)).toEqual([40, 40]);
	});

	test("playing on from a full-size frame keeps drawing small frames at the small scale", async () => {
		const video = createFakeVideo();
		const { stream } = createStream({ video });
		await ask({ stream, video, index: 10, scale: 1 });
		await settle();
		for (let index = 11; index < 15; index++) {
			const frame = await ask({ stream, video, index, scale: 0.25 });
			expect(frame?.scale).toBe(0.25);
			await settle();
		}
		expect(video.log.canvasScales.filter((scale) => scale === 0.25).length).toBeGreaterThan(0);
	});

	test("past the last frame, a frame drawn small is drawn again for a full-size request", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 10 });
		const { stream } = createStream({ video });
		for (let index = 0; index < 10; index++) {
			await ask({ stream, video, index, scale: 0.25 });
			await settle();
		}
		const last = await ask({ stream, video, index: 15, scale: 0.25 });
		expect(last?.scale).toBe(0.25);
		const full = await ask({ stream, video, index: 15, scale: 1 });
		expect(full?.scale).toBe(1);
		expect(Math.round((full?.timestamp ?? 0) * 30)).toBe(9);
	});

	test("a stale frame already on a canvas is shown only when it is big enough", async () => {
		const video = createFakeVideo({ decode: "manual" });
		const { stream, counters } = createStream({ video });
		// one frame delivered: it is on a canvas, nothing decoded waits behind it
		video.release(1);
		const first = await ask({ stream, video, index: 0, scale: 0.25 });
		expect(first?.scale).toBe(0.25);
		await settle();
		// the decoder has not delivered frame 4: the small frame 0 does for a
		// small request within the tolerance ...
		const small = await ask({ stream, video, index: 4, scale: 0.25, maxStaleSeconds: 0.2 });
		expect(small).toBe(first);
		expect(counters.stalePresents).toBe(1);
		// ... but not for a full-size one, which waits for the decoder
		let answer: number | null | undefined;
		void ask({ stream, video, index: 4, scale: 1, maxStaleSeconds: 0.2 }).then((frame) => {
			answer = frame ? frame.scale : null;
		});
		await settle();
		expect(counters.stalePresents).toBe(1);
		expect(answer).toBeUndefined();
		video.release(20);
		await settle();
		await settle();
		expect(answer).toBe(1);
	});

	test("a stale decoded frame is drawn at the scale asked for", async () => {
		const video = createFakeVideo({ decode: "manual" });
		const { stream, counters } = createStream({ video });
		video.release(3);
		await ask({ stream, video, index: 0, scale: 0.25 });
		await settle();
		const stale = await ask({ stream, video, index: 4, scale: 0.25, maxStaleSeconds: 0.1 });
		expect(counters.stalePresents).toBe(1);
		expect(stale?.scale).toBe(0.25);
	});
});

describe("FrameStream: a larger scale while the preview plays", () => {
	// A 60 fps project over a 30 fps video asks for every frame twice. Between
	// the two draws a zoom, a scale animation or a panel resize can move the
	// layer into a larger scale bucket. Decoding the frame again from its key
	// frame would stall the playback for a frame shown for 16 ms; the next new
	// frame is drawn at the new scale anyway. Only an exact request (paused,
	// scrubbing, export, snapshot: tolerance 0) draws it again.
	const LARGER = Math.SQRT1_2 / 2;
	// Inside frame 40, a quarter of a frame after the middle the first draw asked for.
	const secondDrawOf40 = (video: FakeVideo) => video.timeOf(40) + 1 / (4 * video.fps);

	test("the frame on the canvas that covers the time is shown as drawn, without a new decoder", async () => {
		const video = createFakeVideo({ keyframeInterval: 60 });
		const { stream, counters } = createStream({ video });
		const first = await ask({ stream, video, index: 40, scale: 0.25, maxStaleSeconds: 0.1 });
		await settle();
		const opened = video.log.opened.length;
		const restarts = counters.restarts;
		const hits = counters.hits;
		const again = await stream.frameAt({
			time: secondDrawOf40(video),
			maxStaleSeconds: 0.1,
			scale: LARGER,
		});
		expect(again).toBe(first);
		expect(again?.scale).toBe(0.25);
		expect(counters.restarts).toBe(restarts);
		expect(counters.hits).toBe(hits + 1);
		expect(video.log.opened.length).toBe(opened);
		// the next new frame comes from the running decoder, drawn at the new scale
		await settle();
		const next = await ask({ stream, video, index: 41, scale: LARGER, maxStaleSeconds: 0.1 });
		expect(next?.scale).toBe(LARGER);
		expect(Math.round((next?.timestamp ?? 0) * video.fps)).toBe(41);
		expect(counters.restarts).toBe(restarts);
	});

	test("an exact request (tolerance 0) still draws the covered frame again at the larger scale", async () => {
		const video = createFakeVideo({ keyframeInterval: 60 });
		const { stream, counters } = createStream({ video });
		const first = await ask({ stream, video, index: 40, scale: 0.25, maxStaleSeconds: 0.1 });
		await settle();
		const restarts = counters.restarts;
		const exact = await stream.frameAt({ time: secondDrawOf40(video), maxStaleSeconds: 0, scale: LARGER });
		expect(exact).not.toBe(first);
		expect(exact?.scale).toBe(LARGER);
		expect(exact?.timestamp).toBe(first?.timestamp ?? Number.NaN);
		// drawn again from its kept decoded frame, without a new decoder
		expect(counters.restarts).toBe(restarts);
		expect(counters.redraws).toBe(1);
	});

	test("past the last frame while playing, a larger scale keeps the last frame as drawn", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 10 });
		const { stream, counters } = createStream({ video });
		for (let index = 0; index < 10; index++) {
			await ask({ stream, video, index, scale: 0.25, maxStaleSeconds: 0.1 });
			await settle();
		}
		const restarts = counters.restarts;
		const last = await ask({ stream, video, index: 15, scale: 0.5, maxStaleSeconds: 0.1 });
		expect(last?.scale).toBe(0.25);
		expect(Math.round((last?.timestamp ?? 0) * video.fps)).toBe(9);
		expect(counters.restarts).toBe(restarts);
	});

	test("a decoder that ends while a playing request waits past the end keeps the last frame as drawn", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 10, decode: "manual" });
		const { stream, counters } = createStream({ video });
		video.release(10);
		for (let index = 0; index < 10; index++) {
			await ask({ stream, video, index, scale: 0.25, maxStaleSeconds: 0.1 });
			await settle();
		}
		let answer: { index: number; scale: number } | null | undefined;
		void ask({ stream, video, index: 15, scale: 0.5, maxStaleSeconds: 0.1 }).then((frame) => {
			answer = frame ? { index: Math.round(frame.timestamp * video.fps), scale: frame.scale } : null;
		});
		await settle();
		expect(answer).toBeUndefined();
		// the decoder runs out of frames
		video.release(1);
		await settle();
		expect(answer).toEqual({ index: 9, scale: 0.25 });
		expect(counters.restarts).toBe(1);
		expect(video.log.opened.length).toBe(1);
	});
});

describe("FrameStream: the decoder ended before the time asked", () => {
	test("a full-size exact request gets the last frame drawn again at full size, not the small one", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 10, decode: "manual" });
		const { stream, counters } = createStream({ video });
		video.release(10);
		for (let index = 0; index < 10; index++) {
			await ask({ stream, video, index, scale: 0.25, maxStaleSeconds: 0.1 });
			await settle();
		}
		let answer: { index: number; scale: number } | null | undefined;
		void ask({ stream, video, index: 15, scale: 1, maxStaleSeconds: 0 }).then((frame) => {
			answer = frame ? { index: Math.round(frame.timestamp * video.fps), scale: frame.scale } : null;
		});
		await settle();
		expect(answer).toBeUndefined();
		// the decoder runs out of frames while the request waits; the last
		// frame's kept decoded frame is drawn again at full size
		video.release(1);
		await settle();
		expect(answer).toEqual({ index: 9, scale: 1 });
		expect(counters.restarts).toBe(1);
		expect(counters.redraws).toBe(1);
	});
});

describe("FrameStream: a failed redraw at a larger scale", () => {
	// Pausing after playing at preview resolution draws the paused frame again
	// at full size: from its kept decoded frame, else from a new decoder. Here
	// the kept frame cannot be drawn again (`drawnOnce`), and when that decoder
	// fails too, the frame drawn small still shows the right moment: a soft
	// picture beats a missing layer, and a paused preview does not ask again.
	function pausedAfterPlaying({ source, video }: { source: FrameSource<FakeCanvas>; video: FakeVideo }) {
		const counters = createFrameCacheCounters();
		const stream = new FrameStream<FakeCanvas>({
			source: drawnOnce({ source }),
			counters,
			now: () => 0,
			limits: DEFAULT_DECODER_LIMITS,
		});
		const time = video.timeOf(10);
		return { stream, counters, time };
	}

	test("a new decoder that fails before its frame leaves the smaller frame as the answer", async () => {
		const video = createFakeVideo({ decode: "manual", failAtDelivery: 1 });
		const { stream, counters, time } = pausedAfterPlaying({ source: video.source, video });
		const playing = stream.frameAt({ time, maxStaleSeconds: 0.1, scale: 0.25 });
		video.release(1);
		const shown = await playing;
		expect(shown?.scale).toBe(0.25);
		const paused = stream.frameAt({ time, maxStaleSeconds: 0, scale: 1 });
		video.release(1);
		await settle();
		expect(await paused).toBe(shown);
		expect(counters.errors).toBe(1);
		expect(counters.restarts).toBe(2);
		expect(stream.getPresented()).toBe(shown);
		// the next exact request tries again, and this time the decoder works
		const retry = stream.frameAt({ time, maxStaleSeconds: 0, scale: 1 });
		video.release(1);
		const full = await retry;
		expect(full?.scale).toBe(1);
		expect(full?.timestamp).toBe(shown?.timestamp ?? Number.NaN);
	});

	test("a new decoder that cannot even start leaves the smaller frame as the answer", async () => {
		const video = createFakeVideo();
		let opens = 0;
		const source: FrameSource<FakeCanvas> = {
			...video.source,
			openIterator: (args) => {
				opens += 1;
				if (opens === 2) throw new Error("seek failed");
				return video.source.openIterator(args);
			},
		};
		const { stream, counters, time } = pausedAfterPlaying({ source, video });
		const shown = await stream.frameAt({ time, maxStaleSeconds: 0.1, scale: 0.25 });
		await settle();
		const paused = await stream.frameAt({ time, maxStaleSeconds: 0, scale: 1 });
		expect(paused).toBe(shown);
		expect(paused?.scale).toBe(0.25);
		expect(counters.errors).toBe(1);
	});

	test("a frame the stream no longer shows is never the answer: disposed while the redraw waits, nothing", async () => {
		const video = createFakeVideo({ decode: "manual" });
		const { stream, time } = pausedAfterPlaying({ source: video.source, video });
		const playing = stream.frameAt({ time, maxStaleSeconds: 0.1, scale: 0.25 });
		video.release(1);
		expect((await playing)?.scale).toBe(0.25);
		let answer: { scale: number } | null | undefined;
		void stream.frameAt({ time, maxStaleSeconds: 0, scale: 1 }).then((frame) => {
			answer = frame;
		});
		await settle();
		expect(answer).toBeUndefined();
		stream.dispose();
		await settle();
		expect(answer).toBeNull();
	});

	// Past the last frame of the video (a clip longer than its file, a hold at
	// the end): the last frame is the answer, drawn again at full size for an
	// exact request. If that fails, the smaller last frame stays.
	function seekFailsOnSecondOpen({ video }: { video: FakeVideo }): FrameSource<FakeCanvas> {
		let opens = 0;
		return {
			...video.source,
			openIterator: (args) => {
				opens += 1;
				if (opens === 2) throw new Error("seek failed");
				return video.source.openIterator(args);
			},
		};
	}

	test("past the end, after the decoder ended: a failed full-size redraw leaves the smaller last frame", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 10 });
		const { stream, counters } = pausedAfterPlaying({ source: seekFailsOnSecondOpen({ video }), video });
		let last = null;
		for (let index = 0; index < 10; index++) {
			last = await stream.frameAt({ time: video.timeOf(index), maxStaleSeconds: 0.1, scale: 0.25 });
			await settle();
		}
		const paused = await stream.frameAt({ time: video.timeOf(15), maxStaleSeconds: 0, scale: 1 });
		expect(paused).toBe(last);
		expect(paused?.scale).toBe(0.25);
		expect(counters.errors).toBe(1);
	});

	test("past the end, the decoder ending while the request waits: a failed full-size redraw leaves the smaller last frame", async () => {
		const video = createFakeVideo({ fps: 30, frameCount: 10, decode: "manual" });
		const { stream, counters } = pausedAfterPlaying({ source: seekFailsOnSecondOpen({ video }), video });
		video.release(10);
		let last = null;
		for (let index = 0; index < 10; index++) {
			last = await stream.frameAt({ time: video.timeOf(index), maxStaleSeconds: 0.1, scale: 0.25 });
			await settle();
		}
		let answer: unknown;
		void stream.frameAt({ time: video.timeOf(15), maxStaleSeconds: 0, scale: 1 }).then((frame) => {
			answer = frame;
		});
		await settle();
		expect(answer).toBeUndefined();
		// the decoder runs out of frames; the new one cannot start
		video.release(1);
		await settle();
		expect(answer).toBe(last);
		expect(counters.errors).toBe(1);
	});
});
