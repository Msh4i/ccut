import type { DecodeClient } from "./client";
import { WorkerFailure } from "./failure";

/**
 * Most decode workers at once: `maxPerMedia` of `service.ts` (8). Was 4; raised in round 5d, the owner
 * asked the app to use more of his CPU (12 threads). Only the experimental "Decode in workers" lever
 * starts workers at all; not verified: how many hardware decoder sessions the iGPU allows.
 */
export const DECODE_WORKER_MAX = 8;

/**
 * Workers the machine gets: one less than its threads (the main thread keeps
 * one), at least 1, at most DECODE_WORKER_MAX. Unknown or invalid thread
 * counts give 1. (The existing `decodeWorkerCount` of `performance-mode.ts`
 * answers a different question and is left as it is: replacing it is an owner
 * decision.)
 */
export function decodeWorkerCap({
	hardwareConcurrency,
}: {
	hardwareConcurrency: number | undefined;
}): number {
	if (typeof hardwareConcurrency !== "number" || !Number.isFinite(hardwareConcurrency)) return 1;
	return Math.min(DECODE_WORKER_MAX, Math.max(1, Math.floor(hardwareConcurrency) - 1));
}

/** The worker with the fewest streams (the lowest index among equals); null when there is none. */
export function pickWorker({ loads }: { loads: readonly number[] }): number | null {
	let best: number | null = null;
	for (let index = 0; index < loads.length; index++) {
		if (best === null || loads[index] < loads[best]) best = index;
	}
	return best;
}

export type PoolStats = {
	/** Workers running now. */
	live: number;
	/** Most workers the pool starts. */
	cap: number;
	/** Streams over every worker. */
	streams: number;
	/** Workers started since the pool was made. */
	started: number;
};

/** A stream's place on a worker. */
export type WorkerLease = {
	client: DecodeClient;
	streamId: number;
	/** The stream is gone: its place is freed (a worker without streams ends). Once is enough. */
	release: () => void;
};

type PoolWorker = { client: DecodeClient; streams: Set<number> };

/**
 * The decode workers of the app. A worker starts when a stream needs one, one
 * per stream until `cap`, then streams go to the least loaded (`pickWorker`);
 * a worker with no stream ends. A worker that fails (its client is dead) leaves
 * the pool at once and `onWorkerFailure` hears of it.
 */
export class DecodeWorkerPool {
	private readonly cap: number;
	private readonly createClient: () => DecodeClient;
	private readonly onWorkerFailure: ({
		failure,
		client,
	}: {
		failure: WorkerFailure;
		client: DecodeClient | null;
	}) => void;
	private workers: PoolWorker[] = [];
	private nextStreamId = 1;
	private started = 0;

	constructor({
		cap,
		createClient,
		onWorkerFailure = () => {},
	}: {
		cap: number;
		/** Starts a worker and its client; throws when the platform cannot. */
		createClient: () => DecodeClient;
		/** A worker failed (`client`: its client, which every stream of it holds), or none could be started (null). */
		onWorkerFailure?: ({
			failure,
			client,
		}: {
			failure: WorkerFailure;
			client: DecodeClient | null;
		}) => void;
	}) {
		this.cap = Math.min(DECODE_WORKER_MAX, Math.max(1, Math.floor(cap)));
		this.createClient = createClient;
		this.onWorkerFailure = onWorkerFailure;
	}

	/** A place for a new stream; null when no worker could be started. */
	acquire(): WorkerLease | null {
		const worker = this.workerForNewStream();
		if (!worker) return null;
		const streamId = this.nextStreamId;
		this.nextStreamId += 1;
		worker.streams.add(streamId);
		let released = false;
		return {
			client: worker.client,
			streamId,
			release: () => {
				if (released) return;
				released = true;
				worker.streams.delete(streamId);
				if (worker.streams.size === 0 && this.workers.includes(worker)) {
					this.workers = this.workers.filter((other) => other !== worker);
					worker.client.shutdown();
				}
			},
		};
	}

	stats(): PoolStats {
		let streams = 0;
		for (const worker of this.workers) streams += worker.streams.size;
		return { live: this.workers.length, cap: this.cap, streams, started: this.started };
	}

	/** Ends every worker (the app is closing, or the lever went off for good). */
	shutdown(): void {
		const workers = this.workers;
		this.workers = [];
		for (const worker of workers) worker.client.shutdown();
	}

	private workerForNewStream(): PoolWorker | null {
		if (this.workers.length < this.cap) {
			const started = this.start();
			if (started) return started;
		}
		const index = pickWorker({ loads: this.workers.map((worker) => worker.streams.size) });
		return index === null ? null : this.workers[index];
	}

	private start(): PoolWorker | null {
		let client: DecodeClient;
		try {
			client = this.createClient();
		} catch (error) {
			this.onWorkerFailure({
				failure: new WorkerFailure({ message: "A decode worker could not be started", cause: error }),
				client: null,
			});
			return null;
		}
		const worker: PoolWorker = { client, streams: new Set() };
		this.workers.push(worker);
		this.started += 1;
		client.onFailure((failure) => {
			this.workers = this.workers.filter((other) => other !== worker);
			this.onWorkerFailure({ failure, client });
		});
		return worker;
	}
}
