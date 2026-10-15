import type { RenderedTrackPoints } from "@/scene3d/render/solved-points";
import type { VideoElement } from "@/timeline";
import { BaseNode } from "./base-node";

export interface TrackPointsNodeParams {
	/** The tracked clip whose solved track points are drawn (Render Track Points). */
	video: VideoElement;
}

/**
 * AE "Render Track Points": a layer right above its clip with a cross at
 * each projected solved point alive at the shown frame. Preview and export
 * draw it the same way.
 */
export class TrackPointsNode extends BaseNode<
	TrackPointsNodeParams,
	RenderedTrackPoints
> {}
