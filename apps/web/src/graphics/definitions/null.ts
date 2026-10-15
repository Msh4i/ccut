import type { GraphicDefinition } from "../types";

export const NULL_GRAPHIC_DEFINITION_ID = "null";

/**
 * AE's Null layer ("Create Null" of Track Camera): a 3D layer that draws
 * nothing, used as a parent or a reference point in the tracked scene. The
 * preview shows a gizmo for it; export shows nothing. It is not offered in
 * the shapes library (registered unlisted).
 */
export const nullGraphicDefinition: GraphicDefinition = {
	id: NULL_GRAPHIC_DEFINITION_ID,
	name: "Null",
	keywords: ["null", "3d", "tracker"],
	params: [],
	render({ ctx, width, height }) {
		ctx.clearRect(0, 0, width, height);
	},
};
