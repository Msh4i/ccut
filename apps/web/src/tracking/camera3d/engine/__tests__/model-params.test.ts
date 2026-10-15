import { describe, expect, test } from "bun:test";
import { getElementKeyframes, isAnimationPath } from "@/animation";
import { ANIMATION_PROPERTY_PATHS } from "@/animation/types";
import {
	getBuiltInElementParams,
	getElementParam,
	LAYER_3D_PARAM_KEYS,
} from "@/params/registry";
import { LAYER_3D_DEFAULTS, LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS } from "@/scene3d/layer-params";
import type { ElementType, TextElement, TimelineElement } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { getExpandedRows } from "@/timeline/components/expanded-layout";
import { DEFAULTS } from "@/timeline/defaults";
import {
	buildCameraElement,
	buildGraphicElement,
	buildStickerElement,
	buildTextElement,
} from "@/timeline/element-utils";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const NUMERIC_KEYS = Object.values(LAYER_3D_KEYS);
const ALL_3D_KEYS = [LAYER_3D_ENABLED_KEY, ...NUMERIC_KEYS];
const LAYER_TYPES: ElementType[] = ["text", "image", "sticker", "graphic"];
const OTHER_TYPES: ElementType[] = ["video", "audio", "effect", "camera"];

function text(params: TextElement["params"] = { content: "Hi" }): TextElement {
	return {
		id: "t",
		type: "text",
		name: "T",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 120000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params,
	};
}

describe("3D layer params in the element params registry", () => {
	test("text, image, sticker and graphic have the 13 keys of layer-params.ts", () => {
		for (const type of LAYER_TYPES) {
			const keys = getBuiltInElementParams({ type }).map((param) => param.key);
			for (const key of ALL_3D_KEYS) expect(keys).toContain(key);
		}
		expect([...LAYER_3D_PARAM_KEYS].sort()).toEqual([...ALL_3D_KEYS].sort());
	});

	test("video, audio, effect and camera do not get them", () => {
		for (const type of OTHER_TYPES) {
			const keys = getBuiltInElementParams({ type }).map((param) => param.key);
			for (const key of ALL_3D_KEYS) expect(keys).not.toContain(key);
		}
	});

	test("labels, defaults and kinds match the 3D contract", () => {
		const element = text();
		const enabled = getElementParam({ element, key: LAYER_3D_ENABLED_KEY });
		expect(enabled).toMatchObject({ type: "boolean", default: false, keyframable: false });
		const expectedLabels: Record<string, string> = {
			[LAYER_3D_KEYS.positionX]: "Position X",
			[LAYER_3D_KEYS.positionY]: "Position Y",
			[LAYER_3D_KEYS.positionZ]: "Position Z",
			[LAYER_3D_KEYS.orientationX]: "Orientation X",
			[LAYER_3D_KEYS.orientationY]: "Orientation Y",
			[LAYER_3D_KEYS.orientationZ]: "Orientation Z",
			[LAYER_3D_KEYS.rotationX]: "Rotation X",
			[LAYER_3D_KEYS.rotationY]: "Rotation Y",
			[LAYER_3D_KEYS.rotationZ]: "Rotation Z",
			[LAYER_3D_KEYS.scaleX]: "Scale X",
			[LAYER_3D_KEYS.scaleY]: "Scale Y",
			[LAYER_3D_KEYS.scaleZ]: "Scale Z",
		};
		for (const key of NUMERIC_KEYS) {
			const param = getElementParam({ element, key });
			expect(param?.type).toBe("number");
			expect(param?.label).toBe(expectedLabels[key]);
			expect(param?.default).toBe(LAYER_3D_DEFAULTS[key]);
			expect(param?.keyframable).not.toBe(false);
		}
	});

	test("ranges keep the values Track Camera writes (no clamping of a placed layer)", () => {
		const element = text();
		const position = getElementParam({ element, key: LAYER_3D_KEYS.positionZ });
		const orientation = getElementParam({ element, key: LAYER_3D_KEYS.orientationY });
		const scale = getElementParam({ element, key: LAYER_3D_KEYS.scaleX });
		if (position?.type !== "number" || orientation?.type !== "number" || scale?.type !== "number") {
			throw new Error("3D params are not numbers");
		}
		expect(position.min).toBeLessThanOrEqual(-100_000);
		expect(position.max ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(100_000);
		expect(orientation.min).toBeLessThanOrEqual(-180);
		expect(orientation.max ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(180);
		expect(scale.min).toBeLessThanOrEqual(0.0001);
	});

	test("new elements stay 2D: the builders write no 3D keys (absent = 2D)", () => {
		const built = [
			buildTextElement({ raw: DEFAULTS.text.element, startTime: ZERO_MEDIA_TIME }),
			buildGraphicElement({ definitionId: "rectangle", startTime: ZERO_MEDIA_TIME }),
			buildStickerElement({ stickerId: "shapes:square", startTime: ZERO_MEDIA_TIME }),
			buildCameraElement({ sourceElementId: "v", startTime: ZERO_MEDIA_TIME, duration: mediaTime({ ticks: 1 }) }),
		];
		for (const element of built) {
			for (const key of ALL_3D_KEYS) expect(Object.keys(element.params)).not.toContain(key);
		}
	});
});

describe("3D layer params are animatable", () => {
	test("the 12 numbers are animation paths, the switch is not", () => {
		for (const key of NUMERIC_KEYS) {
			expect(ANIMATION_PROPERTY_PATHS).toContain(key);
			expect(isAnimationPath(key)).toBe(true);
		}
		expect(isAnimationPath(LAYER_3D_ENABLED_KEY)).toBe(false);
	});

	test("animation targets resolve through the params registry for every layer type", () => {
		const elements: TimelineElement[] = [
			text(),
			{ ...text(), type: "sticker", stickerId: "shapes:square" },
			{ ...text(), type: "graphic", definitionId: "rectangle" },
			{ ...text(), type: "image", mediaId: "m" },
		];
		for (const element of elements) {
			for (const key of NUMERIC_KEYS) {
				const target = resolveAnimationTarget({ element, path: key });
				expect(target).not.toBeNull();
				expect(target?.getBaseValue()).toBe(LAYER_3D_DEFAULTS[key]);
			}
			expect(resolveAnimationTarget({ element, path: LAYER_3D_ENABLED_KEY })).toBeNull();
		}
	});

	test("a video or camera element has no 3D animation target", () => {
		const video: TimelineElement = { ...text(), type: "video", mediaId: "m" };
		const camera: TimelineElement = { ...text(), type: "camera", sourceElementId: "v" };
		expect(resolveAnimationTarget({ element: video, path: LAYER_3D_KEYS.positionX })).toBeNull();
		expect(resolveAnimationTarget({ element: camera, path: LAYER_3D_KEYS.positionX })).toBeNull();
	});

	test("setting a base value writes the param without rounding a tracked position away", () => {
		const target = resolveAnimationTarget({ element: text(), path: LAYER_3D_KEYS.positionX });
		const next = target?.setBaseValue({ value: 12.34 });
		expect(next?.params[LAYER_3D_KEYS.positionX]).toBeCloseTo(12.34, 9);
	});

	test("keyframes on a 3D channel are listed and get their own keyframe lane", () => {
		const element = text();
		element.animations = {
			[LAYER_3D_KEYS.positionZ]: {
				keys: [
					{ id: "a", time: ZERO_MEDIA_TIME, value: 5, segmentToNext: "linear", tangentMode: "flat" },
					{ id: "b", time: mediaTime({ ticks: 60000 }), value: 9, segmentToNext: "linear", tangentMode: "flat" },
				],
			},
		};
		const keyframes = getElementKeyframes({ animations: element.animations });
		expect(keyframes.map((keyframe) => keyframe.propertyPath)).toEqual([
			LAYER_3D_KEYS.positionZ,
			LAYER_3D_KEYS.positionZ,
		]);
		expect(getExpandedRows({ animations: element.animations })).toEqual([
			{ propertyPath: LAYER_3D_KEYS.positionZ, label: "3D Position Z" },
		]);
	});
});
