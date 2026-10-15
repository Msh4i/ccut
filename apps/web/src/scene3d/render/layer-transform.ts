import { resolveAnimationPathValueAtTime } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";
import {
	LAYER_3D_DEFAULTS,
	LAYER_3D_ENABLED_KEY,
	transform3DFromParams,
} from "../layer-params";
import type { Transform3D } from "../types";

function isLayer3DKey(key: string): key is keyof typeof LAYER_3D_DEFAULTS {
	return key in LAYER_3D_DEFAULTS;
}

/**
 * The 3D transform of an element at its local time: the stored
 * `transform3d.*` params with their keyframes resolved (the animation path of
 * a param is its key, like `transform.positionX`). `null` for a 2D element.
 */
export function resolveTransform3DAtTime({
	params,
	animations,
	localTime,
}: {
	params: ParamValues;
	animations: ElementAnimations | undefined;
	localTime: number;
}): Transform3D | null {
	const time = Math.max(0, localTime);
	return transform3DFromParams((key) => {
		const base = params[key];
		if (key === LAYER_3D_ENABLED_KEY) {
			return resolveAnimationPathValueAtTime({
				animations,
				propertyPath: key,
				localTime: time,
				fallbackValue: base === true,
			});
		}
		if (!isLayer3DKey(key)) return base;
		const fallbackValue =
			typeof base === "number" && Number.isFinite(base) ? base : LAYER_3D_DEFAULTS[key];
		return resolveAnimationPathValueAtTime({
			animations,
			propertyPath: key,
			localTime: time,
			fallbackValue,
		});
	});
}
