import { toast } from "sonner";
import type { VideoElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import type {
	CameraTrackerApi,
	CreateTrackedLayersArgs,
	DecodedCameraTracker,
} from "@/tracking/camera3d/session";
import { runFeedback } from "@/tracking/camera3d/ui/interaction";
import { analysisFrameAt, clipSourceTimeAt } from "@/tracking/camera3d/ui/view";

/** The UI's calls into the engine: never throw, never leave a promise rejection unhandled. */

function notify(feedback: ReturnType<typeof runFeedback>): void {
	if (!feedback) return;
	if (feedback.kind === "error") {
		toast.error(feedback.message);
	} else {
		toast.info(feedback.message);
	}
}

/** Track Camera / Analyze (`track`) or Solve again (`resolve`). */
export async function runCameraTracker({
	api,
	elementId,
	mode,
}: {
	api: CameraTrackerApi;
	elementId: string;
	mode: "track" | "resolve";
}): Promise<void> {
	try {
		const outcome =
			mode === "resolve"
				? await api.resolve({ elementId })
				: await api.trackCamera({ elementId });
		notify(runFeedback({ outcome }));
	} catch (error) {
		notify(runFeedback({ error }));
	}
}

export function createTrackedLayers({
	api,
	args,
}: {
	api: CameraTrackerApi;
	args: CreateTrackedLayersArgs;
}): void {
	try {
		notify(runFeedback({ created: api.createLayers(args) }));
	} catch (error) {
		notify(runFeedback({ error }));
	}
}

/** Runs a synchronous engine call (settings, delete, ground plane) and reports a throw instead of crashing the panel. */
export function callEngine(call: () => void): void {
	try {
		call();
	} catch (error) {
		notify(runFeedback({ error }));
	}
}

/** The analysis frame the playhead shows on this clip (layers are oriented with the camera of this frame). */
export function playheadAnalysisFrame({
	clip,
	decoded,
	time,
}: {
	clip: VideoElement;
	decoded: DecodedCameraTracker;
	time: MediaTime;
}): number {
	return analysisFrameAt({
		sourceTime: clipSourceTimeAt({ clip, time }),
		sourceStart: decoded.data.sourceStart,
		fps: decoded.tracks?.fps ?? decoded.data.tracks.fps,
	});
}
