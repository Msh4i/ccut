// Synthetic music: damped 55-135 Hz kick bursts on every beat, hi-hats on the
// off-beats, a two-note pad and a noise floor. Ground truth is the kick start.
export const SAMPLE_RATE = 22050;

export function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return (state / 4294967296) * 2 - 1;
	};
}

export function synth({
	seconds,
	beatTimes,
	sampleRate = SAMPLE_RATE,
	noiseDb = -40,
	pad = true,
	hats = true,
	seed = 1,
	kickAmp = 0.8,
}: {
	seconds: number;
	beatTimes: number[];
	sampleRate?: number;
	noiseDb?: number;
	pad?: boolean;
	hats?: boolean;
	seed?: number;
	kickAmp?: number;
}): Float32Array {
	const x = new Float32Array(Math.round(seconds * sampleRate));
	const random = rng(seed);
	const noiseAmp = 10 ** (noiseDb / 20);
	for (let i = 0; i < x.length; i++) {
		x[i] =
			random() * noiseAmp +
			(pad
				? 0.05 * Math.sin((2 * Math.PI * 220 * i) / sampleRate) +
					0.04 * Math.sin((2 * Math.PI * 329.6 * i) / sampleRate)
				: 0);
	}
	const kick = ({ at, amp }: { at: number; amp: number }) => {
		const start = Math.round(at * sampleRate);
		for (let i = 0; i < 0.12 * sampleRate; i++) {
			const k = start + i;
			if (k >= x.length) break;
			x[k] +=
				amp *
				Math.sin(
					(2 * Math.PI * (55 + 80 * Math.exp(-i / (0.02 * sampleRate))) * i) /
						sampleRate,
				) *
				Math.exp(-i / (0.04 * sampleRate));
		}
	};
	const hat = ({ at, amp }: { at: number; amp: number }) => {
		const start = Math.round(at * sampleRate);
		for (let i = 0; i < 0.03 * sampleRate; i++) {
			const k = start + i;
			if (k >= x.length) break;
			x[k] += amp * random() * Math.exp(-i / (0.008 * sampleRate));
		}
	};
	for (let b = 0; b < beatTimes.length; b++) {
		kick({ at: beatTimes[b], amp: kickAmp });
		if (hats && b + 1 < beatTimes.length) {
			hat({ at: (beatTimes[b] + beatTimes[b + 1]) / 2, amp: 0.25 });
		}
	}
	return x;
}

export function constantBeats({
	bpm,
	first,
	until,
}: {
	bpm: number;
	first: number;
	until: number;
}): number[] {
	const out: number[] = [];
	for (let t = first; t < until - 0.2; t += 60 / bpm) out.push(t);
	return out;
}

export function rampBeats({
	from,
	to,
	first,
	seconds,
}: {
	from: number;
	to: number;
	first: number;
	seconds: number;
}): number[] {
	const out: number[] = [];
	let t = first;
	while (t < seconds - 0.2) {
		out.push(t);
		t += 60 / (from + (to - from) * (t / seconds));
	}
	return out;
}

export function score({
	truth,
	found,
	toleranceSec = 0.04,
}: {
	truth: number[];
	found: number[];
	toleranceSec?: number;
}) {
	const errors: number[] = [];
	for (const t of truth) {
		let best = Number.POSITIVE_INFINITY;
		for (const f of found) {
			if (Math.abs(f - t) < Math.abs(best)) best = f - t;
		}
		if (Math.abs(best) <= toleranceSec) errors.push(best);
	}
	const falsePositives = found.filter(
		(f) => !truth.some((t) => Math.abs(f - t) <= toleranceSec),
	).length;
	errors.sort((a, b) => a - b);
	return {
		recall: errors.length / truth.length,
		falsePositiveRate: falsePositives / found.length,
		medianErrorMs: (errors[Math.floor(errors.length / 2)] ?? Number.NaN) * 1000,
	};
}

/** A good seeded generator: the LCG above has structure that noise tests must not inherit. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export type NoiseKind =
	| "white-uniform"
	| "white-gauss"
	| "pink"
	| "speech-like"
	| "poisson-clicks";

/** Seeded signals with no beat at all, to measure how often chance fakes one. */
export function seededNoise({
	kind,
	seconds,
	seed,
}: {
	kind: NoiseKind;
	seconds: number;
	seed: number;
}): Float32Array {
	const random = mulberry32(seed * 7919 + 13);
	const n = Math.round(seconds * SAMPLE_RATE);
	const x = new Float32Array(n);

	if (kind === "white-uniform") {
		for (let i = 0; i < n; i++) x[i] = (random() * 2 - 1) * 0.3;
	} else if (kind === "white-gauss") {
		for (let i = 0; i < n; i++) {
			const gauss =
				Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
			x[i] = gauss * 0.1;
		}
	} else if (kind === "pink") {
		// Paul Kellet's filter.
		let b0 = 0;
		let b1 = 0;
		let b2 = 0;
		let b3 = 0;
		let b4 = 0;
		let b5 = 0;
		let b6 = 0;
		for (let i = 0; i < n; i++) {
			const white = random() * 2 - 1;
			b0 = 0.99886 * b0 + white * 0.0555179;
			b1 = 0.99332 * b1 + white * 0.0750759;
			b2 = 0.969 * b2 + white * 0.153852;
			b3 = 0.8665 * b3 + white * 0.3104856;
			b4 = 0.55 * b4 + white * 0.5329522;
			b5 = -0.7616 * b5 - white * 0.016898;
			x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.1;
			b6 = white * 0.115926;
		}
	} else if (kind === "speech-like") {
		// Syllable-length bursts of two formants with random gaps: onsets, no grid.
		let i = 0;
		while (i < n) {
			i += Math.round((0.05 + random() * 0.4) * SAMPLE_RATE);
			const syllable = Math.round((0.08 + random() * 0.17) * SAMPLE_RATE);
			const f1 = 300 + random() * 600;
			const f2 = 900 + random() * 1500;
			for (let k = 0; k < syllable && i + k < n; k++) {
				const shape = Math.sin((Math.PI * k) / syllable) ** 2;
				const pitch = 100 + 40 * Math.sin((2 * Math.PI * 3 * k) / SAMPLE_RATE);
				x[i + k] +=
					shape *
					(0.15 * Math.sin((2 * Math.PI * f1 * k) / SAMPLE_RATE) +
						0.1 * Math.sin((2 * Math.PI * f2 * k) / SAMPLE_RATE) +
						0.05 * Math.sin((2 * Math.PI * pitch * k) / SAMPLE_RATE) +
						0.03 * (random() * 2 - 1));
			}
			i += syllable;
		}
	} else {
		// Clicks at random times (a Poisson process): onsets, no grid.
		const rate = [1, 2, 4, 8][Math.floor(random() * 4)];
		let t = -Math.log(1 - random()) / rate;
		while (t < seconds) {
			const start = Math.round(t * SAMPLE_RATE);
			const amp = 0.2 + random() * 0.7;
			const freq = 200 + random() * 3000;
			for (let i = 0; i < 0.012 * SAMPLE_RATE && start + i < n; i++) {
				x[start + i] +=
					amp *
					Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) *
					Math.exp(-i / (0.003 * SAMPLE_RATE));
			}
			t += -Math.log(1 - random()) / rate;
		}
		for (let i = 0; i < n; i++) x[i] += (random() * 2 - 1) * 0.003;
	}
	return x;
}

