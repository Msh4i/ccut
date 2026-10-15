import { describe, expect, test } from "bun:test";
import {
	PRESET_DEFINITIONS,
	applyPresetDelta,
	getEffectiveDurations,
	getPresetDefinition,
	getPresetRoom,
	getPresetsForElementType,
	getTransformedBounds,
	resolvePresetDelta,
	setPresetPhase,
	splitPresetAnimations,
	type PresetAnimation,
	type PresetAnimationId,
	type PresetAnimations,
	type PresetBounds,
	type PresetContext,
} from "@/animation/presets";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import { VISUAL_ELEMENT_TYPES, type ElementType } from "@/timeline/types";
import type { Transform } from "@/rendering";
import { TICKS_PER_SECOND, mediaTime } from "@/wasm";

// The pure functions do not care about the tick size, so most tests use small
// round numbers. Only the 0.1 s floor needs the real tick rate.
function ticks(value: number) {
	return mediaTime({ ticks: value });
}

function seconds(value: number) {
	return ticks(Math.round(value * TICKS_PER_SECOND));
}

const CLIP = 4000;

function preset({
	id,
	duration,
}: {
	id: PresetAnimationId;
	duration: number;
}): PresetAnimation {
	return { id, duration: ticks(duration) };
}

/**
 * Stored data can hold values the types forbid (JSON turns NaN into null).
 * JSON.parse is the honest way to build such data in a test.
 */
function storedWithDuration(duration: unknown): PresetAnimations {
	return JSON.parse(
		'{"in":{"id":"fade","duration":0}}',
		(key, value) => (key === "duration" ? duration : value),
	);
}

const CONTEXT: PresetContext = {
	canvasWidth: 1920,
	canvasHeight: 1080,
	position: { x: 0, y: 0 },
	bounds: { left: -200, right: 200, top: -100, bottom: 100 },
};

function deltaAt({
	presetAnimations,
	localTime,
	context = CONTEXT,
	duration = CLIP,
}: {
	presetAnimations: PresetAnimations | undefined;
	localTime: number;
	context?: PresetContext;
	duration?: number;
}) {
	return resolvePresetDelta({
		presetAnimations,
		localTime,
		duration,
		getContext: () => context,
	});
}

function evaluateAt({
	id,
	progress,
	context = CONTEXT,
}: {
	id: PresetAnimationId;
	progress: number;
	context?: PresetContext;
}) {
	const definition = getPresetDefinition(id);
	if (!definition) throw new Error(`missing preset ${id}`);
	return definition.evaluate({ progress, context });
}

describe("preset phases", () => {
	test("fade in starts transparent, is half at half time, and ends at identity", () => {
		const presetAnimations = { in: preset({ id: "fade", duration: 1000 }) };
		expect(deltaAt({ presetAnimations, localTime: 0 })).toEqual({ opacity: 0 });
		expect(deltaAt({ presetAnimations, localTime: 500 })).toEqual({
			opacity: 0.5,
		});
		expect(deltaAt({ presetAnimations, localTime: 1000 })).toBeUndefined();
	});

	test("the middle of the clip is untouched", () => {
		const presetAnimations = {
			in: preset({ id: "fade", duration: 1000 }),
			out: preset({ id: "fade", duration: 1000 }),
		};
		expect(deltaAt({ presetAnimations, localTime: 2000 })).toBeUndefined();
		expect(deltaAt({ presetAnimations, localTime: 3000 })).toBeUndefined();
	});

	test("fade out is transparent at the very end and half at half time", () => {
		const presetAnimations = { out: preset({ id: "fade", duration: 1000 }) };
		expect(deltaAt({ presetAnimations, localTime: CLIP })).toEqual({
			opacity: 0,
		});
		expect(deltaAt({ presetAnimations, localTime: 3500 })).toEqual({
			opacity: 0.5,
		});
	});

	test("a clip without presets costs nothing and never builds a context", () => {
		let contextCalls = 0;
		const getContext = () => {
			contextCalls += 1;
			return CONTEXT;
		};
		for (const presetAnimations of [undefined, {}]) {
			expect(
				resolvePresetDelta({
					presetAnimations,
					localTime: 10,
					duration: CLIP,
					getContext,
				}),
			).toBeUndefined();
		}
		expect(
			resolvePresetDelta({
				presetAnimations: { in: preset({ id: "fade", duration: 1000 }) },
				localTime: 2000,
				duration: CLIP,
				getContext,
			}),
		).toBeUndefined();
		expect(contextCalls).toBe(0);
	});

	test("MIRROR: with equal durations, out(D - t) equals in(t) for every registered preset", () => {
		const duration = 1000;
		expect(PRESET_DEFINITIONS.length).toBeGreaterThan(0);
		for (const { id } of PRESET_DEFINITIONS) {
			for (let step = 0; step < 20; step += 1) {
				const time = (duration * step) / 20;
				const incoming = deltaAt({
					presetAnimations: { in: preset({ id, duration }) },
					localTime: time,
				});
				const outgoing = deltaAt({
					presetAnimations: { out: preset({ id, duration }) },
					localTime: CLIP - time,
				});
				expect(incoming).toBeDefined();
				expect(outgoing).toEqual(incoming);
			}
		}
	});

	test("an unknown id (older or newer project) is ignored", () => {
		const presetAnimations: PresetAnimations = JSON.parse(
			'{"in":{"id":"from-the-future","duration":1000}}',
		);
		expect(deltaAt({ presetAnimations, localTime: 0 })).toBeUndefined();
		expect(
			getEffectiveDurations({ presetAnimations, duration: ticks(CLIP) }),
		).toEqual({ in: 0, out: 0 });
		expect(getPresetDefinition("from-the-future")).toBeUndefined();
		expect(getPresetDefinition("constructor")).toBeUndefined();
	});

	test("a zero-length clip yields nothing and does not throw", () => {
		const presetAnimations = {
			in: preset({ id: "fade", duration: 1000 }),
			out: preset({ id: "fade", duration: 1000 }),
		};
		expect(
			getEffectiveDurations({ presetAnimations, duration: ticks(0) }),
		).toEqual({ in: 0, out: 0 });
		expect(
			deltaAt({ presetAnimations, localTime: 0, duration: 0 }),
		).toBeUndefined();
	});
});

describe("effective durations", () => {
	function effective({
		presetAnimations,
		duration = CLIP,
	}: {
		presetAnimations: PresetAnimations;
		duration?: number;
	}) {
		return getEffectiveDurations({ presetAnimations, duration: ticks(duration) });
	}

	test("fits as requested when in + out fit in the clip", () => {
		expect(
			effective({
				presetAnimations: {
					in: preset({ id: "fade", duration: 1000 }),
					out: preset({ id: "zoom", duration: 500 }),
				},
			}),
		).toEqual({ in: 1000, out: 500 });
	});

	test("a 4 s clip with 3 s in and 3 s out becomes 2 s + 2 s", () => {
		expect(
			effective({
				presetAnimations: {
					in: preset({ id: "fade", duration: 3000 }),
					out: preset({ id: "fade", duration: 3000 }),
				},
			}),
		).toEqual({ in: 2000, out: 2000 });
	});

	test("keeps the requested ratio and totals exactly the clip", () => {
		const result = effective({
			presetAnimations: {
				in: preset({ id: "fade", duration: 3000 }),
				out: preset({ id: "fade", duration: 1000 }),
			},
			duration: 2000,
		});
		expect(result.in).toBeCloseTo(1500, 9);
		expect(result.out).toBeCloseTo(500, 9);
		expect(result.in + result.out).toBe(2000);
	});

	test("a single phase longer than the clip becomes the clip", () => {
		expect(
			effective({
				presetAnimations: { in: preset({ id: "fade", duration: 3000 }) },
				duration: 2000,
			}),
		).toEqual({ in: 2000, out: 0 });
	});

	test("zero, negative, NaN, infinite and missing durations count as 0", () => {
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
			expect(effective({ presetAnimations: storedWithDuration(bad) })).toEqual({
				in: 0,
				out: 0,
			});
		}
	});

	test("never rewrites the stored values", () => {
		const presetAnimations: PresetAnimations = Object.freeze({
			in: Object.freeze(preset({ id: "fade", duration: 3000 })),
			out: Object.freeze(preset({ id: "fade", duration: 3000 })),
		});
		effective({ presetAnimations });
		expect(presetAnimations.in?.duration).toBe(ticks(3000));
		expect(presetAnimations.out?.duration).toBe(ticks(3000));
		// Lengthening the clip brings the requested values back.
		expect(effective({ presetAnimations, duration: 8000 })).toEqual({
			in: 3000,
			out: 3000,
		});
	});

	test("the phases never overlap: in ends exactly where out starts", () => {
		const presetAnimations = {
			in: preset({ id: "fade", duration: 3000 }),
			out: preset({ id: "fade", duration: 3000 }),
		};
		// At the shared boundary the clip is at identity, one tick either side is in a phase.
		expect(deltaAt({ presetAnimations, localTime: 2000 })).toBeUndefined();
		expect(deltaAt({ presetAnimations, localTime: 1999 })).toBeDefined();
		expect(deltaAt({ presetAnimations, localTime: 2001 })).toBeDefined();
	});
});

describe("preset room", () => {
	const clip = seconds(4);
	const minimum = seconds(0.1);

	test("is 0.1 s up to the clip when the other phase is empty", () => {
		expect(
			getPresetRoom({ presetAnimations: {}, phase: "in", duration: clip }),
		).toEqual({ min: minimum, max: clip });
	});

	test("shrinks by the other phase's effective length", () => {
		const room = getPresetRoom({
			presetAnimations: { out: { id: "fade", duration: seconds(3) } },
			phase: "in",
			duration: clip,
		});
		expect(room.max).toBe(seconds(1));
	});

	test("uses the squeezed length of the other phase", () => {
		const room = getPresetRoom({
			presetAnimations: {
				in: { id: "fade", duration: seconds(3) },
				out: { id: "fade", duration: seconds(3) },
			},
			phase: "in",
			duration: clip,
		});
		expect(room.max).toBe(seconds(2));
	});

	test("never reports a maximum below the minimum", () => {
		const room = getPresetRoom({
			presetAnimations: {},
			phase: "out",
			duration: seconds(0.05),
		});
		expect(room.max).toBe(room.min);
	});
});

describe("pop and zoom", () => {
	test("pop starts at 0, overshoots once, settles at 1", () => {
		expect(evaluateAt({ id: "pop", progress: 0 }).scale).toBeCloseTo(0, 10);
		expect(evaluateAt({ id: "pop", progress: 1 }).scale).toBe(1);
		let peak = 0;
		for (let step = 0; step <= 1000; step += 1) {
			peak = Math.max(
				peak,
				evaluateAt({ id: "pop", progress: step / 1000 }).scale ?? 0,
			);
		}
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(1.2);
	});

	test("zoom scales from 0.5 and fades from 0 to the full clip", () => {
		expect(evaluateAt({ id: "zoom", progress: 0 })).toEqual({
			scale: 0.5,
			opacity: 0,
		});
		expect(evaluateAt({ id: "zoom", progress: 1 })).toEqual({
			scale: 1,
			opacity: 1,
		});
	});

	test("zoom eases out: it is past halfway before half the time", () => {
		const middle = evaluateAt({ id: "zoom", progress: 0.5 });
		expect(middle.opacity).toBeGreaterThan(0.5);
		expect(middle.scale).toBeGreaterThan(0.75);
	});
});

describe("slide", () => {
	function startOf({
		id,
		context = CONTEXT,
	}: {
		id: PresetAnimationId;
		context?: PresetContext;
	}) {
		return evaluateAt({ id, progress: 0, context });
	}

	test("starts just outside the canvas edge it comes from", () => {
		// 400 px wide clip at the center of a 1920 px canvas: 960 + 200.
		expect(startOf({ id: "slide-left" }).x).toBe(-1160);
		expect(startOf({ id: "slide-right" }).x).toBe(1160);
		// 200 px tall clip in a 1080 px canvas: 540 + 100.
		expect(startOf({ id: "slide-up" }).y).toBe(-640);
		expect(startOf({ id: "slide-down" }).y).toBe(640);
	});

	test("slides only along its own axis", () => {
		expect(startOf({ id: "slide-left" }).y).toBeUndefined();
		expect(startOf({ id: "slide-up" }).x).toBeUndefined();
	});

	test("a clip placed toward the entry edge has less far to go, away has more", () => {
		function shifted(x: number): PresetContext {
			return { ...CONTEXT, position: { x, y: 0 } };
		}
		expect(startOf({ id: "slide-left", context: shifted(300) }).x).toBe(-1460);
		expect(startOf({ id: "slide-left", context: shifted(-300) }).x).toBe(-860);
		expect(startOf({ id: "slide-right", context: shifted(300) }).x).toBe(860);
	});

	test("a clip already outside the canvas does not move", () => {
		const outside: PresetContext = { ...CONTEXT, position: { x: -3000, y: 0 } };
		expect(startOf({ id: "slide-left", context: outside }).x).toBeCloseTo(0, 10);
	});

	test("reaches rest with no offset and moves with an ease-out curve", () => {
		expect(evaluateAt({ id: "slide-left", progress: 1 }).x).toBeCloseTo(0, 10);
		// easeOutCubic(0.5) = 0.875, so only 12.5% of the distance remains.
		expect(evaluateAt({ id: "slide-left", progress: 0.5 }).x).toBeCloseTo(
			-1160 * 0.125,
			9,
		);
	});

	test("uses the side of the clip that faces the entry edge (off-center bounds)", () => {
		// Text anchored at its left edge sits entirely to the right of its origin.
		const rightHeavy: PresetContext = {
			...CONTEXT,
			bounds: { left: 0, right: 400, top: 0, bottom: 200 },
		};
		const leftHeavy: PresetContext = {
			...CONTEXT,
			bounds: { left: -400, right: 0, top: -200, bottom: 0 },
		};
		// Horizontal: half the canvas is 960.
		expect(startOf({ id: "slide-left", context: rightHeavy }).x).toBe(-1360);
		expect(startOf({ id: "slide-right", context: rightHeavy }).x).toBe(960);
		expect(startOf({ id: "slide-left", context: leftHeavy }).x).toBe(-960);
		expect(startOf({ id: "slide-right", context: leftHeavy }).x).toBe(1360);
		// Vertical: half the canvas is 540.
		expect(startOf({ id: "slide-up", context: rightHeavy }).y).toBe(-740);
		expect(startOf({ id: "slide-down", context: rightHeavy }).y).toBe(540);
		expect(startOf({ id: "slide-up", context: leftHeavy }).y).toBe(-540);
		expect(startOf({ id: "slide-down", context: leftHeavy }).y).toBe(740);
	});

	test("slide-left out leaves toward the left", () => {
		const delta = deltaAt({
			presetAnimations: { out: preset({ id: "slide-left", duration: 1000 }) },
			localTime: CLIP,
		});
		expect(delta?.x).toBe(-1160);
	});

	test("the four directions are symmetric", () => {
		const left = startOf({ id: "slide-left" }).x ?? 0;
		const right = startOf({ id: "slide-right" }).x ?? 0;
		const up = startOf({ id: "slide-up" }).y ?? 0;
		const down = startOf({ id: "slide-down" }).y ?? 0;
		expect(left).toBe(-right);
		expect(up).toBe(-down);
	});
});

describe("text reveal presets", () => {
	test("typewriter reveals characters and word-reveal reveals words, in step with time", () => {
		expect(evaluateAt({ id: "typewriter", progress: 0.4 })).toEqual({
			reveal: { unit: "grapheme", fraction: 0.4 },
		});
		expect(evaluateAt({ id: "word-reveal", progress: 0.4 })).toEqual({
			reveal: { unit: "word", fraction: 0.4 },
		});
		expect(evaluateAt({ id: "typewriter", progress: 0 }).reveal?.fraction).toBe(0);
		expect(evaluateAt({ id: "typewriter", progress: 1 }).reveal?.fraction).toBe(1);
	});

	test("are offered for text only and take 1 s by default", () => {
		function idsFor(elementType: ElementType) {
			return getPresetsForElementType({ elementType }).map(
				(definition) => definition.id,
			);
		}

		expect(idsFor("text")).toEqual(
			expect.arrayContaining(["typewriter", "word-reveal", "fade", "pop"]),
		);
		for (const type of ["video", "image", "sticker", "graphic"] as const) {
			expect(idsFor(type)).not.toContain("typewriter");
			expect(idsFor(type)).not.toContain("word-reveal");
		}
		expect(getPresetDefinition("typewriter")?.defaultSeconds).toBe(1);
		expect(getPresetDefinition("word-reveal")?.defaultSeconds).toBe(1);
	});

	test("Out erases from the end: the fraction shrinks to 0 at the last frame", () => {
		const presetAnimations = {
			out: preset({ id: "typewriter", duration: 1000 }),
		};
		expect(deltaAt({ presetAnimations, localTime: 3500 })?.reveal?.fraction).toBe(
			0.5,
		);
		expect(deltaAt({ presetAnimations, localTime: CLIP })?.reveal?.fraction).toBe(0);
	});

	test("they do not move, scale or fade the clip", () => {
		const base: Transform = {
			scaleX: 1,
			scaleY: 1,
			position: { x: 3, y: 4 },
			rotate: 10,
		};
		const result = applyPresetDelta({
			transform: base,
			opacity: 0.8,
			delta: evaluateAt({ id: "typewriter", progress: 0.3 }),
		});
		expect(result.transform).toEqual(base);
		expect(result.opacity).toBe(0.8);
	});
});

describe("transformed bounds", () => {
	const rect = { left: -200, top: -100, width: 400, height: 200 };

	// toBeCloseTo, because a flip or a rotation can produce -0 and rounding noise.
	function expectBounds({
		actual,
		expected,
	}: {
		actual: PresetBounds;
		expected: PresetBounds;
	}) {
		expect(actual.left).toBeCloseTo(expected.left, 9);
		expect(actual.right).toBeCloseTo(expected.right, 9);
		expect(actual.top).toBeCloseTo(expected.top, 9);
		expect(actual.bottom).toBeCloseTo(expected.bottom, 9);
	}

	test("is the rect itself without scale or rotation", () => {
		expectBounds({
			actual: getTransformedBounds({ rect, scaleX: 1, scaleY: 1, rotate: 0 }),
			expected: { left: -200, right: 200, top: -100, bottom: 100 },
		});
	});

	test("grows with scale", () => {
		expectBounds({
			actual: getTransformedBounds({ rect, scaleX: 2, scaleY: 3, rotate: 0 }),
			expected: { left: -400, right: 400, top: -300, bottom: 300 },
		});
	});

	test("a 90 degree rotation swaps the extents", () => {
		expectBounds({
			actual: getTransformedBounds({ rect, scaleX: 1, scaleY: 1, rotate: 90 }),
			expected: { left: -100, right: 100, top: -200, bottom: 200 },
		});
	});

	test("scaleAfterRotate follows the text draw order (rotate, then scale)", () => {
		// 400 x 200 box, stretched 2 x 1, turned 90 degrees.
		// A quad scales in its own axes and then rotates...
		expectBounds({
			actual: getTransformedBounds({ rect, scaleX: 2, scaleY: 1, rotate: 90 }),
			expected: { left: -100, right: 100, top: -400, bottom: 400 },
		});
		// ...text is rotated first and then stretched along the canvas axes.
		expectBounds({
			actual: getTransformedBounds({
				rect,
				scaleX: 2,
				scaleY: 1,
				rotate: 90,
				scaleAfterRotate: true,
			}),
			expected: { left: -200, right: 200, top: -200, bottom: 200 },
		});
	});

	test("both orders agree when the scale is uniform", () => {
		const quad = getTransformedBounds({ rect, scaleX: 2, scaleY: 2, rotate: 30 });
		const text = getTransformedBounds({
			rect,
			scaleX: 2,
			scaleY: 2,
			rotate: 30,
			scaleAfterRotate: true,
		});
		expectBounds({ actual: text, expected: quad });
	});

	test("an off-center rect (left-aligned text) keeps its side", () => {
		const text = { left: 0, top: -50, width: 400, height: 100 };
		expectBounds({
			actual: getTransformedBounds({
				rect: text,
				scaleX: 1,
				scaleY: 1,
				rotate: 0,
			}),
			expected: { left: 0, right: 400, top: -50, bottom: 50 },
		});
		// A horizontal flip moves the rect to the other side of the origin.
		expectBounds({
			actual: getTransformedBounds({
				rect: text,
				scaleX: -1,
				scaleY: 1,
				rotate: 0,
			}),
			expected: { left: -400, right: 0, top: -50, bottom: 50 },
		});
	});
});

describe("applying a delta", () => {
	const base: Transform = Object.freeze({
		scaleX: 2,
		scaleY: 2,
		position: Object.freeze({ x: 10, y: 20 }),
		rotate: 30,
	});

	test("multiplies opacity: 0.5 clip opacity with a 0.5 fade is 0.25", () => {
		const result = applyPresetDelta({
			transform: base,
			opacity: 0.5,
			delta: { opacity: 0.5 },
		});
		expect(result.opacity).toBe(0.25);
		expect(result.transform).toEqual(base);
	});

	test("multiplies scale: scale 2 with a 0.5 zoom is 1", () => {
		const { transform } = applyPresetDelta({
			transform: base,
			opacity: 1,
			delta: { scale: 0.5 },
		});
		expect(transform.scaleX).toBe(1);
		expect(transform.scaleY).toBe(1);
	});

	test("a flipped scale keeps its sign", () => {
		const { transform } = applyPresetDelta({
			transform: { ...base, scaleX: -2 },
			opacity: 1,
			delta: { scale: 0.5 },
		});
		expect(transform.scaleX).toBe(-1);
		expect(transform.scaleY).toBe(1);
	});

	test("adds the offset to the position and leaves rotation alone", () => {
		const { transform } = applyPresetDelta({
			transform: base,
			opacity: 1,
			delta: { x: 5, y: -5 },
		});
		expect(transform.position).toEqual({ x: 15, y: 15 });
		expect(transform.rotate).toBe(30);
	});

	test("never collapses the clip to zero size", () => {
		const collapsed = applyPresetDelta({
			transform: base,
			opacity: 1,
			delta: { scale: 0 },
		}).transform;
		expect(collapsed.scaleX).toBe(MIN_TRANSFORM_SCALE);
		expect(collapsed.scaleY).toBe(MIN_TRANSFORM_SCALE);
		const flipped = applyPresetDelta({
			transform: { ...base, scaleX: -2 },
			opacity: 1,
			delta: { scale: 0 },
		}).transform;
		expect(flipped.scaleX).toBe(-MIN_TRANSFORM_SCALE);
	});

	test("an empty delta changes nothing and does not touch the input", () => {
		const result = applyPresetDelta({ transform: base, opacity: 0.7, delta: {} });
		expect(result.transform).toEqual(base);
		expect(result.opacity).toBe(0.7);
	});
});

describe("editing one phase", () => {
	// A 10 s clip had In 3 s and Out 3 s stored, then was trimmed to 4 s: the
	// panel shows 2 s and 2 s. An edit must not make the other box move.
	const clip = seconds(4);
	const squeezed: PresetAnimations = {
		in: { id: "fade", duration: seconds(3) },
		out: { id: "zoom", duration: seconds(3) },
	};

	function shown(presetAnimations: PresetAnimations | undefined) {
		return getEffectiveDurations({ presetAnimations, duration: clip });
	}

	test("starts out squeezed to 2 s + 2 s", () => {
		expect(shown(squeezed)).toEqual({ in: seconds(2), out: seconds(2) });
	});

	test("the other phase is written at its shown length, so it does not jump", () => {
		const next = setPresetPhase({
			presetAnimations: squeezed,
			phase: "in",
			animation: { id: "fade", duration: seconds(1) },
			duration: clip,
		});
		expect(next).toEqual({
			in: { id: "fade", duration: seconds(1) },
			out: { id: "zoom", duration: seconds(2) },
		});
		expect(shown(next).out).toBe(seconds(2));
	});

	test("dragging to the maximum leaves the room, and the other box, where they were", () => {
		const before = getPresetRoom({
			presetAnimations: squeezed,
			phase: "in",
			duration: clip,
		});
		const next = setPresetPhase({
			presetAnimations: squeezed,
			phase: "in",
			animation: { id: "fade", duration: ticks(before.max) },
			duration: clip,
		});
		expect(shown(next)).toEqual({ in: seconds(2), out: seconds(2) });
		expect(
			getPresetRoom({ presetAnimations: next, phase: "in", duration: clip }).max,
		).toBe(before.max);
	});

	test("resetting a phase to its default gives exactly the default, with the other phase kept", () => {
		const next = setPresetPhase({
			presetAnimations: squeezed,
			phase: "in",
			animation: { id: "fade", duration: seconds(0.5) },
			duration: clip,
		});
		expect(shown(next)).toEqual({ in: seconds(0.5), out: seconds(2) });
		// The room reflects the real neighbour, not the old request.
		expect(
			getPresetRoom({ presetAnimations: next, phase: "in", duration: clip }).max,
		).toBe(seconds(2));
	});

	test("clearing a phase also keeps the other one where it was shown", () => {
		const next = setPresetPhase({
			presetAnimations: squeezed,
			phase: "in",
			animation: undefined,
			duration: clip,
		});
		expect(next).toEqual({ out: { id: "zoom", duration: seconds(2) } });
		expect(Object.keys(next ?? {})).toEqual(["out"]);
	});

	test("clearing the last phase leaves nothing", () => {
		expect(
			setPresetPhase({
				presetAnimations: { in: squeezed.in },
				phase: "in",
				animation: undefined,
				duration: clip,
			}),
		).toBeUndefined();
		expect(
			setPresetPhase({
				presetAnimations: undefined,
				phase: "out",
				animation: undefined,
				duration: clip,
			}),
		).toBeUndefined();
	});

	test("without a squeeze the other phase is left exactly as stored", () => {
		const roomy: PresetAnimations = {
			in: { id: "fade", duration: seconds(1) },
			out: { id: "zoom", duration: seconds(0.5) },
		};
		const next = setPresetPhase({
			presetAnimations: roomy,
			phase: "in",
			animation: { id: "fade", duration: seconds(1.5) },
			duration: clip,
		});
		expect(next?.out).toBe(roomy.out);
	});

	test("setting a phase on a clip with nothing builds only that phase, without dead keys", () => {
		const next = setPresetPhase({
			presetAnimations: undefined,
			phase: "out",
			animation: { id: "pop", duration: seconds(1) },
			duration: clip,
		});
		expect(next).toEqual({ out: { id: "pop", duration: seconds(1) } });
		expect(Object.keys(next ?? {})).toEqual(["out"]);
	});

	test("an unknown id on the other phase is kept untouched", () => {
		const future: PresetAnimations = JSON.parse(
			`{"in":{"id":"fade","duration":${seconds(3)}},"out":{"id":"from-the-future","duration":${seconds(3)}}}`,
		);
		const next = setPresetPhase({
			presetAnimations: future,
			phase: "in",
			animation: { id: "fade", duration: seconds(1) },
			duration: clip,
		});
		expect(next?.out).toBe(future.out);
	});

	test("an edit when the clip is long enough still restores later: lengthening keeps the stored values", () => {
		const next = setPresetPhase({
			presetAnimations: { in: squeezed.in },
			phase: "out",
			animation: { id: "zoom", duration: seconds(3) },
			duration: seconds(10),
		});
		expect(next).toEqual(squeezed);
	});
});

describe("registry", () => {
	test("every preset is finite at both ends and ends at identity", () => {
		for (const { id } of PRESET_DEFINITIONS) {
			const start = evaluateAt({ id, progress: 0 });
			const end = evaluateAt({ id, progress: 1 });
			for (const delta of [start, end]) {
				for (const value of [delta.opacity, delta.scale, delta.x, delta.y]) {
					expect(Number.isFinite(value ?? 0)).toBe(true);
				}
				expect(Number.isFinite(delta.reveal?.fraction ?? 0)).toBe(true);
			}
			expect(end.opacity ?? 1).toBe(1);
			expect(end.scale ?? 1).toBe(1);
			expect(Math.abs(end.x ?? 0)).toBeCloseTo(0, 10);
			expect(Math.abs(end.y ?? 0)).toBeCloseTo(0, 10);
			expect(end.reveal?.fraction ?? 1).toBe(1);
		}
	});

	test("ids are unique and every preset supports only visual element types", () => {
		const visualTypes: readonly ElementType[] = VISUAL_ELEMENT_TYPES;
		const ids = PRESET_DEFINITIONS.map((definition) => definition.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const definition of PRESET_DEFINITIONS) {
			expect(definition.supports.length).toBeGreaterThan(0);
			for (const type of definition.supports) {
				expect(visualTypes).toContain(type);
			}
			expect(definition.defaultSeconds).toBeGreaterThanOrEqual(0.1);
		}
	});

	test("the registry holds exactly the nine v1 presets", () => {
		expect(PRESET_DEFINITIONS.map((definition) => definition.id)).toEqual([
			"fade",
			"slide-left",
			"slide-right",
			"slide-up",
			"slide-down",
			"zoom",
			"pop",
			"typewriter",
			"word-reveal",
		]);
	});

	test("lists the presets offered for an element type", () => {
		function offered(elementType: ElementType) {
			return getPresetsForElementType({ elementType }).map(
				(definition) => definition.id,
			);
		}
		for (const type of ["video", "image", "sticker", "graphic"] as const) {
			expect(offered(type)).toEqual([
				"fade",
				"slide-left",
				"slide-right",
				"slide-up",
				"slide-down",
				"zoom",
				"pop",
			]);
		}
		expect(offered("audio")).toEqual([]);
		expect(offered("effect")).toEqual([]);
	});
});

describe("splitting a clip", () => {
	const both: PresetAnimations = {
		in: preset({ id: "slide-left", duration: 1000 }),
		out: preset({ id: "zoom", duration: 500 }),
	};

	test("the left half keeps the in animation, the right half keeps the out", () => {
		expect(splitPresetAnimations({ presetAnimations: both })).toEqual({
			left: { in: both.in },
			right: { out: both.out },
		});
	});

	test("a half with nothing to keep gets undefined, not an empty object", () => {
		expect(
			splitPresetAnimations({ presetAnimations: { in: both.in } }),
		).toEqual({ left: { in: both.in }, right: undefined });
		expect(
			splitPresetAnimations({ presetAnimations: { out: both.out } }),
		).toEqual({ left: undefined, right: { out: both.out } });
		expect(splitPresetAnimations({ presetAnimations: undefined })).toEqual({
			left: undefined,
			right: undefined,
		});
		expect(splitPresetAnimations({ presetAnimations: {} })).toEqual({
			left: undefined,
			right: undefined,
		});
	});

	test("survives a JSON and structuredClone round trip", () => {
		const { left, right } = splitPresetAnimations({ presetAnimations: both });
		expect(JSON.parse(JSON.stringify(left))).toEqual(left);
		expect(structuredClone(right)).toEqual(right);
	});
});
