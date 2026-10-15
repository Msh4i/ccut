import {
	DECODER_QUEUE_FRAMES,
	DEFAULT_DECODER_LIMITS,
	READ_AHEAD_MAX_FRAMES,
	READ_AHEAD_MIN_FRAMES,
	READ_AHEAD_SECONDS,
	type DecoderLimits,
	type TimedFrame,
	chooseWithKeyframe,
	frameCovers,
	frameStaleness,
	planForwardJump,
	readAheadFrameCount,
} from "./frame-policy";
import { isWorkerFailure } from "./decode-worker/failure";
import { needsLargerDraw, normalizeScale } from "./frame-scale";
import { type ScaledCanvasLease, ScaledCanvasPools } from "./scaled-canvases";

/**
 * A decoded video frame that has not been drawn yet, which the stream draws
 * itself. It holds decoder memory until `close` is called, which must happen
 * exactly once.
 */
export type DecodedFrame<TCanvas> = {
	readonly timestamp: number;
	readonly duration: number;
	/**
	 * Draws the frame over the whole canvas. A method on purpose (bivariant): the
	 * app's cache holds canvases AND the pictures a decode worker made, while a
	 * main-thread frame is only ever given the canvases its own source created.
	 */
	drawInto(canvas: TCanvas): void;
	close: () => void;
};

/** What an asynchronous frame's `render` gives back. */
export type RenderedFrame<TCanvas> =
	/** A picture of the requested scale, made elsewhere (a decode worker's ImageBitmap): it becomes the frame's canvas. */
	| { kind: "image"; image: TCanvas }
	/** A frame the stream draws into a canvas of its own, then closes (a VideoFrame at full size). */
	| { kind: "sample"; frame: DecodedFrame<TCanvas> };

/**
 * A decoded frame that lives elsewhere (a decode worker): the picture comes
 * with `render` at the scale asked for, which may be called again for the same
 * frame while it is kept (a paused redraw at full size). `close` frees it
 * exactly once, whatever `render` calls are in flight. `render` rejects with a
 * `WorkerFailure` when the worker is gone.
 */
export type AsyncDecodedFrame<TCanvas> = {
	readonly timestamp: number;
	readonly duration: number;
	render: ({ scale }: { scale: number }) => Promise<RenderedFrame<TCanvas>>;
	close: () => void;
};

/**
 * What a stream takes from its source: frames it draws itself, or frames that
 * live in a decode worker (`AsyncDecodedFrame`). A source made of the first
 * kind only is typed with `DecodedFrame` alone.
 */
export type StreamFrame<TCanvas> = DecodedFrame<TCanvas> | AsyncDecodedFrame<TCanvas>;

export function isAsyncFrame<TCanvas>(
	frame: StreamFrame<TCanvas>,
): frame is AsyncDecodedFrame<TCanvas> {
	return "render" in frame;
}

/** Frames of one decoder run, in presentation order. */
export type FrameIterator<TCanvas, TFrame extends StreamFrame<TCanvas> = DecodedFrame<TCanvas>> = {
	next: () => Promise<IteratorResult<TFrame, unknown>>;
	/** Stops the decoder. Pending `next` calls end with `done`. */
	return: () => Promise<unknown>;
};

/** What the stream needs from a video file (mediabunny in the app, a fake in tests). */
export type FrameSource<TCanvas, TFrame extends StreamFrame<TCanvas> = DecodedFrame<TCanvas>> = {
	/**
	 * Starts a decoder that hands out the last frame at or before `startTime`
	 * first (decoding from the key frame before it), then every later frame.
	 */
	openIterator: ({ startTime }: { startTime: number }) => FrameIterator<TCanvas, TFrame>;
	/** Timestamp of the key frame a decode of `time` starts from; null when unknown. */
	keyframeAtOrBefore: ({ time }: { time: number }) => Promise<number | null>;
	/** The video's display size (square pixels, rotation applied): what a canvas at scale 1 measures. */
	displaySize: { width: number; height: number };
	/**
	 * A canvas for a frame drawn at `scale` of the display size (1: the display
	 * size itself). `drawInto` fills whatever canvas it is given.
	 */
	createCanvas: ({ scale }: { scale: number }) => TCanvas;
	/**
	 * Frees a canvas the cache no longer uses, at once instead of when the
	 * garbage collector gets to it (mediabunny: width and height 0). Called
	 * once per canvas, only after its quarantine (no render can still upload
	 * it). Optional: without it a dropped canvas waits for the collector.
	 */
	destroyCanvas?({ canvas }: { canvas: TCanvas }): void;
	dispose: () => void;
	/**
	 * Memory of one frame: `decoded` as the decoder hands it out (4:2:0, 8 bit:
	 * coded width x height x 1.5), `drawn` as a canvas (display width x
	 * height x 4, RGBA). Missing: the 1080p estimate.
	 */
	frameBytes?: FrameBytes;
};

/** A frame drawn into one of the stream's canvases. */
export type PresentedFrame<TCanvas> = {
	canvas: TCanvas;
	timestamp: number;
	duration: number;
	/**
	 * The size the canvas was drawn at, as a share of the display size (1: the
	 * display size, less: the preview while it plays or scrubs). A request is
	 * answered by a frame of at least the scale it asked for.
	 */
	scale: number;
	/** The video's display size: what the frame shows however small its canvas is. */
	displayWidth: number;
	displayHeight: number;
	/**
	 * The picture came from a decode worker (a stream of the preview). Export,
	 * snapshot and thumbnail never take such a frame from the drawn-frame cache.
	 */
	viaWorker?: true;
};

/** Running totals over every stream of a cache (read by the playback HUD). */
export type FrameCacheCounters = {
	/** Frame requests served by a stream. */
	requests: number;
	/** The frame already on a canvas was still the right one. */
	hits: number;
	/** The right frame was waiting, decoded, in the read-ahead. */
	readAheadHits: number;
	/** The frame was drawn before and still kept in memory (`drawn-frame-cache.ts`): no stream asked. */
	lruHits: number;
	/** The request waited for the running decoder to reach a later frame. */
	advances: number;
	/** A new decoder was started (from the key frame before the target). */
	restarts: number;
	/** Playback tolerance: a slightly older decoded frame was shown instead of waiting. */
	stalePresents: number;
	/** Frames drawn into canvases. */
	draws: number;
	/** Decoded frames dropped without being drawn. */
	skipped: number;
	/**
	 * Frames drawn again at a larger size from the decoded frame the stream
	 * kept (pausing after preview playback), without a decoder start.
	 */
	redraws: number;
	keyframeLookups: number;
	/** Decoder errors (the request that finds the decoder failed restarts it). */
	errors: number;
	/**
	 * Requests queued on another clip's stream (more clips of a file on screen
	 * than it may have streams): each usually costs a decoder start.
	 */
	borrows: number;
	/** Time requests spent awaiting the decoder or a key frame lookup. */
	waitMs: number;
	/** The longest such time of a single request. */
	maxWaitMs: number;
};

export function createFrameCacheCounters(): FrameCacheCounters {
	return {
		requests: 0,
		hits: 0,
		readAheadHits: 0,
		lruHits: 0,
		advances: 0,
		restarts: 0,
		stalePresents: 0,
		draws: 0,
		skipped: 0,
		redraws: 0,
		keyframeLookups: 0,
		errors: 0,
		borrows: 0,
		waitMs: 0,
		maxWaitMs: 0,
	};
}

/**
 * Canvases a stream draws into, round robin. A request presents at most one
 * frame, so a canvas is drawn over again only three requests later.
 */
export const CANVAS_POOL_SIZE = 3;

export type FrameBytes = { decoded: number; drawn: number };

/** A 1920x1080 frame: 4:2:0 decoded, RGBA drawn. */
export const DEFAULT_FRAME_BYTES: FrameBytes = {
	decoded: 1920 * 1080 * 1.5,
	drawn: 1920 * 1080 * 4,
};

/** How much a stream reads ahead (the memory budget's share of it). */
export type ReadAheadPolicy = {
	/** Seconds of video; 0 keeps READ_AHEAD_MIN_FRAMES. */
	seconds: number;
	/** Bytes of decoded frames waiting, at most (never under READ_AHEAD_MIN_FRAMES frames). */
	maxBytes: number;
	/**
	 * Keep the decoded frame of a frame shown smaller than the video, to draw
	 * it again at full size without a decoder start (default true; the cache
	 * says false under memory pressure).
	 */
	keepDecoded?: boolean;
};

const DEFAULT_READ_AHEAD: ReadAheadPolicy = {
	seconds: READ_AHEAD_SECONDS,
	maxBytes: Number.POSITIVE_INFINITY,
};

/** Upper bound of decoder deliveries one request may wait for (about 8 s at 240 fps). */
const MAX_WAIT_STEPS = 2000;

type Signal = { promise: Promise<void>; resolve: () => void };

function createSignal(): Signal {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * The frames of one video file.
 *
 * One decoder runs ahead of the playhead and keeps decoded frames for the
 * read-ahead policy's seconds (READ_AHEAD_SECONDS by default), bounded in
 * frames (READ_AHEAD_MIN_FRAMES..READ_AHEAD_MAX_FRAMES) and in bytes. A request
 * takes the frame that covers its time from there, drops the frames it skips
 * WITHOUT drawing them, and only then draws the one it returns into a canvas
 * from its lease (`canvas-recycler.ts`). The frame it showed before is retired
 * (to the drawn-frame cache, or back to the lease). A forward jump the running
 * decoder reaches cheaply never restarts it; a backward jump or a far one does
 * (`frame-policy.ts`).
 *
 * `maxStaleSeconds` > 0 (preview playback only): when the decoder has not
 * delivered the frame yet, the newest decoded frame is shown instead if it
 * ended at most that long ago, and the decoder keeps working in the
 * background. With 0 (paused seeks, export) a request always waits for the
 * exact frame.
 *
 * Requests must not overlap: the caller serialises them per stream.
 */
export class FrameStream<TCanvas> {
	private readonly source: FrameSource<TCanvas, StreamFrame<TCanvas>>;
	private readonly counters: FrameCacheCounters;
	private readonly now: () => number;
	private readonly limits: DecoderLimits;

	private iterator: FrameIterator<TCanvas, StreamFrame<TCanvas>> | null = null;
	/** Changes with every decoder start and on dispose; stale pumps check it. */
	private epoch = 0;
	private iteratorStart = 0;
	/** Decoded, not drawn, in presentation order. */
	private ready: StreamFrame<TCanvas>[] = [];
	/** Timestamp of the newest frame the running decoder delivered (or its start). */
	private frontier = 0;
	private ended = false;
	private failed = false;
	private pumping = false;
	private frameDuration = 0;
	private presented: PresentedFrame<TCanvas> | null = null;
	private presentedEpoch = -1;
	/**
	 * The decoded frame drawn into `presented`, kept while that was drawn
	 * smaller than the video: a full-size request for it (pausing after
	 * preview playback) draws it again without a decoder start. Closed by
	 * `closeRetained` only: on the next present, a decoder stop, trim, dispose.
	 */
	private retained: StreamFrame<TCanvas> | null = null;
	private readonly canvases: ScaledCanvasLease<TCanvas>;
	private readonly retire: (frame: PresentedFrame<TCanvas>) => void;
	private readonly readAhead: () => ReadAheadPolicy;
	private readonly decodedFrameBytes: number;
	private arrival: Signal = createSignal();
	private disposed = false;
	/** Frames out of the read-ahead whose picture a decode worker is still making. */
	private rendering = 0;
	/** A restart after a worker failure is running: a second failure ends it (no loop). */
	private recovering = false;
	/** Restarts after a worker failure so far (the request that was waiting is answered by the new decoder). */
	private recoveries = 0;
	/** Time the current request spent awaiting (requests do not overlap). */
	private requestWaitMs = 0;

	constructor({
		source,
		counters,
		now,
		limits = DEFAULT_DECODER_LIMITS,
		canvases,
		retire,
		readAhead = () => DEFAULT_READ_AHEAD,
	}: {
		source: FrameSource<TCanvas, StreamFrame<TCanvas>>;
		counters: FrameCacheCounters;
		now: () => number;
		limits?: DecoderLimits;
		/** Where canvases come from (default: the stream's own three per size, in turn). */
		canvases?: ScaledCanvasLease<TCanvas>;
		/** Takes the frame the stream stops showing (default: its canvas goes back to `canvases`). */
		retire?: (frame: PresentedFrame<TCanvas>) => void;
		readAhead?: () => ReadAheadPolicy;
	}) {
		this.source = source;
		this.counters = counters;
		this.now = now;
		this.limits = limits;
		const lease =
			canvases ??
			new ScaledCanvasPools<TCanvas>({
				create: (args) => source.createCanvas(args),
				destroy: (canvas) => source.destroyCanvas?.({ canvas }),
				quarantine: () => CANVAS_POOL_SIZE,
				maxFree: () => CANVAS_POOL_SIZE,
			});
		this.canvases = lease;
		this.retire = retire ?? ((frame) => lease.release(frame));
		this.readAhead = readAhead;
		this.decodedFrameBytes = source.frameBytes?.decoded ?? DEFAULT_FRAME_BYTES.decoded;
	}

	/** Memory of the decoded frames waiting in the read-ahead. */
	readAheadBytes(): number {
		return (this.ready.length + this.rendering) * this.decodedFrameBytes;
	}

	/** Memory of the decoded frame kept for the frame on the canvas (0 when none). */
	keptDecodedBytes(): number {
		return this.retained ? this.decodedFrameBytes : 0;
	}

	/** Every decoded frame the stream holds: the read-ahead and the kept one. */
	heldDecodedBytes(): number {
		return this.readAheadBytes() + this.keptDecodedBytes();
	}

	/**
	 * Memory of the decoded frames a running decoder may hold before the
	 * stream takes them (mediabunny's own queue): counted in full while a
	 * decoder runs.
	 */
	decoderQueueBytes(): number {
		return this.hasDecoder() ? DECODER_QUEUE_FRAMES * this.decodedFrameBytes : 0;
	}

	/**
	 * Gives memory back while no request runs (memory pressure): keeps the
	 * first `keepFrames` decoded frames of the read-ahead, closes the others,
	 * and stops the decoder (its own queue goes with it). The kept frames still
	 * answer; a later time starts a new decoder, so every answer stays right.
	 */
	trimReadAhead({ keepFrames }: { keepFrames: number }): void {
		if (this.disposed) return;
		this.closeRetained();
		const keep = Number.isFinite(keepFrames) ? Math.max(0, Math.floor(keepFrames)) : 0;
		for (const frame of this.ready.splice(keep)) frame.close();
		const iterator = this.iterator;
		if (!iterator) return;
		// A pump still awaiting the decoder sees the new epoch and closes what it gets.
		this.epoch += 1;
		this.pumping = false;
		this.ended = false;
		this.failed = false;
		this.iterator = null;
		iterator.return().catch(() => {});
		this.signalArrival();
	}

	/**
	 * The canvases lost their pixels (GPU context loss): forgets the frame it
	 * shows (its canvas goes back to the pool, not to the drawn-frame cache)
	 * and its decoder with the read-ahead, so the next request decodes and
	 * draws its frame again, whatever its time.
	 */
	invalidatePresented(): void {
		if (this.disposed) return;
		this.stopDecoder();
		const presented = this.presented;
		this.presented = null;
		if (presented) this.canvases.release(presented);
	}

	/** The frame drawn last (what a superseded request falls back to). */
	getPresented(): PresentedFrame<TCanvas> | null {
		return this.disposed ? null : this.presented;
	}

	hasDecoder(): boolean {
		return this.iterator !== null && !this.disposed;
	}

	/**
	 * The frame that covers `time`, drawn at `scale` of the display size or
	 * larger (default 1). For an exact request (`maxStaleSeconds` 0) a frame
	 * already shown at a smaller scale is not enough: the decoder restarts there
	 * and draws it again at `scale`. While playing, the smaller frame is shown
	 * and the next new frame is drawn at `scale` (`needsLargerDraw`).
	 */
	async frameAt({
		time,
		maxStaleSeconds,
		scale = 1,
	}: {
		time: number;
		maxStaleSeconds: number;
		scale?: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		if (this.disposed) return null;
		this.counters.requests += 1;
		this.requestWaitMs = 0;
		try {
			const frame = await this.resolveFrame({
				time,
				maxStaleSeconds,
				scale: normalizeScale(scale),
			});
			if (frame) this.canvases.noteHandOut(frame);
			return frame;
		} finally {
			this.counters.maxWaitMs = Math.max(
				this.counters.maxWaitMs,
				this.requestWaitMs,
			);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopDecoder();
		const presented = this.presented;
		this.presented = null;
		if (presented) this.retire(presented);
		this.source.dispose();
	}

	private async resolveFrame({
		time,
		maxStaleSeconds,
		scale,
	}: {
		time: number;
		maxStaleSeconds: number;
		scale: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		const presented = this.presented;
		if (presented && this.covers({ frame: presented, time })) {
			if (needsLargerDraw({ drawnScale: presented.scale, scale, maxStaleSeconds })) {
				// The right frame, drawn too small for this exact request (a paused
				// preview after playing at preview resolution). Its decoded frame is
				// gone: decode it again, from its key frame.
				return this.redrawLarger({ previous: presented, time, scale });
			}
			this.counters.hits += 1;
			this.ensurePump();
			return presented;
		}

		this.dropExpired({ time });
		const front = this.ready[0];
		if (front && this.covers({ frame: front, time })) {
			this.counters.readAheadHits += 1;
			const frame = this.presentFront({ scale, time });
			this.ensurePump();
			return frame;
		}

		const backward = presented
			? time < presented.timestamp
			: time < this.iteratorStart;
		if (!this.iterator || this.failed || backward) {
			return this.restartAt({ time, scale });
		}
		if (this.ended) {
			// Everything was delivered: the newest frame at or before `time` stays
			// (past the last frame of the video, that is the last frame).
			if (front) {
				this.counters.readAheadHits += 1;
				return this.presentFront({ scale, time });
			}
			if (
				presented &&
				needsLargerDraw({ drawnScale: presented.scale, scale, maxStaleSeconds })
			) {
				return this.redrawLarger({ previous: presented, time, scale });
			}
			this.counters.hits += 1;
			return presented;
		}

		let action = planForwardJump({
			target: time,
			frontier: this.frontier,
			limits: this.limits,
		});
		if (action === "ask-keyframe") {
			this.counters.keyframeLookups += 1;
			const keyframe = await this.timed(
				this.source.keyframeAtOrBefore({ time }).catch(() => null),
			);
			if (this.disposed) return null;
			// The decoder was stopped meanwhile (drawn frames dropped, memory
			// pressure): nothing would deliver the frame; start one at `time`.
			if (!this.iterator) return this.restartAt({ time, scale });
			action = chooseWithKeyframe({
				target: time,
				frontier: this.frontier,
				keyframe,
				limits: this.limits,
			});
		}
		if (action === "restart") {
			return this.restartAt({ time, scale });
		}

		if (maxStaleSeconds > 0) {
			const stale = this.newestAtOrBefore({ time });
			// A stale frame already on a canvas must be big enough; a decoded one
			// is drawn at the scale asked for.
			const usable =
				stale !== null &&
				(stale === this.ready[0] || (this.presented?.scale ?? 0) >= scale);
			if (stale && usable && frameStaleness({ frame: stale, time }) <= maxStaleSeconds) {
				this.counters.stalePresents += 1;
				const frame =
					stale === this.ready[0] ? this.presentFront({ scale, time }) : this.presented;
				this.ensurePump();
				return frame;
			}
		}

		this.counters.advances += 1;
		const epoch = this.epoch;
		const frame = await this.advanceTo({ time, scale });
		if (frame) return frame;
		// The decoder failed before `time`: start a new one there now, so this
		// request is answered and the next one does not find a dead decoder.
		if (this.failed && this.epoch === epoch) return this.restartAt({ time, scale });
		// The decoder ended before `time`: keep the newest frame (drawn again
		// when it is too small for this exact request).
		if (this.epoch !== epoch) return null;
		const newest = this.presented;
		if (newest && needsLargerDraw({ drawnScale: newest.scale, scale, maxStaleSeconds })) {
			return this.redrawLarger({ previous: newest, time, scale });
		}
		return newest;
	}

	/**
	 * Draws the frame at `time` again at `scale`, from a new decoder. If that
	 * fails (a decoder error, a seek that cannot start), `previous` stays the
	 * answer while it is still the frame shown (not retired, not disposed): a
	 * soft picture beats a missing layer, and a paused preview does not ask
	 * again by itself.
	 */
	private async redrawLarger({
		previous,
		time,
		scale,
	}: {
		previous: PresentedFrame<TCanvas>;
		time: number;
		scale: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		const attempt = this.redrawRetained({ previous, scale });
		// A frame kept in a decode worker is drawn again asynchronously; a
		// main-thread one right here, with no extra tick.
		const kept = attempt instanceof Promise ? await attempt : attempt;
		if (kept) return kept;
		const redrawn = await this.restartAt({ time, scale });
		return redrawn ?? (this.presented === previous ? previous : null);
	}

	/**
	 * Draws the kept decoded frame of `previous` again at `scale`, into a new
	 * canvas; the old one is retired (the drawn-frame cache may keep it). Null
	 * when there is no such frame or its draw fails (the canvas goes back):
	 * the caller restarts the decoder then. A frame kept in a decode worker is
	 * drawn again asynchronously (`redrawRendered`).
	 */
	private redrawRetained({
		previous,
		scale,
	}: {
		previous: PresentedFrame<TCanvas>;
		scale: number;
	}): PresentedFrame<TCanvas> | null | Promise<PresentedFrame<TCanvas> | null> {
		// The kept frame, when there is one, is always the decoded frame of the
		// frame shown (`previous`): set on present, closed on every other one.
		const frame = this.retained;
		// A kept frame of another timestamp is never drawn as `previous`.
		if (!frame || frame.timestamp !== previous.timestamp) return null;
		if (isAsyncFrame(frame)) return this.redrawRendered({ frame, previous, scale });
		let canvas: TCanvas;
		try {
			canvas = this.canvases.acquire({ scale });
		} catch {
			return null;
		}
		try {
			frame.drawInto(canvas);
		} catch (error) {
			this.canvases.release({ canvas, scale });
			console.warn("Failed to draw the kept frame again, decoding it again:", error);
			return null;
		}
		this.counters.redraws += 1;
		this.counters.draws += 1;
		// At full size the decoded frame is not needed any more.
		if (scale >= 1) this.closeRetained();
		this.presented = { ...previous, canvas, scale };
		this.presentedEpoch = this.epoch;
		this.retire(previous);
		return this.presented;
	}

	/** `redrawRetained` for a frame kept in a decode worker: the picture comes with an await. */
	private async redrawRendered({
		frame,
		previous,
		scale,
	}: {
		frame: AsyncDecodedFrame<TCanvas>;
		previous: PresentedFrame<TCanvas>;
		scale: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		const epoch = this.epoch;
		let rendered: RenderedFrame<TCanvas>;
		try {
			rendered = await frame.render({ scale });
		} catch (error) {
			console.warn("Failed to draw the kept frame again, decoding it again:", error);
			return null;
		}
		// Stopped, trimmed or disposed meanwhile: the kept frame is closed and the
		// frame on screen may be another one.
		if (
			this.epoch !== epoch ||
			this.disposed ||
			this.retained !== frame ||
			this.presented !== previous
		) {
			this.discardRendered({ rendered, scale });
			return null;
		}
		let canvas: TCanvas;
		if (rendered.kind === "image") {
			canvas = rendered.image;
			this.canvases.adopt?.({ canvas, scale });
		} else {
			try {
				canvas = this.canvases.acquire({ scale });
				try {
					rendered.frame.drawInto(canvas);
				} catch (error) {
					this.canvases.release({ canvas, scale });
					throw error;
				}
			} catch (error) {
				console.warn("Failed to draw the kept frame again, decoding it again:", error);
				return null;
			} finally {
				rendered.frame.close();
			}
		}
		this.counters.redraws += 1;
		this.counters.draws += 1;
		if (scale >= 1) this.closeRetained();
		this.presented = { ...previous, canvas, scale };
		this.presentedEpoch = this.epoch;
		this.retire(previous);
		return this.presented;
	}

	/** A picture nobody will show: a frame is closed, an image goes to the lease to be closed. */
	private discardRendered({
		rendered,
		scale,
	}: {
		rendered: RenderedFrame<TCanvas>;
		scale: number;
	}): void {
		if (rendered.kind === "sample") {
			rendered.frame.close();
			return;
		}
		this.canvases.adopt?.({ canvas: rendered.image, scale });
		this.canvases.release({ canvas: rendered.image, scale });
	}

	/** The only place the kept decoded frame is closed: forgotten first, so it is closed once. */
	private closeRetained(): void {
		const frame = this.retained;
		this.retained = null;
		frame?.close();
	}

	private async restartAt({
		time,
		scale,
	}: {
		time: number;
		scale: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		this.counters.restarts += 1;
		this.stopDecoder();
		try {
			this.iterator = this.source.openIterator({ startTime: time });
		} catch (error) {
			this.counters.errors += 1;
			console.warn("Failed to seek video:", error);
			return null;
		}
		this.iteratorStart = time;
		this.frontier = time;
		const epoch = this.epoch;
		const recoveries = this.recoveries;
		const frame = await this.advanceTo({ time, scale });
		// Only a frame of the new decoder answers a restart (a failed worker's
		// recovery started another decoder meanwhile: that one's frame answers).
		const current = this.recoveries === recoveries ? epoch : this.epoch;
		return frame && this.presentedEpoch === current ? frame : null;
	}

	/**
	 * Waits for the running decoder to deliver the frame that covers `time`,
	 * dropping the ones before it. Returns null when the decoder ends or fails
	 * first, or when the stream is restarted or disposed meanwhile.
	 */
	private async advanceTo({
		time,
		scale,
	}: {
		time: number;
		scale: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		const epoch = this.epoch;
		for (let step = 0; step < MAX_WAIT_STEPS; step++) {
			this.dropExpired({ time });
			const front = this.ready[0];
			// A front frame after `time` means nothing earlier exists (the start
			// of the video): it is the best there is.
			if (front && (front.timestamp > time || this.covers({ frame: front, time }))) {
				const frame = this.presentFront({ scale, time });
				// Refill what the frame just left: a small read-ahead may have stopped the pump.
				this.ensurePump();
				return frame;
			}
			if (this.ended) {
				return front ? this.presentFront({ scale, time }) : null;
			}
			this.ensurePump();
			// A failed or stopped decoder delivers nothing more, so nothing would wake us.
			if (this.failed || !this.iterator) return null;
			await this.timed(this.arrival.promise);
			if (this.epoch !== epoch || this.disposed) return null;
		}
		return null;
	}

	private stopDecoder(): void {
		this.closeRetained();
		this.epoch += 1;
		this.pumping = false;
		this.ended = false;
		this.failed = false;
		for (const frame of this.ready) {
			frame.close();
		}
		this.ready = [];
		const iterator = this.iterator;
		this.iterator = null;
		if (iterator) {
			// Not awaited: a pending `next` may be waiting for the decoder.
			iterator.return().catch(() => {});
		}
		this.signalArrival();
	}

	private ensurePump(): void {
		if (
			this.pumping ||
			this.disposed ||
			this.ended ||
			this.failed ||
			!this.iterator ||
			this.ready.length >= this.readAheadCap()
		) {
			return;
		}
		this.pumping = true;
		void this.pump({ epoch: this.epoch, iterator: this.iterator });
	}

	/** Pulls decoded frames into the read-ahead until it is full or the decoder ends. */
	private async pump({
		epoch,
		iterator,
	}: {
		epoch: number;
		iterator: FrameIterator<TCanvas, StreamFrame<TCanvas>>;
	}): Promise<void> {
		try {
			while (this.epoch === epoch && this.ready.length < this.readAheadCap()) {
				const result = await iterator.next();
				if (this.epoch !== epoch) {
					if (!result.done) result.value.close();
					return;
				}
				if (result.done) {
					this.ended = true;
					break;
				}
				this.accept({ frame: result.value });
			}
		} catch (error) {
			if (this.epoch === epoch) {
				this.failed = true;
				this.counters.errors += 1;
				console.warn("Video decoder failed, it will restart:", error);
			}
		} finally {
			if (this.epoch === epoch) {
				this.pumping = false;
				this.signalArrival();
			}
		}
	}

	private accept({ frame }: { frame: StreamFrame<TCanvas> }): void {
		this.ready.push(frame);
		this.frontier = frame.timestamp;
		if (frame.duration > 0) {
			this.frameDuration = frame.duration;
		}
		this.signalArrival();
	}

	private signalArrival(): void {
		const current = this.arrival;
		this.arrival = createSignal();
		current.resolve();
	}

	private readAheadCap(): number {
		const policy = this.readAhead();
		const frames = readAheadFrameCount({
			seconds: policy.seconds,
			frameDuration: this.frameDuration,
			min: READ_AHEAD_MIN_FRAMES,
			max: READ_AHEAD_MAX_FRAMES,
		});
		const byBytes = Math.floor(policy.maxBytes / this.decodedFrameBytes);
		return Number.isNaN(byBytes)
			? frames
			: Math.max(READ_AHEAD_MIN_FRAMES, Math.min(frames, byBytes));
	}

	/** Closes read-ahead frames that a later one replaces at `time` (never the last one). */
	private dropExpired({ time }: { time: number }): void {
		while (this.ready.length >= 2 && this.ready[1].timestamp <= time) {
			const dropped = this.ready.shift();
			dropped?.close();
			this.counters.skipped += 1;
		}
	}

	/** The newest frame at or before `time`: the read-ahead front, else the one on a canvas. */
	private newestAtOrBefore({ time }: { time: number }): TimedFrame | null {
		const front = this.ready[0];
		if (front && front.timestamp <= time) return front;
		return this.presented;
	}

	private covers({ frame, time }: { frame: TimedFrame; time: number }): boolean {
		return frameCovers({
			frame,
			time,
			nextTimestamp: this.nextTimestampAfter({ timestamp: frame.timestamp }),
		});
	}

	private nextTimestampAfter({
		timestamp,
	}: {
		timestamp: number;
	}): number | undefined {
		for (const frame of this.ready) {
			if (frame.timestamp > timestamp) return frame.timestamp;
		}
		return undefined;
	}

	private presentFront({
		scale,
		time,
	}: {
		scale: number;
		time: number;
	}):
		| PresentedFrame<TCanvas>
		| null
		| Promise<PresentedFrame<TCanvas> | null> {
		const frame = this.ready.shift();
		if (!frame) return this.presented;
		if (isAsyncFrame(frame)) return this.presentRendered({ frame, scale, time });
		let canvas: TCanvas;
		try {
			canvas = this.canvases.acquire({ scale });
			try {
				frame.drawInto(canvas);
			} catch (error) {
				// Nothing shows it: the canvas goes straight back.
				this.canvases.release({ canvas, scale });
				throw error;
			}
		} catch (error) {
			frame.close();
			throw error;
		}
		this.commitPresent({ frame, canvas, scale });
		return this.presented;
	}

	/**
	 * `presentFront` for a frame in a decode worker: the picture comes with an
	 * await. The stream may be stopped, trimmed, restarted or disposed meanwhile
	 * (the epoch says so): the picture is then closed and the request gets no
	 * frame. A worker that fails sends the stream back to the start of this
	 * request on a new decoder (the main thread's, once `FallbackStreamSource`
	 * switched); that is not a failed allocation and is never thrown.
	 */
	private async presentRendered({
		frame,
		scale,
		time,
	}: {
		frame: AsyncDecodedFrame<TCanvas>;
		scale: number;
		time: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		const epoch = this.epoch;
		this.rendering += 1;
		let rendered: RenderedFrame<TCanvas>;
		try {
			rendered = await frame.render({ scale });
		} catch (error) {
			frame.close();
			if (!isWorkerFailure(error)) throw error;
			return this.recoverFromWorkerFailure({ error, epoch, time, scale });
		} finally {
			this.rendering -= 1;
		}
		if (this.epoch !== epoch || this.disposed) {
			this.discardRendered({ rendered, scale });
			frame.close();
			return null;
		}
		let canvas: TCanvas;
		if (rendered.kind === "image") {
			canvas = rendered.image;
			this.canvases.adopt?.({ canvas, scale });
		} else {
			try {
				canvas = this.canvases.acquire({ scale });
				try {
					rendered.frame.drawInto(canvas);
				} catch (error) {
					this.canvases.release({ canvas, scale });
					throw error;
				}
			} catch (error) {
				frame.close();
				throw error;
			} finally {
				rendered.frame.close();
			}
		}
		this.commitPresent({ frame, canvas, scale });
		return this.presented;
	}

	private recoverFromWorkerFailure({
		error,
		epoch,
		time,
		scale,
	}: {
		error: unknown;
		epoch: number;
		time: number;
		scale: number;
	}): Promise<PresentedFrame<TCanvas> | null> {
		this.counters.errors += 1;
		console.warn("Decode worker failed, the stream restarts:", error);
		if (this.epoch !== epoch || this.disposed || this.recovering) return Promise.resolve(null);
		this.recovering = true;
		this.recoveries += 1;
		return this.restartAt({ time, scale }).finally(() => {
			this.recovering = false;
		});
	}

	/** `frame` was drawn into `canvas`: it is the frame shown now. */
	private commitPresent({
		frame,
		canvas,
		scale,
	}: {
		frame: StreamFrame<TCanvas>;
		canvas: TCanvas;
		scale: number;
	}): void {
		// The previous kept frame goes; this one stays only if drawn smaller.
		this.closeRetained();
		if (scale < 1 && this.readAhead().keepDecoded !== false) this.retained = frame;
		else frame.close();
		this.counters.draws += 1;
		const previous = this.presented;
		this.presented = {
			canvas,
			timestamp: frame.timestamp,
			duration: frame.duration,
			scale,
			displayWidth: this.source.displaySize.width,
			displayHeight: this.source.displaySize.height,
			...(isAsyncFrame(frame) && { viaWorker: true as const }),
		};
		this.presentedEpoch = this.epoch;
		if (previous) this.retire(previous);
	}

	private async timed<T>(promise: Promise<T>): Promise<T> {
		const started = this.now();
		try {
			return await promise;
		} finally {
			const waited = this.now() - started;
			this.counters.waitMs += waited;
			this.requestWaitMs += waited;
		}
	}
}
