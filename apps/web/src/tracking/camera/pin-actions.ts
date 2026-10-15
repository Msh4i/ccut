import type { CameraUnstickResult, PinModeChoice } from "./pin-element";
import type { CameraPinOutcome } from "./analysis-types";
import type { PinNoticeAction } from "./pin-view";
import { useCameraPinStore } from "./store";

/**
 * What the buttons of "Stick to scene" do. Both the Tracking tab's section and
 * the preview chip call these, so one press means the same thing in each.
 */

export function requestStick({
	elementId,
	mode,
}: {
	elementId: string;
	mode?: PinModeChoice;
}): Promise<CameraPinOutcome> {
	return useCameraPinStore.getState().stick({ elementId, mode });
}

export function runPinNoticeAction({
	elementId,
	action,
}: {
	elementId: string;
	action: PinNoticeAction;
}): Promise<CameraPinOutcome> {
	switch (action.kind) {
		case "use-scene":
			return requestStick({ elementId, mode: "scene" });
	}
}

export function cancelPinAnalysis(): void {
	useCameraPinStore.getState().cancel();
}

/** Removes the pin; when that fails the reason is recorded so the notices show it. */
export function unstickAndReport({
	elementId,
}: {
	elementId: string;
}): CameraUnstickResult {
	const store = useCameraPinStore.getState();
	const result = store.unstick({ elementId });
	if (result.status === "error") {
		store.recordOutcome({ outcome: { ...result, elementId } });
	}
	return result;
}
