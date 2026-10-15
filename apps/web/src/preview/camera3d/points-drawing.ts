import type { Target } from "@/scene3d/types";
import type { Point2 } from "@/tracking/camera3d/ui/delaunay";
import type { Gesture } from "@/tracking/camera3d/ui/interaction";
import { markerHue } from "@/tracking/camera3d/ui/markers";
import type { OverlayScene } from "@/tracking/camera3d/ui/overlay-scene";
import type { Selection } from "@/tracking/camera3d/ui/selection";
import { TARGET_RING_FACTORS, targetOutline } from "@/tracking/camera3d/ui/target";

/** What the track points SVG draws, in overlay pixels (the preview's `canvasToOverlay`). */
export interface PointsDrawing {
	markers: Array<{
		trackId: number;
		x: number;
		y: number;
		/** Screen pixels. */
		size: number;
		hue: number;
		selected: boolean;
		/** No solved 3D position: shown, but it cannot define a target. */
		dim: boolean;
	}>;
	triangle: Point2[] | null;
	/** The target's bullseye rings, outer first; `null` when there is none or part of it is behind the camera. */
	rings: Point2[][] | null;
	marquee: { x: number; y: number; width: number; height: number } | null;
	lasso: Point2[] | null;
}

export function buildPointsDrawing({
	scene,
	selection,
	hoverTriangle,
	target,
	gesture,
	toOverlay,
}: {
	scene: OverlayScene;
	selection: Selection;
	hoverTriangle: readonly Point2[] | null;
	target: Target | null;
	gesture: Gesture;
	toOverlay: (point: Point2) => Point2;
}): PointsDrawing {
	const markers = scene.points.map((point, index) => {
		const at = toOverlay(point);
		return {
			trackId: point.trackId,
			x: at.x,
			y: at.y,
			size: scene.sizes[index],
			hue: markerHue(point.trackId),
			selected: selection.includes(point.trackId),
			dim: point.world === null,
		};
	});
	let rings: Point2[][] | null = null;
	if (target && scene.view) {
		const view = scene.view;
		const outlines = TARGET_RING_FACTORS.map((radiusFactor) =>
			targetOutline({ target, view, radiusFactor }),
		);
		if (outlines.every((outline) => outline !== null)) {
			rings = outlines.map((outline) => (outline ?? []).map(toOverlay));
		}
	}
	let marquee: PointsDrawing["marquee"] = null;
	if (gesture.kind === "marquee") {
		const a = toOverlay(gesture.start);
		const b = toOverlay(gesture.current);
		marquee = {
			x: Math.min(a.x, b.x),
			y: Math.min(a.y, b.y),
			width: Math.abs(a.x - b.x),
			height: Math.abs(a.y - b.y),
		};
	}
	return {
		markers,
		triangle: hoverTriangle ? hoverTriangle.map(toOverlay) : null,
		rings,
		marquee,
		lasso: gesture.kind === "lasso" ? gesture.path.map(toOverlay) : null,
	};
}
