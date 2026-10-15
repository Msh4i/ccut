import { scaledFrameSize } from "../frame-scale";
import type {
	AsyncDecodedFrame,
	DecodedFrame,
	FrameIterator,
	FrameSource,
	StreamFrame,
} from "../frame-stream";
import type { ClientFrame, ImageOps, OpenedStream } from "./client";
import { WorkerFailure } from "./failure";
import type { WorkerLease } from "./pool";
import type { WireBitmap, WireRotation, WireVideoFrame } from "./protocol";

/**
 * How pictures from a worker become the cache's own types: ImageBitmaps are
 * the cache's canvases at scales below 1, a VideoFrame is drawn on the main
 * thread by the same code as a main-thread frame (`wrapSample`). In the app
 * these test the platform classes (`instanceof ImageBitmap`); tests pass fakes.
 */
export type WorkerSourceAdapters<TCanvas> = {
	/** The bitmap as a canvas of the cache; null when it is not one. */
	imageOf: (bitmap: WireBitmap) => TCanvas | null;
	/** The VideoFrame as a frame the stream draws and closes; null when it is not one. */
	sampleOf: ({
		frame,
		rotation,
		display,
	}: {
		frame: WireVideoFrame;
		rotation: WireRotation;
		display: { width: number; height: number };
	}) => DecodedFrame<TCanvas> | null;
	/** Closes a picture that cannot be used. */
	ops: ImageOps;
};

/**
 * The frame source of one stream on a decode worker: the decoder runs in the
 * worker (`worker.ts`), everything about the file itself (sizes, canvases,
 * key frame lookup) comes from the main thread's source of the same file.
 * Pictures are checked against what the main thread expects (the size of
 * `scaledFrameSize`); anything else is a `WorkerFailure`, so the stream moves
 * back to the main thread (`fallback-source.ts`) instead of showing a wrong
 * picture.
 *
 * The worker's file is opened right away; the first `next` waits for it.
 */
export function createWorkerSource<TCanvas>({
	main,
	lease,
	file,
	adapters,
}: {
	main: FrameSource<TCanvas>;
	lease: WorkerLease;
	file: object;
	adapters: WorkerSourceAdapters<TCanvas>;
}): FrameSource<TCanvas, StreamFrame<TCanvas>> {
	const { client, streamId } = lease;
	const display = main.displaySize;
	let disposed = false;

	const ready: Promise<OpenedStream> = client.openStream({ streamId, file }).then((opened) => {
		if (opened.displaySize.width !== display.width || opened.displaySize.height !== display.height) {
			throw new WorkerFailure({
				message: `The worker sees the video at ${opened.displaySize.width}x${opened.displaySize.height}, the main thread at ${display.width}x${display.height}`,
			});
		}
		return opened;
	});
	ready.catch(() => {});

	function wrapFrame({
		handle,
		rotation,
	}: {
		handle: ClientFrame;
		rotation: WireRotation;
	}): AsyncDecodedFrame<TCanvas> {
		return {
			timestamp: handle.timestamp,
			duration: handle.duration,
			render: async ({ scale }) => {
				const image = await handle.render({ scale });
				if (image.kind === "bitmap") {
					const expected = scaledFrameSize({ ...display, scale });
					const canvas =
						image.bitmap.width === expected.width && image.bitmap.height === expected.height
							? adapters.imageOf(image.bitmap)
							: null;
					if (canvas === null) {
						adapters.ops.discard(image);
						throw new WorkerFailure({ message: "The worker sent a picture of the wrong kind or size" });
					}
					return { kind: "image", image: canvas };
				}
				const frame = adapters.sampleOf({ frame: image.frame, rotation, display });
				if (frame === null) {
					adapters.ops.discard(image);
					throw new WorkerFailure({ message: "The worker sent a frame that is not a VideoFrame" });
				}
				return { kind: "sample", frame };
			},
			close: () => handle.close(),
		};
	}

	function openIterator({
		startTime,
	}: {
		startTime: number;
	}): FrameIterator<TCanvas, StreamFrame<TCanvas>> {
		const inner = client.openIterator({ streamId, startTime });
		return {
			next: async () => {
				const opened = await ready;
				const result = await inner.next();
				return result.done
					? result
					: { done: false, value: wrapFrame({ handle: result.value, rotation: opened.rotation }) };
			},
			return: () => inner.return(),
		};
	}

	return {
		...(main.frameBytes && { frameBytes: main.frameBytes }),
		displaySize: main.displaySize,
		createCanvas: (args) => main.createCanvas(args),
		...(main.destroyCanvas && {
			destroyCanvas: (args: { canvas: TCanvas }) => main.destroyCanvas?.(args),
		}),
		keyframeAtOrBefore: (args) => main.keyframeAtOrBefore(args),
		openIterator,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			client.disposeStream({ streamId });
			lease.release();
		},
	};
}
