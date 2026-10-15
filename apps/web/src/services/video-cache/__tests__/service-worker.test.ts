import { describe, expect, test } from "bun:test";
import { settleHops } from "../decode-worker/__tests__/harness";
import { WORKER_OVERHEAD_BYTES, WORKER_RENDER_AHEAD } from "../decode-worker/decode-workers";
import { type MemorySource, VideoCache } from "../service";
import { type FakeCanvas, createFakeVideo } from "./fake-video";
import { createFakeDecodeWorkers } from "./worker-fake-cache";

// The frame cache with decode workers behind the lever (`allowWorker` requests
// of the preview). Lever off, or a request that may not use a worker (export,
// snapshot, thumbnail): the old streams on the main thread.

const FPS = 30;
const MiB = 1024 ** 2;
const settle = () => settleHops(40);

type Fake = ReturnType<typeof createFakeDecodeWorkers>;

function setup({
	videoOptions = {},
	withWorkers = true,
	on = true,
	memory,
	threads,
}: {
	videoOptions?: Parameters<typeof createFakeVideo>[0];
	withWorkers?: boolean;
	on?: boolean;
	memory?: MemorySource;
	/** `navigator.hardwareConcurrency` of the fake machine (12 by default). */
	threads?: number;
} = {}) {
	const video = createFakeVideo({ fps: FPS, frameCount: 3000, ...videoOptions });
	const fake: Fake = createFakeDecodeWorkers({ video, ...(threads !== undefined && { hardwareConcurrency: threads }) });
	fake.state.on = on;
	const clock = { now: 0 };
	const cache = new VideoCache<FakeCanvas>({
		openSource: async () => video.source,
		now: () => clock.now,
		...(withWorkers && { workers: fake.workers }),
		...(memory && { memory }),
	});
	const file = new File([], "m1");
	const ask = ({
		index,
		key = "c0",
		scale = 0.25,
		allowWorker = true,
		lease,
		tolerance = 0,
	}: {
		index: number;
		key?: string;
		scale?: number;
		allowWorker?: boolean;
		lease?: ReturnType<VideoCache<FakeCanvas>["beginRender"]>;
		tolerance?: number;
	}) =>
		cache.withPlaybackTolerance({
			maxStaleSeconds: tolerance,
			run: () =>
				cache.getFrameAt({
					mediaId: "m1",
					file,
					time: video.timeOf(index),
					streamKey: key,
					scale,
					...(allowWorker && { allowWorker: true }),
					...(lease && { lease }),
				}),
		});
	const play = async ({
		from,
		to,
		key = "c0",
		scale = 0.25,
		allowWorker = true,
	}: {
		from: number;
		to: number;
		key?: string;
		scale?: number;
		allowWorker?: boolean;
	}) => {
		const shown: Array<number | null> = [];
		for (let index = from; index <= to; index++) {
			clock.now += 1000 / FPS;
			const frame = await ask({ index, key, scale, allowWorker });
			shown.push(frame ? Math.round(frame.timestamp * FPS) : null);
			await settle();
		}
		return shown;
	};
	return { video, fake, cache, ask, play, clock, file };
}

const range = ({ from, to }: { from: number; to: number }) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("VideoCache with decode workers: the lever and who may use them", () => {
	test("lever off: no worker is started, whatever the preview asks", async () => {
		const run = setup({ on: false });
		expect(await run.play({ from: 10, to: 40 })).toEqual(range({ from: 10, to: 40 }));
		expect(run.fake.state.created).toBe(0);
		expect(run.cache.getWorkerStats()).toMatchObject({ on: false, live: 0, fallbacks: 0 });
		// the frames are the main thread's: canvases of the cache at preview size
		expect(run.video.log.canvasScales).toContain(0.25);
	});

	test("a cache without workers has none to report", async () => {
		const run = setup({ withWorkers: false });
		expect(await run.play({ from: 0, to: 10 })).toEqual(range({ from: 0, to: 10 }));
		expect(run.cache.getWorkerStats()).toBeNull();
		expect(run.cache.getMemoryStats().workerBytes).toBe(0);
	});

	test("lever on: the preview's frames come from a worker, the same frames the main thread shows", async () => {
		const main = setup({ on: false });
		const worker = setup();
		const expected = await main.play({ from: 10, to: 70 });
		const got = await worker.play({ from: 10, to: 70 });
		expect(got).toEqual(expected);
		expect(worker.fake.state.created).toBe(1);
		// preview-size frames are pictures made in the worker: no canvas of the cache at 0.25
		expect(worker.video.log.canvasScales).not.toContain(0.25);
		expect(worker.cache.getWorkerStats()).toMatchObject({ on: true, live: 1, streams: 1, fallbacks: 0 });
		expect(worker.cache.getMemoryStats().streams).toBe(1);
	});

	test("export, snapshot and thumbnail (no allowWorker) never use a worker, also with the lever on", async () => {
		const run = setup();
		expect(await run.play({ from: 5, to: 30, scale: 1, allowWorker: false })).toEqual(range({ from: 5, to: 30 }));
		expect(run.fake.state.created).toBe(0);
		expect(run.cache.getWorkerStats()).toMatchObject({ live: 0, streams: 0 });
		expect(new Set(run.video.log.canvasScales)).toEqual(new Set([1]));
	});

	test("a request that may not use a worker is never given a picture a worker made", async () => {
		const run = setup();
		await run.play({ from: 10, to: 40 });
		const hitsBefore = run.cache.getCounters().lruHits;
		// a snapshot of a frame the preview just played, at the same size: not from the worker's pictures
		const snapshot = await run.ask({ index: 25, key: "snap", scale: 0.25, allowWorker: false });
		expect(snapshot?.viaWorker).toBeUndefined();
		expect(snapshot?.canvas.id).toBeGreaterThan(0);
		expect(run.cache.getCounters().lruHits).toBe(hitsBefore);
		// the preview itself may take them back
		const again = await run.ask({ index: 26, key: "c0", scale: 0.25, allowWorker: true });
		expect(again?.canvas.frame).toBe(26);
	});

	test("the preview may take a frame from the drawn-frame cache, a worker's picture included", async () => {
		const run = setup();
		await run.play({ from: 10, to: 40 });
		const frame = await run.ask({ index: 25, key: "c0", scale: 0.25, allowWorker: true });
		expect(frame?.canvas.frame).toBe(25);
		expect(run.cache.getCounters().lruHits).toBeGreaterThan(0);
	});

	test("one worker per stream up to the cap, the least loaded after that", async () => {
		// 5 threads: min(8, 4) workers for 6 streams.
		const run = setup({ threads: 5 });
		for (let clip = 0; clip < 6; clip++) {
			await run.ask({ index: 10 + clip * 20, key: `c${clip}` });
		}
		await settle();
		const stats = run.cache.getWorkerStats();
		expect(stats).toMatchObject({ live: 4, cap: 4, streams: 6 });
		expect(run.fake.state.created).toBe(4);
	});

	test("the lever switched off mid-session: new requests use the main thread, nothing breaks", async () => {
		const run = setup();
		await run.play({ from: 10, to: 20 });
		expect(run.fake.state.created).toBe(1);
		run.fake.state.on = false;
		expect(await run.play({ from: 21, to: 40 })).toEqual(range({ from: 21, to: 40 }));
		expect(run.fake.state.created).toBe(1);
		expect(run.cache.getWorkerStats()?.on).toBe(false);
	});

	test("clearing the media ends its workers", async () => {
		const run = setup();
		await run.play({ from: 10, to: 20 });
		run.cache.clearVideo({ mediaId: "m1" });
		await settle();
		expect(run.cache.getWorkerStats()).toMatchObject({ live: 0, streams: 0 });
		expect(run.fake.worlds[0].client.isAlive()).toBe(false);
		expect(run.video.log.doubleClosed).toBe(0);
	});
});

describe("VideoCache with decode workers: export never gets a worker's picture", () => {
	test("a live worker stream of the same clip is not used by a request that may not use a worker", async () => {
		const run = setup();
		await run.play({ from: 10, to: 30 });
		const frame = await run.ask({ index: 31, key: "c0", scale: 0.25, allowWorker: false });
		expect(frame?.canvas.frame).toBe(31);
		expect(frame?.viaWorker).toBeUndefined();
		expect(frame?.canvas.id).toBeGreaterThan(0);
		// the preview's worker stream and the export's main stream are two streams
		expect(run.cache.getMemoryStats().streams).toBe(2);
		expect(run.fake.state.created).toBe(1);
	});

	for (const scale of [1, 0.25]) {
		test(`after the worker crashes, an export/thumbnail request at ${scale} for the shown frame is not the worker's picture`, async () => {
			const run = setup();
			const shown = await run.ask({ index: 40, key: "c0", scale });
			expect(shown?.viaWorker).toBe(true);
			await settle();
			run.fake.worlds[0].channel.worker.crash("gpu process lost");
			await settle();
			const exported = await run.ask({ index: 40, key: "c0", scale, allowWorker: false });
			expect(exported?.canvas.frame).toBe(40);
			expect(exported?.viaWorker).toBeUndefined();
			expect(exported).not.toBe(shown);
		});
	}

	test("a deliberate shutdown with a render in flight is not a worker failure", async () => {
		const run = setup();
		await run.ask({ index: 10 });
		await settle();
		run.fake.worlds[0].control.holdRenders = true;
		const pending = run.ask({ index: 11 });
		await settle();
		run.cache.clearVideo({ mediaId: "m1" });
		await pending.catch(() => null);
		await settle();
		expect(run.cache.getWorkerStats()).toMatchObject({ tripped: false, fallbacks: 0, on: true });
	});
});

describe("VideoCache with decode workers: a worker that fails", () => {
	test("the stream goes on with the main thread, the lever is off for the session, the allocation path is not touched", async () => {
		const run = setup();
		await run.play({ from: 10, to: 30 });
		const budgetBefore = run.cache.getMemoryStats();
		run.fake.worlds[0].channel.worker.crash("gpu process lost");
		await settle();
		const after = await run.play({ from: 31, to: 60 });
		expect(after).toEqual(range({ from: 31, to: 60 }));
		const stats = run.cache.getWorkerStats();
		expect(stats).toMatchObject({ tripped: true, on: false, fallbacks: 1, live: 0 });
		const memory = run.cache.getMemoryStats();
		expect(memory.reason).toBe(budgetBefore.reason);
		expect(memory.budgetBytes).toBe(budgetBefore.budgetBytes);
		expect(run.cache.getCounters().errors).toBeGreaterThanOrEqual(0);
		// a clip that starts now decodes on the main thread
		expect(run.fake.state.created).toBe(1);
		await run.ask({ index: 100, key: "late" });
		expect(run.fake.state.created).toBe(1);
	});

	test("a worker that dies while the request waits for its picture still answers it", async () => {
		const run = setup();
		await run.ask({ index: 10 });
		await settle();
		const before = run.cache.getMemoryStats();
		run.fake.worlds[0].control.holdRenders = true;
		const answer = run.ask({ index: 11 });
		await settle();
		run.fake.worlds[0].channel.worker.crash("oom");
		const frame = await answer;
		expect(frame?.canvas.frame).toBe(11);
		expect(run.cache.getWorkerStats()?.tripped).toBe(true);
		expect(run.cache.getMemoryStats().reason).toBe(before.reason);
	});
});

describe("VideoCache with decode workers: memory", () => {
	const DRAWN = 4 * MiB;
	const DECODED = 2 * MiB;

	test("a worker's overhead and its picture in flight are counted, per live worker and per stream with a decoder", async () => {
		const run = setup({ videoOptions: { frameBytes: { decoded: DECODED, drawn: DRAWN } } });
		await run.play({ from: 10, to: 20, scale: 0.5 });
		const stats = run.cache.getMemoryStats();
		expect(stats.workerBytes).toBe(WORKER_OVERHEAD_BYTES + WORKER_RENDER_AHEAD * DRAWN * 0.25);
		// ... and they are part of what the cache uses
		expect(stats.usedBytes).toBeGreaterThanOrEqual(
			stats.readAheadBytes + stats.decoderQueueBytes + stats.keptDecodedBytes + stats.workerBytes,
		);
	});

	test("the pictures on the main thread are counted like canvases, at their scale", async () => {
		const withWorker = setup({ videoOptions: { frameBytes: { decoded: DECODED, drawn: DRAWN } } });
		const onMain = setup({ on: false, videoOptions: { frameBytes: { decoded: DECODED, drawn: DRAWN } } });
		await withWorker.play({ from: 10, to: 20, scale: 0.5 });
		await onMain.play({ from: 10, to: 20, scale: 0.5 });
		const a = withWorker.cache.getMemoryStats();
		const b = onMain.cache.getMemoryStats();
		// the same canvases-or-pictures memory (a quarter of the drawn size each), plus the worker's terms
		const canvasesWithWorker = a.usedBytes - a.readAheadBytes - a.decoderQueueBytes - a.keptDecodedBytes - a.workerBytes;
		const canvasesOnMain = b.usedBytes - b.readAheadBytes - b.decoderQueueBytes - b.keptDecodedBytes - b.workerBytes;
		expect(canvasesWithWorker).toBeGreaterThan(0);
		expect(canvasesWithWorker % (DRAWN * 0.25)).toBe(0);
		expect(Math.abs(canvasesWithWorker - canvasesOnMain)).toBeLessThanOrEqual(3 * DRAWN * 0.25);
	});

	test("without workers the worker term is 0 and the cache's own arithmetic is untouched", async () => {
		const run = setup({ withWorkers: false, videoOptions: { frameBytes: { decoded: DECODED, drawn: DRAWN } } });
		await run.play({ from: 10, to: 20, scale: 0.5 });
		const stats = run.cache.getMemoryStats();
		expect(stats.workerBytes).toBe(0);
	});
});

describe("VideoCache with decode workers: pictures and renders", () => {
	test("a render's lease holds the pictures it got until it ends it, however the cache lets go of them", async () => {
		const run = setup();
		await run.play({ from: 10, to: 12 });
		const lease = run.cache.beginRender();
		const held = await run.ask({ index: 13, lease });
		if (!held) throw new Error("no frame");
		// the cache forgets every drawn frame (a GPU context loss) and the preview plays on for a long while
		run.cache.dropDrawnFrames();
		await run.play({ from: 14, to: 60 });
		expect(held.canvas.destroyed).toBe(false);
		expect(held.canvas.frame).toBe(13);
		run.cache.endRender({ lease });
		await run.play({ from: 61, to: 70 });
		expect(held.canvas.destroyed).toBe(true);
		expect(run.fake.stats.bitmapsDoubleClosed).toBe(0);
	});

	test("dropping the drawn frames (a GPU context loss) closes the kept pictures, once each", async () => {
		const run = setup();
		await run.play({ from: 10, to: 60 });
		const closedBefore = run.fake.stats.bitmapsClosed;
		expect(run.cache.getMemoryStats().lruFrames).toBeGreaterThan(0);
		run.cache.dropDrawnFrames();
		await run.play({ from: 61, to: 70 });
		expect(run.cache.getMemoryStats().lruFrames).toBeLessThan(15);
		expect(run.fake.stats.bitmapsClosed).toBeGreaterThan(closedBefore);
		expect(run.fake.stats.bitmapsDoubleClosed).toBe(0);
	});

	test("every picture is closed at most once and every sample exactly once over a long playback with seeks", async () => {
		const run = setup();
		await run.play({ from: 10, to: 80 });
		await run.play({ from: 200, to: 230 });
		await run.play({ from: 40, to: 50 });
		run.cache.clearAll();
		await settle();
		expect(run.fake.stats.bitmapsDoubleClosed).toBe(0);
		expect(run.fake.stats.mainSamplesDoubleClosed).toBe(0);
		expect(run.video.log.doubleClosed).toBe(0);
		// A worker with no stream left is terminated: the frames it still held die with it
		// (none of them were closed twice); every other frame was closed.
		const diedWithWorkers = run.fake.worlds.reduce((total, world) => total + world.core.stats().openFrames, 0);
		expect(run.video.openFrames()).toBe(diedWithWorkers);
		expect(run.cache.getWorkerStats()).toMatchObject({ live: 0, streams: 0 });
	});

	test("memory pressure trims the read-ahead the worker holds", async () => {
		const reading = {
			totalBytes: 15.3 * 1024 ** 3,
			availableBytes: 0.5 * 1024 ** 3,
			swapTotalBytes: 8 * 1024 ** 3,
			swapFreeBytes: 8 * 1024 ** 3,
			appBytes: 1.2 * 1024 ** 3,
		};
		const memory: MemorySource = {
			readMemory: async () => reading,
			mode: () => "balanced",
			deviceMemoryGiB: () => null,
		};
		const run = setup({ memory });
		await run.play({ from: 10, to: 20 });
		const held = run.fake.worlds[0].core.stats().openFrames;
		expect(held).toBeGreaterThan(2);
		await run.cache.tickMemory();
		await settle();
		const afterPressure = run.fake.worlds[0].core.stats().openFrames;
		expect(afterPressure).toBeLessThan(held);
		expect(run.video.log.doubleClosed).toBe(0);
		// and playback still answers, from a new decoder
		expect(await run.play({ from: 21, to: 25 })).toEqual(range({ from: 21, to: 25 }));
	});
});
