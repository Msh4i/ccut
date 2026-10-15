import { describe, expect, test } from "bun:test";
import { createAnalysisCache } from "@/timeline/beats/analysis-cache";

type Analysis = { ok: true; value: number } | { ok: false; reason: string };

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (error: Error) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const signal = () => new AbortController().signal;

describe("createAnalysisCache", () => {
	test("analyses a source once and serves repeat requests from the cache", async () => {
		const cache = createAnalysisCache<Analysis>();
		let starts = 0;
		const start = async (): Promise<Analysis> => {
			starts++;
			return { ok: true, value: 1 };
		};
		const first = await cache.run({ key: "a", signal: signal(), start });
		const second = await cache.run({ key: "a", signal: signal(), start });
		expect(starts).toBe(1);
		expect(second).toBe(first);
	});

	test("shares one in-flight analysis between concurrent requests", async () => {
		const cache = createAnalysisCache<Analysis>();
		const work = deferred<Analysis>();
		let starts = 0;
		const start = () => {
			starts++;
			return work.promise;
		};
		const a = cache.run({ key: "a", signal: signal(), start });
		const b = cache.run({ key: "a", signal: signal(), start });
		work.resolve({ ok: true, value: 2 });
		expect(await a).toEqual(await b);
		expect(starts).toBe(1);
	});

	test("different sources are analysed separately", async () => {
		const cache = createAnalysisCache<Analysis>();
		let starts = 0;
		const start = async (): Promise<Analysis> => ({ ok: true, value: ++starts });
		await cache.run({ key: "a", signal: signal(), start });
		await cache.run({ key: "b", signal: signal(), start });
		expect(starts).toBe(2);
	});

	test("a failed analysis is not cached, so it can be retried", async () => {
		const cache = createAnalysisCache<Analysis>();
		let starts = 0;
		const start = async (): Promise<Analysis> => {
			starts++;
			return { ok: false, reason: "no-beat" };
		};
		await cache.run({ key: "a", signal: signal(), start });
		await cache.run({ key: "a", signal: signal(), start });
		expect(starts).toBe(2);
	});

	test("a crashed analysis is not cached either", async () => {
		const cache = createAnalysisCache<Analysis>();
		await expect(
			cache.run({
				key: "a",
				signal: signal(),
				start: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
		const retry = await cache.run({
			key: "a",
			signal: signal(),
			start: async () => ({ ok: true, value: 3 }),
		});
		expect(retry).toEqual({ ok: true, value: 3 });
	});

	test("a cancelled, unfinished analysis is not handed to the next job", async () => {
		const cache = createAnalysisCache<Analysis>();
		const controller = new AbortController();
		const stuck = deferred<Analysis>();
		const first = cache.run({ key: "a", signal: controller.signal, start: () => stuck.promise });
		first.catch(() => {});
		controller.abort();

		let restarted = false;
		const next = await cache.run({
			key: "a",
			signal: signal(),
			start: async () => {
				restarted = true;
				return { ok: true, value: 4 };
			},
		});
		expect(restarted).toBe(true);
		expect(next).toEqual({ ok: true, value: 4 });
		stuck.resolve({ ok: true, value: 0 });
	});

	test("an analysis that finished before the cancel stays cached", async () => {
		const cache = createAnalysisCache<Analysis>();
		const controller = new AbortController();
		const done = await cache.run({
			key: "a",
			signal: controller.signal,
			start: async () => ({ ok: true, value: 5 }),
		});
		controller.abort();
		let starts = 0;
		const again = await cache.run({
			key: "a",
			signal: signal(),
			start: async () => {
				starts++;
				return { ok: true, value: 6 };
			},
		});
		expect(starts).toBe(0);
		expect(again).toBe(done);
	});

	test("idle waits for the work a cancelled job left running", async () => {
		const cache = createAnalysisCache<Analysis>();
		const controller = new AbortController();
		const decoding = deferred<Analysis>();
		const run = cache.run({ key: "a", signal: controller.signal, start: () => decoding.promise });
		run.catch(() => {});
		controller.abort();

		let idle = false;
		const waiting = cache.idle().then(() => {
			idle = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idle).toBe(false);

		decoding.resolve({ ok: true, value: 7 });
		await waiting;
		expect(idle).toBe(true);
	});

	test("idle also finishes when the abandoned work crashes", async () => {
		const cache = createAnalysisCache<Analysis>();
		const controller = new AbortController();
		const decoding = deferred<Analysis>();
		const run = cache.run({ key: "a", signal: controller.signal, start: () => decoding.promise });
		run.catch(() => {});
		controller.abort();
		decoding.reject(new Error("decode failed after cancel"));
		await cache.idle();
	});

	test("idle is immediate when nothing was abandoned", async () => {
		const cache = createAnalysisCache<Analysis>();
		await cache.run({ key: "a", signal: signal(), start: async () => ({ ok: true, value: 1 }) });
		await cache.idle();
	});

	test("idle forgets finished abandoned work", async () => {
		const cache = createAnalysisCache<Analysis>();
		const controller = new AbortController();
		const decoding = deferred<Analysis>();
		cache.run({ key: "a", signal: controller.signal, start: () => decoding.promise }).catch(() => {});
		controller.abort();
		decoding.resolve({ ok: true, value: 1 });
		await cache.idle();
		const start = performance.now();
		await cache.idle();
		expect(performance.now() - start).toBeLessThan(20);
	});
});
