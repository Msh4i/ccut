import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { ElementBounds } from "@/preview/element-bounds";
import type { Transform } from "@/rendering";
import { canvasToUv, uvToCanvas } from "@/tracking/projection";
import { frameToUnit, unitToFrame } from "./frame-coordinates";
import { mapPoint } from "./solve-pin";
import type { PinSolution } from "./types";

/** The element's box in its own unscaled space, relative to the point `position` moves. */
export interface LocalRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

/** The five animatable transform channels, one value per sample. */
export interface CameraPinValues {
	/** Position relative to the canvas centre, canvas px. */
	x: ArrayLike<number>;
	y: ArrayLike<number>;
	scaleX: ArrayLike<number>;
	scaleY: ArrayLike<number>;
	/** Degrees, clockwise, continuous (never folded into -180..180). */
	rotate: ArrayLike<number>;
}

export interface CameraPinChannels extends CameraPinValues {
	/** Analysis frame of each sample, ascending. */
	frames: Int32Array;
	/** Timeline seconds of each sample. */
	times: Float64Array;
	x: Float64Array;
	y: Float64Array;
	scaleX: Float64Array;
	scaleY: Float64Array;
	rotate: Float64Array;
}

/** Probe points per side of the element's box. */
const GRID = 5;

interface Mat2 {
	a: number;
	b: number;
	c: number;
	d: number;
}

const DEG = Math.PI / 180;

function wrapToPi(angle: number): number {
	return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

function mulMat({ left, right }: { left: Mat2; right: Mat2 }): Mat2 {
	return {
		a: left.a * right.a + left.b * right.c,
		b: left.a * right.b + left.b * right.d,
		c: left.c * right.a + left.d * right.c,
		d: left.c * right.b + left.d * right.d,
	};
}

function applyMat({ m, x, y }: { m: Mat2; x: number; y: number }): Point {
	return { x: m.a * x + m.b * y, y: m.c * x + m.d * y };
}

/**
 * The linear part of what the renderer draws for a transform, in the order the
 * renderer composes it: images, stickers, graphics and video scale and then
 * rotate (`R(theta) diag(sx, sy)`, `layer.wgsl` rotates the scaled quad about
 * its centre); text translates, scales and then rotates its 2D context
 * (`diag(sx, sy) R(theta)`, `text-node.ts`). A negative scale is a flip, which
 * folds into the same matrix.
 */
function linearPart({
	scaleX,
	scaleY,
	rotate,
	isText,
}: {
	scaleX: number;
	scaleY: number;
	rotate: number;
	isText: boolean;
}): Mat2 {
	const radians = rotate * DEG;
	const c = Math.cos(radians);
	const s = Math.sin(radians);
	return isText
		? { a: scaleX * c, b: -scaleX * s, c: scaleY * s, d: scaleY * c }
		: { a: c * scaleX, b: -s * scaleY, c: s * scaleX, d: c * scaleY };
}

function localCorners({ bounds }: { bounds: LocalRect }): Point[] {
	const { left, top, width, height } = bounds;
	return [
		{ x: left, y: top },
		{ x: left + width, y: top },
		{ x: left + width, y: top + height },
		{ x: left, y: top + height },
	];
}

function assertBox({ bounds }: { bounds: LocalRect }): void {
	const values = [bounds.left, bounds.top, bounds.width, bounds.height];
	if (!values.every(Number.isFinite) || !(bounds.width > 0) || !(bounds.height > 0)) {
		throw new RangeError("the element box must have a positive width and height");
	}
}

/** Where the four corners of the element's box (top-left, top-right, bottom-right, bottom-left of its own picture) land on the canvas. */
export function elementCorners({
	bounds,
	look,
	isText,
	canvasSize,
}: {
	bounds: LocalRect;
	look: Transform;
	isText: boolean;
	canvasSize: { width: number; height: number };
}): Point[] {
	const m = linearPart({
		scaleX: look.scaleX,
		scaleY: look.scaleY,
		rotate: look.rotate,
		isText,
	});
	const cx = canvasSize.width / 2 + look.position.x;
	const cy = canvasSize.height / 2 + look.position.y;
	return localCorners({ bounds }).map((corner) => {
		const p = applyMat({ m, x: corner.x, y: corner.y });
		return { x: cx + p.x, y: cy + p.y };
	});
}

/** The worst corner distance (canvas px) between two channel sets of the same element, sample by sample. */
export function maxCornerGap({
	a,
	b,
	bounds,
	isText,
	canvasSize,
}: {
	a: CameraPinValues;
	b: CameraPinValues;
	bounds: LocalRect;
	isText: boolean;
	canvasSize: { width: number; height: number };
}): number {
	const count = Math.min(a.x.length, b.x.length);
	const at = ({ values, i }: { values: CameraPinValues; i: number }): Transform => ({
		position: { x: values.x[i], y: values.y[i] },
		scaleX: values.scaleX[i],
		scaleY: values.scaleY[i],
		rotate: values.rotate[i],
	});
	let worst = 0;
	for (let i = 0; i < count; i++) {
		const ca = elementCorners({ bounds, look: at({ values: a, i }), isText, canvasSize });
		const cb = elementCorners({ bounds, look: at({ values: b, i }), isText, canvasSize });
		for (let k = 0; k < 4; k++) {
			worst = Math.max(worst, Math.hypot(ca[k].x - cb[k].x, ca[k].y - cb[k].y));
		}
	}
	return worst;
}

/**
 * Where a canvas point is in the analysis frame of the host clip, in frame
 * pixel coordinates (pixel centres at whole numbers, so picture position
 * `u = (x + 0.5) / w`), given where the host's picture sits on the canvas.
 */
export function canvasToFramePoint({
	point,
	host,
	frameSize,
}: {
	point: Point;
	host: ElementBounds;
	frameSize: { w: number; h: number };
}): Point {
	const uv = canvasToUv({ x: point.x, y: point.y, bounds: host });
	return {
		x: unitToFrame({ u: uv.u, size: frameSize.w }),
		y: unitToFrame({ u: uv.v, size: frameSize.h }),
	};
}

/** The inverse of {@link canvasToFramePoint}. */
export function framePointToCanvas({
	point,
	host,
	frameSize,
}: {
	point: Point;
	host: ElementBounds;
	frameSize: { w: number; h: number };
}): Point {
	return uvToCanvas({
		u: frameToUnit({ x: point.x, size: frameSize.w }),
		v: frameToUnit({ x: point.y, size: frameSize.h }),
		bounds: host,
	});
}

function assertHost({ bounds }: { bounds: ElementBounds }): void {
	const values = [bounds.cx, bounds.cy, bounds.width, bounds.height, bounds.rotation];
	if (!values.every(Number.isFinite) || bounds.width === 0 || bounds.height === 0) {
		throw new RangeError("the host picture has no size on the canvas");
	}
}

/**
 * The renderer's closest `R(theta) diag(sx, sy)` (images) or
 * `diag(sx, sy) R(theta)` (text) to the 2x2 matrix `b`, `theta` in radians.
 *
 * The element's own flips are taken out first (they would make the family's
 * scales negative) and put back at the end; a matrix that mirrors on top of
 * that (a host whose picture flips while it is on screen) mirrors the second
 * axis. `theta` is the circular mean of the two angles the matrix's two
 * columns (rows for text) point at, which are equal when `b` is in the family;
 * the scales are what is left along them.
 */
function projectToFamily({
	b,
	isText,
	signX,
	signY,
}: {
	b: Mat2;
	isText: boolean;
	signX: number;
	signY: number;
}): { theta: number; scaleX: number; scaleY: number } {
	let m11: number;
	let m12: number;
	let m21: number;
	let m22: number;
	if (isText) {
		// diag(signs) is on the left of the family: take it off the left
		m11 = signX * b.a;
		m12 = signX * b.b;
		m21 = signY * b.c;
		m22 = signY * b.d;
	} else {
		m11 = b.a * signX;
		m12 = b.b * signY;
		m21 = b.c * signX;
		m22 = b.d * signY;
	}
	let mirror = 1;
	if (m11 * m22 - m12 * m21 < 0) {
		mirror = -1;
		if (isText) {
			m21 = -m21;
			m22 = -m22;
		} else {
			m12 = -m12;
			m22 = -m22;
		}
	}
	if (isText) {
		const t1 = Math.atan2(-m12, m11);
		const t2 = Math.atan2(m21, m22);
		const theta = t1 + wrapToPi(t2 - t1) / 2;
		const c = Math.cos(theta);
		const s = Math.sin(theta);
		return {
			theta,
			scaleX: signX * (m11 * c - m12 * s),
			scaleY: signY * mirror * (m21 * s + m22 * c),
		};
	}
	const t1 = Math.atan2(m21, m11);
	const t2 = Math.atan2(-m12, m22);
	const theta = t1 + wrapToPi(t2 - t1) / 2;
	const c = Math.cos(theta);
	const s = Math.sin(theta);
	return {
		theta,
		scaleX: signX * (m11 * c + m21 * s),
		scaleY: signY * mirror * (-m12 * s + m22 * c),
	};
}

function clampScale(value: number): number {
	if (Math.abs(value) >= MIN_TRANSFORM_SCALE) return value;
	return value < 0 ? -MIN_TRANSFORM_SCALE : MIN_TRANSFORM_SCALE;
}

interface FrameFit {
	x: number;
	y: number;
	theta: number;
	scaleX: number;
	scaleY: number;
}

/**
 * Turns the scene motion into the five transform channels of an element that
 * should look glued to the scene (plan section c).
 *
 * The element's box is sampled by a 5x5 grid of probe points, which are carried
 * from the canvas into the picture of the host at the pin frame, moved by the
 * solved map of every frame (a similarity, or a homography), and put back on
 * the canvas through the host as it is at that frame's time. A least-squares
 * affine `p -> c1 + A (p - c0)` per frame says how the canvas moved around the
 * element. With `L0` the element's linear part at the pin frame (its scale and
 * rotation in the renderer's order) and `O0` its origin, the element now has
 * the linear part `B = A L0` and the origin `O_t = c1 + A (O0 - c0)`. `B` is
 * projected to what the renderer can draw: `R(theta) diag(sx, sy)` for images,
 * stickers, graphics and video, `diag(sx, sy) R(theta)` for text. So the whole
 * element sticks, not just its centre, and a host that zooms, turns, drifts
 * or is mirrored needs no special case: its own motion is in `hostAt`.
 *
 * `theta` is unwrapped outward from the pin frame (each frame within 180
 * degrees of the previous one), so a camera that rolls through 400 degrees
 * gives 400 degrees; `|scale|` is never below the renderer's minimum. A frame
 * whose map breaks down (not finite) keeps the previous sample. At the pin
 * frame the channels are exactly the element's own transform.
 */
export function buildCameraPinChannels({
	maps,
	first,
	last,
	frameTimeAt,
	frameSize,
	hostAt,
	overlay,
	bounds,
	isText,
	canvasSize,
}: {
	/** The solved scene motion from the pin frame `maps.f0` to every frame. */
	maps: PinSolution;
	/** The analysis frames to write, inclusive; must contain the pin frame. */
	first: number;
	last: number;
	/** Timeline seconds of an analysis frame. */
	frameTimeAt: (frame: number) => number;
	/** The analysis frame's size in px, which its coordinates and the host's picture share. */
	frameSize: { w: number; h: number };
	/** Where the host's picture sits on the canvas at a timeline time (seconds). */
	hostAt: (seconds: number) => ElementBounds;
	/** The element's own transform at the pin frame. */
	overlay: Transform;
	/** The element's box in its own unscaled space. */
	bounds: LocalRect;
	isText: boolean;
	canvasSize: { width: number; height: number };
}): CameraPinChannels {
	const f0 = maps.f0;
	if (
		!Number.isInteger(first) ||
		!Number.isInteger(last) ||
		first < 0 ||
		last >= maps.frameCount ||
		first > f0 ||
		last < f0
	) {
		throw new RangeError(
			`frames ${first}..${last} must lie inside the solution (0..${maps.frameCount - 1}) and hold the pin frame ${f0}`,
		);
	}
	assertBox({ bounds });
	if (!(Math.abs(overlay.scaleX) > 0) || !(Math.abs(overlay.scaleY) > 0)) {
		throw new RangeError("the element is scaled to nothing");
	}

	const centreX = canvasSize.width / 2;
	const centreY = canvasSize.height / 2;
	const l0 = linearPart({
		scaleX: overlay.scaleX,
		scaleY: overlay.scaleY,
		rotate: overlay.rotate,
		isText,
	});
	const o0 = { x: centreX + overlay.position.x, y: centreY + overlay.position.y };
	const signX = overlay.scaleX < 0 ? -1 : 1;
	const signY = overlay.scaleY < 0 ? -1 : 1;

	// the probe grid on the canvas at the pin frame, and where it is in the host's frame
	const count = GRID * GRID;
	const px = new Float64Array(count);
	const py = new Float64Array(count);
	const zx = new Float64Array(count);
	const zy = new Float64Array(count);
	const host0 = hostAt(frameTimeAt(f0));
	assertHost({ bounds: host0 });
	let k = 0;
	for (let j = 0; j < GRID; j++) {
		for (let i = 0; i < GRID; i++) {
			const p = applyMat({
				m: l0,
				x: bounds.left + (bounds.width * i) / (GRID - 1),
				y: bounds.top + (bounds.height * j) / (GRID - 1),
			});
			px[k] = o0.x + p.x;
			py[k] = o0.y + p.y;
			const z = canvasToFramePoint({ point: { x: px[k], y: py[k] }, host: host0, frameSize });
			zx[k] = z.x;
			zy[k] = z.y;
			k++;
		}
	}
	let c0x = 0;
	let c0y = 0;
	for (let n = 0; n < count; n++) {
		c0x += px[n];
		c0y += py[n];
	}
	c0x /= count;
	c0y /= count;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let n = 0; n < count; n++) {
		const dx = px[n] - c0x;
		const dy = py[n] - c0y;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}
	const det = sxx * syy - sxy * sxy;
	if (!(det > 1e-12 * (sxx + syy) * (sxx + syy))) {
		throw new RangeError("the element's box is too small to follow");
	}
	const inv11 = syy / det;
	const inv12 = -sxy / det;
	const inv22 = sxx / det;

	const qx = new Float64Array(count);
	const qy = new Float64Array(count);
	const fitFrame = (t: number): FrameFit | null => {
		const host = hostAt(frameTimeAt(t));
		assertHost({ bounds: host });
		let c1x = 0;
		let c1y = 0;
		for (let n = 0; n < count; n++) {
			const z = mapPoint({ solution: maps, t, x: zx[n], y: zy[n] });
			const q = framePointToCanvas({ point: z, host, frameSize });
			if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return null;
			qx[n] = q.x;
			qy[n] = q.y;
			c1x += q.x;
			c1y += q.y;
		}
		c1x /= count;
		c1y /= count;
		let m11 = 0;
		let m12 = 0;
		let m21 = 0;
		let m22 = 0;
		for (let n = 0; n < count; n++) {
			const dpx = px[n] - c0x;
			const dpy = py[n] - c0y;
			const dqx = qx[n] - c1x;
			const dqy = qy[n] - c1y;
			m11 += dqx * dpx;
			m12 += dqx * dpy;
			m21 += dqy * dpx;
			m22 += dqy * dpy;
		}
		const a: Mat2 = {
			a: m11 * inv11 + m12 * inv12,
			b: m11 * inv12 + m12 * inv22,
			c: m21 * inv11 + m22 * inv12,
			d: m21 * inv12 + m22 * inv22,
		};
		const root = applyMat({ m: a, x: o0.x - c0x, y: o0.y - c0y });
		const family = projectToFamily({
			b: mulMat({ left: a, right: l0 }),
			isText,
			signX,
			signY,
		});
		const fit: FrameFit = {
			x: c1x + root.x - centreX,
			y: c1y + root.y - centreY,
			theta: family.theta,
			scaleX: family.scaleX,
			scaleY: family.scaleY,
		};
		return Object.values(fit).every(Number.isFinite) ? fit : null;
	};

	const total = last - first + 1;
	const out: CameraPinChannels = {
		frames: new Int32Array(total),
		times: new Float64Array(total),
		x: new Float64Array(total),
		y: new Float64Array(total),
		scaleX: new Float64Array(total),
		scaleY: new Float64Array(total),
		rotate: new Float64Array(total),
	};
	for (let t = first; t <= last; t++) {
		out.frames[t - first] = t;
		out.times[t - first] = frameTimeAt(t);
	}
	const write = ({
		t,
		fit,
		thetaRad,
	}: {
		t: number;
		fit: FrameFit;
		thetaRad: number;
	}): void => {
		const i = t - first;
		out.x[i] = fit.x;
		out.y[i] = fit.y;
		out.scaleX[i] = clampScale(fit.scaleX);
		out.scaleY[i] = clampScale(fit.scaleY);
		out.rotate[i] = thetaRad / DEG;
	};

	// the pin frame is the element as it is; the angle unwraps outward from it
	const start: FrameFit = {
		x: overlay.position.x,
		y: overlay.position.y,
		theta: overlay.rotate * DEG,
		scaleX: overlay.scaleX,
		scaleY: overlay.scaleY,
	};
	write({ t: f0, fit: start, thetaRad: start.theta });
	for (const direction of [1, -1]) {
		let previous = start;
		let previousTheta = start.theta;
		const end = direction === 1 ? last : first;
		for (let t = f0 + direction; direction === 1 ? t <= end : t >= end; t += direction) {
			const fit = fitFrame(t);
			if (!fit) {
				write({ t, fit: previous, thetaRad: previousTheta });
				continue;
			}
			const thetaRad = previousTheta + wrapToPi(fit.theta - previousTheta);
			write({ t, fit, thetaRad });
			previous = fit;
			previousTheta = thetaRad;
		}
	}
	return out;
}
