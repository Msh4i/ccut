import { describe, expect, test } from "bun:test";
import { DEFAULT_DECODER_LIMITS } from "../frame-policy";
import { FrameStream, createFrameCacheCounters } from "../frame-stream";
import type { FakeCanvas } from "./fake-video";
import { SOURCE_MODES, type SuiteVideo, videoFactory } from "./worker-fake-video";

/**
 * The whole suite runs twice: on the main-thread source, and on the same fake
 * video decoded behind the decode worker stack (core, fake channel, client,
 * worker source, fallback source; `worker-fake-video.ts`).
 */
for (const mode of SOURCE_MODES) {
	const { createVideo: createFakeVideo, settle } = videoFactory({ mode });

	type FakeVideo = SuiteVideo;

	function createStream({ video }: { video: FakeVideo }) {
		const counters = createFrameCacheCounters();
		const clock = { now: 0 };
		const stream = new FrameStream<FakeCanvas>({
			source: video.source,
			counters,
			now: () => clock.now,
			limits: DEFAULT_DECODER_LIMITS,
			canvases: video.canvases,
		});
		return { stream, counters, clock };
	}

	async function frameIndexAt({
		stream,
		video,
		index,
		maxStaleSeconds = 0,
	}: {
		stream: FrameStream<FakeCanvas>;
		video: FakeVideo;
		index: number;
		maxStaleSeconds?: number;
	}): Promise<number | null> {
		const frame = await stream.frameAt({ time: video.timeOf(index), maxStaleSeconds });
		return frame ? Math.round(frame.timestamp * video.fps) : null;
	}

	describe(`FrameStream [${mode}]: exact frames`, () => {
		test("every request gets the frame that covers its time, forwards and backwards", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			const indices = [0, 1, 2, 5, 5, 6, 40, 41, 3, 4, 100, 299];
			const got: Array<number | null> = [];
			for (const index of indices) {
				got.push(await frameIndexAt({ stream, video, index }));
				await settle();
			}
			expect(got).toEqual(indices);
		});

		test("the frame on the canvas is the frame the request returned", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			for (const index of [0, 1, 7, 2, 50]) {
				const frame = await stream.frameAt({ time: video.timeOf(index), maxStaleSeconds: 0 });
				expect(frame?.canvas.frame).toBe(index);
				await settle();
			}
		});

		test("a 60 Hz playhead over a 30 fps video draws every frame once", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			for (let tick = 0; tick < 120; tick++) {
				const frame = await stream.frameAt({ time: tick / 60 + 1e-4, maxStaleSeconds: 0 });
				expect(Math.round((frame?.timestamp ?? -1) * 30)).toBe(Math.floor(tick / 2));
				await settle();
			}
			expect(video.log.drawn).toEqual(Array.from({ length: 60 }, (_, i) => i));
		});

		test("past the last frame the last frame stays, without restarting the decoder", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 10 });
			const { stream, counters } = createStream({ video });
			for (let index = 0; index < 10; index++) {
				await frameIndexAt({ stream, video, index });
				await settle();
			}
			const hitsBefore = counters.hits;
			for (const index of [12, 15, 40]) {
				expect(await frameIndexAt({ stream, video, index })).toBe(9);
				await settle();
			}
			expect(counters.hits - hitsBefore).toBe(3);
			expect(counters.restarts).toBe(1);
			expect(video.log.opened.length).toBe(1);
		});
	});

	describe(`FrameStream [${mode}]: when the decoder restarts`, () => {
		test("playing from the read-ahead for three seconds, then skipping past it, keeps the decoder", async () => {
			// The old cache only moved its decoder position on a seek or a slow
			// path, so after two seconds of prefetch hits a skip past the prefetched
			// frame restarted the decoder from the previous key frame inside the
			// render. Here the read-ahead ends at frame 97; frame 100 is 0.1 s past it.
			const video = createFakeVideo({ fps: 30, frameCount: 600 });
			const { stream, counters } = createStream({ video });
			for (let index = 0; index < 90; index++) {
				await frameIndexAt({ stream, video, index });
				await settle();
			}
			expect(counters.readAheadHits).toBe(89);
			expect(await frameIndexAt({ stream, video, index: 100 })).toBe(100);
			expect(counters.advances).toBe(1);
			expect(counters.restarts).toBe(1);
			expect(video.log.opened).toEqual([video.timeOf(0)]);
		});

		test("frames the playhead jumps over are dropped without being drawn", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream, counters } = createStream({ video });
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			expect(await frameIndexAt({ stream, video, index: 12 })).toBe(12);
			expect(video.log.drawn).toEqual([0, 12]);
			expect(counters.skipped).toBe(11);
			expect(counters.restarts).toBe(1);
		});

		test("a backward jump restarts the decoder at the new time", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream, counters } = createStream({ video });
			await frameIndexAt({ stream, video, index: 50 });
			await settle();
			expect(await frameIndexAt({ stream, video, index: 20 })).toBe(20);
			expect(counters.restarts).toBe(2);
			expect(video.log.opened).toEqual([video.timeOf(50), video.timeOf(20)]);
		});

		test("a jump beyond the bounded window restarts without a key frame lookup", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 900, keyframeInterval: 300 });
			const { stream, counters } = createStream({ video });
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			const far = Math.ceil((DEFAULT_DECODER_LIMITS.maxAdvanceSeconds + 1) * 30);
			expect(await frameIndexAt({ stream, video, index: far })).toBe(far);
			expect(counters.restarts).toBe(2);
			expect(video.log.keyframeLookups).toBe(0);
		});

		test("in the middle range a key frame close to the target restarts the decoder", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 900, keyframeInterval: 30 });
			const { stream, counters } = createStream({ video });
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			// frontier ~ frame 8; target 2.33 s; key frame at 2 s
			expect(await frameIndexAt({ stream, video, index: 70 })).toBe(70);
			expect(video.log.keyframeLookups).toBe(1);
			expect(counters.restarts).toBe(2);
		});

		test("in the middle range a far key frame (long GOP) keeps the running decoder", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 900, keyframeInterval: 300 });
			const { stream, counters } = createStream({ video });
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			expect(await frameIndexAt({ stream, video, index: 70 })).toBe(70);
			expect(video.log.keyframeLookups).toBe(1);
			expect(counters.restarts).toBe(1);
			expect(counters.advances).toBe(1);
			expect(video.log.drawn).toEqual([0, 70]);
		});

		test("a decoder error makes the next request restart the decoder", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, failAtDelivery: 4 });
			const { stream, counters } = createStream({ video });
			expect(await frameIndexAt({ stream, video, index: 0 })).toBe(0);
			await settle();
			expect(counters.errors).toBe(1);
			expect(await frameIndexAt({ stream, video, index: 6 })).toBe(6);
			expect(counters.restarts).toBe(2);
		});

		test("a decoder error while a request waits restarts the decoder instead of hanging the request", async () => {
			// Frames 0 to 2 come out, the decoder fails on the next one, and the
			// request for frame 9 is waiting behind it (the test above only fails the
			// decoder after its request returned).
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual", failAtDelivery: 3 });
			const { stream, counters } = createStream({ video });
			video.release(3);
			expect(await frameIndexAt({ stream, video, index: 0 })).toBe(0);
			await settle();
			let result: number | null | undefined;
			void frameIndexAt({ stream, video, index: 9 }).then((index) => {
				result = index;
			});
			await settle();
			expect(result).toBeUndefined();
			video.release(1);
			await settle();
			expect(counters.errors).toBe(1);
			expect(result).toBe(9);
			expect(counters.restarts).toBe(2);
			expect(video.log.opened).toEqual([video.timeOf(0), video.timeOf(9)]);
		});

		test("a frame decoded right before a decoder error still answers the request waiting for it", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual", failAtDelivery: 2 });
			const { stream, counters } = createStream({ video });
			video.release(1);
			expect(await frameIndexAt({ stream, video, index: 0 })).toBe(0);
			await settle();
			let result: number | null | undefined;
			void frameIndexAt({ stream, video, index: 1 }).then((index) => {
				result = index;
			});
			await settle();
			expect(result).toBeUndefined();
			// frame 1 comes out, then the decoder fails on the next one: the request
			// takes frame 1 and does not start a new decoder for nothing
			video.release(2);
			await settle();
			expect(counters.errors).toBe(1);
			expect(result).toBe(1);
			expect(video.log.opened).toEqual([video.timeOf(0)]);
		});

		test("a decoder that ends while a request waits for a time past the end keeps the last frame", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 10, decode: "manual" });
			const { stream, counters } = createStream({ video });
			video.release(10);
			for (let index = 0; index < 10; index++) {
				await frameIndexAt({ stream, video, index });
				await settle();
			}
			let result: number | null | undefined;
			void frameIndexAt({ stream, video, index: 15 }).then((index) => {
				result = index;
			});
			await settle();
			expect(result).toBeUndefined();
			// the decoder runs out of frames
			video.release(1);
			await settle();
			expect(result).toBe(9);
			expect(counters.restarts).toBe(1);
			expect(video.log.opened.length).toBe(1);
		});

		test("a decoder that fails before its first frame ends the request, and the next request starts over", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, failAtDelivery: 0 });
			const { stream, counters } = createStream({ video });
			let result: number | null | undefined;
			void frameIndexAt({ stream, video, index: 5 }).then((index) => {
				result = index;
			});
			await settle();
			expect(result).toBeNull();
			expect(counters.errors).toBe(1);
			expect(await frameIndexAt({ stream, video, index: 5 })).toBe(5);
			expect(counters.restarts).toBe(2);
		});
	});

	describe(`FrameStream [${mode}]: playback tolerance`, () => {
		test("a frame not decoded yet is replaced by the newest decoded one at most maxStale old", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
			const { stream, counters } = createStream({ video });
			video.release(3);
			expect(await frameIndexAt({ stream, video, index: 0 })).toBe(0);
			await settle();
			// frames 1 and 2 wait in the read-ahead; frame 4 is not decoded yet.
			// Frame 2 ended at 0.1 s, 0.05 s before the request.
			expect(
				await frameIndexAt({ stream, video, index: 4, maxStaleSeconds: 0.1 }),
			).toBe(2);
			expect(counters.stalePresents).toBe(1);
			expect(counters.restarts).toBe(1);
		});

		test("an older frame than maxStale is not shown: the request waits for the decoder", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
			const { stream } = createStream({ video });
			video.release(3);
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			let result: number | null | undefined;
			void frameIndexAt({ stream, video, index: 9, maxStaleSeconds: 0.1 }).then((index) => {
				result = index;
			});
			await settle();
			expect(result).toBeUndefined();
			video.release(20);
			await settle();
			expect(result).toBe(9);
		});

		test("without a tolerance the request waits for the exact frame", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
			const { stream, counters } = createStream({ video });
			video.release(3);
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			let result: number | null | undefined;
			void frameIndexAt({ stream, video, index: 4 }).then((index) => {
				result = index;
			});
			await settle();
			expect(result).toBeUndefined();
			video.release(2);
			await settle();
			expect(result).toBe(4);
			expect(counters.stalePresents).toBe(0);
		});

		test("at the exact start of a frame not decoded yet, an exact request waits for it", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
			const { stream } = createStream({ video });
			video.release(3);
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			// frame 2 ends exactly where frame 3 starts: it is not the frame at 3/30
			let result: number | null | undefined;
			void stream.frameAt({ time: 3 / 30, maxStaleSeconds: 0 }).then((frame) => {
				result = frame ? Math.round(frame.timestamp * 30) : null;
			});
			await settle();
			expect(result).toBeUndefined();
			video.release(1);
			await settle();
			expect(result).toBe(3);
		});

		test("the time spent waiting for the decoder is counted", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300, decode: "manual" });
			const { stream, counters, clock } = createStream({ video });
			video.release(1);
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			const waitBefore = counters.waitMs;
			clock.now = 100;
			const pending = frameIndexAt({ stream, video, index: 1 });
			await settle();
			clock.now = 140;
			video.release(1);
			expect(await pending).toBe(1);
			expect(counters.waitMs - waitBefore).toBe(40);
			expect(counters.maxWaitMs).toBeGreaterThanOrEqual(40);
		});
	});

	describe(`FrameStream [${mode}]: bounded resources`, () => {
		test("the read-ahead holds at most a quarter second of decoded frames, at most 8", async () => {
			for (const [fps, expected] of [
				[24, 6],
				[30, 8],
				[60, 8],
			]) {
				const video = createFakeVideo({ fps, frameCount: 600 });
				const { stream } = createStream({ video });
				await frameIndexAt({ stream, video, index: 0 });
				await settle();
				await settle();
				expect(video.openFrames()).toBe(expected);
				stream.dispose();
			}
		});

		test("at most three canvases, and presenting the same frame again draws nothing", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			const first = await stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0 });
			const again = await stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0 });
			expect(again).toBe(first);
			expect(video.log.drawn).toEqual([3]);
			for (let index = 4; index < 20; index++) {
				await frameIndexAt({ stream, video, index });
				await settle();
			}
			expect(video.log.canvases).toBe(3);
		});

		test("the last three presented frames sit on three different canvases and keep their pictures", async () => {
			// A canvas is drawn over again only three requests later: the blur
			// backdrop and the video of one render, and the frame the renderer is
			// still compositing, must not share one.
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			const shown: Array<{ index: number; canvas: FakeCanvas }> = [];
			for (let index = 0; index < 10; index++) {
				const frame = await stream.frameAt({ time: video.timeOf(index), maxStaleSeconds: 0 });
				if (frame) shown.push({ index, canvas: frame.canvas });
				await settle();
			}
			expect(shown.length).toBe(10);
			for (let end = 3; end <= shown.length; end++) {
				const lastThree = shown.slice(end - 3, end);
				expect(new Set(lastThree.map(({ canvas }) => canvas)).size).toBe(3);
			}
			for (const { index, canvas } of shown.slice(-3)) {
				expect(canvas.frame).toBe(index);
			}
		});

		test("every frame handed out is closed exactly once, also after dispose", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			for (const index of [0, 1, 2, 30, 31, 5, 80]) {
				await frameIndexAt({ stream, video, index });
				await settle();
			}
			stream.dispose();
			await settle();
			expect(video.openFrames()).toBe(0);
			expect(video.log.doubleClosed).toBe(0);
			expect(video.log.disposed).toBe(true);
			expect(await stream.frameAt({ time: video.timeOf(81), maxStaleSeconds: 0 })).toBeNull();
		});

		test("a restart closes the frames of the old decoder", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream } = createStream({ video });
			await frameIndexAt({ stream, video, index: 100 });
			await settle();
			await frameIndexAt({ stream, video, index: 10 });
			await settle();
			// only the new decoder's read-ahead is still open
			expect(video.openFrames()).toBe(8);
			expect(video.log.returned).toBe(1);
		});
	});

	describe(`FrameStream [${mode}]: canvases leave the stream, read-ahead policy`, () => {
		function createLeasedStream({
			video,
			readAhead,
		}: {
			video: FakeVideo;
			readAhead?: () => { seconds: number; maxBytes: number };
		}) {
			const counters = createFrameCacheCounters();
			const retired: Array<{ index: number; canvas: FakeCanvas }> = [];
			const released: FakeCanvas[] = [];
			const handedOut: FakeCanvas[] = [];
			let created = 0;
			const stream = new FrameStream<FakeCanvas>({
				source: video.source,
				counters,
				now: () => 0,
				limits: DEFAULT_DECODER_LIMITS,
				canvases: {
					acquire: ({ scale }) => {
						created += 1;
						return { id: 1000 + created, frame: null, draws: 0, scale, destroyed: false };
					},
					noteHandOut: ({ canvas }) => handedOut.push(canvas),
					release: ({ canvas }) => released.push(canvas),
				},
				retire: (frame) =>
					retired.push({ index: Math.round(frame.timestamp * video.fps), canvas: frame.canvas }),
				readAhead,
			});
			return { stream, counters, retired, released, handedOut };
		}

		test("the frame a stream stops showing is retired with its canvas, which the stream never draws into again", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream, retired } = createLeasedStream({ video });
			for (let index = 0; index < 12; index++) {
				await frameIndexAt({ stream, video, index });
				await settle();
			}
			expect(retired.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			for (const { index, canvas } of retired) {
				expect(canvas.frame).toBe(index);
				expect(canvas.draws).toBe(1);
			}
			stream.dispose();
			expect(retired.map(({ index }) => index).at(-1)).toBe(11);
		});

		test("every frame answered is noted as handed out, hits included", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const { stream, handedOut } = createLeasedStream({ video });
			const first = await stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0 });
			const again = await stream.frameAt({ time: video.timeOf(3), maxStaleSeconds: 0 });
			expect(again).toBe(first);
			expect(handedOut).toEqual(first ? [first.canvas, first.canvas] : []);
		});

		// A frame the main thread draws itself; a worker frame that cannot be drawn is in stream-async.test.ts.
		test.skipIf(mode === "worker")("a canvas whose frame could not be drawn goes straight back, and nothing is retired", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 300 });
			const failing = {
				...video,
				source: {
					...video.source,
					openIterator: ({ startTime }: { startTime: number }) => {
						const iterator = video.source.openIterator({ startTime });
						return {
							...iterator,
							next: async () => {
								const result = await iterator.next();
								if (result.done) return result;
								return {
									done: false,
									value: {
										...result.value,
										drawInto: () => {
											throw new Error("canvas lost");
										},
									},
								};
							},
						};
					},
				},
			};
			const { stream, retired, released } = createLeasedStream({ video: failing });
			await expect(stream.frameAt({ time: video.timeOf(2), maxStaleSeconds: 0 })).rejects.toThrow("canvas lost");
			expect(released.length).toBe(1);
			expect(retired).toEqual([]);
			expect(stream.getPresented()).toBeNull();
			stream.dispose();
			expect(video.openFrames()).toBe(0);
		});

		test.each([
			// fps, seconds, maxBytes (decoded frame: 10 bytes), expected frames
			[30, 0.5, Number.POSITIVE_INFINITY, 8],
			[12, 0.5, Number.POSITIVE_INFINITY, 6],
			[30, 0, Number.POSITIVE_INFINITY, 2],
			[30, 0.25, 30, 3],
			[30, 0.25, 5, 2],
		])("at %i fps, %f s and %f bytes the read-ahead holds %i frames", async (fps, seconds, maxBytes, expected) => {
			const video = createFakeVideo({ fps, frameCount: 600, frameBytes: { decoded: 10, drawn: 40 } });
			const { stream } = createLeasedStream({ video, readAhead: () => ({ seconds, maxBytes }) });
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			await settle();
			expect(video.openFrames()).toBe(expected);
			expect(stream.readAheadBytes()).toBe(expected * 10);
			stream.dispose();
		});

		test("without frame sizes from the source, read-ahead bytes use the 1080p estimate", async () => {
			const video = createFakeVideo({ fps: 30, frameCount: 600 });
			const { stream } = createLeasedStream({ video });
			await frameIndexAt({ stream, video, index: 0 });
			await settle();
			await settle();
			expect(stream.readAheadBytes()).toBe(8 * 1920 * 1080 * 1.5);
			stream.dispose();
		});
	});
}
