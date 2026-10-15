import { WorkerFailure } from "./failure";
import {
	type FrameBytesWire,
	type ToWorkerMessage,
	type WireImage,
	type WireRotation,
	parseFromWorker,
} from "./protocol";

/**
 * The main thread's side of one decode worker, over a `Channel` (a real
 * Worker in the app, a fake in tests).
 *
 * Ownership of a frame: the worker holds the decoded sample until the handle
 * the client gives out is closed here (`close` posts to the worker; a second
 * `close` is only counted). A frame that arrives after its `next` was answered
 * (the decoder was returned meanwhile) is closed by the client itself and
 * counted as late. A picture that arrives after nobody waits for it is
 * discarded.
 *
 * Errors: an error the worker reports for one call rejects that call with an
 * ordinary `Error` (as a main-thread decoder would). Anything that makes the
 * worker unusable (its channel broke, a call timed out, it could not open the
 * file) is a `WorkerFailure`: every pending call rejects with it and the
 * client is dead from then on.
 */

export type Channel = {
	/** Posts a message; `transfer` lists the objects that move with it. */
	post: ({
		message,
		transfer,
	}: {
		message: ToWorkerMessage;
		transfer?: readonly object[];
	}) => void;
	onMessage: (handler: (data: unknown) => void) => void;
	/** The worker crashed or sent something that cannot be read. */
	onFailure: (handler: (reason: string) => void) => void;
	/** Ends the worker; nothing is delivered afterwards. */
	terminate: () => void;
};

/** Timers, injected so tests run on a fake clock. */
export type TimerClock = {
	setTimer: ({ run, ms }: { run: () => void; ms: number }) => unknown;
	clearTimer: (handle: unknown) => void;
};

/** What the client does with a picture nobody wants (closes the bitmap or the VideoFrame). */
export type ImageOps = {
	discard: (image: WireImage) => void;
};

/**
 * How long a call may wait for the worker before it is declared hung
 * (OWNER DECISION, none measured). A pull may wait for a decoder start from a
 * key frame, so its limit is generous; a render is a draw.
 */
export type ClientTimeouts = { openMs: number; pullMs: number; renderMs: number };

export const DEFAULT_CLIENT_TIMEOUTS: ClientTimeouts = {
	openMs: 15_000,
	pullMs: 20_000,
	renderMs: 5_000,
};

export type OpenedStream = {
	displaySize: { width: number; height: number };
	frameBytes: FrameBytesWire;
	rotation: WireRotation;
};

/** A decoded frame in the worker, as the main thread sees it. */
export type ClientFrame = {
	readonly timestamp: number;
	readonly duration: number;
	/** Asks the worker for the picture; rejects when the frame is closed or the call fails. */
	render: ({ scale }: { scale: number }) => Promise<WireImage>;
	/** Lets the worker close the frame; once, a second call is only counted. */
	close: () => void;
};

export type ClientIterator = {
	next: () => Promise<IteratorResult<ClientFrame, unknown>>;
	/** Stops the decoder; pending `next` calls end with `done`. */
	return: () => Promise<unknown>;
};

export type ClientStats = {
	/** Frames that arrived after their `next` was answered; the client closed them. */
	lateFrames: number;
	/** Pictures that arrived after nobody waited for them; discarded. */
	lateRenders: number;
	/** Second `close` calls on a handle. */
	doubleCloses: number;
	/** Messages that failed the shape check. */
	rejected: number;
};

export type DecodeClient = {
	openStream: ({ streamId, file }: { streamId: number; file: object }) => Promise<OpenedStream>;
	/** The decoder of a stream (opened first); frames come with `next`. */
	openIterator: ({ streamId, startTime }: { streamId: number; startTime: number }) => ClientIterator;
	/** Closes the stream's file in the worker, its decoders and frames with it. */
	disposeStream: ({ streamId }: { streamId: number }) => void;
	/** Ends the worker on purpose (no streams left): not a failure. */
	shutdown: () => void;
	isAlive: () => boolean;
	/** Called once when the worker fails (not on `shutdown`). */
	onFailure: (handler: (failure: WorkerFailure) => void) => void;
	stats: () => ClientStats;
};

type Pending<T> = {
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	timer: unknown;
};

const DONE: IteratorResult<ClientFrame, unknown> = { done: true, value: undefined };

export function createDecodeClient({
	channel,
	clock,
	ops,
	timeouts = DEFAULT_CLIENT_TIMEOUTS,
}: {
	channel: Channel;
	clock: TimerClock;
	ops: ImageOps;
	timeouts?: ClientTimeouts;
}): DecodeClient {
	let dead: WorkerFailure | null = null;
	let nextIteratorId = 1;
	let nextRequestId = 1;
	const failureHandlers: Array<(failure: WorkerFailure) => void> = [];
	const streams = new Map<number, { opened: Promise<OpenedStream> }>();
	const iterators = new Map<number, { streamId: number; started: boolean; returned: boolean }>();
	const opens = new Map<number, Pending<OpenedStream>>();
	const pulls = new Map<number, Array<Pending<IteratorResult<ClientFrame, unknown>>>>();
	const renders = new Map<number, Pending<WireImage>>();
	const stats: ClientStats = { lateFrames: 0, lateRenders: 0, doubleCloses: 0, rejected: 0 };

	function end({ failure, silent }: { failure: WorkerFailure; silent: boolean }): void {
		if (dead) return;
		dead = failure;
		const pendings: Array<{ timer: unknown; reject: (error: unknown) => void }> = [];
		for (const pending of opens.values()) pendings.push(pending);
		for (const queue of pulls.values()) pendings.push(...queue);
		for (const pending of renders.values()) pendings.push(pending);
		opens.clear();
		pulls.clear();
		renders.clear();
		for (const pending of pendings) {
			clock.clearTimer(pending.timer);
			pending.reject(failure);
		}
		channel.terminate();
		if (!silent) for (const handler of failureHandlers) handler(failure);
	}

	const fail = ({ message, cause }: { message: string; cause?: unknown }) =>
		end({ failure: new WorkerFailure({ message, cause }), silent: false });

	function send({
		message,
		transfer,
	}: {
		message: ToWorkerMessage;
		transfer?: readonly object[];
	}): void {
		if (dead) return;
		try {
			channel.post({ message, ...(transfer && { transfer }) });
		} catch (error) {
			fail({ message: "decode worker: a message could not be posted", cause: error });
		}
	}

	/** A promise settled by a message, or by the watchdog (the whole worker is then declared hung). */
	function track<T>({
		table,
		ms,
		what,
	}: {
		table: (pending: Pending<T>) => void;
		ms: number;
		what: string;
	}): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const pending: Pending<T> = {
				resolve,
				reject,
				timer: clock.setTimer({ run: () => fail({ message: `decode worker: ${what} timed out` }), ms }),
			};
			table(pending);
		});
	}

	function settle<T>({ pending, value }: { pending: Pending<T> | undefined; value: T }): boolean {
		if (!pending) return false;
		clock.clearTimer(pending.timer);
		pending.resolve(value);
		return true;
	}

	function rejectPending<T>({
		pending,
		error,
	}: {
		pending: Pending<T> | undefined;
		error: unknown;
	}): void {
		if (!pending) return;
		clock.clearTimer(pending.timer);
		pending.reject(error);
	}

	function makeFrame({
		frameId,
		timestamp,
		duration,
	}: {
		frameId: number;
		timestamp: number;
		duration: number;
	}): ClientFrame {
		let closed = false;
		return {
			timestamp,
			duration,
			render: ({ scale }) => {
				if (closed) return Promise.reject(new Error("The frame is closed"));
				if (dead) return Promise.reject(dead);
				const requestId = nextRequestId;
				nextRequestId += 1;
				const answer = track<WireImage>({
					table: (pending) => renders.set(requestId, pending),
					ms: timeouts.renderMs,
					what: "a render",
				});
				send({ message: { type: "render", requestId, frameId, scale } });
				return answer;
			},
			close: () => {
				if (closed) {
					stats.doubleCloses += 1;
					return;
				}
				closed = true;
				send({ message: { type: "close", frameId } });
			},
		};
	}

	channel.onMessage((data) => {
		const message = parseFromWorker(data);
		if (dead) {
			// Nothing is delivered after the end; a picture still in flight is discarded.
			if (message?.type === "rendered") ops.discard(message.image);
			return;
		}
		if (!message) {
			stats.rejected += 1;
			return;
		}
		switch (message.type) {
			case "opened": {
				const pending = opens.get(message.streamId);
				opens.delete(message.streamId);
				settle({
					pending,
					value: {
						displaySize: message.displaySize,
						frameBytes: message.frameBytes,
						rotation: message.rotation,
					},
				});
				return;
			}
			case "frame": {
				const pending = pulls.get(message.iteratorId)?.shift();
				if (pending) {
					settle({
						pending,
						value: { done: false, value: makeFrame(message) },
					});
					return;
				}
				// Its `next` was answered by a return: nobody will close it.
				stats.lateFrames += 1;
				send({ message: { type: "close", frameId: message.frameId } });
				return;
			}
			case "done": {
				settle({ pending: pulls.get(message.iteratorId)?.shift(), value: DONE });
				return;
			}
			case "rendered": {
				const pending = renders.get(message.requestId);
				renders.delete(message.requestId);
				if (!settle({ pending, value: message.image })) {
					stats.lateRenders += 1;
					ops.discard(message.image);
				}
				return;
			}
			case "error": {
				if (message.target === "open") {
					const pending = opens.get(message.id);
					opens.delete(message.id);
					streams.delete(message.id);
					// A worker that cannot open the file is not usable for this stream.
					rejectPending({
						pending,
						error: new WorkerFailure({ message: `decode worker could not open the file: ${message.message}` }),
					});
				} else if (message.target === "pull") {
					rejectPending({
						pending: pulls.get(message.id)?.shift(),
						error: new Error(message.message),
					});
				} else {
					const pending = renders.get(message.id);
					renders.delete(message.id);
					rejectPending({ pending, error: new Error(message.message) });
				}
				return;
			}
			case "disposed":
				return;
		}
	});
	channel.onFailure((reason) => fail({ message: `decode worker failed: ${reason}` }));

	function finishIterator({ iteratorId }: { iteratorId: number }): void {
		const state = iterators.get(iteratorId);
		if (!state || state.returned) return;
		state.returned = true;
		iterators.delete(iteratorId);
		const queue = pulls.get(iteratorId) ?? [];
		pulls.delete(iteratorId);
		for (const pending of queue) settle({ pending, value: DONE });
		if (state.started) send({ message: { type: "return", iteratorId } });
	}

	return {
		openStream: ({ streamId, file }) => {
			if (dead) return Promise.reject(dead);
			const opened = track<OpenedStream>({
				table: (pending) => opens.set(streamId, pending),
				ms: timeouts.openMs,
				what: "opening a file",
			});
			// A stream disposed before anyone awaited its opening must not leave an unhandled rejection.
			opened.catch(() => {});
			streams.set(streamId, { opened });
			send({ message: { type: "open", streamId, file } });
			return opened;
		},
		openIterator: ({ streamId, startTime }) => {
			const stream = streams.get(streamId);
			if (dead) throw dead;
			if (!stream) throw new Error("The stream is not open");
			const iteratorId = nextIteratorId;
			nextIteratorId += 1;
			iterators.set(iteratorId, { streamId, started: false, returned: false });
			return {
				next: async () => {
					const state = iterators.get(iteratorId);
					if (!state || state.returned) return DONE;
					if (dead) throw dead;
					await stream.opened;
					if (state.returned) return DONE;
					if (dead) throw dead;
					if (!state.started) {
						state.started = true;
						send({ message: { type: "iterate", streamId, iteratorId, startTime } });
					}
					const answer = track<IteratorResult<ClientFrame, unknown>>({
						table: (pending) => {
							const queue = pulls.get(iteratorId) ?? [];
							queue.push(pending);
							pulls.set(iteratorId, queue);
						},
						ms: timeouts.pullMs,
						what: "a pull",
					});
					send({ message: { type: "pull", iteratorId } });
					return answer;
				},
				return: async () => {
					finishIterator({ iteratorId });
					return undefined;
				},
			};
		},
		disposeStream: ({ streamId }) => {
			if (!streams.delete(streamId)) return;
			for (const [iteratorId, state] of iterators) {
				if (state.streamId !== streamId) continue;
				finishIterator({ iteratorId });
			}
			const opening = opens.get(streamId);
			opens.delete(streamId);
			rejectPending({ pending: opening, error: new Error("The stream was disposed") });
			send({ message: { type: "dispose", streamId } });
		},
		shutdown: () => end({ failure: new WorkerFailure({ message: "decode worker shut down" }), silent: true }),
		isAlive: () => dead === null,
		onFailure: (handler) => {
			failureHandlers.push(handler);
		},
		stats: () => ({ ...stats }),
	};
}
