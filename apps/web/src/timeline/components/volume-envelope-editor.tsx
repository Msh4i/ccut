"use client";

import { useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { resolveAnimationPathValueAtTime } from "@/animation";
import {
	clampDb,
	getElementVolume,
	type AudioCapableElement,
} from "@/timeline/audio-state";
import {
	buildEnvelopePolyline,
	getVolumeEnvelopePoints,
	pointFromPosition,
} from "@/timeline/volume-envelope";
import { mediaTime } from "@/wasm";
import { formatNumberForDisplay } from "@/utils/math";
import { TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";

const POINT_SIZE_PX = 10;
const LINE_HIT_WIDTH = 14;

interface DragState {
	id: string;
	x: number;
	y: number;
}

/**
 * The clip's volume as a line with points, the way CapCut shows it: drag a
 * point to change when and how loud, double-click the line to add a point
 * (it keeps the sound as it is), double-click a point to remove it. Every
 * change is a real `volume` keyframe, so preview and export play the same
 * curve. A drag is one undo step, written when the pointer is released.
 */
export function VolumeEnvelopeEditor({
	element,
	trackId,
}: {
	element: AudioCapableElement;
	trackId: string;
}) {
	const editor = useEditor();
	const surfaceRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const points = getVolumeEnvelopePoints({ element });
	const polyline = buildEnvelopePolyline({ element });

	const readFractions = ({
		clientX,
		clientY,
	}: {
		clientX: number;
		clientY: number;
	}) => {
		const rect = surfaceRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			return null;
		}
		return {
			x: (clientX - rect.left) / rect.width,
			y: (clientY - rect.top) / rect.height,
		};
	};

	const select = () =>
		editor.selection.setSelectedElements({
			elements: [{ trackId, elementId: element.id }],
		});

	const addPointOnLine = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		const at = readFractions(event);
		if (!at) return;
		const time = pointFromPosition({ x: at.x, y: 0, duration: element.duration }).time;
		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId,
					elementId: element.id,
					propertyPath: "volume",
					time: mediaTime({ ticks: time }),
					value: resolveAnimationPathValueAtTime({
						animations: element.animations,
						propertyPath: "volume",
						localTime: time,
						fallbackValue: getElementVolume({ element }),
					}),
				},
			],
		});
	};

	const removePoint = ({ event, id }: { event: React.MouseEvent; id: string }) => {
		event.preventDefault();
		event.stopPropagation();
		editor.timeline.removeKeyframes({
			keyframes: [
				{ trackId, elementId: element.id, propertyPath: "volume", keyframeId: id },
			],
		});
	};

	const moveDrag = ({ event, id }: { event: React.PointerEvent; id: string }) => {
		const at = readFractions(event);
		if (!at) return;
		setDrag({
			id,
			x: Math.max(0, Math.min(1, at.x)),
			y: Math.max(0, Math.min(1, at.y)),
		});
	};

	const endDrag = ({ commit }: { commit: boolean }) => {
		const current = drag;
		setDrag(null);
		if (!commit || !current) return;
		const next = pointFromPosition({
			x: current.x,
			y: current.y,
			duration: element.duration,
		});
		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId,
					elementId: element.id,
					propertyPath: "volume",
					time: mediaTime({ ticks: next.time }),
					value: next.db,
					keyframeId: current.id,
				},
			],
		});
	};

	return (
		<div className="pointer-events-none absolute inset-0">
			<div ref={surfaceRef} className="absolute inset-0">
				<svg
					className="absolute inset-0 size-full"
					viewBox="0 0 100 100"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					<polyline
						points={polyline.map(([x, y]) => `${x},${y}`).join(" ")}
						fill="none"
						stroke="white"
						strokeOpacity={0.85}
						strokeWidth={1.5}
						vectorEffect="non-scaling-stroke"
					/>
					<polyline
						points={polyline.map(([x, y]) => `${x},${y}`).join(" ")}
						fill="none"
						stroke="transparent"
						strokeWidth={LINE_HIT_WIDTH}
						vectorEffect="non-scaling-stroke"
						style={{ pointerEvents: "stroke" }}
						onMouseDown={(event) => event.stopPropagation()}
						onDoubleClick={addPointOnLine}
					>
						<title>Double-click to add a volume point</title>
					</polyline>
				</svg>
				{points.map((point) => {
					const dragging = drag?.id === point.id;
					const shown = dragging
						? pointFromPosition({
								x: drag.x,
								y: drag.y,
								duration: element.duration,
							})
						: { time: point.time, db: point.db };
					const left = dragging ? drag.x * 100 : point.xPercent;
					const top = dragging ? drag.y * 100 : point.yPercent;
					return (
						<button
							key={point.id}
							type="button"
							aria-label={`Volume point ${formatNumberForDisplay({ value: clampDb(shown.db), fractionDigits: 1 })} dB`}
							title={`${formatNumberForDisplay({ value: clampDb(shown.db), fractionDigits: 1 })} dB at ${formatNumberForDisplay({ value: shown.time / TICKS_PER_SECOND, fractionDigits: 2 })} s. Drag to move, double-click to remove.`}
							className={cn(
								"pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 touch-none cursor-grab rounded-full border border-black bg-white",
								dragging && "cursor-grabbing bg-primary",
							)}
							style={{
								left: `${left}%`,
								top: `${top}%`,
								width: POINT_SIZE_PX,
								height: POINT_SIZE_PX,
							}}
							onMouseDown={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
							}}
							onDoubleClick={(event) => removePoint({ event, id: point.id })}
							onPointerDown={(event) => {
								if (event.button !== 0) return;
								event.preventDefault();
								event.stopPropagation();
								select();
								event.currentTarget.setPointerCapture(event.pointerId);
								moveDrag({ event, id: point.id });
							}}
							onPointerMove={(event) => {
								if (drag?.id === point.id) moveDrag({ event, id: point.id });
							}}
							onPointerUp={(event) => {
								event.stopPropagation();
								endDrag({ commit: true });
							}}
							onPointerCancel={() => endDrag({ commit: false })}
						/>
					);
				})}
			</div>
		</div>
	);
}
