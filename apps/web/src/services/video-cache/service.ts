import { createBrowserMemorySource } from "./browser-memory";
import { createAppDecodeWorkers } from "./decode-worker/app";
import { type DecodeWorkerStats, type DecodeWorkers, WORKER_RENDER_AHEAD } from "./decode-worker/decode-workers";
import type { DrawClock } from "./canvas-recycler";
import { DrawnFrameCache, MIN_KEPT_FRAME_BYTES } from "./drawn-frame-cache";
import {
	DECODER_QUEUE_FRAMES,
	DEFAULT_DECODER_LIMITS,
	type DecoderLimits,
	READ_AHEAD_MIN_FRAMES,
} from "./frame-policy";
import { needsLargerDraw, normalizeScale } from "./frame-scale";
import {
	DEFAULT_FRAME_BYTES,
	type FrameCacheCounters,
	type FrameSource,
	FrameStream,
	type PresentedFrame,
	type ReadAheadPolicy,
	createFrameCacheCounters,
} from "./frame-stream";
import {
	BUDGET_FLOOR_BYTES,
	type BudgetReason,
	type BudgetState,
	type PerformanceMode,
	type ValidReading,
	initialBudget,
	isDecodeStalled,
	nextBudget,
	validateReading,
} from "./memory-budget";
import { openMediabunnySource } from "./mediabunny-source";
import { ScaledCanvasPools } from "./scaled-canvases";
import {
	type SlotView,
	chooseStreamToRelease,
	ownStreamFirst,
	planStreamPick,
	streamCapForBudget,
	streamQuota,
} from "./stream-plan";

export type VideoCacheFrame<TCanvas = OffscreenCanvas> = PresentedFrame<TCanvas>;

/**
 * A render's hold on the frames it got (`beginRender`): their canvases are
 * not drawn over, reused or destroyed until the render ends its lease (after
 * the compositor uploaded them) or RENDER_LEASE_TIMEOUT_MS passed.
 */
export type RenderLease = { readonly id: number };

/**
 * A lease never ended (a render that hangs) stops holding its frames after
 * this long, so it cannot pin memory for good (OWNER DECISION). A render that
 * uploads later than this finds a canvas the cache may have destroyed: the
 * compositor skips a canvas whose size changed (`wasm-compositor.ts`).
 */
export const RENDER_LEASE_TIMEOUT_MS = 10_000;

/** What `withRenderLease` needs of the cache. */
export type RenderLeases = {
	beginRender: () => RenderLease;
	endRender: ({ lease }: { lease: RenderLease }) => void;
};

/** Runs one render under a lease of `cache`, ended however the render settles. */
export async function withRenderLease<T>({
	cache,
	run,
}: {
	cache: RenderLeases;
	run: (lease: RenderLease) => Promise<T>;
}): Promise<T> {
	const lease = cache.beginRender();
	try {
		return await run(lease);
	} finally {
		cache.endRender({ lease });
	}
}

/**
 * How many decoders (streams) the cache keeps. A stream is one decoder run
 * plus its read-ahead and the frame it shows; two clips of one file shown at
 * different times need one each, or they would take turns on one decoder.
 */
export type StreamLimits = {
	/** Streams of one media (clips of one file visible at the same time). */
	maxPerMedia: number;
	/**
	 * Streams over every media. Soft bound: a stream with a request in flight
	 * (a layer of the draw being resolved) is never evicted, so a draw with
	 * more video layers than this still gets every frame.
	 */
	maxTotal: number;
	/**
	 * A clip may take over the stream of another clip that was not asked for
	 * during this much activity time (its clip has left the screen).
	 */
	reuseIdleAfterMs: number;
	/** A stream not asked for during this much activity time is disposed. */
	releaseIdleAfterMs: number;
};

/**
 * 8 per media and 12 in total (was 4 / 8; proposed by the P4 review, the owner
 * confirms it after a real-window check). More clips of one
 * file than its streams borrow, which costs a decoder start per draw (fps
 * falls to 2-7 simulated from one clip over), so the cap per media is high and
 * memory is bounded by `streamCapForBudget` instead (6 at 256 MB, 1-2 at the
 * floor, at most this). Not verified: how many hardware decoder sessions the
 * owner's iGPU allows, and the CPU cost of 8 software decoders.
 */
export const DEFAULT_STREAM_LIMITS: StreamLimits = {
	maxPerMedia: 8,
	maxTotal: 12,
	reuseIdleAfterMs: 500,
	releaseIdleAfterMs: 5000,
};

/**
 * Where the memory budget's inputs come from (`browser-memory.ts` in the
 * app). Without one the cache keeps the small fixed budget of a web build.
 */
export type MemorySource = {
	/** The desktop bridge's reading; anything invalid, a throw or a rejection is no reading. */
	readMemory: () => Promise<unknown>;
	mode: () => PerformanceMode;
	/** `navigator.deviceMemory` (GiB), an upper hint without readings. */
	deviceMemoryGiB: () => number | null;
	/** Starts calling `tick` every few seconds; returns the stop function. */
	schedule?: (tick: () => void) => () => void;
};

/**
 * A request a newer one of its stream overtook before it ran is answered by
 * the frame on the canvas, without decoding (scrubbing). Not a full-size exact
 * one (a paused frame, a snapshot, a thumbnail) when that frame was drawn
 * smaller: it would stay on screen, or in the image, at preview resolution.
 * Scrub requests are exact too (tolerance 0) but at the preview's scale: they
 * keep the shortcut, so a scrub over a growing layer decodes nothing extra.
 */
function finalPictureNeedsLarger({
	shown,
	scale,
	maxStaleSeconds,
}: {
	shown: { scale: number };
	scale: number;
	maxStaleSeconds: number;
}): boolean {
	return scale === 1 && needsLargerDraw({ drawnScale: shown.scale, scale, maxStaleSeconds });
}

const NO_MEMORY_SOURCE: MemorySource = {
	readMemory: async () => null,
	mode: () => "balanced",
	deviceMemoryGiB: () => null,
};

/**
 * Sizes one media's frames are drawn at, at most: the raster scale buckets
 * from 1/16 to 1 in steps of the square root of 2 (`rasterScaleBucket`). The
 * canvas pools keep room for as many sizes as the media has clips on screen,
 * never more than this.
 */
const MAX_SCALES_PER_MEDIA = 9;

/**
 * Renders a canvas handed out waits before it is drawn into again (in draws
 * of its media: this x the draws one render makes, one per stream or clip on
 * screen). OWNER DECISION: 1 since render leases hold every canvas a render
 * got until it uploaded them (renders beside each other included); the draw
 * count only protects a render made without a lease. Was 3 (CANVAS_POOL_SIZE)
 * before leases.
 */
const QUARANTINE_RENDERS = 1;

/** Share of the budget every stream's read-ahead may take together. */
const READ_AHEAD_BUDGET_SHARE = 0.25;

/**
 * The activity clock moves on with every request, by the time since the
 * previous one but at most this much: a pause (no requests) does not age the
 * streams, so pressing Play again finds them all.
 */
const MAX_ACTIVITY_STEP_MS = 100;
/**
 * While an export runs (`holdBudgetAtMost` with `forwardOnly`) it only moves forward and asks every
 * visible clip once per frame: a stream or a media not asked for this long (activity time, three
 * frames at the step cap) belongs to a clip that has passed and is released at once, instead of
 * after `releaseIdleAfterMs`.
 */
export const FORWARD_ONLY_RELEASE_AFTER_MS = 3 * MAX_ACTIVITY_STEP_MS;

export type VideoCacheMemoryStats = {
	mode: PerformanceMode;
	budgetBytes: number;
	/**
	 * Drawn canvases (kept, shown, free), decoded frames waiting in the
	 * read-ahead, and the decoders' own queues (DECODER_QUEUE_FRAMES each).
	 */
	usedBytes: number;
	lruBytes: number;
	lruFrames: number;
	lruHits: number;
	readAheadBytes: number;
	/** The running decoders' own queues (mediabunny's), as counted. */
	decoderQueueBytes: number;
	/** Decoded frames streams keep for their small shown frames (redrawn larger when paused). */
	keptDecodedBytes: number;
	/** Decode workers: their own overhead and the pictures they draw (0 without workers). */
	workerBytes: number;
	readAheadSeconds: number;
	streams: number;
	/** Decoder starts since the app started. */
	restarts: number;
	/** Requests queued on another clip's stream, and frames redrawn larger without a decoder, since the app started. */
	borrows: number;
	redraws: number;
	reason: BudgetReason;
	/** From the last valid reading; null without one. */
	availableBytes: number | null;
	appBytes: number | null;
};

type LatestRequest<TCanvas> = {
	/** The clip it is for (null: a request without a key). */
	key: string | null;
	time: number;
	maxStaleSeconds: number;
	/**
	 * The scale it draws at. A request that has not started yet is raised to
	 * the larger scale of a later request for the same time (one draw serves
	 * both); one that started is shared only with equal or smaller scales.
	 */
	size: { scale: number; started: boolean };
	promise: Promise<VideoCacheFrame<TCanvas> | null>;
	/** Its answer once it settled: a reuse hands that canvas out again. */
	settled?: VideoCacheFrame<TCanvas> | null;
};

type StreamSlot<TCanvas> = {
	stream: FrameStream<TCanvas>;
	/** Requests of one stream run one after another, borrowed ones included. */
	chain: Promise<unknown>;
	/**
	 * The newest request of each clip on this stream: a request of the same
	 * clip and time shares its answer; a newer one of the same clip overtakes
	 * it. A clip never shares or overtakes another clip's request.
	 */
	latest: Map<string | null, LatestRequest<TCanvas>>;
	/**
	 * The clip the stream belongs to (null: opened by a request without a
	 * key). A borrower never becomes the owner while the owner is on screen.
	 */
	owner: string | null;
	/** Activity time of the owner's newest request (a borrower does not move it). */
	ownerAskedAt: number;
	/** Media time of the owner's newest request. */
	ownerPosition: number;
	/**
	 * The clip whose request the frame on the canvas answered last, and that
	 * frame (undefined: none yet). An overtaken request may answer with the
	 * frame on the canvas only when it is its own clip's and still the one shown:
	 * a frame change that did not resolve (a failed redraw) leaves it stale.
	 */
	presentedBy: { key: string | null; frame: PresentedFrame<TCanvas> } | undefined;
	/** Media time of its newest request of any clip: where its decoder will be once its queue ran. */
	position: number;
	/** Activity time of its newest request. */
	lastUsed: number;
	/** Requests queued and not finished: a busy stream is never taken over or evicted. */
	pending: number;
	/** Whether the stream decodes on a decode worker now (false once it fell back to the main thread). */
	onWorker: () => boolean;
	/**
	 * Fixed when the stream is opened: a request only goes to a stream of its own
	 * kind, also after a worker stream fell back (its shown frame is still a
	 * worker's picture, which export, snapshot and thumbnail must never get).
	 */
	kind: "worker" | "main";
	/**
	 * Opened ahead of time for a clip that has not started (`prefetchClips`) and not asked by that clip
	 * yet. Such a stream is disposed when the playhead no longer heads for the clip.
	 */
	prefetched: boolean;
};

type MediaEntry<TCanvas> = {
	mediaId: string;
	/** The file, for a decode worker to open on its own. */
	file: File;
	/** One opened file shared by every stream of the media (each stream runs its own decoder). */
	source: FrameSource<TCanvas>;
	slots: StreamSlot<TCanvas>[];
	/** The media's canvases: shown by its streams, kept by the drawn-frame cache, or free. One pool per size. */
	canvases: ScaledCanvasPools<TCanvas>;
	drawnFrameBytes: number;
	decodedFrameBytes: number;
	/** Scale of the newest request (the size the media's frames are drawn at). */
	requestedScale: number;
	/** Activity time each clip (stream key; null: requests without a key) last asked a frame of the media. */
	askedAt: Map<string | null, number>;
	/** Activity time of the media's newest request, or of its opening (a forward-only export releases an untouched media). */
	touchedAt: number;
	/** Clips with a key asked within reuseIdleAfterMs of activity (on screen), as of the last request. */
	visibleClips: number;
	/** A request without a key was made within that time (it may stand for any number of layers). */
	unkeyedVisible: boolean;
};

/**
 * Decoded video frames for the renderer (`frame-stream.ts` has the decode and
 * read-ahead rules of one stream).
 *
 * Every request carries the clip it is for (`streamKey`, the timeline element
 * id; the blur backdrop of a clip uses its clip's id). A clip keeps its own
 * stream, so two clips of one file at different times (picture-in-picture, an
 * A/B cut of one recording) each read ahead on their own decoder. Which stream
 * a request goes to is `planStreamPick` (`stream-plan.ts`): a clip new to the
 * cache takes over an idle stream its time continues (a split clip plays on
 * across the cut), or one whose clip left the screen, else opens one while the
 * media is below its quota (`streamQuota`: a stream per clip on screen, at
 * most 4 per media and 8 in all, at least one per media on screen), else
 * BORROWS a stream: its request queues behind the owner's and the owner stays.
 * A clip is never answered with another clip's frame; with more clips than
 * streams it costs decoder starts instead. Requests without a key go to the
 * idle stream nearest at or before their time within the decoder's forward
 * window. Streams are released when unused for a few seconds of activity, and
 * idle ones of a media over its quota while there are more than 8.
 *
 * Frames a stream stops showing are kept in a drawn-frame cache (least
 * recently used out) within the memory budget (`memory-budget.ts`, ticked
 * every few seconds with the machine's memory reading): a request for a frame
 * drawn a moment ago (scrubbing back, a replay, an A/B cut to a range another
 * clip of the file just played) is answered from there without any decoder.
 *
 * Requests for one stream are served in order. Two requests of one clip for the
 * same time in a row (the blur backdrop and the video of one clip, resolved in
 * parallel by `resolve.ts`) share one answer: the same frame, drawn once. A
 * queued request that a newer one of the same clip overtook before it ran
 * returns the frame on the canvas without decoding (scrubbing), when that
 * frame is its own clip's.
 */
export class VideoCache<TCanvas = OffscreenCanvas> {
	private entries = new Map<string, MediaEntry<TCanvas>>();
	private initPromises = new Map<string, Promise<MediaEntry<TCanvas> | null>>();
	/** Bumped by clearVideo: a file that finishes opening afterwards is dropped. */
	private clearEpochs = new Map<string, number>();
	private readonly openSource: ({
		file,
		onCanvasLost,
	}: {
		file: File;
		onCanvasLost: () => void;
	}) => Promise<FrameSource<TCanvas>>;
	private readonly now: () => number;
	private readonly limits: DecoderLimits;
	private readonly streamLimits: StreamLimits;
	private readonly budgetHolds = new Set<{ capBytes: number; forwardOnly: boolean }>();
	private readonly counters: FrameCacheCounters = createFrameCacheCounters();
	private tolerance = 0;
	private activityMs = 0;
	/** Open render leases: when each began and the canvases it got. */
	private readonly leases = new Map<number, { startedAt: number; canvases: TCanvas[] }>();
	/** Canvases held by open leases, and by how many. */
	private readonly holds = new Map<TCanvas, number>();
	/** Canvas pools of cleared media with canvases a render still held; flushed as renders end. */
	/** Requests of each media between the call and the answer (see `releasePassedMedia`). */
	private readonly asking = new Map<string, number>();
	private readonly retiredPools = new Set<ScaledCanvasPools<TCanvas>>();
	private nextLeaseId = 1;
	private lastRequestAt: number | null = null;
	private canvasLossQueued = false;

	private readonly memory: MemorySource;
	/** Decode workers (lever a); none: every stream decodes on the main thread. */
	private readonly workers: DecodeWorkers<TCanvas> | undefined;
	private budget: BudgetState;
	private lastReading: ValidReading | null = null;
	private readonly lru: DrawnFrameCache<TCanvas>;
	private stopTicks: (() => void) | null = null;
	private ticking = false;
	/** Counters at the last tick (decode stalls are counted per tick). */
	private countersAtTick: FrameCacheCounters = createFrameCacheCounters();

	constructor({
		openSource,
		now = () => performance.now(),
		limits = DEFAULT_DECODER_LIMITS,
		streams,
		memory = NO_MEMORY_SOURCE,
		workers,
	}: {
		/** Opens a file; `onCanvasLost` is for a canvas of it that lost its pixels (GPU context loss). */
		openSource: ({
			file,
			onCanvasLost,
		}: {
			file: File;
			onCanvasLost: () => void;
		}) => Promise<FrameSource<TCanvas>>;
		now?: () => number;
		limits?: DecoderLimits;
		streams?: Partial<StreamLimits>;
		memory?: MemorySource;
		/**
		 * Decode workers for the streams of the preview (`allowWorker` requests).
		 * Without them, or with them switched off, a stream is exactly the main
		 * thread's.
		 */
		workers?: DecodeWorkers<TCanvas>;
	}) {
		this.openSource = openSource;
		this.now = now;
		this.limits = limits;
		this.streamLimits = { ...DEFAULT_STREAM_LIMITS, ...streams };
		this.memory = memory;
		this.workers = workers;
		this.budget = initialBudget({
			mode: memory.mode(),
			deviceMemoryGiB: memory.deviceMemoryGiB(),
		});
		this.lru = new DrawnFrameCache<TCanvas>({ budgetBytes: this.budget.budgetBytes });
	}

	/**
	 * Runs `run` with a playback tolerance: frame requests made SYNCHRONOUSLY
	 * inside it (the renderer asks for every video frame before its first
	 * await) may get a decoded frame that ended up to `maxStaleSeconds` ago
	 * instead of waiting for the decoder. Everything else stays exact: requests
	 * made later, paused seeks, exports, snapshots.
	 */
	withPlaybackTolerance<T>({
		maxStaleSeconds,
		run,
	}: {
		maxStaleSeconds: number;
		run: () => T;
	}): T {
		const previous = this.tolerance;
		this.tolerance = Number.isFinite(maxStaleSeconds)
			? Math.max(0, maxStaleSeconds)
			: 0;
		try {
			return run();
		} finally {
			this.tolerance = previous;
		}
	}

	getPlaybackTolerance(): number {
		return this.tolerance;
	}

	/**
	 * A render starts: frames asked with the lease are held until `endRender`
	 * (the renderer calls it once the compositor uploaded them, or the render
	 * failed). Renders run alongside each other (a snapshot or a thumbnail at
	 * full size beside the playing preview): what one holds, the others' draws
	 * cannot recycle.
	 */
	beginRender(): RenderLease {
		this.expireLeases();
		const id = this.nextLeaseId;
		this.nextLeaseId += 1;
		this.leases.set(id, { startedAt: this.now(), canvases: [] });
		return { id };
	}

	/** The render uploaded its frames (or failed): their canvases may be recycled again. Once is enough. */
	endRender({ lease }: { lease: RenderLease }): void {
		const open = this.leases.get(lease.id);
		if (!open) return;
		this.leases.delete(lease.id);
		for (const canvas of open.canvases) {
			const count = (this.holds.get(canvas) ?? 0) - 1;
			if (count > 0) this.holds.set(canvas, count);
			else this.holds.delete(canvas);
		}
		for (const pools of this.retiredPools) {
			if (pools.flushDeferred()) this.retiredPools.delete(pools);
		}
	}

	/** Display size of an opened media; null until its first frame request has opened it. */
	peekDisplaySize({ mediaId }: { mediaId: string }): { width: number; height: number } | null {
		return this.entries.get(mediaId)?.source.displaySize ?? null;
	}

	async getFrameAt(request: Parameters<VideoCache<TCanvas>["requestFrameAt"]>[0]): Promise<VideoCacheFrame<TCanvas> | null> {
		// Counted before the first await: a media with a request on its way is never released as passed.
		this.asking.set(request.mediaId, (this.asking.get(request.mediaId) ?? 0) + 1);
		try {
			return await this.requestFrameAt(request);
		} finally {
			const left = (this.asking.get(request.mediaId) ?? 1) - 1;
			if (left > 0) this.asking.set(request.mediaId, left);
			else this.asking.delete(request.mediaId);
		}
	}

	private async requestFrameAt({
		mediaId,
		file,
		time,
		streamKey,
		scale = 1,
		lease,
		allowWorker = false,
	}: {
		mediaId: string;
		file: File;
		time: number;
		/** The clip the frame is for (timeline element id); the same for a clip's backdrop and video. */
		streamKey?: string;
		/**
		 * The size the frame is needed at, as a share of the video's display size
		 * (the preview while it plays; export, snapshot and a paused preview ask
		 * for 1, the default). The answer is drawn at this scale or larger.
		 */
		scale?: number;
		/** The render the frame is for: its canvas is held until the render ends the lease. */
		lease?: RenderLease;
		/**
		 * The preview asks (playing, scrubbing or paused): its stream may decode on
		 * a worker. Export, snapshot and thumbnail never pass it: they use the
		 * main thread's streams and never a frame a worker made.
		 */
		allowWorker?: boolean;
	}): Promise<VideoCacheFrame<TCanvas> | null> {
		// Captured before the first await: see withPlaybackTolerance.
		const maxStaleSeconds = this.tolerance;
		this.expireLeases();
		const wantedScale = normalizeScale(scale);
		this.startTicks();
		const media = await this.ensureEntry({ mediaId, file });
		// Cleared while it was opening or while this request waited.
		if (!media || this.entries.get(mediaId) !== media) return null;

		this.advanceActivity();
		const key = streamKey ?? null;
		const useWorker = allowWorker && this.workers?.enabled() === true;
		media.requestedScale = wantedScale;
		this.noteAsked({ media, key });
		const own =
			key === null
				? undefined
				: media.slots.find((slot) => slot.owner === key && (slot.kind === "worker") === useWorker);
		// The clip itself asks now: a stream opened ahead of time for it is its own from here on.
		if (own) own.prefetched = false;
		// The clip's own stream before the drawn-frame cache when it reaches the
		// time without a restart: frames another clip of the file drew would
		// leave this clip's decoder behind (and restart it later).
		const viaOwn =
			own !== undefined &&
			ownStreamFirst({
				time,
				scale: wantedScale,
				maxStaleSeconds,
				position: own.position,
				shown: own.stream.getPresented(),
				continueSeconds: this.limits.alwaysAdvanceSeconds,
			});
		const kept = viaOwn
			? null
			: this.lru.find({
					mediaId,
					time,
					scale: wantedScale,
					// A request that may not use a worker never takes a picture a worker made.
					...(this.workers && !allowWorker && { accept: (frame) => frame.viaWorker !== true }),
				});
		if (kept) {
			this.counters.lruHits += 1;
			media.canvases.noteHandOut(kept);
			if (own) this.noteOwnerAsked({ slot: own, time });
			this.releaseIdleStreams({ keep: own ?? null });
			this.hold({ lease, frame: kept });
			return kept;
		}

		const slot = this.pickSlot({ media, time, key, useWorker });
		slot.lastUsed = this.activityMs;
		this.releaseIdleStreams({ keep: slot });
		const frame = await this.request({ media, slot, key, time, maxStaleSeconds, scale: wantedScale });
		this.hold({ lease, frame });
		return frame;
	}

	/**
	 * Pre-roll across clip boundaries. `clips` are the clips about to start (the next boundaries):
	 * each gets its own stream opened and decoded up to its first frame, so the picture is ready
	 * before the playhead reaches the clip. Never takes another clip's stream and never exceeds the
	 * stream limits or the memory budget: when there is no room the clip is skipped. Streams opened
	 * here for clips that are no longer in `clips` (playback paused, the playhead moved away) and
	 * that no clip has asked for are disposed. Pass `[]` to release everything pre-rolled.
	 */
	async prefetchClips({
		clips,
		keep = [],
		allowWorker = false,
	}: {
		clips: ReadonlyArray<{ mediaId: string; file: File; key: string; time: number }>;
		/** Clips on the playhead now: their pre-rolled stream is kept until the clip itself asks (it may be a draw away). */
		keep?: readonly string[];
		allowWorker?: boolean;
	}): Promise<void> {
		const wanted = new Set([...clips.map((clip) => clip.key), ...keep]);
		for (const { media, slot } of this.allSlots()) {
			if (slot.prefetched && slot.pending === 0 && (slot.owner === null || !wanted.has(slot.owner))) {
				this.disposeSlot({ media, slot });
			}
		}
		const useWorker = allowWorker && this.workers?.enabled() === true;
		for (const clip of clips) {
			this.expireLeases();
			const media = await this.ensureEntry({ mediaId: clip.mediaId, file: clip.file });
			if (!media || this.entries.get(clip.mediaId) !== media) continue;
			// The clip counts as on screen for the stream quota, so that the clips actually playing do not
			// borrow its stream (and it does not borrow theirs).
			this.advanceActivity();
			this.noteAsked({ media, key: clip.key });
			let slot = media.slots.find((candidate) => candidate.owner === clip.key && (candidate.kind === "worker") === useWorker);
			if (slot) {
				// Already pre-rolled (or the clip's own stream): nothing to start.
				if (slot.position === clip.time || !slot.prefetched) continue;
			} else {
				const room =
					media.slots.length < this.streamLimits.maxPerMedia &&
					media.slots.length < this.streamCap(media) &&
					this.slotCount() < this.streamLimits.maxTotal;
				if (!room) { continue; }
				slot = this.openSlot({ media, owner: clip.key, useWorker });
				slot.prefetched = true;
			}
			this.noteOwnerAsked({ slot, time: clip.time });
			// Same size as the last real request: a larger one is accepted later, a smaller one is drawn again.
			const scale = media.requestedScale;
			void this.request({ media, slot, key: clip.key, time: clip.time, maxStaleSeconds: 0, scale }).catch(() => {});
		}
	}

	/** `frame` is part of the render of `lease` (still open): its canvas is held until the lease ends. */
	private hold({
		lease,
		frame,
	}: {
		lease: RenderLease | undefined;
		frame: VideoCacheFrame<TCanvas> | null;
	}): void {
		const open = lease ? this.leases.get(lease.id) : undefined;
		if (!open || !frame) return;
		open.canvases.push(frame.canvas);
		this.holds.set(frame.canvas, (this.holds.get(frame.canvas) ?? 0) + 1);
	}

	/** Ends the leases older than RENDER_LEASE_TIMEOUT_MS (renders that never ended them). */
	private expireLeases(): void {
		if (this.leases.size === 0) return;
		const now = this.now();
		for (const [id, open] of this.leases) {
			if (now - open.startedAt > RENDER_LEASE_TIMEOUT_MS) this.endRender({ lease: { id } });
		}
	}

	/** Totals since the app started (a copy). */
	getCounters(): FrameCacheCounters {
		return { ...this.counters };
	}

	/** The decode workers' numbers for the playback HUD; null when the cache has no workers. */
	getWorkerStats(): DecodeWorkerStats | null {
		return this.workers?.stats() ?? null;
	}

	/**
	 * One tick of the memory budget: reads the machine's memory, recomputes the
	 * budget and evicts down to it at once. The app ticks every few seconds
	 * (`MemorySource.schedule`); never rejects.
	 */
	async tickMemory(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			let value: unknown = null;
			try {
				value = await this.memory.readMemory();
			} catch {
				value = null;
			}
			const reading = validateReading(value);
			if (reading) this.lastReading = reading;
			const counters = this.counters;
			const stalled = isDecodeStalled({
				stalePresents: counters.stalePresents - this.countersAtTick.stalePresents,
				requests: counters.requests - this.countersAtTick.requests,
			});
			this.countersAtTick = { ...counters };
			this.applyBudget({
				state: nextBudget({
					state: this.budget,
					reading,
					ownBytes: this.usedBytes(),
					mode: this.memory.mode(),
					stalled,
					allocationFailed: false,
					deviceMemoryGiB: this.memory.deviceMemoryGiB(),
				}),
			});
		} finally {
			this.ticking = false;
		}
	}

	getMemoryStats(): VideoCacheMemoryStats {
		const lru = this.lru.getStats();
		return {
			mode: this.memory.mode(),
			budgetBytes: this.budget.budgetBytes,
			usedBytes: this.usedBytes(),
			lruBytes: lru.bytes,
			lruFrames: lru.frames,
			lruHits: this.counters.lruHits,
			readAheadBytes: this.readAheadBytes(),
			decoderQueueBytes: this.decoderQueueBytes(),
			keptDecodedBytes: this.keptDecodedBytes(),
			workerBytes: this.workerBytes(),
			readAheadSeconds: this.budget.readAheadSeconds,
			streams: this.slotCount(),
			restarts: this.counters.restarts,
			borrows: this.counters.borrows,
			redraws: this.counters.redraws,
			reason: this.budget.reason,
			availableBytes: this.lastReading?.availableBytes ?? null,
			appBytes: this.lastReading?.appBytes ?? null,
		};
	}

	/**
	 * Every drawn frame lost its pixels (the GPU process lost the canvases'
	 * contents): kept frames are forgotten, and each stream draws its frame
	 * again before it is handed out (a decoder start per stream). Requests in
	 * flight finish; their answers may be blank for one render.
	 */
	dropDrawnFrames(): void {
		this.lru.clear();
		// An answer shared from now on must be a frame drawn again: with no
		// frame shown, no settled answer is shareable (`isShareable`).
		for (const { slot } of this.allSlots()) slot.stream.invalidatePresented();
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		this.clearEpochs.set(mediaId, (this.clearEpochs.get(mediaId) ?? 0) + 1);
		const entry = this.entries.get(mediaId);
		if (entry) {
			// Streams first: the frame each one shows goes to the cache, which
			// then hands every canvas of the media back to be dropped.
			for (const slot of entry.slots) {
				slot.stream.dispose();
			}
			entry.slots = [];
			this.lru.removeMedia({ mediaId });
			entry.canvases.clear();
			// Canvases still in their quarantine would wait for a draw that never comes: destroy them now,
			// or once the renders holding some have ended (`endRender`).
			if (!entry.canvases.flushDeferred()) this.retiredPools.add(entry.canvases);
			entry.source.dispose();
			this.entries.delete(mediaId);
		}
		this.initPromises.delete(mediaId);
	}

	/**
	 * Holds the cache of kept (drawn) frames at what `capBytes` leaves after the streams, until the
	 * returned function is called (the export: it reads each frame once, so kept frames only compete
	 * with the encoder for memory). The kept frames go at once. Only the frame cache is held: the
	 * streams, their decoders and the stream cap follow the real budget, so an export with several
	 * clips of one file keeps a decoder for each. Holds stack: the smallest cap wins.
	 * `forwardOnly` (the export again: it never goes back): a stream or media that no clip on
	 * screen asks for any more is released after `FORWARD_ONLY_RELEASE_AFTER_MS` of activity, so
	 * what the cache holds follows the clips on screen, not the clips already played.
	 */
	holdBudgetAtMost({ capBytes, forwardOnly = false }: { capBytes: number; forwardOnly?: boolean }): () => void {
		const hold = { capBytes: Math.max(BUDGET_FLOOR_BYTES, capBytes), forwardOnly };
		this.budgetHolds.add(hold);
		try {
			this.lru.setBudget({ budgetBytes: this.lruBudget() });
		} catch (error) {
			// The caller never gets the release function: do not leave the hold behind.
			this.budgetHolds.delete(hold);
			throw error;
		}
		return () => {
			this.budgetHolds.delete(hold);
			this.lru.setBudget({ budgetBytes: this.lruBudget() });
		};
	}

	clearAll(): void {
		const mediaIds = new Set([...this.entries.keys(), ...this.initPromises.keys()]);
		for (const mediaId of mediaIds) {
			this.clearVideo({ mediaId });
		}
		this.lru.clear();
		this.stopTicks?.();
		this.stopTicks = null;
	}

	getStats(): { media: number; streams: number; decoders: number } {
		const slots = this.allSlots().map(({ slot }) => slot);
		return {
			media: this.entries.size,
			streams: slots.length,
			decoders: slots.filter((slot) => slot.stream.hasDecoder()).length,
		};
	}

	private startTicks(): void {
		if (this.stopTicks || !this.memory.schedule) return;
		this.stopTicks = this.memory.schedule(() => {
			void this.tickMemory();
		});
	}

	private applyBudget({ state }: { state: BudgetState }): void {
		this.budget = state;
		if (state.reason === "pressure" || state.reason === "allocation-failure") {
			// Idle streams give back their read-ahead beyond the minimum and their
			// decoders (with mediabunny's queue); the next request restarts one.
			for (const { slot } of this.allSlots()) {
				if (slot.pending === 0) slot.stream.trimReadAhead({ keepFrames: READ_AHEAD_MIN_FRAMES });
			}
		}
		// Idle streams over what the budget allows per media go now.
		this.releaseIdleStreams({ keep: null });
		this.lru.setBudget({ budgetBytes: this.lruBudget() });
	}

	/** A frame could not be drawn (a canvas or its memory could not be had): shrink at once. */
	private onAllocationFailure(): void {
		this.applyBudget({
			state: nextBudget({
				state: this.budget,
				reading: this.lastReading,
				ownBytes: this.usedBytes(),
				mode: this.memory.mode(),
				stalled: false,
				allocationFailed: true,
				deviceMemoryGiB: this.memory.deviceMemoryGiB(),
			}),
		});
	}

	private readAheadBytes(): number {
		let bytes = 0;
		for (const media of this.entries.values()) {
			for (const slot of media.slots) bytes += slot.stream.readAheadBytes();
		}
		return bytes;
	}

	private keptDecodedBytes(): number {
		let bytes = 0;
		for (const media of this.entries.values()) {
			for (const slot of media.slots) bytes += slot.stream.keptDecodedBytes();
		}
		return bytes;
	}

	private decoderQueueBytes(): number {
		let bytes = 0;
		for (const media of this.entries.values()) {
			for (const slot of media.slots) bytes += slot.stream.decoderQueueBytes();
		}
		return bytes;
	}

	/**
	 * What decode workers hold besides decoded frames: each live worker's own
	 * overhead, and per stream on a worker with a decoder its drawing canvas and
	 * a picture in flight (WORKER_RENDER_AHEAD, at the size the media is drawn at).
	 * Pictures already on the main thread are in the canvases' `liveBytes`.
	 */
	private workerBytes(): number {
		if (!this.workers) return 0;
		let bytes = this.workers.overheadBytes();
		for (const media of this.entries.values()) {
			for (const slot of media.slots) {
				if (!slot.onWorker() || !slot.stream.hasDecoder()) continue;
				bytes += WORKER_RENDER_AHEAD * media.drawnFrameBytes * media.requestedScale ** 2;
			}
		}
		return bytes;
	}

	/**
	 * Canvases of every media (kept, shown or free, pictures from workers
	 * included), decoded frames waiting, decoder queues, decode workers.
	 */
	private usedBytes(): number {
		let bytes =
			this.readAheadBytes() +
			this.decoderQueueBytes() +
			this.keptDecodedBytes() +
			this.workerBytes();
		for (const media of this.entries.values()) {
			bytes += media.canvases.liveBytes({ fullBytes: media.drawnFrameBytes });
		}
		return bytes;
	}

	/**
	 * What the drawn-frame cache may hold: the budget minus everything else at
	 * its most. Outside the cache a media has at most one shown canvas per
	 * stream (counted at full size), a decoder queue per stream (a stream
	 * without a decoder starts one at its next request) and full free lists
	 * (evicted canvases land there first), each at the size of its canvases.
	 */
	private lruBudget(): number {
		let reserved = this.readAheadBytes();
		for (const media of this.entries.values()) {
			reserved += media.slots.length * media.drawnFrameBytes;
			// Its decoder's queue and the decoded frame kept for a small shown frame.
			reserved += media.slots.length * (DECODER_QUEUE_FRAMES + 1) * media.decodedFrameBytes;
			reserved += media.canvases.reservedFreeBytes({ fullBytes: media.drawnFrameBytes });
			// A stream on a worker: its drawing canvas and picture in flight, at most at full size.
			for (const slot of media.slots) {
				if (slot.onWorker()) reserved += WORKER_RENDER_AHEAD * media.drawnFrameBytes;
			}
		}
		// Each live worker's own overhead.
		reserved += this.workers?.overheadBytes() ?? 0;
		// An export holds the kept frames down (`holdBudgetAtMost`); the streams above are not held.
		let cap = this.budget.budgetBytes;
		for (const hold of this.budgetHolds) cap = Math.min(cap, hold.capBytes);
		return Math.max(0, cap - reserved);
	}

	private readAheadPolicy(): ReadAheadPolicy {
		return {
			// Under pressure a pause costs a decoder start rather than a kept frame per stream.
			keepDecoded: !this.isPressed(),
			seconds: this.budget.readAheadSeconds,
			maxBytes:
				(READ_AHEAD_BUDGET_SHARE * this.budget.budgetBytes) /
				Math.max(1, this.slotCount()),
		};
	}

	/** A frame a stream of `media` stopped showing: kept in memory when the budget allows. */
	private retireFrame({
		media,
		frame,
	}: {
		media: MediaEntry<TCanvas>;
		frame: PresentedFrame<TCanvas>;
	}): void {
		// clearVideo empties the cache of the media right after its streams
		// retired their frames, so an offer during a clear is harmless.
		this.lru.setBudget({ budgetBytes: this.lruBudget() });
		const kept = this.lru.offer({
			mediaId: media.mediaId,
			frame,
			// RGBA: the memory of a canvas follows its area; small ones are
			// charged a minimum, which bounds how many canvases are kept.
			bytes: Math.max(MIN_KEPT_FRAME_BYTES, media.drawnFrameBytes * frame.scale * frame.scale),
			release: () => media.canvases.release(frame),
		});
		if (!kept) media.canvases.release(frame);
	}

	/**
	 * Whether a request's answer may still be shared: not settled yet, or its
	 * frame is still the one on the stream's canvas (another clip's request on
	 * the stream may have retired it since, and its canvas be drawn over).
	 */
	private isShareable({
		slot,
		latest,
	}: {
		slot: StreamSlot<TCanvas>;
		latest: LatestRequest<TCanvas>;
	}): boolean {
		return latest.settled === undefined || latest.settled === slot.stream.getPresented();
	}

	private request({
		media,
		slot,
		key,
		time,
		maxStaleSeconds,
		scale,
	}: {
		media: MediaEntry<TCanvas>;
		slot: StreamSlot<TCanvas>;
		key: string | null;
		time: number;
		maxStaleSeconds: number;
		scale: number;
	}): Promise<VideoCacheFrame<TCanvas> | null> {
		// A settled answer whose frame left the canvas can never be shared again:
		// drop it (and its promise) whichever clip it belongs to.
		for (const [asker, entry] of slot.latest) {
			if (!this.isShareable({ slot, latest: entry })) slot.latest.delete(asker);
		}
		const latest = slot.latest.get(key);
		if (
			latest &&
			slot.latest.get(key) === latest &&
			latest.time === time &&
			latest.maxStaleSeconds <= maxStaleSeconds &&
			// Only from an equal or larger scale, unless it has not started: then
			// it is raised, so the two requests (a clip and its blur backdrop)
			// share one draw whichever asked first. Overtaking it with a new
			// request instead would hand it the frame of the previous time.
			(latest.size.scale >= scale || !latest.size.started)
		) {
			latest.size.scale = Math.max(latest.size.scale, scale);
			// A reused answer is a new hand-out of its canvas, and the stream stays
			// busy until it settles: otherwise another clip could take the stream
			// over and its canvas be redrawn while this layer still shows it.
			if (latest.settled) media.canvases.noteHandOut(latest.settled);
			slot.pending += 1;
			void latest.promise
				.finally(() => {
					slot.pending -= 1;
				})
				.catch(() => {});
			return latest.promise;
		}

		slot.position = time;
		slot.pending += 1;
		const size = { scale, started: false };
		const promise = slot.chain.then(() => {
			size.started = true;
			const shown = slot.stream.getPresented();
			// Overtaken by a newer request of its own clip: the frame on the
			// canvas (nothing when there is none), without decoding; but never
			// another clip's frame, and not a smaller one when a full-size exact
			// answer would stay on screen.
			const overtaken = slot.latest.get(key)?.size !== size;
			if (overtaken && shown === null) return null;
			if (
				overtaken &&
				shown !== null &&
				slot.presentedBy?.key === key &&
				slot.presentedBy.frame === shown &&
				!finalPictureNeedsLarger({ shown, scale: size.scale, maxStaleSeconds })
			) {
				media.canvases.noteHandOut(shown);
				return shown;
			}
			return slot.stream
				.frameAt({ time, maxStaleSeconds, scale: size.scale })
				.then((frame) => {
					if (frame) slot.presentedBy = { key, frame };
					return frame;
				});
		});
		const isNewest = () => slot.latest.get(key)?.size === size;
		slot.chain = promise
			.then(
				(frame) => {
					const entry = slot.latest.get(key);
					if (entry && isNewest()) entry.settled = frame;
					// No frame, or one smaller than asked (a decoder error, a failed
					// redraw at full size): the next request for this time tries again.
					const short = !frame || frame.scale < size.scale;
					if (short && isNewest()) slot.latest.delete(key);
				},
				() => {
					// Rejected (a frame that could not be drawn): the same, and
					// less memory from now on.
					if (isNewest()) slot.latest.delete(key);
					this.onAllocationFailure();
				},
			)
			.finally(() => {
				slot.pending -= 1;
			});
		slot.latest.set(key, { key, time, maxStaleSeconds, size, promise });
		return promise;
	}

	private advanceActivity(): void {
		const now = this.now();
		if (this.lastRequestAt !== null && Number.isFinite(now)) {
			const step = now - this.lastRequestAt;
			if (step > 0) this.activityMs += Math.min(step, MAX_ACTIVITY_STEP_MS);
		}
		this.lastRequestAt = now;
	}

	/** A clip asked a frame of `media`: it is on screen for reuseIdleAfterMs of activity. */
	private noteAsked({ media, key }: { media: MediaEntry<TCanvas>; key: string | null }): void {
		media.askedAt.set(key, this.activityMs);
		media.touchedAt = this.activityMs;
		this.refreshVisible(media);
	}

	/** Counts the clips of `media` on screen now (and forgets the ones gone for a while). */
	private refreshVisible(media: MediaEntry<TCanvas>): void {
		let visible = 0;
		let unkeyed = false;
		for (const [asker, at] of media.askedAt) {
			const since = this.activityMs - at;
			if (since > this.streamLimits.releaseIdleAfterMs) {
				media.askedAt.delete(asker);
			} else if (since < this.streamLimits.reuseIdleAfterMs) {
				if (asker === null) unkeyed = true;
				else visible += 1;
			}
		}
		media.visibleClips = visible;
		media.unkeyedVisible = unkeyed;
	}

	private noteOwnerAsked({ slot, time }: { slot: StreamSlot<TCanvas>; time: number }): void {
		slot.ownerAskedAt = this.activityMs;
		slot.ownerPosition = time;
		slot.lastUsed = this.activityMs;
	}

	/**
	 * Streams each media may have now (`streamQuota`), from its clips on
	 * screen. Requests without a key may stand for any number of layers: a
	 * media they asked for may have maxPerMedia streams.
	 */
	private quotas(): Map<string, number> {
		const clipsByMedia = new Map<string, number>();
		for (const media of this.entries.values()) {
			this.refreshVisible(media);
			clipsByMedia.set(
				media.mediaId,
				media.unkeyedVisible ? this.streamLimits.maxPerMedia : media.visibleClips,
			);
		}
		const quotas = streamQuota({ clipsByMedia, limits: this.streamLimits });
		for (const media of this.entries.values()) {
			const quota = quotas.get(media.mediaId) ?? 0;
			quotas.set(media.mediaId, Math.min(quota, this.streamCap(media)));
		}
		return quotas;
	}

	/**
	 * Streams `media` may have within the memory budget (`streamCapForBudget`),
	 * counting what it holds now: frames at the scale it draws, no kept decoded
	 * frame under pressure, its free canvases for a render's draws.
	 */
	private streamCap(media: MediaEntry<TCanvas>): number {
		let visibleMedia = 0;
		for (const entry of this.entries.values()) {
			if (entry.visibleClips > 0 || entry.unkeyedVisible) visibleMedia += 1;
		}
		let shownScale = media.requestedScale;
		for (const slot of media.slots) {
			shownScale = Math.max(shownScale, slot.stream.getPresented()?.scale ?? 0);
		}
		return streamCapForBudget({
			budgetBytes: this.budget.budgetBytes,
			decodedFrameBytes: media.decodedFrameBytes,
			drawnFrameBytes: media.drawnFrameBytes,
			visibleMedia,
			maxPerMedia: this.streamLimits.maxPerMedia,
			shownScale,
			keepsDecoded: !this.isPressed(),
			mediaCanvases: QUARANTINE_RENDERS * this.drawsPerRender(media) + 1,
		});
	}

	/** Memory pressure or a failed allocation set the budget: no kept frames, minimum read-ahead. */
	private isPressed(): boolean {
		return this.budget.reason === "pressure" || this.budget.reason === "allocation-failure";
	}

	/** What `planStreamPick` sees of a stream. */
	private viewOf(slot: StreamSlot<TCanvas>): SlotView {
		const shown = slot.stream.getPresented();
		const latest = new Map<string | null, number>();
		for (const [key, request] of slot.latest) {
			if (this.isShareable({ slot, latest: request })) latest.set(key, request.time);
		}
		return {
			owner: slot.owner,
			ownerAskedAt: slot.ownerAskedAt,
			position: slot.position,
			ownerPosition: slot.ownerPosition,
			shownTimestamp: shown ? shown.timestamp : null,
			pending: slot.pending,
			latest,
		};
	}

	/** The stream a request goes to (opened, taken over or borrowed when needed). */
	private pickSlot({
		media,
		time,
		key,
		useWorker,
	}: {
		media: MediaEntry<TCanvas>;
		time: number;
		key: string | null;
		/** The request may use a decode worker: only streams of its kind are candidates. */
		useWorker: boolean;
	}): StreamSlot<TCanvas> {
		// Streams on a worker and main-thread streams are separate: a request
		// that may not use a worker (export, snapshot) never goes to one.
		const candidates = media.slots.filter((slot) => (slot.kind === "worker") === useWorker);
		const decision = planStreamPick({
			key,
			time,
			slots: candidates.map((slot) => this.viewOf(slot)),
			quota: this.quotas().get(media.mediaId) ?? 1,
			limits: {
				continueSeconds: this.limits.alwaysAdvanceSeconds,
				maxAdvanceSeconds: this.limits.maxAdvanceSeconds,
				reuseIdleAfterMs: this.streamLimits.reuseIdleAfterMs,
			},
			activityMs: this.activityMs,
		});
		const slot =
			decision.kind === "open"
				? this.openSlot({ media, owner: key, useWorker })
				: candidates[decision.index];
		if (decision.kind === "take") slot.owner = key;
		if (slot.owner === key) this.noteOwnerAsked({ slot, time });
		else if (decision.kind === "borrow") this.counters.borrows += 1;
		return slot;
	}

	private openSlot({
		media,
		owner,
		useWorker,
	}: {
		media: MediaEntry<TCanvas>;
		owner: string | null;
		useWorker: boolean;
	}): StreamSlot<TCanvas> {
		// Over maxTotal now? releaseIdleStreams evicts right after the pick.
		const source = media.source;
		// A decode worker for this stream (null: none could be had, or the lever is off).
		const workerSource = useWorker
			? (this.workers?.createStreamSource({ main: source, file: media.file }) ?? null)
			: null;
		const slot: StreamSlot<TCanvas> = {
			stream: new FrameStream({
				source: workerSource ?? {
					...(source.frameBytes && { frameBytes: source.frameBytes }),
					openIterator: (args) => source.openIterator(args),
					keyframeAtOrBefore: (args) => source.keyframeAtOrBefore(args),
					displaySize: source.displaySize,
					createCanvas: (args) => source.createCanvas(args),
					// The media entry disposes the file once, after its last stream.
					dispose: () => {},
				},
				counters: this.counters,
				now: this.now,
				limits: this.limits,
				canvases: media.canvases,
				retire: (frame) => this.retireFrame({ media, frame }),
				readAhead: () => this.readAheadPolicy(),
			}),
			chain: Promise.resolve(),
			latest: new Map(),
			owner,
			ownerAskedAt: this.activityMs,
			ownerPosition: Number.NaN,
			presentedBy: undefined,
			position: Number.NaN,
			lastUsed: this.activityMs,
			pending: 0,
			onWorker: workerSource ? () => !workerSource.hasFallenBack() : () => false,
			kind: workerSource ? "worker" : "main",
			prefetched: false,
		};
		media.slots.push(slot);
		return slot;
	}

	/**
	 * Disposes streams unused for releaseIdleAfterMs of activity, then, while
	 * there are more than maxTotal, the least recently used idle stream of a
	 * media with more streams than its quota (`chooseStreamToRelease`; a media
	 * on screen keeps one, so the total is soft).
	 */
	private releaseIdleStreams({ keep }: { keep: StreamSlot<TCanvas> | null }): void {
		const forwardOnly = this.isForwardOnly();
		const idleAfterMs = forwardOnly
			? Math.min(this.streamLimits.releaseIdleAfterMs, FORWARD_ONLY_RELEASE_AFTER_MS)
			: this.streamLimits.releaseIdleAfterMs;
		for (const { media, slot } of this.allSlots()) {
			if (slot !== keep && slot.pending === 0 && this.activityMs - slot.lastUsed > idleAfterMs) {
				this.disposeSlot({ media, slot });
			}
		}
		if (forwardOnly) this.releasePassedMedia();
		// Idle streams over what the budget allows per media, least recently used first.
		for (const media of this.entries.values()) {
			const cap = this.streamCap(media);
			for (let excess = media.slots.length - cap; excess > 0; excess--) {
				let victim: StreamSlot<TCanvas> | null = null;
				for (const slot of media.slots) {
					if (slot === keep || slot.pending > 0) continue;
					if (!victim || slot.lastUsed < victim.lastUsed) victim = slot;
				}
				if (!victim) break;
				this.disposeSlot({ media, slot: victim });
			}
		}
		const excess = this.slotCount() - this.streamLimits.maxTotal;
		if (excess <= 0) return;
		const quotaByMedia = this.quotas();
		for (let round = 0; round < excess; round++) {
			const all = this.allSlots();
			const index = chooseStreamToRelease({
				streams: all.map(({ media, slot }) => ({
					mediaId: media.mediaId,
					// The stream just picked counts as busy.
					pending: slot === keep ? slot.pending + 1 : slot.pending,
					lastUsed: slot.lastUsed,
				})),
				quotaByMedia,
				maxTotal: this.streamLimits.maxTotal,
			});
			if (index === null) return;
			this.disposeSlot(all[index]);
		}
	}

	private isForwardOnly(): boolean {
		for (const hold of this.budgetHolds) if (hold.forwardOnly) return true;
		return false;
	}

	/**
	 * A forward-only export: a media with no stream left that no clip has asked for lately is
	 * closed (its file, its canvas pools, its kept frames). A media still opening is left alone,
	 * and one just opened counts as touched (`touchedAt`), so a request still on its way to it
	 * never finds it gone.
	 */
	private releasePassedMedia(): void {
		for (const media of [...this.entries.values()]) {
			if (
				media.slots.length === 0 &&
				!this.asking.has(media.mediaId) &&
				this.activityMs - media.touchedAt > FORWARD_ONLY_RELEASE_AFTER_MS
			) {
				this.clearVideo({ mediaId: media.mediaId });
			}
		}
	}

	/**
	 * Gives back what can be given back at once without stopping anything (the export's relief
	 * when the renderer's memory runs high): kept frames, the read-ahead and decoder of every idle
	 * stream. The next request restarts what it needs.
	 */
	releaseHeldMemory(): void {
		this.lru.clear();
		for (const { slot } of this.allSlots()) {
			if (slot.pending === 0) slot.stream.trimReadAhead({ keepFrames: 0 });
		}
	}

	/** New frames one render may draw for `media`: one per stream or per clip on screen, the larger. */
	private drawsPerRender(media: MediaEntry<TCanvas>): number {
		return Math.max(1, media.slots.length, media.visibleClips);
	}

	/** Streams over every media, without building a list (asked on every read-ahead step). */
	private slotCount(): number {
		let count = 0;
		for (const media of this.entries.values()) count += media.slots.length;
		return count;
	}

	/**
	 * A canvas lost its pixels. A GPU reset reports every canvas at once: they
	 * share one drop of the drawn frames when they are reported in the same synchronous run.
	 */
	private onCanvasLost(): void {
		if (this.canvasLossQueued) return;
		this.canvasLossQueued = true;
		queueMicrotask(() => {
			this.canvasLossQueued = false;
			this.dropDrawnFrames();
		});
	}

	private allSlots(): Array<{ media: MediaEntry<TCanvas>; slot: StreamSlot<TCanvas> }> {
		return [...this.entries.values()].flatMap((media) =>
			media.slots.map((slot) => ({ media, slot })),
		);
	}

	private disposeSlot({
		media,
		slot,
	}: {
		media: MediaEntry<TCanvas>;
		slot: StreamSlot<TCanvas>;
	}): void {
		const index = media.slots.indexOf(slot);
		if (index >= 0) media.slots.splice(index, 1);
		slot.stream.dispose();
	}

	private async ensureEntry({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<MediaEntry<TCanvas> | null> {
		const existing = this.entries.get(mediaId);
		if (existing) return existing;

		const pending = this.initPromises.get(mediaId);
		if (pending) return pending;

		const epoch = this.clearEpochs.get(mediaId) ?? 0;
		const init = this.openSource({ file, onCanvasLost: () => this.onCanvasLost() }).then((source) => {
			if ((this.clearEpochs.get(mediaId) ?? 0) !== epoch) {
				// Cleared while opening: nothing may keep the file open.
				source.dispose();
				return null;
			}
			// With decode workers the media's pictures from them share the pools' draw clock.
			const clock: DrawClock | undefined = this.workers ? { draws: 0 } : undefined;
			const entry: MediaEntry<TCanvas> = {
				mediaId,
				file,
				source,
				slots: [],
				canvases: new ScaledCanvasPools<TCanvas>({
					create: (args) => source.createCanvas(args),
					// A canvas no pool needs any more is freed at once (after its quarantine).
					destroy: (canvas) => source.destroyCanvas?.({ canvas }),
					// A canvas a render still holds is not recycled or destroyed.
					isHeld: (canvas) => this.holds.has(canvas),
					// A render draws up to one frame per clip of the media on screen
					// (borrowed requests included): a canvas waits that many draws, so
					// a render without a lease cannot draw over what it handed out.
					quarantine: () => QUARANTINE_RENDERS * this.drawsPerRender(entry),
					maxFree: () => QUARANTINE_RENDERS * this.drawsPerRender(entry) + 1,
					// Each clip may draw at its own size (clips of the file shown at
					// different sizes). A size no clip draws any more leaves once it
					// is not drawn for a while (scaled-canvases.ts).
					maxActiveScales: () =>
						Math.min(MAX_SCALES_PER_MEDIA, Math.max(entry.slots.length, entry.visibleClips)),
					...(this.workers &&
						clock && {
							clock,
							images: this.workers.createImagePool({
								quarantine: () => QUARANTINE_RENDERS * this.drawsPerRender(entry),
								clock,
								isHeld: (image) => this.holds.has(image),
							}),
						}),
				}),
				drawnFrameBytes: source.frameBytes?.drawn ?? DEFAULT_FRAME_BYTES.drawn,
				decodedFrameBytes: source.frameBytes?.decoded ?? DEFAULT_FRAME_BYTES.decoded,
				requestedScale: 1,
				askedAt: new Map(),
				touchedAt: this.activityMs,
				visibleClips: 0,
				unkeyedVisible: false,
			};
			this.entries.set(mediaId, entry);
			return entry;
		});
		this.initPromises.set(mediaId, init);
		try {
			return await init;
		} catch (error) {
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		} finally {
			if (this.initPromises.get(mediaId) === init) {
				this.initPromises.delete(mediaId);
			}
		}
	}
}

export const videoCache = new VideoCache<OffscreenCanvas | ImageBitmap>({
	openSource: openMediabunnySource,
	memory: createBrowserMemorySource(),
	workers: createAppDecodeWorkers(),
});
