import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { Transform } from "@/rendering";
import { clamp } from "@/utils/math";
import { TICKS_PER_SECOND, roundMediaTime } from "@/wasm";
import { MIN_PRESET_SECONDS, getPresetDefinition } from "./definitions";
import type {
	PresetAnimation,
	PresetAnimations,
	PresetBounds,
	PresetContext,
	PresetDelta,
	PresetPhase,
	PresetReveal,
} from "./types";

function requestedDuration(animation: PresetAnimation | undefined): number {
	if (!animation || !getPresetDefinition(animation.id)) return 0;
	return Number.isFinite(animation.duration) && animation.duration > 0
		? animation.duration
		: 0;
}

/**
 * The lengths the two phases actually get on a clip of `duration`. They are
 * used as requested when they fit; otherwise both shrink by the same factor so
 * they exactly fill the clip and never overlap. Stored values are not touched,
 * so lengthening the clip brings the requested lengths back.
 */
export function getEffectiveDurations({
	presetAnimations,
	duration,
}: {
	presetAnimations: PresetAnimations | undefined;
	duration: number;
}): { in: number; out: number } {
	const clip = Number.isFinite(duration) && duration > 0 ? duration : 0;
	const requestedIn = requestedDuration(presetAnimations?.in);
	const requestedOut = requestedDuration(presetAnimations?.out);
	const total = requestedIn + requestedOut;
	if (total <= clip) return { in: requestedIn, out: requestedOut };

	const effectiveIn = clip * (requestedIn / total);
	return { in: effectiveIn, out: clip - effectiveIn };
}

/** Bounds, in ticks, for one phase's duration field. */
export function getPresetRoom({
	presetAnimations,
	phase,
	duration,
}: {
	presetAnimations: PresetAnimations | undefined;
	phase: PresetPhase;
	duration: number;
}): { min: number; max: number } {
	const effective = getEffectiveDurations({ presetAnimations, duration });
	const other = phase === "in" ? effective.out : effective.in;
	const min = Math.round(MIN_PRESET_SECONDS * TICKS_PER_SECOND);
	return { min, max: Math.max(min, duration - other) };
}

/**
 * `presetAnimations` with one phase set (or cleared). When the stored phases do
 * not fit the clip, the panel shows them squeezed; an edit writes the OTHER
 * phase at that shown length, so editing one box never moves the other and the
 * room for the edited one stays put. Nothing is rewritten while they fit, so
 * lengthening an untouched clip still restores the requested lengths.
 */
export function setPresetPhase({
	presetAnimations,
	phase,
	animation,
	duration,
}: {
	presetAnimations: PresetAnimations | undefined;
	phase: PresetPhase;
	animation: PresetAnimation | undefined;
	duration: number;
}): PresetAnimations | undefined {
	const otherPhase = phase === "in" ? "out" : "in";
	const other = presetAnimations?.[otherPhase];
	const effective = getEffectiveDurations({ presetAnimations, duration });
	const requestedTotal =
		requestedDuration(presetAnimations?.in) +
		requestedDuration(presetAnimations?.out);
	const isSqueezed = effective.in + effective.out < requestedTotal;
	const keptOther =
		other && isSqueezed && getPresetDefinition(other.id)
			? { ...other, duration: roundMediaTime({ time: effective[otherPhase] }) }
			: other;

	const nextIn = phase === "in" ? animation : keptOther;
	const nextOut = phase === "out" ? animation : keptOther;
	if (!nextIn && !nextOut) return undefined;
	return {
		...(nextIn && { in: nextIn }),
		...(nextOut && { out: nextOut }),
	};
}

/**
 * The progress (0..1) a phase's preset is evaluated at, `localTime` into a
 * clip of `duration` whose phase lasts `length`. In runs forward from the clip
 * start. Out is In played backwards: it is measured from the end of the clip
 * (rather than 1 - progress), which keeps the two bit-for-bit mirrors of each
 * other. The renderer and the Animation tab's preview tiles both use this.
 * A phase without length (0, negative, NaN) is at rest: 1. The renderer never
 * asks for one (it only evaluates phases longer than 0).
 */
export function getPhaseProgress({
	phase,
	localTime,
	duration,
	length,
}: {
	phase: PresetPhase;
	localTime: number;
	duration: number;
	length: number;
}): number {
	if (!(length > 0)) return 1;
	const progress =
		phase === "in" ? localTime / length : (duration - localTime) / length;
	return clamp({ value: progress, min: 0, max: 1 });
}

function evaluatePhase({
	animation,
	progress,
	getContext,
}: {
	animation: PresetAnimation;
	progress: number;
	getContext: () => PresetContext;
}): PresetDelta | undefined {
	return getPresetDefinition(animation.id)?.evaluate({
		progress,
		context: getContext(),
	});
}

/**
 * What the presets change at `localTime` (clip time), or undefined when the
 * clip is at rest. `getContext` is only called while a phase is running, so a
 * clip without presets does no work.
 */
export function resolvePresetDelta({
	presetAnimations,
	localTime,
	duration,
	getContext,
}: {
	presetAnimations: PresetAnimations | undefined;
	localTime: number;
	duration: number;
	getContext: () => PresetContext;
}): PresetDelta | undefined {
	if (!presetAnimations) return undefined;

	const { in: inLength, out: outLength } = getEffectiveDurations({
		presetAnimations,
		duration,
	});
	if (presetAnimations.in && inLength > 0 && localTime < inLength) {
		return evaluatePhase({
			animation: presetAnimations.in,
			progress: getPhaseProgress({
				phase: "in",
				localTime,
				duration,
				length: inLength,
			}),
			getContext,
		});
	}
	if (
		presetAnimations.out &&
		outLength > 0 &&
		duration - localTime < outLength
	) {
		return evaluatePhase({
			animation: presetAnimations.out,
			progress: getPhaseProgress({
				phase: "out",
				localTime,
				duration,
				length: outLength,
			}),
			getContext,
		});
	}
	return undefined;
}

/** Scales an axis but never lets the clip collapse below the user-facing minimum scale. */
function scaleAxis({
	value,
	multiplier,
}: {
	value: number;
	multiplier: number;
}): number {
	const scaled = value * multiplier;
	if (Math.abs(scaled) >= MIN_TRANSFORM_SCALE) return scaled;
	return value < 0 ? -MIN_TRANSFORM_SCALE : MIN_TRANSFORM_SCALE;
}

/**
 * Lays a delta over the user's own (keyframed or fixed) values: opacity and
 * scale multiply, position adds.
 */
export function applyPresetDelta({
	transform,
	opacity,
	delta,
}: {
	transform: Transform;
	opacity: number;
	delta: PresetDelta;
}): { transform: Transform; opacity: number } {
	const { scale } = delta;
	return {
		transform: {
			position: {
				x: transform.position.x + (delta.x ?? 0),
				y: transform.position.y + (delta.y ?? 0),
			},
			scaleX:
				scale === undefined
					? transform.scaleX
					: scaleAxis({ value: transform.scaleX, multiplier: scale }),
			scaleY:
				scale === undefined
					? transform.scaleY
					: scaleAxis({ value: transform.scaleY, multiplier: scale }),
			rotate: transform.rotate,
		},
		opacity: opacity * (delta.opacity ?? 1),
	};
}

/**
 * Extent of `rect` (relative to the clip origin) after the clip's scale and
 * rotation, which are both applied around that origin. Rotation follows the
 * canvas convention (positive = clockwise on screen).
 *
 * A quad is scaled in its own axes and then rotated. Text is drawn with
 * translate, scale, rotate, so it is rotated first and then scaled along the
 * canvas axes: pass `scaleAfterRotate` for that. The two only differ when the
 * clip is both rotated and scaled unevenly.
 */
export function getTransformedBounds({
	rect,
	scaleX,
	scaleY,
	rotate,
	scaleAfterRotate = false,
}: {
	rect: { left: number; top: number; width: number; height: number };
	scaleX: number;
	scaleY: number;
	rotate: number;
	scaleAfterRotate?: boolean;
}): PresetBounds {
	const radians = (rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const scalePoint = (point: { x: number; y: number }) => ({
		x: point.x * scaleX,
		y: point.y * scaleY,
	});
	const rotatePoint = (point: { x: number; y: number }) => ({
		x: point.x * cos - point.y * sin,
		y: point.x * sin + point.y * cos,
	});
	const bounds = {
		left: Number.POSITIVE_INFINITY,
		right: Number.NEGATIVE_INFINITY,
		top: Number.POSITIVE_INFINITY,
		bottom: Number.NEGATIVE_INFINITY,
	};
	for (const x of [rect.left, rect.left + rect.width]) {
		for (const y of [rect.top, rect.top + rect.height]) {
			const point = scaleAfterRotate
				? scalePoint(rotatePoint({ x, y }))
				: rotatePoint(scalePoint({ x, y }));
			bounds.left = Math.min(bounds.left, point.x);
			bounds.right = Math.max(bounds.right, point.x);
			bounds.top = Math.min(bounds.top, point.y);
			bounds.bottom = Math.max(bounds.bottom, point.y);
		}
	}
	return bounds;
}

/**
 * Lays the In/Out preset animations over the user's own transform and opacity.
 * `rect` is the clip's unscaled box relative to its origin. The renderer
 * (preview and export) and the motion tracker both come through here, so they
 * cannot disagree about where a clip is.
 */
export function applyPresetsAtTime({
	presetAnimations,
	localTime,
	duration,
	canvasWidth,
	canvasHeight,
	transform,
	opacity,
	rect,
	scaleAfterRotate,
}: {
	presetAnimations: PresetAnimations | undefined;
	localTime: number;
	duration: number;
	canvasWidth: number;
	canvasHeight: number;
	transform: Transform;
	opacity: number;
	rect: { left: number; top: number; width: number; height: number };
	/** True for text, which is drawn rotated first and scaled second. */
	scaleAfterRotate?: boolean;
}): { transform: Transform; opacity: number; reveal: PresetReveal | undefined } {
	const delta = resolvePresetDelta({
		presetAnimations,
		localTime,
		duration,
		getContext: () => ({
			canvasWidth,
			canvasHeight,
			position: transform.position,
			bounds: getTransformedBounds({
				rect,
				scaleX: transform.scaleX,
				scaleY: transform.scaleY,
				rotate: transform.rotate,
				scaleAfterRotate,
			}),
		}),
	});
	if (!delta) {
		return { transform, opacity, reveal: undefined };
	}
	return {
		...applyPresetDelta({ transform, opacity, delta }),
		reveal: delta.reveal,
	};
}

/**
 * A clip cut in two: the left half keeps the In animation and the right half
 * the Out animation. The cut edge itself never animates.
 */
export function splitPresetAnimations({
	presetAnimations,
}: {
	presetAnimations: PresetAnimations | undefined;
}): { left: PresetAnimations | undefined; right: PresetAnimations | undefined } {
	return {
		left: presetAnimations?.in ? { in: presetAnimations.in } : undefined,
		right: presetAnimations?.out ? { out: presetAnimations.out } : undefined,
	};
}
