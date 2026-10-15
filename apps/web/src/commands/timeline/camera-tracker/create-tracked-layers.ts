import { createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import type { CreateCameraElement, CreateTimelineElement, SceneTracks } from "@/timeline";
import { insertTrackedLayers } from "@/tracking/camera3d/engine/tracker-tracks";
import { generateUUID } from "@/utils/id";
import { TracksChangeCommand } from "./tracks-change-command";

/**
 * AE "Create Text / Solid / Null [and Camera]", "Create Multiple ...",
 * "Create Camera": inserts the created 3D layers on new tracks at the top
 * and, when given, the camera on a new camera track above them, as ONE
 * undo step (one snapshot, so it is all or nothing; a batch of insert
 * commands could half-apply). Ids are made once, so a redo repeats them.
 * The created layers (or the camera alone) end up selected.
 */
export class CreateTrackedLayersCommand extends TracksChangeCommand {
	private readonly layers: readonly CreateTimelineElement[];
	private readonly camera: CreateCameraElement | null;
	private readonly elementIds: string[];
	private readonly trackIds: string[];
	private readonly cameraElementId: string;
	private readonly cameraTrackId: string;
	private placed: Array<{ trackId: string; elementId: string }> = [];

	constructor({
		layers,
		camera,
	}: {
		layers: readonly CreateTimelineElement[];
		camera: CreateCameraElement | null;
	}) {
		super();
		this.layers = [...layers];
		this.camera = camera;
		this.elementIds = layers.map(() => generateUUID());
		this.trackIds = layers.map(() => generateUUID());
		this.cameraElementId = generateUUID();
		this.cameraTrackId = generateUUID();
	}

	getElementIds(): string[] {
		return [...this.elementIds];
	}

	getCameraElementId(): string | null {
		return this.camera ? this.cameraElementId : null;
	}

	protected apply(tracks: SceneTracks): SceneTracks {
		const next = insertTrackedLayers({
			tracks,
			layers: this.layers,
			camera: this.camera,
			elementIds: this.elementIds,
			cameraElementId: this.cameraElementId,
			trackIds: this.trackIds,
			cameraTrackId: this.cameraTrackId,
		});
		const wanted = new Set(this.layers.length > 0 ? this.elementIds : [this.cameraElementId]);
		this.placed = next.overlay.flatMap((track) =>
			track.elements.filter((element) => wanted.has(element.id)).map((element) => ({ trackId: track.id, elementId: element.id })),
		);
		return next;
	}

	protected selectionAfter(): CommandResult | undefined {
		return createElementSelectionResult(this.placed);
	}
}
