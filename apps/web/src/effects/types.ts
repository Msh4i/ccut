import type { ParamDefinition, ParamValues } from "@/params";

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

export type EffectUniformValue = number | number[];

export interface EffectPass {
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
}

export interface EffectPassContext {
	effectParams: ParamValues;
	width: number;
	height: number;
	/** Seconds since this effect instance started (clip effect or effect-track clip). */
	localTimeSeconds: number;
	/** Total duration of this effect instance, in seconds. */
	durationSeconds: number;
}

export interface EffectPassTemplate {
	shader: string;
	uniforms(context: EffectPassContext): Record<string, EffectUniformValue>;
}

export interface EffectRendererConfig {
	passes: EffectPassTemplate[];
	buildPasses?: (context: EffectPassContext) => EffectPass[];
}

export interface EffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	renderer: EffectRendererConfig;
	/**
	 * Effect-local second shown as the still thumbnail in the Assets grid
	 * (hovering plays the effect). Defaults to 0, which for many time-based
	 * effects is their resting, effect-free frame.
	 */
	previewTimeSeconds?: number;
	/** Filters get their own Assets tab and a clip holds at most one. */
	category?: "filter";
}
