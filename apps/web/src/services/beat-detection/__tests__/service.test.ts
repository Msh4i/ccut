import { describe, expect, test } from "bun:test";
import { beatDetectionService } from "../service";
import { constantBeats, SAMPLE_RATE, score, synth } from "./synthetic-music";

function clickTrack(seconds: number): Float32Array {
	return synth({
		seconds,
		beatTimes: constantBeats({ bpm: 120, first: 0.3, until: seconds }),
	});
}

describe("beatDetectionService.detect", () => {
	test("resolves with the beats found in the worker", async () => {
		const result = await beatDetectionService.detect({
			samples: clickTrack(20),
			sampleRate: SAMPLE_RATE,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(Math.abs(result.bpm - 120)).toBeLessThan(1);
		expect(result.beatsSec.length).toBeGreaterThan(30);
		expect(Math.abs(result.beatsSec[0] - 0.3)).toBeLessThan(0.05);
	});

	test("detectHits finds hits in no regular pattern, without a tempo", async () => {
		// Gaps of 0.5, 0.25 and 0.125 s in no steady order: no grid fits.
		const gaps = [0.5, 0.5, 0.25, 0.125, 0.125, 0.5, 0.25, 0.25, 0.125, 0.125, 0.125];
		const truth: number[] = [];
		let t = 0.3;
		for (let i = 0; truth.length < 40; i++) {
			truth.push(t);
			t += gaps[i % gaps.length];
		}
		const result = await beatDetectionService.detectHits({
			samples: synth({ seconds: t + 0.5, beatTimes: truth, hats: false }),
			sampleRate: SAMPLE_RATE,
		});
		if (!result.ok) throw new Error(result.reason);
		expect("bpm" in result).toBe(false);
		expect(score({ truth, found: result.beatsSec }).recall).toBeGreaterThanOrEqual(0.95);
	});

	test("detectHits passes the band on to the worker", async () => {
		const gaps = [0.5, 0.5, 0.25, 0.125, 0.125, 0.5, 0.25, 0.25, 0.125, 0.125, 0.125];
		const kicks: number[] = [];
		let t = 0.3;
		for (let i = 0; kicks.length < 30; i++) {
			kicks.push(t);
			t += gaps[i % gaps.length];
		}
		const make = () => synth({ seconds: t + 0.5, beatTimes: kicks, hats: false, pad: false, noiseDb: -50 });
		const low = await beatDetectionService.detectHits({ samples: make(), sampleRate: SAMPLE_RATE, band: "low" });
		const high = await beatDetectionService.detectHits({ samples: make(), sampleRate: SAMPLE_RATE, band: "high" });
		if (!low.ok) throw new Error(low.reason);
		expect(score({ truth: kicks, found: low.beatsSec }).recall).toBeGreaterThanOrEqual(0.9);
		// Kicks have almost nothing above 2 kHz: the same audio, another band, another answer.
		expect(high.ok ? score({ truth: kicks, found: high.beatsSec }).recall : 0).toBeLessThan(0.2);
	});

	test("resolves a rejection reason without throwing", async () => {
		const result = await beatDetectionService.detect({
			samples: new Float32Array(SAMPLE_RATE * 10),
			sampleRate: SAMPLE_RATE,
		});
		expect(result).toEqual({ ok: false, reason: "silent" });
	});

	test("reports progress while the worker runs", async () => {
		const seen: number[] = [];
		await beatDetectionService.detect({
			samples: clickTrack(20),
			sampleRate: SAMPLE_RATE,
			onProgress: (fraction) => seen.push(fraction),
		});
		expect(seen.length).toBeGreaterThan(5);
		for (const fraction of seen) {
			expect(fraction).toBeGreaterThanOrEqual(0);
			expect(fraction).toBeLessThanOrEqual(1);
		}
	});

	test("transfers the samples to the worker instead of copying them", async () => {
		const samples = clickTrack(10);
		const pending = beatDetectionService.detect({
			samples,
			sampleRate: SAMPLE_RATE,
		});
		expect(samples.length).toBe(0);
		await pending;
	});

	test("rejects with an AbortError when cancelled mid-run", async () => {
		const controller = new AbortController();
		const pending = beatDetectionService.detect({
			samples: clickTrack(120),
			sampleRate: SAMPLE_RATE,
			signal: controller.signal,
			onProgress: () => controller.abort(),
		});
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	test("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const samples = clickTrack(10);
		await expect(
			beatDetectionService.detect({
				samples,
				sampleRate: SAMPLE_RATE,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		// Nothing was handed to a worker.
		expect(samples.length).toBeGreaterThan(0);
	});

	test("gives up and rejects when the worker runs past the time limit", async () => {
		const progress: number[] = [];
		await expect(
			beatDetectionService.detect({
				samples: clickTrack(60),
				sampleRate: SAMPLE_RATE,
				timeoutMs: 1,
				onProgress: (fraction) => progress.push(fraction),
			}),
		).rejects.toThrow("Beat detection timed out");
		// The worker was terminated: nothing keeps reporting afterwards.
		const seen = progress.length;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(progress.length).toBe(seen);
	});

	test("a finished job does not trip its own time limit later", async () => {
		const result = await beatDetectionService.detect({
			samples: new Float32Array(SAMPLE_RATE * 10),
			sampleRate: SAMPLE_RATE,
			timeoutMs: 100,
		});
		expect(result).toEqual({ ok: false, reason: "silent" });
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	test("rejects when the worker throws on a bad sample rate", async () => {
		await expect(
			beatDetectionService.detect({
				samples: new Float32Array(100),
				sampleRate: 12,
			}),
		).rejects.toThrow();
	});

	test("runs two jobs independently", async () => {
		const [a, b] = await Promise.all([
			beatDetectionService.detect({
				samples: clickTrack(15),
				sampleRate: SAMPLE_RATE,
			}),
			beatDetectionService.detect({
				samples: new Float32Array(SAMPLE_RATE * 10),
				sampleRate: SAMPLE_RATE,
			}),
		]);
		expect(a.ok).toBe(true);
		expect(b).toEqual({ ok: false, reason: "silent" });
	});
});
