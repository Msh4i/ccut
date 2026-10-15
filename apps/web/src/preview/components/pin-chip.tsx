"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { getVisibleElementsWithBounds } from "@/preview/element-bounds";
import { allHandleCentres, getTransformHandleCentres } from "@/preview/handle-layout";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import {
	CHIP_DEFAULT_SIZE,
	placePinChip,
	visibleChipArea,
	type ChipSize,
} from "@/preview/pin-chip-placement";
import type { TimelineElement } from "@/timeline";
import {
	cancelPinAnalysis,
	requestStick,
	runPinNoticeAction,
	unstickAndReport,
} from "@/tracking/camera/pin-actions";
import { PinChipView } from "./pin-chip-view";
import { usePinElement } from "@/tracking/components/use-pin-element";

/**
 * Mounted over the preview for a selected text, image, sticker or graphic. The
 * layer lets pointer events through to the transform handles; only the chip
 * itself takes them. It sits next to the element and never on one of its
 * transform handles (a press on the rotate handle must reach the handle); where
 * the preview leaves no such room it shrinks to a single button.
 */
export function PinChip({ element }: { element: TimelineElement }) {
	const view = usePinElement({ element });
	const viewport = usePreviewViewport();
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);
	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor((e) => e.project.getActive().settings.canvasSize);

	const entry = tracks
		? getVisibleElementsWithBounds({ tracks, currentTime, canvasSize, mediaAssets }).find(
				(candidate) => candidate.elementId === element.id,
			)
		: undefined;
	const centres = entry
		? getTransformHandleCentres({ bounds: entry.bounds, toOverlay: viewport.canvasToOverlay })
		: null;
	// what the full chip measures now: kept while it is compact, so that it only grows back when it would fit
	const [fullSize, setFullSize] = useState<ChipSize>(CHIP_DEFAULT_SIZE);
	const chipRef = useRef<HTMLDivElement>(null);
	const placement = placePinChip({
		corners: centres?.corners ?? [],
		handles: centres ? allHandleCentres({ centres }) : [],
		area: visibleChipArea({
			scene: {
				left: viewport.sceneLeft,
				top: viewport.sceneTop,
				width: viewport.sceneWidth,
				height: viewport.sceneHeight,
			},
			viewport: { width: viewport.viewportWidth, height: viewport.viewportHeight },
		}),
		size: fullSize,
	});
	const isCompact = placement.mode === "compact";

	useLayoutEffect(() => {
		const node = chipRef.current;
		if (!node || isCompact) return;
		const measure = () => {
			const next = { width: node.offsetWidth, height: node.offsetHeight };
			setFullSize((previous) =>
				previous.width === next.width && previous.height === next.height ? previous : next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [isCompact]);

	return (
		<div className="pointer-events-none absolute inset-0 overflow-hidden">
			<div
				ref={chipRef}
				className="pointer-events-auto absolute w-max"
				style={{ left: placement.left, top: placement.top }}
				onPointerDown={(event) => event.stopPropagation()}
				onDoubleClick={(event) => event.stopPropagation()}
			>
				<PinChipView
					view={view}
					compact={isCompact}
					onStick={() => void requestStick({ elementId: element.id })}
					onCancel={cancelPinAnalysis}
					onUnstick={() => void unstickAndReport({ elementId: element.id })}
					onModeChange={({ mode }) => void requestStick({ elementId: element.id, mode })}
					onNoticeAction={({ action }) => void runPinNoticeAction({ elementId: element.id, action })}
				/>
			</div>
		</div>
	);
}
