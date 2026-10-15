/**
 * Ducking envelope (pure): lowers a bed (music) while "voice" ranges play.
 *
 * Each voice range [start, end] gives a trapezoid in dB, worked out offline so
 * it can look ahead:
 *   - attack: ramps from 0 dB down to -amountDb over [start - attack, start],
 *     so the bed is fully ducked when the voice starts;
 *   - hold: stays at -amountDb until end + hold;
 *   - release: ramps back to 0 dB over [end + hold, end + hold + release].
 * Ramps are linear in dB. Where trapezoids meet, the deepest one wins.
 */

import type { TimeRange } from "./silence";

export interface DuckingParams {
	/** How far the bed goes down, dB, >= 0. */
	amountDb: number;
	attackMs: number;
	holdMs: number;
	releaseMs: number;
}

export interface DuckingEnvelope {
	/** Merged voice ranges the envelope was built from. */
	ranges: TimeRange[];
	params: DuckingParams;
	/** Gain in dB at `t` seconds (0 or negative). */
	gainDbAt: (t: number) => number;
	/** Linear gain at `t` seconds, `10^(dB/20)`. */
	gainAt: (t: number) => number;
}

function assertParams(params: DuckingParams): void {
	for (const [name, value] of Object.entries(params)) {
		if (!Number.isFinite(value) || value < 0) {
			throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
		}
	}
}

/**
 * Sorted, non-overlapping voice ranges. Zero-length ranges are dropped. Two
 * ranges merge when the second one's attack starts before the first one's hold
 * ends (the bed would never come back up in between); this includes
 * overlapping and touching ranges.
 */
export function mergeVoiceRanges({
	ranges,
	params,
}: {
	ranges: TimeRange[];
	params: DuckingParams;
}): TimeRange[] {
	for (const range of ranges) {
		if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end < range.start) {
			throw new RangeError(`invalid voice range [${range.start}, ${range.end}]`);
		}
	}
	const attack = params.attackMs / 1000;
	const hold = params.holdMs / 1000;
	const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
	const merged: TimeRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start - attack <= last.end + hold) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ start: range.start, end: range.end });
		}
	}
	return merged;
}

/** 0..1, how far range `range` ducks at `t`. */
function weightAt({ range, t, params }: { range: TimeRange; t: number; params: DuckingParams }): number {
	const attack = params.attackMs / 1000;
	const holdEnd = range.end + params.holdMs / 1000;
	const release = params.releaseMs / 1000;
	if (t < range.start - attack || t > holdEnd + release) return 0;
	if (t < range.start) return attack > 0 ? (t - (range.start - attack)) / attack : 0;
	if (t <= holdEnd) return 1;
	return release > 0 ? 1 - (t - holdEnd) / release : 0;
}

export function createDuckingEnvelope({
	voiceRanges,
	params,
}: {
	voiceRanges: TimeRange[];
	params: DuckingParams;
}): DuckingEnvelope {
	assertParams(params);
	const ranges = mergeVoiceRanges({ ranges: voiceRanges, params });
	const reach = (params.attackMs + params.releaseMs + params.holdMs) / 1000;

	const gainDbAt = (t: number) => {
		let weight = 0;
		// Ranges are sorted and disjoint; only those near `t` can matter.
		let lo = 0;
		let hi = ranges.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ranges[mid].end + reach < t) lo = mid + 1;
			else hi = mid;
		}
		for (let i = lo; i < ranges.length && ranges[i].start - reach <= t; i++) {
			weight = Math.max(weight, weightAt({ range: ranges[i], t, params }));
		}
		return weight === 0 ? 0 : -params.amountDb * weight;
	};

	return {
		ranges,
		params,
		gainDbAt,
		gainAt: (t) => 10 ** (gainDbAt(t) / 20),
	};
}

/** Linear gain per sample: element i is `gainAt(i / sampleRate)`, `ceil(duration * sampleRate)` samples. */
export function sampleEnvelope({
	envelope,
	sampleRate,
	duration,
}: {
	envelope: DuckingEnvelope;
	sampleRate: number;
	duration: number;
}): Float32Array {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError(`sampleRate must be a positive number, got ${sampleRate}`);
	}
	if (!Number.isFinite(duration) || duration < 0) {
		throw new RangeError(`duration must be a finite number >= 0, got ${duration}`);
	}
	const out = new Float32Array(Math.ceil(duration * sampleRate)).fill(1);
	const { params } = envelope;
	const attack = params.attackMs / 1000;
	const tail = (params.holdMs + params.releaseMs) / 1000;
	// Only the samples each range can touch are evaluated.
	for (const range of envelope.ranges) {
		const from = Math.max(0, Math.floor((range.start - attack) * sampleRate));
		const to = Math.min(out.length, Math.ceil((range.end + tail) * sampleRate) + 1);
		for (let i = from; i < to; i++) {
			out[i] = Math.min(out[i], envelope.gainAt(i / sampleRate));
		}
	}
	return out;
}

/** Returns new channels, each sample multiplied by `envelope[i]`. */
export function applyEnvelope({
	channels,
	envelope,
}: {
	channels: Float32Array[];
	envelope: Float32Array;
}): Float32Array[] {
	return channels.map((channel) => {
		if (envelope.length < channel.length) {
			throw new RangeError(`envelope has ${envelope.length} samples, audio ${channel.length}`);
		}
		const out = new Float32Array(channel.length);
		for (let i = 0; i < channel.length; i++) out[i] = channel[i] * envelope[i];
		return out;
	});
}
