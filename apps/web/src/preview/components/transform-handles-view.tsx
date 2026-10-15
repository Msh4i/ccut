"use client";

import { Rotate01Icon } from "@hugeicons/core-free-icons";
import type { Corner, Edge, ElementBounds } from "@/preview/element-bounds";
import { CORNERS, EDGES, getTransformHandleCentres } from "@/preview/handle-layout";
import {
	BoundingBoxOutline,
	CornerHandle,
	EdgeHandle,
	IconHandle,
	getResizeCursor,
} from "./handle-primitives";

/**
 * The selection box of a visual element: the outline, the four corner handles,
 * the right, left and bottom edge handles and the rotate handle. Plain markup
 * of its props, so a test can render it; {@link TransformHandles} supplies the
 * editor state.
 *
 * Every handle is placed from {@link getTransformHandleCentres}, the layout the
 * pin chip keeps clear of, so the two cannot disagree about where a handle is.
 */
export function TransformHandlesView({
	bounds,
	toOverlay,
	displayScale,
	onCornerPointerDown,
	onEdgePointerDown,
	onRotationPointerDown,
	onPointerMove,
	onPointerUp,
}: {
	bounds: ElementBounds;
	toOverlay: ({ canvasX, canvasY }: { canvasX: number; canvasY: number }) => {
		x: number;
		y: number;
	};
	displayScale: { x: number; y: number };
	onCornerPointerDown: ({ event, corner }: { event: React.PointerEvent; corner: Corner }) => void;
	onEdgePointerDown: ({ event, edge }: { event: React.PointerEvent; edge: Edge }) => void;
	onRotationPointerDown: ({ event }: { event: React.PointerEvent }) => void;
	onPointerMove: ({ event }: { event: React.PointerEvent }) => void;
	onPointerUp: () => void;
}) {
	const center = toOverlay({ canvasX: bounds.cx, canvasY: bounds.cy });
	const outlineWidth = Math.abs(bounds.width) * displayScale.x;
	const outlineHeight = Math.abs(bounds.height) * displayScale.y;
	const centres = getTransformHandleCentres({ bounds, toOverlay });

	return (
		<div
			className="pointer-events-none absolute inset-0 overflow-hidden"
			aria-hidden
		>
			<BoundingBoxOutline
				center={center}
				outlineWidth={outlineWidth}
				outlineHeight={outlineHeight}
				rotation={bounds.rotation}
			/>
			{CORNERS.map((corner, index) => {
				const screen = centres.corners[index];
				const angleDeg =
					Math.atan2(screen.y - center.y, screen.x - center.x) *
					(180 / Math.PI);
				return (
					<CornerHandle
						key={corner}
						cursor={getResizeCursor({ angleDeg })}
						screen={screen}
						onPointerDown={(event) => onCornerPointerDown({ event, corner })}
						onPointerMove={(event) => onPointerMove({ event })}
						onPointerUp={onPointerUp}
					/>
				);
			})}
			{EDGES.map((edge, index) => (
				<EdgeHandle
					key={edge}
					edge={edge}
					screen={centres.edges[index]}
					rotation={bounds.rotation}
					onPointerDown={(event) => onEdgePointerDown({ event, edge })}
					onPointerMove={(event) => onPointerMove({ event })}
					onPointerUp={onPointerUp}
				/>
			))}
			<IconHandle
				icon={Rotate01Icon}
				screen={centres.rotation}
				onPointerDown={(event) => onRotationPointerDown({ event })}
				onPointerMove={(event) => onPointerMove({ event })}
				onPointerUp={onPointerUp}
			/>
		</div>
	);
}
