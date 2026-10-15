import type {
	DecodedFrame,
	FrameIterator,
	FrameSource,
} from "../frame-stream";

/** A canvas stand-in that remembers which frame was drawn into it last. */
export type FakeCanvas = {
	id: number;
	frame: number | null;
	draws: number;
	/** The scale it was created for (1: the display size). */
	scale: number;
	/** Its backing was freed (`destroyCanvas`): it shows nothing any more. */
	destroyed: boolean;
};

export type FakeVideoLog = {
	/** Start time of every decoder (iterator) opened. */
	opened: number[];
	/** Frames decoded, including the ones a decoder skips to reach its start. */
	decoded: number;
	/** Frames handed out by iterators. */
	delivered: number;
	closed: number;
	doubleClosed: number;
	/** Frame indices drawn into canvases, in order. */
	drawn: number[];
	canvases: number;
	/** Scale of every canvas created, in order. */
	canvasScales: number[];
	keyframeLookups: number;
	returned: number;
	disposed: boolean;
	/** Times `dispose` was called (a shared source must be disposed exactly once). */
	disposals: number;
	/** Canvases destroyed, a canvas destroyed twice, and frames drawn into a destroyed canvas. */
	destroyed: number;
	doubleDestroyed: number;
	drawsIntoDestroyed: number;
};

/**
 * A video of `frameCount` frames at `fps` with a key frame every
 * `keyframeInterval` frames, decoded like mediabunny's `samples(start)`: from
 * the key frame at or before `start`, frames before the last one at or before
 * `start` are decoded and dropped.
 *
 * `manual` decoding hands out a frame only after the test released one with
 * `release`; `instant` decoding resolves every `next()` right away.
 */
export function createFakeVideo({
	fps = 30,
	frameCount = 300,
	keyframeInterval = 30,
	decode = "instant",
	failAtDelivery = -1,
	frameBytes,
	displaySize = { width: 1920, height: 1080 },
}: {
	fps?: number;
	frameCount?: number;
	keyframeInterval?: number;
	decode?: "instant" | "manual";
	/** The decoder throws once, instead of handing out frame number `failAtDelivery` (0-based count). */
	failAtDelivery?: number;
	/** Bytes of one decoded / drawn frame the source reports (none: the cache's 1080p estimate). */
	frameBytes?: { decoded: number; drawn: number };
	displaySize?: { width: number; height: number };
} = {}) {
	const log: FakeVideoLog = {
		opened: [],
		decoded: 0,
		delivered: 0,
		closed: 0,
		doubleClosed: 0,
		drawn: [],
		canvases: 0,
		canvasScales: [],
		keyframeLookups: 0,
		returned: 0,
		disposed: false,
		disposals: 0,
		destroyed: 0,
		doubleDestroyed: 0,
		drawsIntoDestroyed: 0,
	};
	let budget = decode === "instant" ? Number.POSITIVE_INFINITY : 0;
	let failed = false;
	let waiters: Array<() => void> = [];

	const frameIndexAt = (time: number) =>
		Math.min(frameCount - 1, Math.max(0, Math.floor(time * fps + 1e-9)));

	function makeFrame(index: number): DecodedFrame<FakeCanvas> {
		let closed = false;
		return {
			timestamp: index / fps,
			duration: 1 / fps,
			drawInto: (canvas) => {
				if (closed) throw new Error(`frame ${index} drawn after close`);
				if (canvas.destroyed) {
					log.drawsIntoDestroyed += 1;
					return;
				}
				canvas.frame = index;
				canvas.draws += 1;
				log.drawn.push(index);
			},
			close: () => {
				if (closed) {
					log.doubleClosed += 1;
					return;
				}
				closed = true;
				log.closed += 1;
			},
		};
	}

	function wake() {
		const pending = waiters;
		waiters = [];
		for (const resolve of pending) resolve();
	}

	function openIterator({
		startTime,
	}: {
		startTime: number;
	}): FrameIterator<FakeCanvas> {
		log.opened.push(startTime);
		const first = frameIndexAt(startTime);
		const keyframe = first - (first % keyframeInterval);
		// frames from the key frame up to the first one shown are decoded too
		log.decoded += first - keyframe;
		let nextIndex = first;
		let terminated = false;

		return {
			next: async () => {
				// Bounded: a test that never releases a frame leaves this waiting, not spinning.
				for (let wakeups = 0; wakeups < 10_000 && budget <= 0 && !terminated; wakeups++) {
					await new Promise<void>((resolve) => {
						waiters.push(resolve);
					});
				}
				if (budget <= 0 && !terminated) {
					throw new Error("fake decoder starved");
				}
				if (terminated || nextIndex >= frameCount) {
					return { done: true, value: undefined };
				}
				if (!failed && log.delivered === failAtDelivery) {
					failed = true;
					throw new Error("fake decoder error");
				}
				budget -= 1;
				log.decoded += 1;
				log.delivered += 1;
				const frame = makeFrame(nextIndex);
				nextIndex += 1;
				return { done: false, value: frame };
			},
			return: async () => {
				terminated = true;
				log.returned += 1;
				wake();
				return { done: true, value: undefined };
			},
		};
	}

	const source: FrameSource<FakeCanvas> = {
		...(frameBytes && { frameBytes }),
		displaySize,
		openIterator,
		keyframeAtOrBefore: async ({ time }) => {
			log.keyframeLookups += 1;
			const index = frameIndexAt(time);
			return (index - (index % keyframeInterval)) / fps;
		},
		createCanvas: ({ scale }) => {
			log.canvases += 1;
			log.canvasScales.push(scale);
			return { id: log.canvases, frame: null, draws: 0, scale, destroyed: false };
		},
		destroyCanvas: ({ canvas }) => {
			if (canvas.destroyed) {
				log.doubleDestroyed += 1;
				return;
			}
			canvas.destroyed = true;
			canvas.frame = null;
			log.destroyed += 1;
		},
		dispose: () => {
			log.disposed = true;
			log.disposals += 1;
		},
	};

	return {
		source,
		log,
		fps,
		/** Lets `count` more frames come out of the decoder (manual decoding). */
		release: (count: number) => {
			budget += count;
			wake();
		},
		/** Time in the middle of frame `index`. */
		timeOf: (index: number) => (index + 0.5) / fps,
		/** Frames handed out and not closed yet (excluding none: every frame must be closed). */
		openFrames: () => log.delivered - log.closed,
	};
}

/** Lets every queued promise reaction run (a macrotask runs after all of them). */
export function settle(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * `source` whose decoded frames can be drawn once: a second draw of a frame
 * (the redraw of a kept frame at a larger size) throws, as a canvas that
 * cannot be had would. Tests of what happens when a redraw needs a decoder.
 */
export function drawnOnce({ source }: { source: FrameSource<FakeCanvas> }): FrameSource<FakeCanvas> {
	return {
		...source,
		openIterator: (args) => {
			const iterator = source.openIterator(args);
			return {
				...iterator,
				next: async () => {
					const result = await iterator.next();
					if (result.done) return result;
					const frame = result.value;
					let drawn = false;
					return {
						done: false,
						value: {
							...frame,
							drawInto: (canvas: FakeCanvas) => {
								if (drawn) throw new Error("this frame cannot be drawn again");
								drawn = true;
								frame.drawInto(canvas);
							},
						},
					};
				},
			};
		},
	};
}
