import { create } from "zustand";
import { EditorCore } from "@/core";
import type { Transform } from "@/rendering";
import {
	type CameraAnalysisJob,
	type CameraPinController,
	type CameraPinOutcome,
	IDLE_CAMERA_JOB,
} from "./analysis-types";
import {
	type CameraPinRecord,
	type CameraPins,
	type CameraUnstickResult,
	type PinFailure,
	type PinModeChoice,
	CAMERA_PIN_MESSAGES,
	unstickElement,
	withPin,
	withoutPin,
} from "./pin-element";
import { isElementStuck } from "./pin-target";

/** No engine is registered: only outside an open editor session (it registers at editor start). */
export const CAMERA_PIN_NOT_READY_MESSAGE =
	"Stick to scene needs an open project. Reopen the project and try again.";

/**
 * Session state of "Stick to scene" (nothing here is saved with the project: the
 * keyframes the pin wrote are, the pin records and analyses are not).
 * The UI reads this store and calls its actions. The engine registers a controller
 * ({@link registerCameraPinController}) and reports through `setJob`/`recordOutcome`.
 */
export interface CameraPinState {
	/** Pins by element id: what each stuck element follows and which stretch its keys cover. */
	pins: CameraPins;
	job: CameraAnalysisJob;
	/** The last outcome per element, for the section and the chip to show. */
	outcomes: Readonly<Record<string, CameraPinOutcome>>;
	/**
	 * The element whose stick or re-stick is awaiting the engine. `job` says an
	 * analysis runs but not for which clip, so this lets the UI show progress and
	 * Cancel on the right one. Set and cleared by `stick`/`repin` themselves.
	 */
	stickingElementId: string | null;
	/**
	 * Elements whose stick or re-stick the engine refused as `busy` during the run
	 * now in flight. A refusal says nothing about the element, so its last outcome
	 * stays in `outcomes`; this is dropped when the run ends.
	 */
	busyRefusedIds: Readonly<Record<string, true>>;
}

export interface CameraPinActions {
	stick(args: { elementId: string; mode?: PinModeChoice }): Promise<CameraPinOutcome>;
	repin(args: { elementId: string; look?: Transform }): Promise<CameraPinOutcome>;
	/**
	 * Remove the pin's keys (one undo step). The record is kept while no pin keys
	 * remain, so the undo brings the element back as stuck; it is forgotten when
	 * keys of another stretch remain.
	 */
	unstick(args: { elementId: string }): CameraUnstickResult;
	/** Stop the running analysis, if any. */
	cancel(): void;
	/** Engine only: the analysis job moved on. */
	setJob(job: CameraAnalysisJob): void;
	/** Engine only: an element's stick came to something; a `pin` is recorded when keys were written. */
	recordOutcome(args: { outcome: CameraPinOutcome; pin?: CameraPinRecord }): void;
	/** Engine/UI: the element is gone or the user removed its pin by other means. */
	forget(args: { elementId: string }): void;
}

let controller: CameraPinController | null = null;

/** The engine registers itself here; `null` unregisters (tests, hot reload). */
export function registerCameraPinController(next: CameraPinController | null): void {
	controller = next;
}

function notReady({ elementId }: { elementId: string }): CameraPinOutcome & PinFailure {
	return {
		status: "error",
		elementId,
		error: "apply-failed",
		message: CAMERA_PIN_NOT_READY_MESSAGE,
	};
}

const INITIAL_STATE: CameraPinState = {
	pins: {},
	job: IDLE_CAMERA_JOB,
	outcomes: {},
	stickingElementId: null,
	busyRefusedIds: {},
};

/** An engine that throws is an outcome like any other failure, never a rejection the UI has to catch. */
async function settle({
	elementId,
	run,
}: {
	elementId: string;
	run: () => Promise<CameraPinOutcome>;
}): Promise<CameraPinOutcome> {
	try {
		return await run();
	} catch (error) {
		// the raw message is for whoever debugs it, not for the notice
		console.error("Stick to scene failed:", error);
		return {
			status: "error",
			elementId,
			error: "apply-failed",
			message: CAMERA_PIN_MESSAGES["apply-failed"],
		};
	}
}

/** Does the element still have the pin's keys in the scene now? */
function isStuckInActiveScene({ pin }: { pin: CameraPinRecord }): boolean {
	return isElementStuck({
		pins: { [pin.elementId]: pin },
		tracks: EditorCore.getInstance().scenes.getActiveSceneOrNull()?.tracks,
		elementId: pin.elementId,
	});
}

function isBusy(outcome: CameraPinOutcome): boolean {
	return outcome.status === "error" && outcome.error === "busy";
}

/**
 * The state after a stick or re-stick answered. A `busy` refusal keeps the
 * element's last outcome and is remembered for the running job only; the
 * in-flight marker is cleared only by the call that set it.
 */
function settled({
	state,
	elementId,
	outcome,
	ownsMarker,
}: {
	state: CameraPinState;
	elementId: string;
	outcome: CameraPinOutcome;
	ownsMarker: boolean;
}): Partial<CameraPinState> {
	const stickingElementId =
		ownsMarker && state.stickingElementId === elementId ? null : state.stickingElementId;
	if (isBusy(outcome)) {
		return {
			stickingElementId,
			busyRefusedIds:
				state.job.state === "running"
					? { ...state.busyRefusedIds, [elementId]: true }
					: state.busyRefusedIds,
		};
	}
	const { [elementId]: _refused, ...busyRefusedIds } = state.busyRefusedIds;
	return {
		outcomes: { ...state.outcomes, [elementId]: outcome },
		stickingElementId,
		busyRefusedIds,
	};
}

export const useCameraPinStore = create<CameraPinState & CameraPinActions>()(
	(set, get) => ({
		...INITIAL_STATE,

		async stick({ elementId, mode }) {
			const engine = controller;
			// while a run is in flight the engine refuses at once: the running element keeps its marker
			const ownsMarker = get().job.state !== "running";
			if (ownsMarker) set({ stickingElementId: elementId });
			const outcome = await settle({
				elementId,
				run: async () =>
					engine ? engine.stick({ elementId, mode }) : notReady({ elementId }),
			});
			// The controller records pins itself (it knows the record); the outcome is kept either way.
			set((state) => settled({ state, elementId, outcome, ownsMarker }));
			return outcome;
		},

		async repin({ elementId, look }) {
			const engine = controller;
			const ownsMarker = get().job.state !== "running";
			if (ownsMarker) set({ stickingElementId: elementId });
			const outcome = await settle({
				elementId,
				run: async () =>
					engine ? engine.repin({ elementId, look }) : notReady({ elementId }),
			});
			set((state) => settled({ state, elementId, outcome, ownsMarker }));
			return outcome;
		},

		unstick({ elementId }) {
			const pin = get().pins[elementId];
			// the record alone is not a stuck element: without the pin's keys there is nothing to remove (and no undo step to write)
			if (!pin || !isStuckInActiveScene({ pin })) {
				return {
					status: "error",
					error: "no-element",
					message: "This clip is not stuck to the scene.",
				};
			}
			const result = unstickElement({ elementId, pin });
			if (result.status !== "unstuck") return result;
			if (isStuckInActiveScene({ pin })) {
				// keys of another stretch remain: the record no longer describes what the element has
				get().forget({ elementId });
			} else {
				// The record stays, so that Ctrl+Z (which brings the keys back) brings "Stuck" back
				// with it; without keys the element reads as not stuck.
				set((state) => {
					const { [elementId]: last, ...others } = state.outcomes;
					const { [elementId]: _refused, ...busyRefusedIds } = state.busyRefusedIds;
					// only a pinned outcome is about those keys; any other would show on an idle element
					return { outcomes: last?.status === "pinned" ? state.outcomes : others, busyRefusedIds };
				});
			}
			return result;
		},

		cancel() {
			controller?.cancel();
		},

		setJob(job) {
			// a busy refusal belongs to the run it met
			set(job.state === "running" ? { job } : { job, busyRefusedIds: {} });
		},

		recordOutcome({ outcome, pin }) {
			set((state) => ({
				outcomes: { ...state.outcomes, [outcome.elementId]: outcome },
				pins: pin ? withPin({ pins: state.pins, pin }) : state.pins,
			}));
		},

		forget({ elementId }) {
			set((state) => {
				const { [elementId]: _gone, ...outcomes } = state.outcomes;
				const { [elementId]: _refused, ...busyRefusedIds } = state.busyRefusedIds;
				return { pins: withoutPin({ pins: state.pins, elementId }), outcomes, busyRefusedIds };
			});
		},
	}),
);

/** Test helper: back to a clean session. */
export function resetCameraPinStore(): void {
	controller = null;
	useCameraPinStore.setState({ ...INITIAL_STATE });
}
