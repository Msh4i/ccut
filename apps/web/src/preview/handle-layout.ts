import {
	getCornerPosition,
	getEdgeHandlePosition,
	ROTATION_HANDLE_OFFSET,
	type Corner,
	type Edge,
	type ElementBounds,
} from "@/preview/element-bounds";

interface Point {
	x: number;
	y: number;
}

/**
 * The corner handles, in drawing order: top-left, top-right, bottom-right,
 * bottom-left. The selection box mounts them in this order and
 * {@link getTransformHandleCentres} returns their centres in it.
 */
export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-right", "bottom-left"];
/**
 * The edge handles: right, left and bottom. There is none on the top edge, on
 * purpose: the rotate handle stands above it. The selection box mounts them in
 * this order and {@link getTransformHandleCentres} returns their centres in it.
 */
export const EDGES: readonly Edge[] = ["right", "left", "bottom"];

export interface TransformHandleCentres {
	/** The centre of each of {@link CORNERS}, in that order. */
	corners: Point[];
	/** The centre of each of {@link EDGES}, in that order. */
	edges: Point[];
	rotation: Point;
}

/**
 * Where the rotate handle's centre is: the middle of the box's top edge
 * (`topCenter`, overlay px) pushed {@link ROTATION_HANDLE_OFFSET} screen px
 * further out along the box's own up direction.
 */
export function getRotationHandleCentre({
	topCenter,
	rotationDeg,
}: {
	topCenter: Point;
	rotationDeg: number;
}): Point {
	const radians = (rotationDeg * Math.PI) / 180;
	return {
		x: topCenter.x + Math.sin(radians) * ROTATION_HANDLE_OFFSET,
		y: topCenter.y - Math.cos(radians) * ROTATION_HANDLE_OFFSET,
	};
}

/**
 * Every transform handle's centre in overlay px, the same places the selection
 * box draws them (it draws them from this): the four corners, the three edge
 * handles and the rotate handle.
 */
export function getTransformHandleCentres({
	bounds,
	toOverlay,
}: {
	bounds: ElementBounds;
	toOverlay: (point: { canvasX: number; canvasY: number }) => Point;
}): TransformHandleCentres {
	const overlayOf = (point: Point) => toOverlay({ canvasX: point.x, canvasY: point.y });
	const radians = (bounds.rotation * Math.PI) / 180;
	const topCenterLocalY = -bounds.height / 2;
	const topCenter = overlayOf({
		x: bounds.cx - topCenterLocalY * Math.sin(radians),
		y: bounds.cy + topCenterLocalY * Math.cos(radians),
	});
	return {
		corners: CORNERS.map((corner) => overlayOf(getCornerPosition({ bounds, corner }))),
		edges: EDGES.map((edge) => overlayOf(getEdgeHandlePosition({ bounds, edge }))),
		rotation: getRotationHandleCentre({ topCenter, rotationDeg: bounds.rotation }),
	};
}

/**
 * The centres of all eight handles in one list (corners, edges, rotate): the
 * places the pin chip must keep clear of. The one list both the chip and the
 * selection box read, so the chip's forbidden squares cannot drift from the
 * drawn handles.
 */
export function allHandleCentres({ centres }: { centres: TransformHandleCentres }): Point[] {
	return [...centres.corners, ...centres.edges, centres.rotation];
}
