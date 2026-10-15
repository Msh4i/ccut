import { describe, expect, test } from "bun:test";
import { type Channel, createDecodeClient } from "../client";
import { isWorkerFailure } from "../failure";
import { createFakeClock, createImageBook, createWorld, settleHops } from "./harness";

const FILE = { name: "clip.mp4" };

async function openStream(world: ReturnType<typeof createWorld>) {
	await world.client.openStream({ streamId: 1, file: FILE });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("decode client over a fake channel", () => {
	test("frames come out in order, with their metadata", async () => {
		const world = createWorld();
		await openStream(world);
		const iterator = world.client.openIterator({ streamId: 1, startTime: 0.5 });
		const first = await iterator.next();
		const second = await iterator.next();
		if (first.done || second.done) throw new Error("decoder ended");
		expect(first.value.timestamp).toBeCloseTo(0.5, 6);
		expect(second.value.timestamp).toBeCloseTo(0.5 + 1 / 30, 6);
		expect(world.core.stats().openFrames).toBe(2);
	});

	test("opening reports the file's size, bytes and rotation", async () => {
		const world = createWorld();
		const opened = await world.client.openStream({ streamId: 1, file: FILE });
		expect(opened).toEqual({
			displaySize: { width: 1920, height: 1080 },
			frameBytes: { decoded: 1, drawn: 1 },
			rotation: 0,
		});
	});

	test("a picture below full size is a bitmap of the scaled size, and the worker lets go of it", async () => {
		const world = createWorld();
		await openStream(world);
		const iterator = world.client.openIterator({ streamId: 1, startTime: 0 });
		const result = await iterator.next();
		if (result.done) throw new Error("decoder ended");
		const image = await result.value.render({ scale: 0.5 });
		expect(image.kind).toBe("bitmap");
		expect(image.kind === "bitmap" && [image.bitmap.width, image.bitmap.height]).toEqual([960, 540]);
		// the original in the worker was transferred: detached there, a copy here
		expect(world.fake.log.images.map((entry) => entry.detached)).toEqual([true]);
		expect(image.kind === "bitmap" && Reflect.get(image.bitmap, "detached")).toBe(false);
	});

	test("a picture at full size is a VideoFrame, also transferred", async () => {
		const world = createWorld();
		await openStream(world);
		const result = await world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		if (result.done) throw new Error("decoder ended");
		const image = await result.value.render({ scale: 1 });
		expect(image.kind).toBe("frame");
		expect(world.fake.log.images.every((entry) => entry.detached)).toBe(true);
	});

	test("the same frame can be rendered again (a paused redraw)", async () => {
		const world = createWorld();
		await openStream(world);
		const result = await world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		if (result.done) throw new Error("decoder ended");
		await result.value.render({ scale: 0.25 });
		await result.value.render({ scale: 1 });
		expect(world.fake.log.renders.map((entry) => entry.scale)).toEqual([0.25, 1]);
	});

	test("close frees the frame in the worker once; a second close is only counted", async () => {
		const world = createWorld();
		await openStream(world);
		const result = await world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		if (result.done) throw new Error("decoder ended");
		result.value.close();
		result.value.close();
		await settleHops(3);
		expect([...world.fake.log.closed.values()]).toEqual([1]);
		expect(world.client.stats().doubleCloses).toBe(1);
		expect(world.core.stats().unknownCloses).toBe(0);
		expect(await rejection(result.value.render({ scale: 1 }))).toBeInstanceOf(Error);
	});

	test("return ends a pending next with done, and the frame that still arrives is closed", async () => {
		const world = createWorld();
		await openStream(world);
		const iterator = world.client.openIterator({ streamId: 1, startTime: 0 });
		const pending = iterator.next();
		// the pull is posted (not delivered yet) when the decoder is returned
		await Promise.resolve();
		await Promise.resolve();
		await iterator.return();
		expect((await pending).done).toBe(true);
		await settleHops(6);
		expect(world.client.stats().lateFrames).toBe(1);
		expect(world.fake.log.created).toBe(1);
		expect([...world.fake.log.closed.values()]).toEqual([1]);
		expect(world.core.stats().openFrames).toBe(0);
		expect((await iterator.next()).done).toBe(true);
	});

	test("an error the worker reports for one call rejects that call only, with an ordinary error", async () => {
		const world = createWorld();
		await openStream(world);
		const result = await world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		if (result.done) throw new Error("decoder ended");
		result.value.close();
		await settleHops(3);
		// a frame the worker no longer has: the worker answers with an error
		const handle = result.value;
		expect(await rejection(handle.render({ scale: 1 }))).toBeInstanceOf(Error);
		expect(world.client.isAlive()).toBe(true);
	});

	test("a worker that crashes rejects every pending call with a worker failure and ends the client", async () => {
		const world = createWorld({ backendOptions: { gate: () => new Promise<void>(() => {}) } });
		await openStream(world);
		const failures: unknown[] = [];
		world.client.onFailure((failure) => failures.push(failure));
		const iterator = world.client.openIterator({ streamId: 1, startTime: 0 });
		const pending = iterator.next();
		await settleHops(2);
		world.channel.worker.crash("out of memory");
		const error = await rejection(pending);
		expect(isWorkerFailure(error)).toBe(true);
		expect(failures).toHaveLength(1);
		expect(world.channel.state.terminated).toBe(true);
		expect(world.client.isAlive()).toBe(false);
		expect(isWorkerFailure(await rejection(iterator.next()))).toBe(true);
		expect(isWorkerFailure(await rejection(world.client.openStream({ streamId: 2, file: FILE })))).toBe(true);
		// the end is reported once
		world.channel.worker.crash("again");
		expect(failures).toHaveLength(1);
	});

	test("a render the worker never answers is cut off by the watchdog", async () => {
		const world = createWorld({ dropReplies: (message) => message.type === "rendered" });
		await openStream(world);
		const result = await world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		if (result.done) throw new Error("decoder ended");
		const render = result.value.render({ scale: 0.5 });
		await settleHops(3);
		world.clock.advance(4_999);
		expect(world.client.isAlive()).toBe(true);
		world.clock.advance(2);
		const error = await rejection(render);
		expect(isWorkerFailure(error)).toBe(true);
		expect(error instanceof Error && error.message).toContain("render timed out");
		expect(world.channel.state.terminated).toBe(true);
	});

	test("a render answered in time clears its watchdog", async () => {
		const world = createWorld();
		await openStream(world);
		const result = await world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		if (result.done) throw new Error("decoder ended");
		const timersBefore = world.clock.pending();
		await result.value.render({ scale: 0.5 });
		expect(world.clock.pending()).toBe(timersBefore);
		world.clock.advance(60_000);
		expect(world.client.isAlive()).toBe(true);
	});

	test("a pull the decoder never answers is cut off too", async () => {
		const world = createWorld({ backendOptions: { gate: () => new Promise<void>(() => {}) } });
		await openStream(world);
		const pending = world.client.openIterator({ streamId: 1, startTime: 0 }).next();
		await settleHops(3);
		world.clock.advance(20_001);
		expect(isWorkerFailure(await rejection(pending))).toBe(true);
	});

	test("a worker that cannot open the file fails the open with a worker failure", async () => {
		const channel = (await import("./harness")).createFakeChannel();
		const book = createImageBook();
		const client = createDecodeClient({ channel: channel.main, clock: createFakeClock(), ops: book.ops });
		channel.worker.onMessage((data) => {
			if (typeof data === "object" && data !== null && Reflect.get(data, "type") === "open") {
				channel.worker.post({
					message: { type: "error", target: "open", id: Reflect.get(data, "streamId"), message: "codec" },
				});
			}
		});
		const error = await rejection(client.openStream({ streamId: 1, file: FILE }));
		expect(isWorkerFailure(error)).toBe(true);
		expect(error instanceof Error && error.message).toContain("codec");
	});

	test("disposing a stream ends its pending next and frees its frames in the worker", async () => {
		const world = createWorld();
		await openStream(world);
		const iterator = world.client.openIterator({ streamId: 1, startTime: 0 });
		await iterator.next();
		await iterator.next();
		const pending = iterator.next();
		world.client.disposeStream({ streamId: 1 });
		expect((await pending).done).toBe(true);
		await settleHops(6);
		expect(world.core.stats()).toMatchObject({ openStreams: 0, openFrames: 0 });
		expect(world.fake.log.doubleClosed).toBe(0);
		expect(world.fake.log.closed.size).toBe(world.fake.log.created);
		expect(world.fake.log.disposed).toBe(1);
	});

	test("an unexpected picture is discarded, not leaked", () => {
		let deliver: (data: unknown) => void = () => {};
		const channel: Channel = {
			post: () => {},
			onMessage: (handler) => {
				deliver = handler;
			},
			onFailure: () => {},
			terminate: () => {},
		};
		const book = createImageBook();
		const client = createDecodeClient({ channel, clock: createFakeClock(), ops: book.ops });
		deliver({ type: "rendered", requestId: 99, image: { kind: "bitmap", bitmap: { id: 5, width: 2, height: 2 } } });
		expect(book.closes.get(5)).toBe(1);
		expect(client.stats().lateRenders).toBe(1);
	});

	test("messages that are not part of the protocol are dropped", () => {
		let deliver: (data: unknown) => void = () => {};
		const channel: Channel = {
			post: () => {},
			onMessage: (handler) => {
				deliver = handler;
			},
			onFailure: () => {},
			terminate: () => {},
		};
		const client = createDecodeClient({ channel, clock: createFakeClock(), ops: createImageBook().ops });
		deliver({ type: "frame", iteratorId: "one" });
		deliver(null);
		deliver("hello");
		expect(client.stats().rejected).toBe(3);
		expect(client.isAlive()).toBe(true);
	});

	test("a message that cannot be posted ends the worker", async () => {
		const channel: Channel = {
			post: () => {
				throw new Error("DataCloneError");
			},
			onMessage: () => {},
			onFailure: () => {},
			terminate: () => {},
		};
		const client = createDecodeClient({ channel, clock: createFakeClock(), ops: createImageBook().ops });
		const error = await rejection(client.openStream({ streamId: 1, file: FILE }));
		expect(isWorkerFailure(error)).toBe(true);
		expect(client.isAlive()).toBe(false);
	});
});
