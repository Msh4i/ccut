import { layerLinear, MIN_PROJECT_DEPTH } from "../camera";
import {
	affineApply,
	affineToMat3,
	mApply,
	mColumn,
	mFromColumns,
	mMul,
	quatToMat3,
	vCross,
	vDot,
	vLength,
	vScale,
	vSub,
} from "../math";
import type { Mat3, Transform3D, Vec3, ViewCamera } from "../types";

/**
 * How a 3D layer is drawn: the compositor maps every canvas pixel back into
 * the layer texture through the inverse of a homography (`layer.wgsl`). These
 * helpers build that homography and the facts the renderer needs around it
 * (depth for sorting, drawability, on-canvas size and bounds). Pure maths on
 * the conventions of `scene3d/types.ts`.
 *
 * Layer UV square: u right, v down over the layer's local content box
 * (`contentWidth` x `contentHeight` content units, origin at its centre):
 * `local = ((u - 0.5) contentWidth, (v - 0.5) contentHeight, 0)`.
 */

/**
 * A layer whose front (or back) face is closer than this cosine to edge-on
 * is not drawn: its picture would be a sliver thinner than a pixel, and its
 * homography is too close to singular for the shader's f32 maths.
 */
export const MIN_LAYER_FACING = 1e-4;

/**
 * Bounds that run off towards infinity (a layer reaching behind the camera)
 * are limited to the canvas extended by this many canvas sizes on each side.
 */
const BOUNDS_LIMIT_CANVASES = 1;

interface LayerGeometry {
	view: ViewCamera;
	transform: Transform3D;
	contentWidth: number;
	contentHeight: number;
}

/**
 * Camera-space affine map of the layer's UV square: `X_camera = M (u, v, 1)`.
 * Column 0 and 1 are the content edges, column 2 the camera-space point of
 * UV (0, 0).
 */
function cameraFromUv({
	view,
	transform,
	contentWidth,
	contentHeight,
}: LayerGeometry): Mat3 {
	const rotation = quatToMat3(view.rotation);
	const linear = mMul({ a: rotation, b: layerLinear(transform) });
	const centre = mApply({
		m: rotation,
		v: vSub({ a: transform.position, b: view.position }),
	});
	const edgeU = vScale({ v: mColumn({ m: linear, index: 0 }), s: contentWidth });
	const edgeV = vScale({ v: mColumn({ m: linear, index: 1 }), s: contentHeight });
	const origin: Vec3 = [
		centre[0] - 0.5 * edgeU[0] - 0.5 * edgeV[0],
		centre[1] - 0.5 * edgeU[1] - 0.5 * edgeV[1],
		centre[2] - 0.5 * edgeU[2] - 0.5 * edgeV[2],
	];
	return mFromColumns({ x: edgeU, y: edgeV, z: origin });
}

/** Camera space -> canvas pixels (homogeneous): frameToCanvas * K. */
function canvasFromCamera(view: ViewCamera): Mat3 {
	const intrinsics: Mat3 = [
		view.focalPx,
		0,
		view.frameWidth / 2,
		0,
		view.focalPx,
		view.frameHeight / 2,
		0,
		0,
		1,
	];
	return mMul({ a: affineToMat3(view.frameToCanvas), b: intrinsics });
}

/**
 * Row-major 3x3 homography from the layer's UV square to canvas pixels:
 * `frameToCanvas * K * [R | -R C] * layer(local)`. Its third component w is
 * the camera-space depth of the layer point (> 0 in front of the camera), as
 * `QuadTransformDescriptor.homography` requires.
 */
export function layerHomography(geometry: LayerGeometry): Mat3 {
	return mMul({
		a: canvasFromCamera(geometry.view),
		b: cameraFromUv(geometry),
	});
}

/** The canvas point of a UV point through `h` and its w; `null` when w is 0. */
export function applyHomography({
	h,
	u,
	v,
}: {
	h: Mat3;
	u: number;
	v: number;
}): { x: number; y: number; w: number } | null {
	const [x, y, w] = mApply({ m: h, v: [u, v, 1] });
	if (w === 0) return null;
	return { x: x / w, y: y / w, w };
}

/**
 * `h` divided by its largest magnitude: the same map with tidy f32 values.
 * The factor is positive, so the sign of w is kept. `null` for a zero or
 * non-finite matrix.
 */
export function normalizeHomography(h: Mat3): Mat3 | null {
	if (!h.every(Number.isFinite)) return null;
	const largest = Math.max(...h.map(Math.abs));
	if (!(largest > 0)) return null;
	return [
		h[0] / largest,
		h[1] / largest,
		h[2] / largest,
		h[3] / largest,
		h[4] / largest,
		h[5] / largest,
		h[6] / largest,
		h[7] / largest,
		h[8] / largest,
	];
}

/** Camera-space depth (z) of the layer's centre: the depth-sort key. */
export function depthOfLayer({
	view,
	transform,
}: {
	view: ViewCamera;
	transform: Transform3D;
}): number {
	const rotation = quatToMat3(view.rotation);
	return mApply({
		m: rotation,
		v: vSub({ a: transform.position, b: view.position }),
	})[2];
}

/**
 * Cosine between the layer's front face normal (local -z) and the direction
 * from its centre to the camera: 1 = facing the camera, -1 = its back faces
 * the camera, 0 = edge-on. 0 for a layer with zero scale or a camera at its
 * centre.
 */
export function layerFacing({
	view,
	transform,
}: {
	view: ViewCamera;
	transform: Transform3D;
}): number {
	const rotation = quatToMat3(view.rotation);
	const linear = mMul({ a: rotation, b: layerLinear(transform) });
	const normal = vCross({
		a: mColumn({ m: linear, index: 0 }),
		b: mColumn({ m: linear, index: 1 }),
	});
	const centre = mApply({
		m: rotation,
		v: vSub({ a: transform.position, b: view.position }),
	});
	const lengths = vLength(normal) * vLength(centre);
	if (!(lengths > 0)) return 0;
	// front normal = -normal, centre -> camera = -centre: the signs cancel.
	return vDot({ a: normal, b: centre }) / lengths;
}

/** Camera-space corners of the layer: UV (0,0), (1,0), (1,1), (0,1). */
function cameraCorners(geometry: LayerGeometry): Vec3[] {
	const m = cameraFromUv(geometry);
	return [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	].map(([u, v]) => mApply({ m, v: [u, v, 1] }));
}

/**
 * Whether the layer can be drawn at all: finite, a non-zero size, not
 * edge-on, and at least partly in front of the camera.
 */
export function isLayerDrawable(geometry: LayerGeometry): boolean {
	if (!(geometry.contentWidth > 0) || !(geometry.contentHeight > 0)) return false;
	const facing = layerFacing(geometry);
	if (!Number.isFinite(facing) || Math.abs(facing) < MIN_LAYER_FACING) return false;
	return cameraCorners(geometry).some((corner) => corner[2] > MIN_PROJECT_DEPTH);
}

function cameraPointToCanvas({
	view,
	point,
}: {
	view: ViewCamera;
	point: Vec3;
}): { x: number; y: number } {
	const frameX = view.frameWidth / 2 + (view.focalPx * point[0]) / point[2];
	const frameY = view.frameHeight / 2 + (view.focalPx * point[1]) / point[2];
	return affineApply({ m: view.frameToCanvas, x: frameX, y: frameY });
}

/** Sutherland-Hodgman clip of a camera-space polygon to z >= near. */
function clipToNearPlane({
	polygon,
	near,
}: {
	polygon: Vec3[];
	near: number;
}): Vec3[] {
	const clipped: Vec3[] = [];
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];
		const aIn = a[2] >= near;
		const bIn = b[2] >= near;
		if (aIn) clipped.push(a);
		if (aIn !== bIn) {
			const t = (near - a[2]) / (b[2] - a[2]);
			clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]);
		}
	}
	return clipped;
}

export interface CanvasBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * Axis-aligned canvas box of the layer's projected quad (the part in front
 * of the camera). Where the layer reaches behind the camera the projection
 * is unbounded: the box is then limited to the canvas extended by one canvas
 * size on each side. `null` when nothing of the layer is in front.
 */
export function projectedLayerBounds({
	canvasWidth,
	canvasHeight,
	...geometry
}: LayerGeometry & { canvasWidth: number; canvasHeight: number }): CanvasBox | null {
	const visible = clipToNearPlane({
		polygon: cameraCorners(geometry),
		near: MIN_PROJECT_DEPTH,
	});
	if (visible.length < 3) return null;
	const points = visible.map((point) =>
		cameraPointToCanvas({ view: geometry.view, point }),
	);
	const limitX = canvasWidth * BOUNDS_LIMIT_CANVASES;
	const limitY = canvasHeight * BOUNDS_LIMIT_CANVASES;
	const clampX = (x: number) => Math.min(canvasWidth + limitX, Math.max(-limitX, x));
	const clampY = (y: number) => Math.min(canvasHeight + limitY, Math.max(-limitY, y));
	const xs = points.map((point) => clampX(point.x));
	const ys = points.map((point) => clampY(point.y));
	if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
	return {
		left: Math.min(...xs),
		top: Math.min(...ys),
		right: Math.max(...xs),
		bottom: Math.max(...ys),
	};
}

/**
 * Canvas pixels per content unit along the layer's longest-looking edge: how
 * large a texture the layer needs on screen. `null` when a corner is behind
 * the camera (the on-screen size is unbounded).
 */
export function layerPixelScale(geometry: LayerGeometry): number | null {
	const corners = cameraCorners(geometry);
	if (!corners.every((corner) => corner[2] > MIN_PROJECT_DEPTH)) return null;
	const [a, b, c, d] = corners.map((point) =>
		cameraPointToCanvas({ view: geometry.view, point }),
	);
	type Point = { x: number; y: number };
	const length = ([p, q]: [Point, Point]) => Math.hypot(q.x - p.x, q.y - p.y);
	const scale = Math.max(
		length([a, b]) / geometry.contentWidth,
		length([d, c]) / geometry.contentWidth,
		length([b, c]) / geometry.contentHeight,
		length([a, d]) / geometry.contentHeight,
	);
	return Number.isFinite(scale) ? scale : null;
}
