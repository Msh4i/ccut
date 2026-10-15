import { describe, expect, test } from "bun:test";
import { effectsRegistry, registerDefaultEffects, resolveEffectPasses } from "@/effects";
import { filterDefinitions } from "../filters";

const resolve = ({ type, intensity }: { type: string; intensity: number }) =>
	resolveEffectPasses({
		definition: effectsRegistry.get(type),
		effectParams: { intensity },
		width: 1920,
		height: 1080,
		localTimeSeconds: 1,
		durationSeconds: 5,
	});

describe("filters", () => {
	test("nine filters, all in the filter category with one Intensity slider", () => {
		registerDefaultEffects();
		expect(filterDefinitions).toHaveLength(9);
		for (const definition of filterDefinitions) {
			expect(effectsRegistry.get(definition.type).category).toBe("filter");
			expect(definition.params.map((param) => param.key)).toEqual(["intensity"]);
		}
	});

	test("intensity 0 is no filter at all, intensity scales every pass", () => {
		registerDefaultEffects();
		for (const { type } of filterDefinitions) {
			expect(resolve({ type, intensity: 0 })).toEqual([]);
			const full = resolve({ type, intensity: 100 });
			expect(full.length).toBeGreaterThan(0);
		}
		const [half] = resolve({ type: "filter-cinematic", intensity: 50 });
		expect(half.uniforms.u_intensity).toBe(0.5);
		const [, vignette] = resolve({ type: "filter-cinematic-light", intensity: 50 });
		expect(vignette.uniforms.u_amount).toBeCloseTo(0.275, 9);
	});

	test("Paper and Pencil sketch use the sketch shader, the others the colour grade", () => {
		registerDefaultEffects();
		expect(resolve({ type: "filter-paper", intensity: 100 })[0].shader).toBe("sketch");
		expect(resolve({ type: "filter-pencil", intensity: 100 })[0].shader).toBe("sketch");
		expect(resolve({ type: "filter-bw-film", intensity: 100 }).map((pass) => pass.shader)).toEqual([
			"color-grade",
			"film-grain",
		]);
	});
});
