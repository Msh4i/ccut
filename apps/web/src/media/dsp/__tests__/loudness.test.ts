import { describe, expect, test } from "bun:test";
import {
	defaultChannelRoles,
	kWeightingCoefficients,
	measureLoudness,
	normalizationGainDb,
	type Biquad,
} from "../loudness";
import { concat, sine, silence } from "./signals";

/** |H(e^jw)|^2 of one biquad, straight from its coefficients. */
function powerResponse({ filter, frequency, sampleRate }: { filter: Biquad; frequency: number; sampleRate: number }) {
	const w = (2 * Math.PI * frequency) / sampleRate;
	// |c0 + c1 e^-jw + c2 e^-2jw|^2
	const magnitude2 = ([c0, c1, c2]: [number, number, number]) =>
		(c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w)) ** 2 + (c1 * Math.sin(w) + c2 * Math.sin(2 * w)) ** 2;
	return magnitude2([filter.b0, filter.b1, filter.b2]) / magnitude2([1, filter.a1, filter.a2]);
}

function kWeightingPower({ frequency, sampleRate }: { frequency: number; sampleRate: number }) {
	const { preFilter, rlb } = kWeightingCoefficients({ sampleRate });
	return (
		powerResponse({ filter: preFilter, frequency, sampleRate }) *
		powerResponse({ filter: rlb, frequency, sampleRate })
	);
}

/**
 * Expected integrated loudness of steady sines, derived from BS.1770-4 eq. (2)
 * (L = -0.691 + 10 log10 sum G_i z_i) with z_i = A^2/2 |H(f)|^2. Independent of
 * the block and gating code under test.
 */
function expectedSineLoudness({
	amplitudes,
	weights,
	frequency,
	sampleRate,
}: {
	amplitudes: number[];
	weights: number[];
	frequency: number;
	sampleRate: number;
}) {
	const h2 = kWeightingPower({ frequency, sampleRate });
	const sum = amplitudes.reduce((acc, amplitude, i) => acc + weights[i] * ((amplitude * amplitude) / 2) * h2, 0);
	return -0.691 + 10 * Math.log10(sum);
}

describe("kWeightingCoefficients", () => {
	test("at 48 kHz they equal the tables of BS.1770-4 Annex 1 (Table 1 pre-filter, Table 2 RLB)", () => {
		const { preFilter, rlb } = kWeightingCoefficients({ sampleRate: 48_000 });
		const tolerance = 1e-7;
		expect(Math.abs(preFilter.a1 - -1.69065929318241)).toBeLessThan(tolerance);
		expect(Math.abs(preFilter.a2 - 0.73248077421585)).toBeLessThan(tolerance);
		expect(Math.abs(preFilter.b0 - 1.53512485958697)).toBeLessThan(tolerance);
		expect(Math.abs(preFilter.b1 - -2.69169618940638)).toBeLessThan(tolerance);
		expect(Math.abs(preFilter.b2 - 1.19839281085285)).toBeLessThan(tolerance);
		expect(Math.abs(rlb.a1 - -1.99004745483398)).toBeLessThan(tolerance);
		expect(Math.abs(rlb.a2 - 0.99007225036621)).toBeLessThan(tolerance);
		expect([rlb.b0, rlb.b1, rlb.b2]).toEqual([1, -2, 1]);
	});

	test("are computed for any rate: the response at audio frequencies barely depends on it", () => {
		for (const frequency of [50, 100, 1000, 4000, 10_000]) {
			const reference = 10 * Math.log10(kWeightingPower({ frequency, sampleRate: 48_000 }));
			for (const sampleRate of [32_000, 44_100, 88_200, 96_000, 192_000]) {
				const db = 10 * Math.log10(kWeightingPower({ frequency, sampleRate }));
				// Only the bilinear transform's frequency warping is left.
				expect(Math.abs(db - reference)).toBeLessThan(0.01);
			}
		}
	});

	test("shape: about +0.69 dB at 1 kHz (the -0.691 constant cancels it), ~+4 dB shelf, low cut", () => {
		const at = (frequency: number) => 10 * Math.log10(kWeightingPower({ frequency, sampleRate: 48_000 }));
		expect(Math.abs(at(1000) - 0.691)).toBeLessThan(0.01);
		expect(at(10_000)).toBeGreaterThan(3.5);
		expect(at(10_000)).toBeLessThan(4.5);
		expect(at(20)).toBeLessThan(-10);
	});

	test("rejects a bad sample rate", () => {
		expect(() => kWeightingCoefficients({ sampleRate: 0 })).toThrow(RangeError);
		expect(() => kWeightingCoefficients({ sampleRate: Number.NaN })).toThrow(RangeError);
	});
});

describe("measureLoudness", () => {
	test("a steady sine measures what eq. (2) predicts from the filter response, at several rates", () => {
		for (const sampleRate of [44_100, 48_000, 96_000]) {
			for (const frequency of [100, 997, 5000]) {
				const amplitude = 10 ** (-20 / 20);
				const tone = sine({ frequency, amplitude, seconds: 3, sampleRate });
				const result = measureLoudness({ channels: [tone, tone], sampleRate });
				const expected = expectedSineLoudness({
					amplitudes: [amplitude, amplitude],
					weights: [1, 1],
					frequency,
					sampleRate,
				});
				expect(Math.abs(result.integratedLufs - expected)).toBeLessThan(0.05);
			}
		}
	});

	test("stereo 997 Hz sine at -23 dBFS peak per channel reads -23.0 LUFS (+-0.1)", () => {
		// EBU Tech 3341 test case 1 / BS.1770-4: a 0 dBFS 1 kHz sine in one front
		// channel reads -3.01 LKFS, so both channels add 3.01 dB.
		const sampleRate = 48_000;
		const tone = sine({ frequency: 997, amplitude: 10 ** (-23 / 20), seconds: 20, sampleRate });
		const result = measureLoudness({ channels: [tone, tone], sampleRate });
		expect(Math.abs(result.integratedLufs - -23)).toBeLessThan(0.1);
	});

	test("a 0 dBFS 1 kHz sine in one channel reads -3.01 LKFS (+-0.02)", () => {
		const sampleRate = 48_000;
		const tone = sine({ frequency: 1000, amplitude: 1, seconds: 2, sampleRate });
		expect(Math.abs(measureLoudness({ channels: [tone], sampleRate }).integratedLufs - -3.01)).toBeLessThan(0.02);
	});

	test("relative gate: a long quiet tail does not pull the loud part down", () => {
		const sampleRate = 48_000;
		const loud = sine({ frequency: 1000, amplitude: 0.1, seconds: 10, sampleRate });
		// -63 LKFS: above the absolute gate, so only the relative gate removes it.
		const quiet = sine({ frequency: 1000, amplitude: 0.001, seconds: 50, sampleRate });
		const loudAlone = measureLoudness({ channels: [loud], sampleRate }).integratedLufs;
		const result = measureLoudness({ channels: [concat([loud, quiet])], sampleRate });
		// Without the relative gate the plain average would be about 7.8 dB lower.
		// Kept: the 97 loud blocks and the 3 edge blocks holding 3/4, 2/4, 1/4 of
		// it (the quiet part adds ~1e-4 of the loud power each, negligible).
		expect(result.gatedBlockCount).toBe(100);
		expect(Math.abs(result.integratedLufs - (loudAlone + 10 * Math.log10(98.5 / 100)))).toBeLessThan(0.005);
	});

	test("relative gate keeps a part that is less than 10 LU below", () => {
		const sampleRate = 48_000;
		const a = sine({ frequency: 1000, amplitude: 0.1, seconds: 10, sampleRate });
		const b = sine({ frequency: 1000, amplitude: 0.1 * 10 ** (-6 / 20), seconds: 10, sampleRate });
		const loudness = measureLoudness({ channels: [concat([a, b])], sampleRate });
		// Both halves are kept: the result is the power average of the two levels.
		const la = measureLoudness({ channels: [a], sampleRate }).integratedLufs;
		const expected = 10 * Math.log10((10 ** (la / 10) + 10 ** ((la - 6) / 10)) / 2);
		expect(Math.abs(loudness.integratedLufs - expected)).toBeLessThan(0.1);
	});

	test("absolute gate: digital silence and anything under -70 LUFS is ignored", () => {
		const sampleRate = 48_000;
		const tone = sine({ frequency: 1000, amplitude: 0.1, seconds: 5, sampleRate });
		const alone = measureLoudness({ channels: [tone], sampleRate }).integratedLufs;
		const withSilence = measureLoudness({
			channels: [concat([silence({ seconds: 30, sampleRate }), tone, silence({ seconds: 30, sampleRate })])],
			sampleRate,
		});
		// The 47 blocks inside the tone pass, plus 3 blocks at each edge that hold
		// 1/4, 2/4 and 3/4 of tone (all above the relative gate); the silent
		// blocks fail the absolute gate. Mean power = (47 + 2 * 1.5) / 53 of the tone's.
		expect(withSilence.gatedBlockCount).toBe(53);
		expect(Math.abs(withSilence.integratedLufs - (alone + 10 * Math.log10(50 / 53)))).toBeLessThan(0.005);

		const veryQuiet = sine({ frequency: 1000, amplitude: 10 ** (-75 / 20), seconds: 5, sampleRate });
		expect(measureLoudness({ channels: [veryQuiet], sampleRate }).integratedLufs).toBe(Number.NEGATIVE_INFINITY);
		expect(
			measureLoudness({ channels: [silence({ seconds: 2, sampleRate })], sampleRate }).integratedLufs,
		).toBe(Number.NEGATIVE_INFINITY);
	});

	test("shorter than one 400 ms block: no loudness, but the peak is measured", () => {
		const sampleRate = 48_000;
		const tone = sine({ frequency: 1000, amplitude: 0.5, seconds: 0.39, sampleRate });
		const result = measureLoudness({ channels: [tone], sampleRate });
		expect(result.integratedLufs).toBe(Number.NEGATIVE_INFINITY);
		expect(result.blockCount).toBe(0);
		expect(result.samplePeak).toBeCloseTo(0.5, 3);
	});

	test("block count follows 400 ms blocks with 75% overlap", () => {
		const sampleRate = 48_000;
		const tone = sine({ frequency: 1000, amplitude: 0.5, seconds: 1, sampleRate });
		// Blocks start every 100 ms: 0.0 .. 0.6 s -> 7 blocks.
		expect(measureLoudness({ channels: [tone], sampleRate }).blockCount).toBe(7);
	});

	test("channel weights: surrounds count 1.41, LFE is ignored", () => {
		const sampleRate = 48_000;
		const tone = sine({ frequency: 1000, amplitude: 0.1, seconds: 2, sampleRate });
		const zero = new Float32Array(tone.length);
		// 5.1 in WAV order: L R C LFE Ls Rs.
		const at = (index: number) =>
			measureLoudness({
				channels: Array.from({ length: 6 }, (_, i) => (i === index ? tone : zero)),
				sampleRate,
			}).integratedLufs;
		const left = at(0);
		expect(Math.abs(at(1) - left)).toBeLessThan(1e-9);
		expect(Math.abs(at(2) - left)).toBeLessThan(1e-9);
		expect(Math.abs(at(4) - left - 10 * Math.log10(1.41))).toBeLessThan(1e-9);
		expect(Math.abs(at(5) - left - 10 * Math.log10(1.41))).toBeLessThan(1e-9);
		expect(at(3)).toBe(Number.NEGATIVE_INFINITY);
	});

	test("an explicit layout overrides the default roles", () => {
		const sampleRate = 48_000;
		const tone = sine({ frequency: 1000, amplitude: 0.1, seconds: 2, sampleRate });
		const asLeft = measureLoudness({ channels: [tone], sampleRate, roles: ["L"] }).integratedLufs;
		const asSurround = measureLoudness({ channels: [tone], sampleRate, roles: ["Ls"] }).integratedLufs;
		expect(Math.abs(asSurround - asLeft - 10 * Math.log10(1.41))).toBeLessThan(1e-9);
	});

	test("sample peak is the largest absolute sample of any channel", () => {
		const sampleRate = 48_000;
		const a = new Float32Array(48_000);
		const b = new Float32Array(48_000);
		a[100] = 0.25;
		b[200] = -0.5;
		const result = measureLoudness({ channels: [a, b], sampleRate });
		expect(result.samplePeak).toBe(0.5);
		expect(result.samplePeakDb).toBeCloseTo(-6.0206, 4);
		expect(measureLoudness({ channels: [new Float32Array(10)], sampleRate }).samplePeakDb).toBe(
			Number.NEGATIVE_INFINITY,
		);
	});

	test("rejects mismatched channels and unknown layouts", () => {
		expect(() =>
			measureLoudness({ channels: [new Float32Array(10), new Float32Array(11)], sampleRate: 48_000 }),
		).toThrow(RangeError);
		expect(() => measureLoudness({ channels: [], sampleRate: 48_000 })).toThrow(RangeError);
		expect(() => defaultChannelRoles({ count: 7 })).toThrow(RangeError);
		expect(() =>
			measureLoudness({ channels: [new Float32Array(10)], sampleRate: 48_000, roles: ["L", "R"] }),
		).toThrow(RangeError);
	});

	test.skipIf(!process.env.PERF)("PERF: 10 minutes of stereo 48 kHz", () => {
		const sampleRate = 48_000;
		const seconds = 600;
		const left = new Float32Array(sampleRate * seconds);
		const right = new Float32Array(sampleRate * seconds);
		for (let i = 0; i < left.length; i++) {
			left[i] = 0.1 * Math.sin(i * 0.0654);
			right[i] = 0.1 * Math.sin(i * 0.0321);
		}
		const runs: number[] = [];
		for (let run = 0; run < 3; run++) {
			const t0 = performance.now();
			measureLoudness({ channels: [left, right], sampleRate });
			runs.push(performance.now() - t0);
		}
		console.log(`PERF loudness 10 min stereo 48 kHz: ${runs.map((ms) => ms.toFixed(0)).join(" / ")} ms`);
	});
});

describe("normalizationGainDb", () => {
	const base = { targetLufs: -14, ceilingDb: -1, maxBoostDb: 12 };

	test("plain gain when nothing limits it", () => {
		expect(normalizationGainDb({ ...base, measuredLufs: -20, peakDb: -10 })).toEqual({
			gainDb: 6,
			wantedGainDb: 6,
			cutByCeiling: false,
			cutByBoostLimit: false,
			silent: false,
		});
	});

	test("attenuation is never limited by the boost limit", () => {
		const result = normalizationGainDb({ ...base, measuredLufs: -5, peakDb: -0.1 });
		expect(result.gainDb).toBe(-9);
		expect(result.cutByBoostLimit).toBe(false);
		expect(result.cutByCeiling).toBe(false);
	});

	test("the peak ceiling cuts the gain and says so", () => {
		const result = normalizationGainDb({ ...base, measuredLufs: -20, peakDb: -4 });
		expect(result.gainDb).toBe(3);
		expect(result.wantedGainDb).toBe(6);
		expect(result.cutByCeiling).toBe(true);
		expect(result.cutByBoostLimit).toBe(false);
	});

	test("the boost limit cuts the gain and says so", () => {
		const result = normalizationGainDb({ ...base, measuredLufs: -40, peakDb: -30 });
		expect(result.gainDb).toBe(12);
		expect(result.cutByBoostLimit).toBe(true);
		expect(result.cutByCeiling).toBe(false);
	});

	test("when both limit, the smaller wins and both are reported only if both bind", () => {
		const both = normalizationGainDb({ ...base, measuredLufs: -40, peakDb: -13 });
		expect(both.gainDb).toBe(12);
		expect(both.cutByBoostLimit).toBe(true);
		expect(both.cutByCeiling).toBe(true);
		const ceilingOnly = normalizationGainDb({ ...base, measuredLufs: -40, peakDb: -5 });
		expect(ceilingOnly.gainDb).toBe(4);
		expect(ceilingOnly.cutByCeiling).toBe(true);
		expect(ceilingOnly.cutByBoostLimit).toBe(false);
	});

	test("a ceiling above the boost limit is not reported as cutting", () => {
		// Wanted +26, boost limit 12, ceiling room 15: only the boost limit binds.
		const result = normalizationGainDb({ ...base, measuredLufs: -40, peakDb: -16 });
		expect(result.gainDb).toBe(12);
		expect(result.cutByBoostLimit).toBe(true);
		expect(result.cutByCeiling).toBe(false);
	});

	test("a peak already over the ceiling turns a wanted boost into a cut", () => {
		const result = normalizationGainDb({ ...base, measuredLufs: -16, peakDb: 0 });
		expect(result.gainDb).toBe(-1);
		expect(result.cutByCeiling).toBe(true);
	});

	test("silence (or nothing above the gates) gets no gain", () => {
		const result = normalizationGainDb({
			...base,
			measuredLufs: Number.NEGATIVE_INFINITY,
			peakDb: Number.NEGATIVE_INFINITY,
		});
		expect(result).toEqual({
			gainDb: 0,
			wantedGainDb: 0,
			cutByCeiling: false,
			cutByBoostLimit: false,
			silent: true,
		});
	});

	test("rejects non-finite targets and limits", () => {
		expect(() => normalizationGainDb({ ...base, targetLufs: Number.NaN, measuredLufs: -20, peakDb: -3 })).toThrow(
			RangeError,
		);
		expect(() => normalizationGainDb({ ...base, maxBoostDb: -1, measuredLufs: -20, peakDb: -3 })).toThrow(
			RangeError,
		);
		expect(() => normalizationGainDb({ ...base, measuredLufs: Number.NaN, peakDb: -3 })).toThrow(RangeError);
	});
});
