import { getChannel, setChannel } from "@/animation/keyframes";
import { isScalarChannel } from "@/animation/interpolation";
import { getSegmentEasingPatch } from "@/animation/segment-easing";
import type {
	ElementAnimations,
	ScalarAnimationKey,
} from "@/animation/types";
import { generateUUID } from "@/utils/id";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import { MIN_KEYFRAME_PRESET_SECONDS } from "./definitions";
import type {
	KeyframePresetDefinition,
	KeyframePresetInput,
	KeyframePresetPlacement,
	KeyframePresetRange,
	PathLimits,
	PresetKeyPlan,
} from "./types";

/**
 * Where a preset sits on a clip. The requested length is cut to the clip, and
 * the range is moved (never shortened) to stay inside it. Returns null when the
 * clip is shorter than the smallest range a preset can have.
 */
export function resolveKeyframePresetRange({
	placement,
	playheadLocal,
	clipDuration,
	requestedDuration,
}: {
	placement: KeyframePresetPlacement;
	/** The playhead in ticks from the clip's start; may lie outside the clip. */
	playheadLocal: number;
	clipDuration: number;
	requestedDuration: number;
}): KeyframePresetRange | null {
	const minimum = Math.round(MIN_KEYFRAME_PRESET_SECONDS * TICKS_PER_SECOND);
	const length = Math.min(Math.round(requestedDuration), clipDuration);
	if (!(length >= minimum)) {
		return null;
	}
	const latestStart = clipDuration - length;
	const start =
		placement === "start"
			? 0
			: placement === "end"
				? latestStart
				: Math.min(latestStart, Math.max(0, Math.round(playheadLocal)));
	return { start, end: start + length };
}

function clampToLimits({
	value,
	limits,
}: {
	value: number;
	limits: PathLimits | undefined;
}): number {
	let result = value;
	if (limits?.min !== undefined) result = Math.max(limits.min, result);
	if (limits?.max !== undefined) result = Math.min(limits.max, result);
	return result;
}

/**
 * The keys of one path: times in ticks inside `range`, values held to
 * `limits`, each segment shaped as its plan says. Two plan keys that land on
 * the same tick collapse into the later one.
 */
export function buildPresetKeys({
	plan,
	range,
	limits,
}: {
	plan: readonly PresetKeyPlan[];
	range: KeyframePresetRange;
	limits?: PathLimits;
}): ScalarAnimationKey[] {
	const length = range.end - range.start;
	const byTick = new Map<number, PresetKeyPlan & { value: number }>();
	for (const entry of plan) {
		const tick = range.start + Math.round(entry.at * length);
		byTick.set(tick, {
			...entry,
			value: clampToLimits({ value: entry.value, limits }),
		});
	}
	const ticks = [...byTick.keys()].sort((a, b) => a - b);
	const keys: ScalarAnimationKey[] = ticks.map((tick) => {
		const entry = byTick.get(tick);
		return {
			id: generateUUID(),
			time: roundMediaTime({ time: tick }),
			value: entry?.value ?? 0,
			segmentToNext: "linear",
			tangentMode: "flat",
		};
	});
	for (let index = 0; index < keys.length - 1; index++) {
		const entry = byTick.get(ticks[index]);
		const patch = getSegmentEasingPatch({
			leftKey: keys[index],
			rightKey: keys[index + 1],
			easing: entry?.easing ?? "linear",
		});
		if (!patch) {
			continue;
		}
		keys[index] = {
			...keys[index],
			segmentToNext: patch.segmentToNext,
			rightHandle: patch.rightHandle ?? undefined,
			tangentMode: patch.rightHandle ? "broken" : keys[index].tangentMode,
		};
		keys[index + 1] = {
			...keys[index + 1],
			leftHandle: patch.nextLeftHandle ?? undefined,
			tangentMode: patch.nextLeftHandle ? "broken" : keys[index + 1].tangentMode,
		};
	}
	return keys;
}

/**
 * Writes a preset into an element's animations. Per path the preset writes,
 * the keys inside the range (both ends included) are replaced and the keys
 * outside it stay as they were. Other paths and the channel's extrapolation are
 * untouched. Values keep their decimals (`setChannel`, not the whole-pixel
 * single-key path).
 */
export function applyKeyframePresetToAnimations({
	animations,
	definition,
	range,
	canvas,
	base,
	limits,
}: {
	animations: ElementAnimations | undefined;
	definition: KeyframePresetDefinition;
	range: KeyframePresetRange;
	canvas: KeyframePresetInput["canvas"];
	base: KeyframePresetInput["base"];
	limits: Readonly<Record<string, PathLimits | undefined>>;
}): ElementAnimations | undefined {
	if (!(range.end > range.start)) {
		throw new RangeError("keyframe preset: the range ends before it starts");
	}
	const plan = definition.plan({
		base,
		canvas,
		seconds: (range.end - range.start) / TICKS_PER_SECOND,
	});
	let next = animations;
	for (const path of definition.paths) {
		const planned = plan[path];
		if (!planned || planned.length === 0) {
			throw new Error(`keyframe preset "${definition.id}": no keys for ${path}`);
		}
		const existing = getChannel({ animations: next, propertyPath: path });
		const existingScalar =
			existing && isScalarChannel(existing) ? existing : undefined;
		const outside = (existingScalar?.keys ?? []).filter(
			(key) => key.time < range.start || key.time > range.end,
		);
		const keys = [
			...outside,
			...buildPresetKeys({ plan: planned, range, limits: limits[path] }),
		];
		next = setChannel({
			animations: next,
			propertyPath: path,
			channel: existingScalar?.extrapolation
				? { keys, extrapolation: existingScalar.extrapolation }
				: { keys },
		});
	}
	return next;
}
