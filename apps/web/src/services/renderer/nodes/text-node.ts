import { BaseNode } from "./base-node";
import type { TextElement } from "@/timeline";
import type { EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import type { Transform3D } from "@/scene3d/types";
import { drawMeasuredTextLayout } from "@/text/primitives";
import type { MeasuredTextElement } from "@/text/measure-element";

export type TextNodeParams = TextElement & {
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	canvasCenter: { x: number; y: number };
	canvasHeight: number;
	textBaseline?: CanvasTextBaseline;
};

export interface ResolvedTextNodeState {
	transform: Transform;
	opacity: number;
	textColor: string;
	backgroundColor: string;
	effectPasses: EffectPass[][];
	measuredText: MeasuredTextElement;
	/** Present while a text reveal preset runs: how much of each line to draw. */
	visibleLengths?: number[];
	/** Present on a 3D layer: drawn through the camera, the 2D `transform` is ignored. */
	transform3d?: Transform3D;
}

export class TextNode extends BaseNode<TextNodeParams, ResolvedTextNodeState> {}

/**
 * A 3D text layer's content: the measured layout (its visual box, glyphs and
 * background, at 2D scale 1) drawn to fill a local texture of `width` x
 * `height` pixels. The compositor places that texture with the layer's
 * homography.
 */
export function renderTextToLocalContext({
	node,
	ctx,
	width,
	height,
}: {
	node: TextNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
}): void {
	const resolved = node.resolved;
	if (!resolved) {
		return;
	}
	const rect = resolved.measuredText.visualRect;
	if (!(rect.width > 0) || !(rect.height > 0)) {
		return;
	}

	ctx.save();
	ctx.scale(width / rect.width, height / rect.height);
	ctx.translate(-rect.left, -rect.top);
	drawMeasuredTextLayout({
		ctx,
		layout: resolved.measuredText,
		textColor: resolved.textColor,
		background: resolved.measuredText.resolvedBackground,
		backgroundColor: resolved.backgroundColor,
		textBaseline: node.params.textBaseline ?? "middle",
		visibleLengths: resolved.visibleLengths,
	});
	ctx.restore();
}

export function renderTextToContext({
	node,
	ctx,
}: {
	node: TextNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	const resolved = node.resolved;
	if (!resolved) {
		return;
	}

	const x = resolved.transform.position.x + node.params.canvasCenter.x;
	const y = resolved.transform.position.y + node.params.canvasCenter.y;
	const baseline = node.params.textBaseline ?? "middle";

	ctx.save();
	ctx.translate(x, y);
	ctx.scale(resolved.transform.scaleX, resolved.transform.scaleY);
	if (resolved.transform.rotate) {
		ctx.rotate((resolved.transform.rotate * Math.PI) / 180);
	}

	drawMeasuredTextLayout({
		ctx,
		layout: resolved.measuredText,
		textColor: resolved.textColor,
		background: resolved.measuredText.resolvedBackground,
		backgroundColor: resolved.backgroundColor,
		textBaseline: baseline,
		visibleLengths: resolved.visibleLengths,
	});

	ctx.restore();
}
