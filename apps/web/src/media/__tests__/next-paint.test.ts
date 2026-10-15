import { describe, expect, test } from "bun:test";
import { NEXT_PAINT_FALLBACK_MS, waitForNextPaint } from "../next-paint";
import { createFakeTimers, flushMicrotasks } from "./fake-timers";

function manualFrames() {
	const queue: Array<() => void> = [];
	return {
		requestFrame: (callback: () => void) => {
			queue.push(callback);
		},
		/** Runs the callbacks queued so far (one "frame"). */
		tick: () => {
			for (const callback of queue.splice(0)) callback();
		},
		queued: () => queue.length,
	};
}

describe("waitForNextPaint", () => {
	test("resolves after two animation frames and leaves no timer behind", async () => {
		const timers = createFakeTimers();
		const frames = manualFrames();
		let done = false;
		const promise = waitForNextPaint({ requestFrame: frames.requestFrame, timers }).then(() => {
			done = true;
		});
		frames.tick();
		await flushMicrotasks();
		expect(done).toBe(false);
		frames.tick();
		await promise;
		expect(done).toBe(true);
		expect(timers.pending()).toBe(0);
	});

	test("does not wait forever when frames never come (hidden or occluded window)", async () => {
		const timers = createFakeTimers();
		const frames = manualFrames();
		let done = false;
		const promise = waitForNextPaint({ requestFrame: frames.requestFrame, timers }).then(() => {
			done = true;
		});
		timers.advance(NEXT_PAINT_FALLBACK_MS - 1);
		await flushMicrotasks();
		expect(done).toBe(false);
		timers.advance(1);
		await promise;
		expect(done).toBe(true);
	});

	test("a frame arriving after the fallback is harmless", async () => {
		const timers = createFakeTimers();
		const frames = manualFrames();
		const promise = waitForNextPaint({ requestFrame: frames.requestFrame, timers });
		timers.advance(NEXT_PAINT_FALLBACK_MS);
		await promise;
		frames.tick();
		frames.tick();
		expect(frames.queued()).toBe(0);
	});
});
