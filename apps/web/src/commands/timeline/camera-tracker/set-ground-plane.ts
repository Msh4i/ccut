import type { Target } from "@/scene3d/types";
import type { SceneTracks } from "@/timeline";
import { applyGroundPlane } from "@/tracking/camera3d/engine/tracker-tracks";
import { TracksChangeCommand } from "./tracks-change-command";

/**
 * AE "Set Ground Plane and Origin": re-bases the clip's solved world on the
 * target (plane -> y = 0 facing up, centre -> origin) and moves every 3D
 * layer seen through the clip's camera with it, so nothing moves on screen.
 * One undo step. Throws, writing nothing, without a solve or with a
 * degenerate target.
 */
export class SetGroundPlaneCommand extends TracksChangeCommand {
	private readonly elementId: string;
	private readonly target: Target;
	private readonly frame: number;

	constructor({ elementId, target, frame }: { elementId: string; target: Target; frame: number }) {
		super();
		this.elementId = elementId;
		this.target = target;
		this.frame = frame;
	}

	protected apply(tracks: SceneTracks): SceneTracks {
		return applyGroundPlane({ tracks, elementId: this.elementId, target: this.target, frame: this.frame });
	}
}
