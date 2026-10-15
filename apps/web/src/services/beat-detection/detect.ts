import type { StemName } from "@/services/stems/types";
// Beat detection: spectral-flux onset envelope -> autocorrelation tempo ->
// Ellis dynamic-programming beat tracker.
//
// Pure DSP on typed arrays: no DOM, no framework, no `@/wasm`. AGENTS.md wants
// non-UI logic in `rust/`; keeping this file dependency-free makes that port
// mechanical. Constants were tuned on synthetic signals only (no real songs).

const FFT_SIZE = 1024;
const HOP = 256;
const BANDS = 32;
const BAND_LOW_HZ = 30;
const BAND_HIGH_HZ = 8000;
// Bass bands count triple: fixes the double-time error on 74/90 BPM tracks
// whose hi-hats are louder than their kick in the other bands.
const BASS_HZ = 200;
const BASS_WEIGHT = 3;
const LOG_GAIN = 1e4;
const MEAN_WINDOW_SEC = 1.5;

// One-frame-wide onset peaks make autocorrelation heights depend on whether
// the true period lands on an integer lag, which flipped the octave guard
// (150 BPM came out as 75). Smoothing the ACF input removes that.
const ACF_SMOOTHING_SIGMA = 1;

// Known limit: from about 189 BPM up, a track is reported at exactly half its
// tempo (95-100 BPM). That is a legitimate on-beat octave, every other beat is
// marked. The 110 BPM prior is not the cause; see the 2/3 check in
// `estimateTempo` for the failure it replaced. Real music is untested.
const MIN_BPM = 60;
const MAX_BPM = 200;
const PRIOR_BPM = 110;
const PRIOR_SIGMA_OCTAVES = 0.8;
// Take the double period when it correlates clearly stronger (kick-kick over
// kick-hat).
const OCTAVE_GUARD_RATIO = 1.15;
// A peak at 2/3 of the winning lag this strong replaces it.
const TWO_THIRDS_RATIO = 0.8;

const DP_TIGHTNESS = 100;

// The flux peaks before the audible attack because the analysis window sees an
// onset early. Measured at 22.05 kHz (a 46 ms window) on synthetic kicks:
// found - truth was -11.2 to -11.4 ms over 74-174 BPM. The window is longer in
// seconds at lower rates, so the bias scales with 22050 / sampleRate (16 kHz
// measured -15.6 ms). Real attacks are untested.
const ONSET_BIAS_SEC = 0.0112;
const ONSET_BIAS_RATE = 22050;

const MIN_SAMPLE_RATE = 3000;
const MAX_SAMPLE_RATE = 768000;
const MIN_DURATION_SEC = 5;
// Hard sanity bounds for this worker; the caller enforces the real 30 min cap.
const MAX_DURATION_SEC = 3600;
const MAX_SAMPLES = 2 ** 28;
const SILENCE_PEAK = 1e-3;
// Gate on the autocorrelation peak ("confidence"). Chance peaks in material
// with no beat follow a 1/sqrt(frames) law: for the worst classes (speech-like
// syllables, gated noise, random clicks; 200 seeds per length) the highest peak
// times sqrt(frames) stays at 9-12.5 whatever the length, i.e. 0.43 at 6 s,
// 0.30 at 12 s, 0.24 at 20 s and 0.17 at 60 s. The old 0.10 gate accepted 22%
// of 288 seeded non-rhythmic signals and 4-5% of plain 20 s white noise.
// Real material grows with length instead: a real song scored 0.48 whole,
// 0.39+ on 20 s excerpts and 0.31+ on 10 s ones; synthetic rhythms with weak
// accents, rubato or 30 ms jitter scored 0.48+.
// The gate is max(MIN_TEMPO_STRENGTH, CHANCE_PEAK_SCALE / sqrt(frames)): about
// 0.38 at 8 s, 0.34 at 10 s, 0.31 at 12 s and the floor from 15 s. The scale
// sits just under the noise maximum, so below about 12 s real music and noise
// overlap and short clips may be rejected (about 8-15% of real 8-10 s excerpts
// here, none from 12 s).
// Not separable by strength: chords with partials a few Hz apart beat like a
// tremolo (a genuine periodic modulation), and a rhythm buried in broadband
// noise sits inside the noise tail and is rejected.
const MIN_TEMPO_STRENGTH = 0.28;
const CHANCE_PEAK_SCALE = 10;
const MIN_BEATS = 8;
const PROGRESS_STEPS = 50;

export type BeatDetectionResult =
	| { ok: true; beatsSec: number[]; bpm: number; confidence: number }
	| { ok: false; reason: "silent" | "too-short" | "no-beat" | "too-long" };

type DetectionFailure = Extract<BeatDetectionResult, { ok: false }>;

/** Hit detection finds no tempo, so there is no bpm or confidence. */
export type OnsetDetectionResult =
	| { ok: true; beatsSec: number[] }
	| DetectionFailure;

/** The checks both detectors share; null means the audio is fine to analyse. */
function rejectInput({
	samples,
	sampleRate,
	minSeconds,
}: {
	samples: Float32Array;
	sampleRate: number;
	minSeconds: number;
}): DetectionFailure | null {
	if (
		!Number.isFinite(sampleRate) ||
		sampleRate < MIN_SAMPLE_RATE ||
		sampleRate > MAX_SAMPLE_RATE
	) {
		throw new RangeError(`Unsupported sample rate: ${sampleRate}`);
	}
	if (samples.length < minSeconds * sampleRate) {
		return { ok: false, reason: "too-short" };
	}
	if (samples.length > MAX_SAMPLES || samples.length > MAX_DURATION_SEC * sampleRate) {
		return { ok: false, reason: "too-long" };
	}
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const magnitude = Math.abs(samples[i]);
		if (magnitude > peak) peak = magnitude;
	}
	return peak < SILENCE_PEAK ? { ok: false, reason: "silent" } : null;
}

export function detectBeats({
	samples,
	sampleRate,
	onProgress,
}: {
	samples: Float32Array;
	sampleRate: number;
	onProgress?: (fraction: number) => void;
}): BeatDetectionResult {
	const rejected = rejectInput({ samples, sampleRate, minSeconds: MIN_DURATION_SEC });
	if (rejected) {
		return rejected;
	}

	const envelope = normalizeEnvelope({
		envelope: computeOnsetEnvelope({ samples, sampleRate, onProgress }),
		sampleRate,
	});
	const tempo = estimateTempo({ envelope, framesPerSecond: sampleRate / HOP });
	if (
		!tempo ||
		!Number.isFinite(tempo.lag) ||
		!(
			tempo.strength >=
			Math.max(MIN_TEMPO_STRENGTH, CHANCE_PEAK_SCALE / Math.sqrt(envelope.length))
		)
	) {
		return { ok: false, reason: "no-beat" };
	}

	const frames = trackBeats({ envelope, period: tempo.lag });
	if (frames.length < MIN_BEATS) {
		return { ok: false, reason: "no-beat" };
	}

	return {
		ok: true,
		beatsSec: frames.map(
			(frame) =>
				(frame * HOP) / sampleRate +
				(ONSET_BIAS_SEC * ONSET_BIAS_RATE) / sampleRate,
		),
		bpm: tempo.bpm,
		confidence: tempo.strength,
	};
}

/**
 * What "Auto hits" listens to: the range, in Hz, of a band's centre frequency.
 * A hit is found if it has enough energy in that range, so a broadband sound (a
 * snare, a hi-hat with a low click) shows up in more than one band: this
 * emphasises, it does not isolate. Demanding that most of a hit's rise sits in
 * the band was tried and dropped: a kick and a hi-hat on the same beat are
 * common, and it would discard the kick.
 */
export type HitBand = "all" | "low" | "mid" | "high";
const HIT_BAND_HZ: Record<HitBand, readonly [number, number]> = {
	all: [0, Number.POSITIVE_INFINITY],
	low: [0, 200], // kick, bass
	mid: [200, 2000], // vocals, melody, snare body
	high: [2000, Number.POSITIVE_INFINITY], // hi-hat, cymbals
};

// Hit detection ("pat pat patapata"): every drum hit, in any rhythm. detectBeats
// fits ONE tempo and snaps to it, so an irregular pattern is rejected or forced
// onto a wrong grid. This reuses its onset envelope and only picks the peaks.
const MIN_HIT_DURATION_SEC = 1;
// The width of the window a peak has to win, so one hit with two flux maxima
// (a snare's attack and body) is one marker. Two peaks closer than the radius
// cannot both win, so the real minimum spacing is (radius + 1) frames: 46 ms at
// the 22.05 kHz the editor analyses at. A regular roll measured: 55 ms apart
// all found, 50 ms 93 %, 47 ms 85 % (32nd notes above about 160 BPM merge).
// No synthetic signal needed the window itself: the 46 ms analysis already
// merges hits 25 ms apart and separates ones 60 ms apart.
const HIT_MIN_GAP_SEC = 0.04;
// A hit must lift the spectrum by this much (`riseAboveMean` units, an average
// of the log-compressed band rises). The flux is logarithmic, so the rise of
// noise does not depend on how loud it is: peaks of white noise, a noise floor
// and a pad reach 1.4-1.8 whatever the level. Real hits measured 2.8 or more at
// the 10th percentile (4.6 median) on irregular drums, 4+ for a few hits over a
// quiet room. Normalising by the RMS instead made the bar depend on the other
// hits in the clip, and it invented 45 hits in 10 s around two real kicks.
// Per band: fewer bands (and, at the bottom, one or two FFT bins each) make the
// average noisier, so the noise floor reaches higher: peaks of white noise were
// 1.4-1.8 in all bands, 3.4 in low, 0 above 1.5 in mid and high. Mid exists for
// pitched notes: they lift one or two of the 32 bands, so next to loud kicks the
// full average buries them. Measured with kicks at 0.8 and notes at 0.35: mid
// found 83-87 % of the notes, all 53-63 %. Kicks (low 100 %, mid 100 %) are found
// by both: the bands emphasise, they do not isolate.
const HIT_MIN_RISE_BY_BAND: Record<HitBand, number> = {
	all: 1.9,
	low: 3.4,
	mid: 2.1,
	high: 1.9,
};
// A tall peak is not enough: speech-like syllables rise by 3.5. What a drum
// track has is a mostly quiet envelope: 80 % of its frames sit below 0.2 of the
// RMS for dense drums (16th hi-hats, 17 hits a second) and below 0.5 for a few
// hits over a noise floor; white noise, a pad and syllables sit at 0.97-1.06.
// The limit is between them, so such audio gets "no hits" instead of invented
// ones. Synthetic signals only; a slow vibrato tone (0.15) still passes it.
const HIT_QUIET_QUANTILE = 0.8;
const HIT_QUIET_LEVEL = 0.7;
// A separated stem is not a full mix: it is already quiet between its notes, so
// the quiet-envelope gate above (meant to turn noise and speech in a full mix
// into "no hits") only rejects real stems — vocals measured 0.738 against the
// 0.7 limit, "other" 0.695 — and is skipped for stem input. Drums get a higher
// bar instead: on a drum stem the full-mix 1.9 marked 19.7 hits per 10 s, 27 %
// of them off the beat (eighth notes, ghost notes); 4 kept 99 % of the beats at
// 16.1 per 10 s, 89 % on a beat (measured on one song). The other stems are
// tonal and softer-edged, so they get a lower bar than the full mix
// (unverified: no ground truth for them yet).
const HIT_MIN_RISE_BY_STEM: Record<StemName, number> = {
	drums: 4,
	bass: 1.6,
	vocals: 1.6,
	other: 1.6,
};
// Same cap as a clip may store (`MAX_BEATS_PER_CLIP`): the biggest rises stay.
const MAX_HITS = 20_000;

export function detectOnsets({
	samples,
	sampleRate,
	onProgress,
	band = "all",
	maxHits = MAX_HITS,
	stem,
}: {
	samples: Float32Array;
	sampleRate: number;
	onProgress?: (fraction: number) => void;
	band?: HitBand;
	maxHits?: number;
	/** Set when the audio is one separated stem rather than a full mix. */
	stem?: StemName;
}): OnsetDetectionResult {
	const rejected = rejectInput({ samples, sampleRate, minSeconds: MIN_HIT_DURATION_SEC });
	if (rejected) {
		return rejected;
	}

	const { rise, rms } = riseAboveMean({
		envelope: computeOnsetEnvelope({ samples, sampleRate, onProgress, band }),
		sampleRate,
	});
	if (
		!stem &&
		rise.slice().sort()[Math.floor(HIT_QUIET_QUANTILE * rise.length)] > HIT_QUIET_LEVEL * rms
	) {
		return { ok: false, reason: "no-beat" };
	}

	// A frame whose window sticks out past the end sees the cut as a click. The
	// start shows no click, but frame 0 has no flux, so a hit in the first 25 ms
	// or so is not seen.
	const last = Math.floor((samples.length - FFT_SIZE / 2) / HOP);
	const minRise = stem ? HIT_MIN_RISE_BY_STEM[stem] : HIT_MIN_RISE_BY_BAND[band];
	const radius = Math.max(1, Math.round((HIT_MIN_GAP_SEC * sampleRate) / HOP));
	let peaks: Array<{ frame: number; height: number }> = [];
	for (let i = 0; i <= last; i++) {
		const height = rise[i];
		if (height < minRise) continue;
		// The highest value within +-radius; on a plateau the first frame wins.
		let wins = true;
		for (let k = Math.max(0, i - radius); wins && k <= Math.min(last, i + radius); k++) {
			wins = k < i ? rise[k] < height : rise[k] <= height;
		}
		if (wins) peaks.push({ frame: i, height });
	}
	if (peaks.length === 0) {
		return { ok: false, reason: "no-beat" };
	}
	if (peaks.length > maxHits) {
		peaks = peaks.sort((a, b) => b.height - a.height).slice(0, maxHits);
		peaks.sort((a, b) => a.frame - b.frame);
	}
	return {
		ok: true,
		beatsSec: peaks.map(
			({ frame }) =>
				(frame * HOP) / sampleRate + (ONSET_BIAS_SEC * ONSET_BIAS_RATE) / sampleRate,
		),
	};
}

/** In-place radix-2 FFT over its own `re`/`im` buffers. */
function createFft(size: number): {
	re: Float32Array;
	im: Float32Array;
	transform: () => void;
} {
	const levels = Math.log2(size);
	const cos = new Float32Array(size / 2);
	const sin = new Float32Array(size / 2);
	for (let i = 0; i < size / 2; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / size);
		sin[i] = Math.sin((2 * Math.PI * i) / size);
	}
	const reversed = new Uint16Array(size);
	for (let i = 0; i < size; i++) {
		let r = 0;
		for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
		reversed[i] = r;
	}

	const re = new Float32Array(size);
	const im = new Float32Array(size);
	const transform = () => {
		for (let i = 0; i < size; i++) {
			const j = reversed[i];
			if (j > i) {
				let t = re[i];
				re[i] = re[j];
				re[j] = t;
				t = im[i];
				im[i] = im[j];
				im[j] = t;
			}
		}
		for (let blockSize = 2; blockSize <= size; blockSize *= 2) {
			const half = blockSize / 2;
			const step = size / blockSize;
			for (let i = 0; i < size; i += blockSize) {
				for (let j = i, k = 0; j < i + half; j++, k += step) {
					const l = j + half;
					const tre = re[l] * cos[k] + im[l] * sin[k];
					const tim = -re[l] * sin[k] + im[l] * cos[k];
					re[l] = re[j] - tre;
					im[l] = im[j] - tim;
					re[j] += tre;
					im[j] += tim;
				}
			}
		}
	};
	return { re, im, transform };
}

/**
 * Half-wave-rectified spectral flux over 32 log bands, one value per hop. With a
 * `band` other than "all" only the bands whose centre lies in its range count,
 * averaged over those bands. The bass weighting is kept, so the values of
 * different bands are not comparable: each band has its own rise threshold.
 */
function computeOnsetEnvelope({
	samples,
	sampleRate,
	onProgress,
	band = "all",
}: {
	samples: Float32Array;
	sampleRate: number;
	onProgress?: (fraction: number) => void;
	band?: HitBand;
}): Float32Array {
	const { re, im, transform } = createFft(FFT_SIZE);
	const hann = new Float32Array(FFT_SIZE);
	for (let i = 0; i < FFT_SIZE; i++) {
		hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
	}

	const binHz = sampleRate / FFT_SIZE;
	const highHz = Math.min(BAND_HIGH_HZ, sampleRate / 2);
	const edges = new Int32Array(BANDS + 1);
	for (let b = 0; b <= BANDS; b++) {
		edges[b] = Math.max(
			1,
			Math.round((BAND_LOW_HZ * (highHz / BAND_LOW_HZ) ** (b / BANDS)) / binHz),
		);
		if (b > 0 && edges[b] <= edges[b - 1]) edges[b] = edges[b - 1] + 1;
	}
	const weights = new Float32Array(BANDS);
	const [fromHz, toHz] = HIT_BAND_HZ[band];
	let activeBands = 0;
	for (let b = 0; b < BANDS; b++) {
		const centreHz = Math.sqrt(edges[b] * edges[b + 1]) * binHz;
		const active = centreHz >= fromHz && centreHz < toHz;
		weights[b] = !active ? 0 : edges[b] * binHz < BASS_HZ ? BASS_WEIGHT : 1;
		if (active) activeBands++;
	}

	const frames = Math.floor(samples.length / HOP) + 1;
	const progressEvery = Math.max(1, Math.floor(frames / PROGRESS_STEPS));
	const envelope = new Float32Array(frames);
	let previous = new Float32Array(BANDS);
	let current = new Float32Array(BANDS);

	for (let t = 0; t < frames; t++) {
		if (onProgress && t % progressEvery === 0) onProgress(t / frames);

		const start = t * HOP - FFT_SIZE / 2;
		for (let i = 0; i < FFT_SIZE; i++) {
			const k = start + i;
			re[i] = k >= 0 && k < samples.length ? samples[k] * hann[i] : 0;
			im[i] = 0;
		}
		transform();

		for (let b = 0; b < BANDS; b++) {
			let energy = 0;
			for (let k = edges[b]; k < edges[b + 1]; k++) {
				energy += re[k] * re[k] + im[k] * im[k];
			}
			current[b] = Math.log1p((LOG_GAIN * energy) / (edges[b + 1] - edges[b]));
		}

		let flux = 0;
		if (t > 0) {
			for (let b = 0; b < BANDS; b++) {
				const rise = current[b] - previous[b];
				if (rise > 0) flux += rise * weights[b];
			}
		}
		envelope[t] = activeBands > 0 ? flux / activeBands : 0;
		[previous, current] = [current, previous];
	}

	return envelope;
}

/**
 * Subtract a moving mean and rectify: how far the spectrum rose above its recent
 * level, in the units of the log-compressed flux. Also returns the RMS of that.
 */
function riseAboveMean({
	envelope,
	sampleRate,
}: {
	envelope: Float32Array;
	sampleRate: number;
}): { rise: Float32Array; rms: number } {
	const n = envelope.length;
	const radius = Math.round((MEAN_WINDOW_SEC * sampleRate) / HOP);
	const prefix = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + envelope[i];

	const rise = new Float32Array(n);
	let sumSquares = 0;
	for (let i = 0; i < n; i++) {
		const from = Math.max(0, i - radius);
		const to = Math.min(n, i + radius + 1);
		const mean = (prefix[to] - prefix[from]) / (to - from);
		const value = Math.max(0, envelope[i] - mean);
		rise[i] = value;
		sumSquares += value * value;
	}
	return { rise, rms: Math.sqrt(sumSquares / n) || 1 };
}

/** `riseAboveMean` scaled to unit RMS. */
function normalizeEnvelope({
	envelope,
	sampleRate,
}: {
	envelope: Float32Array;
	sampleRate: number;
}): Float32Array {
	const { rise, rms } = riseAboveMean({ envelope, sampleRate });
	for (let i = 0; i < rise.length; i++) rise[i] /= rms;
	return rise;
}

/** Gaussian-weighted sum over +-radius samples (zero outside, not normalised). */
function gaussianSmooth({
	values,
	radius,
	sigma,
}: {
	values: Float32Array;
	radius: number;
	sigma: number;
}): Float32Array {
	const kernel = new Float32Array(2 * radius + 1);
	for (let j = -radius; j <= radius; j++) {
		kernel[j + radius] = Math.exp(-0.5 * (j / sigma) ** 2);
	}
	const n = values.length;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		let sum = 0;
		for (let j = Math.max(-radius, -i); j <= Math.min(radius, n - 1 - i); j++) {
			sum += values[i + j] * kernel[j + radius];
		}
		out[i] = sum;
	}
	return out;
}

/** Autocorrelation peak, log-Gaussian prior around 110 BPM, octave guard. */
function estimateTempo({
	envelope,
	framesPerSecond,
}: {
	envelope: Float32Array;
	framesPerSecond: number;
}): { lag: number; bpm: number; strength: number } | null {
	const n = envelope.length;
	const minLag = Math.floor((framesPerSecond * 60) / MAX_BPM);
	const maxLag = Math.ceil((framesPerSecond * 60) / MIN_BPM);

	let mean = 0;
	for (let i = 0; i < n; i++) mean += envelope[i];
	mean /= n;
	const centered = new Float32Array(n);
	for (let i = 0; i < n; i++) centered[i] = envelope[i] - mean;
	const smoothed = gaussianSmooth({
		values: centered,
		radius: 3 * ACF_SMOOTHING_SIGMA,
		sigma: ACF_SMOOTHING_SIGMA,
	});
	let energy = 0;
	for (let i = 0; i < n; i++) energy += smoothed[i] * smoothed[i];
	if (energy === 0) return null;

	const acf = new Float64Array(maxLag + 2);
	for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
		let sum = 0;
		for (let i = lag; i < n; i++) sum += smoothed[i] * smoothed[i - lag];
		acf[lag] = sum / energy;
	}

	let best = -1;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let lag = minLag; lag <= maxLag; lag++) {
		const bpm = (60 * framesPerSecond) / lag;
		const prior = Math.exp(
			-0.5 * (Math.log2(bpm / PRIOR_BPM) / PRIOR_SIGMA_OCTAVES) ** 2,
		);
		// The double period is rewarded too: robust to weak alternate beats.
		// Only lags up to maxLag + 1 are computed, so this bonus exists for
		// lags up to about half of maxLag, i.e. fast tempos. That favours lag
		// 1.5L over L (see the 2/3 check below).
		const score = (acf[lag] + 0.5 * (acf[lag * 2] || 0)) * prior;
		if (
			score > bestScore &&
			acf[lag] >= acf[lag - 1] &&
			acf[lag] >= acf[lag + 1]
		) {
			bestScore = score;
			best = lag;
		}
	}
	if (best < 0) return null;

	// The bonus above can make lag 1.5L beat the true lag L (at 180 BPM lag 43
	// scores higher than lag 29 when off-beat hats are present), and the guard
	// below would then double 43 to 86, reporting 60 BPM. A clear peak at 2/3
	// of the winner is the real beat.
	const twoThirds = Math.round((best * 2) / 3);
	if (twoThirds >= minLag) {
		let peak = twoThirds;
		if (acf[twoThirds - 1] > acf[peak]) peak = twoThirds - 1;
		if (acf[twoThirds + 1] > acf[peak]) peak = twoThirds + 1;
		if (peak >= minLag && acf[peak] >= TWO_THIRDS_RATIO * acf[best]) best = peak;
	}

	for (;;) {
		const doubled = best * 2;
		if (doubled + 1 > maxLag) break;
		let peak = doubled;
		if (acf[doubled - 1] > acf[peak]) peak = doubled - 1;
		if (acf[doubled + 1] > acf[peak]) peak = doubled + 1;
		if (acf[peak] <= OCTAVE_GUARD_RATIO * acf[best]) break;
		best = peak;
	}

	const a = acf[best - 1];
	const b = acf[best];
	const c = acf[best + 1];
	const curvature = a - 2 * b + c;
	const lag = best + (curvature !== 0 ? (0.5 * (a - c)) / curvature : 0);
	return { lag, bpm: (60 * framesPerSecond) / lag, strength: b };
}

/** Ellis dynamic-programming tracker. Returns fractional envelope frames. */
function trackBeats({
	envelope,
	period,
}: {
	envelope: Float32Array;
	period: number;
}): number[] {
	const n = envelope.length;
	const p = Math.max(1, Math.round(period));

	const radius = Math.max(1, Math.round(p / 32));
	const local = gaussianSmooth({ values: envelope, radius, sigma: radius / 2 });

	// minGap >= 1 keeps every back-link strictly before its frame.
	const minGap = Math.max(1, Math.round(p / 2));
	const maxGap = 2 * p;
	const penalty = new Float32Array(maxGap - minGap + 1);
	for (let gap = minGap; gap <= maxGap; gap++) {
		penalty[gap - minGap] = DP_TIGHTNESS * Math.log(gap / p) ** 2;
	}
	const score = new Float32Array(n);
	const back = new Int32Array(n).fill(-1);
	for (let i = 0; i < n; i++) {
		// Starting a fresh chain here is free, so a track that opens on a beat
		// does not lose it to the gap penalty.
		let bestScore = 0;
		let bestFrom = -1;
		for (let gap = minGap; gap <= maxGap && gap <= i; gap++) {
			const candidate = score[i - gap] - penalty[gap - minGap];
			if (candidate > bestScore) {
				bestScore = candidate;
				bestFrom = i - gap;
			}
		}
		score[i] = local[i] + bestScore;
		back[i] = bestFrom;
	}

	// Last beat: the strongest local maximum of the accumulated score that is
	// not a weak tail.
	const minScore = 0.5 * Float32Array.from(score).sort()[Math.floor(n / 2)];
	let last = 0;
	let lastScore = Number.NEGATIVE_INFINITY;
	for (let i = 1; i < n - 1; i++) {
		if (
			score[i] >= score[i - 1] &&
			score[i] > score[i + 1] &&
			score[i] >= minScore &&
			score[i] > lastScore
		) {
			lastScore = score[i];
			last = i;
		}
	}
	let beats: number[] = [];
	for (let i = last; i >= 0 && beats.length <= n; i = back[i]) beats.push(i);
	beats.reverse();

	// Drop weak beats at both ends (beatless intro and outro).
	let squares = 0;
	for (const i of beats) squares += local[i] * local[i];
	const strongEnough = 0.5 * Math.sqrt(squares / beats.length);
	let from = 0;
	let to = beats.length;
	while (from < to && local[beats[from]] < strongEnough) from++;
	while (to > from && local[beats[to - 1]] < strongEnough) to--;
	beats = beats.slice(from, to);

	return beats.map((i) => {
		const before = i > 0 ? envelope[i - 1] : envelope[i];
		const after = i < n - 1 ? envelope[i + 1] : envelope[i];
		const curvature = before - 2 * envelope[i] + after;
		if (curvature >= 0) return i;
		return i + Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / curvature));
	});
}
