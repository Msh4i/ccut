import { describe, expect, test } from "bun:test";
import {
	buildChosenAnimation,
	buildPresetAnimation,
	choosePreset,
	getPresetDefinition,
	type PresetAnimationId,
	type PresetAnimations,
	type PresetDefinition,
} from "@/animation/presets";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

function seconds(value: number) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function definition(id: PresetAnimationId): PresetDefinition {
	const found = getPresetDefinition(id);
	if (!found) throw new Error(`missing preset ${id}`);
	return found;
}

const CLIP = seconds(4);

function chosenSeconds({
	presetAnimations,
	phase,
	id,
	duration = CLIP,
}: {
	presetAnimations: PresetAnimations | undefined;
	phase: "in" | "out";
	id: PresetAnimationId;
	duration?: number;
}): number {
	const animation = buildChosenAnimation({
		presetAnimations,
		phase,
		definition: definition(id),
		duration,
	});
	expect(animation.id).toBe(id);
	return animation.duration / TICKS_PER_SECOND;
}

describe("buildChosenAnimation: what clicking a preset tile stores", () => {
	test("a phase without a preset gets the preset's default length", () => {
		expect(chosenSeconds({ presetAnimations: undefined, phase: "in", id: "fade" })).toBe(0.5);
		expect(chosenSeconds({ presetAnimations: undefined, phase: "out", id: "typewriter" })).toBe(1);
	});

	test("switching presets keeps the length shown", () => {
		const presetAnimations = { in: { id: "fade" as const, duration: seconds(2) } };
		expect(chosenSeconds({ presetAnimations, phase: "in", id: "slide-left" })).toBe(2);
	});

	test("switching on a squeezed clip keeps the squeezed length, which is the one that plays", () => {
		const presetAnimations = {
			in: { id: "fade" as const, duration: seconds(3) },
			out: { id: "fade" as const, duration: seconds(3) },
		};
		expect(chosenSeconds({ presetAnimations, phase: "in", id: "zoom" })).toBe(2);
	});

	test("the default is cut to the room the other phase leaves", () => {
		const presetAnimations = { out: { id: "fade" as const, duration: seconds(3.8) } };
		expect(chosenSeconds({ presetAnimations, phase: "in", id: "fade" })).toBeCloseTo(0.2, 9);
	});

	test("the default is cut to a clip shorter than it", () => {
		expect(
			chosenSeconds({ presetAnimations: undefined, phase: "in", id: "fade", duration: seconds(0.3) }),
		).toBeCloseTo(0.3, 9);
	});
});

describe("choosePreset: what a click on a tile changes", () => {
	test("clicking the preset that is already chosen changes nothing (no commit, no undo step)", () => {
		const presetAnimations: PresetAnimations = {
			in: { id: "fade", duration: seconds(3) },
			out: { id: "fade", duration: seconds(3) },
		};
		expect(
			choosePreset({ presetAnimations, phase: "in", definition: definition("fade"), duration: CLIP }),
		).toEqual({ changed: false });
	});

	test("None on an empty phase changes nothing", () => {
		const presetAnimations: PresetAnimations = { out: { id: "fade", duration: seconds(1) } };
		expect(choosePreset({ presetAnimations, phase: "in", definition: undefined, duration: CLIP })).toEqual({
			changed: false,
		});
		expect(
			choosePreset({ presetAnimations: undefined, phase: "out", definition: undefined, duration: CLIP }),
		).toEqual({ changed: false });
	});

	test("None clears its phase and keeps the other", () => {
		const presetAnimations: PresetAnimations = {
			in: { id: "zoom", duration: seconds(1) },
			out: { id: "fade", duration: seconds(1) },
		};
		expect(choosePreset({ presetAnimations, phase: "in", definition: undefined, duration: CLIP })).toEqual({
			changed: true,
			presetAnimations: { out: { id: "fade", duration: seconds(1) } },
		});
		expect(
			choosePreset({
				presetAnimations: { in: { id: "zoom", duration: seconds(1) } },
				phase: "in",
				definition: undefined,
				duration: CLIP,
			}),
		).toEqual({ changed: true, presetAnimations: undefined });
	});

	test("another preset is stored with the length a switch keeps", () => {
		const presetAnimations: PresetAnimations = { in: { id: "fade", duration: seconds(2) } };
		expect(
			choosePreset({ presetAnimations, phase: "in", definition: definition("slide-left"), duration: CLIP }),
		).toEqual({ changed: true, presetAnimations: { in: { id: "slide-left", duration: seconds(2) } } });
		expect(
			choosePreset({ presetAnimations, phase: "out", definition: definition("pop"), duration: CLIP }),
		).toEqual({
			changed: true,
			presetAnimations: {
				in: { id: "fade", duration: seconds(2) },
				out: { id: "pop", duration: seconds(0.5) },
			},
		});
	});
});

describe("buildPresetAnimation: a length typed or dragged in the Duration field", () => {
	test("is clamped to the 0.1 s floor and to the room", () => {
		const shortest = buildPresetAnimation({
			presetAnimations: undefined,
			phase: "in",
			id: "fade",
			seconds: 0.01,
			duration: CLIP,
		});
		expect(shortest.duration / TICKS_PER_SECOND).toBeCloseTo(0.1, 9);
		const longest = buildPresetAnimation({
			presetAnimations: { out: { id: "fade", duration: seconds(1) } },
			phase: "in",
			id: "fade",
			seconds: 10,
			duration: CLIP,
		});
		expect(longest.duration / TICKS_PER_SECOND).toBe(3);
	});
});
