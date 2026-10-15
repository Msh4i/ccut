import type { FrameIterator, FrameSource, StreamFrame } from "../frame-stream";
import { isWorkerFailure } from "./failure";

/**
 * A stream's source that starts on a decode worker and, the first time the
 * worker fails (`WorkerFailure`: it crashed, hung, could not open the file or
 * sent something unusable), goes on with the main thread's decoder for good.
 *
 * The stream is not told: its iterator or its frame's `render` rejects once
 * with the failure, the stream restarts its decoder (`openIterator`), and that
 * one comes from the main thread. Errors that are not worker failures (a frame
 * that cannot be decoded or drawn) pass through untouched.
 */
export type FallbackSource<TCanvas> = FrameSource<TCanvas, StreamFrame<TCanvas>> & {
	/** The stream moved to the main thread. */
	hasFallenBack: () => boolean;
	/**
	 * Moves the stream to the main thread now (its worker is known to be dead):
	 * the stream's next decoder is the main thread's. Once; later calls do nothing.
	 */
	fallBack: (failure: unknown) => void;
};

export function createFallbackSource<TCanvas>({
	primary,
	fallback,
	onFallback,
}: {
	/** The worker's source. */
	primary: FrameSource<TCanvas, StreamFrame<TCanvas>>;
	/** The main thread's source of the same file. */
	fallback: FrameSource<TCanvas>;
	/** Once, with the failure that ended the worker's turn. */
	onFallback: (failure: unknown) => void;
}): FallbackSource<TCanvas> {
	let fellBack = false;
	let disposed = false;

	function trip(failure: unknown): void {
		// A deliberate shutdown (the stream was disposed) is not a worker failure.
		if (fellBack || disposed) return;
		fellBack = true;
		onFallback(failure);
		// Frees the worker's place of this stream.
		try {
			primary.dispose();
		} catch {
			// Already gone.
		}
	}

	function guarded<T>(promise: Promise<T>): Promise<T> {
		return promise.catch((error: unknown) => {
			if (isWorkerFailure(error)) trip(error);
			throw error;
		});
	}

	function guardFrame(frame: StreamFrame<TCanvas>): StreamFrame<TCanvas> {
		if (!("render" in frame)) return frame;
		return {
			timestamp: frame.timestamp,
			duration: frame.duration,
			render: (args) => guarded(frame.render(args)),
			close: () => frame.close(),
		};
	}

	function wrap(
		iterator: FrameIterator<TCanvas, StreamFrame<TCanvas>>,
	): FrameIterator<TCanvas, StreamFrame<TCanvas>> {
		return {
			next: async () => {
				const result = await guarded(iterator.next());
				return result.done ? result : { done: false, value: guardFrame(result.value) };
			},
			return: () => guarded(iterator.return()).catch(() => undefined),
		};
	}

	return {
		// The main thread's source knows the file: sizes, canvases, key frames.
		...(fallback.frameBytes && { frameBytes: fallback.frameBytes }),
		displaySize: fallback.displaySize,
		createCanvas: (args) => fallback.createCanvas(args),
		...(fallback.destroyCanvas && {
			destroyCanvas: (args: { canvas: TCanvas }) => fallback.destroyCanvas?.(args),
		}),
		keyframeAtOrBefore: (args) => fallback.keyframeAtOrBefore(args),
		openIterator: ({ startTime }) => {
			if (fellBack) return fallback.openIterator({ startTime });
			try {
				return wrap(primary.openIterator({ startTime }));
			} catch (error) {
				if (!isWorkerFailure(error)) throw error;
				trip(error);
				return fallback.openIterator({ startTime });
			}
		},
		// The media entry owns the main thread's source; only the worker's stream goes.
		dispose: () => {
			disposed = true;
			primary.dispose();
		},
		hasFallenBack: () => fellBack,
		fallBack: trip,
	};
}
