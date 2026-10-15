import { describe, expect, test } from "bun:test";
import { detectOnsets, type HitBand } from "../detect";
import {
	constantBeats,
	mulberry32,
	SAMPLE_RATE,
	score,
	synth,
} from "./synthetic-music";

// Drum hits in no regular pattern ("pat pat patapata"): gaps of 1/2, 1/4, 1/8,
// 1/12 and 1/16 of a second, a little loose, never closer than `minGap`. Kicks
// and snare-like noise bursts alternate at random, snares at a random loudness.
function irregularHits({
	seconds,
	seed,
	minGap = 0.06,
}: {
	seconds: number;
	seed: number;
	minGap?: number;
}): number[] {
	const random = mulberry32(seed);
	const gaps = [0.5, 0.5, 0.25, 0.25, 0.125, 0.125, 0.083, 0.06];
	const times: number[] = [];
	let t = 0.3;
	while (t < seconds - 0.3) {
		times.push(t);
		t += Math.max(minGap, gaps[Math.floor(random() * gaps.length)] * (0.92 + 0.16 * random()));
	}
	return times;
}

function addSnare({
	x,
	at,
	amp,
	random,
}: {
	x: Float32Array;
	at: number;
	amp: number;
	random: () => number;
}) {
	const start = Math.round(at * SAMPLE_RATE);
	for (let i = 0; i < 0.14 * SAMPLE_RATE && start + i < x.length; i++) {
		x[start + i] +=
			amp *
			(0.7 * (random() * 2 - 1) * Math.exp(-i / (0.03 * SAMPLE_RATE)) +
				0.4 *
					Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) *
					Math.exp(-i / (0.05 * SAMPLE_RATE)));
	}
}

function addHat({
	x,
	at,
	amp,
	random,
}: {
	x: Float32Array;
	at: number;
	amp: number;
	random: () => number;
}) {
	const start = Math.round(at * SAMPLE_RATE);
	for (let i = 0; i < 0.03 * SAMPLE_RATE && start + i < x.length; i++) {
		x[start + i] += amp * (random() * 2 - 1) * Math.exp(-i / (0.008 * SAMPLE_RATE));
	}
}

function drumTrack({
	seconds,
	times,
	seed,
	pad = true,
	softest = 0.3,
}: {
	seconds: number;
	times: number[];
	seed: number;
	pad?: boolean;
	softest?: number;
}): Float32Array {
	const random = mulberry32(seed + 99);
	const kicks = times.filter(() => random() < 0.5);
	const x = synth({ seconds, beatTimes: kicks, hats: false, pad, seed, kickAmp: 0.8 });
	for (const at of times.filter((t) => !kicks.includes(t))) {
		addSnare({ x, at, amp: softest + (0.8 - softest) * random(), random });
	}
	return x;
}

function expectFound({
	truth,
	samples,
	recall = 0.95,
}: {
	truth: number[];
	samples: Float32Array;
	recall?: number;
}) {
	const result = detectOnsets({ samples, sampleRate: SAMPLE_RATE });
	if (!result.ok) throw new Error(`expected hits, got ${result.reason}`);
	const found = score({ truth, found: result.beatsSec });
	expect(found.recall).toBeGreaterThanOrEqual(recall);
	expect(found.falsePositiveRate).toBeLessThanOrEqual(0.03);
	expect(Math.abs(found.medianErrorMs)).toBeLessThanOrEqual(15);
	return result.beatsSec;
}

describe("detectOnsets on drums in no regular pattern", () => {
	for (const seed of [1, 2, 3]) {
		test(`kicks and snares, seed ${seed}`, () => {
			const times = irregularHits({ seconds: 40, seed });
			expectFound({ truth: times, samples: drumTrack({ seconds: 40, times, seed }) });
		});
	}

	test("without a pad under it", () => {
		const times = irregularHits({ seconds: 40, seed: 4 });
		// The weakest snares (0.3 amplitude, 10 dB under a kick) sit near the rise floor.
		expectFound({
			truth: times,
			samples: drumTrack({ seconds: 40, times, seed: 4, pad: false }),
			recall: 0.93,
		});
	});

	test("a regular roll with hits 55 ms apart", () => {
		// 50 ms apart measured 93 %, 47 ms 85 %: hits closer than about 46 ms merge.
		const truth = Array.from({ length: 40 }, (_, i) => 1 + i * 0.055);
		expectFound({
			truth,
			samples: synth({ seconds: 5, beatTimes: truth, hats: false, pad: false, noiseDb: -60 }),
			recall: 0.97,
		});
	});

	test("quiet ghost notes between loud hits", () => {
		const times = irregularHits({ seconds: 40, seed: 3 });
		expectFound({
			truth: times,
			samples: drumTrack({ seconds: 40, times, seed: 3, softest: 0.1 }),
			recall: 0.9,
		});
	});

	test("every kick and snare is found among 16th hi-hats (9 hits a second)", () => {
		const beat = 60 / 140;
		const kicks = constantBeats({ bpm: 140, first: 0.2, until: 40 });
		const x = synth({ seconds: 40, beatTimes: kicks, hats: false });
		const random = mulberry32(11);
		for (let t = 0.2; t < 39.5; t += beat / 4) {
			if (!kicks.some((k) => Math.abs(k - t) < 0.01)) {
				addHat({ x, at: t, amp: 0.25, random });
			}
		}
		const snares: number[] = [];
		for (let t = 0.2 + beat; t < 39.5; t += 2 * beat) {
			addSnare({ x, at: t, amp: 0.6, random });
			snares.push(t);
		}
		const result = detectOnsets({ samples: x, sampleRate: SAMPLE_RATE });
		if (!result.ok) throw new Error(`expected hits, got ${result.reason}`);
		// The quiet hats may or may not be picked up: only the loud hits are promised.
		const loud = [...kicks, ...snares];
		expect(score({ truth: loud, found: result.beatsSec }).recall).toBeGreaterThanOrEqual(0.97);
	});

	test("a plain steady kick is found too", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 30 });
		expectFound({
			truth,
			samples: synth({ seconds: 30, beatTimes: truth, hats: false }),
		});
	});

	test("hit times land on the attack, not 11 ms early", () => {
		for (const seed of [1, 2, 3]) {
			const times = irregularHits({ seconds: 40, seed });
			const result = detectOnsets({
				samples: drumTrack({ seconds: 40, times, seed }),
				sampleRate: SAMPLE_RATE,
			});
			if (!result.ok) throw new Error(`expected hits, got ${result.reason}`);
			expect(Math.abs(score({ truth: times, found: result.beatsSec }).medianErrorMs)).toBeLessThanOrEqual(5);
		}
	});

	test("two kicks 25 ms apart are one hit, 60 ms apart are two", () => {
		const near = detectOnsets({
			samples: synth({ seconds: 7, beatTimes: [3.0, 3.025, 5.0], hats: false, pad: false, noiseDb: -60 }),
			sampleRate: SAMPLE_RATE,
		});
		const apart = detectOnsets({
			samples: synth({ seconds: 7, beatTimes: [3.0, 3.06, 5.0], hats: false, pad: false, noiseDb: -60 }),
			sampleRate: SAMPLE_RATE,
		});
		if (!near.ok || !apart.ok) throw new Error("expected hits");
		// The window is 2.9-3.1 s: the click a synthetic kick's cut-off tail makes comes later.
		const around = (hits: number[]) => hits.filter((hit) => hit > 2.9 && hit < 3.1).length;
		expect(around(near.beatsSec)).toBe(1);
		expect(around(apart.beatsSec)).toBe(2);
	});

	test("hits come back ascending, unique and inside the audio", () => {
		const times = irregularHits({ seconds: 20, seed: 5 });
		const found = expectFound({
			truth: times,
			samples: drumTrack({ seconds: 20, times, seed: 5 }),
		});
		for (let i = 0; i < found.length; i++) {
			expect(found[i]).toBeGreaterThanOrEqual(0);
			expect(found[i]).toBeLessThanOrEqual(20);
			if (i > 0) expect(found[i]).toBeGreaterThan(found[i - 1]);
		}
	});

	test("a clip of two seconds is long enough", () => {
		const times = [0.3, 0.8, 1.2, 1.55];
		const result = detectOnsets({
			samples: drumTrack({ seconds: 2, times, seed: 6 }),
			sampleRate: SAMPLE_RATE,
		});
		expect(result.ok).toBe(true);
	});
});

describe("detectOnsets on a few hits over a quiet room", () => {
	// Normalising by the clip's RMS once made noise-floor peaks pass as hits here.
	test("two kicks in ten seconds give two hits", () => {
		const truth = [3, 6];
		expectFound({
			truth,
			samples: synth({ seconds: 10, beatTimes: truth, hats: false, pad: true }),
			recall: 1,
		});
	});

	test("eight kicks in forty seconds give eight hits", () => {
		const truth = [2, 5.3, 9.1, 14.6, 20.2, 24, 27.5, 33];
		expectFound({
			truth,
			samples: synth({ seconds: 40, beatTimes: truth, hats: false, pad: true }),
			recall: 1,
		});
	});

	test("six claps over a louder noise floor give six hits", () => {
		const truth = [1.5, 4.2, 7.7, 12.3, 15.1, 19.4];
		const random = mulberry32(21);
		const x = synth({ seconds: 22, beatTimes: [], hats: false, pad: true, noiseDb: -34 });
		for (const at of truth) addSnare({ x, at, amp: 0.5, random });
		expectFound({ truth, samples: x, recall: 1 });
	});
});

describe("detectOnsets on audio without hits", () => {
	test("white noise is not turned into hits", () => {
		const random = mulberry32(5);
		const samples = new Float32Array(SAMPLE_RATE * 30).map(() => (random() * 2 - 1) * 0.05);
		expect(detectOnsets({ samples, sampleRate: SAMPLE_RATE })).toEqual({
			ok: false,
			reason: "no-beat",
		});
	});

	test("a steady pad over a noise floor is not turned into hits", () => {
		const samples = synth({ seconds: 30, beatTimes: [], hats: false, pad: true });
		expect(detectOnsets({ samples, sampleRate: SAMPLE_RATE })).toEqual({
			ok: false,
			reason: "no-beat",
		});
	});

	test("speech-like syllables are not turned into hits", () => {
		const random = mulberry32(8);
		const samples = new Float32Array(SAMPLE_RATE * 30);
		for (let i = 0; i < samples.length; i++) {
			const syllable = Math.sin((2 * Math.PI * 4 * i) / SAMPLE_RATE) ** 2;
			samples[i] =
				(random() * 2 - 1) * 0.2 * syllable +
				0.1 * Math.sin((2 * Math.PI * 140 * i) / SAMPLE_RATE) * syllable;
		}
		expect(detectOnsets({ samples, sampleRate: SAMPLE_RATE })).toEqual({
			ok: false,
			reason: "no-beat",
		});
	});
});

describe("detectOnsets input checks", () => {
	test("under a second is too short", () => {
		expect(
			detectOnsets({
				samples: new Float32Array(SAMPLE_RATE / 2).fill(0.5),
				sampleRate: SAMPLE_RATE,
			}),
		).toEqual({ ok: false, reason: "too-short" });
	});

	test("silence is silent", () => {
		expect(
			detectOnsets({ samples: new Float32Array(SAMPLE_RATE * 5), sampleRate: SAMPLE_RATE }),
		).toEqual({ ok: false, reason: "silent" });
	});

	test("an unusable sample rate throws, like detectBeats", () => {
		expect(() => detectOnsets({ samples: new Float32Array(100), sampleRate: 100 })).toThrow(
			RangeError,
		);
	});

	test("maxHits keeps the biggest hits, not the first ones, in order", () => {
		// 20 soft kicks fill the first half, 20 loud ones the second; room for 20.
		const soft = Array.from({ length: 20 }, (_, i) => 1 + i);
		const loud = Array.from({ length: 20 }, (_, i) => 22 + i);
		const samples = synth({
			seconds: 43,
			beatTimes: loud,
			hats: false,
			pad: false,
			kickAmp: 0.8,
			noiseDb: -70,
		});
		const softer = synth({
			seconds: 43,
			beatTimes: soft,
			hats: false,
			pad: false,
			kickAmp: 0.15,
			noiseDb: -70,
			seed: 3,
		});
		for (let i = 0; i < samples.length; i++) samples[i] += softer[i];

		const uncapped = detectOnsets({ samples, sampleRate: SAMPLE_RATE });
		const capped = detectOnsets({ samples, sampleRate: SAMPLE_RATE, maxHits: 20 });
		if (!uncapped.ok || !capped.ok) throw new Error("expected hits");
		expect(uncapped.beatsSec.length).toBeGreaterThan(40);
		expect(capped.beatsSec.length).toBe(20);
		// Most of what stays is from the loud half (about 16 of 20 measured); keeping
		// the first 20 in time would keep none of it.
		expect(capped.beatsSec.filter((hit) => hit > 21.5).length).toBeGreaterThanOrEqual(12);
		expect(capped.beatsSec).toEqual([...capped.beatsSec].sort((x, y) => x - y));
		for (const hit of capped.beatsSec) {
			expect(uncapped.beatsSec).toContain(hit);
		}
	});
});

// ---------------------------------------------------------------- by band

// A pitched note with a short attack and a soft end (no click at the cut).
function addNote({
	x,
	at,
	hz,
	amp,
	seconds,
	decay,
}: {
	x: Float32Array;
	at: number;
	hz: number;
	amp: number;
	seconds: number;
	decay: number;
}) {
	const start = Math.round(at * SAMPLE_RATE);
	const length = Math.round(seconds * SAMPLE_RATE);
	const fade = 0.02 * SAMPLE_RATE;
	for (let i = 0; i < length && start + i < x.length; i++) {
		x[start + i] +=
			amp *
			Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) *
			Math.exp(-i / (decay * SAMPLE_RATE)) *
			Math.min(1, i / (0.004 * SAMPLE_RATE)) *
			Math.min(1, (length - i) / fade);
	}
}

function spreadTimes({ seed, count }: { seed: number; count: number }): number[] {
	const random = mulberry32(seed);
	const times: number[] = [];
	let t = 0.5;
	for (let i = 0; i < count; i++) {
		times.push(t);
		t += 0.3 + random() * 0.9;
	}
	return times;
}

function recallOf({
	truth,
	samples,
	band,
}: {
	truth: number[];
	samples: Float32Array;
	band: HitBand;
}): number {
	const result = detectOnsets({ samples, sampleRate: SAMPLE_RATE, band });
	return result.ok ? score({ truth, found: result.beatsSec }).recall : 0;
}

function floor(seconds: number): Float32Array {
	return synth({ seconds, beatTimes: [], hats: false, pad: false, noiseDb: -50 });
}

describe("detectOnsets by band", () => {
	test("kicks are found by low and not by high", () => {
		const times = spreadTimes({ seed: 11, count: 30 });
		const samples = synth({
			seconds: times[times.length - 1] + 1,
			beatTimes: times,
			hats: false,
			pad: false,
			noiseDb: -50,
		});
		expect(recallOf({ truth: times, samples, band: "low" })).toBeGreaterThanOrEqual(0.95);
		expect(recallOf({ truth: times, samples, band: "high" })).toBeLessThan(0.2);
	});

	test("two kicks over a quiet room give two hits in low, whose noise floor is the highest", () => {
		const truth = [3, 6];
		const samples = synth({ seconds: 10, beatTimes: truth, hats: false, pad: true });
		const result = detectOnsets({ samples, sampleRate: SAMPLE_RATE, band: "low" });
		if (!result.ok) throw new Error(`expected hits, got ${result.reason}`);
		expect(score({ truth, found: result.beatsSec }).recall).toBe(1);
		expect(result.beatsSec.length).toBeLessThanOrEqual(3);
	});

	test("a bass line of 60-100 Hz notes is found by low", () => {
		const times = spreadTimes({ seed: 12, count: 30 });
		const samples = floor(times[times.length - 1] + 1);
		const random = mulberry32(5);
		for (const at of times) {
			addNote({ x: samples, at, hz: 60 + 40 * random(), amp: 0.5, seconds: 0.35, decay: 0.12 });
		}
		expect(recallOf({ truth: times, samples, band: "low" })).toBeGreaterThanOrEqual(0.9);
		expect(recallOf({ truth: times, samples, band: "high" })).toBeLessThan(0.2);
	});

	test("hi-hat noise is found by high", () => {
		const times = spreadTimes({ seed: 13, count: 30 });
		const samples = floor(times[times.length - 1] + 1);
		const random = mulberry32(6);
		for (const at of times) addHat({ x: samples, at, amp: 0.35, random });
		expect(recallOf({ truth: times, samples, band: "high" })).toBeGreaterThanOrEqual(0.9);
	});

	test("melody notes are found by mid and never by high", () => {
		const times = spreadTimes({ seed: 14, count: 30 });
		const samples = floor(times[times.length - 1] + 1);
		const random = mulberry32(7);
		for (const at of times) {
			addNote({
				x: samples,
				at,
				hz: [440, 523, 659, 784][Math.floor(random() * 4)],
				amp: 0.35,
				seconds: 0.4,
				decay: 0.15,
			});
		}
		expect(recallOf({ truth: times, samples, band: "mid" })).toBeGreaterThanOrEqual(0.85);
		expect(recallOf({ truth: times, samples, band: "high" })).toBeLessThan(0.2);
	});

	test("next to loud kicks mid finds clearly more of the notes than all", () => {
		// A pitched note lifts one or two of the 32 bands: the full average buries it
		// under the kicks. Measured over four seeds: mid 0.83-0.87, all 0.53-0.63.
		for (const seed of [41, 42, 43, 44]) {
			const notes = spreadTimes({ seed, count: 30 });
			const kicks = spreadTimes({ seed: seed + 100, count: 30 }).map((time) => time + 0.13);
			const samples = synth({
				seconds: Math.max(notes[notes.length - 1], kicks[kicks.length - 1]) + 1,
				beatTimes: kicks,
				hats: false,
				pad: false,
				noiseDb: -50,
			});
			const random = mulberry32(7);
			for (const at of notes) {
				addNote({
					x: samples,
					at,
					hz: [440, 523, 659, 784][Math.floor(random() * 4)],
					amp: 0.35,
					seconds: 0.4,
					decay: 0.15,
				});
			}
			const mid = recallOf({ truth: notes, samples, band: "mid" });
			expect(mid).toBeGreaterThanOrEqual(0.75);
			expect(mid - recallOf({ truth: notes, samples, band: "all" })).toBeGreaterThanOrEqual(0.15);
		}
	});

	for (const band of ["all", "low", "mid", "high"] as const) {
		test(`noise, a pad and syllables are not turned into hits in ${band}`, () => {
			const random = mulberry32(5);
			const noise = new Float32Array(SAMPLE_RATE * 30).map(() => (random() * 2 - 1) * 0.05);
			const pad = synth({ seconds: 30, beatTimes: [], hats: false, pad: true });
			const speech = new Float32Array(SAMPLE_RATE * 30);
			const other = mulberry32(8);
			for (let i = 0; i < speech.length; i++) {
				const syllable = Math.sin((2 * Math.PI * 4 * i) / SAMPLE_RATE) ** 2;
				speech[i] =
					(other() * 2 - 1) * 0.2 * syllable +
					0.1 * Math.sin((2 * Math.PI * 140 * i) / SAMPLE_RATE) * syllable;
			}
			for (const samples of [noise, pad, speech]) {
				expect(detectOnsets({ samples, sampleRate: SAMPLE_RATE, band })).toEqual({
					ok: false,
					reason: "no-beat",
				});
			}
		});
	}

	test("a band the sample rate cannot reach finds nothing instead of failing", () => {
		// 3 kHz sampling: nothing above 1.5 kHz exists, so "high" has no bands at all.
		// The same 400 Hz notes are found in "all", so the silence is the band's.
		const sampleRate = 3000;
		const times = spreadTimes({ seed: 21, count: 12 });
		const samples = new Float32Array(Math.round((times[times.length - 1] + 1) * sampleRate));
		for (const at of times) {
			const start = Math.round(at * sampleRate);
			const length = Math.round(0.4 * sampleRate);
			for (let i = 0; i < length && start + i < samples.length; i++) {
				samples[start + i] +=
					0.5 *
					Math.sin((2 * Math.PI * 400 * i) / sampleRate) *
					Math.exp(-i / (0.15 * sampleRate)) *
					Math.min(1, i / (0.004 * sampleRate)) *
					Math.min(1, (length - i) / (0.02 * sampleRate));
			}
		}
		const all = detectOnsets({ samples, sampleRate, band: "all" });
		if (!all.ok) throw new Error(`expected hits, got ${all.reason}`);
		// One analysis frame is 85 ms at 3 kHz: a hit lands within half of that.
		expect(score({ truth: times, found: all.beatsSec, toleranceSec: 0.1 }).recall).toBeGreaterThanOrEqual(0.9);
		expect(detectOnsets({ samples, sampleRate, band: "high" })).toEqual({
			ok: false,
			reason: "no-beat",
		});
	});
});
