import type { SceneTracks } from "@/timeline";
import { withCameraTracker } from "@/tracking/camera3d/engine/tracker-tracks";
import type { CameraTrackerData } from "@/tracking/camera3d/types";
import { TracksChangeCommand } from "./tracks-change-command";

/**
 * Writes a video clip's Track Camera data (`null` removes it): a finished
 * track (analysis + solve), a re-solve, changed effect controls. One undo
 * step. Throws, writing nothing, when there is no such video clip.
 */
export class SetCameraTrackerCommand extends TracksChangeCommand {
	private readonly elementId: string;
	private readonly data: CameraTrackerData | null;

	constructor({ elementId, data }: { elementId: string; data: CameraTrackerData | null }) {
		super();
		this.elementId = elementId;
		this.data = data;
	}

	protected apply(tracks: SceneTracks): SceneTracks {
		return withCameraTracker({ tracks, elementId: this.elementId, data: this.data });
	}
}
