import { describe, expect, test } from "bun:test";
import { detectBeats } from "../detect";
import {
	constantBeats,
	rampBeats,
	rng,
	SAMPLE_RATE,
	score,
	seededNoise,
	synth,
	type NoiseKind,
} from "./synthetic-music";

function expectAccurate({
	truth,
	result,
}: {
	truth: number[];
	result: ReturnType<typeof detectBeats>;
}) {
	if (!result.ok) throw new Error(`expected beats, got ${result.reason}`);
	const { recall, falsePositiveRate, medianErrorMs } = score({
		truth,
		found: result.beatsSec,
	});
	expect(recall).toBeGreaterThanOrEqual(0.97);
	expect(falsePositiveRate).toBeLessThanOrEqual(0.02);
	expect(Math.abs(medianErrorMs)).toBeLessThanOrEqual(15);
}

describe("detectBeats on steady tempo", () => {
	for (const { bpm, first } of [
		{ bpm: 120, first: 0.3 },
		{ bpm: 128, first: 0.45 },
		{ bpm: 100, first: 0.1 },
		{ bpm: 140, first: 0.62 },
		{ bpm: 174, first: 0.2 },
	]) {
		test(`${bpm} BPM, first beat at ${first}s`, () => {
			const truth = constantBeats({ bpm, first, until: 60 });
			const result = detectBeats({
				samples: synth({ seconds: 60, beatTimes: truth }),
				sampleRate: SAMPLE_RATE,
			});
			expectAccurate({ truth, result });
			if (result.ok) {
				expect(Math.abs(result.bpm - bpm)).toBeLessThan(1);
				expect(result.confidence).toBeGreaterThan(0.25);
			}
		});
	}

	test("120 BPM without hi-hats or pad", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 60 });
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth, hats: false, pad: false }),
			sampleRate: SAMPLE_RATE,
		});
		expectAccurate({ truth, result });
	});
});

describe("detectBeats keeps the octave on slow tracks with hi-hats", () => {
	for (const bpm of [74, 90]) {
		test(`${bpm} BPM is not reported as double time`, () => {
			const truth = constantBeats({ bpm, first: 0.3, until: 60 });
			const result = detectBeats({
				samples: synth({ seconds: 60, beatTimes: truth }),
				sampleRate: SAMPLE_RATE,
			});
			expectAccurate({ truth, result });
			if (result.ok) {
				expect(Math.abs(result.bpm - bpm)).toBeLessThan(1);
			}
		});
	}
});

describe("detectBeats at the edges of a track", () => {
	// 0.3 s at 120 BPM used to lose its first beat to the DP gap penalty.
	for (const first of [0.05, 0.3, 0.45, 0.9]) {
		test(`keeps a first beat at ${first}s and a last beat at the end`, () => {
			const truth = constantBeats({ bpm: 120, first, until: 20 });
			const result = detectBeats({
				samples: synth({ seconds: 20, beatTimes: truth }),
				sampleRate: SAMPLE_RATE,
			});
			if (!result.ok) throw new Error(result.reason);
			expect(result.beatsSec.length).toBe(truth.length);
			expect(Math.abs(result.beatsSec[0] - truth[0])).toBeLessThan(0.03);
			expect(
				Math.abs(
					result.beatsSec[result.beatsSec.length - 1] - truth[truth.length - 1],
				),
			).toBeLessThan(0.03);
		});
	}
});

describe("detectBeats does not find a beat in chance periodicity", () => {
	// Each of these used to be accepted: noise whose autocorrelation happens to
	// peak above the old 0.10 gate (strength 0.11-0.42). The first one is the
	// 20 s white noise that came back as "25 beats (~72 BPM)".
	const accepted: Array<{ kind: NoiseKind; seconds: number; seed: number }> = [
		{ kind: "white-gauss", seconds: 20, seed: 72 },
		{ kind: "white-gauss", seconds: 20, seed: 58 },
		{ kind: "white-uniform", seconds: 20, seed: 60 },
		{ kind: "white-uniform", seconds: 20, seed: 86 },
		{ kind: "white-uniform", seconds: 20, seed: 296 },
		{ kind: "pink", seconds: 20, seed: 282 },
		{ kind: "pink", seconds: 20, seed: 103 },
		// Short clips have the highest chance peaks.
		{ kind: "speech-like", seconds: 8, seed: 4 },
		{ kind: "speech-like", seconds: 60, seed: 3 },
		{ kind: "poisson-clicks", seconds: 8, seed: 31 },
	];
	for (const { kind, seconds, seed } of accepted) {
		test(`${kind}, ${seconds} s, seed ${seed} has no beat`, () => {
			const result = detectBeats({
				samples: seededNoise({ kind, seconds, seed }),
				sampleRate: SAMPLE_RATE,
			});
			expect(result).toEqual({ ok: false, reason: "no-beat" });
		});
	}

	test("none of 60 more seeded white, pink and speech-like signals is accepted", () => {
		let accepted = 0;
		for (const kind of ["white-gauss", "pink", "speech-like"] as const) {
			for (let seed = 200; seed < 220; seed++) {
				const result = detectBeats({
					samples: seededNoise({ kind, seconds: 12, seed }),
					sampleRate: SAMPLE_RATE,
				});
				if (result.ok) accepted++;
			}
		}
		expect(accepted).toBe(0);
	});
});

describe("detectBeats still accepts weak but real rhythms", () => {
	test("kicks 20 dB under the pad level", () => {
		const truth = constantBeats({ bpm: 100, first: 0.3, until: 30 });
		const result = detectBeats({
			samples: synth({ seconds: 30, beatTimes: truth, kickAmp: 0.1, hats: false }),
			sampleRate: SAMPLE_RATE,
		});
		expectAccurate({ truth, result });
	});

	test("human timing: 30 ms of jitter on a 10 s clip", () => {
		const random = rng(4);
		const truth = constantBeats({ bpm: 128, first: 0.3, until: 10 }).map(
			(t) => t + random() * 0.03,
		);
		const result = detectBeats({
			samples: synth({ seconds: 10, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		expect(result.ok).toBe(true);
	});

	test("a short 6 s clip with a clear beat", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 6 });
		const result = detectBeats({
			samples: synth({ seconds: 6, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		expect(result.ok).toBe(true);
	});

	test("a tempo wandering by 8 percent", () => {
		const random = rng(11);
		const truth: number[] = [];
		let t = 0.3;
		let drift = 0;
		while (t < 40) {
			truth.push(t);
			drift = Math.max(-0.08, Math.min(0.08, drift + random() * 0.01));
			t += (60 / 118) * (1 + drift);
		}
		const result = detectBeats({
			samples: synth({ seconds: 42, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		expect(result.ok).toBe(true);
	});

	test("the confidence of real rhythms is far above the gate", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 20 });
		const result = detectBeats({
			samples: synth({ seconds: 20, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.confidence).toBeGreaterThan(0.5);
	});
});

describe("detectBeats keeps the octave across the tempo range", () => {
	// The true beat period falls between autocorrelation bins for most of these
	// tempos; comparing raw integer-lag peaks used to halve them (150 -> 75).
	for (const bpm of [62, 68, 84, 124, 134, 142, 150, 154, 164, 170, 176, 180, 186]) {
		test(`${bpm} BPM is reported at ${bpm}, not at half or double`, () => {
			const truth = constantBeats({ bpm, first: 0.3, until: 60 });
			const result = detectBeats({
				samples: synth({ seconds: 60, beatTimes: truth }),
				sampleRate: SAMPLE_RATE,
			});
			expectAccurate({ truth, result });
			if (result.ok) {
				expect(Math.abs(result.bpm - bpm) / bpm).toBeLessThan(0.02);
			}
		});
	}
});

describe("detectBeats at the top of the tempo range", () => {
	test("from about 190 BPM up a track is reported at exactly half tempo (documented limit)", () => {
		const truth = constantBeats({ bpm: 194, first: 0.3, until: 60 });
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(Math.abs(result.bpm - 97) / 97).toBeLessThan(0.02);
		// Every marked beat is a real beat, it is just every other one.
		const { recall, falsePositiveRate } = score({ truth, found: result.beatsSec });
		expect(falsePositiveRate).toBeLessThanOrEqual(0.02);
		expect(recall).toBeGreaterThan(0.45);
		expect(recall).toBeLessThan(0.55);
	});
});

describe("detectBeats on drifting or imperfect timing", () => {
	test("follows a 100 to 112 BPM tempo drift", () => {
		const truth = rampBeats({ from: 100, to: 112, first: 0.5, seconds: 60 });
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		expectAccurate({ truth, result });
	});

	test("tolerates 15 ms of human jitter", () => {
		const random = rng(9);
		const truth = constantBeats({ bpm: 124, first: 0.3, until: 60 }).map(
			(t) => t + random() * 0.015,
		);
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		expectAccurate({ truth, result });
	});

	test("does not invent beats in a beatless intro and outro", () => {
		// 20 s of pad, 20 s of beat, 20 s of pad.
		const truth = constantBeats({ bpm: 120, first: 20, until: 40 });
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		expectAccurate({ truth, result });
		if (!result.ok) return;
		expect(Math.abs(result.beatsSec[0] - truth[0])).toBeLessThan(0.1);
		expect(
			Math.abs(result.beatsSec[result.beatsSec.length - 1] - truth[truth.length - 1]),
		).toBeLessThan(0.1);
	});
});

describe("detectBeats timing calibration", () => {
	test("reports kick onsets within 3 ms of their attack, not about 11 ms early", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 60 });
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(
			Math.abs(score({ truth, found: result.beatsSec }).medianErrorMs),
		).toBeLessThanOrEqual(3);
	});
});

describe("detectBeats timing at lower sample rates", () => {
	// The analysis window is longer in seconds when the rate is lower, so the
	// early-detection bias grows by 22050 / rate.
	for (const sampleRate of [16000, 11025]) {
		test(`kick onsets stay within 3 ms of their attack at ${sampleRate} Hz`, () => {
			const truth = constantBeats({ bpm: 120, first: 0.3, until: 60 });
			const result = detectBeats({
				samples: synth({ seconds: 60, beatTimes: truth, sampleRate }),
				sampleRate,
			});
			if (!result.ok) throw new Error(result.reason);
			expect(
				Math.abs(score({ truth, found: result.beatsSec }).medianErrorMs),
			).toBeLessThanOrEqual(3);
		});
	}
});

describe("detectBeats rejects input without a beat", () => {
	test("digital silence is reported as silent", () => {
		expect(
			detectBeats({ samples: new Float32Array(SAMPLE_RATE * 30), sampleRate: SAMPLE_RATE }),
		).toEqual({ ok: false, reason: "silent" });
	});

	test("a signal below the audibility floor is silent", () => {
		const samples = new Float32Array(SAMPLE_RATE * 30).fill(5e-4);
		expect(detectBeats({ samples, sampleRate: SAMPLE_RATE })).toEqual({
			ok: false,
			reason: "silent",
		});
	});

	test("under 5 seconds is too short", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 3 });
		expect(
			detectBeats({
				samples: synth({ seconds: 3, beatTimes: truth }),
				sampleRate: SAMPLE_RATE,
			}),
		).toEqual({ ok: false, reason: "too-short" });
	});

	test("an empty buffer is too short", () => {
		expect(
			detectBeats({ samples: new Float32Array(0), sampleRate: SAMPLE_RATE }),
		).toEqual({ ok: false, reason: "too-short" });
	});

	test("white noise has no beat", () => {
		const random = rng(5);
		const samples = new Float32Array(SAMPLE_RATE * 60);
		for (let i = 0; i < samples.length; i++) samples[i] = random() * 0.3;
		expect(detectBeats({ samples, sampleRate: SAMPLE_RATE })).toEqual({
			ok: false,
			reason: "no-beat",
		});
	});

	test("a pad with no percussion has no beat", () => {
		expect(
			detectBeats({
				samples: synth({ seconds: 60, beatTimes: [] }),
				sampleRate: SAMPLE_RATE,
			}),
		).toEqual({ ok: false, reason: "no-beat" });
	});

	test("a buffer of NaN does not throw or claim a beat", () => {
		const samples = new Float32Array(SAMPLE_RATE * 10).fill(Number.NaN);
		const result = detectBeats({ samples, sampleRate: SAMPLE_RATE });
		expect(result.ok).toBe(false);
	});
});

describe("detectBeats input validation", () => {
	test.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		0,
		-22050,
		2999,
		768001,
	])("rejects the sample rate %p", (sampleRate) => {
		expect(() =>
			detectBeats({ samples: new Float32Array(1000), sampleRate }),
		).toThrow(RangeError);
	});

	test("accepts the lowest and highest supported sample rates", () => {
		for (const sampleRate of [3000, 768000]) {
			expect(
				detectBeats({ samples: new Float32Array(sampleRate * 6), sampleRate }),
			).toEqual({ ok: false, reason: "silent" });
		}
	});

	test("refuses more than an hour of audio without reading it", () => {
		const samples = new Float32Array(1);
		Object.defineProperty(samples, "length", { value: 3000 * 3601 });
		expect(detectBeats({ samples, sampleRate: 3000 })).toEqual({
			ok: false,
			reason: "too-long",
		});
	});

	test("refuses an absurd sample count even at a high sample rate", () => {
		const samples = new Float32Array(1);
		Object.defineProperty(samples, "length", { value: 2 ** 28 + 1 });
		expect(detectBeats({ samples, sampleRate: 768000 })).toEqual({
			ok: false,
			reason: "too-long",
		});
	});
});

describe("detectBeats contract", () => {
	test("beats are ascending seconds inside the buffer", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 60 });
		const result = detectBeats({
			samples: synth({ seconds: 60, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
		});
		if (!result.ok) throw new Error(result.reason);
		for (let i = 1; i < result.beatsSec.length; i++) {
			expect(result.beatsSec[i]).toBeGreaterThan(result.beatsSec[i - 1]);
		}
		expect(result.beatsSec[0]).toBeGreaterThanOrEqual(0);
		expect(result.beatsSec[result.beatsSec.length - 1]).toBeLessThanOrEqual(60);
	});

	test("does not modify the input samples", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 20 });
		const samples = synth({ seconds: 20, beatTimes: truth });
		const copy = samples.slice();
		detectBeats({ samples, sampleRate: SAMPLE_RATE });
		expect(samples).toEqual(copy);
	});

	test("reports progress in [0, 1], increasing, in many steps", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 30 });
		const seen: number[] = [];
		detectBeats({
			samples: synth({ seconds: 30, beatTimes: truth }),
			sampleRate: SAMPLE_RATE,
			onProgress: (fraction) => seen.push(fraction),
		});
		expect(seen.length).toBeGreaterThanOrEqual(20);
		expect(seen.length).toBeLessThanOrEqual(120);
		for (const fraction of seen) {
			expect(fraction).toBeGreaterThanOrEqual(0);
			expect(fraction).toBeLessThanOrEqual(1);
		}
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i]).toBeGreaterThan(seen[i - 1]);
		}
	});

	test("converts frames to seconds with the given sample rate", () => {
		const truth = constantBeats({ bpm: 120, first: 0.3, until: 40 });
		const result = detectBeats({
			samples: synth({ seconds: 40, beatTimes: truth, sampleRate: 16000 }),
			sampleRate: 16000,
		});
		expectAccurate({ truth, result });
	});
});

describe("detectBeats on a full-length track", () => {
	test("a 4 minute track at 128 BPM stays accurate (timing is logged, not asserted)", () => {
		const truth = constantBeats({ bpm: 128, first: 0.45, until: 240 });
		const samples = synth({ seconds: 240, beatTimes: truth });
		const start = performance.now();
		const result = detectBeats({ samples, sampleRate: SAMPLE_RATE });
		console.log(
			`detectBeats 4 min: ${(performance.now() - start).toFixed(0)} ms`,
		);
		expectAccurate({ truth, result });
	});
});
