/**
 * What the buttons of "Stick to scene" do (slice T4): each one is one call
 * into the session store, so the section and the chip cannot drift apart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CameraPinController, CameraPinOutcome } from "../analysis-types";
import { requestStick, runPinNoticeAction, unstickAndReport } from "../pin-actions";
import { registerCameraPinController, resetCameraPinStore, useCameraPinStore } from "../store";

function recordingController() {
	const calls: string[] = [];
	const answer = (elementId: string): CameraPinOutcome => ({
		status: "cancelled",
		elementId,
	});
	const controller: CameraPinController = {
		async stick({ elementId, mode }) {
			calls.push(`stick:${elementId}:${mode ?? "auto"}`);
			return answer(elementId);
		},
		async repin({ elementId }) {
			calls.push(`repin:${elementId}`);
			return answer(elementId);
		},
		cancel() {
			calls.push("cancel");
		},
	};
	return { controller, calls };
}

describe("pin actions", () => {
	beforeEach(() => resetCameraPinStore());
	afterEach(() => resetCameraPinStore());

	test("Stick asks for an automatic mode unless a mode is chosen", async () => {
		const { controller, calls } = recordingController();
		registerCameraPinController(controller);
		await requestStick({ elementId: "e1" });
		await requestStick({ elementId: "e1", mode: "object" });
		expect(calls).toEqual(["stick:e1:auto", "stick:e1:object"]);
	});

	test("Use scene sticks again in scene mode", async () => {
		const { controller, calls } = recordingController();
		registerCameraPinController(controller);
		await runPinNoticeAction({ elementId: "e1", action: { kind: "use-scene", label: "Use scene" } });
		expect(calls).toEqual(["stick:e1:scene"]);
	});

	test("Unstick of an element that is not stuck reports why, where the notices are read", () => {
		const result = unstickAndReport({ elementId: "e1" });
		expect(result.status).toBe("error");
		const outcome = useCameraPinStore.getState().outcomes.e1;
		expect(outcome).toMatchObject({ status: "error", elementId: "e1", error: "no-element" });
	});
});
