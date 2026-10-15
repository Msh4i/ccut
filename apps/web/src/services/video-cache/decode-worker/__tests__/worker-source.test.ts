import { describe, expect, test } from "bun:test";
import type { FakeCanvas } from "../../__tests__/fake-video";
import { createFakeVideo } from "../../__tests__/fake-video";
import { createWorkerSource } from "../worker-source";
import { WorkerFailure } from "../failure";
import { createWorld, settleHops } from "./harness";

function setup({
	displayInWorker,
	bitmapGrowth = 0,
}: { displayInWorker?: { width: number; height: number }; bitmapGrowth?: number } = {}) {
	const video = createFakeVideo({ displaySize: { width: 1920, height: 1080 } });
	const world = createWorld({
		backendOptions: { display: displayInWorker ?? { width: 1920, height: 1080 }, bitmapGrowth },
	});
	const log = { released: 0, discarded: 0 };
	const sampleCalls: Array<{ rotation: number; width: number }> = [];
	const source = createWorkerSource<FakeCanvas>({
		main: video.source,
		lease: { client: world.client, streamId: 1, release: () => (log.released += 1) },
		file: { name: "clip.mp4" },
		adapters: {
			imageOf: (bitmap) => ({ id: 1, frame: bitmap.width, draws: 0, scale: bitmap.width / 1920, destroyed: false }),
			sampleOf: ({ rotation, display }) => {
				sampleCalls.push({ rotation, width: display.width });
				return { timestamp: 0, duration: 1, drawInto: () => {}, close: () => {} };
			},
			ops: { discard: () => (log.discarded += 1) },
		},
	});
	return { source, world, log, sampleCalls, video };
}

describe("createWorkerSource", () => {
	test("file facts come from the main thread's source; the main thread's source is not disposed", async () => {
		const { source, video } = setup();
		expect(source.displaySize).toEqual({ width: 1920, height: 1080 });
		expect(source.createCanvas({ scale: 0.5 }).scale).toBe(0.5);
		expect(await source.keyframeAtOrBefore({ time: 1.5 })).toBe(1);
		source.dispose();
		expect(video.log.disposed).toBe(false);
	});

	test("a frame renders to a picture of the scaled size, or to a sample at full size, with the worker's rotation", async () => {
		const { source, sampleCalls } = setup();
		const result = await source.openIterator({ startTime: 0 }).next();
		if (result.done || !("render" in result.value)) throw new Error("expected an async frame");
		const small = await result.value.render({ scale: 0.5 });
		expect(small.kind).toBe("image");
		const full = await result.value.render({ scale: 1 });
		expect(full.kind).toBe("sample");
		expect(sampleCalls).toEqual([{ rotation: 0, width: 1920 }]);
	});

	test("a worker that sees the video at another size is a worker failure on the first pull", async () => {
		const { source } = setup({ displayInWorker: { width: 1080, height: 1920 } });
		await expect(source.openIterator({ startTime: 0 }).next()).rejects.toBeInstanceOf(WorkerFailure);
	});

	test("a picture of the wrong size is discarded and is a worker failure, not a wrong layer", async () => {
		const { source, log } = setup({ bitmapGrowth: 1 });
		const result = await source.openIterator({ startTime: 0 }).next();
		if (result.done || !("render" in result.value)) throw new Error("expected an async frame");
		await expect(result.value.render({ scale: 0.5 })).rejects.toBeInstanceOf(WorkerFailure);
		expect(log.discarded).toBe(1);
	});

	test("dispose frees the worker's stream and the place, once", async () => {
		const { source, world, log } = setup();
		await source.openIterator({ startTime: 0 }).next();
		source.dispose();
		source.dispose();
		await settleHops(5);
		expect(log.released).toBe(1);
		expect(world.core.stats().openStreams).toBe(0);
	});
});
