import { describe, expect, test } from "bun:test";
import { sampleCount, sourceTimes } from "@/tracking/sample-times";

describe("sampleCount", () => {
	test("counts the frames from the start to the end of the clip", () => {
		expect(sampleCount({ clipStartSec: 0, clipDurationSec: 3, fps: 30 })).toBe(
			90,
		);
		expect(sampleCount({ clipStartSec: 1, clipDurationSec: 3, fps: 30 })).toBe(
			60,
		);
	});

	test("includes a last partial frame but never a frame at or past the end", () => {
		// Frames at 0, 1/30, ..., the one at 1.0 s is past a clip that ends at 1.0 s.
		expect(sampleCount({ clipStartSec: 0, clipDurationSec: 1, fps: 30 })).toBe(
			30,
		);
		expect(
			sampleCount({ clipStartSec: 0, clipDurationSec: 1.01, fps: 30 }),
		).toBe(31);
	});

	test("is zero when the start is at or beyond the end", () => {
		expect(sampleCount({ clipStartSec: 3, clipDurationSec: 3, fps: 30 })).toBe(
			0,
		);
		expect(sampleCount({ clipStartSec: 4, clipDurationSec: 3, fps: 30 })).toBe(
			0,
		);
	});

	test("handles fractional frame rates", () => {
		expect(
			sampleCount({
				clipStartSec: 0,
				clipDurationSec: 10,
				fps: 30_000 / 1_001,
			}),
		).toBe(300);
	});
});

describe("sourceTimes", () => {
	test("steps one frame at a time from the trimmed clip start", () => {
		const times = sourceTimes({
			clipStartSec: 0.5,
			count: 4,
			fps: 10,
			trimStartSec: 2,
		});
		expect(times).toHaveLength(4);
		[2.5, 2.6, 2.7, 2.8].forEach((expected, i) => {
			expect(times[i]).toBeCloseTo(expected, 9);
		});
	});

	test("a retimed clip advances through the source faster", () => {
		const times = sourceTimes({
			clipStartSec: 1,
			count: 3,
			fps: 10,
			trimStartSec: 0,
			retime: { rate: 2 },
		});
		[2, 2.2, 2.4].forEach((expected, i) => {
			expect(times[i]).toBeCloseTo(expected, 9);
		});
	});

	test("a slowed clip advances through the source slower", () => {
		const times = sourceTimes({
			clipStartSec: 0,
			count: 3,
			fps: 10,
			trimStartSec: 1,
			retime: { rate: 0.5 },
		});
		[1, 1.05, 1.1].forEach((expected, i) => {
			expect(times[i]).toBeCloseTo(expected, 9);
		});
	});

	test("times ascend, which the decoder needs to read each packet once", () => {
		const times = sourceTimes({
			clipStartSec: 0,
			count: 500,
			fps: 29.97,
			trimStartSec: 12.3,
			retime: { rate: 1.37 },
		});
		for (let i = 1; i < times.length; i++) {
			expect(times[i]).toBeGreaterThan(times[i - 1]);
		}
	});

	test("an empty count gives no times", () => {
		expect(
			sourceTimes({ clipStartSec: 0, count: 0, fps: 30, trimStartSec: 0 }),
		).toEqual([]);
	});
});
