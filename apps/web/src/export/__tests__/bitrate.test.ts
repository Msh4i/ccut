import { describe, expect, test } from "bun:test";
import {
	AUDIO_BITRATE_CHOICES,
	CALIBRATION,
	CUSTOM_MBPS_LIMITS,
	computeVideoBitrate,
	defaultAudioBitrate,
	estimateFileBytes,
} from "../bitrate";

const MBPS = 1_000_000;

function within({ actual, expected, fraction }: { actual: number; expected: number; fraction: number }) {
	expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(fraction);
}

describe("CALIBRATION", () => {
	test("is one object, marked UNCALIBRATED until measured on real encodes", () => {
		expect(CALIBRATION.status).toBe("UNCALIBRATED");
		expect(Object.isFrozen(CALIBRATION)).toBe(true);
	});
});

describe("computeVideoBitrate", () => {
	const high = { kind: "preset", quality: "high" } as const;

	test("formula W*H*30*bpp*(fps/30)^0.75 reproduces the plan's H.264 'high' examples (+-1%)", () => {
		within({ actual: computeVideoBitrate({ width: 1920, height: 1080, fps: 30, quality: high, codec: "avc" }), expected: 8.1 * MBPS, fraction: 0.01 });
		within({ actual: computeVideoBitrate({ width: 1920, height: 1080, fps: 60, quality: high, codec: "avc" }), expected: 13.6 * MBPS, fraction: 0.01 });
		within({ actual: computeVideoBitrate({ width: 3840, height: 2160, fps: 30, quality: high, codec: "avc" }), expected: 32.3 * MBPS, fraction: 0.01 });
		within({ actual: computeVideoBitrate({ width: 3840, height: 2160, fps: 60, quality: high, codec: "avc" }), expected: 54.4 * MBPS, fraction: 0.01 });
	});

	test("grows with pixels linearly and with fps sub-linearly", () => {
		const at = ([width, height, fps]: [number, number, number]) =>
			computeVideoBitrate({ width, height, fps, quality: high, codec: "avc" });
		expect(at([3840, 2160, 30]) / at([1920, 1080, 30])).toBeCloseTo(4, 6);
		expect(at([1920, 1080, 60]) / at([1920, 1080, 30])).toBeCloseTo(2 ** CALIBRATION.fpsExponent, 6);
		expect(at([1920, 1080, 60])).toBeLessThan(2 * at([1920, 1080, 30]));
		expect(at([1920, 1080, 24])).toBeLessThan(at([1920, 1080, 30]));
	});

	test("quality presets are ordered and VP9 takes the VP9 factor", () => {
		const of = ({ quality, codec = "avc" }: { quality: "low" | "medium" | "high" | "very_high"; codec?: "avc" | "vp9" }) =>
			computeVideoBitrate({ width: 1920, height: 1080, fps: 30, quality: { kind: "preset", quality }, codec });
		expect(of({ quality: "low" })).toBeLessThan(of({ quality: "medium" }));
		expect(of({ quality: "medium" })).toBeLessThan(of({ quality: "high" }));
		expect(of({ quality: "high" })).toBeLessThan(of({ quality: "very_high" }));
		expect(of({ quality: "high", codec: "vp9" }) / of({ quality: "high" })).toBeCloseTo(CALIBRATION.vp9Factor, 6);
	});

	test("custom Mb/s is used as it is (the same for both codecs)", () => {
		const custom = { kind: "custom", mbps: 12.5 } as const;
		expect(computeVideoBitrate({ width: 1920, height: 1080, fps: 30, quality: custom, codec: "avc" })).toBe(12_500_000);
		expect(computeVideoBitrate({ width: 1920, height: 1080, fps: 30, quality: custom, codec: "vp9" })).toBe(12_500_000);
	});

	test("returns whole bits per second", () => {
		const bitrate = computeVideoBitrate({ width: 1081, height: 607, fps: 29.97, quality: high, codec: "avc" });
		expect(Number.isInteger(bitrate)).toBe(true);
	});

	test("rejects sizes, fps and custom values it cannot use", () => {
		expect(() => computeVideoBitrate({ width: 0, height: 1080, fps: 30, quality: high, codec: "avc" })).toThrow(RangeError);
		expect(() => computeVideoBitrate({ width: 1920, height: 1080, fps: -1, quality: high, codec: "avc" })).toThrow(RangeError);
		expect(() =>
			computeVideoBitrate({ width: 1920, height: 1080, fps: 30, quality: { kind: "custom", mbps: Number.NaN }, codec: "avc" }),
		).toThrow(RangeError);
	});

	test("custom limits: 0.5 Mb/s up to the H.264 level 5.2 High maximum", () => {
		expect(CUSTOM_MBPS_LIMITS.min).toBe(0.5);
		expect(CUSTOM_MBPS_LIMITS.max).toBe(300);
	});
});

describe("audio bitrates", () => {
	test("the plan's choices and defaults", () => {
		expect(AUDIO_BITRATE_CHOICES.aac).toEqual([128_000, 192_000, 256_000, 320_000]);
		expect(AUDIO_BITRATE_CHOICES.opus).toEqual([96_000, 128_000, 160_000]);
		expect(defaultAudioBitrate({ codec: "aac" })).toBe(192_000);
		expect(defaultAudioBitrate({ codec: "opus" })).toBe(128_000);
	});
});

describe("estimateFileBytes", () => {
	test("(video + audio bitrate) x duration / 8, with the uncalibrated error band", () => {
		const estimate = estimateFileBytes({ videoBitrate: 8_000_000, audioBitrate: 192_000, durationSeconds: 60 });
		const expected = ((8_000_000 + 192_000) * 60) / 8 * (1 + CALIBRATION.containerOverheadFraction);
		expect(estimate.bytes).toBe(Math.round(expected));
		expect(estimate.low).toBe(Math.round(expected * (1 - CALIBRATION.sizeEstimateErrorFraction)));
		expect(estimate.high).toBe(Math.round(expected * (1 + CALIBRATION.sizeEstimateErrorFraction)));
		expect(estimate.low).toBeLessThan(estimate.bytes);
		expect(estimate.high).toBeGreaterThan(estimate.bytes);
	});

	test("no audio counts as zero, zero duration is zero bytes", () => {
		const withoutAudio = estimateFileBytes({ videoBitrate: 8_000_000, audioBitrate: null, durationSeconds: 10 });
		const withAudio = estimateFileBytes({ videoBitrate: 8_000_000, audioBitrate: 128_000, durationSeconds: 10 });
		expect(withoutAudio.bytes).toBeLessThan(withAudio.bytes);
		expect(estimateFileBytes({ videoBitrate: 8_000_000, audioBitrate: null, durationSeconds: 0 }).bytes).toBe(0);
	});

	test("is linear in duration and monotonic in bitrate", () => {
		const one = estimateFileBytes({ videoBitrate: 5_000_000, audioBitrate: 128_000, durationSeconds: 30 }).bytes;
		const two = estimateFileBytes({ videoBitrate: 5_000_000, audioBitrate: 128_000, durationSeconds: 60 }).bytes;
		expect(Math.abs(two - 2 * one)).toBeLessThanOrEqual(1);
		expect(estimateFileBytes({ videoBitrate: 6_000_000, audioBitrate: 128_000, durationSeconds: 30 }).bytes).toBeGreaterThan(one);
	});

	test("rejects negative or non-finite input", () => {
		expect(() => estimateFileBytes({ videoBitrate: -1, audioBitrate: null, durationSeconds: 1 })).toThrow(RangeError);
		expect(() => estimateFileBytes({ videoBitrate: 1, audioBitrate: null, durationSeconds: Number.POSITIVE_INFINITY })).toThrow(
			RangeError,
		);
	});
});
