import { SMART_CUTOUT_ENABLED_KEY } from "@/background/matte/matte-registry";
import type {
	ParamDefinition,
	ParamValue,
	ParamValues,
} from "@/params";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { NumberSliderSpec } from "@/params/slider";
import type { BlendMode } from "@/rendering";
import type {
	ElementType,
	TimelineElement,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { CHROMA_KEY_DEFAULTS } from "@/background/chroma-key";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import {
	CORNER_RADIUS_MAX,
	CORNER_RADIUS_MIN,
} from "@/text/background";
import {
	LAYER_3D_DEFAULTS,
	LAYER_3D_ENABLED_KEY,
	LAYER_3D_KEYS,
	type Layer3DKey,
} from "@/scene3d/layer-params";

export type ElementParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		read?: ({ element }: { element: TimelineElement }) => ParamValue | null;
		write?: ({
			element,
			value,
		}: {
			element: TimelineElement;
			value: ParamValue;
		}) => TimelineElement;
	};

export function buildDefaultParamValues(
	params: readonly ParamDefinition[],
): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

export class DefinitionRegistry<TKey extends string, TDefinition> {
	private definitions = new Map<TKey, TDefinition>();
	private entityName: string;

	constructor(entityName: string) {
		this.entityName = entityName;
	}

	register({
		key,
		definition,
	}: {
		key: TKey;
		definition: TDefinition;
	}): void {
		this.definitions.set(key, definition);
	}

	has(key: TKey): boolean {
		return this.definitions.has(key);
	}

	get(key: TKey): TDefinition {
		const def = this.definitions.get(key);
		if (!def) {
			// An id from a saved project can be any length: cut it for the message.
			throw new Error(`Unknown ${this.entityName}: ${String(key).slice(0, 80)}`);
		}
		return def;
	}

	getAll(): TDefinition[] {
		return Array.from(this.definitions.values());
	}
}

const BLEND_MODE_OPTIONS: Array<{ value: BlendMode; label: string }> = [
	{ value: "normal", label: "Normal" },
	{ value: "darken", label: "Darken" },
	{ value: "multiply", label: "Multiply" },
	{ value: "color-burn", label: "Color Burn" },
	{ value: "lighten", label: "Lighten" },
	{ value: "screen", label: "Screen" },
	{ value: "plus-lighter", label: "Plus Lighter" },
	{ value: "color-dodge", label: "Color Dodge" },
	{ value: "overlay", label: "Overlay" },
	{ value: "soft-light", label: "Soft Light" },
	{ value: "hard-light", label: "Hard Light" },
	{ value: "difference", label: "Difference" },
	{ value: "exclusion", label: "Exclusion" },
	{ value: "hue", label: "Hue" },
	{ value: "saturation", label: "Saturation" },
	{ value: "color", label: "Color" },
	{ value: "luminosity", label: "Luminosity" },
];

const SCALE_SLIDER: NumberSliderSpec = {
	min: MIN_TRANSFORM_SCALE,
	max: 5,
	pivot: 1,
};

const visualElementParams: ElementParamDefinition[] = [
	{
		key: "transform.positionX",
		label: "Position X",
		type: "number",
		default: DEFAULTS.element.transform.position.x,
		min: -100_000,
		step: 1,
		slider: { min: -1920, max: 1920 },
	},
	{
		key: "transform.positionY",
		label: "Position Y",
		type: "number",
		default: DEFAULTS.element.transform.position.y,
		min: -100_000,
		step: 1,
		slider: { min: -1080, max: 1080 },
	},
	{
		key: "transform.scaleX",
		label: "Scale X",
		type: "number",
		default: DEFAULTS.element.transform.scaleX,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
		slider: SCALE_SLIDER,
	},
	{
		key: "transform.scaleY",
		label: "Scale Y",
		type: "number",
		default: DEFAULTS.element.transform.scaleY,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
		slider: SCALE_SLIDER,
	},
	{
		key: "transform.rotate",
		label: "Rotate",
		type: "number",
		default: DEFAULTS.element.transform.rotate,
		min: -360,
		max: 360,
		step: 1,
		unitLabel: "degrees",
	},
	{
		key: "opacity",
		label: "Opacity",
		type: "number",
		default: DEFAULTS.element.opacity,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "blendMode",
		label: "Blend Mode",
		type: "select",
		default: DEFAULTS.element.blendMode,
		keyframable: false,
		options: BLEND_MODE_OPTIONS,
	},
];

const audioElementParams: ElementParamDefinition[] = [
	{
		key: "volume",
		label: "Volume",
		type: "number",
		default: DEFAULTS.element.volume,
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
		step: 0.01,
		unitLabel: "dB",
	},
	{
		key: "muted",
		label: "Muted",
		type: "boolean",
		default: false,
		keyframable: false,
	},
];

const textElementParams: ElementParamDefinition[] = [
	{
		key: "content",
		label: "Content",
		type: "text",
		default: "Default text",
		keyframable: false,
	},
	{
		key: "fontFamily",
		label: "Font Family",
		type: "font",
		default: "Arial",
		keyframable: false,
	},
	{
		key: "fontSize",
		label: "Font Size",
		type: "number",
		default: 15,
		min: 1,
		step: 1,
		slider: { min: 1, max: 100 },
	},
	{
		key: "color",
		label: "Color",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "textAlign",
		label: "Text Align",
		type: "select",
		default: "center",
		keyframable: false,
		options: [
			{ value: "left", label: "Left" },
			{ value: "center", label: "Center" },
			{ value: "right", label: "Right" },
		],
	},
	{
		key: "fontWeight",
		label: "Font Weight",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "bold", label: "Bold" },
		],
	},
	{
		key: "fontStyle",
		label: "Font Style",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "italic", label: "Italic" },
		],
	},
	{
		key: "textDecoration",
		label: "Text Decoration",
		type: "select",
		default: "none",
		keyframable: false,
		options: [
			{ value: "none", label: "None" },
			{ value: "underline", label: "Underline" },
			{ value: "line-through", label: "Line Through" },
		],
	},
	{
		key: "letterSpacing",
		label: "Letter Spacing",
		type: "number",
		default: DEFAULTS.text.letterSpacing,
		min: -100,
		step: 0.1,
		slider: { min: -20, max: 50 },
	},
	{
		key: "lineHeight",
		label: "Line Height",
		type: "number",
		default: DEFAULTS.text.lineHeight,
		min: 0.1,
		step: 0.1,
		slider: { min: 0.5, max: 3 },
	},
	{
		key: "background.enabled",
		label: "Background Enabled",
		type: "boolean",
		default: DEFAULTS.text.background.enabled,
		keyframable: false,
	},
	{
		key: "background.color",
		label: "Background Color",
		type: "color",
		default: DEFAULTS.text.background.color,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.cornerRadius",
		label: "Background Radius",
		type: "number",
		default: DEFAULTS.text.background.cornerRadius,
		min: CORNER_RADIUS_MIN,
		max: CORNER_RADIUS_MAX,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingX",
		label: "Background Padding X",
		type: "number",
		default: DEFAULTS.text.background.paddingX,
		min: 0,
		step: 1,
		slider: { min: 0, max: 200 },
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingY",
		label: "Background Padding Y",
		type: "number",
		default: DEFAULTS.text.background.paddingY,
		min: 0,
		step: 1,
		slider: { min: 0, max: 200 },
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetX",
		label: "Background Offset X",
		type: "number",
		default: DEFAULTS.text.background.offsetX,
		min: -100_000,
		step: 1,
		slider: { min: -200, max: 200 },
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetY",
		label: "Background Offset Y",
		type: "number",
		default: DEFAULTS.text.background.offsetY,
		min: -100_000,
		step: 1,
		slider: { min: -200, max: 200 },
		dependencies: [{ param: "background.enabled", equals: true }],
	},
];

/**
 * World positions of a tracked scene have no fixed scale (the solve picks
 * one), so a slider bar would mean nothing: the field scrubs instead.
 */
const LAYER_3D_POSITION_LIMIT = 1_000_000;
/** Degrees, wide enough for every angle `mat3ToEulerDeg` returns. */
const LAYER_3D_ANGLE_LIMIT = 360;
const LAYER_3D_SCALE_SLIDER: NumberSliderSpec = { min: 0, max: 5, pivot: 1 };

function layer3DNumberParam({
	key,
	label,
}: {
	key: Layer3DKey;
	label: string;
}): ElementParamDefinition {
	const base = { key, label, type: "number" as const, default: LAYER_3D_DEFAULTS[key] };
	if (key.startsWith("transform3d.position")) {
		return {
			...base,
			min: -LAYER_3D_POSITION_LIMIT,
			max: LAYER_3D_POSITION_LIMIT,
			step: 0.01,
			slider: false,
		};
	}
	if (key.startsWith("transform3d.scale")) {
		// negative scale mirrors the layer, as in After Effects
		return { ...base, min: -100, max: 100, step: 0.001, slider: LAYER_3D_SCALE_SLIDER };
	}
	return {
		...base,
		min: -LAYER_3D_ANGLE_LIMIT,
		max: LAYER_3D_ANGLE_LIMIT,
		step: 0.1,
		unitLabel: "degrees",
	};
}

/**
 * AE's 3D layer switch and 3D transform (`scene3d/layer-params.ts`). Shown
 * in the properties panel's own 3D tab, never in the 2D Transform tab
 * (that tab lists its keys explicitly).
 */
/** Colour key ("chroma key") of a picture clip: see `background/chroma-key.ts`. */
const chromaKeyElementParams: ElementParamDefinition[] = [
	{
		key: "chromaKey.enabled",
		label: "Chroma key",
		type: "boolean",
		default: CHROMA_KEY_DEFAULTS.enabled,
		keyframable: false,
	},
	{
		key: "chromaKey.color",
		label: "Key color",
		type: "color",
		default: CHROMA_KEY_DEFAULTS.color,
		dependencies: [{ param: "chromaKey.enabled", equals: true }],
	},
	{
		key: "chromaKey.tolerance",
		label: "Tolerance",
		type: "number",
		default: CHROMA_KEY_DEFAULTS.tolerance,
		min: 0,
		max: 100,
		step: 1,
		slider: { min: 0, max: 100 },
		dependencies: [{ param: "chromaKey.enabled", equals: true }],
	},
	{
		key: "chromaKey.softness",
		label: "Edge softness",
		type: "number",
		default: CHROMA_KEY_DEFAULTS.softness,
		min: 0,
		max: 100,
		step: 1,
		slider: { min: 0, max: 100 },
		dependencies: [{ param: "chromaKey.enabled", equals: true }],
	},
	{
		key: "chromaKey.spill",
		label: "Spill removal",
		type: "number",
		default: CHROMA_KEY_DEFAULTS.spill,
		min: 0,
		max: 100,
		step: 1,
		slider: { min: 0, max: 100 },
		dependencies: [{ param: "chromaKey.enabled", equals: true }],
	},
	{
		key: "chromaKey.invert",
		label: "Invert",
		type: "boolean",
		default: CHROMA_KEY_DEFAULTS.invert,
		keyframable: false,
		dependencies: [{ param: "chromaKey.enabled", equals: true }],
	},
];

/** Smart (AI) cutout switch of a video clip; the "Smart cutout" section of the Background tab sets it. */
const smartCutoutElementParams: ElementParamDefinition[] = [
	{
		key: SMART_CUTOUT_ENABLED_KEY,
		label: "Smart cutout",
		type: "boolean",
		default: false,
		keyframable: false,
	},
];

export const CHROMA_KEY_PARAM_LIST: readonly string[] = chromaKeyElementParams.map(
	(param) => param.key,
);

const layer3DElementParams: ElementParamDefinition[] = [
	{
		key: LAYER_3D_ENABLED_KEY,
		label: "3D Layer",
		type: "boolean",
		default: false,
		keyframable: false,
	},
	layer3DNumberParam({ key: LAYER_3D_KEYS.positionX, label: "Position X" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.positionY, label: "Position Y" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.positionZ, label: "Position Z" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.orientationX, label: "Orientation X" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.orientationY, label: "Orientation Y" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.orientationZ, label: "Orientation Z" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.rotationX, label: "Rotation X" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.rotationY, label: "Rotation Y" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.rotationZ, label: "Rotation Z" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.scaleX, label: "Scale X" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.scaleY, label: "Scale Y" }),
	layer3DNumberParam({ key: LAYER_3D_KEYS.scaleZ, label: "Scale Z" }),
];

/** The param keys of a 3D layer, in the order the 3D tab lists them. */
export const LAYER_3D_PARAM_KEYS: readonly string[] = layer3DElementParams.map(
	(param) => param.key,
);

const LAYER_3D_PARAM_KEY_SET = new Set(LAYER_3D_PARAM_KEYS);

export function isLayer3DParamKey({ key }: { key: string }): boolean {
	return LAYER_3D_PARAM_KEY_SET.has(key);
}

export const elementParamRegistry = new DefinitionRegistry<
	ElementType,
	readonly ElementParamDefinition[]
>("element params");

elementParamRegistry.register({
	key: "video",
	definition: [
		...visualElementParams,
		...chromaKeyElementParams,
		...smartCutoutElementParams,
		...audioElementParams,
	],
});
elementParamRegistry.register({
	key: "image",
	definition: [
		...visualElementParams,
		...chromaKeyElementParams,
		...layer3DElementParams,
	],
});
elementParamRegistry.register({
	key: "text",
	definition: [
		...textElementParams,
		...visualElementParams,
		...layer3DElementParams,
	],
});
elementParamRegistry.register({
	key: "sticker",
	definition: [
		...visualElementParams,
		...chromaKeyElementParams,
		...layer3DElementParams,
	],
});
elementParamRegistry.register({
	key: "graphic",
	definition: [...visualElementParams, ...layer3DElementParams],
});
elementParamRegistry.register({ key: "audio", definition: audioElementParams });
elementParamRegistry.register({ key: "effect", definition: [] });

export function getElementParams({
	element,
}: {
	element: TimelineElement;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(element.type)
		? elementParamRegistry.get(element.type)
		: [];
}

export function getBuiltInElementParams({
	type,
}: {
	type: ElementType;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(type) ? elementParamRegistry.get(type) : [];
}

export function getElementParam({
	element,
	key,
}: {
	element: TimelineElement;
	key: string;
}): ElementParamDefinition | null {
	return (
		getElementParams({ element }).find((param) => param.key === key) ?? null
	);
}

export function readElementParamValue({
	element,
	param,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
}): ParamValue | null {
	if (param.read) {
		return param.read({ element });
	}
	if ("params" in element) {
		return element.params[param.key] ?? param.default;
	}
	return null;
}

export function writeElementParamValue({
	element,
	param,
	value,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
	value: ParamValue;
}): TimelineElement {
	if (param.write) {
		return param.write({ element, value });
	}
	if ("params" in element) {
		return {
			...element,
			params: {
				...element.params,
				[param.key]: value,
			},
		};
	}
	return element;
}

export function buildElementParamValues({
	element,
}: {
	element: TimelineElement;
}): ParamValues {
	const values: ParamValues = {};
	for (const param of getElementParams({ element })) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

