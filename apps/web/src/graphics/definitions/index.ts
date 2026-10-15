import { graphicsRegistry } from "../registry";
import { ellipseGraphicDefinition } from "./ellipse";
import { NULL_GRAPHIC_DEFINITION_ID, nullGraphicDefinition } from "./null";
import { polygonGraphicDefinition } from "./polygon";
import { rectangleGraphicDefinition } from "./rectangle";
import { starGraphicDefinition } from "./star";

const defaultGraphicDefinitions = [
	rectangleGraphicDefinition,
	ellipseGraphicDefinition,
	polygonGraphicDefinition,
	starGraphicDefinition,
];

/** Graphics that exist for other features and are not offered as shapes. */
const unlistedGraphicDefinitions = [nullGraphicDefinition];

export function registerDefaultGraphics(): void {
	for (const definition of defaultGraphicDefinitions) {
		if (graphicsRegistry.has(definition.id)) {
			continue;
		}
		graphicsRegistry.register({
			key: definition.id,
			definition,
		});
	}
	for (const definition of unlistedGraphicDefinitions) {
		if (graphicsRegistry.has(definition.id)) {
			continue;
		}
		graphicsRegistry.registerUnlisted({
			key: definition.id,
			definition,
		});
	}
}

export {
	ellipseGraphicDefinition,
	NULL_GRAPHIC_DEFINITION_ID,
	nullGraphicDefinition,
	polygonGraphicDefinition,
	rectangleGraphicDefinition,
	starGraphicDefinition,
};
export { STROKE_ALIGN_PARAM } from "./shared";
