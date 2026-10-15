export {
	MIN_PRESET_SECONDS,
	PRESET_DEFINITIONS,
	getPresetDefinition,
	getPresetsForElementType,
	type PresetDefinition,
} from "./definitions";

export {
	buildChosenAnimation,
	buildPresetAnimation,
	choosePreset,
	type PresetChoice,
} from "./choice";

export {
	applyPresetDelta,
	applyPresetsAtTime,
	getEffectiveDurations,
	getPhaseProgress,
	getPresetRoom,
	getTransformedBounds,
	resolvePresetDelta,
	setPresetPhase,
	splitPresetAnimations,
} from "./resolve";

export type {
	PresetAnimation,
	PresetAnimationId,
	PresetAnimations,
	PresetBounds,
	PresetContext,
	PresetDelta,
	PresetPhase,
	PresetReveal,
} from "./types";
