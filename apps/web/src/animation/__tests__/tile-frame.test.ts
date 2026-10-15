import { describe, expect, test } from "bun:test";
import {
	PRESET_DEFINITIONS,
	applyPresetsAtTime,
	getPhaseProgress,
	type PresetDefinition,
	type PresetPhase,
} from "@/animation/presets";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import {
	TILE_CANVAS,
	getTileBox,
	getTileContext,
	tileFrameAt,
	tileFrameStyle,
	type TileCanvas,
	type TileFrame,
} from "@/animation/tiles/frame";
import { mediaTime } from "@/wasm";

/** A 160 x 100 tile with a 120 x 40 box (the text box) centred in it. */
const TILE: TileCanvas = { width: 160, height: 100, box: { width: 120, height: 40 } };
const PROGRESSES = [0, 0.25, 0.5, 0.75, 1];
const PHASES: PresetPhase[] = ["in", "out"];

/**
 * What the tile must show when the preset is evaluated at `evaluateAt`, built
 * by hand from the definition: the box centred, opacity and scale multiplied
 * onto 1 (with the renderer's scale floor), position added onto 0.
 */
function expectedFrame({
	definition,
	evaluateAt,
}: {
	definition: PresetDefinition;
	evaluateAt: number;
}): TileFrame {
	const delta = definition.evaluate({
		progress: evaluateAt,
		context: {
			canvasWidth: 160,
			canvasHeight: 100,
			position: { x: 0, y: 0 },
			bounds: { left: -60, right: 60, top: -20, bottom: 20 },
		},
	});
	const scale = delta.scale ?? 1;
	return {
		opacity: delta.opacity ?? 1,
		scale: Math.abs(scale) >= MIN_TRANSFORM_SCALE ? scale : MIN_TRANSFORM_SCALE,
		translateX: 0 + (delta.x ?? 0),
		translateY: 0 + (delta.y ?? 0),
		reveal: delta.reveal,
	};
}

function definitionOf(id: string): PresetDefinition {
	const definition = PRESET_DEFINITIONS.find((entry) => entry.id === id);
	if (!definition) throw new Error(`missing preset ${id}`);
	return definition;
}

describe("tileFrameAt: the preset's own evaluate, mapped onto the tile", () => {
	for (const definition of PRESET_DEFINITIONS) {
		test(`${definition.id}: In at progress p is evaluate(p)`, () => {
			for (const progress of PROGRESSES) {
				expect(
					tileFrameAt({ definition, phase: "in", progress, tile: TILE }),
				).toEqual(expectedFrame({ definition, evaluateAt: progress }));
			}
		});

		test(`${definition.id}: Out at progress p is evaluate(1 - p), In played backwards`, () => {
			for (const progress of PROGRESSES) {
				expect(
					tileFrameAt({ definition, phase: "out", progress, tile: TILE }),
				).toEqual(expectedFrame({ definition, evaluateAt: 1 - progress }));
			}
		});
	}

	test("Out starts at rest and ends where In starts", () => {
		for (const definition of PRESET_DEFINITIONS) {
			expect(
				tileFrameAt({ definition, phase: "out", progress: 0, tile: TILE }),
			).toEqual(tileFrameAt({ definition, phase: "in", progress: 1, tile: TILE }));
			expect(
				tileFrameAt({ definition, phase: "out", progress: 1, tile: TILE }),
			).toEqual(tileFrameAt({ definition, phase: "in", progress: 0, tile: TILE }));
		}
	});

	test("a slide starts with the box just off the tile edge, like a clip on the canvas", () => {
		const at = ({ id, phase, progress }: { id: string; phase: PresetPhase; progress: number }) =>
			tileFrameAt({ definition: definitionOf(id), phase, progress, tile: TILE });
		// Box right edge (-140 + 60) on the tile's left edge (-80).
		expect(at({ id: "slide-left", phase: "in", progress: 0 }).translateX).toBe(-140);
		expect(at({ id: "slide-right", phase: "in", progress: 0 }).translateX).toBe(140);
		// Box bottom edge (-70 + 20) on the tile's top edge (-50).
		expect(at({ id: "slide-up", phase: "in", progress: 0 }).translateY).toBe(-70);
		expect(at({ id: "slide-down", phase: "in", progress: 0 }).translateY).toBe(70);
		expect(at({ id: "slide-left", phase: "out", progress: 1 }).translateX).toBe(-140);
		for (const id of ["slide-left", "slide-right", "slide-up", "slide-down"]) {
			const rest = at({ id, phase: "in", progress: 1 });
			expect(Math.abs(rest.translateX) + Math.abs(rest.translateY)).toBe(0);
		}
	});

	test("the reveal presets pass the renderer's reveal through, Out counting down", () => {
		expect(
			tileFrameAt({ definition: definitionOf("typewriter"), phase: "in", progress: 0.25, tile: TILE }).reveal,
		).toEqual({ unit: "grapheme", fraction: 0.25 });
		expect(
			tileFrameAt({ definition: definitionOf("word-reveal"), phase: "out", progress: 0.25, tile: TILE }).reveal,
		).toEqual({ unit: "word", fraction: 0.75 });
		expect(
			tileFrameAt({ definition: definitionOf("fade"), phase: "in", progress: 0.25, tile: TILE }).reveal,
		).toBeUndefined();
	});

	test("pop's first frame keeps the renderer's minimum scale instead of collapsing to 0", () => {
		const frame = tileFrameAt({ definition: definitionOf("pop"), phase: "in", progress: 0, tile: TILE });
		expect(frame.scale).toBe(MIN_TRANSFORM_SCALE);
	});

	test("a progress that is not a number is the phase start, never NaN", () => {
		for (const progress of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			for (const definition of PRESET_DEFINITIONS) {
				for (const phase of PHASES) {
					const frame = tileFrameAt({ definition, phase, progress, tile: TILE });
					expect(frame).toEqual(tileFrameAt({ definition, phase, progress: 0, tile: TILE }));
				}
			}
		}
	});

	test("progress outside 0..1 is clamped", () => {
		const fade = definitionOf("fade");
		expect(tileFrameAt({ definition: fade, phase: "in", progress: -2, tile: TILE }).opacity).toBe(0);
		expect(tileFrameAt({ definition: fade, phase: "in", progress: 3, tile: TILE }).opacity).toBe(1);
		expect(tileFrameAt({ definition: fade, phase: "out", progress: 3, tile: TILE }).opacity).toBe(0);
	});
});

describe("the tile and the renderer share the In/Out mapping", () => {
	/**
	 * The renderer's own path (`applyPresetsAtTime`, used by preview and
	 * export) on a clip of 1 tick whose phase lasts the whole clip, with the
	 * tile's canvas and the box at the canvas centre.
	 */
	function rendererFrame({
		definition,
		phase,
		progress,
	}: {
		definition: PresetDefinition;
		phase: PresetPhase;
		progress: number;
	}): TileFrame {
		const animation = { id: definition.id, duration: mediaTime({ ticks: 1 }) };
		const { transform, opacity, reveal } = applyPresetsAtTime({
			presetAnimations: phase === "in" ? { in: animation } : { out: animation },
			localTime: progress,
			duration: 1,
			canvasWidth: TILE.width,
			canvasHeight: TILE.height,
			transform: { position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotate: 0 },
			opacity: 1,
			rect: { left: -60, top: -20, width: 120, height: 40 },
		});
		return {
			opacity,
			scale: transform.scaleX,
			translateX: transform.position.x,
			translateY: transform.position.y,
			reveal,
		};
	}

	for (const phase of PHASES) {
		test(`${phase}: every preset at every progress matches the renderer`, () => {
			for (const definition of PRESET_DEFINITIONS) {
				for (const progress of PROGRESSES) {
					const tile = tileFrameAt({ definition, phase, progress, tile: TILE });
					const renderer = rendererFrame({ definition, phase, progress });
					const isRendererAtRest =
						(phase === "in" && progress === 1) || (phase === "out" && progress === 0);
					if (isRendererAtRest) {
						// The renderer does not animate at the phase's rest edge (no
						// reveal at all); the tile shows evaluate(1), which is the
						// same pose with the whole text revealed.
						expect(renderer.reveal).toBeUndefined();
						expect(tile.reveal === undefined || tile.reveal.fraction === 1).toBe(true);
						const pose: TileFrame = { ...tile, reveal: undefined };
						expect(pose).toEqual(renderer);
						continue;
					}
					expect(tile).toEqual(renderer);
				}
			}
		});
	}

	test("getPhaseProgress: In counts from the clip start, Out from the clip end", () => {
		expect(getPhaseProgress({ phase: "in", localTime: 250, duration: 4000, length: 1000 })).toBe(0.25);
		expect(getPhaseProgress({ phase: "out", localTime: 3750, duration: 4000, length: 1000 })).toBe(0.25);
		expect(getPhaseProgress({ phase: "out", localTime: 4000, duration: 4000, length: 1000 })).toBe(0);
		expect(getPhaseProgress({ phase: "in", localTime: -5, duration: 4000, length: 1000 })).toBe(0);
		expect(getPhaseProgress({ phase: "out", localTime: 0, duration: 4000, length: 1000 })).toBe(1);
	});

	test("getPhaseProgress: a phase without length is at rest (1), never NaN or Infinity", () => {
		for (const length of [0, -1, Number.NaN]) {
			for (const phase of PHASES) {
				expect(getPhaseProgress({ phase, localTime: 0, duration: 4000, length })).toBe(1);
				expect(getPhaseProgress({ phase, localTime: 4000, duration: 4000, length })).toBe(1);
			}
		}
	});
});

describe("tile geometry", () => {
	test("the tile is a 16:10 canvas", () => {
		expect(TILE_CANVAS.width / TILE_CANVAS.height).toBe(1.6);
	});

	test("text gets a wide, low box", () => {
		expect(getTileBox({ kind: "text" })).toEqual({ width: 120, height: 40 });
	});

	test("a picture keeps its aspect inside a 100 x 64 box", () => {
		expect(getTileBox({ kind: "picture", aspect: 16 / 9 })).toEqual({ width: 100, height: 56.25 });
		expect(getTileBox({ kind: "picture", aspect: 9 / 16 })).toEqual({ width: 36, height: 64 });
		expect(getTileBox({ kind: "picture", aspect: 1 })).toEqual({ width: 64, height: 64 });
	});

	test("an aspect that is not a positive number falls back to 16:9", () => {
		for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(getTileBox({ kind: "picture", aspect })).toEqual({ width: 100, height: 56.25 });
		}
	});

	test("the context centres the box in the tile", () => {
		expect(getTileContext({ tile: TILE })).toEqual({
			canvasWidth: 160,
			canvasHeight: 100,
			position: { x: 0, y: 0 },
			bounds: { left: -60, right: 60, top: -20, bottom: 20 },
		});
	});
});

describe("tileFrameStyle: the frame as CSS on the moving box", () => {
	test("translation is a percentage of the box, so it scales with the tile on screen", () => {
		const style = tileFrameStyle({
			frame: { opacity: 0.5, scale: 1.25, translateX: -140, translateY: 10, reveal: undefined },
			tile: TILE,
		});
		expect(style).toEqual({ transform: "translate(-116.667%, 25%) scale(1.25)", opacity: "0.5" });
	});

	test("the rest frame is the identity", () => {
		expect(
			tileFrameStyle({
				frame: { opacity: 1, scale: 1, translateX: 0, translateY: 0, reveal: undefined },
				tile: TILE,
			}),
		).toEqual({ transform: "translate(0%, 0%) scale(1)", opacity: "1" });
	});

	test("an empty box never produces NaN or Infinity", () => {
		const style = tileFrameStyle({
			frame: { opacity: 1, scale: 1, translateX: 20, translateY: -20, reveal: undefined },
			tile: { width: 160, height: 100, box: { width: 0, height: 0 } },
		});
		expect(style.transform).toBe("translate(0%, 0%) scale(1)");
	});
});
