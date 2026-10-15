import { hasKeyframesForPath } from "@/animation/keyframe-query";
import type { ElementAnimations } from "@/animation/types";
import type { SceneTracks } from "@/timeline";
import { findElementInTracks } from "@/tracking/host";
import type { CameraAnalysisJob, CameraPinOutcome } from "./analysis-types";
import { CAMERA_PIN_PATHS } from "./pin-animations";
import {
	isPinCurrent,
	selectPinHost,
	type CameraPinRecord,
	type CameraPins,
	type PinScene,
} from "./pin-element";
import { buildPinView, type PinView } from "./pin-view";

/**
 * Does the element still carry a pin's keys? A stick writes all five channels;
 * undoing it takes them away while the session's pin record stays, so the
 * record alone does not make an element stuck.
 */
export function hasCameraPinKeys({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): boolean {
	return Object.values(CAMERA_PIN_PATHS).every((propertyPath) =>
		hasKeyframesForPath({ animations, propertyPath }),
	);
}

/** Stuck = a pin record for the element AND the element really has the pin's keys. */
export function isElementStuck({
	pins,
	tracks,
	elementId,
}: {
	pins: CameraPins;
	tracks: SceneTracks | null | undefined;
	elementId: string;
}): boolean {
	if (!(elementId in pins) || !tracks) return false;
	const element = findElementInTracks({ tracks, elementId })?.element;
	return !!element && hasCameraPinKeys({ animations: element.animations });
}

/**
 * What the UI asks the project before it draws "Stick to scene": does a video
 * lie under the element (so there is something to stick to), and, for a pinned
 * element, are its keys still there (an undo takes them) and is the host still
 * where the pin was written (keys are baked, a moved, trimmed or retimed host
 * leaves them behind).
 */
export function pinTargetState({
	scene,
	elementId,
	pin,
}: {
	scene: PinScene;
	elementId: string;
	pin: CameraPinRecord | null;
}): { hasVideoUnder: boolean; hasPinKeys: boolean; isPinCurrent: boolean } {
	const hasVideoUnder = selectPinHost({ scene, elementId, box: null }) !== null;
	if (!pin) return { hasVideoUnder, hasPinKeys: false, isPinCurrent: true };
	const hasPinKeys = isElementStuck({
		pins: { [pin.elementId]: pin },
		tracks: scene.tracks,
		elementId,
	});
	const host = findElementInTracks({ tracks: scene.tracks, elementId: pin.hostElementId })?.element;
	return {
		hasVideoUnder,
		hasPinKeys,
		isPinCurrent: host?.type === "video" && isPinCurrent({ pin, host }),
	};
}

/**
 * What the section and the chip draw for one element: the session's state (the
 * store) and what the project says about the element (`pinTargetState`), put
 * together. `usePinElement` calls exactly this, and the tests call it too, so a
 * wire dropped here fails a test, and one dropped by the hook fails the build
 * (every input is required). No scene open: nothing is stuck, nothing to stick to.
 */
export function pinViewFor({
	element,
	elementStartSeconds,
	pins,
	job,
	outcomes,
	stickingElementId,
	busyRefused,
	scene,
}: {
	element: { id: string; type: string };
	/** The element's start on the timeline, in seconds. */
	elementStartSeconds: number;
	pins: CameraPins;
	job: CameraAnalysisJob;
	outcomes: Readonly<Record<string, CameraPinOutcome>>;
	stickingElementId: string | null;
	/** The engine refused this element's stick as busy during the run in flight. */
	busyRefused: boolean;
	scene: PinScene | null;
}): PinView {
	const target = scene
		? pinTargetState({ scene, elementId: element.id, pin: pins[element.id] ?? null })
		: { hasVideoUnder: false, hasPinKeys: false, isPinCurrent: true };
	return buildPinView({
		element,
		pins,
		job,
		outcomes,
		stickingElementId,
		hasVideoUnder: target.hasVideoUnder,
		isPinCurrent: target.isPinCurrent,
		hasPinKeys: target.hasPinKeys,
		busyRefused,
		elementStartSeconds,
	});
}
