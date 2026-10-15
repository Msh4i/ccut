import { describe, expect, test } from "bun:test";
import { WorkerFailure, isWorkerFailure } from "../decode-worker/failure";
import { DEFAULT_DECODER_LIMITS } from "../frame-policy";
import { type FrameSource, FrameStream, type StreamFrame, createFrameCacheCounters } from "../frame-stream";
import { settleHops } from "../decode-worker/__tests__/harness";
import type { FakeCanvas } from "./fake-video";
import { createWorkerBackedVideo } from "./worker-fake-video";

// A FrameStream over a source whose frames live in a decode worker
// (`AsyncDecodedFrame`): the picture comes with an await.

const FPS = 30;
const settle = () => settleHops(40);

type WorkerVideo = ReturnType<typeof createWorkerBackedVideo>;

function createStream({
	video,
	source = video.source,
}: {
	video: WorkerVideo;
	source?: FrameSource<FakeCanvas, StreamFrame<FakeCanvas>>;
}) {
	const counters = createFrameCacheCounters();
	const stream = new FrameStream<FakeCanvas>({
		source,
		counters,
		now: () => 0,
		limits: DEFAULT_DECODER_LIMITS,
		canvases: video.canvases,
	});
	return { stream, counters };
}

const index = (frame: { timestamp: number } | null) => (frame ? Math.round(frame.timestamp * FPS) : null);

describe("FrameStream over a decode worker: pictures", () => {
	test("a preview frame is a picture made in the worker, of the scaled size, not a pooled canvas", async () => {
		const video = createWorkerBackedVideo();
		const { stream } = createStream({ video });
		const frame = await stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0, scale: 0.25 });
		expect(index(frame)).toBe(3);
		expect(frame?.scale).toBe(0.25);
		expect(frame?.canvas.scale).toBe(0.25);
		expect(frame?.canvas.frame).toBe(3);
		expect(frame?.displayWidth).toBe(1920);
		// the picture was drawn in the worker: no canvas of the cache was made for it
		expect(video.log.canvasScales).toEqual([]);
		expect(video.pictures.getStats().live).toBe(1);
		stream.dispose();
	});

	test("a full-size frame is drawn on the main thread into a canvas of the cache, and its VideoFrame is closed", async () => {
		const video = createWorkerBackedVideo();
		const { stream } = createStream({ video });
		const frame = await stream.frameAt({ time: video.timeOf(5), maxStaleSeconds: 0 });
		expect(frame?.canvas.frame).toBe(5);
		expect(frame?.canvas.scale).toBe(1);
		expect(video.log.canvasScales).toEqual([1]);
		expect(video.log.drawn).toEqual([5]);
		expect(video.stats.mainSamplesClosed).toBe(1);
		expect(video.stats.mainSamplesDoubleClosed).toBe(0);
		stream.dispose();
	});

	test("pausing after preview playback draws the kept frame again at full size: no decoder, one redraw", async () => {
		const video = createWorkerBackedVideo();
		const { stream, counters } = createStream({ video });
		const playing = await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0.09, scale: 0.25 });
		await settle();
		const restarts = counters.restarts;
		const opened = video.log.opened.length;
		const paused = await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0, scale: 1 });
		expect(paused).not.toBe(playing);
		expect(paused?.scale).toBe(1);
		expect(paused?.canvas.frame).toBe(40);
		expect(paused?.timestamp).toBe(playing?.timestamp ?? Number.NaN);
		expect(counters.restarts).toBe(restarts);
		expect(counters.redraws).toBe(1);
		expect(video.log.opened.length).toBe(opened);
		// the sample kept in the worker for the redraw is closed again: nothing kept at full size
		expect(stream.heldDecodedBytes()).toBe(stream.readAheadBytes());
		stream.dispose();
		await settle();
		expect(video.openFrames()).toBe(0);
	});

	test("every sample is closed once and every picture is closed once after a play, a pause, a seek and a dispose", async () => {
		const video = createWorkerBackedVideo({ quarantine: 0 });
		const { stream } = createStream({ video });
		for (let step = 0; step < 30; step++) {
			await stream.frameAt({ time: video.timeOf(step), maxStaleSeconds: 0.05, scale: 0.5 });
			await settle();
		}
		await stream.frameAt({ time: video.timeOf(29), maxStaleSeconds: 0, scale: 1 });
		await stream.frameAt({ time: video.timeOf(120), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 1 });
		stream.dispose();
		await settle();
		expect(video.log.doubleClosed).toBe(0);
		expect(video.openFrames()).toBe(0);
		expect(video.world.core.stats().openFrames).toBe(0);
		expect(video.stats.bitmapsDoubleClosed).toBe(0);
		expect(video.stats.mainSamplesDoubleClosed).toBe(0);
		// pictures: none left alive, none closed twice
		expect(video.pictures.getStats().live).toBe(0);
		expect(video.stats.bitmapsClosed).toBeGreaterThan(30);
	});
});

describe("FrameStream over a decode worker: the stream moves on while a picture is made", () => {
	test("a decoder stopped meanwhile: the picture is closed and the request gets no frame", async () => {
		const video = createWorkerBackedVideo({ quarantine: 0 });
		const { stream } = createStream({ video });
		video.control.holdRenders = true;
		const answer = stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		// the stream's decoder is stopped (a GPU context loss) while the worker draws
		stream.invalidatePresented();
		video.control.releaseRenders();
		expect(await answer).toBeNull();
		await settle();
		expect(stream.getPresented()).toBeNull();
		// the picture that arrived was closed, once, and so was every sample
		expect(video.stats.bitmapsClosed).toBe(1);
		expect(video.stats.bitmapsDoubleClosed).toBe(0);
		expect(video.pictures.getStats().live).toBe(0);
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
		stream.dispose();
	});

	test("a stream disposed meanwhile closes the picture and the sample", async () => {
		const video = createWorkerBackedVideo({ quarantine: 0 });
		const { stream } = createStream({ video });
		video.control.holdRenders = true;
		const answer = stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		stream.dispose();
		video.control.releaseRenders();
		expect(await answer).toBeNull();
		await settle();
		expect(video.stats.bitmapsClosed).toBe(1);
		expect(video.pictures.getStats().live).toBe(0);
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
	});

	test("the frame whose picture is being made still counts as decoded memory", async () => {
		const video = createWorkerBackedVideo({ video: { frameBytes: { decoded: 10, drawn: 40 } } });
		const { stream } = createStream({ video });
		video.control.holdRenders = true;
		const answer = stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		const waiting = stream.readAheadBytes();
		// Every decoded frame the worker still holds counts: the read-ahead and the one being drawn.
		const heldWhileDrawing = video.openFrames();
		video.control.releaseRenders();
		await answer;
		await settle();
		expect(heldWhileDrawing).toBeGreaterThan(1);
		expect(waiting).toBe(heldWhileDrawing * 10);
		expect(stream.readAheadBytes()).toBe(video.openFrames() * 10 - stream.keptDecodedBytes());
		stream.dispose();
	});
});

describe("FrameStream over a decode worker: failures", () => {
	test("a second worker failure during the recovery ends the request: no loop, two decoder starts", async () => {
		const video = createWorkerBackedVideo();
		let opened = 0;
		const failing: FrameSource<FakeCanvas, StreamFrame<FakeCanvas>> = {
			...video.source,
			openIterator: ({ startTime }) => {
				opened += 1;
				return {
					next: async () => ({
						done: false,
						value: {
							timestamp: startTime,
							duration: 1 / FPS,
							render: async () => {
								throw new WorkerFailure({ message: "worker lost again" });
							},
							close: () => {},
						},
					}),
					return: async () => undefined,
				};
			},
		};
		const { stream, counters } = createStream({ video, source: failing });
		expect(await stream.frameAt({ time: video.timeOf(4), maxStaleSeconds: 0, scale: 0.25 })).toBeNull();
		expect(opened).toBe(2);
		expect(counters.errors).toBe(2);
		stream.dispose();
	});

	test("a worker that dies while a picture is made: the stream restarts on the main thread and answers", async () => {
		const video = createWorkerBackedVideo();
		const { stream, counters } = createStream({ video });
		video.control.holdRenders = true;
		const answer = stream.frameAt({ time: video.timeOf(7), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		video.world.channel.worker.crash("gpu process lost");
		const frame = await answer;
		expect(index(frame)).toBe(7);
		// the answer came from the main thread's decoder: a canvas of the cache, drawn there
		expect(video.fallbacks).toHaveLength(1);
		expect(video.source.hasFallenBack()).toBe(true);
		expect(frame?.canvas.frame).toBe(7);
		expect(counters.errors).toBeGreaterThanOrEqual(1);
		expect(video.log.opened).toHaveLength(2);
		// every sample the worker held died with it; the main thread's are closed as usual
		stream.dispose();
		await settle();
		expect(video.log.doubleClosed).toBe(0);
		expect(video.stats.bitmapsDoubleClosed).toBe(0);
	});

	test("a worker that dies between frames: the next request is answered by the main thread's decoder", async () => {
		const video = createWorkerBackedVideo();
		const { stream } = createStream({ video });
		expect(index(await stream.frameAt({ time: video.timeOf(0), maxStaleSeconds: 0, scale: 0.5 }))).toBe(0);
		await settle();
		video.world.channel.worker.crash("oom");
		await settle();
		expect(index(await stream.frameAt({ time: video.timeOf(40), maxStaleSeconds: 0, scale: 0.5 }))).toBe(40);
		expect(video.source.hasFallenBack()).toBe(true);
		expect(video.fallbacks).toHaveLength(1);
		// the next ones keep coming from the main thread
		expect(index(await stream.frameAt({ time: video.timeOf(41), maxStaleSeconds: 0, scale: 0.5 }))).toBe(41);
		expect(video.fallbacks).toHaveLength(1);
		stream.dispose();
	});

	test("an error of one draw in the worker is an ordinary error: it is thrown, the frame is closed, nothing falls back", async () => {
		const video = createWorkerBackedVideo({ quarantine: 0 });
		const { stream } = createStream({ video });
		video.control.failRenders = true;
		await expect(stream.frameAt({ time: video.timeOf(2), maxStaleSeconds: 0, scale: 0.25 })).rejects.toThrow(
			"draw failed in the worker",
		);
		expect(video.source.hasFallenBack()).toBe(false);
		expect(video.fallbacks).toHaveLength(0);
		video.control.failRenders = false;
		expect(index(await stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0, scale: 0.25 }))).toBe(3);
		stream.dispose();
		await settle();
		expect(video.openFrames()).toBe(0);
		expect(video.log.doubleClosed).toBe(0);
	});

	test("a dead worker with nothing to fall back to ends the request without looping", async () => {
		const video = createWorkerBackedVideo();
		const { stream } = createStream({ video, source: video.workerOnly });
		video.control.holdRenders = true;
		const answer = stream.frameAt({ time: video.timeOf(2), maxStaleSeconds: 0, scale: 0.25 });
		await settle();
		video.world.channel.worker.crash("gone");
		expect(await answer).toBeNull();
		// the dead worker refuses a new decoder with a worker failure
		let refused: unknown = null;
		try {
			video.workerOnly.openIterator({ startTime: 0 });
		} catch (error) {
			refused = error;
		}
		expect(isWorkerFailure(refused)).toBe(true);
		stream.dispose();
	});

	test("a kept frame that cannot be drawn again because the worker is gone falls back to a new decoder", async () => {
		const video = createWorkerBackedVideo();
		const { stream, counters } = createStream({ video });
		await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0.09, scale: 0.25 });
		await settle();
		video.world.channel.worker.crash("gone");
		await settle();
		const paused = await stream.frameAt({ time: video.timeOf(10), maxStaleSeconds: 0, scale: 1 });
		expect(index(paused)).toBe(10);
		expect(paused?.scale).toBe(1);
		expect(counters.redraws).toBe(0);
		expect(video.source.hasFallenBack()).toBe(true);
		stream.dispose();
	});
});
