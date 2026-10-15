import type { FrameSource } from "../frame-stream";
import type { DrawClock } from "../canvas-recycler";
import type { ImagePool } from "../scaled-canvases";
import type { DecodeClient } from "./client";
import { type FallbackSource, createFallbackSource } from "./fallback-source";
import { ImageLease } from "./image-lease";
import { DecodeWorkerPool, decodeWorkerCap } from "./pool";
import { type WorkerSourceAdapters, createWorkerSource } from "./worker-source";
import type { WorkerFailure } from "./failure";

/**
 * Memory one live decode worker costs besides the frames it holds: its
 * JavaScript heap, the WebCodecs and mediabunny state, its drawing canvas.
 * OWNER DECISION, not measured (Chromium dedicated workers of this kind are
 * often 20-60 MB; the HUD's `usedBytes` counts this many per worker).
 */
export const WORKER_OVERHEAD_BYTES = 32 * 1024 ** 2;

/**
 * What a stream's worker holds for pictures besides the decoded frames: its
 * drawing canvas and one picture in flight, each at the drawn size times
 * scale^2 (counted per stream while it has a decoder). The worker does not
 * render ahead: a picture is made when the stream presents the frame.
 */
export const WORKER_RENDER_AHEAD = 2;

/** Worker failures after which the lever is off for the rest of the session. */
export const WORKER_FAILURES_BEFORE_OFF = 1;

export type DecodeWorkerStats = {
	/** The lever is on and has not tripped: streams opened now may use a worker. */
	on: boolean;
	/** Tripped by a failure: off until the app restarts. */
	tripped: boolean;
	/** Workers running now, and the most the pool starts. */
	live: number;
	cap: number;
	/** Streams on workers now. */
	streams: number;
	/** Streams that moved back to the main thread after a worker failed. */
	fallbacks: number;
};

/**
 * What the frame cache asks of the decode workers (`service.ts`). The cache
 * never constructs a worker itself: without this (or with `enabled()` false)
 * its streams are exactly the main-thread ones.
 */
export type DecodeWorkers<TCanvas> = {
	/** Whether a stream opened now may use a worker (the lever, and no failure so far). */
	enabled: () => boolean;
	/**
	 * A source for one stream of `main`'s file on a worker, falling back to
	 * `main` when the worker fails; null when no worker could be had.
	 */
	createStreamSource: ({
		main,
		file,
	}: {
		main: FrameSource<TCanvas>;
		file: File;
	}) => FallbackSource<TCanvas> | null;
	/** Where the worker's pictures live next to a media's canvases. */
	createImagePool: ({
		quarantine,
		clock,
		isHeld,
	}: {
		quarantine: () => number;
		clock: DrawClock;
		isHeld: (image: TCanvas) => boolean;
	}) => ImagePool<TCanvas>;
	stats: () => DecodeWorkerStats;
	/** `WORKER_OVERHEAD_BYTES` per live worker. */
	overheadBytes: () => number;
};

export function createDecodeWorkers<TCanvas extends object>({
	isOn,
	hardwareConcurrency,
	createClient,
	adapters,
	closeImage,
}: {
	/** The lever (read at every stream open). */
	isOn: () => boolean;
	/** `navigator.hardwareConcurrency`, read when the first worker is wanted. */
	hardwareConcurrency: () => number | undefined;
	/** Starts a worker and its client (the only place a Worker is made). */
	createClient: () => DecodeClient;
	adapters: WorkerSourceAdapters<TCanvas>;
	/** Frees a picture of the worker (`ImageBitmap.close()`). */
	closeImage: (image: TCanvas) => void;
}): DecodeWorkers<TCanvas> {
	let pool: DecodeWorkerPool | null = null;
	let failures = 0;
	let fallbacks = 0;
	/** The streams on each worker, to move them all to the main thread when it dies. */
	const streamsOf = new Map<DecodeClient, Set<FallbackSource<TCanvas>>>();

	const tripped = () => failures >= WORKER_FAILURES_BEFORE_OFF;
	const noteFailure = (failure: WorkerFailure | unknown) => {
		failures += 1;
		console.warn("Decode worker failed, the lever is off for this session:", failure);
	};
	const getPool = (): DecodeWorkerPool => {
		pool ??= new DecodeWorkerPool({
			cap: decodeWorkerCap({ hardwareConcurrency: hardwareConcurrency() }),
			createClient,
			onWorkerFailure: ({ failure, client }) => {
				noteFailure(failure);
				// Its streams go back to the main thread now, not when each next touches it.
				for (const source of [...(client ? (streamsOf.get(client) ?? []) : [])]) {
					source.fallBack(failure);
				}
			},
		});
		return pool;
	};

	return {
		enabled: () => isOn() && !tripped(),
		createStreamSource: ({ main, file }) => {
			if (!isOn() || tripped()) return null;
			const lease = getPool().acquire();
			if (!lease) return null;
			const source = createFallbackSource({
				primary: createWorkerSource({ main, lease, file, adapters }),
				fallback: main,
				onFallback: (failure) => {
					fallbacks += 1;
					streamsOf.get(lease.client)?.delete(source);
					// A fallback without the pool having heard of a failure (a wrong picture).
					if (!tripped()) noteFailure(failure);
				},
			});
			const streams = streamsOf.get(lease.client) ?? new Set();
			streams.add(source);
			streamsOf.set(lease.client, streams);
			return {
				...source,
				dispose: () => {
					streamsOf.get(lease.client)?.delete(source);
					source.dispose();
				},
			};
		},
		createImagePool: ({ quarantine, clock, isHeld }) =>
			new ImageLease<TCanvas>({ close: closeImage, quarantine, clock, isHeld }),
		stats: () => {
			const poolStats = pool?.stats();
			return {
				on: isOn() && !tripped(),
				tripped: tripped(),
				live: poolStats?.live ?? 0,
				cap: poolStats?.cap ?? decodeWorkerCap({ hardwareConcurrency: hardwareConcurrency() }),
				streams: poolStats?.streams ?? 0,
				fallbacks,
			};
		},
		overheadBytes: () => (pool?.stats().live ?? 0) * WORKER_OVERHEAD_BYTES,
	};
}
