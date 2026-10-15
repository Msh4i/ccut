import { describe, expect, test } from "bun:test";
import { DEFAULT_DECODER_LIMITS } from "../frame-policy";
import { type FrameSource, FrameStream, createFrameCacheCounters } from "../frame-stream";
import { VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo, settle } from "./fake-video";

// A request waiting for a key frame lookup while the stream's decoder is
// stopped (drawn frames dropped after a GPU context loss) must still be
// answered, and so must the next one (review P4-RB 1: the stream waited for
// a decoder that no longer existed, for good).

const FPS = 30;

function frameIndex(frame: { timestamp: number } | null): number | null {
	return frame ? Math.round(frame.timestamp * FPS) : null;
}

/** Key frame lookups that wait until `open` is called (once armed). */
function gatedKeyframes({ video }: { video: ReturnType<typeof createFakeVideo> }) {
	const state: { gate: (() => void) | null; armed: boolean; lookups: number } = {
		gate: null,
		armed: false,
		lookups: 0,
	};
	const source: FrameSource<FakeCanvas> = {
		...video.source,
		keyframeAtOrBefore: async (args) => {
			state.lookups += 1;
			if (state.armed) {
				await new Promise<void>((resolve) => {
					state.gate = resolve;
				});
			}
			return video.source.keyframeAtOrBefore(args);
		},
	};
	return {
		state,
		source,
		arm: () => {
			state.armed = true;
		},
		open: () => {
			state.armed = false;
			state.gate?.();
		},
	};
}

/** The answer, or "timeout" when none came within `ms` (real time). */
function within<T>({ promise, ms }: { promise: Promise<T>; ms: number }): Promise<T | "timeout"> {
	return Promise.race([
		promise,
		new Promise<"timeout">((resolve) => {
			setTimeout(() => resolve("timeout"), ms);
		}),
	]);
}

describe("a decoder stopped during a key frame lookup", () => {
	test("FrameStream: the waiting request is answered with its own frame", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300 });
		const gated = gatedKeyframes({ video });
		const stream = new FrameStream<FakeCanvas>({
			source: gated.source,
			counters: createFrameCacheCounters(),
			now: () => 0,
			limits: DEFAULT_DECODER_LIMITS,
		});
		expect(frameIndex(await stream.frameAt({ time: video.timeOf(30), maxStaleSeconds: 0 }))).toBe(30);
		await settle();
		gated.arm();
		// 28 frames ahead: the stream asks where the key frame is.
		const pending = stream.frameAt({ time: video.timeOf(58), maxStaleSeconds: 0 });
		await settle();
		expect(gated.state.lookups).toBeGreaterThan(0);
		stream.invalidatePresented();
		gated.open();
		const answer = await within({ promise: pending, ms: 300 });
		expect(answer === "timeout" ? "timeout" : frameIndex(answer)).toBe(58);
		stream.dispose();
	});

	test("VideoCache: after dropDrawnFrames during the lookup, this render and the next are answered", async () => {
		const video = createFakeVideo({ fps: FPS, frameCount: 300 });
		const gated = gatedKeyframes({ video });
		const clock = { now: 0 };
		const cache = new VideoCache<FakeCanvas>({ openSource: async () => gated.source, now: () => clock.now });
		const file = new File([], "m1");
		const ask = (index: number) =>
			cache.getFrameAt({ mediaId: "m1", file, time: video.timeOf(index), streamKey: "a", scale: 1 });
		expect(frameIndex(await ask(30))).toBe(30);
		await settle();
		gated.arm();
		clock.now += 33;
		const pending = ask(58);
		await settle();
		expect(gated.state.lookups).toBeGreaterThan(0);
		cache.dropDrawnFrames();
		gated.open();
		const first = await within({ promise: pending, ms: 300 });
		clock.now += 33;
		const next = await within({ promise: ask(59), ms: 300 });
		expect([first, next].map((answer) => (answer === "timeout" ? "timeout" : frameIndex(answer)))).toEqual([58, 59]);
		cache.clearAll();
	});
});
