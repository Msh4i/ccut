import { describe, expect, test } from "bun:test";
import {
	isLayer3D,
	LAYER_3D_ENABLED_KEY,
	LAYER_3D_KEYS,
	paramsFromTransform3D,
	transform3DFromParams,
} from "../layer-params";
import type { Transform3D } from "../types";

const TRANSFORM: Transform3D = {
	position: [1, -2, 300],
	orientationDeg: [90, 0, -15],
	rotationDeg: [0, 12.5, 0],
	scale: [0.5, 0.5, 1],
};

function reader(params: Record<string, number | string | boolean>) {
	return (key: string) => params[key];
}

describe("3D layer params", () => {
	test("round trip", () => {
		const params = paramsFromTransform3D(TRANSFORM);
		expect(isLayer3D(reader(params))).toBe(true);
		expect(transform3DFromParams(reader(params))).toEqual(TRANSFORM);
	});

	test("not 3D unless enabled is exactly true", () => {
		const params = { ...paramsFromTransform3D(TRANSFORM), [LAYER_3D_ENABLED_KEY]: false };
		expect(transform3DFromParams(reader(params))).toBeNull();
		expect(transform3DFromParams(reader({ [LAYER_3D_ENABLED_KEY]: "true" }))).toBeNull();
	});

	test("missing and non-finite values use the defaults", () => {
		const transform = transform3DFromParams(
			reader({
				[LAYER_3D_ENABLED_KEY]: true,
				[LAYER_3D_KEYS.positionZ]: Number.NaN,
				[LAYER_3D_KEYS.scaleY]: "2",
			}),
		);
		expect(transform).toEqual({
			position: [0, 0, 0],
			orientationDeg: [0, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		});
	});
});
