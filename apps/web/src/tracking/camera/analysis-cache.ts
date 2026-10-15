import type { CameraAnalysis } from "./types";

/** Plan decision 6: the session keeps at most this many bytes of feature tracks. */
export const DEFAULT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** A stretch of the source media, in seconds. */
export interface SourceWindow {
	start: number;
	end: number;
}

/** The bytes an analysis holds in its typed arrays (what the budget counts). */
export function analysisBytes({ analysis }: { analysis: CameraAnalysis }): number {
	const { tracks } = analysis;
	return (
		tracks.trackStart.byteLength +
		tracks.trackLen.byteLength +
		tracks.trackOffset.byteLength +
		tracks.xy.byteLength +
		tracks.liveOffsets.byteLength +
		tracks.liveIds.byteLength +
		tracks.stats.lostFraction.byteLength
	);
}

/** Source seconds from one analysis frame to the next. */
function sourceStep({ analysis }: { analysis: CameraAnalysis }): number {
	return analysis.rate0 / analysis.tracks.fps;
}

/** The source seconds of the first and the last frame of an analysis. */
export function analysisSourceWindow({ analysis }: { analysis: CameraAnalysis }): SourceWindow {
	const step = sourceStep({ analysis });
	return {
		start: analysis.sourceStart,
		end: analysis.sourceStart + (analysis.tracks.frameCount - 1) * step,
	};
}

/**
 * Does the analysis hold a frame for every frame of `window`? The window's
 * ends may fall up to half a frame outside the sampled stretch on either
 * side, plus the frame that follows the last sample (a window usually ends on
 * the clip's end, one step past the last frame taken before it), and still
 * count as covered: the pin would land on the nearest sample anyway.
 */
export function coversWindow({
	analysis,
	window,
}: {
	analysis: CameraAnalysis;
	window: SourceWindow;
}): boolean {
	const step = sourceStep({ analysis });
	const have = analysisSourceWindow({ analysis });
	const slack = step / 2;
	return window.start >= have.start - slack && window.end <= have.end + step + slack;
}

interface Entry {
	analysis: CameraAnalysis;
	bytes: number;
}

/**
 * Session cache of camera analyses, keyed by the host clip and its media and
 * holding the source stretch each one covers. Least recently used entries go
 * first when the byte budget is exceeded. Everything here is synchronous, so a
 * caller can tell at once whether it needs to run an analysis (and show a
 * progress bar) or has one ready.
 *
 * An analysis stays valid when its host is moved, trimmed or retimed (it is
 * bound to source frames, see `host.ts`); it goes when the host is deleted or
 * plays other media (`prune`, `invalidateHost`) or the project changes
 * (`clear`).
 */
export class AnalysisCache {
	private readonly budgetBytes: number;
	/** Insertion order is the use order: the first entry is the least recently used. */
	private readonly entries = new Map<string, Entry>();
	private total = 0;

	constructor({ budgetBytes = DEFAULT_CACHE_BUDGET_BYTES }: { budgetBytes?: number } = {}) {
		this.budgetBytes = budgetBytes;
	}

	get size(): number {
		return this.entries.size;
	}

	get bytes(): number {
		return this.total;
	}

	/** The most recently used analysis of this clip that covers `window`, or null. */
	getCached({
		hostElementId,
		mediaId,
		window,
	}: {
		hostElementId: string;
		mediaId: string;
		window: SourceWindow;
	}): CameraAnalysis | null {
		let found: Entry | null = null;
		for (const entry of this.entries.values()) {
			const { analysis } = entry;
			if (analysis.hostElementId !== hostElementId || analysis.mediaId !== mediaId) continue;
			if (coversWindow({ analysis, window })) found = entry;
		}
		if (!found) return null;
		this.touch({ entry: found });
		return found.analysis;
	}

	byId({ analysisId }: { analysisId: string }): CameraAnalysis | null {
		const entry = this.entries.get(analysisId);
		if (!entry) return null;
		this.touch({ entry });
		return entry.analysis;
	}

	/**
	 * Keeps a finished analysis, as the most recently used, and lets the least
	 * recently used ones go until the budget holds. An analysis larger than the
	 * whole budget is kept on its own. A cancelled analysis is refused: partial
	 * tracks are never kept.
	 */
	put({ analysis }: { analysis: CameraAnalysis }): void {
		if (analysis.status !== "complete") {
			throw new Error(`AnalysisCache: only a complete analysis is kept, got "${analysis.status}"`);
		}
		this.remove({ analysisId: analysis.id });
		const entry: Entry = { analysis, bytes: analysisBytes({ analysis }) };
		this.entries.set(analysis.id, entry);
		this.total += entry.bytes;
		for (const [id, candidate] of this.entries) {
			if (this.total <= this.budgetBytes) break;
			if (candidate === entry) continue;
			this.remove({ analysisId: id });
		}
	}

	invalidateHost({ hostElementId }: { hostElementId: string }): void {
		for (const [id, entry] of this.entries) {
			if (entry.analysis.hostElementId === hostElementId) this.remove({ analysisId: id });
		}
	}

	/**
	 * Drops every analysis whose host clip is gone (`mediaIdOf` gives null) or
	 * plays other media now. Moving, trimming or retiming the host changes
	 * neither, so those keep their analyses.
	 */
	prune({
		mediaIdOf,
	}: {
		mediaIdOf: ({ hostElementId }: { hostElementId: string }) => string | null;
	}): void {
		for (const [id, entry] of this.entries) {
			const { hostElementId, mediaId } = entry.analysis;
			if (mediaIdOf({ hostElementId }) !== mediaId) this.remove({ analysisId: id });
		}
	}

	clear(): void {
		this.entries.clear();
		this.total = 0;
	}

	private touch({ entry }: { entry: Entry }): void {
		this.entries.delete(entry.analysis.id);
		this.entries.set(entry.analysis.id, entry);
	}

	private remove({ analysisId }: { analysisId: string }): void {
		const entry = this.entries.get(analysisId);
		if (!entry) return;
		this.entries.delete(analysisId);
		this.total -= entry.bytes;
	}
}
