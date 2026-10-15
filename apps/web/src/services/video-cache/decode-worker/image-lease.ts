import { CanvasRecycler, type DrawClock } from "../canvas-recycler";

/**
 * The pictures a decode worker made (ImageBitmaps) that live on the main
 * thread as frames' canvases. They follow the rule of the canvases
 * (`canvas-recycler.ts`): a picture is closed only after the renders that got
 * it let go of it (`isHeld`) and its quarantine of draws is over; it is never
 * reused, so a released picture is closed, not kept.
 *
 * Built on a `CanvasRecycler` that keeps no free picture; it shares the draw
 * clock of the media's canvas pools, so a draw at any size counts.
 */
export class ImageLease<TImage extends object> {
	private readonly recycler: CanvasRecycler<TImage>;
	/** Scale of every picture alive (not yet closed), for the memory it holds. */
	private readonly scales = new Map<object, number>();

	constructor({
		close,
		quarantine,
		clock,
		isHeld = () => false,
	}: {
		/** Frees a picture's memory (`ImageBitmap.close()`); called once per picture. */
		close: (image: TImage) => void;
		/** Draws (at any size) a released picture waits after its last hand-out. */
		quarantine: () => number;
		clock: DrawClock;
		/** A render still holds the picture: it is not closed, whatever its quarantine says. */
		isHeld?: (image: TImage) => boolean;
	}) {
		this.recycler = new CanvasRecycler<TImage>({
			create: () => {
				throw new Error("An image lease only adopts pictures");
			},
			quarantine,
			maxFree: () => 0,
			clock,
			isHeld,
			destroy: (image) => {
				this.scales.delete(image);
				close(image);
			},
		});
	}

	/** A picture drawn at `scale` of the video's display size becomes a frame's canvas. */
	adopt({ image, scale }: { image: TImage; scale: number }): void {
		if (this.scales.has(image)) return;
		this.scales.set(image, scale);
		this.recycler.adopt(image);
		this.recycler.trim();
	}

	owns(image: object): boolean {
		return this.scales.has(image);
	}

	noteHandOut(image: TImage): void {
		this.recycler.noteHandOut(image);
	}

	/** Its owner no longer needs the picture: closed now, or once its quarantine is over. */
	release(image: TImage): void {
		this.recycler.release(image);
	}

	/** Closes the released pictures whose quarantine is over. */
	trim(): void {
		this.recycler.trim();
	}

	/** Closes every released picture (the media was cleared; its other owners released theirs first). */
	clear(): void {
		this.recycler.clear();
	}

	getStats(): { live: number; free: number } {
		const { live, free } = this.recycler.getStats();
		return { live, free };
	}

	/** Memory of every picture alive, given the bytes of one at scale 1 (RGBA grows with the area). */
	liveBytes({ fullBytes }: { fullBytes: number }): number {
		let bytes = 0;
		for (const scale of this.scales.values()) bytes += fullBytes * scale * scale;
		return bytes;
	}
}
