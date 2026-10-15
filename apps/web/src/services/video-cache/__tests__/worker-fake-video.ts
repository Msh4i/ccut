import { createFallbackSource } from "../decode-worker/fallback-source";
import type { FromWorkerMessage } from "../decode-worker/protocol";
import { createDecodeClient } from "../decode-worker/client";
import { createDecodeWorkerCore, type WorkerBackend, type WorkerSample } from "../decode-worker/core";
import { ImageLease } from "../decode-worker/image-lease";
import {
	createFakeChannel,
	createFakeClock,
	createImageBook,
	settleHops,
} from "../decode-worker/__tests__/harness";
import { type WorkerSourceAdapters, createWorkerSource } from "../decode-worker/worker-source";
import type { DecodedFrame, FrameSource, StreamFrame } from "../frame-stream";
import { type ScaledCanvasLease, ScaledCanvasPools } from "../scaled-canvases";
import { type FakeCanvas, createFakeVideo } from "./fake-video";

/** Which side of the worker a suite runs its source on. */
export type SourceMode = "main" | "worker";

export const SOURCE_MODES: readonly SourceMode[] = ["main", "worker"];

type FakeWorkerSample = WorkerSample & { index: number; frame: DecodedFrame<FakeCanvas> };

/** Test controls of a fake worker: hold its pictures back, make its draws fail. */
export type WorkerControl = {
	holdRenders: boolean;
	failRenders: boolean;
	held: Array<{ message: FromWorkerMessage; transfer: readonly object[] }>;
	/** Sends the pictures held back, and stops holding. */
	releaseRenders: () => void;
};

export function createWorkerControl(): WorkerControl {
	return { holdRenders: false, failRenders: false, held: [], releaseRenders: () => {} };
}

/**
 * A worker's file over a fake video: the video's frames are its samples. A
 * picture below full size is drawn in the worker (its draw is logged there) and
 * is a plain object with the frame it shows; at full size it is a VideoFrame
 * stand-in naming the frame.
 */
export function fakeBackendOver({
	video,
	control,
}: {
	video: ReturnType<typeof createFakeVideo>;
	control: WorkerControl;
}): WorkerBackend<FakeWorkerSample> {
	const display = video.source.displaySize;
	return {
		displaySize: display,
		frameBytes: video.source.frameBytes ?? { decoded: 1, drawn: 1 },
		rotation: 0,
		samples: ({ startTime }) => {
			const iterator = video.source.openIterator({ startTime });
			return {
				next: async () => {
					const result = await iterator.next();
					if (result.done) return result;
					const frame = result.value;
					return {
						done: false,
						value: {
							timestamp: frame.timestamp,
							duration: frame.duration,
							index: Math.round(frame.timestamp * video.fps),
							frame,
							close: () => frame.close(),
						},
					};
				},
				return: () => iterator.return(),
			};
		},
		render: ({ sample, scale }) => {
			if (control.failRenders) throw new Error("draw failed in the worker");
			const id = sample.index * 1000 + Math.round(scale * 100);
			if (scale < 1) {
				const workerCanvas: FakeCanvas = { id: 0, frame: null, draws: 0, scale, destroyed: false };
				sample.frame.drawInto(workerCanvas);
				const bitmap = {
					id,
					width: Math.max(1, Math.round(display.width * scale)),
					height: Math.max(1, Math.round(display.height * scale)),
					frameIndex: workerCanvas.frame,
					scale,
					detached: false,
				};
				return { image: { kind: "bitmap", bitmap }, transfer: [bitmap] };
			}
			const frame = { id, index: sample.index, detached: false };
			return { image: { kind: "frame", frame }, transfer: [frame] };
		},
		// The worker closes the file with its stream.
		dispose: () => video.source.dispose(),
	};
}

/** What the main side did with the worker's pictures and frames. */
export type MainSideStats = {
	bitmapsClosed: number;
	bitmapsDoubleClosed: number;
	mainSamplesClosed: number;
	mainSamplesDoubleClosed: number;
};

/** The main side's view of a fake worker's pictures (`createWorkerSource`'s adapters). */
export function fakeAdapters({
	video,
	stats,
	discard,
}: {
	video: ReturnType<typeof createFakeVideo>;
	stats: MainSideStats;
	discard: WorkerSourceAdapters<FakeCanvas>["ops"];
}): WorkerSourceAdapters<FakeCanvas> {
	let nextBitmapId = 1;
	return {
		imageOf: (bitmap) => {
			const frameIndex = Reflect.get(bitmap, "frameIndex");
			const scale = Reflect.get(bitmap, "scale");
			if (typeof frameIndex !== "number" || typeof scale !== "number") return null;
			nextBitmapId += 1;
			return { id: -nextBitmapId, frame: frameIndex, draws: 1, scale, destroyed: false };
		},
		sampleOf: ({ frame }) => {
			const index = Reflect.get(frame, "index");
			if (typeof index !== "number") return null;
			let closed = false;
			return {
				timestamp: index / video.fps,
				duration: 1 / video.fps,
				drawInto: (canvas) => {
					if (closed) throw new Error(`frame ${index} drawn after close`);
					if (canvas.destroyed) {
						video.log.drawsIntoDestroyed += 1;
						return;
					}
					canvas.frame = index;
					canvas.draws += 1;
					video.log.drawn.push(index);
				},
				close: () => {
					if (closed) stats.mainSamplesDoubleClosed += 1;
					closed = true;
					stats.mainSamplesClosed += 1;
				},
			};
		},
		ops: discard,
	};
}

/**
 * `createFakeVideo` whose decoder runs behind the whole worker stack: the fake
 * video's frames are the worker's samples (core), pictures cross a fake channel
 * (structured clone, setImmediate delivery, transfer marks), the main side is
 * the client, `createWorkerSource` and a `FallbackSource`. What the tests
 * observe (`log`, canvases, counters) stays comparable with the main-thread
 * run of the same fake video. A picture below full size is drawn in the worker
 * (its draw is logged there) and arrives as a canvas of the cache; at full
 * size the main side draws it, as `wrapSample` does.
 */
export function createWorkerBackedVideo({
	video: videoOptions = {},
	quarantine = 3,
}: {
	video?: Parameters<typeof createFakeVideo>[0];
	/** Draws a picture waits after its last hand-out before it is closed (0: closed once released). */
	quarantine?: number;
} = {}) {
	const video = createFakeVideo(videoOptions);
	const control = createWorkerControl();
	const channel = createFakeChannel();
	const clock = createFakeClock();
	const book = createImageBook();
	const stats: MainSideStats = { bitmapsClosed: 0, bitmapsDoubleClosed: 0, mainSamplesClosed: 0, mainSamplesDoubleClosed: 0 };
	const fallbacks: unknown[] = [];

	const core = createDecodeWorkerCore<FakeWorkerSample>({
		post: ({ message, transfer }) => {
			if (control.holdRenders && message.type === "rendered") {
				control.held.push({ message, transfer });
				return;
			}
			channel.worker.post({ message, transfer });
		},
		openBackend: async () => fakeBackendOver({ video, control }),
	});
	channel.worker.onMessage((data) => core.handle(data));
	control.releaseRenders = () => {
		control.holdRenders = false;
		for (const entry of control.held.splice(0)) channel.worker.post(entry);
	};
	const client = createDecodeClient({ channel: channel.main, clock, ops: book.ops });

	// One draw clock for pictures and canvases.
	const clockOfPools = { draws: 0 };
	const lease = new ImageLease<FakeCanvas>({
		close: (image) => {
			if (image.destroyed) stats.bitmapsDoubleClosed += 1;
			image.destroyed = true;
			image.frame = null;
			stats.bitmapsClosed += 1;
		},
		quarantine: () => quarantine,
		clock: clockOfPools,
	});
	const canvases: ScaledCanvasLease<FakeCanvas> = new ScaledCanvasPools<FakeCanvas>({
		create: (args) => video.source.createCanvas(args),
		destroy: (canvas) => video.source.destroyCanvas?.({ canvas }),
		quarantine: () => quarantine,
		maxFree: () => 3,
		clock: clockOfPools,
		images: lease,
	});

	const workerLease = { client, streamId: 1, release: () => {} };
	const workerOnly = createWorkerSource<FakeCanvas>({
		main: video.source,
		lease: workerLease,
		file: { name: "fake.mp4" },
		adapters: fakeAdapters({ video, stats, discard: book.ops }),
	});
	const source = createFallbackSource<FakeCanvas>({
		primary: workerOnly,
		fallback: video.source,
		onFallback: (failure) => fallbacks.push(failure),
	});

	return {
		...video,
		source,
		/** The worker's own source, without the fall back to the main thread. */
		workerOnly,
		control,
		canvases,
		pictures: lease,
		world: { channel, clock, book, core, client },
		stats,
		fallbacks,
	};
}

/** A fake video as the suites use it: either source mode, frames of either kind. */
export type SuiteVideo = Omit<ReturnType<typeof createFakeVideo>, "source"> & {
	source: FrameSource<FakeCanvas, StreamFrame<FakeCanvas>>;
	/** Canvases (with the worker's pictures) to hand to a stream; none: its default. */
	canvases: ScaledCanvasLease<FakeCanvas> | undefined;
};

/** The fake video of a suite for `mode`, with the settle that lets a worker's messages through. */
export function videoFactory({ mode }: { mode: SourceMode }) {
	return {
		createVideo: (options: Parameters<typeof createFakeVideo>[0] = {}): SuiteVideo =>
			mode === "worker" ? createWorkerBackedVideo({ video: options }) : { ...createFakeVideo(options), canvases: undefined },
		settle: async () => {
			// Each frame takes two message hops (pull, frame): a read-ahead of eight needs about thirty.
			await settleHops(mode === "worker" ? 40 : 1);
		},
	};
}
