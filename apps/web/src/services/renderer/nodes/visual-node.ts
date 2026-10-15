import { BaseNode } from "./base-node";
import type { PresetAnimations } from "@/animation/presets";
import type { Effect, EffectPass } from "@/effects/types";
import type { ChromaKeySettings } from "@/background/chroma-key";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import type { BlendMode, Transform } from "@/rendering";
import type { Transform3D } from "@/scene3d/types";
import type { Matte } from "@/background/matte/matte-registry";
import type { RetimeConfig, VisualElement } from "@/timeline";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	presetAnimations?: PresetAnimations;
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/** The element's stored params: read for its 3D layer switch and transform (`transform3d.*`). */
	elementParams?: ParamValues;
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
	/** Present on a 3D layer: drawn through the camera, the 2D `transform` is ignored. */
	transform3d?: Transform3D;
	/** Present when the clip's colour key is on: its picture is keyed before it is drawn. */
	chromaKey?: ChromaKeySettings;
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	/** The source's logical size: what the layer's quad and effects are computed from. */
	sourceWidth: number;
	sourceHeight: number;
	/**
	 * The pixel size of `source` when it is smaller than its logical size (a
	 * video frame drawn at preview resolution). The texture is uploaded at this
	 * size while the layer keeps the logical one; absent: the logical size.
	 */
	textureWidth?: number;
	textureHeight?: number;
	/** Changes when the pixels of `source` change in place (video frame canvases are pooled). */
	sourceVersion?: number;
	/** Alpha mattes (smart cutout, brush) to multiply into the picture, after the colour key. */
	mattes?: Matte[];
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
