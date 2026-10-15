"use client";

import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useTransformHandles } from "@/preview/hooks/use-transform-handles";
import { isVisualElement } from "@/timeline/element-utils";
import type { OnSnapLinesChange } from "@/preview/hooks/use-preview-interaction";
import { TransformHandlesView } from "./transform-handles-view";

export function TransformHandles({
	onSnapLinesChange,
}: {
	onSnapLinesChange?: OnSnapLinesChange;
}) {
	const viewport = usePreviewViewport();
	const {
		selectedWithBounds,
		hasVisualSelection,
		handleCornerPointerDown,
		handleEdgePointerDown,
		handleRotationPointerDown,
		handlePointerMove,
		handlePointerUp,
	} = useTransformHandles({ onSnapLinesChange });

	if (!hasVisualSelection || !selectedWithBounds) return null;

	const { bounds, element } = selectedWithBounds;
	if (!isVisualElement(element)) return null;

	return (
		<TransformHandlesView
			bounds={bounds}
			toOverlay={viewport.canvasToOverlay}
			displayScale={viewport.getDisplayScale()}
			onCornerPointerDown={handleCornerPointerDown}
			onEdgePointerDown={handleEdgePointerDown}
			onRotationPointerDown={handleRotationPointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={() => handlePointerUp()}
		/>
	);
}
