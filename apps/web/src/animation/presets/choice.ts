import { clamp } from "@/utils/math";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
} from "@/wasm";
import type { PresetDefinition } from "./definitions";
import { getEffectiveDurations, getPresetRoom, setPresetPhase } from "./resolve";
import type {
	PresetAnimation,
	PresetAnimationId,
	PresetAnimations,
	PresetPhase,
} from "./types";

/** A phase preset of `seconds`, clamped to the room the clip and the other phase leave. */
export function buildPresetAnimation({
	presetAnimations,
	phase,
	id,
	seconds,
	duration,
}: {
	presetAnimations: PresetAnimations | undefined;
	phase: PresetPhase;
	id: PresetAnimationId;
	seconds: number;
	duration: number;
}): PresetAnimation {
	const room = getPresetRoom({ presetAnimations, phase, duration });
	const ticks = clamp({
		value: mediaTimeFromSeconds({ seconds }),
		min: room.min,
		max: room.max,
	});
	return { id, duration: roundMediaTime({ time: ticks }) };
}

/**
 * What choosing `definition` for `phase` stores: the preset's default length
 * on an empty phase; when the phase already has a preset, the length shown
 * for it (which is the one that plays), so switching never changes the timing.
 */
export function buildChosenAnimation({
	presetAnimations,
	phase,
	definition,
	duration,
}: {
	presetAnimations: PresetAnimations | undefined;
	phase: PresetPhase;
	definition: PresetDefinition;
	duration: number;
}): PresetAnimation {
	const seconds = presetAnimations?.[phase]
		? mediaTimeToSeconds({
				time: roundMediaTime({
					time: getEffectiveDurations({ presetAnimations, duration })[phase],
				}),
			})
		: definition.defaultSeconds;
	return buildPresetAnimation({
		presetAnimations,
		phase,
		id: definition.id,
		seconds,
		duration,
	});
}

export type PresetChoice =
	| { changed: false }
	| { changed: true; presetAnimations: PresetAnimations | undefined };

/**
 * What choosing `definition` (undefined = None) for `phase` does. Choosing
 * what is already there, or None on an empty phase, changes nothing: no
 * commit and no undo step (a commit could also rewrite a squeezed other
 * phase at its shown length).
 */
export function choosePreset({
	presetAnimations,
	phase,
	definition,
	duration,
}: {
	presetAnimations: PresetAnimations | undefined;
	phase: PresetPhase;
	definition: PresetDefinition | undefined;
	duration: number;
}): PresetChoice {
	const current = presetAnimations?.[phase];
	if (!definition) {
		if (!current) return { changed: false };
		return {
			changed: true,
			presetAnimations: setPresetPhase({
				presetAnimations,
				phase,
				animation: undefined,
				duration,
			}),
		};
	}
	if (current?.id === definition.id) return { changed: false };
	return {
		changed: true,
		presetAnimations: setPresetPhase({
			presetAnimations,
			phase,
			animation: buildChosenAnimation({
				presetAnimations,
				phase,
				definition,
				duration,
			}),
			duration,
		}),
	};
}
