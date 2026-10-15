import type { NumberParamDefinition } from "@/params";
import { clamp, snapToStep } from "@/utils/math";

/** Bar range in the same (display) space as the param's min/max/step. */
export interface NumberSliderSpec {
	min: number;
	max: number;
	/** Value shown at the middle of the bar (e.g. scale 1). Ignored unless strictly inside min..max. */
	pivot?: number;
}

const COARSE_STEP_COUNT = 10;
const FINE_DRAG_FACTOR = 0.1;
const KEYBOARD_STEPS_PER_RANGE = 100;

const KEY_DIRECTIONS: ReadonlyMap<string, 1 | -1> = new Map([
	["ArrowRight", 1],
	["ArrowUp", 1],
	["PageUp", 1],
	["ArrowLeft", -1],
	["ArrowDown", -1],
	["PageDown", -1],
]);

export function resolveSliderSpec({
	param,
}: {
	param: NumberParamDefinition;
}): NumberSliderSpec | null {
	if (param.slider === false) return null;
	if (param.slider) return param.slider;
	return param.max === undefined ? null : { min: param.min, max: param.max };
}

function getPivot({ spec }: { spec: NumberSliderSpec }): number | null {
	const { min, max, pivot } = spec;
	return pivot !== undefined && pivot > min && pivot < max ? pivot : null;
}

function toUnit({ value }: { value: number }): number {
	return Number.isNaN(value) ? 0 : clamp({ value, min: 0, max: 1 });
}

export function valueToPosition({
	value,
	spec,
}: {
	value: number;
	spec: NumberSliderSpec;
}): number {
	const { min, max } = spec;
	if (!(max > min)) return 0;
	const clamped = Number.isNaN(value) ? min : clamp({ value, min, max });
	const pivot = getPivot({ spec });
	if (pivot === null) return (clamped - min) / (max - min);
	return clamped <= pivot
		? (clamped - min) / (pivot - min) / 2
		: 0.5 + (clamped - pivot) / (max - pivot) / 2;
}

export function positionToValue({
	position,
	spec,
	step,
}: {
	position: number;
	spec: NumberSliderSpec;
	step: number;
}): number {
	const { min, max } = spec;
	const unit = toUnit({ value: position });
	const pivot = getPivot({ spec });
	const raw =
		pivot === null
			? min + unit * (max - min)
			: unit <= 0.5
				? min + unit * 2 * (pivot - min)
				: pivot + (unit - 0.5) * 2 * (max - pivot);
	return clamp({ value: snapToStep({ value: raw, step }), min, max });
}

/** Filled part of the bar as 0..1 positions, starting from the end of the range nearest zero. */
export function getFillSpan({
	value,
	spec,
}: {
	value: number;
	spec: NumberSliderSpec;
}): { start: number; end: number } {
	const origin = valueToPosition({
		value: clamp({ value: 0, min: spec.min, max: spec.max }),
		spec,
	});
	const position = valueToPosition({ value, spec });
	return { start: Math.min(origin, position), end: Math.max(origin, position) };
}

/** Moves by `unit` (default: one `step`) and lands on the `step` grid. */
export function stepValue({
	value,
	direction,
	coarse,
	step,
	unit = step,
	spec,
}: {
	value: number;
	direction: 1 | -1;
	coarse: boolean;
	step: number;
	unit?: number;
	spec: NumberSliderSpec;
}): number {
	const next = snapToStep({
		value: value + direction * unit * (coarse ? COARSE_STEP_COUNT : 1),
		step,
	});
	// A stored value outside the bar must not jump against the key direction.
	return clamp({
		value: next,
		min: Math.min(spec.min, value),
		max: Math.max(spec.max, value),
	});
}

export function dragPosition({
	startPosition,
	deltaPx,
	trackPx,
	fine,
}: {
	startPosition: number;
	deltaPx: number;
	trackPx: number;
	fine: boolean;
}): number {
	if (trackPx <= 0) return startPosition;
	const factor = fine ? FINE_DRAG_FACTOR : 1;
	return toUnit({ value: startPosition + (deltaPx / trackPx) * factor });
}

/** Keys a focused bar handles itself; global shortcuts must not also act on them. */
export function isSliderKey({ key }: { key: string }): boolean {
	return KEY_DIRECTIONS.has(key) || key === "Home" || key === "End";
}

/** Value after a key press, or null when the key is not a slider key. */
export function getKeyboardValue({
	key,
	shiftKey,
	value,
	step,
	spec,
}: {
	key: string;
	shiftKey: boolean;
	value: number;
	step: number;
	spec: NumberSliderSpec;
}): number | null {
	const direction = KEY_DIRECTIONS.get(key);
	if (direction) {
		// A tiny step on a huge range would need thousands of presses.
		const unit = Math.max(
			step,
			snapToStep({
				value: (spec.max - spec.min) / KEYBOARD_STEPS_PER_RANGE,
				step,
			}),
		);
		return stepValue({
			value,
			direction,
			coarse: shiftKey || key.startsWith("Page"),
			step,
			unit,
			spec,
		});
	}
	if (key === "Home") return spec.min;
	if (key === "End") return spec.max;
	return null;
}
