import type { SceneTracks } from "@/timeline";
import {
	findVideoClip,
	withCameraTracker,
	withDeletedTrackPoints,
} from "@/tracking/camera3d/engine/tracker-tracks";
import { TracksChangeCommand } from "./tracks-change-command";

/**
 * AE "Delete Selected Points": the tracks go into `deletedTrackIds` (whole
 * tracks, across time) and the solve is marked stale; the solve itself is
 * kept until the user solves again. One undo step. Throws, writing nothing,
 * when the clip has no tracker data or no new valid id is given.
 */
export class DeleteTrackPointsCommand extends TracksChangeCommand {
	private readonly elementId: string;
	private readonly trackIds: readonly number[];

	constructor({ elementId, trackIds }: { elementId: string; trackIds: readonly number[] }) {
		super();
		this.elementId = elementId;
		this.trackIds = [...trackIds];
	}

	protected apply(tracks: SceneTracks): SceneTracks {
		const data = findVideoClip({ tracks, elementId: this.elementId })?.element.cameraTracker;
		if (!data) throw new Error("Delete points: the clip has no Track Camera data.");
		const next = withDeletedTrackPoints({ data, trackIds: this.trackIds });
		if (!next) throw new Error("Delete points: no new point to delete.");
		return withCameraTracker({ tracks, elementId: this.elementId, data: next });
	}
}
