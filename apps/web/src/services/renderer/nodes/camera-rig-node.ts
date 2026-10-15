import type { ViewCamera } from "@/scene3d/types";
import type { SceneTracks } from "@/timeline";
import { BaseNode } from "./base-node";

export interface CameraRigNodeParams {
	/** All tracks of the scene: camera elements and the clips they reproduce. */
	tracks: SceneTracks;
}

/**
 * Draws nothing. Resolves to the camera every 3D layer of the frame is drawn
 * through (`scene3d/render/active-camera.ts`): the topmost active camera
 * element's solved camera, or the default camera of the canvas.
 */
export class CameraRigNode extends BaseNode<CameraRigNodeParams, ViewCamera> {}
