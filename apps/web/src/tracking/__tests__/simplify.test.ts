import { describe, expect, test } from "bun:test";
import { simplifySeries } from "@/tracking/simplify";

function interpolate({
	times,
	values,
	kept,
	at,
}: {
	times: number[];
	values: number[];
	kept: number[];
	at: number;
}): number {
	for (let k = 0; k < kept.length - 1; k++) {
		const lo = kept[k];
		const hi = kept[k + 1];
		if (at >= times[lo] && at <= times[hi]) {
			const f = (at - times[lo]) / (times[hi] - times[lo]);
			return values[lo] + (values[hi] - values[lo]) * f;
		}
	}
	throw new Error("time outside of kept range");
}

describe("simplifySeries", () => {
	const times = Array.from({ length: 120 }, (_, i) => i / 30);

	test("a straight line collapses to its two end points", () => {
		const values = times.map((t) => 3 + 7 * t);
		expect(simplifySeries({ times, values, epsilon: 0.01 })).toEqual([0, 119]);
	});

	test("a lone bump larger than epsilon is kept, one within it is not", () => {
		const flat = times.map(() => 5);
		const big = flat.map((v, i) => (i === 60 ? v + 0.6 : v));
		const small = flat.map((v, i) => (i === 60 ? v + 0.4 : v));
		expect(simplifySeries({ times, values: big, epsilon: 0.5 })).toContain(60);
		expect(simplifySeries({ times, values: small, epsilon: 0.5 })).toEqual([0, 119]);
	});

	test("long series do not overflow the stack", () => {
		const n = 200_000;
		const longTimes = new Float64Array(n);
		const longValues = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			longTimes[i] = i;
			longValues[i] = i * i * 1e-4;
		}
		const kept = simplifySeries({ times: longTimes, values: longValues, epsilon: 0.5 });
		expect(kept[0]).toBe(0);
		expect(kept[kept.length - 1]).toBe(n - 1);
	});

	test("every sample stays within epsilon of the simplified series", () => {
		const values = times.map((t) => 12 * Math.sin(t * 5) + 3 * Math.cos(t * 11));
		const epsilon = 0.2;
		const kept = simplifySeries({ times, values, epsilon });
		expect(kept.length).toBeGreaterThan(2);
		for (let i = 0; i < times.length; i++) {
			const at = interpolate({ times, values, kept, at: times[i] });
			expect(Math.abs(at - values[i])).toBeLessThanOrEqual(epsilon + 1e-9);
		}
	});

	test("relative mode measures the error as a share of the sample's size", () => {
		// the same absolute dip of 0.3 is a 30 percent error near 1 and 3 percent near 10
		const nearOne = times.map((_, i) => (i === 60 ? 0.7 : 1));
		const nearTen = times.map((_, i) => (i === 60 ? 9.7 : 10));
		expect(simplifySeries({ times, values: nearOne, epsilon: 0.1, relative: true })).toContain(60);
		expect(simplifySeries({ times, values: nearTen, epsilon: 0.1, relative: true })).toEqual([
			0, 119,
		]);
		expect(simplifySeries({ times, values: nearTen, epsilon: 0.1 })).toContain(60);
	});

	test("relative mode follows the sign of a mirrored scale", () => {
		const values = times.map((_, i) => (i === 60 ? -0.7 : -1));
		expect(simplifySeries({ times, values, epsilon: 0.1, relative: true })).toContain(60);
	});

	test("handles empty, single and two sample inputs", () => {
		expect(simplifySeries({ times: [], values: [], epsilon: 0.5 })).toEqual([]);
		expect(simplifySeries({ times: [1], values: [2], epsilon: 0.5 })).toEqual([0]);
		expect(simplifySeries({ times: [0, 1], values: [2, 8], epsilon: 0.5 })).toEqual([0, 1]);
	});

	test("end points are always kept and the indices ascend", () => {
		const t = Array.from({ length: 80 }, (_, i) => i);
		const values = t.map((i) => (i % 9) * 3);
		const kept = simplifySeries({ times: t, values, epsilon: 1 });
		expect(kept[0]).toBe(0);
		expect(kept[kept.length - 1]).toBe(79);
		for (let k = 1; k < kept.length; k++) expect(kept[k]).toBeGreaterThan(kept[k - 1]);
	});

	test("uneven times are interpolated in time, not in index", () => {
		// samples 0, 1, 10: a straight line in time, not in index
		const t = [0, 1, 10];
		const values = [0, 1, 10];
		expect(simplifySeries({ times: t, values, epsilon: 0.01 })).toEqual([0, 2]);
	});

	test("a pinned sample stays even on a straight line, the stretches either side are simplified on their own", () => {
		const values = times.map((t) => 3 + 7 * t);
		expect(simplifySeries({ times, values, epsilon: 0.01, pinned: [40] })).toEqual([0, 40, 119]);
		expect(simplifySeries({ times, values, epsilon: 0.01, pinned: [90, 30, 30] })).toEqual([0, 30, 90, 119]);
	});

	test("pinned samples outside the series, or the ends again, change nothing", () => {
		const values = times.map((t) => 3 + 7 * t);
		expect(simplifySeries({ times, values, epsilon: 0.01, pinned: [-1, 0, 119, 500, 2.5] })).toEqual([0, 119]);
	});

	test("without pinned samples the answer is what it was", () => {
		const values = times.map((t) => 12 * Math.sin(t * 5) + 3 * Math.cos(t * 11));
		expect(simplifySeries({ times, values, epsilon: 0.2, pinned: [] })).toEqual(
			simplifySeries({ times, values, epsilon: 0.2 }),
		);
	});

	test("every sample is still within epsilon with a pinned one in the middle", () => {
		const values = times.map((t) => 12 * Math.sin(t * 5) + 3 * Math.cos(t * 11));
		const kept = simplifySeries({ times, values, epsilon: 0.2, pinned: [57] });
		expect(kept).toContain(57);
		for (let i = 0; i < times.length; i++) {
			const at = interpolate({ times, values, kept, at: times[i] });
			expect(Math.abs(at - values[i])).toBeLessThanOrEqual(0.2 + 1e-9);
		}
	});
});
