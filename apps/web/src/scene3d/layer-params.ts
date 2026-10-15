import type { Transform3D } from "./types";

/**
 * Param keys of a 3D layer (AE's 3D layer switch and its transform). They
 * live in the element's flat `params` like the 2D `transform.*` keys, so
 * they are saved with the project, edited in the properties panel and
 * keyframed through the normal animation channels. When
 * `transform3d.enabled` is true the 2D `transform.*` params are ignored by
 * the renderer and the layer is drawn through the active camera.
 */
export const LAYER_3D_ENABLED_KEY = "transform3d.enabled";

export const LAYER_3D_KEYS = {
	positionX: "transform3d.positionX",
	positionY: "transform3d.positionY",
	positionZ: "transform3d.positionZ",
	orientationX: "transform3d.orientationX",
	orientationY: "transform3d.orientationY",
	orientationZ: "transform3d.orientationZ",
	rotationX: "transform3d.rotationX",
	rotationY: "transform3d.rotationY",
	rotationZ: "transform3d.rotationZ",
	scaleX: "transform3d.scaleX",
	scaleY: "transform3d.scaleY",
	scaleZ: "transform3d.scaleZ",
} as const;

export type Layer3DKey = (typeof LAYER_3D_KEYS)[keyof typeof LAYER_3D_KEYS];

export const LAYER_3D_DEFAULTS: Record<Layer3DKey, number> = {
	"transform3d.positionX": 0,
	"transform3d.positionY": 0,
	"transform3d.positionZ": 0,
	"transform3d.orientationX": 0,
	"transform3d.orientationY": 0,
	"transform3d.orientationZ": 0,
	"transform3d.rotationX": 0,
	"transform3d.rotationY": 0,
	"transform3d.rotationZ": 0,
	"transform3d.scaleX": 1,
	"transform3d.scaleY": 1,
	"transform3d.scaleZ": 1,
};

type ParamRead = (key: string) => number | string | boolean | undefined;

function numberAt({ read, key }: { read: ParamRead; key: Layer3DKey }): number {
	const value = read(key);
	return typeof value === "number" && Number.isFinite(value)
		? value
		: LAYER_3D_DEFAULTS[key];
}

/** Whether the params mark the element as a 3D layer. */
export function isLayer3D(read: ParamRead): boolean {
	return read(LAYER_3D_ENABLED_KEY) === true;
}

/**
 * The 3D transform of a layer from (resolved, possibly animated) param
 * values, or `null` when the layer is not 3D. Missing or non-finite values
 * fall back to the defaults.
 */
export function transform3DFromParams(read: ParamRead): Transform3D | null {
	if (!isLayer3D(read)) return null;
	const at = (key: Layer3DKey) => numberAt({ read, key });
	return {
		position: [
			at(LAYER_3D_KEYS.positionX),
			at(LAYER_3D_KEYS.positionY),
			at(LAYER_3D_KEYS.positionZ),
		],
		orientationDeg: [
			at(LAYER_3D_KEYS.orientationX),
			at(LAYER_3D_KEYS.orientationY),
			at(LAYER_3D_KEYS.orientationZ),
		],
		rotationDeg: [
			at(LAYER_3D_KEYS.rotationX),
			at(LAYER_3D_KEYS.rotationY),
			at(LAYER_3D_KEYS.rotationZ),
		],
		scale: [
			at(LAYER_3D_KEYS.scaleX),
			at(LAYER_3D_KEYS.scaleY),
			at(LAYER_3D_KEYS.scaleZ),
		],
	};
}

/** Param values that make an element a 3D layer with `transform`. */
export function paramsFromTransform3D(
	transform: Transform3D,
): Record<string, number | boolean> {
	return {
		[LAYER_3D_ENABLED_KEY]: true,
		[LAYER_3D_KEYS.positionX]: transform.position[0],
		[LAYER_3D_KEYS.positionY]: transform.position[1],
		[LAYER_3D_KEYS.positionZ]: transform.position[2],
		[LAYER_3D_KEYS.orientationX]: transform.orientationDeg[0],
		[LAYER_3D_KEYS.orientationY]: transform.orientationDeg[1],
		[LAYER_3D_KEYS.orientationZ]: transform.orientationDeg[2],
		[LAYER_3D_KEYS.rotationX]: transform.rotationDeg[0],
		[LAYER_3D_KEYS.rotationY]: transform.rotationDeg[1],
		[LAYER_3D_KEYS.rotationZ]: transform.rotationDeg[2],
		[LAYER_3D_KEYS.scaleX]: transform.scale[0],
		[LAYER_3D_KEYS.scaleY]: transform.scale[1],
		[LAYER_3D_KEYS.scaleZ]: transform.scale[2],
	};
}
