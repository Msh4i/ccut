"use client";

import { useEditor } from "@/editor/use-editor";
import type { CameraElement } from "@/timeline";
import { findElementInTracks } from "@/tracking/host";
import { getCameraTrackerApi } from "@/tracking/camera3d/session";
import { buildCameraTab } from "@/tracking/camera3d/ui/layer-tabs";
import { CameraLayerTabView } from "./camera-layer-tab-view";

/** The camera layer's tab: its source clip, the angle of view at the playhead, Hide (one undo step). */
export function CameraLayerTab({
	element,
	trackId,
}: {
	element: CameraElement;
	trackId: string;
}) {
	const editor = useEditor();
	const time = useEditor((e) => e.playback.getCurrentTime());
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const found = tracks
		? findElementInTracks({ tracks, elementId: element.sourceElementId })
		: null;
	const source = found?.element.type === "video" ? found.element : null;
	const api = getCameraTrackerApi();
	const decoded = source && api ? api.decoded({ elementId: source.id }) : null;
	const model = buildCameraTab({ camera: element, source, decoded, time });

	return (
		<CameraLayerTabView
			elementId={element.id}
			model={model}
			onHiddenChange={(hidden) =>
				editor.timeline.updateElements({
					updates: [{ trackId, elementId: element.id, patch: { hidden } }],
				})
			}
		/>
	);
}
