import type { Mat3 } from "../types";

/**
 * CPU reference of the compositor's layer pass (`layer.wgsl`) and its
 * normal blend (`blend.wgsl`), in f64. Used by unit tests (against analytic
 * ground truth) and by the GPU harness (`apps/web/scripts/gpu-harness`,
 * against the real shader). Not used by the app.
 *
 * Images are straight-alpha RGBA in [0, 1], row-major, top row first. A
 * canvas pixel (x, y) is evaluated at its centre (x + 0.5, y + 0.5), like the
 * fragment shader. Textures are sampled bilinearly with clamp-to-edge, like
 * the compositor's linear sampler.
 */
export interface RgbaImage {
	width: number;
	height: number;
	data: Float64Array;
}

export type Rgba = [number, number, number, number];

export function createImage({
	width,
	height,
}: {
	width: number;
	height: number;
}): RgbaImage {
	return { width, height, data: new Float64Array(width * height * 4) };
}

export function pixelAt({
	image,
	x,
	y,
}: {
	image: RgbaImage;
	x: number;
	y: number;
}): Rgba {
	const o = (y * image.width + x) * 4;
	return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

function texel({
	texture,
	x,
	y,
}: {
	texture: RgbaImage;
	x: number;
	y: number;
}): Rgba {
	const cx = Math.min(texture.width - 1, Math.max(0, x));
	const cy = Math.min(texture.height - 1, Math.max(0, y));
	return pixelAt({ image: texture, x: cx, y: cy });
}

/** Bilinear, clamp-to-edge sample at UV (0..1 over the texture). */
export function sampleBilinear({
	texture,
	u,
	v,
}: {
	texture: RgbaImage;
	u: number;
	v: number;
}): Rgba {
	const tx = u * texture.width - 0.5;
	const ty = v * texture.height - 0.5;
	const x0 = Math.floor(tx);
	const y0 = Math.floor(ty);
	const fx = tx - x0;
	const fy = ty - y0;
	const a = texel({ texture, x: x0, y: y0 });
	const b = texel({ texture, x: x0 + 1, y: y0 });
	const c = texel({ texture, x: x0, y: y0 + 1 });
	const d = texel({ texture, x: x0 + 1, y: y0 + 1 });
	const out: Rgba = [0, 0, 0, 0];
	for (let i = 0; i < 4; i++) {
		const top = a[i] + (b[i] - a[i]) * fx;
		const bottom = c[i] + (d[i] - c[i]) * fx;
		out[i] = top + (bottom - top) * fy;
	}
	return out;
}

/**
 * The compositor's inverse of a layer homography (`compositor.rs`,
 * `layer_homography_inverse`): adjugate over determinant in f64, divided by
 * its largest magnitude (a positive factor). `null` when singular or not
 * finite.
 */
export function homographyInverse(h: Mat3): Mat3 | null {
	const [a, b, c, d, e, f, g, hh, i] = h;
	const adjugate = [
		e * i - f * hh,
		c * hh - b * i,
		b * f - c * e,
		f * g - d * i,
		a * i - c * g,
		c * d - a * f,
		d * hh - e * g,
		b * g - a * hh,
		a * e - b * d,
	];
	const determinant = a * adjugate[0] + b * adjugate[3] + c * adjugate[6];
	if (!Number.isFinite(determinant) || determinant === 0) return null;
	const inverse = adjugate.map((value) => value / determinant);
	const largest = Math.max(...inverse.map(Math.abs));
	if (!Number.isFinite(largest) || largest === 0) return null;
	const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = inverse.map((value) => value / largest);
	return [m0, m1, m2, m3, m4, m5, m6, m7, m8];
}

/**
 * The 3D branch of `layer.wgsl`: `q = H^-1 (pixel, 1)`, transparent where
 * `q.z <= 0` (behind the camera) or `uv = q.xy / q.z` is outside [0, 1]^2,
 * else the bilinear sample with its alpha times `opacity`.
 */
export function renderHomographyLayer({
	width,
	height,
	texture,
	homography,
	opacity,
}: {
	width: number;
	height: number;
	texture: RgbaImage;
	homography: Mat3;
	opacity: number;
}): RgbaImage {
	const image = createImage({ width, height });
	const inverse = homographyInverse(homography);
	if (!inverse) return image;
	for (let y = 0; y < height; y++) {
		const py = y + 0.5;
		for (let x = 0; x < width; x++) {
			const px = x + 0.5;
			const qz = inverse[6] * px + inverse[7] * py + inverse[8];
			if (qz <= 0) continue;
			const u = (inverse[0] * px + inverse[1] * py + inverse[2]) / qz;
			const v = (inverse[3] * px + inverse[4] * py + inverse[5]) / qz;
			if (u < 0 || u > 1 || v < 0 || v > 1) continue;
			const color = sampleBilinear({ texture, u, v });
			const o = (y * width + x) * 4;
			image.data[o] = color[0];
			image.data[o + 1] = color[1];
			image.data[o + 2] = color[2];
			image.data[o + 3] = color[3] * opacity;
		}
	}
	return image;
}

/** The fields of `QuadTransformDescriptor` the 2D branch reads. */
export interface Quad2D {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
}

/** The 2D branch of `layer.wgsl` (rotate about the centre, scale, flip). */
export function render2DLayer({
	width,
	height,
	texture,
	quad,
	opacity,
}: {
	width: number;
	height: number;
	texture: RgbaImage;
	quad: Quad2D;
	opacity: number;
}): RgbaImage {
	const image = createImage({ width, height });
	const radians = (quad.rotationDegrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x + 0.5 - quad.centerX;
			const dy = y + 0.5 - quad.centerY;
			const u = (dx * cos + dy * sin) / quad.width + 0.5;
			const v = (-dx * sin + dy * cos) / quad.height + 0.5;
			if (u < 0 || u > 1 || v < 0 || v > 1) continue;
			const color = sampleBilinear({
				texture,
				u: quad.flipX ? 1 - u : u,
				v: quad.flipY ? 1 - v : v,
			});
			const o = (y * width + x) * 4;
			image.data[o] = color[0];
			image.data[o + 1] = color[1];
			image.data[o + 2] = color[2];
			image.data[o + 3] = color[3] * opacity;
		}
	}
	return image;
}

/** `blend.wgsl` with blend mode "normal": the layer over the base by its alpha. */
export function blendNormal({
	base,
	layer,
}: {
	base: RgbaImage;
	layer: RgbaImage;
}): RgbaImage {
	const out = createImage({ width: base.width, height: base.height });
	for (let o = 0; o < base.data.length; o += 4) {
		const la = layer.data[o + 3];
		const ba = base.data[o + 3];
		for (let i = 0; i < 3; i++) {
			const b = base.data[o + i];
			const l = layer.data[o + i];
			const value = (1 - la) * b + la * ((1 - ba) * l + ba * l);
			out.data[o + i] = Math.min(1, Math.max(0, value));
		}
		out.data[o + 3] = la + ba * (1 - la);
	}
	return out;
}

/** Rounds every channel to the nearest 1/255 (an 8-bit render target). */
export function quantize8(image: RgbaImage): RgbaImage {
	const out = createImage({ width: image.width, height: image.height });
	for (let i = 0; i < image.data.length; i++) {
		out.data[i] = Math.round(Math.min(1, Math.max(0, image.data[i])) * 255) / 255;
	}
	return out;
}
