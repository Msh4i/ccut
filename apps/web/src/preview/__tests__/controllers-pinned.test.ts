/**
 * Dragging, scaling and turning an element that IS stuck to the scene (slice
 * T4, plan section c "Surukleme/tutamac"): its five channels are lifted for the
 * gesture so it follows the cursor, and on release it is stuck again from the
 * same analysis with its look as the user left it.
 */
import { describe, expect, test } from "bun:test";
import { getElementLocalTime, hasKeyframesForPath } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValue } from "@/params";
import { buildTransformFromParams, type Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { PIN_PROPERTY_PATHS } from "../controllers/pin-gesture";
import { PreviewInteractionController } from "../controllers/preview-interaction-controller";
import { TransformHandleController } from "../controllers/transform-handle-controller";
import {
	CANVAS_SIZE,
	ELEMENT_ID,
	IDENTITY_VIEWPORT,
	MEDIA_ASSETS,
	OPACITY_ANIMATIONS,
	OTHER_TRACK_ID,
	PIN_LIKE_ANIMATIONS,
	PLAYHEAD,
	TRACK_ID,
	capturingTarget,
	imageElement,
	pointerEvent,
	sceneTracks,
	sceneTracksWithTwo,
	timelineLog,
	type TimelineCall,
} from "./controller-harness";

function numberParam({ value }: { value: ParamValue | undefined }): number {
	return typeof value === "number" ? value : Number.NaN;
}

const ANIMATIONS: ElementAnimations = { ...PIN_LIKE_ANIMATIONS, ...OPACITY_ANIMATIONS };

function lookAtPlayhead({ animations }: { animations: ElementAnimations }): Transform {
	const element = imageElement({ animations });
	return resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations,
		localTime: getElementLocalTime({
			timelineTime: PLAYHEAD,
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	});
}

function pinsRecorder({ stuck = true }: { stuck?: boolean } = {}) {
	const repins: Array<{ elementId: string; look?: Transform; at: number }> = [];
	let calls = 0;
	return {
		repins,
		/** How many timeline calls had happened when each repin was made. */
		pins: {
			isPinned: ({ elementId }: { elementId: string }) => stuck && elementId === ELEMENT_ID,
			repin: ({ elementId, look }: { elementId: string; look?: Transform }) => {
				repins.push({ elementId, look, at: calls });
			},
		},
		markCall: () => {
			calls++;
		},
	};
}

function dragSetup() {
	const element = imageElement({ animations: ANIMATIONS });
	const tracks = sceneTracks({ element });
	const recorder = pinsRecorder();
	const log = timelineLog();
	const ops = {
		previewElements: (updates: Parameters<typeof log.ops.previewElements>[0]) => {
			recorder.markCall();
			log.ops.previewElements(updates);
		},
		commitPreview: () => {
			recorder.markCall();
			log.ops.commitPreview();
		},
		discardPreview: () => {
			recorder.markCall();
			log.ops.discardPreview();
		},
	};
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
				timeline: { getElementsWithTracks: () => [{ track: tracks.overlay[0], element }], ...ops },
				playback: { getIsPlaying: () => false, subscribe: () => () => {} },
				preview: { isMaskMode: () => false },
				pins: recorder.pins,
			},
		},
	});
	return { controller, log, recorder, look: lookAtPlayhead({ animations: ANIMATIONS }) };
}

function previews({ calls }: { calls: TimelineCall[] }) {
	return calls.flatMap((entry) => (entry.call === "preview" ? [entry.updates[0]?.updates] : []));
}

describe("dragging a stuck element", () => {
	test("the channels are lifted, and the element starts from its look at the playhead", () => {
		const { controller, log, look } = dragSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 610, type: "pointermove" }));
		const update = previews({ calls: log.calls })[0];
		for (const propertyPath of PIN_PROPERTY_PATHS) {
			expect(hasKeyframesForPath({ animations: update?.animations, propertyPath })).toBe(false);
		}
		expect(hasKeyframesForPath({ animations: update?.animations, propertyPath: "opacity" })).toBe(true);
		expect(update?.params?.["transform.positionX"]).toBeCloseTo(look.position.x + 100, 6);
		expect(update?.params?.["transform.positionY"]).toBeCloseTo(look.position.y + 50, 6);
		// Scale and turn are what the pin made them at the playhead, not the base values.
		expect(update?.params?.["transform.scaleX"]).toBeCloseTo(look.scaleX, 6);
		expect(update?.params?.["transform.scaleY"]).toBeCloseTo(look.scaleY, 6);
		expect(update?.params?.["transform.rotate"]).toBeCloseTo(look.rotate, 6);
		controller.cancel();
	});

	test("on release the preview is dropped and the element is stuck again with the look it was left in", () => {
		const { controller, log, recorder, look } = dragSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 610, type: "pointermove" }));
		controller.onPointerUp(pointerEvent({ type: "pointerup" }));
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		expect(recorder.repins.length).toBe(1);
		const repin = recorder.repins[0];
		expect(repin?.elementId).toBe(ELEMENT_ID);
		// After the discard (two timeline calls), never before: the keys are written on the restored element.
		expect(repin?.at).toBe(2);
		expect(repin?.look?.position.x).toBeCloseTo(look.position.x + 100, 6);
		expect(repin?.look?.position.y).toBeCloseTo(look.position.y + 50, 6);
		expect(repin?.look?.scaleX).toBeCloseTo(look.scaleX, 6);
		expect(repin?.look?.scaleY).toBeCloseTo(look.scaleY, 6);
		expect(repin?.look?.rotate).toBeCloseTo(look.rotate, 6);
	});

	test("the last position wins when the pointer moves on", () => {
		const { controller, recorder, look } = dragSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 610, type: "pointermove" }));
		controller.onPointerMove(pointerEvent({ clientX: 870, clientY: 460, type: "pointermove" }));
		controller.onPointerUp(pointerEvent({ type: "pointerup" }));
		expect(recorder.repins[0]?.look?.position.x).toBeCloseTo(look.position.x - 100, 6);
		expect(recorder.repins[0]?.look?.position.y).toBeCloseTo(look.position.y - 100, 6);
	});

	test("cancelling (Esc, pointer cancel) discards and does not stick again", () => {
		const { controller, log, recorder } = dragSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 610, type: "pointermove" }));
		controller.cancel();
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		expect(recorder.repins).toEqual([]);

		const second = dragSetup();
		second.controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		second.controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 610, type: "pointermove" }));
		second.controller.onPointerUp(pointerEvent({ type: "pointercancel" }));
		expect(second.log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		expect(second.recorder.repins).toEqual([]);
	});

	test("a click that does not drag changes nothing and does not stick again", () => {
		const { controller, log, recorder } = dragSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerUp(pointerEvent({ type: "pointerup" }));
		expect(log.calls).toEqual([]);
		expect(recorder.repins).toEqual([]);
	});

	test("two drags in a row each stick once, from their own look", () => {
		const { controller, recorder, look } = dragSetup();
		for (const dx of [100, -60]) {
			controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
			controller.onPointerMove(pointerEvent({ clientX: 970 + dx, clientY: 560, type: "pointermove" }));
			controller.onPointerUp(pointerEvent({ type: "pointerup" }));
		}
		expect(recorder.repins.map((entry) => entry.look?.position.x)).toEqual([
			expect.closeTo(look.position.x + 100, 6),
			expect.closeTo(look.position.x - 60, 6),
		]);
	});
});

describe("dragging a stuck element together with one that is not", () => {
	function mixedSetup() {
		const stuck = imageElement({ animations: ANIMATIONS });
		const loose = imageElement({ id: "img-2", animations: OPACITY_ANIMATIONS });
		const tracks = sceneTracksWithTwo({ lower: stuck, upper: loose });
		const recorder = pinsRecorder();
		const log = timelineLog();
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
						getSelected: () => [
							{ trackId: OTHER_TRACK_ID, elementId: "img-2" },
							{ trackId: TRACK_ID, elementId: ELEMENT_ID },
						],
						setSelected: () => {},
						clearSelection: () => {},
					},
					timeline: {
						getElementsWithTracks: () => [
							{ track: tracks.overlay[0], element: loose },
							{ track: tracks.overlay[1], element: stuck },
						],
						previewElements: (updates) => {
							recorder.markCall();
							log.ops.previewElements(updates);
						},
						commitPreview: () => {
							recorder.markCall();
							log.ops.commitPreview();
						},
						discardPreview: () => {
							recorder.markCall();
							log.ops.discardPreview();
						},
					},
					playback: { getIsPlaying: () => false, subscribe: () => () => {} },
					preview: { isMaskMode: () => false },
					pins: recorder.pins,
				},
			},
		});
		return { controller, log, recorder, stuck, loose, look: lookAtPlayhead({ animations: ANIMATIONS }) };
	}

	test("the stuck one is put back before the commit, the other is committed, then the stuck one is stuck again", () => {
		const { controller, log, recorder, stuck, loose } = mixedSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 560, type: "pointermove" }));
		controller.onPointerUp(pointerEvent({ type: "pointerup" }));
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "preview", "commit"]);
		const restore = log.calls[1];
		if (restore?.call !== "preview") throw new Error("expected the restore preview");
		expect(restore.updates.length).toBe(1);
		expect(restore.updates[0]?.elementId).toBe(ELEMENT_ID);
		expect(restore.updates[0]?.updates.params).toEqual(stuck.params);
		expect(restore.updates[0]?.updates.animations).toEqual(stuck.animations);
		// The loose one's drag was previewed in the first call and keeps its own keys.
		const first = log.calls[0];
		if (first?.call !== "preview") throw new Error("expected the drag preview");
		const moved = first.updates.find((entry) => entry.elementId === "img-2");
		expect(moved && "animations" in moved.updates).toBe(false);
		expect(moved?.updates.params?.["transform.positionX"]).toBe(numberParam({ value: loose.params["transform.positionX"] }) + 100);
		expect(recorder.repins.map((entry) => entry.elementId)).toEqual([ELEMENT_ID]);
		expect(recorder.repins[0]?.at).toBe(3);
	});

	test("cancelling the mixed drag discards everything and sticks nothing again", () => {
		const { controller, log, recorder } = mixedSetup();
		controller.onPointerDown(pointerEvent({ clientX: 970, clientY: 560 }));
		controller.onPointerMove(pointerEvent({ clientX: 1070, clientY: 560, type: "pointermove" }));
		controller.cancel();
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		expect(recorder.repins).toEqual([]);
	});
});

function handleSetup({ stuck = true }: { stuck?: boolean } = {}) {
	const element = imageElement({ animations: ANIMATIONS });
	const tracks = sceneTracks({ element });
	const recorder = pinsRecorder({ stuck });
	const log = timelineLog();
	const ops = {
		previewElements: (updates: Parameters<typeof log.ops.previewElements>[0]) => {
			recorder.markCall();
			log.ops.previewElements(updates);
		},
		commitPreview: () => {
			recorder.markCall();
			log.ops.commitPreview();
		},
		discardPreview: () => {
			recorder.markCall();
			log.ops.discardPreview();
		},
	};
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
				timeline: ops,
				preview: {},
				pins: recorder.pins,
			},
		},
	});
	return { controller, log, recorder, look: lookAtPlayhead({ animations: ANIMATIONS }) };
}

describe("the handles on a stuck element", () => {
	test("corner scale lifts all five channels (not only the scale ones) and sticks again on release", () => {
		const { controller, log, recorder, look } = handleSetup();
		controller.onCornerPointerDown({ event: pointerEvent({ clientX: 2020, clientY: 1100 }), corner: "bottom-right" });
		// At the playhead the pin has made the element fill the canvas around (1060, 560): pull the corner outwards.
		controller.onPointerMove({ event: pointerEvent({ clientX: 2600, clientY: 1400, type: "pointermove" }) });
		const update = previews({ calls: log.calls })[0];
		for (const propertyPath of PIN_PROPERTY_PATHS) {
			expect(hasKeyframesForPath({ animations: update?.animations, propertyPath })).toBe(false);
		}
		expect(hasKeyframesForPath({ animations: update?.animations, propertyPath: "opacity" })).toBe(true);
		controller.onPointerUp();
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		expect(recorder.repins.length).toBe(1);
		const left = recorder.repins[0]?.look;
		expect(recorder.repins[0]?.elementId).toBe(ELEMENT_ID);
		expect(recorder.repins[0]?.at).toBe(2);
		expect(left?.scaleX).toBeGreaterThan(look.scaleX);
		expect(left?.scaleX).toBeCloseTo(numberParam({ value: update?.params?.["transform.scaleX"] }), 6);
		expect(left?.scaleY).toBeCloseTo(numberParam({ value: update?.params?.["transform.scaleY"] }), 6);
		expect(left?.position.x).toBeCloseTo(look.position.x, 6);
		expect(left?.rotate).toBeCloseTo(look.rotate, 6);
	});

	test("an edge handle moves one scale and leaves the other as the pin made it", () => {
		const { controller, recorder, look } = handleSetup();
		controller.onEdgePointerDown({ event: pointerEvent({ clientX: 1440, clientY: 540 }), edge: "right" });
		controller.onPointerMove({ event: pointerEvent({ clientX: 1600, clientY: 540, type: "pointermove" }) });
		controller.onPointerUp();
		const left = recorder.repins[0]?.look;
		expect(left?.scaleX).not.toBeCloseTo(look.scaleX, 3);
		expect(left?.scaleY).toBeCloseTo(look.scaleY, 6);
	});

	test("rotating lifts the channels too (it used to write the base only) and sticks again with the new angle", () => {
		const { controller, log, recorder, look } = handleSetup();
		controller.onRotationPointerDown({ event: pointerEvent({ clientX: 970, clientY: 100 }) });
		controller.onPointerMove({ event: pointerEvent({ clientX: 1200, clientY: 300, type: "pointermove" }) });
		const update = previews({ calls: log.calls })[0];
		for (const propertyPath of PIN_PROPERTY_PATHS) {
			expect(hasKeyframesForPath({ animations: update?.animations, propertyPath })).toBe(false);
		}
		// The update does carry animations (the other channels survive), it is not just missing them.
		expect(hasKeyframesForPath({ animations: update?.animations, propertyPath: "opacity" })).toBe(true);
		controller.onPointerUp();
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		const left = recorder.repins[0]?.look;
		expect(left?.rotate).not.toBeCloseTo(look.rotate, 3);
		expect(left?.rotate).toBeCloseTo(numberParam({ value: update?.params?.["transform.rotate"] }), 6);
		expect(left?.scaleX).toBeCloseTo(look.scaleX, 6);
	});

	test("cancelling discards and does not stick again", () => {
		const { controller, log, recorder } = handleSetup();
		controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
		controller.onPointerMove({ event: pointerEvent({ clientX: 1700, clientY: 900, type: "pointermove" }) });
		controller.cancel();
		expect(log.calls.map((entry) => entry.call)).toEqual(["preview", "discard"]);
		expect(recorder.repins).toEqual([]);
	});

	test("a press on a handle that does not move neither previews nor sticks again", () => {
		const { controller, log, recorder } = handleSetup();
		controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
		controller.onPointerUp();
		expect(log.calls.filter((entry) => entry.call === "preview")).toEqual([]);
		expect(recorder.repins).toEqual([]);
	});

	test("a second gesture does not repeat the first one's repin", () => {
		const { controller, recorder } = handleSetup();
		controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
		controller.onPointerMove({ event: pointerEvent({ clientX: 1700, clientY: 900, type: "pointermove" }) });
		controller.onPointerUp();
		controller.onCornerPointerDown({ event: pointerEvent({ clientX: 1440, clientY: 810 }), corner: "bottom-right" });
		controller.onPointerUp();
		expect(recorder.repins.length).toBe(1);
	});
});

describe("turning with the rotate handle follows the pointer, stuck or not (B1 of the window e2e: a pull of +20 turned a stuck element 3.3)", () => {
	const CENTRE = { x: 1060, y: 560 }; // the stuck element's middle at the playhead: canvas middle + (100, 20)
	const RADIUS = 200;

	/** The pointer on a circle round the box's middle, at `degrees` clockwise from straight up. */
	function pointerAt({ degrees }: { degrees: number }) {
		const radians = ((degrees - 90) * Math.PI) / 180;
		return { clientX: CENTRE.x + RADIUS * Math.cos(radians), clientY: CENTRE.y + RADIUS * Math.sin(radians) };
	}

	function turn({ stuck, pull, steps = 12 }: { stuck: boolean; pull: number; steps?: number }) {
		const setup = handleSetup({ stuck });
		const start = 10; // where the element's own turn is at the playhead (the pin's key, or the base)
		setup.controller.onRotationPointerDown({ event: pointerEvent({ ...pointerAt({ degrees: start }) }) });
		const seen: number[] = [];
		for (let step = 1; step <= steps; step++) {
			setup.controller.onPointerMove({
				event: pointerEvent({ ...pointerAt({ degrees: start + (pull * step) / steps }), type: "pointermove" }),
			});
			const update = previews({ calls: setup.log.calls }).at(-1);
			seen.push(numberParam({ value: update?.params?.["transform.rotate"] }));
		}
		setup.controller.onPointerUp();
		return { ...setup, seen, start };
	}

	for (const pull of [20, 45, -30, 90]) {
		test(`a stuck element follows a pull of ${pull} degrees at every move, and is stuck again with that turn`, () => {
			const { seen, start, recorder, look, log } = turn({ stuck: true, pull });
			expect(look.rotate).toBeCloseTo(start, 6);
			seen.forEach((rotate, index) => {
				expect(rotate).toBeCloseTo(start + (pull * (index + 1)) / seen.length, 6);
			});
			const expectedCalls: TimelineCall["call"][] = [...seen.map((): TimelineCall["call"] => "preview"), "discard"];
			expect(log.calls.map((entry) => entry.call)).toEqual(expectedCalls);
			const left = recorder.repins[0]?.look;
			expect(recorder.repins.length).toBe(1);
			expect(left?.rotate).toBeCloseTo(start + pull, 6);
			// only the turn changed: the look the user made is the pin's look at the playhead otherwise
			expect(left?.position.x).toBeCloseTo(look.position.x, 6);
			expect(left?.position.y).toBeCloseTo(look.position.y, 6);
			expect(left?.scaleX).toBeCloseTo(look.scaleX, 6);
			expect(left?.scaleY).toBeCloseTo(look.scaleY, 6);
		});

		test(`an element that is not stuck turns by the same ${pull} degrees (the control)`, () => {
			const stuck = turn({ stuck: true, pull });
			const loose = turn({ stuck: false, pull });
			expect(loose.seen).toEqual(stuck.seen);
			expect(loose.recorder.repins).toEqual([]);
			expect(loose.log.calls.at(-1)?.call).toBe("commit");
		});
	}

	describe("when the browser ends the pointer early, the turn so far is what is kept, once (M2 of the review)", () => {
		/**
		 * The handle's end handler is the controller's `onPointerUp` for pointerup,
		 * pointercancel and lostpointercapture alike. Releasing the capture queues
		 * one more `lostpointercapture`, so an early end reaches the controller at
		 * least twice: the second must be a no-op.
		 */
		for (const stuck of [true, false]) {
			test(`${stuck ? "a stuck" : "a loose"} element: pointercancel, then the lostpointercapture it causes, end the gesture exactly once`, () => {
				const setup = handleSetup({ stuck });
				const capture = capturingTarget();
				setup.controller.onRotationPointerDown({
					event: pointerEvent({ ...pointerAt({ degrees: 10 }), target: capture.target }),
				});
				for (const degrees of [13, 16, 19, 22, 25, 30]) {
					setup.controller.onPointerMove({ event: pointerEvent({ ...pointerAt({ degrees }), type: "pointermove" }) });
				}
				expect(setup.controller.isActive).toBe(true);
				expect(capture.isCaptured()).toBe(true);

				// pointercancel
				setup.controller.onPointerUp();
				expect(setup.controller.isActive).toBe(false);
				expect(capture.isCaptured()).toBe(false);
				// the lostpointercapture that releasing the capture causes (and any other late end)
				const lost = capture.takeLostCaptures();
				expect(lost).toBe(1);
				for (let n = 0; n < lost + 1; n++) setup.controller.onPointerUp();

				// one end, not three: the turn up to the last move is committed, or stuck again, once
				const previewsMade = Array.from({ length: 6 }, (): TimelineCall["call"] => "preview");
				expect(setup.log.calls.map((entry) => entry.call)).toEqual([...previewsMade, stuck ? "discard" : "commit"]);
				if (stuck) {
					expect(setup.recorder.repins.length).toBe(1);
					expect(setup.recorder.repins[0]?.look?.rotate).toBeCloseTo(30, 6);
				} else {
					expect(setup.recorder.repins).toEqual([]);
					expect(numberParam({ value: previews({ calls: setup.log.calls }).at(-1)?.params?.["transform.rotate"] })).toBeCloseTo(30, 6);
				}

				// and nothing the pointer does afterwards touches the element
				setup.controller.onPointerMove({ event: pointerEvent({ ...pointerAt({ degrees: 80 }), type: "pointermove" }) });
				expect(setup.log.calls.length).toBe(previewsMade.length + 1);
			});
		}
	});
});
