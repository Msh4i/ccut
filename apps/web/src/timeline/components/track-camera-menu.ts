import type { TimelineElement } from "@/timeline";
import {
	CAMERA_TRACKER_NOT_READY_MESSAGE,
	type CameraTrackerApi,
} from "@/tracking/camera3d/session";
import type { CameraTrackerPhase } from "@/tracking/camera3d/types";

export const TRACK_CAMERA_MENU_LABEL = "Track Camera";

/**
 * The "Track Camera" item of a clip's context menu: video clips only,
 * greyed out while a camera track is running (one job at a time).
 */
export function trackCameraMenuItem({
	element,
	phase,
}: {
	element: TimelineElement;
	phase: CameraTrackerPhase;
}): { label: string; disabled: boolean } | null {
	if (element.type !== "video") return null;
	return { label: TRACK_CAMERA_MENU_LABEL, disabled: phase.phase !== "idle" };
}

/**
 * Starts Track Camera on a clip from the menu. The run's progress and its
 * result are shown by the session's banner; this only says what the banner
 * cannot: the engine is missing, busy with another clip, or broke.
 */
export async function startTrackCamera({
	elementId,
	api,
	notify,
}: {
	elementId: string;
	api: CameraTrackerApi | null;
	notify: (message: string) => void;
}): Promise<void> {
	if (!api) {
		notify(CAMERA_TRACKER_NOT_READY_MESSAGE);
		return;
	}
	try {
		const outcome = await api.trackCamera({ elementId });
		if (outcome.status === "busy") notify(outcome.message);
	} catch (error) {
		notify(error instanceof Error && error.message ? error.message : "Track Camera failed.");
	}
}
