"use client";

import { useEditor } from "@/editor/use-editor";
import type { TimelineElement } from "@/timeline";
import { mediaTimeToSeconds } from "@/wasm";
import { pinViewFor } from "../camera/pin-target";
import type { PinView } from "../camera/pin-view";
import { useCameraPinStore } from "../camera/store";

/**
 * Reads the session store and the project for one element and gives what the
 * section and the chip draw. Both use it, so they always agree.
 */
export function usePinElement({ element }: { element: TimelineElement }): PinView {
	const pins = useCameraPinStore((state) => state.pins);
	const job = useCameraPinStore((state) => state.job);
	const outcomes = useCameraPinStore((state) => state.outcomes);
	const stickingElementId = useCameraPinStore((state) => state.stickingElementId);
	const busyRefused = useCameraPinStore((state) => element.id in state.busyRefusedIds);
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const playhead = useEditor((e) => e.playback.getCurrentTime());
	const canvasSize = useEditor((e) => e.project.getActive().settings.canvasSize);

	return pinViewFor({
		element: { id: element.id, type: element.type },
		elementStartSeconds: mediaTimeToSeconds({ time: element.startTime }),
		pins,
		job,
		outcomes,
		stickingElementId,
		busyRefused,
		scene: tracks ? { tracks, canvasSize, mediaSize: () => undefined, playhead } : null,
	});
}
