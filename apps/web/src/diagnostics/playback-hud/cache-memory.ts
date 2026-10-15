/**
 * The frame cache's memory line of the playback HUD (pure; `recorder.ts`
 * samples `videoCache.getMemoryStats()` when it refreshes the overlay).
 */
export type CacheMemorySnapshot = {
	/** When it was sampled (performance.now()). */
	atMs: number;
	mode: string;
	/** Why the budget is what it is (memory-budget.ts BudgetReason). */
	reason: string;
	budgetBytes: number;
	usedBytes: number;
	lruBytes: number;
	lruFrames: number;
	/** Totals since the app started. */
	lruHits: number;
	streams: number;
	restarts: number;
	/** Decoded frames held: read-ahead, the decoders' own queues, frames kept to redraw larger. */
	readAheadBytes: number;
	decoderQueueBytes: number;
	keptDecodedBytes: number;
	/** Requests queued on another clip's stream, and frames redrawn larger without a decoder (totals). */
	borrows: number;
	redraws: number;
	availableBytes: number | null;
	appBytes: number | null;
};

const MiB = 1024 ** 2;

function megabytes(bytes: number | null): string {
	return bytes === null ? "-" : (bytes / MiB).toFixed(0);
}

/** Per second between two samples; "-" without a usable earlier one. */
function rate({
	current,
	previous,
	elapsedMs,
}: {
	current: number;
	previous: number | undefined;
	elapsedMs: number;
}): string {
	if (previous === undefined || elapsedMs <= 0 || current < previous) return "-";
	return ((current - previous) / (elapsedMs / 1000)).toFixed(1);
}

export function formatCacheMemoryLine({
	current,
	previous,
}: {
	current: CacheMemorySnapshot;
	previous: CacheMemorySnapshot | null;
}): string {
	const elapsedMs = previous ? current.atMs - previous.atMs : 0;
	return [
		`cache: budget ${megabytes(current.budgetBytes)} MB (${current.mode}, ${current.reason})`,
		`used ${megabytes(current.usedBytes)} MB (kept ${megabytes(current.lruBytes)} MB, ${current.lruFrames} frames; decoded ${megabytes(current.readAheadBytes + current.decoderQueueBytes + current.keptDecodedBytes)} MB)`,
		`LRU hits ${current.lruHits} (${rate({ current: current.lruHits, previous: previous?.lruHits, elapsedMs })}/s)`,
		`streams ${current.streams}`,
		`restarts ${rate({ current: current.restarts, previous: previous?.restarts, elapsedMs })}/s`,
		`borrowed ${rate({ current: current.borrows, previous: previous?.borrows, elapsedMs })}/s`,
		`redraws ${current.redraws}`,
		`available ${megabytes(current.availableBytes)} MB`,
		`app ${megabytes(current.appBytes)} MB`,
	].join(" | ");
}
