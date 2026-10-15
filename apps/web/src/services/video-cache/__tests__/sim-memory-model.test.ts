import { describe, expect, test } from "bun:test";
import { DEFAULT_FRAME_BYTES } from "../frame-stream";
import {
	type DecoderModelParams,
	createDecoderStats,
	createModelSource,
	destroySimCanvas,
} from "../sim/decoder-model";
import { VirtualClock } from "../sim/virtual-clock";

// The simulator's own memory model: what the decoders and canvases hold,
// counted where they are created and freed, whatever the cache believes.

const PARAMS: DecoderModelParams = {
	fps: 30,
	frameCount: 300,
	keyframeInterval: 30,
	decodeMs: 6,
	startupMs: 20,
	maxQueued: 8,
};
const DECODED = DEFAULT_FRAME_BYTES.decoded;
const DRAWN = DEFAULT_FRAME_BYTES.drawn;

function setup() {
	const clock = new VirtualClock();
	const stats = createDecoderStats();
	const source = createModelSource({ clock, params: PARAMS, stats });
	return { clock, stats, source };
}

describe("decoder model memory", () => {
	test("a decoder holds up to 8 decoded frames in its queue; a frame handed out counts until it is closed", async () => {
		const { clock, stats, source } = setup();
		const iterator = source.openIterator({ startTime: 0 });
		await clock.runUntil({ time: 200, maxEvents: 1000 });
		expect(stats.queuedFrames).toBe(8);
		expect(stats.heldBytes).toBe(8 * DECODED);

		const first = await iterator.next();
		if (first.done) throw new Error("no frame");
		// Taken from the queue: open now; the decoder refills its queue.
		expect(stats.openFrames).toBe(1);
		await clock.runUntil({ time: 400, maxEvents: 1000 });
		expect(stats.queuedFrames).toBe(8);
		expect(stats.heldBytes).toBe(9 * DECODED);
		expect(stats.peakHeldBytes).toBe(9 * DECODED);

		first.value.close();
		first.value.close();
		expect(stats.openFrames).toBe(0);
		expect(stats.doubleClosed).toBe(1);

		await iterator.return();
		expect(stats.queuedFrames).toBe(0);
		expect(stats.heldBytes).toBe(0);
		expect(stats.peakHeldBytes).toBe(9 * DECODED);
	});

	test("live decoders are counted, the most at once kept", async () => {
		const { stats, source } = setup();
		const a = source.openIterator({ startTime: 0 });
		const b = source.openIterator({ startTime: 5 });
		expect(stats.liveRuns).toBe(2);
		await a.return();
		await a.return();
		expect(stats.liveRuns).toBe(1);
		await b.return();
		expect(stats.liveRuns).toBe(0);
		expect(stats.peakLiveRuns).toBe(2);
	});

	test("a canvas holds drawn bytes x scale^2 until it is destroyed", () => {
		const { stats, source } = setup();
		const full = source.createCanvas({ scale: 1 });
		const quarter = source.createCanvas({ scale: 0.25 });
		expect(stats.liveCanvases).toBe(2);
		expect(stats.heldBytes).toBe(DRAWN + DRAWN / 16);
		destroySimCanvas({ canvas: quarter, stats });
		destroySimCanvas({ canvas: quarter, stats });
		expect(stats.liveCanvases).toBe(1);
		expect(stats.heldBytes).toBe(DRAWN);
		expect(full.destroyed).toBe(false);
		expect(quarter).toMatchObject({ destroyed: true, frame: -1 });
		expect(stats.canvasesCreated).toBe(2);
	});

	test("a destroyed canvas holds nothing; drawing into it is counted and leaves it empty", async () => {
		const { clock, stats, source } = setup();
		const iterator = source.openIterator({ startTime: 0 });
		const pending = iterator.next();
		await clock.runUntil({ time: 100, maxEvents: 1000 });
		const frame = await pending;
		if (frame.done) throw new Error("no frame");
		const canvas = source.createCanvas({ scale: 1 });
		frame.value.drawInto(canvas);
		expect(canvas.frame).toBe(0);
		destroySimCanvas({ canvas, stats });
		expect(canvas.frame).toBe(-1);
		frame.value.drawInto(canvas);
		expect(stats.drawsIntoDestroyed).toBe(1);
		expect(canvas.frame).toBe(-1);
		frame.value.close();
		await iterator.return();
	});
});
