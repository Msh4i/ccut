"use client";

import { ElementParamsTab } from "@/components/editor/panels/properties/components/element-params-tab";
import type { VisualElement } from "@/timeline";
import { LAYER_3D_TAB_ID } from "@/tracking/camera3d/ui/layer-tabs";

/**
 * The "3D" tab of a text, image, sticker or graphic layer: the "3D layer"
 * switch and Position / Orientation / Rotation / Scale X/Y/Z, drawn by the
 * standard param fields (keyframe toggles where the params are keyframable).
 * The registry only offers it once the `transform3d.*` params are registered.
 */
export function Layer3DTab({
	element,
	trackId,
	paramKeys,
}: {
	element: VisualElement;
	trackId: string;
	paramKeys: readonly string[];
}) {
	return (
		<ElementParamsTab
			element={element}
			trackId={trackId}
			paramKeys={paramKeys}
			sectionKey={LAYER_3D_TAB_ID}
		/>
	);
}
