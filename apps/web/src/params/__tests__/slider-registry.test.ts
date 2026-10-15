import { describe, expect, test } from "bun:test";
import { effectsRegistry, registerDefaultEffects } from "@/effects";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { masksRegistry, registerDefaultMasks } from "@/masks";
import {
	getDisplayParam,
	type NumberParamDefinition,
	type ParamDefinition,
} from "@/params";
import { elementParamRegistry } from "@/params/registry";
import { resolveSliderSpec } from "@/params/slider";
import { snapToStep } from "@/utils/math";

registerDefaultEffects();
registerDefaultGraphics();
registerDefaultMasks();

const groups: Array<{ name: string; params: ParamDefinition[] }> = [
	...elementParamRegistry
		.getAll()
		.map((params, index) => ({
			name: `element ${index}`,
			params: [...params],
		})),
	...masksRegistry
		.getAll()
		.map((definition) => ({
			name: `mask ${definition.type}`,
			params: definition.params,
		})),
	...graphicsRegistry
		.getAll()
		.map((definition) => ({
			name: `graphic ${definition.id}`,
			params: definition.params,
		})),
	...effectsRegistry
		.getAll()
		.map((definition) => ({
			name: `effect ${definition.type}`,
			params: definition.params,
		})),
];

function numberParams({ params }: { params: ParamDefinition[] }) {
	return params.filter(
		(param): param is NumberParamDefinition => param.type === "number",
	);
}

describe("registered slider specs", () => {
	test("the registries contain number params", () => {
		const total = groups.reduce(
			(sum, group) => sum + numberParams({ params: group.params }).length,
			0,
		);
		expect(total).toBeGreaterThan(20);
	});

	for (const group of groups) {
		for (const param of numberParams({ params: group.params })) {
			test(`${group.name} / ${param.key}: bar is consistent with the param`, () => {
				const display = getDisplayParam({ param });
				const spec = resolveSliderSpec({ param: display });
				if (!spec) return;

				const multiplier = display.displayMultiplier ?? 1;
				const displayDefault = snapToStep({
					value: param.default * multiplier,
					step: display.step,
				});

				expect(spec.max).toBeGreaterThan(spec.min);
				expect(spec.min).toBeGreaterThanOrEqual(display.min);
				if (display.max !== undefined) {
					expect(spec.max).toBeLessThanOrEqual(display.max);
				}
				expect(displayDefault).toBeGreaterThanOrEqual(spec.min);
				expect(displayDefault).toBeLessThanOrEqual(spec.max);
				if (spec.pivot !== undefined) {
					expect(spec.pivot).toBeGreaterThan(spec.min);
					expect(spec.pivot).toBeLessThan(spec.max);
				}
			});
		}
	}
});
