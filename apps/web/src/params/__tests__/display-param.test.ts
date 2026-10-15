import { describe, expect, test } from "bun:test";
import { getDisplayParam, type NumberParamDefinition } from "@/params";

const base: NumberParamDefinition = {
	key: "test",
	label: "Test",
	type: "number",
	default: 0,
	min: 0,
	step: 0.1,
};

describe("getDisplayParam", () => {
	test("returns non-percent params unchanged", () => {
		const param = { ...base, max: 360, displayMultiplier: 100 };
		expect(getDisplayParam({ param })).toBe(param);
	});

	test("shows percent params as 0..100 in steps of 1", () => {
		const feather = getDisplayParam({
			param: { ...base, max: 1000, step: 1, unit: "percent" },
		});
		expect(feather.min).toBe(0);
		expect(feather.max).toBe(100);
		expect(feather.step).toBe(1);
		expect(feather.displayMultiplier).toBeCloseTo(0.1, 10);
	});

	test("converts a displayed value back to the stored value", () => {
		const feather = getDisplayParam({
			param: { ...base, max: 1000, step: 1, unit: "percent" },
		});
		expect(33 / (feather.displayMultiplier ?? 1)).toBe(330);
		expect(100 / (feather.displayMultiplier ?? 1)).toBe(1000);
	});

	test("overrides an explicit min and treats a missing max as 100", () => {
		const param = getDisplayParam({
			param: { ...base, min: 5, step: 1, unit: "percent" },
		});
		expect(param.min).toBe(0);
		expect(param.max).toBe(100);
		expect(param.displayMultiplier).toBe(1);
	});

	test("does not mutate the stored param", () => {
		const stored = { ...base, max: 1000, step: 1, unit: "percent" as const };
		getDisplayParam({ param: stored });
		expect(stored.max).toBe(1000);
		expect(stored.displayMultiplier).toBeUndefined();
	});
});
