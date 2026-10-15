import {
	isLayerDrawable,
	layerHomography,
	normalizeHomography,
	projectedLayerBounds,
} from "@/scene3d/render/homography";
import type { Transform3D, ViewCamera } from "@/scene3d/types";
import type { QuadTransformDescriptor } from "./types";

/**
 * The compositor quad of a 3D layer: its homography (layer UV -> canvas,
 * normalised) plus, in the 2D fields, the axis-aligned box of its projected
 * quad (for tools; the shader ignores them when a homography is present).
 * `null` when the layer cannot be seen (behind the camera, edge-on, empty).
 */
export function homographyLayerTransform({
	view,
	transform,
	contentWidth,
	contentHeight,
	canvasWidth,
	canvasHeight,
}: {
	view: ViewCamera;
	transform: Transform3D;
	contentWidth: number;
	contentHeight: number;
	canvasWidth: number;
	canvasHeight: number;
}): QuadTransformDescriptor | null {
	const geometry = { view, transform, contentWidth, contentHeight };
	if (!isLayerDrawable(geometry)) return null;
	const homography = normalizeHomography(layerHomography(geometry));
	if (!homography) return null;
	const bounds = projectedLayerBounds({ ...geometry, canvasWidth, canvasHeight });
	if (!bounds) return null;
	return {
		centerX: (bounds.left + bounds.right) / 2,
		centerY: (bounds.top + bounds.bottom) / 2,
		width: bounds.right - bounds.left,
		height: bounds.bottom - bounds.top,
		rotationDegrees: 0,
		flipX: false,
		flipY: false,
		homography: [...homography],
	};
}
