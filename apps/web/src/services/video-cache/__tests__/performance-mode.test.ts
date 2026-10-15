import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PERFORMANCE_MODE,
	PERFORMANCE_MODE_OPTIONS,
	type PerformanceMode,
	decodeWorkerCount,
	mergePersistedPerformance,
	parsePerformanceMode,
} from "../performance-mode";

describe("parsePerformanceMode", () => {
	test("keeps the two modes and falls back to high (the default) for anything else", () => {
		expect(parsePerformanceMode("balanced")).toBe("balanced");
		expect(parsePerformanceMode("high")).toBe("high");
		for (const value of [undefined, null, "", "HIGH", "ultra", 1, {}, ["high"]]) {
			expect(parsePerformanceMode(value)).toBe("high");
		}
		expect(DEFAULT_PERFORMANCE_MODE).toBe("high");
	});
});

describe("mergePersistedPerformance", () => {
	const current: { mode: PerformanceMode; setMode: () => void } = {
		mode: "balanced",
		setMode: () => {},
	};

	test("takes a stored mode and keeps the store's actions", () => {
		const merged = mergePersistedPerformance({ persisted: { mode: "high" }, current });
		expect(merged.mode).toBe("high");
		expect(merged.setMode).toBe(current.setMode);
	});

	test("nothing stored, or something unreadable, is the default", () => {
		for (const persisted of [undefined, null, "high", 3, {}, { mode: "turbo" }, { mode: 1 }]) {
			expect(mergePersistedPerformance({ persisted, current }).mode).toBe("high");
		}
	});
});

describe("decodeWorkerCount", () => {
	test("balanced: one worker", () => {
		for (const hardwareConcurrency of [1, 2, 4, 12, 64]) {
			expect(decodeWorkerCount({ mode: "balanced", hardwareConcurrency })).toBe(1);
		}
	});

	test.each([
		[1, 1],
		[2, 1],
		[3, 1],
		[4, 2],
		[6, 4],
		// the owner's i5-1235U: 12 threads
		[12, 4],
		[64, 4],
	])("high with %i logical cores: %i (two left for the UI, at most 4)", (hardwareConcurrency, expected) => {
		expect(decodeWorkerCount({ mode: "high", hardwareConcurrency })).toBe(expected);
	});

	test("an unknown core count is one worker", () => {
		for (const hardwareConcurrency of [undefined, Number.NaN, 0, -4, Number.POSITIVE_INFINITY]) {
			expect(decodeWorkerCount({ mode: "high", hardwareConcurrency })).toBe(1);
		}
	});

	test("a fractional core count is rounded down", () => {
		expect(decodeWorkerCount({ mode: "high", hardwareConcurrency: 4.9 })).toBe(2);
	});
});

describe("PERFORMANCE_MODE_OPTIONS", () => {
	test("one option per mode, balanced first, each with a label and what it does", () => {
		expect(PERFORMANCE_MODE_OPTIONS.map((option) => option.mode)).toEqual(["balanced", "high"]);
		for (const option of PERFORMANCE_MODE_OPTIONS) {
			expect(option.label.length).toBeGreaterThan(0);
			expect(option.description.length).toBeGreaterThan(0);
		}
	});
});
