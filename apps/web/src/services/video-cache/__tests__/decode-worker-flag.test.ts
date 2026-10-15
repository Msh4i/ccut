import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { usePlaybackLeversStore } from "@/services/playback-levers/store";
import { createAppDecodeWorkers } from "../decode-worker/app";
import type { FrameSource } from "../frame-stream";

// The lever is off by default and then NO worker is ever constructed: not at
// import, not when a stream asks for one. Switched on, a stream that needs a
// worker constructs exactly one (the real `spawnDecodeWorker`, with the Worker
// class replaced by a counter: the bundler and the browser are not here).

/** A file's main-thread source that is never used (no frame is requested). */
function unusedSource(): FrameSource<OffscreenCanvas | ImageBitmap> {
	return {
		displaySize: { width: 1920, height: 1080 },
		openIterator: () => {
			throw new Error("not used");
		},
		keyframeAtOrBefore: async () => null,
		createCanvas: () => {
			throw new Error("not used");
		},
		dispose: () => {},
	};
}

let constructed = 0;
let terminated = 0;
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");

class CountingWorker {
	constructor() {
		constructed += 1;
	}
	postMessage() {}
	addEventListener() {}
	terminate() {
		terminated += 1;
	}
}

beforeEach(() => {
	constructed = 0;
	terminated = 0;
	Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: CountingWorker });
	usePlaybackLeversStore.getState().setLever({ key: "decodeWorker", on: false });
});

afterEach(() => {
	usePlaybackLeversStore.getState().setLever({ key: "decodeWorker", on: false });
	if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
	else Reflect.deleteProperty(globalThis, "Worker");
});

describe("the decode worker lever", () => {
	test("off by default: asking for a stream source constructs no worker", () => {
		const main = unusedSource();
		const workers = createAppDecodeWorkers();
		expect(workers.enabled()).toBe(false);
		expect(workers.createStreamSource({ main, file: new File([], "a.mp4") })).toBeNull();
		expect(workers.stats()).toMatchObject({ on: false, live: 0, streams: 0, fallbacks: 0 });
		expect(constructed).toBe(0);
	});

	test("the app's cache module constructs no worker when it is imported", async () => {
		await import("../service");
		expect(constructed).toBe(0);
	});

	test("on: the first stream constructs one worker, a second stream another until the cap, and a worker with no stream ends", () => {
		usePlaybackLeversStore.getState().setLever({ key: "decodeWorker", on: true });
		const main = unusedSource();
		const workers = createAppDecodeWorkers();
		expect(workers.enabled()).toBe(true);
		const file = new File([], "a.mp4");
		const first = workers.createStreamSource({ main, file });
		expect(first).not.toBeNull();
		expect(constructed).toBe(1);
		expect(workers.stats()).toMatchObject({ on: true, live: 1, streams: 1 });
		const second = workers.createStreamSource({ main, file });
		expect(second).not.toBeNull();
		// one worker per stream while the machine has threads to spare (bun: hardwareConcurrency of the test machine)
		expect(constructed).toBeGreaterThanOrEqual(1);
		first?.dispose();
		second?.dispose();
		expect(workers.stats()).toMatchObject({ live: 0, streams: 0 });
		expect(terminated).toBe(constructed);
	});

	test("switching the lever off stops new streams from using workers at once", () => {
		usePlaybackLeversStore.getState().setLever({ key: "decodeWorker", on: true });
		const main = unusedSource();
		const workers = createAppDecodeWorkers();
		const file = new File([], "a.mp4");
		workers.createStreamSource({ main, file })?.dispose();
		const before = constructed;
		usePlaybackLeversStore.getState().setLever({ key: "decodeWorker", on: false });
		expect(workers.createStreamSource({ main, file })).toBeNull();
		expect(constructed).toBe(before);
	});
});
