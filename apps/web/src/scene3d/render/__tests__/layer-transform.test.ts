import { describe, expect, test } from "bun:test";
import type { ElementAnimations } from "@/animation/types";
import { LAYER_3D_ENABLED_KEY, LAYER_3D_KEYS } from "../../layer-params";
import { resolveTransform3DAtTime } from "../layer-transform";
import { seconds } from "./fixtures";

function linearChannel({ from, to }: { from: number; to: number }) {
	return {
		keys: [
			{
				id: "a",
				time: seconds(0),
				value: from,
				segmentToNext: "linear" as const,
				tangentMode: "flat" as const,
			},
			{
				id: "b",
				time: seconds(2),
				value: to,
				segmentToNext: "linear" as const,
				tangentMode: "flat" as const,
			},
		],
	};
}

describe("resolveTransform3DAtTime", () => {
	test("a 2D element (no switch, or the switch off) has no 3D transform", () => {
		expect(resolveTransform3DAtTime({ params: {}, animations: undefined, localTime: 0 })).toBeNull();
		expect(
			resolveTransform3DAtTime({
				params: { [LAYER_3D_ENABLED_KEY]: false, [LAYER_3D_KEYS.positionZ]: 50 },
				animations: undefined,
				localTime: 0,
			}),
		).toBeNull();
	});

	test("static values, with defaults for the missing ones", () => {
		const transform = resolveTransform3DAtTime({
			params: {
				[LAYER_3D_ENABLED_KEY]: true,
				[LAYER_3D_KEYS.positionX]: 10,
				[LAYER_3D_KEYS.positionZ]: -40,
				[LAYER_3D_KEYS.orientationY]: 30,
				[LAYER_3D_KEYS.scaleX]: 2,
			},
			animations: undefined,
			localTime: 0,
		});
		expect(transform).toEqual({
			position: [10, 0, -40],
			orientationDeg: [0, 30, 0],
			rotationDeg: [0, 0, 0],
			scale: [2, 1, 1],
		});
	});

	test("keyframed channels are resolved at the element's local time", () => {
		const animations: ElementAnimations = {
			[LAYER_3D_KEYS.positionZ]: linearChannel({ from: 0, to: 200 }),
			[LAYER_3D_KEYS.rotationY]: linearChannel({ from: -90, to: 90 }),
		};
		const transform = resolveTransform3DAtTime({
			params: { [LAYER_3D_ENABLED_KEY]: true, [LAYER_3D_KEYS.positionZ]: 999 },
			animations,
			localTime: seconds(0.5),
		});
		expect(transform?.position[2]).toBeCloseTo(50, 9);
		expect(transform?.rotationDeg[1]).toBeCloseTo(-45, 9);
	});

	test("non-finite stored values fall back to the defaults", () => {
		const transform = resolveTransform3DAtTime({
			params: {
				[LAYER_3D_ENABLED_KEY]: true,
				[LAYER_3D_KEYS.positionX]: Number.NaN,
				[LAYER_3D_KEYS.scaleY]: Number.POSITIVE_INFINITY,
				[LAYER_3D_KEYS.rotationZ]: "12",
			},
			animations: undefined,
			localTime: 0,
		});
		expect(transform?.position[0]).toBe(0);
		expect(transform?.scale[1]).toBe(1);
		expect(transform?.rotationDeg[2]).toBe(0);
	});
});
