"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { getVisibleElementsWithBounds } from "@/preview/element-bounds";
import { canvasToSourceUv, sourceUvToCanvas } from "./coords";
import { paintStroke, playheadInClip } from "./edit";
import { useBrushStore } from "./brush-store";
import type { BrushPoint, BrushStroke } from "./types";

const MIN_STEP_UV = 0.002;

/**
 * Painting on the preview: the pointer draws a stroke on the selected clip's picture. The point
 * is mapped through the clip's current bounds (position, scale, rotation) to the source picture,
 * so the stroke sticks to the picture. One stroke = one undo step.
 */
export function BrushOverlay() {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const brush = useBrushStore();
	const tracks = useEditor((e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks);
	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor((e) => e.project.getActive().settings.canvasSize);
	const selected = useEditor((e) => e.selection.getSelectedElements());
	const drawing = useRef<BrushPoint[] | null>(null);
	const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
	const [live, setLive] = useState<BrushPoint[]>([]);

	const ref = selected.length === 1 ? selected[0] : null;
	const entry = ref
		? getVisibleElementsWithBounds({ tracks, currentTime, canvasSize, mediaAssets }).find(
				(item) => item.trackId === ref.trackId && item.elementId === ref.elementId,
			)
		: undefined;
	const element = entry?.element;
	if (!entry || !element || (element.type !== "video" && element.type !== "image")) return null;
	const { bounds } = entry;
	const scale = viewport.getDisplayScale();
	const radiusPx = brush.radius * bounds.width * scale.x;

	const uvOf = ({ clientX, clientY }: { clientX: number; clientY: number }): BrushPoint | null => {
		const canvas = viewport.screenToCanvas({ clientX, clientY });
		return canvas ? canvasToSourceUv({ point: canvas, bounds }) : null;
	};

	const strokeFrom = ({ points }: { points: BrushPoint[] }): BrushStroke => ({
		mode: brush.mode,
		radius: brush.radius,
		hardness: brush.hardness,
		feather: brush.feather,
		points,
	});

	const finish = () => {
		const points = drawing.current;
		drawing.current = null;
		setLive([]);
		if (!points || points.length === 0) return;
		const time = playheadInClip({ editor, element });
		if (time === null) {
			toast.info("Move the playhead onto the clip to paint.");
			return;
		}
		const result = paintStroke({ editor, target: { trackId: entry.trackId, element }, time, stroke: strokeFrom({ points }) });
		if (!result.ok) toast.error(result.reason);
	};

	const overlayPoint = ({ clientX, clientY }: { clientX: number; clientY: number }) => {
		const canvas = viewport.screenToCanvas({ clientX, clientY });
		return canvas ? viewport.canvasToOverlay({ canvasX: canvas.x, canvasY: canvas.y }) : null;
	};

	return (
		<div
			className="pointer-events-auto absolute inset-0 touch-none select-none"
			style={{ cursor: "none" }}
			role="application"
			aria-label="Brush cutout canvas"
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				const point = uvOf(event);
				if (!point) return;
				drawing.current = [point];
				setLive([point]);
			}}
			onPointerMove={(event) => {
				setCursor(overlayPoint(event));
				const points = drawing.current;
				if (!points) return;
				const point = uvOf(event);
				const last = points[points.length - 1];
				if (!point || !last || Math.hypot(point.x - last.x, point.y - last.y) < MIN_STEP_UV) return;
				points.push(point);
				setLive([...points]);
			}}
			onPointerUp={finish}
			onPointerCancel={finish}
			onPointerLeave={() => setCursor(null)}
		>
			{cursor ? (
				<svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
					<circle
						cx={cursor.x}
						cy={cursor.y}
						r={Math.max(2, radiusPx)}
						fill="none"
						stroke={brush.mode === "remove" ? "#ef4444" : "#22c55e"}
						strokeWidth={1.5}
					/>
					<circle cx={cursor.x} cy={cursor.y} r={1.5} fill="white" />
				</svg>
			) : null}
			{live.length > 0 ? (
				<svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
					<polyline
						fill="none"
						stroke={brush.mode === "remove" ? "rgba(239,68,68,0.45)" : "rgba(34,197,94,0.45)"}
						strokeWidth={Math.max(2, radiusPx * 2)}
						strokeLinecap="round"
						strokeLinejoin="round"
						points={live
							.map((point) => {
								const canvas = sourceUvToCanvas({ uv: point, bounds });
								const o = viewport.canvasToOverlay({ canvasX: canvas.x, canvasY: canvas.y });
								return `${o.x},${o.y}`;
							})
							.join(" ")}
					/>
				</svg>
			) : null}
		</div>
	);
}
