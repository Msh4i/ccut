import type { EffectPass } from "@/effects/types";
import type { RetimeConfig } from "@/timeline";
import { BaseNode } from "./base-node";

export type BlurBackgroundNodeParams = {
	mediaId: string;
	/** Timeline element id of the clip: the backdrop shares the clip's decoded frame. */
	elementId?: string;
	url: string;
	file: File;
	mediaType: "video" | "image";
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	blurIntensity: number;
};

export type BackdropSource = {
	source: CanvasImageSource;
	width: number;
	height: number;
	/** Changes when the pixels of `source` change in place (video frame canvases are pooled). */
	version?: number;
};

export interface ResolvedBlurBackgroundNodeState {
	backdropSource: BackdropSource;
	passes: EffectPass[];
	/**
	 * How many times smaller than the frame the backdrop texture is drawn (>= 1).
	 * The blur still runs at frame resolution with the same sigma, so a strong
	 * blur hides the loss; see compositor/backdrop-scale.ts.
	 */
	downscale: number;
}

export class BlurBackgroundNode extends BaseNode<
	BlurBackgroundNodeParams,
	ResolvedBlurBackgroundNodeState
> {}
