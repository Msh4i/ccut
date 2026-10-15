import { describe, expect, test } from "bun:test";
import type { FrameIterator, FrameSource, StreamFrame } from "../../frame-stream";
import { createFallbackSource } from "../fallback-source";
import { WorkerFailure } from "../failure";

type Canvas = { name: string };

function mainSource(): { source: FrameSource<Canvas>; opened: number[] } {
	const opened: number[] = [];
	return {
		opened,
		source: {
			displaySize: { width: 100, height: 50 },
			frameBytes: { decoded: 1, drawn: 2 },
			openIterator: ({ startTime }) => {
				opened.push(startTime);
				return {
					next: async () => ({
						done: false,
						value: { timestamp: startTime, duration: 1, drawInto: () => {}, close: () => {} },
					}),
					return: async () => undefined,
				};
			},
			keyframeAtOrBefore: async () => 0,
			createCanvas: () => ({ name: "main" }),
			dispose: () => {},
		},
	};
}

function workerSource({
	nextFails = false,
	renderFails = false,
	error = new WorkerFailure({ message: "worker lost" }),
}: { nextFails?: boolean; renderFails?: boolean; error?: Error } = {}) {
	const log = { disposed: 0, opened: 0, returned: 0, closed: 0 };
	const source: FrameSource<Canvas, StreamFrame<Canvas>> = {
		displaySize: { width: 100, height: 50 },
		createCanvas: () => ({ name: "worker" }),
		keyframeAtOrBefore: async () => 0,
		openIterator: ({ startTime }): FrameIterator<Canvas, StreamFrame<Canvas>> => {
			log.opened += 1;
			return {
				next: async () => {
					if (nextFails) throw error;
					return {
						done: false,
						value: {
							timestamp: startTime,
							duration: 1,
							render: async () => {
								if (renderFails) throw error;
								return { kind: "image", image: { name: "bitmap" } };
							},
							close: () => {
								log.closed += 1;
							},
						},
					};
				},
				return: async () => {
					log.returned += 1;
					return undefined;
				},
			};
		},
		dispose: () => {
			log.disposed += 1;
		},
	};
	return { source, log };
}

describe("createFallbackSource", () => {
	test("while the worker works, decoders come from the worker and the file facts from the main thread", async () => {
		const main = mainSource();
		const worker = workerSource();
		const failures: unknown[] = [];
		const source = createFallbackSource({ primary: worker.source, fallback: main.source, onFallback: (f) => failures.push(f) });
		expect(source.displaySize).toEqual({ width: 100, height: 50 });
		expect(source.frameBytes).toEqual({ decoded: 1, drawn: 2 });
		expect(source.createCanvas({ scale: 1 })).toEqual({ name: "main" });
		const result = await source.openIterator({ startTime: 2 }).next();
		expect(result.done).toBe(false);
		expect(worker.log.opened).toBe(1);
		expect(main.opened).toEqual([]);
		expect(source.hasFallenBack()).toBe(false);
		expect(failures).toEqual([]);
	});

	test("the first worker failure of a pull is reported once, frees the worker's place, and the next decoder is the main thread's", async () => {
		const main = mainSource();
		const worker = workerSource({ nextFails: true });
		const failures: unknown[] = [];
		const source = createFallbackSource({ primary: worker.source, fallback: main.source, onFallback: (f) => failures.push(f) });
		await expect(source.openIterator({ startTime: 1 }).next()).rejects.toBeInstanceOf(WorkerFailure);
		expect(failures).toHaveLength(1);
		expect(worker.log.disposed).toBe(1);
		expect(source.hasFallenBack()).toBe(true);
		const next = await source.openIterator({ startTime: 5 }).next();
		expect(next.done).toBe(false);
		expect(main.opened).toEqual([5]);
		expect(worker.log.opened).toBe(1);
		// a second failure (another old iterator) is not reported again
		await expect(source.openIterator({ startTime: 6 }).next()).resolves.toBeDefined();
		expect(failures).toHaveLength(1);
	});

	test("a worker failure of a render trips it too, and the frame is the worker's until then", async () => {
		const main = mainSource();
		const worker = workerSource({ renderFails: true });
		const failures: unknown[] = [];
		const source = createFallbackSource({ primary: worker.source, fallback: main.source, onFallback: (f) => failures.push(f) });
		const result = await source.openIterator({ startTime: 1 }).next();
		if (result.done || !("render" in result.value)) throw new Error("expected an async frame");
		await expect(result.value.render({ scale: 0.5 })).rejects.toBeInstanceOf(WorkerFailure);
		expect(failures).toHaveLength(1);
		expect(source.hasFallenBack()).toBe(true);
	});

	test("an ordinary error passes through and does not trip", async () => {
		const main = mainSource();
		const worker = workerSource({ nextFails: true, error: new Error("corrupt frame") });
		const failures: unknown[] = [];
		const source = createFallbackSource({ primary: worker.source, fallback: main.source, onFallback: (f) => failures.push(f) });
		await expect(source.openIterator({ startTime: 1 }).next()).rejects.toThrow("corrupt frame");
		expect(failures).toEqual([]);
		expect(source.hasFallenBack()).toBe(false);
		expect(worker.log.disposed).toBe(0);
	});

	test("a worker that refuses to start a decoder trips it, and that decoder is the main thread's", () => {
		const main = mainSource();
		const worker = workerSource();
		const failures: unknown[] = [];
		const primary: FrameSource<Canvas, StreamFrame<Canvas>> = {
			...worker.source,
			openIterator: () => {
				throw new WorkerFailure({ message: "dead worker" });
			},
		};
		const source = createFallbackSource({ primary, fallback: main.source, onFallback: (f) => failures.push(f) });
		source.openIterator({ startTime: 3 });
		expect(main.opened).toEqual([3]);
		expect(failures).toHaveLength(1);
	});

	test("an error of another kind thrown when a decoder starts is not swallowed", () => {
		const main = mainSource();
		const worker = workerSource();
		const primary: FrameSource<Canvas, StreamFrame<Canvas>> = {
			...worker.source,
			openIterator: () => {
				throw new Error("bad argument");
			},
		};
		const source = createFallbackSource({ primary, fallback: main.source, onFallback: () => {} });
		expect(() => source.openIterator({ startTime: 3 })).toThrow("bad argument");
		expect(main.opened).toEqual([]);
	});

	test("dispose frees the worker's place and never touches the main thread's source", () => {
		const main = mainSource();
		let mainDisposed = 0;
		const worker = workerSource();
		const source = createFallbackSource({
			primary: worker.source,
			fallback: { ...main.source, dispose: () => (mainDisposed += 1) },
			onFallback: () => {},
		});
		source.dispose();
		expect(worker.log.disposed).toBe(1);
		expect(mainDisposed).toBe(0);
	});
});
