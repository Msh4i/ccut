import {
	getElementKeyframes,
	getKeyframeAtTime,
	resolveAnimationPathValueAtTime,
} from "@/animation";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import type { SceneTracks, TimelineElement } from "@/timeline/types";
import type { ParamValue } from "@/params";
import { mediaTime, type MediaTime } from "@/wasm";

const VISUAL_GROUP_PATHS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"opacity",
] as const;
const AUDIO_GROUP_PATHS = ["volume"] as const;

/**
 * The properties the "keyframe at playhead" button keys together: position,
 * scale, rotate and opacity for a picture, volume for a sound. Video clips
 * take the picture group; their volume has its own envelope.
 */
export function getPlayheadKeyframePaths({
	element,
}: {
	element: TimelineElement;
}): string[] {
	const candidates =
		element.type === "audio" ? AUDIO_GROUP_PATHS : VISUAL_GROUP_PATHS;
	return candidates.filter(
		(path) => resolveAnimationTarget({ element, path }) !== null,
	);
}

export type PlayheadKeyframePlan =
	| {
			kind: "add";
			keyframes: Array<{ propertyPath: string; value: ParamValue }>;
	  }
	| {
			kind: "remove";
			keyframes: Array<{ propertyPath: string; keyframeId: string }>;
	  };

/**
 * What the button does at the playhead: if any property of the group already
 * has a key there, take those keys out; otherwise key every property of the
 * group at its current value. Null when the playhead is outside the clip or
 * the clip has nothing to key.
 */
export function planPlayheadKeyframe({
	element,
	playhead,
}: {
	element: TimelineElement;
	playhead: number;
}): PlayheadKeyframePlan | null {
	const localTime = playhead - element.startTime;
	if (localTime < 0 || localTime > element.duration) {
		return null;
	}
	const paths = getPlayheadKeyframePaths({ element });
	if (paths.length === 0) {
		return null;
	}

	const existing = paths.flatMap((propertyPath) => {
		const key = getKeyframeAtTime({
			animations: element.animations,
			propertyPath,
			time: localTime,
		});
		return key ? [{ propertyPath, keyframeId: key.id }] : [];
	});
	if (existing.length > 0) {
		return { kind: "remove", keyframes: existing };
	}

	const keyframes: Array<{ propertyPath: string; value: ParamValue }> = [];
	for (const propertyPath of paths) {
		const fixed = resolveAnimationTarget({ element, path: propertyPath })?.getBaseValue();
		if (typeof fixed !== "number") {
			continue;
		}
		keyframes.push({
			propertyPath,
			value: resolveAnimationPathValueAtTime({
				animations: element.animations,
				propertyPath,
				localTime,
				fallbackValue: fixed,
			}),
		});
	}
	return keyframes.length > 0 ? { kind: "add", keyframes } : null;
}

/**
 * The timeline time of the closest keyframe of the clip (any property) before
 * or after the playhead, or null when there is none that way.
 */
export function findAdjacentKeyframeTime({
	element,
	playhead,
	direction,
}: {
	element: TimelineElement;
	playhead: number;
	direction: "previous" | "next";
}): MediaTime | null {
	let best: number | null = null;
	for (const keyframe of getElementKeyframes({ animations: element.animations })) {
		const time = element.startTime + keyframe.time;
		if (direction === "next" ? time > playhead : time < playhead) {
			if (
				best === null ||
				(direction === "next" ? time < best : time > best)
			) {
				best = time;
			}
		}
	}
	return best === null ? null : mediaTime({ ticks: best });
}

export interface KeyframeTarget {
	trackId: string;
	element: TimelineElement;
}

/** The selected clips as targets, in selection order; refs that no longer exist are dropped. */
export function resolveKeyframeTargets({
	tracks,
	selected,
}: {
	tracks: SceneTracks;
	selected: ReadonlyArray<{ trackId: string; elementId: string }>;
}): KeyframeTarget[] {
	const targets: KeyframeTarget[] = [];
	for (const { trackId, elementId } of selected) {
		const element = findTrackInSceneTracks({ tracks, trackId })?.elements.find(
			(candidate) => candidate.id === elementId,
		);
		if (element) {
			targets.push({ trackId, element });
		}
	}
	return targets;
}

export type PlayheadKeyframesPlan =
	| {
			kind: "add";
			keyframes: Array<{
				trackId: string;
				elementId: string;
				propertyPath: string;
				value: ParamValue;
				time: MediaTime;
			}>;
	  }
	| {
			kind: "remove";
			keyframes: Array<{
				trackId: string;
				elementId: string;
				propertyPath: string;
				keyframeId: string;
			}>;
	  };

/**
 * The button's state for the selected clips: how many it can act on at the
 * playhead (the playhead inside the clip, something to key) and whether every
 * one of those already has a key there (the diamond is filled).
 */
export function getPlayheadKeyframeState({
	targets,
	playhead,
}: {
	targets: readonly KeyframeTarget[];
	playhead: number;
}): { actionable: number; isKeyed: boolean } {
	let actionable = 0;
	let keyed = 0;
	for (const { element } of targets) {
		const plan = planPlayheadKeyframe({ element, playhead });
		if (!plan) continue;
		actionable++;
		if (plan.kind === "remove") keyed++;
	}
	return { actionable, isKeyed: actionable > 0 && keyed === actionable };
}

/**
 * What the button does for the selected clips, as one plan (so one undo step):
 * when every clip that can take a key already has one at the playhead, those
 * keys come out; otherwise the clips without a key get their group keyed and
 * the others are left as they are. Null when no selected clip can act.
 */
export function planPlayheadKeyframes({
	targets,
	playhead,
}: {
	targets: readonly KeyframeTarget[];
	playhead: number;
}): PlayheadKeyframesPlan | null {
	const plans = targets.flatMap(({ trackId, element }) => {
		const plan = planPlayheadKeyframe({ element, playhead });
		return plan ? [{ trackId, element, plan }] : [];
	});
	if (plans.length === 0) {
		return null;
	}

	if (plans.every(({ plan }) => plan.kind === "remove")) {
		return {
			kind: "remove",
			keyframes: plans.flatMap(({ trackId, element, plan }) =>
				plan.kind === "remove"
					? plan.keyframes.map((keyframe) => ({
							trackId,
							elementId: element.id,
							...keyframe,
						}))
					: [],
			),
		};
	}

	return {
		kind: "add",
		keyframes: plans.flatMap(({ trackId, element, plan }) =>
			plan.kind === "add"
				? plan.keyframes.map((keyframe) => ({
						trackId,
						elementId: element.id,
						time: mediaTime({ ticks: playhead - element.startTime }),
						...keyframe,
					}))
				: [],
		),
	};
}

/** The closest keyframe before or after the playhead across all the given clips. */
export function findAdjacentKeyframeTimeAmong({
	targets,
	playhead,
	direction,
}: {
	targets: readonly KeyframeTarget[];
	playhead: number;
	direction: "previous" | "next";
}): MediaTime | null {
	let best: MediaTime | null = null;
	for (const { element } of targets) {
		const time = findAdjacentKeyframeTime({ element, playhead, direction });
		if (
			time !== null &&
			(best === null || (direction === "next" ? time < best : time > best))
		) {
			best = time;
		}
	}
	return best;
}
