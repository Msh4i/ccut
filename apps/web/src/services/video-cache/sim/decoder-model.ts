import { DEFAULT_FRAME_BYTES, type FrameBytes, type FrameSource } from "../frame-stream";
import type { VirtualClock } from "./virtual-clock";

/**
 * A model of mediabunny's decoding pipeline for the playback simulation. The
 * numbers are assumptions, not measurements: see `run-playback-sim.ts`.
 *
 * A decoder run starts at the key frame at or before its start time, decodes
 * one frame every `decodeMs` on its own thread (after `startupMs` for the
 * first one), drops the frames before the start, and keeps at most
 * `maxQueued` decoded frames waiting to be taken (mediabunny: 8).
 */
export type DecoderModelParams = {
	fps: number;
	frameCount: number;
	/** Frames between key frames. */
	keyframeInterval: number;
	decodeMs: number;
	startupMs: number;
	maxQueued: number;
	/**
	 * The decoder process's first use in the whole simulation takes this long and every decode
	 * waits for it (measured in the real window: the first ~10 decodes all returned after
	 * 4.3 s, later ones every 0.3 s). Default 0.
	 */
	firstUseMs?: number;
};

/**
 * Counters of a simulation, and its own model of the memory the decoders and
 * canvases hold: counted where frames and canvases are created and freed,
 * independently of what the cache believes it holds.
 */
export type DecoderStats = {
	runs: number;
	/** Frames decoded, including the ones a run drops to reach its start. */
	decoded: number;
	/** Frames drawn into canvases (CanvasSink: every frame it yields). */
	draws: number;
	/** Decoded frames waiting in the decoders' own queues (mediabunny: up to 8 each). */
	queuedFrames: number;
	/** Decoded frames handed to the cache and not closed yet. */
	openFrames: number;
	/** `close` called on a frame already closed. */
	doubleClosed: number;
	/** Decoder runs started and not stopped, and the most at once. */
	liveRuns: number;
	peakLiveRuns: number;
	/** Canvases created and not destroyed, and their memory (drawn bytes x scale^2). */
	liveCanvases: number;
	liveCanvasBytes: number;
	canvasesCreated: number;
	/** Frames drawn into a canvas already destroyed (it shows nothing). */
	drawsIntoDestroyed: number;
	/** Decoded frames (queued + open) and live canvases, now and at most. */
	heldBytes: number;
	peakHeldBytes: number;
	/** Memory of one frame: decoded (4:2:0) and drawn (RGBA, at scale 1). */
	frameBytes: FrameBytes;
	/** When the decoder process is ready (null: not used yet), see `firstUseMs`. */
	processReadyAt: number | null;
};

/**
 * A canvas stand-in that knows which frame it holds (-1: none) and the scale
 * it was created at. A destroyed canvas (its backing freed) holds nothing.
 */
export type SimCanvas = { id: number; frame: number; scale: number; destroyed: boolean };

export function createDecoderStats({
	frameBytes = DEFAULT_FRAME_BYTES,
}: {
	frameBytes?: FrameBytes;
} = {}): DecoderStats {
	return {
		runs: 0,
		decoded: 0,
		draws: 0,
		queuedFrames: 0,
		openFrames: 0,
		doubleClosed: 0,
		liveRuns: 0,
		peakLiveRuns: 0,
		liveCanvases: 0,
		liveCanvasBytes: 0,
		canvasesCreated: 0,
		drawsIntoDestroyed: 0,
		heldBytes: 0,
		peakHeldBytes: 0,
		frameBytes,
		processReadyAt: null,
	};
}

/** Recomputes the bytes held after any change (so the peak is exact, not sampled). */
function noteHeld(stats: DecoderStats): void {
	stats.heldBytes =
		(stats.queuedFrames + stats.openFrames) * stats.frameBytes.decoded + stats.liveCanvasBytes;
	stats.peakHeldBytes = Math.max(stats.peakHeldBytes, stats.heldBytes);
}

/** Frees a canvas's backing: it holds nothing from now on. Once; later calls do nothing. */
export function destroySimCanvas({
	canvas,
	stats,
}: {
	canvas: SimCanvas;
	stats: DecoderStats;
}): void {
	if (canvas.destroyed) return;
	canvas.destroyed = true;
	canvas.frame = -1;
	stats.liveCanvases -= 1;
	stats.liveCanvasBytes -= stats.frameBytes.drawn * canvas.scale * canvas.scale;
	noteHeld(stats);
}

/**
 * Decode engines shared by every decoder run of a simulation: a run's next
 * frame starts on the engine that frees up first. One lane models a single
 * hardware video engine (decoders take turns); no lanes object means every
 * run decodes on its own thread (the model's default).
 */
export type DecodeLanes = { busyUntil: number[] };

export function createDecodeLanes({ count }: { count: number }): DecodeLanes {
	return { busyUntil: Array.from({ length: Math.max(1, count) }, () => 0) };
}

class DecoderRun {
	private readonly clock: VirtualClock;
	private readonly params: DecoderModelParams;
	private readonly stats: DecoderStats;
	private readonly lanes: DecodeLanes | null;
	private readonly firstIndex: number;
	private decodeIndex: number;
	private queue: number[] = [];
	private waiters: Array<(index: number | null) => void> = [];
	private decoding = false;
	private started = false;
	private terminated = false;

	constructor({
		clock,
		params,
		stats,
		startTime,
		lanes,
	}: {
		clock: VirtualClock;
		params: DecoderModelParams;
		stats: DecoderStats;
		startTime: number;
		lanes: DecodeLanes | null;
	}) {
		this.clock = clock;
		this.params = params;
		this.stats = stats;
		this.lanes = lanes;
		stats.runs += 1;
		stats.liveRuns += 1;
		stats.peakLiveRuns = Math.max(stats.peakLiveRuns, stats.liveRuns);
		this.firstIndex = Math.min(
			params.frameCount - 1,
			Math.max(0, Math.floor(startTime * params.fps + 1e-9)),
		);
		this.decodeIndex =
			this.firstIndex - (this.firstIndex % params.keyframeInterval);
		this.pump();
	}

	nextIndex(): Promise<number | null> {
		const queued = this.queue.shift();
		if (queued !== undefined) {
			this.stats.queuedFrames -= 1;
			noteHeld(this.stats);
			this.pump();
			return Promise.resolve(queued);
		}
		if (this.terminated || this.isDrained()) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	stop(): void {
		if (!this.terminated) {
			this.stats.liveRuns -= 1;
			this.stats.queuedFrames -= this.queue.length;
			noteHeld(this.stats);
		}
		this.terminated = true;
		this.queue = [];
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve(null);
	}

	private isDrained(): boolean {
		return this.decodeIndex >= this.params.frameCount && !this.decoding;
	}

	private pump(): void {
		if (
			this.decoding ||
			this.terminated ||
			this.decodeIndex >= this.params.frameCount ||
			this.queue.length >= this.params.maxQueued
		) {
			return;
		}
		this.decoding = true;
		let readyAt = this.clock.now + (this.started ? 0 : this.params.startupMs);
		this.started = true;
		if (this.params.firstUseMs) {
			this.stats.processReadyAt ??= this.clock.now + this.params.firstUseMs;
			readyAt = Math.max(readyAt, this.stats.processReadyAt);
		}
		this.clock.at({ time: this.reserveDecode({ readyAt }), run: () => this.finishDecode() });
	}

	/** When the frame that may start at `readyAt` is decoded (waits for a free lane). */
	private reserveDecode({ readyAt }: { readyAt: number }): number {
		const lanes = this.lanes;
		if (!lanes) return readyAt + this.params.decodeMs;
		let lane = 0;
		for (let index = 1; index < lanes.busyUntil.length; index++) {
			if (lanes.busyUntil[index] < lanes.busyUntil[lane]) lane = index;
		}
		const finish = Math.max(readyAt, lanes.busyUntil[lane]) + this.params.decodeMs;
		lanes.busyUntil[lane] = finish;
		return finish;
	}

	private finishDecode(): void {
		this.decoding = false;
		if (this.terminated) return;
		const index = this.decodeIndex;
		this.decodeIndex += 1;
		this.stats.decoded += 1;
		if (index >= this.firstIndex) {
			const waiter = this.waiters.shift();
			if (waiter) waiter(index);
			else {
				this.queue.push(index);
				this.stats.queuedFrames += 1;
				noteHeld(this.stats);
			}
		}
		this.pump();
		if (this.isDrained() && this.queue.length === 0) {
			const waiters = this.waiters;
			this.waiters = [];
			for (const resolve of waiters) resolve(null);
		}
	}
}

/** The frame cache's source (new cache). */
export function createModelSource({
	clock,
	params,
	stats,
	lanes = null,
}: {
	clock: VirtualClock;
	params: DecoderModelParams;
	stats: DecoderStats;
	lanes?: DecodeLanes | null;
}): FrameSource<SimCanvas> {
	let canvases = 0;
	return {
		displaySize: { width: 1920, height: 1080 },
		openIterator: ({ startTime }) => {
			const run = new DecoderRun({ clock, params, stats, startTime, lanes });
			return {
				next: async () => {
					const index = await run.nextIndex();
					if (index === null) return { done: true, value: undefined };
					stats.openFrames += 1;
					noteHeld(stats);
					let closed = false;
					return {
						done: false,
						value: {
							timestamp: index / params.fps,
							duration: 1 / params.fps,
							drawInto: (canvas: SimCanvas) => {
								stats.draws += 1;
								if (canvas.destroyed) stats.drawsIntoDestroyed += 1;
								else canvas.frame = index;
							},
							close: () => {
								if (closed) {
									stats.doubleClosed += 1;
									return;
								}
								closed = true;
								stats.openFrames -= 1;
								noteHeld(stats);
							},
						},
					};
				},
				return: async () => {
					run.stop();
					return { done: true, value: undefined };
				},
			};
		},
		keyframeAtOrBefore: async ({ time }) => {
			const index = Math.floor(time * params.fps + 1e-9);
			return (index - (index % params.keyframeInterval)) / params.fps;
		},
		createCanvas: ({ scale }) => {
			canvases += 1;
			stats.canvasesCreated += 1;
			stats.liveCanvases += 1;
			stats.liveCanvasBytes += stats.frameBytes.drawn * scale * scale;
			noteHeld(stats);
			return { id: canvases, frame: -1, scale, destroyed: false };
		},
		destroyCanvas: ({ canvas }) => destroySimCanvas({ canvas, stats }),
		dispose: () => {},
	};
}

export type LegacyFrame = { canvas: SimCanvas; timestamp: number; duration: number };

export type LegacyIterator = {
	next: () => Promise<IteratorResult<LegacyFrame, void>>;
	return: () => Promise<unknown>;
};

/** mediabunny's CanvasSink (poolSize 3) over the same decoder model (old cache). */
export function createModelCanvasSink({
	clock,
	params,
	stats,
}: {
	clock: VirtualClock;
	params: DecoderModelParams;
	stats: DecoderStats;
}): { canvases: (startTime: number) => LegacyIterator } {
	const pool: SimCanvas[] = [1, 2, 3].map((id) => ({ id, frame: -1, scale: 1, destroyed: false }));
	let nextCanvas = 0;
	return {
		canvases: (startTime) => {
			const run = new DecoderRun({ clock, params, stats, startTime, lanes: null });
			return {
				next: async () => {
					const index = await run.nextIndex();
					if (index === null) return { done: true, value: undefined };
					// CanvasSink draws every frame it yields into the next pool canvas.
					const canvas = pool[nextCanvas];
					nextCanvas = (nextCanvas + 1) % pool.length;
					canvas.frame = index;
					stats.draws += 1;
					return {
						done: false,
						value: { canvas, timestamp: index / params.fps, duration: 1 / params.fps },
					};
				},
				return: async () => {
					run.stop();
					return { done: true, value: undefined };
				},
			};
		},
	};
}
