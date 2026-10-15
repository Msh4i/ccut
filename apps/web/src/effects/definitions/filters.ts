import type { EffectDefinition, EffectPass } from "@/effects/types";
import { parseClampedNumberParam } from "./time-based-effect-utils";

/**
 * Filters: a colour look applied to a whole clip (or, on an effect track, to
 * everything below it), with a single Intensity slider like CapCut's. They
 * run on the effect pipeline, but are shown in their own Assets tab and a
 * clip holds at most one (see add-effect.ts).
 */

interface Grade {
	saturation?: number;
	contrast?: number;
	fade?: number;
	/** -1 cool .. 1 warm */
	temperature?: number;
	/** -1 green .. 1 magenta */
	tint?: number;
	/** [hue 0..1, amount] pushed into the shadows */
	shadowTone?: [number, number];
	/** [hue 0..1, amount] pushed into the highlights */
	highlightTone?: [number, number];
}

interface Sketch {
	edge: number;
	colorKept: number;
	paperWarmth: number;
	paperGrain: number;
}

interface FilterSpec {
	type: string;
	name: string;
	keywords: string[];
	grade?: Grade;
	sketch?: Sketch;
	/** Static vignette strength at full intensity (vignette-pulse shader). */
	vignette?: number;
	/** Film grain amount at full intensity (film-grain shader). */
	grain?: number;
}

// Hues on the 0..1 wheel used below: 0.08 orange, 0.5 cyan/teal,
// 0.6 blue, 0.75 purple, 0.88 pink.
const FILTERS: FilterSpec[] = [
	{
		type: "filter-cinematic",
		name: "Cinematic",
		keywords: ["cinematic", "teal", "orange", "movie", "film"],
		grade: {
			saturation: 1.1,
			contrast: 1.15,
			temperature: 0.1,
			shadowTone: [0.5, 0.25],
			highlightTone: [0.08, 0.2],
		},
	},
	{
		type: "filter-cinematic-light",
		name: "Cinematic light",
		keywords: ["cinematic", "light", "dramatic", "contrast", "movie"],
		grade: {
			saturation: 0.95,
			contrast: 1.3,
			temperature: 0.2,
			shadowTone: [0.55, 0.12],
			highlightTone: [0.09, 0.22],
		},
		vignette: 0.55,
	},
	{
		type: "filter-warm",
		name: "Warm",
		keywords: ["warm", "sunny", "golden"],
		grade: { saturation: 1.05, temperature: 0.6, highlightTone: [0.1, 0.1] },
	},
	{
		type: "filter-cool",
		name: "Cool",
		keywords: ["cool", "cold", "blue", "winter"],
		grade: { saturation: 0.95, temperature: -0.6, tint: -0.1, shadowTone: [0.6, 0.1] },
	},
	{
		type: "filter-bw-film",
		name: "B&W film",
		keywords: ["black and white", "bw", "monochrome", "film", "noir"],
		grade: { saturation: 0, contrast: 1.3, fade: 0.15 },
		grain: 0.05,
	},
	{
		type: "filter-vintage",
		name: "Vintage",
		keywords: ["vintage", "retro", "faded", "old", "film"],
		grade: {
			saturation: 0.75,
			contrast: 0.95,
			fade: 0.55,
			temperature: 0.3,
			shadowTone: [0.4, 0.12],
			highlightTone: [0.1, 0.15],
		},
		vignette: 0.35,
		grain: 0.04,
	},
	{
		type: "filter-paper",
		name: "Paper",
		keywords: ["paper", "drawing", "sketch", "illustration", "art"],
		sketch: { edge: 1, colorKept: 0.6, paperWarmth: 1, paperGrain: 0.06 },
	},
	{
		type: "filter-pencil",
		name: "Pencil sketch",
		keywords: ["pencil", "sketch", "drawing", "charcoal", "art"],
		sketch: { edge: 1.6, colorKept: 0, paperWarmth: 0.3, paperGrain: 0.04 },
	},
	{
		type: "filter-neon-night",
		name: "Neon night",
		keywords: ["neon", "night", "cyberpunk", "purple", "pink"],
		grade: {
			saturation: 1.5,
			contrast: 1.2,
			temperature: -0.3,
			tint: 0.25,
			shadowTone: [0.72, 0.3],
			highlightTone: [0.88, 0.25],
		},
	},
];

const INTENSITY_DEFAULT = 100;
const FILM_GRAIN_STEPS_PER_SECOND = 12;
const FILM_GRAIN_SEED_PERIOD = 1009;

export function buildFilterPasses({
	spec,
	intensity,
	localTimeSeconds,
}: {
	spec: FilterSpec;
	/** 0..1 */
	intensity: number;
	localTimeSeconds: number;
}): EffectPass[] {
	if (intensity <= 0) return [];
	const passes: EffectPass[] = [];
	if (spec.grade) {
		const grade = spec.grade;
		passes.push({
			shader: "color-grade",
			uniforms: {
				u_intensity: intensity,
				u_saturation: grade.saturation ?? 1,
				u_contrast: grade.contrast ?? 1,
				u_fade: grade.fade ?? 0,
				u_temperature: grade.temperature ?? 0,
				u_tint: grade.tint ?? 0,
				u_shadow_tone: grade.shadowTone ?? [0, 0],
				u_highlight_tone: grade.highlightTone ?? [0, 0],
			},
		});
	}
	if (spec.sketch) {
		passes.push({
			shader: "sketch",
			uniforms: {
				u_intensity: intensity,
				u_edge: spec.sketch.edge,
				u_color_kept: spec.sketch.colorKept,
				u_paper_warmth: spec.sketch.paperWarmth,
				u_paper_grain: spec.sketch.paperGrain,
			},
		});
	}
	if (spec.vignette) {
		passes.push({
			shader: "vignette-pulse",
			uniforms: { u_amount: spec.vignette * intensity },
		});
	}
	if (spec.grain) {
		const step = Math.floor(
			Math.max(localTimeSeconds, 0) * FILM_GRAIN_STEPS_PER_SECOND,
		);
		passes.push({
			shader: "film-grain",
			uniforms: {
				u_seed: step % FILM_GRAIN_SEED_PERIOD,
				u_amount: spec.grain * intensity,
			},
		});
	}
	return passes;
}

function toDefinition(spec: FilterSpec): EffectDefinition {
	return {
		type: spec.type,
		name: spec.name,
		keywords: spec.keywords,
		category: "filter",
		params: [
			{
				key: "intensity",
				label: "Intensity",
				type: "number",
				default: INTENSITY_DEFAULT,
				min: 0,
				max: 100,
				step: 1,
			},
		],
		renderer: {
			// Pass count depends on the filter and on intensity (none at 0).
			passes: [],
			buildPasses: ({ effectParams, localTimeSeconds }) =>
				buildFilterPasses({
					spec,
					intensity:
						parseClampedNumberParam({
							effectParams,
							key: "intensity",
							fallback: INTENSITY_DEFAULT,
							min: 0,
							max: 100,
						}) / 100,
					localTimeSeconds,
				}),
		},
	};
}

export const filterDefinitions: EffectDefinition[] = FILTERS.map(toDefinition);
