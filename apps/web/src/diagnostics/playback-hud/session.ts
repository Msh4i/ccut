/**
 * Pure aggregation of the dev-only playback HUD (`recorder.ts` is the browser
 * glue). One session covers one playback, from Play to Pause; every number is
 * reported per bucket of time since Play, so a slowdown after the first
 * seconds shows up as a change between buckets.
 */

/** Video frame cache counters the HUD reads (a subset of FrameCacheCounters). */
export type HudCacheCounters = {
	hits: number;
	readAheadHits: number;
	advances: number;
	restarts: number;
	stalePresents: number;
	draws: number;
	skipped: number;
	errors: number;
	waitMs: number;
};

export type HudUploadCounters = {
	uploads: number;
	uploadedPixels: number;
	/**
	 * Layer pictures the compositor did not upload because their canvas had
	 * changed size since (a freed canvas): the layer keeps its earlier picture.
	 */
	skippedResized?: number;
};

/** Totals read right before and right after one preview draw. */
export type HudProbe = {
	atMs: number;
	cache: HudCacheCounters;
	uploads: HudUploadCounters;
};

export type HudFrameSample = {
	/** When the draw finished (performance.now()). */
	atMs: number;
	/** The draw, from its start to its end: resolve, build, upload, compositor. */
	renderMs: number;
	/** Part of it the video frame requests spent waiting for the decoder. */
	decodeWaitMs: number;
	uploads: number;
	uploadedPixels: number;
	/** Layer pictures this draw left as they were (see `HudUploadCounters.skippedResized`). */
	keptStalePictures?: number;
	/** Cache counters of this draw (differences). */
	cache: HudCacheCounters;
	/** Effect passes the draw ran, all groups of all layers (each one a full-frame shader run). */
	effectPasses: number;
};

export type HudLongTask = { startMs: number; durationMs: number };
export type HudHeapSample = { atMs: number; usedBytes: number };

export type HudRow = {
	fromS: number;
	toS: number;
	frames: number;
	fps: number;
	/** Time between two finished draws: what the eye sees. */
	intervalP50Ms: number | null;
	intervalP95Ms: number | null;
	intervalMaxMs: number | null;
	renderP50Ms: number | null;
	renderP95Ms: number | null;
	renderMaxMs: number | null;
	decodeWaitMs: number;
	decodeWaitMaxMs: number;
	hits: number;
	advances: number;
	restarts: number;
	stalePresents: number;
	skipped: number;
	draws: number;
	errors: number;
	uploads: number;
	uploadedMegapixels: number;
	/** Layer pictures left as they were because their canvas was freed or resized. */
	keptStalePictures: number;
	longTasks: number;
	longTaskMs: number;
	/** Last JS heap sample of the bucket; null when none (or not available). */
	heapMB: number | null;
	/** Effect passes per draw (median, most); null without draws. */
	effectPassesP50: number | null;
	effectPassesMax: number | null;
	/** Draws that failed or were drawn without their effects. */
	renderErrors: number;
};

/** Two minutes at 60 fps. */
const DEFAULT_MAX_FRAMES = 7200;
const MAX_LONG_TASKS = 2000;
const MAX_HEAP_SAMPLES = 600;
const MAX_RENDER_ERRORS = 2000;

export function percentile({
	values,
	q,
}: {
	values: number[];
	q: number;
}): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/**
 * Effect passes of a frame descriptor: every group of every item (clip layers
 * and effect-track scene effects). Structural, so diagnostics need no renderer
 * import; null (nothing drawn yet) is 0.
 */
export function effectPassesOfFrame(
	frame: {
		items: ReadonlyArray<{
			effectPassGroups: ReadonlyArray<ReadonlyArray<unknown>>;
		}>;
	} | null,
): number {
	let passes = 0;
	for (const item of frame?.items ?? []) {
		for (const group of item.effectPassGroups) {
			passes += group.length;
		}
	}
	return passes;
}

export function frameSampleFromProbes({
	before,
	after,
	effectPasses,
}: {
	before: HudProbe;
	after: HudProbe;
	effectPasses: number;
}): HudFrameSample {
	const diff = (key: keyof HudCacheCounters) =>
		after.cache[key] - before.cache[key];
	const cache: HudCacheCounters = {
		hits: diff("hits"),
		readAheadHits: diff("readAheadHits"),
		advances: diff("advances"),
		restarts: diff("restarts"),
		stalePresents: diff("stalePresents"),
		draws: diff("draws"),
		skipped: diff("skipped"),
		errors: diff("errors"),
		waitMs: diff("waitMs"),
	};
	return {
		atMs: after.atMs,
		renderMs: after.atMs - before.atMs,
		decodeWaitMs: cache.waitMs,
		uploads: after.uploads.uploads - before.uploads.uploads,
		uploadedPixels: after.uploads.uploadedPixels - before.uploads.uploadedPixels,
		keptStalePictures: (after.uploads.skippedResized ?? 0) - (before.uploads.skippedResized ?? 0),
		cache,
		effectPasses,
	};
}

/** `window.__playbackHud === true` or `localStorage["ccut.playbackHud"] === "1"`. */
export function parseHudFlag({
	windowFlag,
	storageValue,
}: {
	windowFlag: unknown;
	storageValue: string | null;
}): boolean {
	if (windowFlag === true) return true;
	if (windowFlag === false) return false;
	return storageValue === "1";
}

export class PlaybackSession {
	readonly startMs: number;
	private readonly maxFrames: number;
	private frames: HudFrameSample[] = [];
	private dropped = 0;
	private longTasks: HudLongTask[] = [];
	private heap: HudHeapSample[] = [];
	private renderErrors: number[] = [];

	constructor({
		startMs,
		maxFrames = DEFAULT_MAX_FRAMES,
	}: {
		startMs: number;
		maxFrames?: number;
	}) {
		this.startMs = startMs;
		this.maxFrames = maxFrames;
	}

	addFrame(sample: HudFrameSample): void {
		if (this.frames.length >= this.maxFrames) {
			this.dropped += 1;
			return;
		}
		this.frames.push(sample);
	}

	addLongTask(task: HudLongTask): void {
		if (this.longTasks.length < MAX_LONG_TASKS) this.longTasks.push(task);
	}

	addHeap(sample: HudHeapSample): void {
		if (this.heap.length < MAX_HEAP_SAMPLES) this.heap.push(sample);
	}

	/** A draw that failed or was drawn without its effects. */
	addRenderError({ atMs }: { atMs: number }): void {
		if (this.renderErrors.length < MAX_RENDER_ERRORS) this.renderErrors.push(atMs);
	}

	storedFrames(): number {
		return this.frames.length;
	}

	droppedFrames(): number {
		return this.dropped;
	}

	/** One row per bucket of `bucketSeconds` since the session started, up to `nowMs`. */
	rows({
		bucketSeconds,
		nowMs,
	}: {
		bucketSeconds: number;
		nowMs: number;
	}): HudRow[] {
		const bucketMs = bucketSeconds * 1000;
		const bucketOf = (atMs: number) =>
			Math.max(0, Math.floor((atMs - this.startMs) / bucketMs));
		const lastFrame = this.frames[this.frames.length - 1];
		const lastBucket = Math.max(
			Math.floor((nowMs - this.startMs - 1e-6) / bucketMs),
			lastFrame ? bucketOf(lastFrame.atMs) : 0,
			0,
		);
		const rows: HudRow[] = [];
		for (let bucket = 0; bucket <= lastBucket; bucket++) {
			const fromMs = this.startMs + bucket * bucketMs;
			const toMs = fromMs + bucketMs;
			rows.push(
				this.summarize({
					fromMs,
					toMs,
					coveredMs: Math.max(1e-3, Math.min(toMs, Math.max(nowMs, fromMs)) - fromMs),
					includes: (atMs) => bucketOf(atMs) === bucket,
				}),
			);
		}
		return rows;
	}

	/** The trailing window before `nowMs` (the live line of the overlay). */
	lastWindow({ nowMs, windowMs }: { nowMs: number; windowMs: number }): HudRow {
		const fromMs = Math.max(this.startMs, nowMs - windowMs);
		return this.summarize({
			fromMs,
			toMs: nowMs,
			coveredMs: Math.max(1e-3, nowMs - fromMs),
			includes: (atMs) => atMs > nowMs - windowMs && atMs <= nowMs,
		});
	}

	private summarize({
		fromMs,
		toMs,
		coveredMs,
		includes,
	}: {
		fromMs: number;
		toMs: number;
		coveredMs: number;
		includes: (atMs: number) => boolean;
	}): HudRow {
		const intervals: number[] = [];
		const renders: number[] = [];
		const effectPasses: number[] = [];
		const totals = {
			decodeWaitMs: 0,
			decodeWaitMaxMs: 0,
			hits: 0,
			advances: 0,
			restarts: 0,
			stalePresents: 0,
			skipped: 0,
			draws: 0,
			errors: 0,
			uploads: 0,
			uploadedPixels: 0,
			keptStalePictures: 0,
		};
		let frames = 0;
		for (let index = 0; index < this.frames.length; index++) {
			const sample = this.frames[index];
			if (!includes(sample.atMs)) continue;
			frames += 1;
			if (index > 0) intervals.push(sample.atMs - this.frames[index - 1].atMs);
			renders.push(sample.renderMs);
			effectPasses.push(sample.effectPasses);
			totals.decodeWaitMs += sample.decodeWaitMs;
			totals.decodeWaitMaxMs = Math.max(totals.decodeWaitMaxMs, sample.decodeWaitMs);
			totals.hits += sample.cache.hits + sample.cache.readAheadHits;
			totals.advances += sample.cache.advances;
			totals.restarts += sample.cache.restarts;
			totals.stalePresents += sample.cache.stalePresents;
			totals.skipped += sample.cache.skipped;
			totals.draws += sample.cache.draws;
			totals.errors += sample.cache.errors;
			totals.uploads += sample.uploads;
			totals.uploadedPixels += sample.uploadedPixels;
			totals.keptStalePictures += sample.keptStalePictures ?? 0;
		}
		const tasks = this.longTasks.filter((task) => includes(task.startMs));
		const heapSamples = this.heap.filter((sample) => includes(sample.atMs));
		const lastHeap = heapSamples[heapSamples.length - 1];
		return {
			fromS: (fromMs - this.startMs) / 1000,
			toS: (toMs - this.startMs) / 1000,
			frames,
			fps: frames / (coveredMs / 1000),
			intervalP50Ms: percentile({ values: intervals, q: 0.5 }),
			intervalP95Ms: percentile({ values: intervals, q: 0.95 }),
			intervalMaxMs: intervals.length > 0 ? Math.max(...intervals) : null,
			renderP50Ms: percentile({ values: renders, q: 0.5 }),
			renderP95Ms: percentile({ values: renders, q: 0.95 }),
			renderMaxMs: renders.length > 0 ? Math.max(...renders) : null,
			decodeWaitMs: totals.decodeWaitMs,
			decodeWaitMaxMs: totals.decodeWaitMaxMs,
			hits: totals.hits,
			advances: totals.advances,
			restarts: totals.restarts,
			stalePresents: totals.stalePresents,
			skipped: totals.skipped,
			draws: totals.draws,
			errors: totals.errors,
			uploads: totals.uploads,
			uploadedMegapixels: totals.uploadedPixels / 1e6,
			keptStalePictures: totals.keptStalePictures,
			longTasks: tasks.length,
			longTaskMs: tasks.reduce((sum, task) => sum + task.durationMs, 0),
			heapMB: lastHeap ? lastHeap.usedBytes / (1024 * 1024) : null,
			effectPassesP50: percentile({ values: effectPasses, q: 0.5 }),
			effectPassesMax: effectPasses.length > 0 ? Math.max(...effectPasses) : null,
			renderErrors: this.renderErrors.filter((atMs) => includes(atMs)).length,
		};
	}
}

function fixed({ value, digits }: { value: number | null; digits: number }): string {
	return value === null ? "-" : value.toFixed(digits);
}

export function formatRow(row: HudRow): string {
	const span = `${row.fromS.toFixed(0)}-${row.toS.toFixed(0)} s`.padStart(9);
	return [
		span,
		`${row.fps.toFixed(1).padStart(5)} fps`,
		`int ${fixed({ value: row.intervalP50Ms, digits: 0 })}/${fixed({ value: row.intervalP95Ms, digits: 0 })}/${fixed({ value: row.intervalMaxMs, digits: 0 })} ms`,
		`draw ${fixed({ value: row.renderP50Ms, digits: 0 })}/${fixed({ value: row.renderP95Ms, digits: 0 })}/${fixed({ value: row.renderMaxMs, digits: 0 })} ms`,
		`decode wait ${row.decodeWaitMs.toFixed(0)}/${row.decodeWaitMaxMs.toFixed(0)} ms`,
		`restarts ${row.restarts}`,
		`waits ${row.advances}`,
		`stale ${row.stalePresents}`,
		`skipped ${row.skipped}`,
		`decoder errors ${row.errors}`,
		`uploads ${row.uploads} (${row.uploadedMegapixels.toFixed(1)} MP)`,
		`kept stale pictures ${row.keptStalePictures}`,
		`long tasks ${row.longTasks}/${row.longTaskMs.toFixed(0)} ms`,
		`heap ${fixed({ value: row.heapMB, digits: 1 })} MB`,
		`fx passes ${fixed({ value: row.effectPassesP50, digits: 0 })}/${fixed({ value: row.effectPassesMax, digits: 0 })}`,
		`render errors ${row.renderErrors}`,
	].join(" | ");
}

export function formatLastRenderError(message: string | null): string {
	return `last render error: ${message ?? "none"}`;
}

/** Uncaptured GPU errors of the device (getGpuErrorStats), null when the wasm build does not report them. */
export type HudGpuErrors = { count: number; lastMessage: string | null };

export function formatGpuErrors(stats: HudGpuErrors | null): string {
	if (!stats) return "gpu errors: not reported (this wasm build has no getGpuErrorStats)";
	if (stats.count === 0) return "gpu errors: 0";
	return `gpu errors: ${stats.count} (last: ${stats.lastMessage ?? "unknown"})`;
}

/** The copy-paste dump: 5 s buckets, then 1 s rows. */
export function formatSummary({
	session,
	nowMs,
	lastRenderError,
	gpuErrors,
}: {
	session: PlaybackSession;
	nowMs: number;
	/** The preview's last render error message (deduplicated), null when none. */
	lastRenderError: string | null;
	gpuErrors: HudGpuErrors | null;
}): string {
	const elapsed = (nowMs - session.startMs) / 1000;
	const stored = session.storedFrames();
	const header = `Ccut playback HUD: ${elapsed.toFixed(1)} s since play, ${stored + session.droppedFrames()} frames (${session.droppedFrames()} not stored)`;
	const legend =
		"columns: fps | interval between draws p50/p95/max | draw time p50/p95/max | decode wait total/max per draw | decoder restarts | waits for the decoder | stale frames shown | decoded frames skipped | decoder errors | texture uploads | layer pictures kept from an earlier frame | long tasks count/total | JS heap | effect passes per draw p50/max (effect time is not measured: no GPU timer) | draws failed or drawn without effects";
	return [
		header,
		legend,
		formatLastRenderError(lastRenderError),
		formatGpuErrors(gpuErrors),
		"per 5 s since play:",
		...session.rows({ bucketSeconds: 5, nowMs }).map(formatRow),
		"per second:",
		...session.rows({ bucketSeconds: 1, nowMs }).map(formatRow),
	].join("\n");
}
