import { describe, expect, test } from "bun:test";
import { tukeyCutoff } from "../robust";

const BASE = { window: 1.5, minCount: 3, sMin: 0.12, sMax: 0.6, cFac: 4.685 };

function cutoff({
	values,
	overrides = {},
}: {
	values: number[];
	overrides?: Partial<typeof BASE>;
}) {
	const residuals = Float64Array.from(values);
	return tukeyCutoff({
		residuals,
		n: residuals.length,
		scratch: new Float64Array(residuals.length),
		...BASE,
		...overrides,
	});
}

describe("tukeyCutoff", () => {
	test("is cFac times the median residual converted to a deviation", () => {
		// ten residuals, upper median 0.31, sigma = 0.31 / 1.1774
		const values = [0.1, 0.15, 0.2, 0.25, 0.3, 0.31, 0.35, 0.4, 0.45, 0.5];
		expect(cutoff({ values })).toBeCloseTo((4.685 * 0.31) / 1.1774, 9);
	});

	test("never trusts a scale below sMin or above sMax", () => {
		expect(cutoff({ values: [0.001, 0.002, 0.003, 0.004] })).toBeCloseTo(4.685 * 0.12, 9);
		expect(cutoff({ values: [1.2, 1.3, 1.4, 1.45] })).toBeCloseTo(4.685 * 0.6, 9);
	});

	test("looks only at residuals inside the window", () => {
		const near = [0.2, 0.2, 0.2];
		expect(cutoff({ values: [...near, 5, 9, 300, 1e9] })).toBeCloseTo(cutoff({ values: near }), 12);
	});

	test("says so when too few residuals are inside the window", () => {
		expect(cutoff({ values: [0.2, 0.2, 7, 8] })).toBe(-1);
		expect(cutoff({ values: [0.2, 0.2, 7, 8], overrides: { minCount: 2 } })).toBeGreaterThan(0);
		expect(cutoff({ values: [] })).toBe(-1);
	});

	test("leaves the residuals it was given untouched", () => {
		const residuals = Float64Array.from([0.9, 0.1, 0.5, 0.3]);
		tukeyCutoff({ residuals, n: 4, scratch: new Float64Array(4), ...BASE });
		expect(Array.from(residuals)).toEqual([0.9, 0.1, 0.5, 0.3]);
	});

	test("only the first n residuals count", () => {
		const residuals = Float64Array.from([0.2, 0.2, 0.2, 0.2, 1.4, 1.4, 1.4]);
		const four = tukeyCutoff({ residuals, n: 4, scratch: new Float64Array(7), ...BASE });
		expect(four).toBeCloseTo(cutoff({ values: [0.2, 0.2, 0.2, 0.2] }), 12);
	});
});
