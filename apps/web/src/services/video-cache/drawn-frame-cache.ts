import type { PresentedFrame } from "./frame-stream";

/**
 * Frames already drawn, kept in memory within a byte budget (least recently
 * used first out), so scrubbing back or replaying a recent range shows them
 * without a decoder restart.
 *
 * A kept frame owns its canvas until it is evicted: nothing draws into it
 * meanwhile, and `release` hands the canvas back to its media's recycler.
 * Frames are found by media and time ([timestamp, timestamp + duration)), and a
 * frame drawn at a smaller scale than the caller needs (`frame-scale.ts`: the
 * preview while it plays) is no hit. One entry per timestamp: the largest scale
 * offered, so a replay at preview resolution finds what a paused frame drew.
 */

/** Below this many frames of the offered size the cache keeps nothing (eviction would hit frames still on screen). */
export const MIN_CACHED_FRAMES = 8;

/**
 * The least a kept frame is charged (OWNER DECISION). Small frames (a preview
 * tile at 1/4 of 1080p is 0.5 MB, at 1/16 32 KB) would otherwise let the
 * cache hold thousands of canvases (at the 1.5 GB ceiling about 3,100 of
 * 480x270), each with fixed costs in the GPU process that are not counted and
 * not measured. 1 MiB bounds the count at budget / 1 MiB (256 at 256 MB,
 * 1,536 at 1.5 GB).
 */
export const MIN_KEPT_FRAME_BYTES = 1024 ** 2;

/**
 * How many kept frames have each byte size, for the smallest one without a
 * scan of every entry (asked on every frame a stream retires). Sizes are few:
 * one per media and scale.
 */
export class SizeCounts {
	private readonly counts = new Map<number, number>();

	add(bytes: number): void {
		this.counts.set(bytes, (this.counts.get(bytes) ?? 0) + 1);
	}

	remove(bytes: number): void {
		const count = this.counts.get(bytes) ?? 0;
		if (count <= 1) this.counts.delete(bytes);
		else this.counts.set(bytes, count - 1);
	}

	smallest(): number | null {
		let smallest: number | null = null;
		for (const bytes of this.counts.keys()) {
			if (smallest === null || bytes < smallest) smallest = bytes;
		}
		return smallest;
	}
}

type Entry<TCanvas> = {
	mediaId: string;
	frame: PresentedFrame<TCanvas>;
	bytes: number;
	release: () => void;
};

export class DrawnFrameCache<TCanvas> {
	private budgetBytes: number;
	private bytes = 0;
	private hits = 0;
	private evictions = 0;
	private slowRemovals = 0;
	/** Least recently used first (Map keeps insertion order; a hit moves its entry last). */
	private order = new Map<Entry<TCanvas>, true>();
	/** Per media, sorted by timestamp (one entry per timestamp). */
	private byMedia = new Map<string, Entry<TCanvas>[]>();
	private readonly sizes = new SizeCounts();

	constructor({ budgetBytes }: { budgetBytes: number }) {
		this.budgetBytes = sanitize(budgetBytes);
	}

	setBudget({ budgetBytes }: { budgetBytes: number }): void {
		this.budgetBytes = sanitize(budgetBytes);
		this.evictOver({ budgetBytes: this.budgetBytes });
		const smallest = this.smallestEntryBytes();
		if (smallest !== null && smallest * MIN_CACHED_FRAMES > this.budgetBytes) {
			this.evictOver({ budgetBytes: 0 });
		}
	}

	/**
	 * Takes `frame` and its canvas. False: not taken (no room for the minimum
	 * number of frames, or this time is kept already); the canvas stays its
	 * owner's.
	 */
	offer({
		mediaId,
		frame,
		bytes,
		release,
	}: {
		mediaId: string;
		frame: PresentedFrame<TCanvas>;
		bytes: number;
		release: () => void;
	}): boolean {
		if (!(bytes > 0) || bytes * MIN_CACHED_FRAMES > this.budgetBytes) return false;
		const entries = this.byMedia.get(mediaId) ?? [];
		const kept = entries[insertionIndex({ entries, timestamp: frame.timestamp }) - 1];
		if (kept?.frame.timestamp === frame.timestamp) {
			// This time is kept already: only a larger drawing of it replaces it.
			if (kept.frame.scale >= frame.scale) return false;
			this.remove(kept);
		}
		const index = insertionIndex({ entries, timestamp: frame.timestamp });
		const entry: Entry<TCanvas> = { mediaId, frame, bytes, release };
		entries.splice(index, 0, entry);
		this.byMedia.set(mediaId, entries);
		this.order.set(entry, true);
		this.bytes += bytes;
		this.sizes.add(bytes);
		this.evictOver({ budgetBytes: this.budgetBytes });
		return true;
	}

	/**
	 * The kept frame of `mediaId` shown at `time`, drawn at `scale` or larger
	 * (default 1: full size), or null. A hit makes it the most recently used.
	 */
	find({
		mediaId,
		time,
		scale = 1,
		accept,
	}: {
		mediaId: string;
		time: number;
		scale?: number;
		/** The caller takes only such frames (the entry that covers `time` is the only candidate). */
		accept?: (frame: PresentedFrame<TCanvas>) => boolean;
	}): PresentedFrame<TCanvas> | null {
		const entries = this.byMedia.get(mediaId);
		if (!entries) return null;
		const entry = entries[insertionIndex({ entries, timestamp: time }) - 1];
		if (!entry || time >= entry.frame.timestamp + entry.frame.duration) return null;
		if (entry.frame.scale < scale) return null;
		if (accept && !accept(entry.frame)) return null;
		this.order.delete(entry);
		this.order.set(entry, true);
		this.hits += 1;
		return entry.frame;
	}

	removeMedia({ mediaId }: { mediaId: string }): void {
		for (const entry of [...(this.byMedia.get(mediaId) ?? [])]) {
			this.remove(entry);
		}
	}

	clear(): void {
		for (const entry of [...this.order.keys()]) {
			this.remove(entry);
		}
	}

	/** Removals the binary search missed (a scan found the entry): 0 while the sorted order holds. */
	slowRemovalCount(): number {
		return this.slowRemovals;
	}

	framesOf({ mediaId }: { mediaId: string }): number {
		return this.byMedia.get(mediaId)?.length ?? 0;
	}

	getStats(): { bytes: number; frames: number; hits: number; evictions: number } {
		return {
			bytes: this.bytes,
			frames: this.order.size,
			hits: this.hits,
			evictions: this.evictions,
		};
	}

	private evictOver({ budgetBytes }: { budgetBytes: number }): void {
		for (const entry of this.order.keys()) {
			if (this.bytes <= budgetBytes) return;
			this.remove(entry);
			this.evictions += 1;
		}
	}

	private remove(entry: Entry<TCanvas>): void {
		if (!this.order.delete(entry)) return;
		const entries = this.byMedia.get(entry.mediaId);
		if (entries) {
			// Sorted by timestamp, one entry per timestamp: the one before the
			// insertion point of its timestamp is the entry itself.
			const found = insertionIndex({ entries, timestamp: entry.frame.timestamp }) - 1;
			let index = found;
			if (entries[found] !== entry) {
				this.slowRemovals += 1;
				index = entries.indexOf(entry);
			}
			if (index >= 0) entries.splice(index, 1);
			if (entries.length === 0) this.byMedia.delete(entry.mediaId);
		}
		this.bytes -= entry.bytes;
		this.sizes.remove(entry.bytes);
		entry.release();
	}

	private smallestEntryBytes(): number | null {
		return this.sizes.smallest();
	}
}

function sanitize(bytes: number): number {
	return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/** Index of the first entry with a timestamp after `timestamp` (binary search). */
function insertionIndex<TCanvas>({
	entries,
	timestamp,
}: {
	entries: Entry<TCanvas>[];
	timestamp: number;
}): number {
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (entries[middle].frame.timestamp <= timestamp) low = middle + 1;
		else high = middle;
	}
	return low;
}
