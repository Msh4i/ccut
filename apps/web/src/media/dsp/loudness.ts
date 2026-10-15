/**
 * ITU-R BS.1770-4 integrated loudness and sample peak (pure, no DOM).
 *
 * - K-weighting (Annex 1): a high-shelf pre-filter and the RLB high-pass,
 *   designed for the actual sample rate with the bilinear transform
 *   (pre-warped, K = tan(pi f0 / fs)). The analogue parameters are the ones
 *   that reproduce the standard's 48 kHz tables (the same ones libebur128
 *   uses); at 48 kHz the coefficients match Tables 1 and 2. See the RLB
 *   comment for the one deliberate difference at other rates.
 * - Gating (Annex 1, eqs. 3-7): 400 ms blocks starting every 100 ms (75 %
 *   overlap), absolute gate -70 LKFS, relative gate 10 LU under the loudness
 *   of the blocks that passed the absolute gate.
 * - Channel weights: L, R, C 1.0; Ls, Rs 1.41; LFE ignored.
 *
 * Sample peak is not true peak (no oversampling).
 */

export interface Biquad {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

export type ChannelRole = "L" | "R" | "C" | "LFE" | "Ls" | "Rs";

export const CHANNEL_WEIGHTS: Record<ChannelRole, number> = {
	L: 1,
	R: 1,
	C: 1,
	LFE: 0,
	Ls: 1.41,
	Rs: 1.41,
};

export const LOUDNESS_GATING = {
	blockSeconds: 0.4,
	stepSeconds: 0.1,
	absoluteGateLufs: -70,
	relativeGateLu: -10,
} as const;

const LOUDNESS_OFFSET = -0.691;

/** WAV / SMPTE channel order for the common counts. */
export function defaultChannelRoles({ count }: { count: number }): ChannelRole[] {
	switch (count) {
		case 1:
			return ["C"];
		case 2:
			return ["L", "R"];
		case 3:
			return ["L", "R", "C"];
		case 4:
			return ["L", "R", "Ls", "Rs"];
		case 5:
			return ["L", "R", "C", "Ls", "Rs"];
		case 6:
			return ["L", "R", "C", "LFE", "Ls", "Rs"];
		default:
			throw new RangeError(`no default channel layout for ${count} channels; pass roles`);
	}
}

function assertSampleRate(sampleRate: number): void {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError(`sampleRate must be a positive number, got ${sampleRate}`);
	}
}

export function kWeightingCoefficients({ sampleRate }: { sampleRate: number }): {
	preFilter: Biquad;
	rlb: Biquad;
} {
	assertSampleRate(sampleRate);

	// Stage 1: high shelf, ~+4 dB above ~1.5 kHz.
	const shelfF0 = 1681.974450955533;
	const shelfGainDb = 3.999843853973347;
	const shelfQ = 0.7071752369554196;
	const k1 = Math.tan((Math.PI * shelfF0) / sampleRate);
	const vh = 10 ** (shelfGainDb / 20);
	const vb = vh ** 0.4996667741545416;
	const a01 = 1 + k1 / shelfQ + k1 * k1;
	const preFilter: Biquad = {
		b0: (vh + (vb * k1) / shelfQ + k1 * k1) / a01,
		b1: (2 * (k1 * k1 - vh)) / a01,
		b2: (vh - (vb * k1) / shelfQ + k1 * k1) / a01,
		a1: (2 * (k1 * k1 - 1)) / a01,
		a2: (1 - k1 / shelfQ + k1 * k1) / a01,
	};

	// Stage 2: RLB high-pass at ~38 Hz. The standard's 48 kHz numerator is
	// [1, -2, 1], which leaves a passband gain of a0(48 kHz) (~+0.04 dB) that
	// the -0.691 constant absorbs. Scaling the numerator by a0(48 kHz) / a0(fs)
	// keeps that same gain at every rate (otherwise 32 kHz would read ~0.02 dB
	// louder and 192 kHz ~0.03 dB quieter); at 48 kHz the scale is exactly 1.
	const hpF0 = 38.13547087602444;
	const hpQ = 0.5003270373238773;
	const hpA0 = (rate: number) => {
		const k = Math.tan((Math.PI * hpF0) / rate);
		return { k, a0: 1 + k / hpQ + k * k };
	};
	const { k: k2, a0: a02 } = hpA0(sampleRate);
	const numeratorScale = sampleRate === 48_000 ? 1 : hpA0(48_000).a0 / a02;
	const rlb: Biquad = {
		b0: numeratorScale,
		b1: -2 * numeratorScale,
		b2: numeratorScale,
		a1: (2 * (k2 * k2 - 1)) / a02,
		a2: (1 - k2 / hpQ + k2 * k2) / a02,
	};

	return { preFilter, rlb };
}

/**
 * K-weights `channel` and returns the sum of squares of every `step`-sample
 * segment (the last partial segment is dropped: no block can use it).
 */
function kWeightedSegmentEnergy({
	channel,
	preFilter,
	rlb,
	step,
}: {
	channel: Float32Array;
	preFilter: Biquad;
	rlb: Biquad;
	step: number;
}): Float64Array {
	const segments = Math.floor(channel.length / step);
	const energy = new Float64Array(segments);
	// Direct form II transposed, one state pair per stage.
	let s1a = 0;
	let s1b = 0;
	let s2a = 0;
	let s2b = 0;
	const { b0: p0, b1: p1, b2: p2, a1: pa1, a2: pa2 } = preFilter;
	const { b0: r0, b1: r1, b2: r2, a1: ra1, a2: ra2 } = rlb;
	for (let s = 0; s < segments; s++) {
		let sum = 0;
		const end = (s + 1) * step;
		for (let i = s * step; i < end; i++) {
			const x = channel[i];
			const y1 = p0 * x + s1a;
			s1a = p1 * x - pa1 * y1 + s1b;
			s1b = p2 * x - pa2 * y1;
			const y2 = r0 * y1 + s2a;
			s2a = r1 * y1 - ra1 * y2 + s2b;
			s2b = r2 * y1 - ra2 * y2;
			sum += y2 * y2;
		}
		energy[s] = sum;
	}
	return energy;
}

export interface LoudnessResult {
	/** LUFS (= LKFS); `-Infinity` when no block passes the gates or the signal is shorter than 400 ms. */
	integratedLufs: number;
	/** Largest absolute sample, linear (1 = full scale). */
	samplePeak: number;
	samplePeakDb: number;
	/** 400 ms blocks measured. */
	blockCount: number;
	/** Blocks that passed both gates. */
	gatedBlockCount: number;
}

export function measureLoudness({
	channels,
	sampleRate,
	roles,
}: {
	channels: Float32Array[];
	sampleRate: number;
	roles?: ChannelRole[];
}): LoudnessResult {
	assertSampleRate(sampleRate);
	if (channels.length === 0) {
		throw new RangeError("at least one channel is required");
	}
	const length = channels[0].length;
	if (channels.some((channel) => channel.length !== length)) {
		throw new RangeError("all channels must have the same length");
	}
	const channelRoles = roles ?? defaultChannelRoles({ count: channels.length });
	if (channelRoles.length !== channels.length) {
		throw new RangeError(`${channelRoles.length} roles for ${channels.length} channels`);
	}

	let samplePeak = 0;
	for (const channel of channels) {
		for (let i = 0; i < channel.length; i++) {
			const magnitude = Math.abs(channel[i]);
			if (magnitude > samplePeak) samplePeak = magnitude;
		}
	}
	const samplePeakDb = samplePeak > 0 ? 20 * Math.log10(samplePeak) : Number.NEGATIVE_INFINITY;

	const step = Math.max(1, Math.round(LOUDNESS_GATING.stepSeconds * sampleRate));
	const stepsPerBlock = Math.round(LOUDNESS_GATING.blockSeconds / LOUDNESS_GATING.stepSeconds);
	const segmentCount = Math.floor(length / step);
	const blockCount = Math.max(0, segmentCount - stepsPerBlock + 1);
	if (blockCount === 0) {
		return { integratedLufs: Number.NEGATIVE_INFINITY, samplePeak, samplePeakDb, blockCount: 0, gatedBlockCount: 0 };
	}

	const { preFilter, rlb } = kWeightingCoefficients({ sampleRate });
	// Weighted sum over channels of each block's mean square: sum_i G_i z_ij.
	const blockPower = new Float64Array(blockCount);
	const blockSamples = step * stepsPerBlock;
	channels.forEach((channel, c) => {
		const weight = CHANNEL_WEIGHTS[channelRoles[c]];
		if (weight === 0) return;
		const energy = kWeightedSegmentEnergy({ channel, preFilter, rlb, step });
		let window = 0;
		for (let s = 0; s < stepsPerBlock; s++) window += energy[s];
		for (let j = 0; j < blockCount; j++) {
			if (j > 0) window += energy[j + stepsPerBlock - 1] - energy[j - 1];
			blockPower[j] += (weight * Math.max(0, window)) / blockSamples;
		}
	});

	const loudnessOf = (power: number) =>
		power > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;
	const meanPowerOver = (keep: (j: number) => boolean) => {
		let sum = 0;
		let count = 0;
		for (let j = 0; j < blockCount; j++) {
			if (!keep(j)) continue;
			sum += blockPower[j];
			count += 1;
		}
		return { power: count > 0 ? sum / count : 0, count };
	};

	const blockLoudness = Array.from(blockPower, loudnessOf);
	const aboveAbsolute = (j: number) => blockLoudness[j] > LOUDNESS_GATING.absoluteGateLufs;
	const absolute = meanPowerOver(aboveAbsolute);
	if (absolute.count === 0) {
		return { integratedLufs: Number.NEGATIVE_INFINITY, samplePeak, samplePeakDb, blockCount, gatedBlockCount: 0 };
	}
	const relativeGate = loudnessOf(absolute.power) + LOUDNESS_GATING.relativeGateLu;
	const gated = meanPowerOver((j) => aboveAbsolute(j) && blockLoudness[j] > relativeGate);

	return {
		integratedLufs: loudnessOf(gated.power),
		samplePeak,
		samplePeakDb,
		blockCount,
		gatedBlockCount: gated.count,
	};
}

export interface NormalizationGain {
	/** Gain to apply, dB. */
	gainDb: number;
	/** `targetLufs - measuredLufs`, before limits. */
	wantedGainDb: number;
	/** `peakDb + wantedGainDb` would pass `ceilingDb`, so the gain was lowered. */
	cutByCeiling: boolean;
	/** The wanted boost was over `maxBoostDb`. */
	cutByBoostLimit: boolean;
	/** Nothing measurable (no gated loudness): no gain. */
	silent: boolean;
}

/**
 * Gain that brings `measuredLufs` to `targetLufs`, lowered so the sample peak
 * stays at or under `ceilingDb` and a boost stays at or under `maxBoostDb`.
 * Cuts (negative gains) are not limited by `maxBoostDb`; the ceiling can turn
 * a wanted boost into a cut when the peak is already over it.
 */
export function normalizationGainDb({
	measuredLufs,
	targetLufs,
	peakDb,
	ceilingDb,
	maxBoostDb,
}: {
	measuredLufs: number;
	targetLufs: number;
	peakDb: number;
	ceilingDb: number;
	maxBoostDb: number;
}): NormalizationGain {
	for (const [name, value] of [
		["targetLufs", targetLufs],
		["ceilingDb", ceilingDb],
		["maxBoostDb", maxBoostDb],
	] as const) {
		if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`);
	}
	if (maxBoostDb < 0) throw new RangeError(`maxBoostDb must be >= 0, got ${maxBoostDb}`);
	if (Number.isNaN(measuredLufs) || Number.isNaN(peakDb)) {
		throw new RangeError("measuredLufs and peakDb must be numbers");
	}

	if (!Number.isFinite(measuredLufs)) {
		return { gainDb: 0, wantedGainDb: 0, cutByCeiling: false, cutByBoostLimit: false, silent: true };
	}

	const wantedGainDb = targetLufs - measuredLufs;
	const boostLimit = maxBoostDb;
	const ceilingLimit = Number.isFinite(peakDb) ? ceilingDb - peakDb : Number.POSITIVE_INFINITY;
	const gainDb = Math.min(wantedGainDb, boostLimit, ceilingLimit);
	return {
		gainDb,
		wantedGainDb,
		cutByCeiling: ceilingLimit < wantedGainDb && gainDb === ceilingLimit,
		cutByBoostLimit: boostLimit < wantedGainDb && gainDb === boostLimit,
		silent: false,
	};
}
