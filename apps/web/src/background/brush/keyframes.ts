import { CUTOUT_LIMITS, type BrushStroke, type CutoutKeyframe, type ElementCutout } from "./types";

/**
 * The keyframe whose strokes apply at clip-local `time`: the last one at or before it (hold until
 * the next). Before the first keyframe the first one applies (the picture does not jump when the
 * first keyframe is painted in the middle of a clip).
 */
export function activeKeyframe({ cutout, time }: { cutout: ElementCutout; time: number }): CutoutKeyframe | null {
	let found: CutoutKeyframe | null = null;
	for (const keyframe of cutout.keyframes) {
		if (keyframe.time <= time) found = keyframe;
		else break;
	}
	return found ?? cutout.keyframes[0] ?? null;
}

export type CutoutEditResult = { ok: true; cutout: ElementCutout } | { ok: false; reason: string };

/**
 * Adds a stroke at `time`. A keyframe within `tolerance` of `time` is edited; otherwise a new
 * keyframe starts from the strokes that applied there (so painting on a later frame continues the
 * earlier work) plus the new stroke.
 */
export function addStroke({
	cutout,
	time,
	stroke,
	tolerance,
	isVideo,
}: {
	cutout: ElementCutout | undefined;
	time: number;
	stroke: BrushStroke;
	tolerance: number;
	isVideo: boolean;
}): CutoutEditResult {
	const keyTime = isVideo ? Math.max(0, time) : 0;
	const base = cutout ?? { keyframes: [] };
	const near = base.keyframes.find((keyframe) => Math.abs(keyframe.time - keyTime) <= tolerance);
	if (near) {
		if (near.strokes.length >= CUTOUT_LIMITS.maxStrokesPerKeyframe) {
			return { ok: false, reason: "This matte frame has too many strokes. Add a new matte keyframe." };
		}
		return {
			ok: true,
			cutout: {
				keyframes: base.keyframes.map((keyframe) =>
					keyframe === near ? { ...keyframe, strokes: [...keyframe.strokes, stroke] } : keyframe,
				),
			},
		};
	}
	if (base.keyframes.length >= CUTOUT_LIMITS.maxKeyframes) {
		return { ok: false, reason: "Too many matte keyframes on this clip." };
	}
	const previous = base.keyframes.length > 0 ? activeKeyframe({ cutout: base, time: keyTime }) : null;
	const earlier = previous !== null && previous.time <= keyTime;
	const inherited = earlier ? previous.strokes : [];
	const keyframes = [...base.keyframes, { time: keyTime, strokes: [...inherited, stroke] }].sort((a, b) => a.time - b.time);
	return { ok: true, cutout: { keyframes } };
}

/** Takes back the last stroke of the keyframe at `time`; an emptied keyframe goes away. Null: nothing left. */
export function undoStroke({
	cutout,
	time,
	tolerance,
}: {
	cutout: ElementCutout;
	time: number;
	tolerance: number;
}): ElementCutout | null {
	const target = cutout.keyframes.find((keyframe) => Math.abs(keyframe.time - time) <= tolerance);
	if (!target) return cutout;
	const strokes = target.strokes.slice(0, -1);
	const keyframes =
		strokes.length === 0
			? cutout.keyframes.filter((keyframe) => keyframe !== target)
			: cutout.keyframes.map((keyframe) => (keyframe === target ? { ...keyframe, strokes } : keyframe));
	return keyframes.length > 0 ? { keyframes } : null;
}

/** Removes the keyframe at `time`. Null: nothing left. */
export function removeKeyframe({
	cutout,
	time,
	tolerance,
}: {
	cutout: ElementCutout;
	time: number;
	tolerance: number;
}): ElementCutout | null {
	const keyframes = cutout.keyframes.filter((keyframe) => Math.abs(keyframe.time - time) > tolerance);
	return keyframes.length > 0 ? { keyframes } : null;
}

/** A new keyframe at `time` that starts from the strokes in force there. Same cutout when one is already within `tolerance`. */
export function addKeyframeAt({
	cutout,
	time,
	tolerance,
}: {
	cutout: ElementCutout;
	time: number;
	tolerance: number;
}): CutoutEditResult {
	if (cutout.keyframes.some((keyframe) => Math.abs(keyframe.time - time) <= tolerance)) {
		return { ok: true, cutout };
	}
	if (cutout.keyframes.length >= CUTOUT_LIMITS.maxKeyframes) {
		return { ok: false, reason: "Too many matte keyframes on this clip." };
	}
	const current = activeKeyframe({ cutout, time });
	const keyframes = [...cutout.keyframes, { time, strokes: current ? [...current.strokes] : [] }].sort(
		(a, b) => a.time - b.time,
	);
	return { ok: true, cutout: { keyframes } };
}
