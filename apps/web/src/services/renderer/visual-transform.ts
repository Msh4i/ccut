import { applyPresetsAtTime, type PresetAnimations } from "@/animation/presets";
import type { ElementAnimations } from "@/animation/types";
import { resolveOpacityAtTime } from "@/animation/values";
import type { Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type { QuadTransformDescriptor } from "./compositor/types";

/**
 * Where a picture element (video, image, sticker, graphic) is drawn on the
 * canvas at a time: its animated transform with the In/Out presets laid over
 * it, and the compositor quad of that. Pure: the renderer
 * (`resolve.ts`, `compositor/frame-descriptor.ts`) and the 3D camera
 * (`scene3d/render/active-camera.ts`, which needs the tracked clip's quad)
 * share it, so they cannot disagree.
 */

/** Size of a source contain-fitted into the canvas (its size on the canvas at 2D scale 1). */
export function containFitSize({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): { width: number; height: number; scale: number } {
	const scale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
	return { width: sourceWidth * scale, height: sourceHeight * scale, scale };
}

/** The element's transform and opacity at `localTime`: keyframes first, then the presets. */
export function resolveVisualTransformAtTime({
	baseTransform,
	baseOpacity,
	animations,
	presetAnimations,
	localTime,
	duration,
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
}: {
	baseTransform: Transform;
	baseOpacity: number;
	animations: ElementAnimations | undefined;
	presetAnimations: PresetAnimations | undefined;
	localTime: number;
	duration: number;
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}): { transform: Transform; opacity: number } {
	const fitted = containFitSize({
		canvasWidth,
		canvasHeight,
		sourceWidth,
		sourceHeight,
	});
	const { transform, opacity } = applyPresetsAtTime({
		presetAnimations,
		localTime,
		duration,
		canvasWidth,
		canvasHeight,
		transform: resolveTransformAtTime({
			baseTransform,
			animations,
			localTime,
		}),
		opacity: resolveOpacityAtTime({
			baseOpacity,
			animations,
			localTime,
		}),
		rect: {
			left: -fitted.width / 2,
			top: -fitted.height / 2,
			width: fitted.width,
			height: fitted.height,
		},
	});
	return { transform, opacity };
}

/** The compositor quad of a contain-fitted source under a 2D transform. */
export function visualQuadTransform({
	canvasWidth,
	canvasHeight,
	transform,
	sourceWidth,
	sourceHeight,
}: {
	canvasWidth: number;
	canvasHeight: number;
	transform: Transform;
	sourceWidth: number;
	sourceHeight: number;
}): QuadTransformDescriptor {
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * transform.scaleX;
	const scaledHeight = sourceHeight * containScale * transform.scaleY;
	const absWidth = Math.abs(scaledWidth);
	const absHeight = Math.abs(scaledHeight);

	return {
		centerX: canvasWidth / 2 + transform.position.x,
		centerY: canvasHeight / 2 + transform.position.y,
		width: absWidth,
		height: absHeight,
		rotationDegrees: transform.rotate,
		flipX: scaledWidth < 0,
		flipY: scaledHeight < 0,
	};
}
