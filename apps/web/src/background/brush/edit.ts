import type { EditorCore } from "@/core";
import type { ImageElement, VideoElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { addKeyframeAt, addStroke, removeKeyframe, undoStroke, type CutoutEditResult } from "./keyframes";
import type { BrushStroke, ElementCutout } from "./types";

type Target = { trackId: string; element: VideoElement | ImageElement };

/** Half a video frame, in clip-local ticks: strokes within it belong to the same matte keyframe. */
export function keyframeTolerance({ editor }: { editor: EditorCore }): number {
	const fps = editor.project.getActive()?.settings.fps;
	return fps ? Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator / 2) : Math.round(TICKS_PER_SECOND / 60);
}

/** Clip-local time of the playhead, or null when the playhead is outside the clip. */
export function playheadInClip({ editor, element }: { editor: EditorCore; element: VideoElement | ImageElement }): number | null {
	const now = Number(editor.playback.getCurrentTime());
	const start = Number(element.startTime);
	return now >= start && now < start + Number(element.duration) ? now - start : null;
}

/** One update = one undo step. A null cutout removes the field. */
export function writeCutout({ editor, target, cutout }: { editor: EditorCore; target: Target; cutout: ElementCutout | null }) {
	editor.timeline.updateElements({
		updates: [{ trackId: target.trackId, elementId: target.element.id, patch: { cutout: cutout ?? undefined } }],
	});
}

export function paintStroke({ editor, target, time, stroke }: { editor: EditorCore; target: Target; time: number; stroke: BrushStroke }): CutoutEditResult {
	const result = addStroke({
		cutout: target.element.cutout,
		time,
		stroke,
		tolerance: keyframeTolerance({ editor }),
		isVideo: target.element.type === "video",
	});
	if (result.ok) writeCutout({ editor, target, cutout: result.cutout });
	return result;
}

export function undoLastStroke({ editor, target, time }: { editor: EditorCore; target: Target; time: number }) {
	const cutout = target.element.cutout;
	if (!cutout) return;
	writeCutout({ editor, target, cutout: undoStroke({ cutout, time, tolerance: keyframeTolerance({ editor }) }) });
}

export function addMatteKeyframe({ editor, target, time }: { editor: EditorCore; target: Target; time: number }): CutoutEditResult | null {
	const cutout = target.element.cutout;
	if (!cutout) return null;
	const result = addKeyframeAt({ cutout, time, tolerance: keyframeTolerance({ editor }) });
	if (result.ok) writeCutout({ editor, target, cutout: result.cutout });
	return result;
}

export function deleteMatteKeyframe({ editor, target, time }: { editor: EditorCore; target: Target; time: number }) {
	const cutout = target.element.cutout;
	if (!cutout) return;
	writeCutout({ editor, target, cutout: removeKeyframe({ cutout, time, tolerance: keyframeTolerance({ editor }) }) });
}
