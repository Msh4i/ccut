import { describe, expect, spyOn, test } from "bun:test";
import { createFrameTicker } from "@/animation/tiles/ticker";

/** A requestAnimationFrame stand-in: frames run only when the test says so. */
function fakeFrames() {
	const pending = new Map<number, (now: number) => void>();
	let nextHandle = 1;
	let requested = 0;
	let cancelled = 0;
	return {
		requestFrame: (callback: (now: number) => void) => {
			const handle = nextHandle++;
			pending.set(handle, callback);
			requested += 1;
			return handle;
		},
		cancelFrame: (handle: number) => {
			if (pending.delete(handle)) cancelled += 1;
		},
		/** Runs the frames that were pending when called (like one display refresh). */
		runFrame: (now: number) => {
			const due = [...pending];
			pending.clear();
			for (const [, callback] of due) callback(now);
		},
		pendingCount: () => pending.size,
		requestedCount: () => requested,
		cancelledCount: () => cancelled,
	};
}

describe("createFrameTicker: one requestAnimationFrame loop shared by every tile", () => {
	test("asks for no frame while nobody listens", () => {
		const frames = fakeFrames();
		createFrameTicker(frames);
		expect(frames.requestedCount()).toBe(0);
	});

	test("many listeners share one frame, and each gets the frame time", () => {
		const frames = fakeFrames();
		const ticker = createFrameTicker(frames);
		const seen: string[] = [];
		ticker.subscribe((now) => seen.push(`a${now}`));
		ticker.subscribe((now) => seen.push(`b${now}`));
		ticker.subscribe((now) => seen.push(`c${now}`));
		expect(frames.pendingCount()).toBe(1);
		frames.runFrame(16);
		frames.runFrame(32);
		expect(seen).toEqual(["a16", "b16", "c16", "a32", "b32", "c32"]);
		expect(frames.requestedCount()).toBe(3);
	});

	test("the last unsubscribe cancels the pending frame: nothing keeps running", () => {
		const frames = fakeFrames();
		const ticker = createFrameTicker(frames);
		const stopA = ticker.subscribe(() => {});
		const stopB = ticker.subscribe(() => {});
		frames.runFrame(16);
		stopA();
		expect(frames.pendingCount()).toBe(1);
		stopB();
		expect(frames.pendingCount()).toBe(0);
		expect(frames.cancelledCount()).toBe(1);
		frames.runFrame(32);
		expect(frames.requestedCount()).toBe(2);
	});

	test("a listener can unsubscribe itself during a frame", () => {
		const frames = fakeFrames();
		const ticker = createFrameTicker(frames);
		let calls = 0;
		const stop = ticker.subscribe(() => {
			calls += 1;
			stop();
		});
		frames.runFrame(16);
		frames.runFrame(32);
		expect(calls).toBe(1);
		expect(frames.pendingCount()).toBe(0);
	});

	test("unsubscribing twice is harmless and does not stop the others", () => {
		const frames = fakeFrames();
		const ticker = createFrameTicker(frames);
		let calls = 0;
		const stop = ticker.subscribe(() => {});
		ticker.subscribe(() => {
			calls += 1;
		});
		stop();
		stop();
		frames.runFrame(16);
		expect(calls).toBe(1);
		expect(frames.pendingCount()).toBe(1);
	});

	test("subscribing again after everything stopped starts a new loop", () => {
		const frames = fakeFrames();
		const ticker = createFrameTicker(frames);
		ticker.subscribe(() => {})();
		expect(frames.pendingCount()).toBe(0);
		let calls = 0;
		ticker.subscribe(() => {
			calls += 1;
		});
		frames.runFrame(16);
		expect(calls).toBe(1);
	});

	test("a listener that throws is dropped and logged once; the others keep running", () => {
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const frames = fakeFrames();
			const ticker = createFrameTicker(frames);
			let broken = 0;
			let calls = 0;
			ticker.subscribe(() => {
				broken += 1;
				throw new Error("broken tile");
			});
			ticker.subscribe(() => {
				calls += 1;
			});
			frames.runFrame(16);
			frames.runFrame(32);
			frames.runFrame(48);
			expect(broken).toBe(1);
			expect(calls).toBe(3);
			expect(errors).toHaveBeenCalledTimes(1);
			expect(frames.pendingCount()).toBe(1);
		} finally {
			errors.mockRestore();
		}
	});

	test("when the only listener throws, no frame is left pending", () => {
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const frames = fakeFrames();
			const ticker = createFrameTicker(frames);
			ticker.subscribe(() => {
				throw new Error("broken tile");
			});
			frames.runFrame(16);
			expect(frames.pendingCount()).toBe(0);
			expect(errors).toHaveBeenCalledTimes(1);
		} finally {
			errors.mockRestore();
		}
	});
});
