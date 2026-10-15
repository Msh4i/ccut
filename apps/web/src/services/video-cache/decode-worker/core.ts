import { normalizeScale } from "../frame-scale";
import {
	type ErrorTarget,
	type FrameBytesWire,
	type FromWorkerMessage,
	type ToWorkerMessage,
	type WireImage,
	type WireRotation,
	parseToWorker,
} from "./protocol";

/**
 * The logic of a decode worker, with the media parts injected (mediabunny and
 * the OffscreenCanvas in `worker.ts`, fakes in tests). The worker owns every
 * decoded sample it hands the main thread a handle of, until the main thread
 * says `close` (or the stream is disposed): a sample is removed from the map
 * first and closed once.
 */

/** A decoded frame in the worker. */
export type WorkerSample = {
	readonly timestamp: number;
	readonly duration: number;
	close: () => void;
};

export type SampleIterator<TSample> = {
	next: () => Promise<IteratorResult<TSample, unknown>>;
	/** Stops the decoder; a pending `next` ends. */
	return: () => Promise<unknown>;
};

/** An opened file in the worker (one per stream). */
export type WorkerBackend<TSample> = {
	displaySize: { width: number; height: number };
	frameBytes: FrameBytesWire;
	rotation: WireRotation;
	/** The decoder of `FrameSource.openIterator`: the frame at `startTime` first, then every later one. */
	samples: ({ startTime }: { startTime: number }) => SampleIterator<TSample>;
	/**
	 * The picture of a sample. A scale below 1 gives an ImageBitmap of the scaled
	 * size, drawn as the main thread draws a preview frame; scale 1 gives a
	 * VideoFrame for the main thread to draw. `transfer` lists what moves with
	 * the message (the sender lets go of it).
	 */
	render: ({ sample, scale }: { sample: TSample; scale: number }) => {
		image: WireImage;
		transfer: object[];
	};
	/** Closes the file (and the decoder state with it). */
	dispose: () => void;
};

export type WorkerCoreDeps<TSample extends WorkerSample> = {
	post: ({
		message,
		transfer,
	}: {
		message: FromWorkerMessage;
		transfer: readonly object[];
	}) => void;
	openBackend: ({ file }: { file: object }) => Promise<WorkerBackend<TSample>>;
};

export type WorkerCoreStats = {
	openStreams: number;
	openIterators: number;
	/** Samples held for the main thread and not closed yet. */
	openFrames: number;
	/** `close` for a frame the worker does not hold (already closed or never there). */
	unknownCloses: number;
	/** `render` for a frame the worker does not hold. */
	unknownFrames: number;
	/** Messages that failed the shape check. */
	rejected: number;
};

type StreamState<TSample> = {
	backend: WorkerBackend<TSample> | null;
	disposed: boolean;
	iterators: Set<number>;
	frames: Set<number>;
};

type IteratorState<TSample> = {
	streamId: number;
	source: SampleIterator<TSample> | null;
	failure: string | null;
	returned: boolean;
	/** Pulls of one iterator run one after another. */
	queue: Promise<void>;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDecodeWorkerCore<TSample extends WorkerSample>(
	deps: WorkerCoreDeps<TSample>,
): { handle: (raw: unknown) => void; stats: () => WorkerCoreStats } {
	const streams = new Map<number, StreamState<TSample>>();
	const iterators = new Map<number, IteratorState<TSample>>();
	const frames = new Map<number, { streamId: number; sample: TSample }>();
	let nextFrameId = 1;
	let unknownCloses = 0;
	let unknownFrames = 0;
	let rejected = 0;

	const post = ({
		message,
		transfer = [],
	}: {
		message: FromWorkerMessage;
		transfer?: readonly object[];
	}) => deps.post({ message, transfer });
	const postError = ({ target, id, error }: { target: ErrorTarget; id: number; error: unknown }) =>
		post({ message: { type: "error", target, id, message: messageOf(error) } });

	function closeSample(sample: TSample): void {
		try {
			sample.close();
		} catch {
			// A sample that cannot be closed is gone either way.
		}
	}

	function stopSource(source: SampleIterator<TSample> | null): void {
		source?.return().catch(() => {});
	}

	function openStream({ streamId, file }: { streamId: number; file: object }): void {
		if (streams.has(streamId)) {
			postError({ target: "open", id: streamId, error: "stream already open" });
			return;
		}
		const state: StreamState<TSample> = {
			backend: null,
			disposed: false,
			iterators: new Set(),
			frames: new Set(),
		};
		streams.set(streamId, state);
		deps.openBackend({ file }).then(
			(backend) => {
				if (state.disposed) {
					// Disposed while opening: nothing may keep the file open.
					backend.dispose();
					return;
				}
				state.backend = backend;
				post({
					message: {
						type: "opened",
						streamId,
						displaySize: backend.displaySize,
						frameBytes: backend.frameBytes,
						rotation: backend.rotation,
					},
				});
			},
			(error) => {
				if (state.disposed) return;
				streams.delete(streamId);
				postError({ target: "open", id: streamId, error });
			},
		);
	}

	function startIterator({
		streamId,
		iteratorId,
		startTime,
	}: {
		streamId: number;
		iteratorId: number;
		startTime: number;
	}): void {
		const stream = streams.get(streamId);
		if (!stream?.backend || stream.disposed || iterators.has(iteratorId)) return;
		const state: IteratorState<TSample> = {
			streamId,
			source: null,
			failure: null,
			returned: false,
			queue: Promise.resolve(),
		};
		try {
			state.source = stream.backend.samples({ startTime });
		} catch (error) {
			state.failure = messageOf(error);
		}
		iterators.set(iteratorId, state);
		stream.iterators.add(iteratorId);
	}

	async function pullOne({
		iteratorId,
		state,
	}: {
		iteratorId: number;
		state: IteratorState<TSample>;
	}): Promise<void> {
		if (state.returned) return;
		if (state.failure !== null || !state.source) {
			postError({ target: "pull", id: iteratorId, error: state.failure ?? "no decoder" });
			return;
		}
		let result: IteratorResult<TSample, unknown>;
		try {
			result = await state.source.next();
		} catch (error) {
			if (!state.returned) postError({ target: "pull", id: iteratorId, error });
			return;
		}
		if (state.returned) {
			// The main thread stopped this decoder meanwhile and no longer waits
			// for the frame: it would never be closed.
			if (!result.done) closeSample(result.value);
			return;
		}
		if (result.done) {
			post({ message: { type: "done", iteratorId } });
			return;
		}
		const frameId = nextFrameId;
		nextFrameId += 1;
		frames.set(frameId, { streamId: state.streamId, sample: result.value });
		streams.get(state.streamId)?.frames.add(frameId);
		post({
			message: {
				type: "frame",
				iteratorId,
				frameId,
				timestamp: result.value.timestamp,
				duration: result.value.duration,
			},
		});
	}

	function pull({ iteratorId }: { iteratorId: number }): void {
		const state = iterators.get(iteratorId);
		if (!state) {
			postError({ target: "pull", id: iteratorId, error: "unknown iterator" });
			return;
		}
		state.queue = state.queue.then(() => pullOne({ iteratorId, state }));
	}

	function render({
		requestId,
		frameId,
		scale,
	}: {
		requestId: number;
		frameId: number;
		scale: number;
	}): void {
		const held = frames.get(frameId);
		const backend = held ? streams.get(held.streamId)?.backend : null;
		if (!held || !backend) {
			unknownFrames += 1;
			postError({ target: "render", id: requestId, error: "unknown frame" });
			return;
		}
		let output: ReturnType<WorkerBackend<TSample>["render"]>;
		try {
			output = backend.render({ sample: held.sample, scale: normalizeScale(scale) });
		} catch (error) {
			postError({ target: "render", id: requestId, error });
			return;
		}
		post({
			message: { type: "rendered", requestId, image: output.image },
			transfer: output.transfer,
		});
	}

	function closeFrame({ frameId }: { frameId: number }): void {
		const held = frames.get(frameId);
		if (!held) {
			unknownCloses += 1;
			return;
		}
		// Forgotten first: a second close finds nothing and closes nothing.
		frames.delete(frameId);
		streams.get(held.streamId)?.frames.delete(frameId);
		closeSample(held.sample);
	}

	function returnIterator({ iteratorId }: { iteratorId: number }): void {
		const state = iterators.get(iteratorId);
		if (!state) return;
		state.returned = true;
		iterators.delete(iteratorId);
		streams.get(state.streamId)?.iterators.delete(iteratorId);
		stopSource(state.source);
	}

	function disposeStream({ streamId }: { streamId: number }): void {
		const stream = streams.get(streamId);
		if (stream) {
			streams.delete(streamId);
			stream.disposed = true;
			for (const iteratorId of [...stream.iterators]) returnIterator({ iteratorId });
			for (const frameId of [...stream.frames]) closeFrame({ frameId });
			try {
				stream.backend?.dispose();
			} catch {
				// Already gone.
			}
		}
		post({ message: { type: "disposed", streamId } });
	}

	function dispatch(message: ToWorkerMessage): void {
		switch (message.type) {
			case "open":
				openStream(message);
				return;
			case "iterate":
				startIterator(message);
				return;
			case "pull":
				pull(message);
				return;
			case "render":
				render(message);
				return;
			case "close":
				closeFrame(message);
				return;
			case "return":
				returnIterator(message);
				return;
			case "dispose":
				disposeStream(message);
				return;
		}
	}

	return {
		handle: (raw) => {
			const message = parseToWorker(raw);
			if (!message) {
				rejected += 1;
				return;
			}
			dispatch(message);
		},
		stats: () => ({
			openStreams: streams.size,
			openIterators: iterators.size,
			openFrames: frames.size,
			unknownCloses,
			unknownFrames,
			rejected,
		}),
	};
}
