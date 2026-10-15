import { LONG_CLIP_FRAMES, LIMITS, MAX_ANALYSED_FRAMES, MAX_MATTE_MEMORY_BYTES } from "./constants";
import { blendMattes } from "./matte-math";
import type { Matte, MatteSource } from "../matte/matte-registry";

export type SequenceMeta = {
	width: number;
	height: number;
	fps: number;
	/** Source second of matte index 0. */
	startSeconds: number;
	/** Distance between two stored matte frames, in video frames. */
	stride: number;
	/** Number of video frames the range covers. */
	frameCount: number;
};

/**
 * Every video frame at first; every 2nd for long clips; wider if the mattes would not fit in
 * memory or the run would take too many model runs. Computed, never looped: a damaged file's
 * frame count cannot make this slow.
 */
export function chooseStride({
	frameCount,
	matteBytes,
	maxBytes = MAX_MATTE_MEMORY_BYTES,
}: {
	frameCount: number;
	matteBytes: number;
	maxBytes?: number;
}): number {
	const counted = Number.isNaN(frameCount) ? 1 : frameCount;
	const frames = Math.min(Math.max(1, Math.floor(counted)), LIMITS.maxFrames);
	const base = frames > LONG_CLIP_FRAMES ? 2 : 1;
	const forMemory = Math.ceil((frames * Math.max(1, matteBytes)) / Math.max(1, maxBytes));
	const forSteps = Math.ceil(frames / MAX_ANALYSED_FRAMES);
	return Math.min(LIMITS.maxStride, Math.max(base, forMemory, forSteps));
}

/**
 * A finished (or partly finished) run of mattes for one clip: the frames stored every `stride`
 * video frames. Between two stored frames the matte is the blend of the neighbours; before the
 * first and after the last it holds the nearest one.
 */
export class SequenceMatteSource implements MatteSource {
	private readonly frames = new Map<number, Uint8Array>();
	private order: number[] = [];
	private last: { hash: string; matte: Matte } | null = null;

	readonly id: string;
	readonly meta: SequenceMeta;

	constructor({ id, meta }: { id: string; meta: SequenceMeta }) {
		this.id = id;
		this.meta = meta;
	}

	set({ index, data }: { index: number; data: Uint8Array }): void {
		if (!this.frames.has(index)) {
			this.order.push(index);
			this.order.sort((a, b) => a - b);
		}
		this.frames.set(index, data);
		this.last = null;
	}

	get size(): number {
		return this.frames.size;
	}

	lookup({ sourceSeconds }: { sourceSeconds: number }): Matte | null {
		if (this.order.length === 0) return null;
		const position = (sourceSeconds - this.meta.startSeconds) * this.meta.fps;
		const { width, height } = this.meta;
		const first = this.order[0] ?? 0;
		const lastIndex = this.order[this.order.length - 1] ?? 0;
		if (position <= first) return this.single(first);
		if (position >= lastIndex) return this.single(lastIndex);
		let lo = 0;
		let hi = this.order.length - 1;
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1;
			if ((this.order[mid] ?? 0) <= position) lo = mid;
			else hi = mid;
		}
		const a = this.order[lo] ?? 0;
		const b = this.order[hi] ?? 0;
		const dataA = this.frames.get(a);
		const dataB = this.frames.get(b);
		if (!dataA || !dataB) return null;
		// quarter steps: the blend is rebuilt only when it visibly changes
		const t = Math.round(((position - a) / (b - a)) * 4) / 4;
		const hash = `${this.id}:${a}-${b}:${t}`;
		if (this.last?.hash === hash) return this.last.matte;
		const matte = { width, height, data: t === 0 ? dataA : t === 1 ? dataB : blendMattes({ a: dataA, b: dataB, t }), hash };
		this.last = { hash, matte };
		return matte;
	}

	private single(index: number): Matte | null {
		const data = this.frames.get(index);
		return data ? { width: this.meta.width, height: this.meta.height, data, hash: `${this.id}:${index}` } : null;
	}
}
