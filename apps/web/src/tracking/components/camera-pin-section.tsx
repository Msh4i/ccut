"use client";

import type { TimelineElement } from "@/timeline";
import { cancelPinAnalysis, requestStick, runPinNoticeAction, unstickAndReport } from "../camera/pin-actions";
import { CameraPinSectionView } from "./camera-pin-section-view";
import { usePinElement } from "./use-pin-element";

/** The Tracking tab of a text, image, sticker or graphic clip. */
export function CameraPinSection({ element }: { element: TimelineElement }) {
	const view = usePinElement({ element });
	return (
		<CameraPinSectionView
			elementId={element.id}
			view={view}
			onStick={() => void requestStick({ elementId: element.id })}
			onCancel={cancelPinAnalysis}
			onUnstick={() => void unstickAndReport({ elementId: element.id })}
			onModeChange={({ mode }) => void requestStick({ elementId: element.id, mode })}
			onNoticeAction={({ action }) => void runPinNoticeAction({ elementId: element.id, action })}
		/>
	);
}
