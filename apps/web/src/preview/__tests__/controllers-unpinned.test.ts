/**
 * Regression: an element that is NOT stuck to the scene must behave exactly as
 * before slice T4 in both preview controllers, whether or not they were given
 * the pin dependency. The numbers pinned here are what the code did before.
 */
import { describe, expect, test } from "bun:test";
import { hasKeyframesForPath } from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";
import { getElementLocalTime } from "@/animation";
import { PreviewInteractionController } from "../controllers/preview-interaction-controller";
import { TransformHandleController } from "../controllers/transform-handle-controller";
import {
	BASE_PARAMS,
	CANVAS_SIZE,
	ELEMENT_ID,
	IDENTITY_VIEWPORT,
	MEDIA_ASSETS,
	OPACITY_ANIMATIONS,
	PIN_LIKE_ANIMATIONS,
	PLAYHEAD,
	TRACK_ID,
	imageElement,
	pointerEvent,
	sceneTracks,
	timelineLog,
} from "./controller-harness";
import type { ElementAnimations } from "@/animation/types";

type PinsVariant = "no pins dependency" | "pins dependency, element not stuck";
const VARIANTS: PinsVariant[] = ["no pins dependency", "pins dependency, element not stuck"];

function pinsFor({ variant }: { variant: PinsVariant }) {
	const repins: string[] = [];
	return {
		repins,
		pins:
			variant === "no pins dependency"
				? undefined
				: {
						isPinned: () => false,
						repin: ({ elementId }: { elementId: string }) => {
							repins.push(elementId);
						},
					},
	};
}

function dragSetup({ animations, variant }: { animations?: ElementAnimations; variant: PinsVariant }) {
	const element = imageElement({ animations });
	const tracks = sceneTracks({ element });
	const log = timelineLog();
	const { pins, repins } = pinsFor({ variant });
	const controller = new PreviewInteractionController({
		depsRef: {
			current: {
				viewport: IDENTITY_VIEWPORT,
				input: { isShiftHeld: () => true },
				scene: {
					getTracks: () => tracks,
					getCurrentTime: () => PLAYHEAD,
					getMediaAssets: () => MEDIA_ASSETS,
					getCanvasSize: () => CANVAS_SIZE,
				},
				selection: {
					getSelected: () => [{ trackId: TRACK_ID, elementId: ELEMENT_ID }],
					setSelected: () => {},
					clearSelection: () => {},
				},
				timeline: {
					getElementsWithTracks: () => [{ track: tracks.overlay[0], element }],
					...log.ops,
				},
				playback: { getIsPlaying: () => false, subscribe: () => () => {} },
				preview: { isMaskMode: () => false },
				...(pins ? { pins } : {}),
			},
		},
	});
	return { controller, log, repins, element };
}

function dragBy({ controller, dx, dy }: { controller: PreviewInteractionController; dx: number; dy: number }) {
	// The element (scale 0.5 of the canvas) covers 480..1440 x 270..810 around (970, 560).
	controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
	controller.onPointerMove(pointerEvent({ clientX: 970 + dx, clientY: 560 + dy, type: "pointermove" }));
	controller.onPointerUp(pointerEvent({ type: "pointerup" }));
}

for (const variant of VARIANTS) {
	describe(`dragging an element that is not stuck (${variant})`, () => {
		test("an element without animations: writes the base position, then commits", () => {
			const { controller, log, repins } = dragSetup({ variant });
			dragBy({ controller, dx: 100, dy: 50 });
			expect(log.calls).toEqual([
				{
					call: "preview",
					updates: [
						{
							trackId: TRACK_ID,
							elementId: ELEMENT_ID,
							updates: {
								params: {
									...BASE_PARAMS,
									"transform.positionX": 110,
									"transform.positionY": 70,
								},
							},
						},
					],
				},
				{ call: "commit" },
			]);
			expect(repins).toEqual([]);
		});

		test("an element with animations: still only the base position, animations are not in the update", () => {
			const { controller, log, repins } = dragSetup({ animations: PIN_LIKE_ANIMATIONS, variant });
			dragBy({ controller, dx: 100, dy: 50 });
			expect(log.calls.length).toBe(2);
			const first = log.calls[0];
			expect(first?.call).toBe("preview");
			if (first?.call !== "preview") throw new Error("expected a preview");
			expect(Object.keys(first.updates[0]?.updates ?? {})).toEqual(["params"]);
			expect(first.updates[0]?.updates.params).toEqual({
				...BASE_PARAMS,
				"transform.positionX": 110,
				"transform.positionY": 70,
			});
			expect(log.calls[1]).toEqual({ call: "commit" });
			expect(repins).toEqual([]);
		});

		test("a click without moving commits nothing and previews nothing", () => {
			const { controller, log } = dragSetup({ variant });
			controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
			controller.onPointerUp(pointerEvent({ type: "pointerup" }));
			expect(log.calls).toEqual([]);
		});

		test("cancelling a drag discards the preview", () => {
			const { controller, log } = dragSetup({ variant });
			controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
			controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 560, type: "pointermove" }));
			controller.cancel();
			expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		});
	});
}

function handleSetup({ animations, variant }: { animations?: ElementAnimations; variant: PinsVariant }) {
	const element = imageElement({ animations });
	const tracks = sceneTracks({ element });
	const log = timelineLog();
	const { pins, repins } = pinsFor({ variant });
	const controller = new TransformHandleController({
		depsRef: {
			current: {
				viewport: IDENTITY_VIEWPORT,
				input: { isShiftHeld: () => true },
				scene: {
					getSelectedElements: () => [{ trackId: TRACK_ID, elementId: ELEMENT_ID }],
					getTracks: () => tracks,
					getCurrentTime: () => PLAYHEAD,
					getMediaAssets: () => MEDIA_ASSETS,
					getCanvasSize: () => CANVAS_SIZE,
				},
				timeline: log.ops,
				preview: {},
				...(pins ? { pins } : {}),
			},
		},
	});
	return { controller, log, repins, element };
}

function lastPreview({ log }: { log: ReturnType<typeof timelineLog> }) {
	for (let index = log.calls.length - 1; index >= 0; index--) {
		const entry = log.calls[index];
		if (entry?.call === "preview") return entry.updates[0]?.updates ?? null;
	}
	return null;
}

for (const variant of VARIANTS) {
	describe(`the scale and rotate handles on an element that is not stuck (${variant})`, () => {
		test("corner scale of an element without animations: params only", () => {
			const { controller, log, repins } = handleSetup({ variant });
			controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
			controller.onPointerMove({ event: pointerEvent({ clientX: 1700, clientY: 900, type: "pointermove" }) });
			controller.onPointerUp();
			const update = lastPreview({ log });
			expect(update && Object.keys(update)).toEqual(["params"]);
			expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "commit"]);
			expect(repins).toEqual([]);
		});

		test("corner scale of an element with scale keys still deletes only the scale keys (as before)", () => {
			const { controller, log, repins } = handleSetup({
				animations: { ...PIN_LIKE_ANIMATIONS, ...OPACITY_ANIMATIONS },
				variant,
			});
			controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
			controller.onPointerMove({ event: pointerEvent({ clientX: 1700, clientY: 900, type: "pointermove" }) });
			controller.onPointerUp();
			const update = lastPreview({ log });
			expect(update && Object.keys(update).sort()).toEqual(["animations", "params"]);
			const animations = update?.animations;
			expect(hasKeyframesForPath({ animations, propertyPath: "transform.scaleX" })).toBe(false);
			expect(hasKeyframesForPath({ animations, propertyPath: "transform.scaleY" })).toBe(false);
			for (const propertyPath of ["transform.positionX", "transform.positionY", "transform.rotate", "opacity"] as const) {
				expect(hasKeyframesForPath({ animations, propertyPath })).toBe(true);
			}
			expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "commit"]);
			expect(repins).toEqual([]);
		});

		test("the right edge handle deletes only the scaleX keys", () => {
			const { controller, log } = handleSetup({ animations: PIN_LIKE_ANIMATIONS, variant });
			controller.onEdgePointerDown({ event: pointerEvent({ clientX: 1440, clientY: 540 }), edge: "right" });
			controller.onPointerMove({ event: pointerEvent({ clientX: 1600, clientY: 540, type: "pointermove" }) });
			controller.onPointerUp();
			const animations = lastPreview({ log })?.animations;
			expect(hasKeyframesForPath({ animations, propertyPath: "transform.scaleX" })).toBe(false);
			expect(hasKeyframesForPath({ animations, propertyPath: "transform.scaleY" })).toBe(true);
		});

		test("the rotation handle writes params only and keeps every key", () => {
			const { controller, log, repins } = handleSetup({ animations: PIN_LIKE_ANIMATIONS, variant });
			controller.onRotationPointerDown({ event: pointerEvent({ clientX: 970, clientY: 100 }) });
			controller.onPointerMove({ event: pointerEvent({ clientX: 1200, clientY: 300, type: "pointermove" }) });
			controller.onPointerUp();
			const update = lastPreview({ log });
			expect(update && Object.keys(update)).toEqual(["params"]);
			expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "commit"]);
			expect(repins).toEqual([]);
		});

		test("the scale handles start from what the element looks like at the playhead", () => {
			const { controller, log, element } = handleSetup({ animations: PIN_LIKE_ANIMATIONS, variant });
			const look = resolveTransformAtTime({
				baseTransform: buildTransformFromParams({ params: element.params }),
				animations: element.animations,
				localTime: getElementLocalTime({
					timelineTime: PLAYHEAD,
					elementStartTime: element.startTime,
					elementDuration: element.duration,
				}),
			});
			controller.onRotationPointerDown({ event: pointerEvent({ clientX: 970, clientY: 100 }) });
			controller.onPointerMove({ event: pointerEvent({ clientX: 970, clientY: 100, type: "pointermove" }) });
			const params = lastPreview({ log })?.params;
			expect(params?.["transform.positionX"]).toBeCloseTo(look.position.x, 6);
			expect(params?.["transform.scaleX"]).toBeCloseTo(look.scaleX, 6);
			controller.cancel();
		});

		test("a press on a handle without moving commits nothing", () => {
			const { controller, log, repins } = handleSetup({ animations: PIN_LIKE_ANIMATIONS, variant });
			controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
			controller.onPointerUp();
			expect(log.calls.filter((entry) => entry.call === "preview")).toEqual([]);
			expect(repins).toEqual([]);
		});
	});
}
