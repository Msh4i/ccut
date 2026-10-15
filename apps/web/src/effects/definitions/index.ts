import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { blurPulseEffectDefinition } from "./blur-pulse";
import { filmGrainEffectDefinition } from "./film-grain";
import { filterDefinitions } from "./filters";
import { flashEffectDefinition } from "./flash";
import { glitchEffectDefinition } from "./glitch";
import { lightLeakEffectDefinition } from "./light-leak";
import { punchZoomEffectDefinition } from "./punch-zoom";
import { rotateWobbleEffectDefinition } from "./rotate-wobble";
import { shakeEffectDefinition } from "./shake";
import { strobeEffectDefinition } from "./strobe";
import { vignettePulseEffectDefinition } from "./vignette-pulse";

// Registration order is the order the Assets > Effects grid shows them in.
const defaultEffects = [
	blurEffectDefinition,
	shakeEffectDefinition,
	punchZoomEffectDefinition,
	flashEffectDefinition,
	strobeEffectDefinition,
	glitchEffectDefinition,
	blurPulseEffectDefinition,
	vignettePulseEffectDefinition,
	filmGrainEffectDefinition,
	lightLeakEffectDefinition,
	rotateWobbleEffectDefinition,
	...filterDefinitions,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
