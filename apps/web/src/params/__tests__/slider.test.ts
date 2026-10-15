import { describe, expect, test } from "bun:test";
import type { NumberParamDefinition } from "@/params";
import {
	dragPosition,
	getFillSpan,
	getKeyboardValue,
	isSliderKey,
	positionToValue,
	resolveSliderSpec,
	stepValue,
	valueToPosition,
	type NumberSliderSpec,
} from "@/params/slider";

const POSITION_X: NumberSliderSpec = { min: -1920, max: 1920 };
const SCALE: NumberSliderSpec = { min: 0.01, max: 5, pivot: 1 };
const VOLUME: NumberSliderSpec = { min: -60, max: 20 };
const OPACITY: NumberSliderSpec = { min: 0, max: 1 };

describe("valueToPosition", () => {
	test("maps a linear range onto 0..1", () => {
		expect(valueToPosition({ value: -1920, spec: POSITION_X })).toBe(0);
		expect(valueToPosition({ value: 0, spec: POSITION_X })).toBe(0.5);
		expect(valueToPosition({ value: 1920, spec: POSITION_X })).toBe(1);
	});

	test("clamps values outside the range and never returns NaN", () => {
		expect(valueToPosition({ value: 3000, spec: POSITION_X })).toBe(1);
		expect(valueToPosition({ value: -Infinity, spec: POSITION_X })).toBe(0);
		expect(valueToPosition({ value: Infinity, spec: POSITION_X })).toBe(1);
		expect(valueToPosition({ value: Number.NaN, spec: POSITION_X })).toBe(0);
	});

	test("returns 0 instead of dividing by zero when min equals max", () => {
		expect(valueToPosition({ value: 5, spec: { min: 5, max: 5 } })).toBe(0);
	});

	test("places the pivot at exactly the middle of the bar", () => {
		expect(valueToPosition({ value: 1, spec: SCALE })).toBe(0.5);
		expect(valueToPosition({ value: 0.01, spec: SCALE })).toBe(0);
		expect(valueToPosition({ value: 5, spec: SCALE })).toBe(1);
		expect(valueToPosition({ value: 3, spec: SCALE })).toBe(0.75);
	});

	test("ignores a pivot that is not strictly inside the range", () => {
		expect(
			valueToPosition({ value: 5, spec: { min: 0, max: 10, pivot: 20 } }),
		).toBe(0.5);
		expect(
			valueToPosition({ value: 5, spec: { min: 0, max: 10, pivot: 0 } }),
		).toBe(0.5);
		expect(
			valueToPosition({ value: 5, spec: { min: 0, max: 10, pivot: 10 } }),
		).toBe(0.5);
	});
});

describe("positionToValue", () => {
	test("round-trips values on the step grid, linear and pivoted", () => {
		for (const value of [-1920, -1, 0, 1, 1000, 1920]) {
			const position = valueToPosition({ value, spec: POSITION_X });
			expect(positionToValue({ position, spec: POSITION_X, step: 1 })).toBe(
				value,
			);
		}
		for (const value of [0.01, 0.5, 1, 2.5, 5]) {
			const position = valueToPosition({ value, spec: SCALE });
			expect(positionToValue({ position, spec: SCALE, step: 0.01 })).toBe(
				value,
			);
		}
	});

	test("maps the middle position to exactly the pivot", () => {
		expect(positionToValue({ position: 0.5, spec: SCALE, step: 0.01 })).toBe(1);
	});

	test("clamps positions outside 0..1 and treats NaN as the start", () => {
		expect(positionToValue({ position: 2, spec: POSITION_X, step: 1 })).toBe(
			1920,
		);
		expect(positionToValue({ position: -1, spec: POSITION_X, step: 1 })).toBe(
			-1920,
		);
		expect(
			positionToValue({ position: Number.NaN, spec: POSITION_X, step: 1 }),
		).toBe(-1920);
	});

	test("snaps to the step and removes floating point noise", () => {
		expect(
			positionToValue({ position: 0.123456, spec: OPACITY, step: 0.01 }),
		).toBe(0.12);
		expect(
			positionToValue({ position: 0.1 + 0.2, spec: OPACITY, step: 0.01 }),
		).toBe(0.3);
	});

	test("never exceeds the bar range when the max is not a multiple of the step", () => {
		expect(
			positionToValue({ position: 1, spec: { min: 0, max: 10.5 }, step: 1 }),
		).toBe(10.5);
	});
});

describe("getFillSpan", () => {
	test("fills from zero when the range crosses zero", () => {
		const negative = getFillSpan({ value: -10, spec: VOLUME });
		expect(negative.start).toBe(0.625);
		expect(negative.end).toBe(0.75);
		const positive = getFillSpan({ value: 10, spec: VOLUME });
		expect(positive.start).toBe(0.75);
		expect(positive.end).toBe(0.875);
	});

	test("fills from the bar minimum when zero is not strictly inside the range", () => {
		expect(getFillSpan({ value: 0.25, spec: OPACITY })).toEqual({
			start: 0,
			end: 0.25,
		});
		expect(getFillSpan({ value: 15, spec: { min: 5, max: 105 } })).toEqual({
			start: 0,
			end: 0.1,
		});
	});

	test("fills from the end nearest zero when the range ends at zero", () => {
		const span = getFillSpan({ value: -10, spec: { min: -60, max: 0 } });
		expect(span.start).toBeCloseTo(50 / 60, 10);
		expect(span.end).toBe(1);
	});

	test("clamps a value outside the range to the bar ends", () => {
		expect(getFillSpan({ value: 9999, spec: OPACITY })).toEqual({
			start: 0,
			end: 1,
		});
		expect(getFillSpan({ value: 9999, spec: VOLUME })).toEqual({
			start: 0.75,
			end: 1,
		});
	});
});

describe("stepValue", () => {
	test("moves by one step, or ten when coarse", () => {
		const base = { value: 5, step: 1, spec: POSITION_X };
		expect(stepValue({ ...base, direction: 1, coarse: false })).toBe(6);
		expect(stepValue({ ...base, direction: -1, coarse: false })).toBe(4);
		expect(stepValue({ ...base, direction: 1, coarse: true })).toBe(15);
	});

	test("removes floating point noise", () => {
		expect(
			stepValue({
				value: 0.29,
				direction: 1,
				coarse: false,
				step: 0.01,
				spec: OPACITY,
			}),
		).toBe(0.3);
		expect(
			stepValue({
				value: 0.07,
				direction: 1,
				coarse: false,
				step: 0.01,
				spec: OPACITY,
			}),
		).toBe(0.08);
	});

	test("stays at the hard min and max", () => {
		expect(
			stepValue({
				value: 1,
				direction: 1,
				coarse: true,
				step: 0.01,
				spec: OPACITY,
			}),
		).toBe(1);
		expect(
			stepValue({
				value: 0,
				direction: -1,
				coarse: false,
				step: 0.01,
				spec: OPACITY,
			}),
		).toBe(0);
		expect(
			stepValue({
				value: 0.95,
				direction: 1,
				coarse: true,
				step: 0.01,
				spec: OPACITY,
			}),
		).toBe(1);
	});

	test("does not move against the key direction when the value is outside the bar", () => {
		const base = { value: 3000, step: 1, coarse: false, spec: POSITION_X };
		expect(stepValue({ ...base, direction: 1 })).toBe(3000);
		expect(stepValue({ ...base, direction: -1 })).toBe(2999);
	});
});

describe("stepValue below the bar", () => {
	test("does not move against the key direction when the value is below the bar", () => {
		const base = { value: -3000, step: 1, coarse: false, spec: POSITION_X };
		expect(stepValue({ ...base, direction: -1 })).toBe(-3000);
		expect(stepValue({ ...base, direction: 1 })).toBe(-2999);
	});
});

describe("getKeyboardValue", () => {
	const base = { shiftKey: false, value: 500, step: 1, spec: POSITION_X };
	const unit = 38;

	test("arrows step by max(step, range / 100) and Shift makes it ten times larger", () => {
		expect(getKeyboardValue({ ...base, key: "ArrowRight" })).toBe(500 + unit);
		expect(getKeyboardValue({ ...base, key: "ArrowUp" })).toBe(500 + unit);
		expect(getKeyboardValue({ ...base, key: "ArrowLeft" })).toBe(500 - unit);
		expect(getKeyboardValue({ ...base, key: "ArrowDown" })).toBe(500 - unit);
		expect(
			getKeyboardValue({ ...base, key: "ArrowRight", shiftKey: true }),
		).toBe(500 + unit * 10);
	});

	test("PageUp and PageDown always take the large step", () => {
		expect(getKeyboardValue({ ...base, key: "PageUp" })).toBe(500 + unit * 10);
		expect(getKeyboardValue({ ...base, key: "PageDown" })).toBe(
			500 - unit * 10,
		);
	});

	test("Home and End go to the bar ends", () => {
		expect(getKeyboardValue({ ...base, key: "Home" })).toBe(-1920);
		expect(getKeyboardValue({ ...base, key: "End" })).toBe(1920);
	});

	test("keeps the plain step when the range is small", () => {
		const opacity = { shiftKey: false, value: 0.5, step: 0.01, spec: OPACITY };
		expect(getKeyboardValue({ ...opacity, key: "ArrowRight" })).toBe(0.51);
		const volume = { shiftKey: false, value: 0, step: 0.01, spec: VOLUME };
		expect(getKeyboardValue({ ...volume, key: "ArrowRight" })).toBe(0.8);
	});

	test("returns null for keys the bar does not own", () => {
		expect(getKeyboardValue({ ...base, key: "a" })).toBeNull();
		expect(getKeyboardValue({ ...base, key: "Escape" })).toBeNull();
		expect(getKeyboardValue({ ...base, key: "Shift" })).toBeNull();
	});
});

describe("isSliderKey", () => {
	test("is true for the keys a focused slider handles itself", () => {
		for (const key of [
			"ArrowLeft",
			"ArrowRight",
			"ArrowUp",
			"ArrowDown",
			"Home",
			"End",
			"PageUp",
			"PageDown",
		]) {
			expect(isSliderKey({ key })).toBe(true);
		}
	});

	test("is false for everything else, including Escape and Space", () => {
		for (const key of ["Escape", " ", "Enter", "a", "Shift", "Delete"]) {
			expect(isSliderKey({ key })).toBe(false);
		}
	});
});

describe("dragPosition", () => {
	test("moves by the pointer delta relative to the track width", () => {
		const base = { startPosition: 0.5, trackPx: 100, fine: false };
		expect(dragPosition({ ...base, deltaPx: 25 })).toBe(0.75);
		expect(dragPosition({ ...base, deltaPx: -25 })).toBe(0.25);
	});

	test("clamps to 0..1", () => {
		const base = { startPosition: 0.5, trackPx: 100, fine: false };
		expect(dragPosition({ ...base, deltaPx: 500 })).toBe(1);
		expect(dragPosition({ ...base, deltaPx: -1000 })).toBe(0);
	});

	test("fine mode moves at a tenth of the speed", () => {
		expect(
			dragPosition({
				startPosition: 0.5,
				deltaPx: 25,
				trackPx: 100,
				fine: true,
			}),
		).toBeCloseTo(0.525, 10);
	});

	test("keeps the start position for an empty track instead of returning NaN", () => {
		expect(
			dragPosition({
				startPosition: 0.4,
				deltaPx: 25,
				trackPx: 0,
				fine: false,
			}),
		).toBe(0.4);
	});

	test("rebasing on a Shift toggle does not jump", () => {
		const coarse = dragPosition({
			startPosition: 0.2,
			deltaPx: 40,
			trackPx: 100,
			fine: false,
		});
		expect(coarse).toBeCloseTo(0.6, 10);
		expect(
			dragPosition({
				startPosition: coarse,
				deltaPx: 0,
				trackPx: 100,
				fine: true,
			}),
		).toBe(coarse);
		expect(
			dragPosition({
				startPosition: coarse,
				deltaPx: 10,
				trackPx: 100,
				fine: true,
			}),
		).toBeCloseTo(0.61, 10);
	});
});

describe("resolveSliderSpec", () => {
	const base: NumberParamDefinition = {
		key: "test",
		label: "Test",
		type: "number",
		default: 0,
		min: -360,
		step: 1,
	};

	test("returns null when there is no max and no explicit slider", () => {
		expect(resolveSliderSpec({ param: base })).toBeNull();
	});

	test("derives the bar from min and max", () => {
		expect(resolveSliderSpec({ param: { ...base, max: 360 } })).toEqual({
			min: -360,
			max: 360,
		});
	});

	test("an explicit slider overrides the derived range, even without a max", () => {
		const slider = { min: -1920, max: 1920 };
		expect(resolveSliderSpec({ param: { ...base, slider } })).toEqual(slider);
		expect(resolveSliderSpec({ param: { ...base, max: 360, slider } })).toEqual(
			slider,
		);
	});

	test("keeps the pivot of an explicit slider", () => {
		const slider = { min: 0.01, max: 5, pivot: 1 };
		expect(resolveSliderSpec({ param: { ...base, slider } })).toEqual(slider);
	});

	test("slider: false opts out", () => {
		expect(
			resolveSliderSpec({ param: { ...base, max: 360, slider: false } }),
		).toBeNull();
	});
});
