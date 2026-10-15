import { VISUAL_ELEMENT_TYPES, type ElementType } from "@/timeline/types";
import { easeOutBack, easeOutCubic, linear } from "./easing";
import type {
	PresetAnimationId,
	PresetContext,
	PresetDelta,
} from "./types";

export const MIN_PRESET_SECONDS = 0.1;

export interface PresetDefinition {
	id: PresetAnimationId;
	label: string;
	/** Label as an Out preset, when it reads differently from the In one. */
	outLabel?: string;
	supports: readonly ElementType[];
	defaultSeconds: number;
	/**
	 * The In animation at `progress` (0 = first frame, 1 = at rest). Out is the
	 * same function run backwards, so the two are exact mirrors.
	 */
	evaluate: (args: { progress: number; context: PresetContext }) => PresetDelta;
}

/** Where a slide starts: just far enough that the clip is fully off its entry edge. */
type SlideStart = (context: PresetContext) => number;

const fromLeft: SlideStart = ({ canvasWidth, position, bounds }) =>
	-Math.max(0, canvasWidth / 2 + position.x + bounds.right);
const fromRight: SlideStart = ({ canvasWidth, position, bounds }) =>
	Math.max(0, canvasWidth / 2 - position.x - bounds.left);
const fromTop: SlideStart = ({ canvasHeight, position, bounds }) =>
	-Math.max(0, canvasHeight / 2 + position.y + bounds.bottom);
const fromBottom: SlideStart = ({ canvasHeight, position, bounds }) =>
	Math.max(0, canvasHeight / 2 - position.y - bounds.top);

function slide({
	id,
	edge,
	axis,
	start,
}: {
	id: PresetAnimationId;
	edge: string;
	axis: "x" | "y";
	start: SlideStart;
}): PresetDefinition {
	return {
		id,
		label: `From ${edge}`,
		outLabel: `To ${edge}`,
		supports: VISUAL_ELEMENT_TYPES,
		defaultSeconds: 0.5,
		evaluate: ({ progress, context }) => {
			const offset = start(context) * (1 - easeOutCubic(progress));
			return axis === "x" ? { x: offset } : { y: offset };
		},
	};
}

export const PRESET_DEFINITIONS: readonly PresetDefinition[] = [
	{
		id: "fade",
		label: "Fade",
		supports: VISUAL_ELEMENT_TYPES,
		defaultSeconds: 0.5,
		evaluate: ({ progress }) => ({ opacity: linear(progress) }),
	},
	slide({ id: "slide-left", edge: "left", axis: "x", start: fromLeft }),
	slide({ id: "slide-right", edge: "right", axis: "x", start: fromRight }),
	slide({ id: "slide-up", edge: "top", axis: "y", start: fromTop }),
	slide({ id: "slide-down", edge: "bottom", axis: "y", start: fromBottom }),
	{
		id: "zoom",
		label: "Zoom",
		supports: VISUAL_ELEMENT_TYPES,
		defaultSeconds: 0.5,
		evaluate: ({ progress }) => {
			const eased = easeOutCubic(progress);
			return { scale: 0.5 + 0.5 * eased, opacity: eased };
		},
	},
	{
		id: "pop",
		label: "Pop",
		supports: VISUAL_ELEMENT_TYPES,
		defaultSeconds: 0.5,
		evaluate: ({ progress }) => ({ scale: easeOutBack(progress) }),
	},
	{
		id: "typewriter",
		label: "Typewriter",
		supports: ["text"],
		defaultSeconds: 1,
		evaluate: ({ progress }) => ({
			reveal: { unit: "grapheme", fraction: linear(progress) },
		}),
	},
	{
		id: "word-reveal",
		label: "Word reveal",
		supports: ["text"],
		defaultSeconds: 1,
		evaluate: ({ progress }) => ({
			reveal: { unit: "word", fraction: linear(progress) },
		}),
	},
];

// A Map, not an object lookup: an id like "constructor" must not find anything.
const definitionsById = new Map<string, PresetDefinition>(
	PRESET_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getPresetDefinition(id: string): PresetDefinition | undefined {
	return definitionsById.get(id);
}

export function getPresetsForElementType({
	elementType,
}: {
	elementType: ElementType;
}): PresetDefinition[] {
	return PRESET_DEFINITIONS.filter((definition) =>
		definition.supports.includes(elementType),
	);
}
