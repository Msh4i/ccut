import { describe, expect, test } from "bun:test";
import type { DecodeClient } from "../client";
import { WorkerFailure } from "../failure";
import { DECODE_WORKER_MAX, DecodeWorkerPool, decodeWorkerCap, pickWorker } from "../pool";

describe("decodeWorkerCap", () => {
	test("one less than the threads, at least 1, at most DECODE_WORKER_MAX", () => {
		const table: Array<[number | undefined, number]> = [
			[undefined, 1],
			[Number.NaN, 1],
			[Number.POSITIVE_INFINITY, 1],
			[-4, 1],
			[0, 1],
			[1, 1],
			[2, 1],
			[3, 2],
			[4, 3],
			[5, 4],
			[9, 8],
			[12, 8],
			[64, DECODE_WORKER_MAX],
			[4.9, 3],
		];
		for (const [hardwareConcurrency, expected] of table) {
			expect([hardwareConcurrency, decodeWorkerCap({ hardwareConcurrency })]).toEqual([
				hardwareConcurrency,
				expected,
			]);
		}
	});
});

describe("pickWorker", () => {
	test("the least loaded, the lowest index among equals", () => {
		expect(pickWorker({ loads: [] })).toBeNull();
		expect(pickWorker({ loads: [3] })).toBe(0);
		expect(pickWorker({ loads: [2, 1, 1, 3] })).toBe(1);
		expect(pickWorker({ loads: [1, 1, 1] })).toBe(0);
		expect(pickWorker({ loads: [4, 3, 0, 0] })).toBe(2);
	});
});

function fakeClient() {
	const state = { shutdowns: 0, alive: true };
	let failureHandler: (failure: WorkerFailure) => void = () => {};
	const client: DecodeClient = {
		openStream: async () => {
			throw new Error("not used");
		},
		openIterator: () => {
			throw new Error("not used");
		},
		disposeStream: () => {},
		shutdown: () => {
			state.shutdowns += 1;
			state.alive = false;
		},
		isAlive: () => state.alive,
		onFailure: (handler) => {
			failureHandler = handler;
		},
		stats: () => ({ lateFrames: 0, lateRenders: 0, doubleCloses: 0, rejected: 0 }),
	};
	return { client, state, fail: (failure: WorkerFailure) => failureHandler(failure) };
}

function createPool({ cap }: { cap: number }) {
	const clients: Array<ReturnType<typeof fakeClient>> = [];
	const failures: Array<{ failure: WorkerFailure; client: DecodeClient | null }> = [];
	let throwOnCreate = false;
	const pool = new DecodeWorkerPool({
		cap,
		createClient: () => {
			if (throwOnCreate) throw new Error("no Worker in this environment");
			const entry = fakeClient();
			clients.push(entry);
			return entry.client;
		},
		onWorkerFailure: (event) => failures.push(event),
	});
	return {
		pool,
		clients,
		failures,
		setThrow: (value: boolean) => {
			throwOnCreate = value;
		},
	};
}

describe("DecodeWorkerPool", () => {
	test("starts nothing until a stream needs a worker", () => {
		const { pool, clients } = createPool({ cap: 3 });
		expect(clients).toHaveLength(0);
		expect(pool.stats()).toMatchObject({ live: 0, cap: 3, streams: 0 });
	});

	test("one worker per stream up to the cap, then the least loaded one", () => {
		const { pool, clients } = createPool({ cap: 2 });
		const leases = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
		expect(clients).toHaveLength(2);
		expect(leases.map((lease) => clients.findIndex((entry) => entry.client === lease?.client))).toEqual([
			0, 1, 0, 1, 0,
		]);
		expect(pool.stats()).toMatchObject({ live: 2, streams: 5, started: 2 });
	});

	test("the cap is never exceeded, whatever is asked for", () => {
		const { pool, clients } = createPool({ cap: 99 });
		for (let index = 0; index < 20; index++) pool.acquire();
		expect(clients).toHaveLength(DECODE_WORKER_MAX);
		expect(pool.stats().cap).toBe(DECODE_WORKER_MAX);
	});

	test("a worker with no stream left ends; the next stream starts a new one", () => {
		const { pool, clients } = createPool({ cap: 2 });
		const first = pool.acquire();
		const second = pool.acquire();
		first?.release();
		first?.release();
		expect(clients[0].state.shutdowns).toBe(1);
		expect(clients[1].state.shutdowns).toBe(0);
		expect(pool.stats()).toMatchObject({ live: 1, streams: 1 });
		const third = pool.acquire();
		expect(clients).toHaveLength(3);
		expect(third?.client).toBe(clients[2].client);
		second?.release();
		third?.release();
		expect(pool.stats()).toMatchObject({ live: 0, streams: 0 });
	});

	test("a worker that fails leaves the pool and is reported once", () => {
		const { pool, clients, failures } = createPool({ cap: 2 });
		const lease = pool.acquire();
		pool.acquire();
		const failure = new WorkerFailure({ message: "crashed" });
		clients[0].fail(failure);
		expect(failures).toEqual([{ failure, client: clients[0].client }]);
		expect(pool.stats().live).toBe(1);
		// its stream releasing afterwards does not shut it down a second time or break the pool
		lease?.release();
		expect(clients[0].state.shutdowns).toBe(0);
		expect(pool.stats().live).toBe(1);
	});

	test("a platform that cannot start a worker gives no place, and says so", () => {
		const { pool, failures, setThrow } = createPool({ cap: 2 });
		setThrow(true);
		expect(pool.acquire()).toBeNull();
		expect(failures).toHaveLength(1);
		expect(failures[0].failure).toBeInstanceOf(WorkerFailure);
		expect(failures[0].client).toBeNull();
	});

	test("shutdown ends every worker", () => {
		const { pool, clients } = createPool({ cap: 3 });
		pool.acquire();
		pool.acquire();
		pool.shutdown();
		expect(clients.map((entry) => entry.state.shutdowns)).toEqual([1, 1]);
		expect(pool.stats().live).toBe(0);
	});
});
