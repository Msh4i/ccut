import { CanvasRecycler, type DrawClock } from "./canvas-recycler";

/**
 * Where a stream gets its canvases when frames are drawn at more than one size
 * (`frame-scale.ts`): one `CanvasRecycler` per scale. A canvas always goes back
 * to the pool of the scale it was drawn at, so a frame's canvas never has to be
 * resized. The recycler's rule (a canvas is drawn over only after the renderer
 * let go of it) counts the draws of every size: the pools share one clock.
 */
export type ScaledCanvasLease<TCanvas> = {
	/** A canvas of the video at `scale` that may be drawn into now. */
	acquire: ({ scale }: { scale: number }) => TCanvas;
	/** The canvas of a frame drawn at `scale` was handed out to a caller. */
	noteHandOut: (frame: { canvas: TCanvas; scale: number }) => void;
	/** Its owner no longer needs the canvas of a frame drawn at `scale`. */
	release: (frame: { canvas: TCanvas; scale: number }) => void;
	/**
	 * A picture made elsewhere (a decode worker's ImageBitmap) becomes a frame's
	 * canvas: from now on the lease counts it, holds it for the renders that got
	 * it and closes it once released. Only leases that take such pictures have it.
	 */
	adopt?: (frame: { canvas: TCanvas; scale: number }) => void;
};

/**
 * Sizes that keep free canvases at the same time, at least: a playback that
 * crosses a size (zoom, resizing the panel, play to pause) uses two. Clips of
 * one media shown at different sizes (picture in picture) use one each, so
 * the cache passes `maxActiveScales` from the media's streams.
 *
 * A size stays in use while it is drawn: one not drawn for twice the
 * quarantine (in draws of the media) leaves, like the least recently drawn
 * one beyond `maxActiveScales`. A size that left keeps no free canvas past its
 * quarantine (the others follow once theirs is over), and any other canvas of
 * it is dropped when released, so a size left behind holds no memory.
 */
export const MIN_ACTIVE_SCALES = 2;

/**
 * Pictures made elsewhere (a decode worker's ImageBitmaps) that live as frames'
 * canvases next to the pooled ones (`decode-worker/image-lease.ts`). They are
 * adopted once, then follow the same hand-out and release calls; they are
 * closed, never reused.
 */
export type ImagePool<TCanvas> = {
	adopt: ({ image, scale }: { image: TCanvas; scale: number }) => void;
	/** Whether `image` is one of its pictures (so a call for a canvas goes to the right pool). */
	owns: (image: TCanvas) => boolean;
	noteHandOut: (image: TCanvas) => void;
	release: (image: TCanvas) => void;
	trim: () => void;
	clear: () => void;
	getStats: () => { live: number; free: number };
	liveBytes: ({ fullBytes }: { fullBytes: number }) => number;
};

export class ScaledCanvasPools<TCanvas> implements ScaledCanvasLease<TCanvas> {
	private readonly create: ({ scale }: { scale: number }) => TCanvas;
	private readonly destroy: (canvas: TCanvas) => void;
	private readonly isHeld: (canvas: TCanvas) => boolean;
	private readonly quarantine: () => number;
	private readonly maxFree: () => number;
	private readonly maxActiveScales: () => number;
	private readonly pools = new Map<number, CanvasRecycler<TCanvas>>();
	/** Draws at every size: a quarantine waits for draws of the media, not of one size. */
	private readonly clock: DrawClock;
	private readonly images: ImagePool<TCanvas> | undefined;
	/** Scales with free canvases kept, the most recently asked last. */
	private active: number[] = [];
	/** Clock reading of the last draw at each scale. */
	private readonly lastDrawn = new Map<number, number>();

	constructor({
		create,
		quarantine,
		maxFree,
		maxActiveScales = () => MIN_ACTIVE_SCALES,
		destroy = () => {},
		isHeld = () => false,
		clock = { draws: 0 },
		images,
	}: {
		create: ({ scale }: { scale: number }) => TCanvas;
		/** The draw clock of the pools (default: their own); `images` must count on the same one. */
		clock?: DrawClock;
		/** Pictures made elsewhere, kept with the canvases (none: the pools are as ever). */
		images?: ImagePool<TCanvas>;
		/** A render still holds the canvas: not reused, dropped or destroyed (`canvas-recycler.ts`). */
		isHeld?: (canvas: TCanvas) => boolean;
		/** Frees a canvas a pool lets go of, once its quarantine is over (`canvas-recycler.ts`). */
		destroy?: (canvas: TCanvas) => void;
		/** Draws (at any size) a free canvas waits after its last hand-out. */
		quarantine: () => number;
		/** Free canvases kept per size in use; more are dropped. */
		maxFree: () => number;
		/** Sizes that keep free canvases (never fewer than MIN_ACTIVE_SCALES). */
		maxActiveScales?: () => number;
	}) {
		this.create = create;
		this.destroy = destroy;
		this.isHeld = isHeld;
		this.quarantine = quarantine;
		this.maxFree = maxFree;
		this.maxActiveScales = maxActiveScales;
		this.clock = clock;
		this.images = images;
	}

	acquire({ scale }: { scale: number }): TCanvas {
		const canvas = this.poolFor({ scale }).acquire();
		this.lastDrawn.set(scale, this.clock.draws);
		this.touch({ scale });
		for (const pool of this.pools.values()) pool.trim();
		this.images?.trim();
		return canvas;
	}

	/** A picture made elsewhere becomes a frame's canvas (see `ImagePool`). */
	adopt({ canvas, scale }: { canvas: TCanvas; scale: number }): void {
		// A picture nobody would close is a leak: refuse it. Unreachable in the app (an image pool
		// always exists when workers do); the callers do not catch, so a throw here would leave the
		// picture to the garbage collector.
		if (!this.images) throw new Error("No image pool to adopt a picture made elsewhere");
		this.images.adopt({ image: canvas, scale });
		for (const pool of this.pools.values()) pool.trim();
	}

	/** Draws of the media after which an unused size, or an unused free canvas, goes. */
	private unusedWindow(): number {
		return 2 * Math.max(1, this.quarantine());
	}

	noteHandOut({ canvas, scale }: { canvas: TCanvas; scale: number }): void {
		if (this.images?.owns(canvas)) {
			this.images.noteHandOut(canvas);
			return;
		}
		this.pools.get(scale)?.noteHandOut(canvas);
	}

	release({ canvas, scale }: { canvas: TCanvas; scale: number }): void {
		if (this.images?.owns(canvas)) {
			this.images.release(canvas);
			return;
		}
		this.pools.get(scale)?.release(canvas);
	}

	/** Drops every free canvas (the media was cleared; its other owners released theirs first). */
	clear(): void {
		for (const pool of this.pools.values()) pool.clear();
		this.images?.clear();
	}

	/** After `clear()` of a media nobody draws for any more: destroys what waits; false while a render still holds some. */
	flushDeferred(): boolean {
		let waiting = 0;
		for (const pool of this.pools.values()) waiting += pool.flushDeferred();
		return waiting === 0;
	}

	getStats(): { live: number; free: number } {
		let live = this.images?.getStats().live ?? 0;
		let free = this.images?.getStats().free ?? 0;
		for (const pool of this.pools.values()) {
			const stats = pool.getStats();
			live += stats.live;
			free += stats.free;
		}
		return { live, free };
	}

	/** Memory of every canvas alive, given the bytes of one at scale 1 (RGBA grows with the area). */
	liveBytes({ fullBytes }: { fullBytes: number }): number {
		let bytes = this.images?.liveBytes({ fullBytes }) ?? 0;
		for (const [scale, pool] of this.pools) {
			bytes += pool.getStats().live * fullBytes * scale * scale;
		}
		return bytes;
	}

	/** Most the free lists may hold: the free canvases kept per size in use, at their size. */
	reservedFreeBytes({ fullBytes }: { fullBytes: number }): number {
		let bytes = 0;
		for (const scale of this.active) {
			bytes += this.maxFree() * fullBytes * scale * scale;
		}
		return bytes;
	}

	private poolFor({ scale }: { scale: number }): CanvasRecycler<TCanvas> {
		const existing = this.pools.get(scale);
		if (existing) return existing;
		const pool = new CanvasRecycler<TCanvas>({
			create: () => this.create({ scale }),
			quarantine: this.quarantine,
			maxFree: () => (this.active.includes(scale) ? this.maxFree() : 0),
			clock: this.clock,
			maxUnused: () => this.unusedWindow(),
			destroy: this.destroy,
			isHeld: this.isHeld,
		});
		this.pools.set(scale, pool);
		return pool;
	}

	private activeLimit(): number {
		const limit = this.maxActiveScales();
		return Number.isFinite(limit)
			? Math.max(MIN_ACTIVE_SCALES, Math.floor(limit))
			: MIN_ACTIVE_SCALES;
	}

	/** `scale` was drawn: it is the newest size in use; sizes not drawn for the window leave. */
	private touch({ scale }: { scale: number }): void {
		const since = this.clock.draws - this.unusedWindow();
		// The common case, drawing on at the newest size with every other size
		// still in use and within the limit: nothing changes, nothing to allocate.
		if (
			this.active[this.active.length - 1] === scale &&
			this.active.length <= this.activeLimit() &&
			this.active.every((other) => (this.lastDrawn.get(other) ?? Number.NEGATIVE_INFINITY) >= since)
		) {
			return;
		}
		const recent = this.active.filter(
			(other) => other !== scale && (this.lastDrawn.get(other) ?? Number.NEGATIVE_INFINITY) >= since,
		);
		this.active = [...recent, scale].slice(-this.activeLimit());
	}
}
