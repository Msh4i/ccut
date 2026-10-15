/**
 * Silence detection on decoded PCM (pure, no DOM / AudioContext).
 *
 * Level: RMS per window in dBFS, `20 * log10(rms)`, so a full-scale square
 * wave reads 0 dBFS and a full-scale sine -3.01 dBFS. Each channel's DC offset
 * (its mean over the whole signal) is removed first, and a multichannel window
 * takes the loudest channel: a window is quiet only if every channel is.
 */

export interface TimeRange {
	/** Seconds. */
	start: number;
	/** Seconds, `end > start`. */
	end: number;
}

export interface AudioChannels {
	channels: Float32Array[];
	sampleRate: number;
}

export const DEFAULT_RMS_WINDOW_MS = 20;

function assertChannels({ channels, sampleRate }: AudioChannels): number {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError(`sampleRate must be a positive number, got ${sampleRate}`);
	}
	if (channels.length === 0) {
		throw new RangeError("at least one channel is required");
	}
	const length = channels[0].length;
	if (channels.some((channel) => channel.length !== length)) {
		throw new RangeError("all channels must have the same length");
	}
	return length;
}

function assertNonNegative({ name, value }: { name: string; value: number }): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
	}
}

function channelMean(channel: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < channel.length; i++) sum += channel[i];
	return channel.length > 0 ? sum / channel.length : 0;
}

/**
 * dBFS of consecutive, non-overlapping windows of `windowMs`; the last window
 * may be shorter and is measured over its own length. Digital silence is
 * `-Infinity`.
 */
export function windowedRmsDb({
	channels,
	sampleRate,
	windowMs = DEFAULT_RMS_WINDOW_MS,
}: AudioChannels & { windowMs?: number }): Float64Array {
	const length = assertChannels({ channels, sampleRate });
	if (!Number.isFinite(windowMs) || windowMs <= 0) {
		throw new RangeError(`windowMs must be > 0, got ${windowMs}`);
	}
	const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
	const windowCount = Math.ceil(length / windowSamples);
	const db = new Float64Array(windowCount).fill(Number.NEGATIVE_INFINITY);
	const means = channels.map(channelMean);

	for (let w = 0; w < windowCount; w++) {
		const from = w * windowSamples;
		const to = Math.min(length, from + windowSamples);
		let loudest = 0;
		for (let c = 0; c < channels.length; c++) {
			const channel = channels[c];
			const mean = means[c];
			let sum = 0;
			for (let i = from; i < to; i++) {
				const sample = channel[i] - mean;
				sum += sample * sample;
			}
			loudest = Math.max(loudest, sum / (to - from));
		}
		db[w] = loudest > 0 ? 10 * Math.log10(loudest) : Number.NEGATIVE_INFINITY;
	}
	return db;
}

interface Run {
	quiet: boolean;
	from: number;
	to: number;
}

function runsOf(quiet: boolean[]): Run[] {
	const runs: Run[] = [];
	for (let i = 0; i < quiet.length; i++) {
		const last = runs[runs.length - 1];
		if (last && last.quiet === quiet[i]) {
			last.to = i + 1;
		} else {
			runs.push({ quiet: quiet[i], from: i, to: i + 1 });
		}
	}
	return runs;
}

function mergeNeighbours(runs: Run[]): Run[] {
	const merged: Run[] = [];
	for (const run of runs) {
		const last = merged[merged.length - 1];
		if (last && last.quiet === run.quiet) {
			last.to = run.to;
		} else {
			merged.push({ ...run });
		}
	}
	return merged;
}

/**
 * Silent ranges in seconds, sorted, non-overlapping, inside `[0, duration]`.
 *
 * 1. Windows below `thresholdDb` are quiet.
 * 2. Quiet runs shorter than `minSilenceMs` count as sound (pauses in speech).
 * 3. Sound runs shorter than `minSpeechMs` count as quiet (clicks in a pause).
 * 4. Each range gives `paddingMs` back to the sound next to it (never at the
 *    file's start or end); a range that shrinks to nothing disappears.
 */
export function detectSilences({
	channels,
	sampleRate,
	thresholdDb,
	minSilenceMs,
	minSpeechMs,
	paddingMs,
	windowMs = DEFAULT_RMS_WINDOW_MS,
}: AudioChannels & {
	thresholdDb: number;
	minSilenceMs: number;
	minSpeechMs: number;
	paddingMs: number;
	windowMs?: number;
}): TimeRange[] {
	const length = assertChannels({ channels, sampleRate });
	assertNonNegative({ name: "minSilenceMs", value: minSilenceMs });
	assertNonNegative({ name: "minSpeechMs", value: minSpeechMs });
	assertNonNegative({ name: "paddingMs", value: paddingMs });
	if (Number.isNaN(thresholdDb)) {
		throw new RangeError("thresholdDb must be a number");
	}
	if (length === 0) return [];

	const duration = length / sampleRate;
	const levels = windowedRmsDb({ channels, sampleRate, windowMs });
	const windowSeconds = Math.max(1, Math.round((windowMs / 1000) * sampleRate)) / sampleRate;
	const timeOf = (windowIndex: number) => Math.min(duration, windowIndex * windowSeconds);
	const lengthMs = (run: Run) => (timeOf(run.to) - timeOf(run.from)) * 1000;

	let runs = runsOf(Array.from(levels, (level) => level < thresholdDb));
	runs = mergeNeighbours(
		runs.map((run) => (run.quiet && lengthMs(run) < minSilenceMs ? { ...run, quiet: false } : run)),
	);
	runs = mergeNeighbours(
		runs.map((run) => (!run.quiet && lengthMs(run) < minSpeechMs ? { ...run, quiet: true } : run)),
	);

	const padding = paddingMs / 1000;
	const silences: TimeRange[] = [];
	for (const run of runs) {
		if (!run.quiet) continue;
		const start = run.from === 0 ? 0 : timeOf(run.from) + padding;
		const end = run.to === levels.length ? duration : timeOf(run.to) - padding;
		if (end > start) silences.push({ start, end });
	}
	return silences;
}

/** The parts of `[0, duration]` not covered by `silences`. */
export function keepRanges({
	silences,
	duration,
}: {
	silences: TimeRange[];
	duration: number;
}): TimeRange[] {
	const sorted = [...silences].sort((a, b) => a.start - b.start);
	const keep: TimeRange[] = [];
	let cursor = 0;
	for (const silence of sorted) {
		const start = Math.max(0, Math.min(duration, silence.start));
		const end = Math.max(0, Math.min(duration, silence.end));
		if (start > cursor) keep.push({ start: cursor, end: start });
		cursor = Math.max(cursor, end);
	}
	if (duration > cursor) keep.push({ start: cursor, end: duration });
	return keep;
}
