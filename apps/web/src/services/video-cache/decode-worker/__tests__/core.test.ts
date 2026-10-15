import { describe, expect, test } from "bun:test";
import { createDecodeWorkerCore } from "../core";
import type { FromWorkerMessage } from "../protocol";
import { type FakeSample, createFakeBackend, settleHops } from "./harness";

function createCore(options?: Parameters<typeof createFakeBackend>[0]) {
	const fake = createFakeBackend(options);
	const sent: Array<{ message: FromWorkerMessage; transfer: readonly object[] }> = [];
	const core = createDecodeWorkerCore<FakeSample>({
		post: (entry) => sent.push(entry),
		openBackend: async () => fake.backend,
	});
	const messages = () => sent.map((entry) => entry.message);
	return { core, fake, sent, messages };
}

const FILE = new Blob(["x"]);

async function openAndPull({ core, startTime = 0 }: { core: ReturnType<typeof createCore>["core"]; startTime?: number }) {
	core.handle({ type: "open", streamId: 1, file: FILE });
	await settleHops(2);
	core.handle({ type: "iterate", streamId: 1, iteratorId: 1, startTime });
	core.handle({ type: "pull", iteratorId: 1 });
	await settleHops(2);
}

describe("decode worker core", () => {
	test("open answers with what the main thread needs of the file", async () => {
		const { core, messages } = createCore();
		core.handle({ type: "open", streamId: 7, file: FILE });
		await settleHops(2);
		expect(messages()).toEqual([
			{
				type: "opened",
				streamId: 7,
				displaySize: { width: 1920, height: 1080 },
				frameBytes: { decoded: 1, drawn: 1 },
				rotation: 0,
			},
		]);
	});

	test("a pull answers with the metadata of a frame the worker keeps", async () => {
		const { core, messages, fake } = createCore();
		await openAndPull({ core, startTime: 1 });
		const frame = messages().find((message) => message.type === "frame");
		expect(frame).toMatchObject({ type: "frame", iteratorId: 1, timestamp: 1 });
		expect(core.stats().openFrames).toBe(1);
		expect(fake.log.closed.size).toBe(0);
	});

	test("a pull after the last frame says done", async () => {
		const { core, messages } = createCore({ frames: 1 });
		await openAndPull({ core });
		core.handle({ type: "pull", iteratorId: 1 });
		await settleHops(2);
		expect(messages().filter((message) => message.type === "done")).toHaveLength(1);
	});

	test("render below full size gives a bitmap of the scaled size, transferred", async () => {
		const { core, sent } = createCore();
		await openAndPull({ core });
		const frame = sent.map((entry) => entry.message).find((message) => message.type === "frame");
		if (frame?.type !== "frame") throw new Error("no frame");
		core.handle({ type: "render", requestId: 1, frameId: frame.frameId, scale: 0.25 });
		const rendered = sent.find((entry) => entry.message.type === "rendered");
		expect(rendered?.message).toMatchObject({
			type: "rendered",
			requestId: 1,
			image: { kind: "bitmap", bitmap: { width: 480, height: 270 } },
		});
		expect(rendered?.transfer).toHaveLength(1);
	});

	test("render at full size gives a VideoFrame, transferred", async () => {
		const { core, sent } = createCore();
		await openAndPull({ core });
		const frame = sent.map((entry) => entry.message).find((message) => message.type === "frame");
		if (frame?.type !== "frame") throw new Error("no frame");
		core.handle({ type: "render", requestId: 2, frameId: frame.frameId, scale: 1 });
		const rendered = sent.find((entry) => entry.message.type === "rendered");
		expect(rendered?.message).toMatchObject({ type: "rendered", requestId: 2, image: { kind: "frame" } });
		expect(rendered?.transfer).toHaveLength(1);
		// rendering never closes the sample: it may be rendered again
		expect(core.stats().openFrames).toBe(1);
	});

	test("a scale that is not usable renders at full size", async () => {
		const { core, sent } = createCore();
		await openAndPull({ core });
		const frame = sent.map((entry) => entry.message).find((message) => message.type === "frame");
		if (frame?.type !== "frame") throw new Error("no frame");
		core.handle({ type: "render", requestId: 3, frameId: frame.frameId, scale: 4 });
		expect(sent.find((entry) => entry.message.type === "rendered")?.message).toMatchObject({
			image: { kind: "frame" },
		});
	});

	test("close removes the frame before it closes the sample, once", async () => {
		const { core, fake, sent } = createCore();
		await openAndPull({ core });
		const frame = sent.map((entry) => entry.message).find((message) => message.type === "frame");
		if (frame?.type !== "frame") throw new Error("no frame");
		core.handle({ type: "close", frameId: frame.frameId });
		core.handle({ type: "close", frameId: frame.frameId });
		expect([...fake.log.closed.values()]).toEqual([1]);
		expect(fake.log.doubleClosed).toBe(0);
		expect(core.stats()).toMatchObject({ openFrames: 0, unknownCloses: 1 });
	});

	test("a render of a frame that is gone is an error, not a crash", async () => {
		const { core, messages } = createCore();
		await openAndPull({ core });
		core.handle({ type: "render", requestId: 9, frameId: 999, scale: 1 });
		expect(messages().at(-1)).toMatchObject({ type: "error", target: "render", id: 9 });
		expect(core.stats().unknownFrames).toBe(1);
	});

	test("return while a pull waits for the decoder closes the frame that comes out, posts nothing", async () => {
		let release = () => {};
		const gate = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const { core, fake, messages } = createCore({ gate });
		core.handle({ type: "open", streamId: 1, file: FILE });
		await settleHops(2);
		core.handle({ type: "iterate", streamId: 1, iteratorId: 1, startTime: 0 });
		core.handle({ type: "pull", iteratorId: 1 });
		await settleHops(1);
		core.handle({ type: "return", iteratorId: 1 });
		release();
		await settleHops(2);
		expect(messages().map((message) => message.type)).toEqual(["opened"]);
		expect(fake.log.created).toBe(1);
		expect([...fake.log.closed.values()]).toEqual([1]);
		expect(core.stats()).toMatchObject({ openFrames: 0, openIterators: 0 });
	});

	test("dispose closes every frame, stops every decoder and closes the file once", async () => {
		const { core, fake, messages } = createCore();
		core.handle({ type: "open", streamId: 1, file: FILE });
		await settleHops(2);
		for (const iteratorId of [1, 2]) {
			core.handle({ type: "iterate", streamId: 1, iteratorId, startTime: 0 });
			core.handle({ type: "pull", iteratorId });
			core.handle({ type: "pull", iteratorId });
		}
		await settleHops(3);
		expect(core.stats().openFrames).toBe(4);
		core.handle({ type: "dispose", streamId: 1 });
		core.handle({ type: "dispose", streamId: 1 });
		expect(fake.log.created).toBe(4);
		expect([...fake.log.closed.values()]).toEqual([1, 1, 1, 1]);
		expect(fake.log.returned).toBe(2);
		expect(fake.log.disposed).toBe(1);
		expect(core.stats()).toMatchObject({ openStreams: 0, openFrames: 0, openIterators: 0 });
		expect(messages().filter((message) => message.type === "disposed")).toHaveLength(2);
	});

	test("a stream disposed while its file is opening closes the file when it opens", async () => {
		const { core, fake, messages } = createCore();
		core.handle({ type: "open", streamId: 1, file: FILE });
		core.handle({ type: "dispose", streamId: 1 });
		await settleHops(2);
		expect(fake.log.disposed).toBe(1);
		expect(messages().map((message) => message.type)).toEqual(["disposed"]);
	});

	test("a file that cannot be opened is reported as an error of the open", async () => {
		const core = createDecodeWorkerCore<FakeSample>({
			post: ({ message }) => {
				sent.push(message);
			},
			openBackend: async () => {
				throw new Error("no video track");
			},
		});
		const sent: FromWorkerMessage[] = [];
		core.handle({ type: "open", streamId: 5, file: FILE });
		await settleHops(2);
		expect(sent).toEqual([{ type: "error", target: "open", id: 5, message: "no video track" }]);
		expect(core.stats().openStreams).toBe(0);
	});

	test("a decoder that throws is reported on the pull", async () => {
		const sent: FromWorkerMessage[] = [];
		const fake = createFakeBackend();
		const core = createDecodeWorkerCore<FakeSample>({
			post: ({ message }) => {
				sent.push(message);
			},
			openBackend: async () => ({
				...fake.backend,
				samples: () => ({
					next: async () => {
						throw new Error("decoder died");
					},
					return: async () => undefined,
				}),
			}),
		});
		core.handle({ type: "open", streamId: 1, file: FILE });
		await settleHops(2);
		core.handle({ type: "iterate", streamId: 1, iteratorId: 1, startTime: 0 });
		core.handle({ type: "pull", iteratorId: 1 });
		await settleHops(2);
		expect(sent.at(-1)).toEqual({ type: "error", target: "pull", id: 1, message: "decoder died" });
	});

	test("messages that fail the shape check are dropped and counted", () => {
		const { core, sent } = createCore();
		core.handle({ type: "pull", iteratorId: "x" });
		core.handle(null);
		core.handle({ type: "render", requestId: 1, frameId: 1, scale: -1 });
		expect(sent).toHaveLength(0);
		expect(core.stats().rejected).toBe(3);
	});
});
