import { describe, expect, spyOn, test } from "bun:test";
import type { HostTimingClip } from "@/tracking/host";
import type { GrayFrame } from "@/tracking/types";
import { mediaTimeFromSeconds } from "@/wasm";
import { renderFrame } from "../../__tests__/synthetic";
import {
	ANALYSIS_MESSAGES,
	analysisFps,
	analysisSourceWindowOf,
	analyze,
	type AnalysisDeps,
	type AnalysisOutcome,
	messageOf,
	PROGRESS_INTERVAL_MS,
} from "../analysis-service";

const W = 160;
const H = 90;
const FPS = 30;

const sec = (seconds: number) => mediaTimeFromSeconds({ seconds });

function hostOf({
	start = 0,
	duration = 10,
	trimStart = 0,
	rate,
	mediaId = "media-1",
}: {
	start?: number;
	duration?: number;
	trimStart?: number;
	rate?: number;
	mediaId?: string;
} = {}): HostTimingClip {
	return {
		mediaId,
		startTime: sec(start),
		duration: sec(duration),
		trimStart: sec(trimStart),
		retime: rate === undefined ? undefined : { rate },
	};
}

function movingFrames({ count, w = W, h = H }: { count: number; w?: number; h?: number }): GrayFrame[] {
	return Array.from({ length: count }, (_, i) => renderFrame({ w, h, dx: 1.5 * i, dy: 0.5 * i }));
}

interface Setup {
	deps: AnalysisDeps;
	decodeCalls: Array<{ file: File; sourceTimes: number[]; signal: AbortSignal }>;
	pulled: () => number;
	released: () => boolean;
	yields: () => number;
	progress: number[];
	onProgress: ({ fraction }: { fraction: number }) => void;
}

function setup({
	frames = movingFrames({ count: 12 }),
	decodeFrames,
	clock,
	onPull,
	onYield,
}: {
	frames?: GrayFrame[];
	decodeFrames?: ({ signal }: { signal: AbortSignal }) => AsyncIterable<GrayFrame>;
	clock?: () => number;
	onPull?: (index: number) => void;
	/** Runs inside the UI hand-over after frame `count` (1-based), before it resolves. */
	onYield?: (count: number) => void;
} = {}): Setup {
	let pulledCount = 0;
	let releasedFlag = false;
	let yieldCount = 0;
	let ids = 0;
	const decodeCalls: Setup["decodeCalls"] = [];
	const progress: number[] = [];
	const deps: AnalysisDeps = {
		decode: ({ file, sourceTimes, signal }) => {
			decodeCalls.push({ file, sourceTimes, signal });
			if (decodeFrames) return decodeFrames({ signal });
			return (async function* () {
				try {
					for (let i = 0; i < sourceTimes.length && i < frames.length; i++) {
						onPull?.(i);
						pulledCount++;
						yield frames[i];
					}
				} finally {
					releasedFlag = true;
				}
			})();
		},
		now: clock ?? (() => 0),
		yieldToUi: async () => {
			yieldCount++;
			onYield?.(yieldCount);
		},
		newId: () => `id-${++ids}`,
	};
	return {
		deps,
		decodeCalls,
		pulled: () => pulledCount,
		released: () => releasedFlag,
		yields: () => yieldCount,
		progress,
		onProgress: ({ fraction }) => {
			progress.push(fraction);
		},
	};
}

const FILE = new File([], "clip.mp4");

/** A few turns of the microtask queue: enough for an async step to reach its next await. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A decoder that is asked for a frame and never answers, nor fails: its `next()` stays pending. */
function silentDecoder({ onReturn }: { onReturn: () => Promise<IteratorResult<GrayFrame>> }): AsyncIterable<GrayFrame> {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => new Promise<IteratorResult<GrayFrame>>(() => {}),
				return: onReturn,
			};
		},
	};
}

/**
 * A decoder whose `next()` always answers at once, as a decoder with its frames
 * ready does: nothing here gives an abort a microtask of its own to be noticed in.
 */
function instantFrames({ frames }: { frames: GrayFrame[] }): AsyncIterable<GrayFrame> {
	return {
		[Symbol.asyncIterator]() {
			let next = 0;
			return {
				next: () =>
					next < frames.length
						? Promise.resolve({ done: false, value: frames[next++] })
						: Promise.resolve({ done: true, value: undefined }),
			};
		},
	};
}

function run({
	s,
	host = hostOf(),
	window = { start: 0, end: 12 / FPS },
	projectFps = FPS,
	signal = new AbortController().signal,
}: {
	s: Setup;
	host?: HostTimingClip;
	window?: { start: number; end: number };
	projectFps?: number;
	signal?: AbortSignal;
}): Promise<AnalysisOutcome> {
	return analyze({
		hostElementId: "host-1",
		host,
		file: FILE,
		window,
		projectFps,
		signal,
		onProgress: s.onProgress,
		deps: s.deps,
	});
}

function complete(outcome: AnalysisOutcome) {
	if (outcome.status !== "complete") throw new Error(`expected a complete analysis, got ${outcome.status}`);
	return outcome.analysis;
}

describe("analysisFps", () => {
	test("is the project rate, capped at 30", () => {
		expect(analysisFps({ projectFps: 24 })).toBe(24);
		expect(analysisFps({ projectFps: 30 })).toBe(30);
		expect(analysisFps({ projectFps: 60 })).toBe(30);
		expect(analysisFps({ projectFps: 29.97 })).toBeCloseTo(29.97, 6);
	});
});

describe("messageOf", () => {
	test("is the message of an Error that has one, nothing for anything else", () => {
		expect(messageOf({ error: new Error("decode boom") })).toBe("decode boom");
		expect(messageOf({ error: new Error("") })).toBeUndefined();
		expect(messageOf({ error: "boom" })).toBeUndefined();
		expect(messageOf({ error: null })).toBeUndefined();
	});
});

describe("analysisSourceWindowOf", () => {
	test("maps a timeline window onto source seconds through trim and rate", () => {
		const host = hostOf({ start: 0.5, trimStart: 1, rate: 2 });
		const window = analysisSourceWindowOf({ host, window: { start: 2.5, end: 4.5 } });
		// 2 s into the clip at 2x, after a 1 s trim: source 5; 4 s in: source 9
		expect(window.start).toBeCloseTo(5, 9);
		expect(window.end).toBeCloseTo(9, 9);
	});
});

describe("analyze", () => {
	test("decodes the window's frames at the analysis rate and hands back a complete analysis", async () => {
		const s = setup();
		const host = hostOf({ start: 0.5, duration: 10, trimStart: 1, rate: 2 });
		const outcome = await run({ s, host, window: { start: 2.5, end: 2.5 + 12 / FPS } });

		const [{ file, sourceTimes }] = s.decodeCalls;
		expect(file).toBe(FILE);
		expect(sourceTimes).toHaveLength(12);
		// 2 s into the clip, trimmed by 1 s, played at 2x: source second 5
		expect(sourceTimes[0]).toBeCloseTo(5, 6);
		expect(sourceTimes[1] - sourceTimes[0]).toBeCloseTo(2 / FPS, 6);

		const analysis = complete(outcome);
		expect(analysis.id).toBe("id-1");
		expect(analysis.hostElementId).toBe("host-1");
		expect(analysis.mediaId).toBe("media-1");
		expect(analysis.sourceStart).toBeCloseTo(5, 6);
		expect(analysis.rate0).toBe(2);
		expect(analysis.status).toBe("complete");
		expect(analysis.tracks.fps).toBe(FPS);
		expect(analysis.tracks.frameCount).toBe(12);
		expect(analysis.tracks.w).toBe(W);
		expect(analysis.tracks.h).toBe(H);
		expect(analysis.tracks.liveOffsets.length).toBe(13);
		expect(s.released()).toBe(true);
	});

	test("the analysis rate is the project rate capped at 30, and the frames are sampled at it", async () => {
		const sixty = setup({ frames: movingFrames({ count: 30 }) });
		const at60 = complete(await run({ s: sixty, projectFps: 60, window: { start: 0, end: 0.4 } }));
		expect(at60.tracks.fps).toBe(30);
		expect(sixty.decodeCalls[0].sourceTimes).toHaveLength(12);
		expect(sixty.decodeCalls[0].sourceTimes[1]).toBeCloseTo(1 / 30, 9);

		const twentyFour = setup({ frames: movingFrames({ count: 30 }) });
		const at24 = complete(await run({ s: twentyFour, projectFps: 24, window: { start: 0, end: 0.5 } }));
		expect(at24.tracks.fps).toBe(24);
		expect(twentyFour.decodeCalls[0].sourceTimes).toHaveLength(12);
		expect(twentyFour.decodeCalls[0].sourceTimes[1]).toBeCloseTo(1 / 24, 9);
	});

	test("a window with no frame in it is a typed failure, without decoding", async () => {
		const s = setup();
		const outcome = await run({ s, window: { start: 3, end: 3 } });
		expect(outcome).toEqual({
			status: "error",
			error: "no-frames",
			message: ANALYSIS_MESSAGES["no-frames"],
		});
		expect(s.decodeCalls).toHaveLength(0);
	});

	test("publishes progress at most every 100 ms, ending at the last frame", async () => {
		expect(PROGRESS_INTERVAL_MS).toBe(100);
		let ticks = 0;
		const quiet = setup({ clock: () => (ticks += 10) });
		await run({ s: quiet });
		// 12 frames, 10 ms apart: the first publish waits for 100 ms, so at most one or two
		expect(quiet.progress.length).toBeLessThanOrEqual(2);

		ticks = 0;
		const lively = setup({ clock: () => (ticks += PROGRESS_INTERVAL_MS) });
		await run({ s: lively });
		expect(lively.progress).toHaveLength(12);
		for (let i = 1; i < lively.progress.length; i++) {
			expect(lively.progress[i]).toBeGreaterThan(lively.progress[i - 1]);
		}
		expect(lively.progress[0]).toBeCloseTo(1 / 12, 9);
		expect(lively.progress[11]).toBe(1);
	});

	test("hands the thread back to the UI once per frame", async () => {
		const s = setup();
		await run({ s });
		expect(s.yields()).toBe(12);
	});

	test("cancelling at frame k stops the decoder there and keeps nothing", async () => {
		const controller = new AbortController();
		const s = setup({
			frames: movingFrames({ count: 60 }),
			onPull: (i) => {
				if (i === 5) controller.abort();
			},
		});
		const outcome = await run({ s, window: { start: 0, end: 2 }, signal: controller.signal });
		expect(outcome).toEqual({ status: "cancelled" });
		expect(s.pulled()).toBeLessThanOrEqual(6);
		// the decoder is asked to let go; nobody waits for it
		await flush();
		expect(s.released()).toBe(true);
		expect("analysis" in outcome).toBe(false);
	});

	test("an abort that lands while the last frame is handed to the UI is a cancel, not a complete analysis", async () => {
		const controller = new AbortController();
		const frames = movingFrames({ count: 12 });
		const s = setup({
			decodeFrames: () => instantFrames({ frames }),
			onYield: (count) => {
				if (count === 12) controller.abort();
			},
		});
		const outcome = await run({ s, signal: controller.signal });
		expect(s.yields()).toBe(12);
		expect(outcome).toEqual({ status: "cancelled" });
		expect("analysis" in outcome).toBe(false);
	});

	test("hands the decoder the abort signal, so it can stop what it is waiting on", async () => {
		const controller = new AbortController();
		const s = setup();
		await run({ s, signal: controller.signal });
		expect(s.decodeCalls[0].signal).toBe(controller.signal);
	});

	test("a decoder that never delivers a frame and never fails is stopped by the abort: cancelled, its teardown asked for", async () => {
		const controller = new AbortController();
		let returns = 0;
		const s = setup({
			decodeFrames: () =>
				silentDecoder({
					onReturn: () => {
						returns++;
						return new Promise<IteratorResult<GrayFrame>>(() => {});
					},
				}),
		});
		const running = run({ s, signal: controller.signal });
		await flush();
		expect(returns).toBe(0);

		controller.abort();
		expect(await running).toEqual({ status: "cancelled" });
		expect(returns).toBe(1);
	}, 1000);

	test("a decoder that stalls after some frames is stopped by the abort too", async () => {
		const controller = new AbortController();
		const frames = movingFrames({ count: 3 });
		const s = setup({
			decodeFrames: () => {
				let next = 0;
				return {
					[Symbol.asyncIterator]: () => ({
						next: () =>
							next < frames.length
								? Promise.resolve({ done: false, value: frames[next++] })
								: new Promise<IteratorResult<GrayFrame>>(() => {}),
					}),
				};
			},
		});
		const running = run({ s, signal: controller.signal });
		await flush();
		expect(s.yields()).toBe(3);

		controller.abort();
		expect(await running).toEqual({ status: "cancelled" });
	}, 1000);

	test("a teardown of the stopped decoder that fails is swallowed: the cancel stands and nothing is left unhandled", async () => {
		const controller = new AbortController();
		const s = setup({
			decodeFrames: () => silentDecoder({ onReturn: () => Promise.reject(new Error("teardown failed")) }),
		});
		const running = run({ s, signal: controller.signal });
		await flush();
		controller.abort();
		expect(await running).toEqual({ status: "cancelled" });
		await flush();
	}, 1000);

	test("a decoder that fails because it was stopped is a cancel, not a decode failure", async () => {
		const controller = new AbortController();
		const s = setup({
			decodeFrames: () => ({
				[Symbol.asyncIterator]: () => ({
					next: () => {
						controller.abort();
						return Promise.reject(new Error("Input has been disposed."));
					},
				}),
			}),
		});
		expect(await run({ s, signal: controller.signal })).toEqual({ status: "cancelled" });
	}, 1000);

	test("an abort during the hand-over to the UI is noticed before the decoder is asked again, even if it then goes silent", async () => {
		const controller = new AbortController();
		const frames = movingFrames({ count: 3 });
		let pulls = 0;
		const s = setup({
			decodeFrames: () => ({
				[Symbol.asyncIterator]: () => ({
					next: () =>
						pulls++ < frames.length
							? Promise.resolve({ done: false, value: frames[pulls - 1] })
							: new Promise<IteratorResult<GrayFrame>>(() => {}),
				}),
			}),
			onYield: (count) => {
				if (count === 3) controller.abort();
			},
		});
		expect(await run({ s, signal: controller.signal })).toEqual({ status: "cancelled" });
		// the decoder was not asked for a fourth frame
		expect(pulls).toBe(3);
	}, 1000);

	test("an abort that lands after the decoder has answered, before the answer is read, still cancels", async () => {
		const controller = new AbortController();
		const s = setup({
			decodeFrames: () => ({
				[Symbol.asyncIterator]: () => ({
					next: () => {
						const answer = Promise.resolve<IteratorResult<GrayFrame>>({ done: true, value: undefined });
						// queued behind the analysis' own reaction to the answer, ahead of its continuation
						void answer.then(() => queueMicrotask(() => controller.abort()));
						return answer;
					},
				}),
			}),
		});
		const outcome = await run({ s, signal: controller.signal });
		expect(outcome).toEqual({ status: "cancelled" });
	}, 1000);

	test("a decode that throws before it hands anything over is a typed failure", async () => {
		const s = setup({
			decodeFrames: () => {
				throw new Error("cannot open the file");
			},
		});
		expect(await run({ s })).toEqual({ status: "error", error: "decode-failed", message: "cannot open the file" });
	});

	test("a decoder is asked to let go after a failure of the analysis, not only after a cancel", async () => {
		const frames = movingFrames({ count: 12 });
		frames[6] = renderFrame({ w: W + 2, h: H });
		const s = setup({ frames });
		const outcome = await run({ s });
		expect(outcome).toMatchObject({ status: "error", error: "decode-failed" });
		await flush();
		expect(s.released()).toBe(true);
	});

	test("a decoder that ran dry is not asked to let go again", async () => {
		let returns = 0;
		const frames = movingFrames({ count: 12 });
		const s = setup({
			decodeFrames: () => {
				let next = 0;
				return {
					[Symbol.asyncIterator]: () => ({
						next: () =>
							Promise.resolve<IteratorResult<GrayFrame>>(
								next < frames.length ? { done: false, value: frames[next++] } : { done: true, value: undefined },
							),
						return: () => {
							returns++;
							return Promise.resolve<IteratorResult<GrayFrame>>({ done: true, value: undefined });
						},
					}),
				};
			},
		});
		complete(await run({ s }));
		expect(returns).toBe(0);
	});

	test("the abort listener of each wait is gone once the wait is over", async () => {
		const controller = new AbortController();
		const added = spyOn(controller.signal, "addEventListener");
		const removed = spyOn(controller.signal, "removeEventListener");
		const s = setup();
		complete(await run({ s, signal: controller.signal }));
		// one wait per frame and one for the end of the stream
		expect(added).toHaveBeenCalledTimes(13);
		expect(removed).toHaveBeenCalledTimes(13);
		for (let i = 0; i < 13; i++) {
			expect(added.mock.calls[i][0]).toBe("abort");
			expect(removed.mock.calls[i][0]).toBe("abort");
			expect(removed.mock.calls[i][1]).toBe(added.mock.calls[i][1]);
		}
	});

	test("an already aborted signal is cancelled before any frame is decoded", async () => {
		const controller = new AbortController();
		controller.abort();
		const s = setup();
		const outcome = await run({ s, signal: controller.signal });
		expect(outcome).toEqual({ status: "cancelled" });
		expect(s.decodeCalls).toHaveLength(0);
	});

	test("a decoder that fails before any frame is a typed failure with its message", async () => {
		const s = setup({
			decodeFrames: async function* () {
				await Promise.reject(new Error("Video codec not supported for decoding"));
				yield movingFrames({ count: 1 })[0];
			},
		});
		const outcome = await run({ s });
		expect(outcome).toEqual({
			status: "error",
			error: "decode-failed",
			message: "Video codec not supported for decoding",
		});
	});

	test("a decoder that fails mid-stream is a typed failure: the frames read so far are dropped", async () => {
		const frames = movingFrames({ count: 12 });
		const s = setup({
			decodeFrames: async function* () {
				for (let i = 0; i < 5; i++) yield frames[i];
				throw new Error("decode boom");
			},
		});
		const outcome = await run({ s });
		expect(outcome).toEqual({ status: "error", error: "decode-failed", message: "decode boom" });
	});

	test("a decoder that fails with something that is not an Error still gives a message", async () => {
		const s = setup({
			decodeFrames: async function* () {
				await Promise.reject("boom");
				yield movingFrames({ count: 1 })[0];
			},
		});
		const outcome = await run({ s });
		expect(outcome).toMatchObject({ status: "error", error: "decode-failed" });
		if (outcome.status === "error") expect(outcome.message).toBe(ANALYSIS_MESSAGES["decode-failed"]);
	});

	test("a frame too small to track is a user error, not a thrown RangeError", async () => {
		const s = setup({ frames: movingFrames({ count: 12, w: 3, h: 3 }) });
		const outcome = await run({ s });
		expect(outcome).toEqual({
			status: "error",
			error: "frame-too-small",
			message: ANALYSIS_MESSAGES["frame-too-small"],
		});
		await flush();
		expect(s.released()).toBe(true);
	});

	test("a frame of another size mid-stream is a decode failure", async () => {
		const frames = movingFrames({ count: 12 });
		frames[6] = renderFrame({ w: W + 2, h: H });
		const s = setup({ frames });
		const outcome = await run({ s });
		expect(outcome).toMatchObject({ status: "error", error: "decode-failed" });
	});
});
