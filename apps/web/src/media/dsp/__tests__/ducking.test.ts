import { describe, expect, test } from "bun:test";
import {
	applyEnvelope,
	createDuckingEnvelope,
	mergeVoiceRanges,
	sampleEnvelope,
	type DuckingParams,
} from "../ducking";

const PARAMS: DuckingParams = { amountDb: 12, attackMs: 100, holdMs: 200, releaseMs: 400 };

describe("mergeVoiceRanges", () => {
	test("sorts, drops zero-length ranges, merges overlapping and adjacent ones", () => {
		expect(
			mergeVoiceRanges({
				ranges: [
					{ start: 5, end: 6 },
					{ start: 1, end: 2 },
					{ start: 3, end: 3 },
					{ start: 2, end: 2.5 },
					{ start: 1.5, end: 1.8 },
				],
				params: { ...PARAMS, holdMs: 0, attackMs: 0 },
			}),
		).toEqual([
			{ start: 1, end: 2.5 },
			{ start: 5, end: 6 },
		]);
	});

	test("bridges a gap the hold and the next attack cover, keeps a longer one", () => {
		// The next attack starts at 2.3 - 0.1 = 2.2 <= 2 + 0.2: still fully ducked.
		expect(
			mergeVoiceRanges({ ranges: [{ start: 1, end: 2 }, { start: 2.3, end: 3 }], params: PARAMS }),
		).toEqual([{ start: 1, end: 3 }]);
		expect(
			mergeVoiceRanges({ ranges: [{ start: 1, end: 2 }, { start: 2.31, end: 3 }], params: PARAMS }),
		).toHaveLength(2);
	});

	test("rejects inverted or non-finite ranges and bad parameters", () => {
		expect(() => mergeVoiceRanges({ ranges: [{ start: 2, end: 1 }], params: PARAMS })).toThrow(RangeError);
		expect(() => mergeVoiceRanges({ ranges: [{ start: Number.NaN, end: 1 }], params: PARAMS })).toThrow(
			RangeError,
		);
		expect(() => createDuckingEnvelope({ voiceRanges: [], params: { ...PARAMS, amountDb: -3 } })).toThrow(
			RangeError,
		);
		expect(() => createDuckingEnvelope({ voiceRanges: [], params: { ...PARAMS, releaseMs: Number.NaN } })).toThrow(
			RangeError,
		);
	});
});

describe("createDuckingEnvelope", () => {
	const envelope = createDuckingEnvelope({ voiceRanges: [{ start: 2, end: 3 }], params: PARAMS });

	test("trapezoid in dB: attack before the voice, hold after it, then release", () => {
		expect(envelope.gainDbAt(0)).toBe(0);
		expect(envelope.gainDbAt(1.9)).toBe(0);
		expect(envelope.gainDbAt(1.95)).toBeCloseTo(-6, 9);
		expect(envelope.gainDbAt(2)).toBe(-12);
		expect(envelope.gainDbAt(2.5)).toBe(-12);
		expect(envelope.gainDbAt(3.1)).toBe(-12);
		expect(envelope.gainDbAt(3.2)).toBe(-12);
		expect(envelope.gainDbAt(3.4)).toBeCloseTo(-6, 9);
		expect(envelope.gainDbAt(3.6)).toBeCloseTo(0, 9);
		expect(envelope.gainDbAt(100)).toBe(0);
	});

	test("ramps are linear in dB, and the linear gain is 10^(dB/20)", () => {
		const a = envelope.gainDbAt(1.925);
		const b = envelope.gainDbAt(1.95);
		const c = envelope.gainDbAt(1.975);
		expect(b - a).toBeCloseTo(c - b, 9);
		expect(envelope.gainAt(2.5)).toBeCloseTo(10 ** (-12 / 20), 12);
		expect(envelope.gainAt(0)).toBe(1);
	});

	test("a voice at the very start is fully ducked at t = 0, one at the end holds to the end", () => {
		const edges = createDuckingEnvelope({
			voiceRanges: [
				{ start: 0, end: 1 },
				{ start: 9, end: 10 },
			],
			params: PARAMS,
		});
		expect(edges.gainDbAt(0)).toBe(-12);
		expect(edges.gainDbAt(10)).toBe(-12);
		// A voice starting 50 ms in is already half ducked at t = 0.
		const early = createDuckingEnvelope({ voiceRanges: [{ start: 0.05, end: 1 }], params: PARAMS });
		expect(early.gainDbAt(0)).toBeCloseTo(-6, 9);
	});

	test("zero attack / release are steps; zero-length voices duck nothing", () => {
		const steps = createDuckingEnvelope({
			voiceRanges: [{ start: 1, end: 2 }],
			params: { amountDb: 6, attackMs: 0, holdMs: 0, releaseMs: 0 },
		});
		expect(steps.gainDbAt(0.9999)).toBe(0);
		expect(steps.gainDbAt(1)).toBe(-6);
		expect(steps.gainDbAt(2)).toBe(-6);
		expect(steps.gainDbAt(2.0001)).toBe(0);
		const none = createDuckingEnvelope({ voiceRanges: [{ start: 1, end: 1 }], params: PARAMS });
		expect(none.gainDbAt(1)).toBe(0);
		expect(none.ranges).toEqual([]);
	});

	test("close voices that are not merged never duck less than either alone (deepest wins)", () => {
		const params = { amountDb: 10, attackMs: 300, holdMs: 0, releaseMs: 300 };
		const both = createDuckingEnvelope({
			voiceRanges: [
				{ start: 1, end: 2 },
				{ start: 2.4, end: 3 },
			],
			params,
		});
		expect(both.ranges).toHaveLength(2);
		const first = createDuckingEnvelope({ voiceRanges: [{ start: 1, end: 2 }], params });
		const second = createDuckingEnvelope({ voiceRanges: [{ start: 2.4, end: 3 }], params });
		for (let i = 0; i <= 40; i++) {
			const t = i * 0.1;
			expect(both.gainDbAt(t)).toBeCloseTo(Math.min(first.gainDbAt(t), second.gainDbAt(t)), 12);
		}
		// Between them it comes back only part of the way: at 2.25 s the first is
		// 5/6 released (weight 1/6), the second half attacked (weight 1/2).
		expect(both.gainDbAt(2.25)).toBeCloseTo(-5, 9);
	});

	test("a zero amount is a flat envelope", () => {
		const flat = createDuckingEnvelope({
			voiceRanges: [{ start: 1, end: 2 }],
			params: { ...PARAMS, amountDb: 0 },
		});
		expect(flat.gainAt(1.5)).toBe(1);
	});
});

describe("sampleEnvelope / applyEnvelope", () => {
	test("samples gainAt at i / sampleRate over the duration", () => {
		const envelope = createDuckingEnvelope({ voiceRanges: [{ start: 0.5, end: 0.6 }], params: PARAMS });
		const sampled = sampleEnvelope({ envelope, sampleRate: 1000, duration: 1.5 });
		expect(sampled.length).toBe(1500);
		for (const i of [0, 399, 400, 450, 500, 700, 800, 1000, 1200, 1499]) {
			expect(sampled[i]).toBeCloseTo(envelope.gainAt(i / 1000), 6);
		}
		expect(sampleEnvelope({ envelope, sampleRate: 1000, duration: 0 }).length).toBe(0);
		expect(() => sampleEnvelope({ envelope, sampleRate: 0, duration: 1 })).toThrow(RangeError);
	});

	test("multiplies every channel and leaves the input untouched", () => {
		const left = new Float32Array([1, 1, 1, 1]);
		const right = new Float32Array([0.5, -0.5, 0.5, -0.5]);
		const gain = new Float32Array([1, 0.5, 0.25, 0]);
		const [outLeft, outRight] = applyEnvelope({ channels: [left, right], envelope: gain });
		expect(Array.from(outLeft)).toEqual([1, 0.5, 0.25, 0]);
		expect(Array.from(outRight)).toEqual([0.5, -0.25, 0.125, -0]);
		expect(Array.from(left)).toEqual([1, 1, 1, 1]);
	});

	test("an envelope shorter than the audio is an error, not a silent cut", () => {
		expect(() =>
			applyEnvelope({ channels: [new Float32Array(5)], envelope: new Float32Array(4) }),
		).toThrow(RangeError);
	});
});
