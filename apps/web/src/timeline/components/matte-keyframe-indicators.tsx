"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { KeyframeIcon } from "@hugeicons/core-free-icons";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { deleteMatteKeyframe } from "@/background/brush/edit";
import { useEditor } from "@/editor/use-editor";
import type { ImageElement, VideoElement } from "@/timeline";
import { timelineTimeToSnappedPixels } from "@/timeline";
import { addMediaTime, mediaTime, type MediaTime } from "@/wasm";

/**
 * The matte keyframes of a video clip's brush cutout: small blue diamonds along the bottom edge
 * of the selected clip. Click moves the playhead there; right-click deletes the keyframe.
 */
export function MatteKeyframeIndicators({
	element,
	trackId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
}: {
	element: VideoElement | ImageElement;
	trackId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
}) {
	const editor = useEditor();
	if (element.type !== "video" || !element.cutout) return null;
	return element.cutout.keyframes.map((keyframe) => {
		const left = timelineTimeToSnappedPixels({ time: addMediaTime({ a: displayedStartTime, b: mediaTime({ ticks: keyframe.time }) }), zoomLevel }) - elementLeft;
		return (
			<ContextMenu key={keyframe.time}>
				<ContextMenuTrigger asChild>
					<button
						type="button"
						className="pointer-events-auto absolute bottom-0.5 -translate-x-1/2 cursor-pointer"
						style={{ left }}
						aria-label="Matte keyframe"
						title="Matte keyframe (right-click to delete)"
						onClick={(event) => {
							event.stopPropagation();
							editor.playback.seek({ time: addMediaTime({ a: element.startTime, b: mediaTime({ ticks: keyframe.time }) }) });
						}}
					>
						<HugeiconsIcon icon={KeyframeIcon} className="size-3 fill-sky-400 text-black" strokeWidth={1.5} />
					</button>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onSelect={() => deleteMatteKeyframe({ editor, target: { trackId, element }, time: keyframe.time })}>
						Delete matte keyframe
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		);
	});
}
