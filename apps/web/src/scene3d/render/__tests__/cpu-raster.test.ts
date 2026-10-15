import { describe, expect, test } from "bun:test";
import {
	frameRay,
	layerLinear,
	layerToWorld,
	projectToCanvas,
	quadFrameToCanvas,
} from "../../camera";
import {
	affineApply,
	affineInverse,
	mApply,
	mColumn,
	mInverse,
	quatFromAxisAngle,
	quatMul,
	vCross,
	vNormalize,
	vSub,
} from "../../math";
import { intersectRayPlane } from "../../plane";
import type { Transform3D, Vec3, ViewCamera } from "../../types";
import {
	blendNormal,
	createImage,
	homographyInverse,
	pixelAt,
	render2DLayer,
	renderHomographyLayer,
	type RgbaImage,
} from "../cpu-raster";
import { layerHomography } from "../homography";

const CANVAS = { width: 162, height: 288 };

function view(): ViewCamera {
	return {
		kind: "tracked",
		rotation: quatMul({
			a: quatFromAxisAngle({ axis: [0, 1, 0], radians: 0.3 }),
			b: quatFromAxisAngle({ axis: [1, 0, 0], radians: -0.15 }),
		}),
		position: [30, -20, -420],
		focalPx: 380,
		frameWidth: 320,
		frameHeight: 180,
		frameToCanvas: quadFrameToCanvas({
			quad: {
				centerX: 81,
				centerY: 144,
				width: 162,
				height: 91.125,
				rotationDegrees: 4,
				flipX: false,
				flipY: false,
			},
			frameWidth: 320,
			frameHeight: 180,
		}),
	};
}

/** A texture whose bilinear sample at uv is exactly (u, v) away from its outer half texel. */
function uvGradient({ width, height }: { width: number; height: number }): RgbaImage {
	const image = createImage({ width, height });
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			image.data[o] = (x + 0.5) / width;
			image.data[o + 1] = (y + 0.5) / height;
			image.data[o + 2] = 0;
			image.data[o + 3] = 1;
		}
	}
	return image;
}

const CELLS = 8;
const TEXELS_PER_CELL = 8;

function checkerboard(): RgbaImage {
	const size = CELLS * TEXELS_PER_CELL;
	const image = createImage({ width: size, height: size });
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dark = (Math.floor(x / TEXELS_PER_CELL) + Math.floor(y / TEXELS_PER_CELL)) % 2;
			const o = (y * size + x) * 4;
			image.data[o] = dark ? 0.1 : 0.9;
			image.data[o + 1] = dark ? 0.2 : 0.8;
			image.data[o + 2] = dark ? 0.3 : 0.7;
			image.data[o + 3] = 1;
		}
	}
	return image;
}

/** Least-squares homography UV -> canvas from correspondences (h33 = 1, normalised equations). */
function fitHomography(
	pairs: { u: number; v: number; x: number; y: number }[],
): number[] {
	const n = 8;
	const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0));
	const atb = new Array<number>(n).fill(0);
	const scale = 1 / CANVAS.width;
	const addRow = ({ row, rhs }: { row: number[]; rhs: number }) => {
		for (let i = 0; i < n; i++) {
			atb[i] += row[i] * rhs;
			for (let j = 0; j < n; j++) ata[i][j] += row[i] * row[j];
		}
	};
	for (const { u, v, x, y } of pairs) {
		const sx = x * scale;
		const sy = y * scale;
		addRow({ row: [u, v, 1, 0, 0, 0, -sx * u, -sx * v], rhs: sx });
		addRow({ row: [0, 0, 0, u, v, 1, -sy * u, -sy * v], rhs: sy });
	}
	// Gaussian elimination with partial pivoting.
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(ata[row][col]) > Math.abs(ata[pivot][col])) pivot = row;
		}
		[ata[col], ata[pivot]] = [ata[pivot], ata[col]];
		[atb[col], atb[pivot]] = [atb[pivot], atb[col]];
		for (let row = col + 1; row < n; row++) {
			const factor = ata[row][col] / ata[col][col];
			for (let k = col; k < n; k++) ata[row][k] -= factor * ata[col][k];
			atb[row] -= factor * atb[col];
		}
	}
	const h = new Array<number>(n).fill(0);
	for (let row = n - 1; row >= 0; row--) {
		let sum = atb[row];
		for (let k = row + 1; k < n; k++) sum -= ata[row][k] * h[k];
		h[row] = sum / ata[row][row];
	}
	return [
		h[0] / scale,
		h[1] / scale,
		h[2] / scale,
		h[3] / scale,
		h[4] / scale,
		h[5] / scale,
		h[6],
		h[7],
		1,
	];
}

function pointInConvexPolygon({
	point,
	polygon,
}: {
	point: { x: number; y: number };
	polygon: { x: number; y: number }[];
}): { inside: boolean; margin: number } {
	let sign = 0;
	let margin = Number.POSITIVE_INFINITY;
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];
		const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
		const distance = cross / Math.hypot(b.x - a.x, b.y - a.y);
		margin = Math.min(margin, Math.abs(distance));
		const s = Math.sign(cross);
		if (s === 0) return { inside: false, margin: 0 };
		if (sign === 0) sign = s;
		else if (s !== sign) return { inside: false, margin };
	}
	return { inside: true, margin };
}

/**
 * Ground truth independent of the homography code: the ray through a canvas
 * pixel centre hits the layer plane at which UV point (null: no hit in front
 * of the camera).
 */
function rayCastUv({
	camera,
	transform,
	contentWidth,
	contentHeight,
	x,
	y,
}: {
	camera: ViewCamera;
	transform: Transform3D;
	contentWidth: number;
	contentHeight: number;
	x: number;
	y: number;
}): { u: number; v: number } | null {
	const toFrame = affineInverse(camera.frameToCanvas);
	if (!toFrame) throw new Error("frameToCanvas not invertible");
	const frame = affineApply({ m: toFrame, x, y });
	const ray = frameRay({
		camera,
		frameWidth: camera.frameWidth,
		frameHeight: camera.frameHeight,
		x: frame.x,
		y: frame.y,
	});
	const linear = layerLinear(transform);
	const normal = vNormalize(
		vCross({ a: mColumn({ m: linear, index: 0 }), b: mColumn({ m: linear, index: 1 }) }),
	);
	if (!normal) throw new Error("degenerate layer");
	const hit = intersectRayPlane({
		origin: ray.origin,
		direction: ray.direction,
		plane: { point: transform.position, normal },
	});
	if (!hit) return null;
	const inverse = mInverse(linear);
	if (!inverse) throw new Error("layer linear map not invertible");
	const local: Vec3 = mApply({ m: inverse, v: vSub({ a: hit, b: transform.position }) });
	return { u: local[0] / contentWidth + 0.5, v: local[1] / contentHeight + 0.5 };
}

const PINNED: Transform3D = {
	position: [10, 15, 40],
	orientationDeg: [15, -40, 8],
	rotationDeg: [0, 0, 0],
	scale: [1, 1, 1],
};
const PINNED_SIZE = { contentWidth: 200, contentHeight: 120 };

describe("renderHomographyLayer: a pinned quad against analytic ground truth", () => {
	const camera = view();
	const h = layerHomography({ view: camera, transform: PINNED, ...PINNED_SIZE });
	const texture = uvGradient({ width: 64, height: 48 });
	const layer = renderHomographyLayer({
		width: CANVAS.width,
		height: CANVAS.height,
		texture,
		homography: h,
		opacity: 1,
	});
	const corners = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	].map(([u, v]) => {
		const point = projectToCanvas({
			view: camera,
			point: layerToWorld({
				transform: PINNED,
				local: [(u - 0.5) * PINNED_SIZE.contentWidth, (v - 0.5) * PINNED_SIZE.contentHeight, 0],
			}),
		});
		if (!point) throw new Error("corner behind the camera");
		return point;
	});

	test("the corners implied by the rendered pixels are within 0.01 px of the analytic projection", () => {
		const pairs: { u: number; v: number; x: number; y: number }[] = [];
		const marginU = 0.6 / texture.width;
		const marginV = 0.6 / texture.height;
		for (let y = 0; y < layer.height; y++) {
			for (let x = 0; x < layer.width; x++) {
				const [u, v, , a] = pixelAt({ image: layer, x, y });
				if (a === 0) continue;
				if (u < marginU || u > 1 - marginU || v < marginV || v > 1 - marginV) continue;
				pairs.push({ u, v, x: x + 0.5, y: y + 0.5 });
			}
		}
		expect(pairs.length).toBeGreaterThan(1000);
		const fitted = fitHomography(pairs);
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		].forEach(([u, v], index) => {
			const w = fitted[6] * u + fitted[7] * v + fitted[8];
			const x = (fitted[0] * u + fitted[1] * v + fitted[2]) / w;
			const y = (fitted[3] * u + fitted[4] * v + fitted[5]) / w;
			expect(Math.abs(x - corners[index].x)).toBeLessThan(0.01);
			expect(Math.abs(y - corners[index].y)).toBeLessThan(0.01);
		});
	});

	test("a pixel is covered exactly when its centre is inside the projected quad", () => {
		let covered = 0;
		let checked = 0;
		for (let y = 0; y < layer.height; y++) {
			for (let x = 0; x < layer.width; x++) {
				const { inside, margin } = pointInConvexPolygon({
					point: { x: x + 0.5, y: y + 0.5 },
					polygon: corners,
				});
				if (margin < 1e-6) continue;
				checked++;
				const alpha = pixelAt({ image: layer, x, y })[3];
				expect(alpha).toBe(inside ? 1 : 0);
				if (inside) covered++;
			}
		}
		expect(checked).toBeGreaterThan(CANVAS.width * CANVAS.height * 0.95);
		expect(covered).toBeGreaterThan(2000);
	});
});

describe("renderHomographyLayer: perspective-correct interior", () => {
	test("every checkerboard cell shows where the ray through the pixel hits the layer", () => {
		const camera = view();
		// Strong perspective: the layer is turned 60 degrees away.
		const transform: Transform3D = {
			position: [0, 0, 80],
			orientationDeg: [0, 60, 0],
			rotationDeg: [10, 0, 0],
			scale: [1.5, 1.5, 1],
		};
		const size = { contentWidth: 160, contentHeight: 160 };
		const texture = checkerboard();
		const layer = renderHomographyLayer({
			width: CANVAS.width,
			height: CANVAS.height,
			texture,
			homography: layerHomography({ view: camera, transform, ...size }),
			opacity: 1,
		});
		let checked = 0;
		// One texel of the checkerboard from a cell border: bilinear blending stays inside the cell.
		const border = 1.01 / TEXELS_PER_CELL;
		for (let y = 0; y < layer.height; y++) {
			for (let x = 0; x < layer.width; x++) {
				const truth = rayCastUv({ camera, transform, ...size, x: x + 0.5, y: y + 0.5 });
				if (!truth) continue;
				const cu = truth.u * CELLS;
				const cv = truth.v * CELLS;
				if (cu <= 0 || cu >= CELLS || cv <= 0 || cv >= CELLS) continue;
				const fu = cu - Math.floor(cu);
				const fv = cv - Math.floor(cv);
				if (Math.min(fu, 1 - fu, fv, 1 - fv) < border) continue;
				const dark = (Math.floor(cu) + Math.floor(cv)) % 2;
				const pixel = pixelAt({ image: layer, x, y });
				expect(pixel[0]).toBeCloseTo(dark ? 0.1 : 0.9, 12);
				expect(pixel[3]).toBe(1);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(1500);
	});

	test("pixels whose ray meets the layer plane behind the camera stay transparent", () => {
		const camera = view();
		// A floor that runs from in front of the camera to behind it.
		const transform: Transform3D = {
			position: [30, 60, -420],
			orientationDeg: [90, 0, 0],
			rotationDeg: [0, 0, 0],
			scale: [1, 1, 1],
		};
		const size = { contentWidth: 600, contentHeight: 1600 };
		const layer = renderHomographyLayer({
			width: CANVAS.width,
			height: CANVAS.height,
			texture: checkerboard(),
			homography: layerHomography({ view: camera, transform, ...size }),
			opacity: 1,
		});
		let empty = 0;
		let hits = 0;
		for (let y = 0; y < layer.height; y++) {
			for (let x = 0; x < layer.width; x++) {
				const truth = rayCastUv({ camera, transform, ...size, x: x + 0.5, y: y + 0.5 });
				const alpha = pixelAt({ image: layer, x, y })[3];
				if (!truth) {
					expect(alpha).toBe(0);
					empty++;
					continue;
				}
				const inside = truth.u > 1e-9 && truth.u < 1 - 1e-9 && truth.v > 1e-9 && truth.v < 1 - 1e-9;
				const outside = truth.u < -1e-9 || truth.u > 1 + 1e-9 || truth.v < -1e-9 || truth.v > 1 + 1e-9;
				if (inside) {
					expect(alpha).toBe(1);
					hits++;
				}
				if (outside) expect(alpha).toBe(0);
			}
		}
		expect(empty).toBeGreaterThan(1000);
		expect(hits).toBeGreaterThan(1000);
	});
});

describe("homographyInverse (the compositor's f64 inverse)", () => {
	test("is normalised to a largest entry of 1 and keeps q.z > 0 in front", () => {
		const camera = view();
		const h = layerHomography({ view: camera, transform: PINNED, ...PINNED_SIZE });
		const inverse = homographyInverse(h);
		expect(inverse).not.toBeNull();
		if (!inverse) return;
		expect(Math.max(...inverse.map(Math.abs))).toBe(1);
		const p = mApply({ m: h, v: [0.3, 0.6, 1] });
		const q = mApply({ m: inverse, v: [p[0] / p[2], p[1] / p[2], 1] });
		expect(q[2]).toBeGreaterThan(0);
		expect(q[0] / q[2]).toBeCloseTo(0.3, 9);
		expect(q[1] / q[2]).toBeCloseTo(0.6, 9);
	});

	test("is null for a singular matrix", () => {
		expect(homographyInverse([1, 2, 3, 4, 5, 6, 5, 7, 9])).toBeNull();
	});
});

describe("render2DLayer and blendNormal (the 2D shader branch and the normal blend)", () => {
	test("a rotated, flipped 2D quad covers its rectangle and samples mirrored", () => {
		const texture = uvGradient({ width: 16, height: 8 });
		const quad = {
			centerX: 80,
			centerY: 140,
			width: 100,
			height: 60,
			rotationDegrees: 30,
			flipX: true,
			flipY: false,
		};
		const layer = render2DLayer({
			width: CANVAS.width,
			height: CANVAS.height,
			texture,
			quad,
			opacity: 0.5,
		});
		const radians = (30 * Math.PI) / 180;
		for (let y = 0; y < layer.height; y++) {
			for (let x = 0; x < layer.width; x++) {
				const dx = x + 0.5 - quad.centerX;
				const dy = y + 0.5 - quad.centerY;
				const lx = dx * Math.cos(radians) + dy * Math.sin(radians);
				const ly = -dx * Math.sin(radians) + dy * Math.cos(radians);
				const u = lx / quad.width + 0.5;
				const v = ly / quad.height + 0.5;
				const pixel = pixelAt({ image: layer, x, y });
				const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
				expect(pixel[3]).toBe(inside ? 0.5 : 0);
				if (inside && u > 0.05 && u < 0.95 && v > 0.1 && v < 0.9) {
					expect(pixel[0]).toBeCloseTo(1 - u, 9);
					expect(pixel[1]).toBeCloseTo(v, 9);
				}
			}
		}
	});

	test("normal blend: layer over base by the layer's alpha", () => {
		const base = createImage({ width: 1, height: 1 });
		base.data.set([0.2, 0.4, 0.6, 1]);
		const layer = createImage({ width: 1, height: 1 });
		layer.data.set([1, 0, 0.5, 0.25]);
		const out = blendNormal({ base, layer });
		const expected = [0.75 * 0.2 + 0.25 * 1, 0.75 * 0.4, 0.75 * 0.6 + 0.25 * 0.5, 1];
		expected.forEach((value, index) => {
			expect(out.data[index]).toBeCloseTo(value, 12);
		});
	});
});
