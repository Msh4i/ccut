/**
 * The canvases video frames are drawn into, recycled without a canvas being
 * drawn over while a renderer may still hold it.
 *
 * A canvas belongs to one owner at a time: a stream (the frame it shows), the
 * drawn-frame cache, or this recycler's free list. A free canvas is drawn into
 * again only `quarantine()` draws after it was last handed out to a caller:
 * the renderer asks for every layer of a draw before it uploads them, so a
 * canvas it got must not be redrawn by the other requests of that draw. With
 * one stream and a quarantine of 3 this is the old round robin over three
 * canvases; the cache passes 3 x the streams of the media.
 *
 * A canvas in its quarantine is never reused nor dropped. Of the free canvases
 * past it, the one that came back last is reused first, so the ones a pool no
 * longer needs (two streams drew at its size, one left) stay unused and
 * `trim` drops them after `maxUnused` draws.
 *
 * A canvas dropped is destroyed (`destroy`, its backing freed at once), but
 * only once its quarantine is over: one still in it when the media is cleared
 * waits, and is destroyed by a later acquire or trim; a pool that is not used again
 * is emptied by `flushDeferred` (the cache calls it once the renders holding
 * canvases have ended), or else its canvases would wait for the garbage collector.
 */
export type CanvasLease<TCanvas> = {
	/** A canvas that may be drawn into now (counts one draw). */
	acquire: () => TCanvas;
	/** `canvas` was handed out to a caller (a frame answer). */
	noteHandOut: (canvas: TCanvas) => void;
	/** Its owner no longer needs `canvas`. */
	release: (canvas: TCanvas) => void;
};

/**
 * Counts draws for the quarantine. The pools of one media's sizes share one
 * (`scaled-canvases.ts`): a render asks for every layer of the media, at any
 * size, before it uploads them, so a draw at another size is a draw of that
 * render too.
 */
export type DrawClock = { draws: number };

export class CanvasRecycler<TCanvas> implements CanvasLease<TCanvas> {
	private readonly create: () => TCanvas;
	private readonly quarantine: () => number;
	private readonly maxFree: () => number;
	private readonly maxUnused: () => number;
	private readonly clock: DrawClock;
	private readonly destroy: (canvas: TCanvas) => void;
	private readonly isHeld: (canvas: TCanvas) => boolean;
	/** Clock reading when each free canvas came back. */
	private freedAt = new Map<TCanvas, number>();
	/** Dropped while still in their quarantine: destroyed once it is over. */
	private deferred: TCanvas[] = [];
	/** Canvases this pool made and has not let go of (a canvas is dropped and destroyed once). */
	private readonly owned = new Set<TCanvas>();
	private lastHandOut = new Map<TCanvas, number>();
	private free: TCanvas[] = [];
	private live = 0;

	constructor({
		create,
		quarantine,
		maxFree,
		clock = { draws: 0 },
		maxUnused = () => Number.POSITIVE_INFINITY,
		destroy = () => {},
		isHeld = () => false,
	}: {
		create: () => TCanvas;
		/** Draws a free canvas waits after its last hand-out. */
		quarantine: () => number;
		/** Free canvases kept for reuse; more are dropped. */
		maxFree: () => number;
		/** Where draws are counted (default: this recycler's own draws). */
		clock?: DrawClock;
		/** Draws a free canvas may wait unused before trim() drops it (default: forever). */
		maxUnused?: () => number;
		/** Frees a dropped canvas, once its quarantine is over (default: nothing, the collector frees it). */
		destroy?: (canvas: TCanvas) => void;
		/**
		 * A render still holds the canvas (it has not uploaded it yet): it is not
		 * reused, dropped or destroyed, whatever its quarantine says.
		 */
		isHeld?: (canvas: TCanvas) => boolean;
	}) {
		this.create = create;
		this.quarantine = quarantine;
		this.maxFree = maxFree;
		this.clock = clock;
		this.maxUnused = maxUnused;
		this.destroy = destroy;
		this.isHeld = isHeld;
	}

	acquire(): TCanvas {
		this.clock.draws += 1;
		this.destroyDeferred();
		// The newest idle canvas first: the oldest ones are the spare ones.
		for (let index = this.free.length - 1; index >= 0; index--) {
			const canvas = this.free[index];
			if (this.isIdle(canvas)) {
				this.free.splice(index, 1);
				this.freedAt.delete(canvas);
				return canvas;
			}
		}
		const canvas = this.create();
		this.owned.add(canvas);
		this.live += 1;
		return canvas;
	}

	/**
	 * Takes a canvas this pool did not make (a picture drawn elsewhere, a decode
	 * worker's ImageBitmap) as its own, counting it as one draw: it is recycled
	 * (or, with maxFree 0, dropped and destroyed) like the ones `acquire` made.
	 */
	adopt(canvas: TCanvas): void {
		this.clock.draws += 1;
		this.destroyDeferred();
		this.owned.add(canvas);
		this.live += 1;
	}

	noteHandOut(canvas: TCanvas): void {
		this.lastHandOut.set(canvas, this.clock.draws);
	}

	release(canvas: TCanvas): void {
		if (!this.owned.has(canvas) || this.free.includes(canvas)) return;
		// A canvas still in its quarantine is never dropped (the renderer may
		// still upload it): it waits in the free list, and trim() drops it later.
		if (this.free.length < this.maxFree() || !this.isIdle(canvas)) {
			this.free.push(canvas);
			this.freedAt.set(canvas, this.clock.draws);
			return;
		}
		this.drop(canvas);
	}

	/**
	 * Drops the free canvases past their quarantine that are beyond maxFree()
	 * (a size no longer in use has a maxFree of 0) or that waited unused for
	 * more than maxUnused() draws. A canvas in its quarantine stays.
	 */
	trim(): void {
		this.destroyDeferred();
		const busy = this.free.filter((canvas) => !this.isIdle(canvas)).length;
		let room = this.maxFree() - busy;
		const unusedSince = this.clock.draws - this.maxUnused();
		this.free = this.free.filter((canvas) => {
			if (!this.isIdle(canvas)) return true;
			const freedAt = this.freedAt.get(canvas) ?? Number.NEGATIVE_INFINITY;
			if (room > 0 && freedAt >= unusedSince) {
				room -= 1;
				return true;
			}
			this.drop(canvas);
			return false;
		});
	}

	/** Drops every free canvas (the media was cleared; its other owners released theirs first). */
	clear(): void {
		for (const canvas of this.free) this.drop(canvas);
		this.free = [];
	}

	/**
	 * For a pool nobody draws into any more (its media was cleared): destroys the dropped canvases
	 * still in their quarantine unless a render holds them, since no later acquire will come to
	 * do it. Returns how many wait for their render to end.
	 */
	flushDeferred(): number {
		this.deferred = this.deferred.filter((canvas) => {
			if (this.isHeld(canvas)) return true;
			this.lastHandOut.delete(canvas);
			this.live = Math.max(0, this.live - 1);
			this.destroy(canvas);
			return false;
		});
		return this.deferred.length;
	}

	private destroyDeferred(): void {
		if (this.deferred.length === 0) return;
		this.deferred = this.deferred.filter((canvas) => {
			if (!this.isIdle(canvas)) return true;
			this.lastHandOut.delete(canvas);
			this.live = Math.max(0, this.live - 1);
			this.destroy(canvas);
			return false;
		});
	}

	getStats(): { live: number; free: number; maxFree: number } {
		return { live: this.live, free: this.free.length, maxFree: this.maxFree() };
	}

	/** Its quarantine is over: no draw of the renderer that got it can still upload it. */
	private isIdle(canvas: TCanvas): boolean {
		if (this.isHeld(canvas)) return false;
		const last = this.lastHandOut.get(canvas);
		return last === undefined || this.clock.draws - last >= this.quarantine();
	}

	/** Lets a canvas go: destroyed now past its quarantine, else once it is over (live till then). */
	private drop(canvas: TCanvas): void {
		this.owned.delete(canvas);
		this.freedAt.delete(canvas);
		if (!this.isIdle(canvas)) {
			if (!this.deferred.includes(canvas)) this.deferred.push(canvas);
			return;
		}
		this.lastHandOut.delete(canvas);
		this.live = Math.max(0, this.live - 1);
		this.destroy(canvas);
	}
}
