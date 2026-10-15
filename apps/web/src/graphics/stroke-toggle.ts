import { buildGraphicParamPath } from "@/animation/graphic-param-channel";
import { hasKeyframesForPath } from "@/animation/keyframe-query";
import type { ParamValues } from "@/params";
import type { GraphicElement } from "@/timeline";
import { resolveGraphicElementParamsAtTime } from "./index";

export type StrokeToggleAction =
	| { kind: "params"; params: ParamValues }
	| { kind: "key"; propertyPath: string; time: number; value: number };

export interface StrokeTogglePlan {
	/** Whether the stroke is on, as drawn at the playhead. */
	wasEnabled: boolean;
	/** The width that was showing when the stroke is turned off, to bring back later. */
	widthToRemember: number | null;
	action: StrokeToggleAction;
}

/**
 * What the Stroke section's +/- button does.
 *
 * Without keys on the stroke width it flips the fixed width between 0 and the
 * remembered one, as before. With keys the fixed width is ignored by the
 * renderer, so writing it would look like a dead button; the button then works
 * on what is drawn at the playhead: it writes a key there (0 to turn the stroke
 * off, the remembered width to turn it on), and the other keys stay.
 */
export function planStrokeToggle({
	element,
	localTime,
	rememberedWidth,
}: {
	element: GraphicElement;
	localTime: number;
	rememberedWidth: number;
}): StrokeTogglePlan {
	const path = buildGraphicParamPath({ paramKey: "strokeWidth" });
	const isKeyed = hasKeyframesForPath({
		animations: element.animations,
		propertyPath: path,
	});

	if (!isKeyed) {
		const fixed = Number(element.params.strokeWidth ?? 0);
		const wasEnabled = fixed > 0;
		return {
			wasEnabled,
			widthToRemember: wasEnabled ? fixed : null,
			action: {
				kind: "params",
				params: {
					...element.params,
					strokeWidth: wasEnabled ? 0 : rememberedWidth,
				},
			},
		};
	}

	const time = Math.min(element.duration, Math.max(0, Math.round(localTime)));
	const shown = Number(
		resolveGraphicElementParamsAtTime({ element, localTime: time }).strokeWidth ?? 0,
	);
	const wasEnabled = shown > 0;
	return {
		wasEnabled,
		widthToRemember: wasEnabled ? shown : null,
		action: {
			kind: "key",
			propertyPath: path,
			time,
			value: wasEnabled ? 0 : rememberedWidth,
		},
	};
}
