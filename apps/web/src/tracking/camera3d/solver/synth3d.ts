/**
 * Synthetic 3D footage with a known camera, for testing and measuring the
 * camera solver (`solve-camera.ts`).
 *
 * A scene is a few textured rectangles in 3D (a wall, a floor, boxes,
 * pillars, an optional moving occluder) seen by a pinhole camera whose path
 * (`CameraState` per frame, frame pixels of a 1920 x 1080 source) is the
 * ground truth. Frames are rendered straight at the analysis size by
 * casting one ray per pixel: ray-rectangle intersection with a depth test,
 * trilinear (mip-mapped) texture sampling so far or grazing surfaces do not
 * alias, sensor noise, and motion blur as an average of sub-frame renders.
 * Textures are the value-noise worlds of the 2D tracker's generator
 * (`tracking/camera/camera-synth-world.ts`). Everything is deterministic.
 *
 * Conventions are those of `scene3d/types.ts`: x right, y down, z forward;
 * the floor is at y = +1.5 (below the eye), the wall at z = 12 faces the
 * cameras (normal -z).
 */
import { mat3ToQuat } from "@/scene3d/math";
import type { CameraState, Mat3, Plane, Vec3 } from "@/scene3d/types";
import { makeWorld } from "@/tracking/camera/camera-synth-world";
import { createRng, gaussianSample } from "@/tracking/camera/random";
import type { FeatureTracks } from "@/tracking/camera/types";
import type { GrayFrame } from "@/tracking/types";

export const SYNTH3D_SCENES = [
	"fixed-walk",
	"zoom",
	"pan-parallax",
	"shake",
	"foreground",
	"occlusion",
	"tripod",
	"textureless",
] as const;

export type Synth3DSceneName = (typeof SYNTH3D_SCENES)[number];

export const SYNTH_FRAME_WIDTH = 1920;
export const SYNTH_FRAME_HEIGHT = 1080;
export const SYNTH_FPS = 30;

/** A textured rectangle: `origin + a axisU + b axisV`, `0 <= a <= width`, `0 <= b <= height`. */
export interface SynthSurface {
	name: string;
	origin: Vec3;
	/** Unit and orthogonal to `axisV`. */
	axisU: Vec3;
	axisV: Vec3;
	width: number;
	height: number;
	/** World units per texel of the texture. */
	texel: number;
	textureSeed: number;
	/** Moving surfaces: world offset of the whole rectangle at a (fractional) frame. */
	offsetAt?: (frame: number) => Vec3;
}

export interface Synth3DScene {
	name: Synth3DSceneName;
	frameCount: number;
	fps: number;
	frameWidth: number;
	frameHeight: number;
	/** The true camera at a (fractional) frame index. */
	cameraAt: (frame: number) => CameraState;
	surfaces: SynthSurface[];
	/** Index of the wall in `surfaces` (the plane of the acceptance metric). */
	wall: number;
	/** Texture detail of every surface (1 = the full value-noise world). */
	detail: number;
	/** Sensor noise sigma, gray levels. */
	noise: number;
	/** Shutter as a share of the frame interval (0 = no motion blur). */
	shutter: number;
	subframes: number;
	/** The shot type a user would pick for this footage. */
	shotType: "fixed-angle" | "variable-zoom";
	seed: number;
}

// ---------------------------------------------------------------------------
// Camera rigs
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** World-to-camera rotation of a camera turned by yaw (right), pitch (up) and roll, degrees. */
function rigRotation({ yaw, pitch, roll }: { yaw: number; pitch: number; roll: number }): Mat3 {
	const cy = Math.cos(yaw * DEG);
	const sy = Math.sin(yaw * DEG);
	const cp = Math.cos(pitch * DEG);
	const sp = Math.sin(pitch * DEG);
	const cr = Math.cos(roll * DEG);
	const sr = Math.sin(roll * DEG);
	// camera-to-world = Ry(yaw) Rx(-pitch) Rz(roll): positive pitch looks up (towards -y)
	const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
	const rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
	const rz = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
	const mul = ({ a, b }: { a: number[]; b: number[] }): number[] => {
		const out = new Array<number>(9).fill(0);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
			}
		}
		return out;
	};
	const cw = mul({ a: mul({ a: ry, b: rx }), b: rz });
	return [cw[0], cw[3], cw[6], cw[1], cw[4], cw[7], cw[2], cw[5], cw[8]];
}

/** Six smooth random channels (yaw, pitch, roll in degrees, x y z in world units) for handheld motion. */
function makeShake({
	seed,
	rotationDeg,
	translation,
	loHz,
	hiHz,
}: {
	seed: number;
	rotationDeg: number;
	translation: number;
	loHz: number;
	hiHz: number;
}): (seconds: number) => number[] {
	const random = createRng({ seed });
	const parts: { channel: number; amp: number; hz: number; phase: number }[] = [];
	for (let channel = 0; channel < 6; channel++) {
		const amplitude = channel < 3 ? rotationDeg : translation;
		for (let k = 0; k < 3; k++) {
			parts.push({
				channel,
				amp: (amplitude / Math.sqrt(3)) * (0.6 + 0.8 * random()),
				hz: loHz + (hiHz - loHz) * random(),
				phase: random() * 2 * Math.PI,
			});
		}
	}
	return (seconds) => {
		const out = [0, 0, 0, 0, 0, 0];
		for (const p of parts) out[p.channel] += p.amp * Math.sin(2 * Math.PI * p.hz * seconds + p.phase);
		return out;
	};
}

function focalOfHfov(hfovDeg: number): number {
	return SYNTH_FRAME_WIDTH / (2 * Math.tan((hfovDeg * DEG) / 2));
}

function smoothstep(s: number): number {
	const t = Math.max(0, Math.min(1, s));
	return t * t * (3 - 2 * t);
}

interface RigPose {
	position: Vec3;
	yaw: number;
	pitch: number;
	roll: number;
	hfov: number;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

const WALL_Z = 12;
const FLOOR_Y = 1.5;

function wallSurface(): SynthSurface {
	return {
		name: "wall",
		origin: [-16, -9, WALL_Z],
		axisU: [1, 0, 0],
		axisV: [0, 1, 0],
		width: 32,
		height: 9 + FLOOR_Y,
		texel: 32 / 1024,
		textureSeed: 101,
	};
}

function floorSurface(): SynthSurface {
	return {
		name: "floor",
		origin: [-16, FLOOR_Y, -6],
		axisU: [1, 0, 0],
		axisV: [0, 0, 1],
		width: 32,
		height: WALL_Z + 6,
		texel: 32 / 1024,
		textureSeed: 202,
	};
}

/** The faces of a box seen from the cameras (front, left, right, top), named `<name>-front` etc. */
function boxSurfaces({
	name,
	min,
	max,
	seed,
}: {
	name: string;
	min: Vec3;
	max: Vec3;
	seed: number;
}): SynthSurface[] {
	const [x0, y0, z0] = min;
	const [x1, y1, z1] = max;
	const texel = 1 / 128;
	return [
		{ name: `${name}-front`, origin: [x0, y0, z0], axisU: [1, 0, 0], axisV: [0, 1, 0], width: x1 - x0, height: y1 - y0, texel, textureSeed: seed },
		{ name: `${name}-left`, origin: [x0, y0, z1], axisU: [0, 0, -1], axisV: [0, 1, 0], width: z1 - z0, height: y1 - y0, texel, textureSeed: seed + 1 },
		{ name: `${name}-right`, origin: [x1, y0, z0], axisU: [0, 0, 1], axisV: [0, 1, 0], width: z1 - z0, height: y1 - y0, texel, textureSeed: seed + 2 },
		{ name: `${name}-top`, origin: [x0, y0, z1], axisU: [1, 0, 0], axisV: [0, 0, -1], width: x1 - x0, height: z1 - z0, texel, textureSeed: seed + 3 },
	];
}

/** A vertical rectangle facing the cameras (normal -z). */
function boardSurface({
	name,
	x0,
	x1,
	y0,
	y1,
	z,
	seed,
	offsetAt,
}: {
	name: string;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	z: number;
	seed: number;
	offsetAt?: (frame: number) => Vec3;
}): SynthSurface {
	return {
		name,
		origin: [x0, y0, z],
		axisU: [1, 0, 0],
		axisV: [0, 1, 0],
		width: x1 - x0,
		height: y1 - y0,
		texel: 1 / 110,
		textureSeed: seed,
		offsetAt,
	};
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

interface SceneSpec {
	rig: (args: { s: number; seconds: number }) => RigPose;
	surfaces: SynthSurface[];
	detail: number;
	noise: number;
	shutter: number;
	shotType: "fixed-angle" | "variable-zoom";
}

function sceneSpec({ name, frameCount }: { name: Synth3DSceneName; frameCount: number }): SceneSpec {
	const base = [wallSurface(), floorSurface()];
	const slow = makeShake({ seed: 7, rotationDeg: 0.5, translation: 0.012, loHz: 0.2, hiHz: 1.2 });
	switch (name) {
		case "fixed-walk":
		case "textureless": {
			return {
				rig: ({ s, seconds }) => {
					const h = slow(seconds);
					return {
						position: [0.35 * Math.sin(1.2 * Math.PI * s) + h[3], h[4] + 0.025 * Math.sin(2 * Math.PI * 1.8 * seconds), -2 + 6 * s + h[5]],
						yaw: 5 * Math.sin(Math.PI * s) - 2.5 + h[0],
						pitch: -2 + h[1],
						roll: h[2],
						hfov: 60,
					};
				},
				surfaces: [...base, ...boxSurfaces({ name: "box", min: [1.3, 0.5, 5], max: [2.3, FLOOR_Y, 6], seed: 303 })],
				detail: name === "textureless" ? 0.02 : 1,
				noise: 2,
				shutter: 0.4,
				shotType: "fixed-angle",
			};
		}
		case "zoom": {
			const tiny = makeShake({ seed: 9, rotationDeg: 0.15, translation: 0.004, loHz: 0.3, hiHz: 1.5 });
			return {
				rig: ({ s, seconds }) => {
					const h = tiny(seconds);
					return {
						position: [-0.5 + 1.0 * s + h[3], -0.2 + h[4], 1 + h[5]],
						yaw: 18 + h[0],
						pitch: -6 + h[1],
						roll: h[2],
						hfov: 55 + (28 - 55) * smoothstep(s),
					};
				},
				surfaces: [...base, ...boxSurfaces({ name: "box", min: [0.2, 0.5, 6], max: [1.2, FLOOR_Y, 7], seed: 313 })],
				detail: 1,
				noise: 2,
				shutter: 0,
				shotType: "variable-zoom",
			};
		}
		case "pan-parallax": {
			return {
				rig: ({ s, seconds }) => {
					const h = slow(seconds);
					return {
						position: [-2.5 + 5 * s + h[3], h[4], h[5]],
						yaw: -12 + 24 * s + h[0],
						pitch: -1 + h[1],
						roll: h[2],
						hfov: 60,
					};
				},
				surfaces: [
					...base,
					boardSurface({ name: "pillar-left", x0: -1.8, x1: -1.2, y0: -3, y1: FLOOR_Y, z: 4, seed: 404 }),
					boardSurface({ name: "pillar-right", x0: 1.0, x1: 1.6, y0: -3, y1: FLOOR_Y, z: 4, seed: 405 }),
				],
				detail: 1,
				noise: 2,
				shutter: 0.4,
				shotType: "fixed-angle",
			};
		}
		case "shake": {
			const fast = makeShake({ seed: 11, rotationDeg: 0.8, translation: 0.03, loHz: 2, hiHz: 7 });
			return {
				rig: ({ s, seconds }) => {
					const h = fast(seconds);
					return {
						position: [-0.5 + 1.0 * s + h[3], h[4], 0.6 * s + h[5]],
						yaw: h[0],
						pitch: -1 + h[1],
						roll: h[2],
						hfov: 60,
					};
				},
				surfaces: [...base, ...boxSurfaces({ name: "box", min: [-1.9, 0.5, 4], max: [-0.9, FLOOR_Y, 5], seed: 323 })],
				detail: 1,
				noise: 2,
				shutter: 0.5,
				shotType: "fixed-angle",
			};
		}
		case "foreground": {
			return {
				rig: ({ s, seconds }) => {
					const h = slow(seconds);
					return {
						position: [-1.5 + 3 * s + h[3], h[4], h[5]],
						yaw: h[0],
						pitch: -2 + h[1],
						roll: h[2],
						hfov: 60,
					};
				},
				surfaces: [
					...base,
					...boxSurfaces({ name: "box", min: [-1.6, 0.5, 3], max: [-0.6, FLOOR_Y, 4], seed: 333 }),
					...boxSurfaces({ name: "crate", min: [0.9, 0.9, 2.5], max: [1.5, FLOOR_Y, 3.1], seed: 343 }),
				],
				detail: 1,
				noise: 2,
				shutter: 0,
				shotType: "fixed-angle",
			};
		}
		case "occlusion": {
			const last = Math.max(1, frameCount - 1);
			return {
				rig: ({ s, seconds }) => {
					const h = slow(seconds);
					return {
						position: [-1 + 2 * s + h[3], h[4], 0.5 * s + h[5]],
						yaw: 3 - 6 * s + h[0],
						pitch: -2 + h[1],
						roll: h[2],
						hfov: 60,
					};
				},
				surfaces: [
					...base,
					boardSurface({
						name: "occluder",
						x0: -0.7,
						x1: 0.7,
						y0: -1.5,
						y1: FLOOR_Y,
						z: 5,
						seed: 505,
						offsetAt: (frame) => [3 - (6 * frame) / last, 0, 0],
					}),
				],
				detail: 1,
				noise: 2,
				shutter: 0,
				shotType: "fixed-angle",
			};
		}
		case "tripod": {
			return {
				rig: ({ s, seconds }) => {
					const h = slow(seconds);
					return {
						position: [0, 0, 0],
						yaw: -15 + 30 * s + h[0],
						pitch: -2 + 3 * Math.sin(2 * Math.PI * s) + h[1],
						roll: Math.sin(Math.PI * s) + h[2],
						hfov: 60,
					};
				},
				surfaces: [...base, ...boxSurfaces({ name: "box", min: [-2.5, 0.5, 6], max: [-1.5, FLOOR_Y, 7], seed: 353 })],
				detail: 1,
				noise: 2,
				shutter: 0,
				shotType: "fixed-angle",
			};
		}
	}
}

/** A scene of `frameCount` frames at 30 fps; the motion spans the whole clip whatever its length. */
export function makeScene({ name, frameCount }: { name: Synth3DSceneName; frameCount: number }): Synth3DScene {
	if (!Number.isInteger(frameCount) || frameCount < 2) {
		throw new RangeError(`frameCount must be an integer >= 2, got ${frameCount}`);
	}
	const spec = sceneSpec({ name, frameCount });
	const last = frameCount - 1;
	const cameraAt = (frame: number): CameraState => {
		const pose = spec.rig({ s: frame / last, seconds: frame / SYNTH_FPS });
		return {
			rotation: mat3ToQuat(rigRotation({ yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll })),
			position: pose.position,
			focalPx: focalOfHfov(pose.hfov),
		};
	};
	return {
		name,
		frameCount,
		fps: SYNTH_FPS,
		frameWidth: SYNTH_FRAME_WIDTH,
		frameHeight: SYNTH_FRAME_HEIGHT,
		cameraAt,
		surfaces: spec.surfaces,
		wall: 0,
		detail: spec.detail,
		noise: spec.noise,
		shutter: spec.shutter,
		subframes: spec.shutter > 0 ? 3 : 1,
		shotType: spec.shotType,
		seed: 5,
	};
}

/** The wall's plane, normal towards the cameras. */
export function wallPlane(scene: Synth3DScene): Plane {
	const wall = scene.surfaces[scene.wall];
	const n = surfaceNormal(wall);
	return { point: wall.origin, normal: n[2] > 0 ? [-n[0], -n[1], -n[2]] : n };
}

function surfaceNormal(surface: SynthSurface): Vec3 {
	const u = surface.axisU;
	const v = surface.axisV;
	return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

interface MipTexture {
	levels: { data: Float32Array; w: number; h: number }[];
}

const textureCache = new Map<string, MipTexture>();

/** Frees the cached textures (call from `afterAll`). */
export function releaseSynthTextures(): void {
	textureCache.clear();
}

function textureOf({ surface, detail }: { surface: SynthSurface; detail: number }): MipTexture {
	const w = Math.max(8, Math.round(surface.width / surface.texel));
	const h = Math.max(8, Math.round(surface.height / surface.texel));
	const key = `${surface.textureSeed}:${w}x${h}:${detail}`;
	const cached = textureCache.get(key);
	if (cached) return cached;
	const world = makeWorld({
		width: w,
		height: h,
		seed: surface.textureSeed,
		texture: detail,
		// a bare surface (detail near 0) gets no rectangles or discs: those are corners however faint
		shapes: detail < 0.1 ? 0 : Math.round((700 * w * h) / (1024 * 576)) + 20,
		maxSize: Math.min(160, Math.max(12, Math.round(Math.min(w, h) / 4))),
	});
	const levels = [{ data: world.data, w, h }];
	for (let k = 0; k < 16; k++) {
		const prev = levels[levels.length - 1];
		if (prev.w <= 1 && prev.h <= 1) break;
		const nw = Math.max(1, prev.w >> 1);
		const nh = Math.max(1, prev.h >> 1);
		const data = new Float32Array(nw * nh);
		for (let y = 0; y < nh; y++) {
			const y0 = Math.min(prev.h - 1, 2 * y);
			const y1 = Math.min(prev.h - 1, 2 * y + 1);
			for (let x = 0; x < nw; x++) {
				const x0 = Math.min(prev.w - 1, 2 * x);
				const x1 = Math.min(prev.w - 1, 2 * x + 1);
				data[y * nw + x] =
					(prev.data[y0 * prev.w + x0] + prev.data[y0 * prev.w + x1] + prev.data[y1 * prev.w + x0] + prev.data[y1 * prev.w + x1]) / 4;
			}
		}
		levels.push({ data, w: nw, h: nh });
	}
	const texture = { levels };
	textureCache.set(key, texture);
	return texture;
}

// ---------------------------------------------------------------------------
// Ray casting
// ---------------------------------------------------------------------------

/** Per-frame constants of one surface for the ray caster. */
interface PreparedSurface {
	origin: Vec3;
	u: Vec3;
	v: Vec3;
	n: Vec3;
	width: number;
	height: number;
	texel: number;
	texture: MipTexture;
}

function prepareSurfaces({ scene, frame }: { scene: Synth3DScene; frame: number }): PreparedSurface[] {
	return scene.surfaces.map((surface) => {
		const offset = surface.offsetAt?.(frame) ?? [0, 0, 0];
		return {
			origin: [surface.origin[0] + offset[0], surface.origin[1] + offset[1], surface.origin[2] + offset[2]],
			u: surface.axisU,
			v: surface.axisV,
			n: surfaceNormal(surface),
			width: surface.width,
			height: surface.height,
			texel: surface.texel,
			texture: textureOf({ surface, detail: scene.detail }),
		};
	});
}

/** Rows of the world-to-camera matrix of a camera. */
function rotationRows(camera: CameraState): number[] {
	const [w, x, y, z] = camera.rotation;
	const length = Math.hypot(w, x, y, z);
	const qw = w / length;
	const qx = x / length;
	const qy = y / length;
	const qz = z / length;
	return [
		1 - 2 * (qy * qy + qz * qz),
		2 * (qx * qy - qw * qz),
		2 * (qx * qz + qw * qy),
		2 * (qx * qy + qw * qz),
		1 - 2 * (qx * qx + qz * qz),
		2 * (qy * qz - qw * qx),
		2 * (qx * qz - qw * qy),
		2 * (qy * qz + qw * qx),
		1 - 2 * (qx * qx + qy * qy),
	];
}

/**
 * The nearest surface along the ray through a frame pixel (continuous frame
 * coordinates), at a frame. `only` restricts the test to one surface.
 */
export function surfaceAtPixel({
	scene,
	frame,
	x,
	y,
	only,
}: {
	scene: Synth3DScene;
	frame: number;
	x: number;
	y: number;
	only?: number;
}): { surface: number; depth: number; point: Vec3 } | null {
	const camera = scene.cameraAt(frame);
	const r = rotationRows(camera);
	const cx = (x - scene.frameWidth / 2) / camera.focalPx;
	const cy = (y - scene.frameHeight / 2) / camera.focalPx;
	const d: Vec3 = [r[0] * cx + r[3] * cy + r[6], r[1] * cx + r[4] * cy + r[7], r[2] * cx + r[5] * cy + r[8]];
	const c = camera.position;
	let best: { surface: number; depth: number; point: Vec3 } | null = null;
	scene.surfaces.forEach((surface, index) => {
		if (only !== undefined && index !== only) return;
		const offset = surface.offsetAt?.(frame) ?? [0, 0, 0];
		const o: Vec3 = [surface.origin[0] + offset[0], surface.origin[1] + offset[1], surface.origin[2] + offset[2]];
		const n = surfaceNormal(surface);
		const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
		if (Math.abs(den) < 1e-12) return;
		const t = ((o[0] - c[0]) * n[0] + (o[1] - c[1]) * n[1] + (o[2] - c[2]) * n[2]) / den;
		if (!(t > 0.05)) return;
		const p: Vec3 = [c[0] + t * d[0], c[1] + t * d[1], c[2] + t * d[2]];
		const a = (p[0] - o[0]) * surface.axisU[0] + (p[1] - o[1]) * surface.axisU[1] + (p[2] - o[2]) * surface.axisU[2];
		const b = (p[0] - o[0]) * surface.axisV[0] + (p[1] - o[1]) * surface.axisV[1] + (p[2] - o[2]) * surface.axisV[2];
		if (a < 0 || a > surface.width || b < 0 || b > surface.height) return;
		if (!best || t < best.depth) best = { surface: index, depth: t, point: p };
	});
	return best;
}

/** Renders the noise-free picture at one (fractional) frame into `out` (gray levels as floats). */
function castFrame({
	scene,
	frame,
	width,
	height,
	out,
}: {
	scene: Synth3DScene;
	frame: number;
	width: number;
	height: number;
	out: Float32Array;
}): void {
	const camera = scene.cameraAt(frame);
	const r = rotationRows(camera);
	const f = camera.focalPx;
	const sx = scene.frameWidth / width;
	const sy = scene.frameHeight / height;
	// d(i, j) = A + i Bx + j By, the world direction of pixel (i, j) with camera z = 1
	const ax = (0.5 * sx - scene.frameWidth / 2) / f;
	const ay = (0.5 * sy - scene.frameHeight / 2) / f;
	const A = [r[0] * ax + r[3] * ay + r[6], r[1] * ax + r[4] * ay + r[7], r[2] * ax + r[5] * ay + r[8]];
	const Bx = [(r[0] * sx) / f, (r[1] * sx) / f, (r[2] * sx) / f];
	const By = [(r[3] * sy) / f, (r[4] * sy) / f, (r[5] * sy) / f];
	const pixelAngle = Math.sqrt(sx * sy) / f;
	const c = camera.position;
	const surfaces = prepareSurfaces({ scene, frame });
	const count = surfaces.length;
	// per surface: den = d.n, du = d.u, dv = d.v are linear in (i, j)
	const coef = new Float64Array(count * 14);
	for (let k = 0; k < count; k++) {
		const s = surfaces[k];
		const base = k * 14;
		const oc: Vec3 = [s.origin[0] - c[0], s.origin[1] - c[1], s.origin[2] - c[2]];
		const vectors = [A, Bx, By, oc];
		const axes = [s.n, s.u, s.v];
		// rows: A.n Bx.n By.n A.u Bx.u By.u A.v Bx.v By.v, then oc.n and the camera centre in (a, b)
		const dots = axes.map((axis) => vectors.map((v) => v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]));
		coef[base] = dots[0][0];
		coef[base + 1] = dots[0][1];
		coef[base + 2] = dots[0][2];
		coef[base + 3] = dots[1][0];
		coef[base + 4] = dots[1][1];
		coef[base + 5] = dots[1][2];
		coef[base + 6] = dots[2][0];
		coef[base + 7] = dots[2][1];
		coef[base + 8] = dots[2][2];
		coef[base + 9] = dots[0][3];
		coef[base + 10] = -dots[1][3];
		coef[base + 11] = -dots[2][3];
		coef[base + 12] = s.width;
		coef[base + 13] = s.height;
	}
	// screen bounding box of every surface (the whole frame when a corner is behind the camera)
	const box = new Int32Array(count * 4);
	for (let k = 0; k < count; k++) {
		const s = surfaces[k];
		let x0 = Infinity;
		let x1 = -Infinity;
		let y0 = Infinity;
		let y1 = -Infinity;
		let behind = false;
		for (const [a, b] of [
			[0, 0],
			[s.width, 0],
			[0, s.height],
			[s.width, s.height],
		]) {
			const px = s.origin[0] + a * s.u[0] + b * s.v[0] - c[0];
			const py = s.origin[1] + a * s.u[1] + b * s.v[1] - c[1];
			const pz = s.origin[2] + a * s.u[2] + b * s.v[2] - c[2];
			const z = r[6] * px + r[7] * py + r[8] * pz;
			if (!(z > 0.05)) {
				behind = true;
				break;
			}
			const ix = (scene.frameWidth / 2 + (f * (r[0] * px + r[1] * py + r[2] * pz)) / z) / sx - 0.5;
			const iy = (scene.frameHeight / 2 + (f * (r[3] * px + r[4] * py + r[5] * pz)) / z) / sy - 0.5;
			x0 = Math.min(x0, ix);
			x1 = Math.max(x1, ix);
			y0 = Math.min(y0, iy);
			y1 = Math.max(y1, iy);
		}
		box[k * 4] = behind ? 0 : Math.max(0, Math.floor(x0) - 1);
		box[k * 4 + 1] = behind ? width - 1 : Math.min(width - 1, Math.ceil(x1) + 1);
		box[k * 4 + 2] = behind ? 0 : Math.max(0, Math.floor(y0) - 1);
		box[k * 4 + 3] = behind ? height - 1 : Math.min(height - 1, Math.ceil(y1) + 1);
	}
	const active = new Int32Array(count);
	for (let j = 0; j < height; j++) {
		let activeCount = 0;
		for (let k = 0; k < count; k++) {
			if (j >= box[k * 4 + 2] && j <= box[k * 4 + 3] && box[k * 4] <= box[k * 4 + 1]) active[activeCount++] = k;
		}
		for (let i = 0; i < width; i++) {
			let bestT = Infinity;
			let bestK = -1;
			let bestA = 0;
			let bestB = 0;
			let bestDen = 0;
			for (let q = 0; q < activeCount; q++) {
				const k = active[q];
				if (i < box[k * 4] || i > box[k * 4 + 1]) continue;
				const base = k * 14;
				const den = coef[base] + i * coef[base + 1] + j * coef[base + 2];
				if (den > -1e-9 && den < 1e-9) continue;
				const t = coef[base + 9] / den;
				if (!(t > 0.05) || t >= bestT) continue;
				const a = coef[base + 10] + t * (coef[base + 3] + i * coef[base + 4] + j * coef[base + 5]);
				if (a < 0 || a > coef[base + 12]) continue;
				const b = coef[base + 11] + t * (coef[base + 6] + i * coef[base + 7] + j * coef[base + 8]);
				if (b < 0 || b > coef[base + 13]) continue;
				bestT = t;
				bestK = k;
				bestA = a;
				bestB = b;
				bestDen = den;
			}
			if (bestK < 0) {
				out[j * width + i] = 128;
				continue;
			}
			const s = surfaces[bestK];
			const dx = A[0] + i * Bx[0] + j * By[0];
			const dy = A[1] + i * Bx[1] + j * By[1];
			const dz = A[2] + i * Bx[2] + j * By[2];
			const dLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
			const cosine = Math.max(0.05, Math.abs(bestDen) / dLength);
			// world size of the pixel footprint (geometric mean of its two axes on the surface)
			const footprint = (bestT * dLength * pixelAngle) / Math.sqrt(cosine);
			const level = Math.max(0, Math.log2(footprint / s.texel));
			const levels = s.texture.levels;
			const l0 = Math.min(levels.length - 1, Math.floor(level));
			const l1 = Math.min(levels.length - 1, l0 + 1);
			const blend = l0 === l1 ? 0 : level - l0;
			let value = 0;
			for (let pass = 0; pass < 2; pass++) {
				const index = pass === 0 ? l0 : l1;
				const weight = pass === 0 ? 1 - blend : blend;
				if (weight <= 0) continue;
				const tex = levels[index];
				const scale = 1 / (s.texel * (1 << index));
				const tx = Math.max(0, Math.min(tex.w - 1.000001, bestA * scale - 0.5));
				const ty = Math.max(0, Math.min(tex.h - 1.000001, bestB * scale - 0.5));
				const x0 = Math.floor(tx);
				const y0 = Math.floor(ty);
				const fx = tx - x0;
				const fy = ty - y0;
				const x1 = Math.min(tex.w - 1, x0 + 1);
				const y1 = Math.min(tex.h - 1, y0 + 1);
				const row0 = y0 * tex.w;
				const row1 = y1 * tex.w;
				const top = tex.data[row0 + x0] * (1 - fx) + tex.data[row0 + x1] * fx;
				const bottom = tex.data[row1 + x0] * (1 - fx) + tex.data[row1 + x1] * fx;
				value += weight * (top * (1 - fy) + bottom * fy);
			}
			out[j * width + i] = value;
		}
	}
}

function analysisHeight({ scene, width }: { scene: Synth3DScene; width: number }): number {
	return Math.round((width * scene.frameHeight) / scene.frameWidth);
}

let noiseTable: Float32Array | null = null;

/** A table of standard normal samples read with a xorshift index: cheap, deterministic sensor noise. */
function makeNoiseSource({ seed }: { seed: number }): () => number {
	if (!noiseTable) {
		const random = createRng({ seed: 0x5bd1e995 });
		noiseTable = new Float32Array(65536);
		for (let i = 0; i < noiseTable.length; i++) noiseTable[i] = gaussianSample({ random });
	}
	const table = noiseTable;
	let state = ((seed * 2654435761) >>> 0) || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return table[(state >>> 16) & 0xffff];
	};
}

/**
 * Renders the frames `0..frameCount-1` at `width` px wide (height from the
 * 16:9 frame), one at a time into a reused buffer: `onFrame` must copy a
 * frame it keeps.
 */
export function renderSequence({
	scene,
	width,
	onFrame,
	frames,
}: {
	scene: Synth3DScene;
	width: number;
	onFrame: (args: { frame: GrayFrame; index: number }) => void;
	/** Render only these frames (default all). */
	frames?: readonly number[];
}): void {
	const height = analysisHeight({ scene, width });
	const n = width * height;
	const tmp = new Float32Array(n);
	const acc = new Float32Array(n);
	const data = new Uint8Array(n);
	const frame: GrayFrame = { w: width, h: height, data };
	const list = frames ?? Array.from({ length: scene.frameCount }, (_, i) => i);
	for (const index of list) {
		const noise = makeNoiseSource({ seed: scene.seed * 7919 + index * 104729 + 13 });
		if (scene.subframes > 1) {
			acc.fill(0);
			for (let k = 0; k < scene.subframes; k++) {
				const t = index + (k / (scene.subframes - 1) - 0.5) * scene.shutter;
				castFrame({ scene, frame: t, width, height, out: tmp });
				for (let i = 0; i < n; i++) acc[i] += tmp[i] / scene.subframes;
			}
			tmp.set(acc);
		} else {
			castFrame({ scene, frame: index, width, height, out: tmp });
		}
		for (let i = 0; i < n; i++) {
			const v = tmp[i] + scene.noise * noise();
			data[i] = v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0;
		}
		onFrame({ frame, index });
	}
}

/** One rendered frame (a copy). */
export function renderFrame({ scene, frame, width }: { scene: Synth3DScene; frame: number; width: number }): GrayFrame {
	let result: GrayFrame | null = null;
	renderSequence({
		scene,
		width,
		frames: [frame],
		onFrame: ({ frame: rendered }) => {
			result = { w: rendered.w, h: rendered.h, data: Uint8Array.from(rendered.data) };
		},
	});
	if (!result) throw new Error("renderFrame: nothing rendered");
	return result;
}

// ---------------------------------------------------------------------------
// Metric support
// ---------------------------------------------------------------------------

/** Radius around the metric pixel that must be wall: the corners of the 200 px square are 141 px away. */
const METRIC_CLEAR_RADIUS = 150;

/**
 * The acceptance metric's pixel at `frame`: the pixel nearest to the frame
 * centre (8 px grid) whose ray hits the wall first, with the wall also the
 * first hit at 16 points on a circle of 150 px around it. The same rule for
 * every scene. `null` when there is none.
 */
export function metricPixel({ scene, frame }: { scene: Synth3DScene; frame: number }): { x: number; y: number } | null {
	const cx = scene.frameWidth / 2;
	const cy = scene.frameHeight / 2;
	const candidates: { x: number; y: number; d: number }[] = [];
	for (let y = METRIC_CLEAR_RADIUS; y <= scene.frameHeight - METRIC_CLEAR_RADIUS; y += 8) {
		for (let x = METRIC_CLEAR_RADIUS; x <= scene.frameWidth - METRIC_CLEAR_RADIUS; x += 8) {
			candidates.push({ x, y, d: Math.hypot(x - cx, y - cy) });
		}
	}
	candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
	for (const candidate of candidates) {
		if (surfaceAtPixel({ scene, frame, x: candidate.x, y: candidate.y })?.surface !== scene.wall) continue;
		let clear = true;
		for (let k = 0; k < 16 && clear; k++) {
			const angle = (2 * Math.PI * k) / 16;
			const hit = surfaceAtPixel({
				scene,
				frame,
				x: candidate.x + METRIC_CLEAR_RADIUS * Math.cos(angle),
				y: candidate.y + METRIC_CLEAR_RADIUS * Math.sin(angle),
			});
			if (hit?.surface !== scene.wall) clear = false;
		}
		if (clear) return { x: candidate.x, y: candidate.y };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Ideal tracks (no rendering): for fast solver unit tests
// ---------------------------------------------------------------------------

/**
 * Feature tracks of random points on the static surfaces, projected exactly
 * by the true cameras and given Gaussian noise (`noise`, analysis px), in
 * the tracker's analysis INDEX coordinates. Each point is one track that
 * starts on a random frame where it is in view and lives up to `maxLife`
 * frames while it stays in view. No occlusion test. `outliers` adds tracks
 * that wander at random (a share of `pointCount`). Tracks never cross a
 * frame of `cuts`.
 */
export function syntheticTracks({
	scene,
	width,
	noise,
	pointCount,
	seed,
	minLife = 8,
	maxLife = 80,
	outliers = 0,
	cuts = [],
}: {
	scene: Synth3DScene;
	width: number;
	noise: number;
	pointCount: number;
	seed: number;
	minLife?: number;
	maxLife?: number;
	outliers?: number;
	cuts?: number[];
}): { tracks: FeatureTracks; points: Vec3[] } {
	const random = createRng({ seed });
	const height = analysisHeight({ scene, width });
	const sx = width / scene.frameWidth;
	const sy = height / scene.frameHeight;
	const margin = 4;
	const cameras = Array.from({ length: scene.frameCount }, (_, t) => scene.cameraAt(t));
	const rows = cameras.map(rotationRows);
	const project = ({ point, frame }: { point: Vec3; frame: number }): { x: number; y: number } | null => {
		const r = rows[frame];
		const c = cameras[frame].position;
		const px = point[0] - c[0];
		const py = point[1] - c[1];
		const pz = point[2] - c[2];
		const z = r[6] * px + r[7] * py + r[8] * pz;
		if (!(z > 0.1)) return null;
		const f = cameras[frame].focalPx;
		const x = scene.frameWidth / 2 + (f * (r[0] * px + r[1] * py + r[2] * pz)) / z;
		const y = scene.frameHeight / 2 + (f * (r[3] * px + r[4] * py + r[5] * pz)) / z;
		const ix = x * sx - 0.5;
		const iy = y * sy - 0.5;
		if (ix < margin || iy < margin || ix > width - 1 - margin || iy > height - 1 - margin) return null;
		return { x: ix, y: iy };
	};
	const statics = scene.surfaces.filter((surface) => !surface.offsetAt);
	const area = statics.map((surface) => surface.width * surface.height);
	const totalArea = area.reduce((a, b) => a + b, 0);
	const points: Vec3[] = [];
	const starts: number[] = [];
	const samples: number[][] = [];
	const cutSet = [...cuts].sort((a, b) => a - b);
	const nextCut = (frame: number): number => cutSet.find((cut) => cut > frame) ?? scene.frameCount;
	const inlierCount = Math.round(pointCount * (1 - outliers));
	for (let attempt = 0; attempt < pointCount * 200 && samples.length < inlierCount; attempt++) {
		let pick = random() * totalArea;
		let index = 0;
		while (index < statics.length - 1 && pick > area[index]) {
			pick -= area[index];
			index++;
		}
		const surface = statics[index];
		const a = random() * surface.width;
		const b = random() * surface.height;
		const point: Vec3 = [
			surface.origin[0] + a * surface.axisU[0] + b * surface.axisV[0],
			surface.origin[1] + a * surface.axisU[1] + b * surface.axisV[1],
			surface.origin[2] + a * surface.axisU[2] + b * surface.axisV[2],
		];
		const start = Math.floor(random() * scene.frameCount);
		if (!project({ point, frame: start })) continue;
		const life = minLife + Math.floor(random() * (maxLife - minLife + 1));
		const stop = Math.min(scene.frameCount, start + life, nextCut(start));
		const xy: number[] = [];
		for (let t = start; t < stop; t++) {
			const p = project({ point, frame: t });
			if (!p) break;
			xy.push(p.x + noise * gaussianSample({ random }), p.y + noise * gaussianSample({ random }));
		}
		if (xy.length < 4) continue;
		points.push(point);
		starts.push(start);
		samples.push(xy);
	}
	const outlierCount = pointCount - inlierCount;
	for (let k = 0; k < outlierCount; k++) {
		const start = Math.floor(random() * (scene.frameCount - minLife));
		const stop = Math.min(start + minLife + Math.floor(random() * (maxLife - minLife)), nextCut(start));
		let x = margin + random() * (width - 2 * margin);
		let y = margin + random() * (height - 2 * margin);
		const vx = (random() - 0.5) * 3;
		const vy = (random() - 0.5) * 3;
		const xy: number[] = [];
		for (let t = start; t < stop; t++) {
			x = Math.max(margin, Math.min(width - 1 - margin, x + vx));
			y = Math.max(margin, Math.min(height - 1 - margin, y + vy));
			xy.push(x, y);
		}
		if (xy.length < 4) continue;
		points.push([Number.NaN, Number.NaN, Number.NaN]);
		starts.push(start);
		samples.push(xy);
	}
	return { tracks: packTracks({ width, height, frameCount: scene.frameCount, fps: scene.fps, starts, samples, cuts: cutSet }), points };
}

/** Builds `FeatureTracks` from per-track start frames and interleaved samples. */
export function packTracks({
	width,
	height,
	frameCount,
	fps,
	starts,
	samples,
	cuts,
}: {
	width: number;
	height: number;
	frameCount: number;
	fps: number;
	starts: readonly number[];
	samples: readonly (readonly number[])[];
	cuts: number[];
}): FeatureTracks {
	const count = starts.length;
	const trackStart = Int32Array.from(starts);
	const trackLen = new Int32Array(count);
	const trackOffset = new Int32Array(count);
	let floats = 0;
	for (let i = 0; i < count; i++) {
		trackLen[i] = samples[i].length / 2;
		trackOffset[i] = floats;
		floats += samples[i].length;
	}
	const xy = new Float32Array(floats);
	for (let i = 0; i < count; i++) xy.set(samples[i], trackOffset[i]);
	const lists: number[][] = Array.from({ length: frameCount }, () => []);
	for (let i = 0; i < count; i++) {
		for (let j = 0; j < trackLen[i]; j++) lists[trackStart[i] + j].push(i);
	}
	const liveOffsets = new Int32Array(frameCount + 1);
	for (let f = 0; f < frameCount; f++) liveOffsets[f + 1] = liveOffsets[f] + lists[f].length;
	const liveIds = new Int32Array(liveOffsets[frameCount]);
	for (let f = 0; f < frameCount; f++) liveIds.set(lists[f], liveOffsets[f]);
	return {
		w: width,
		h: height,
		frameCount,
		fps,
		trackStart,
		trackLen,
		trackOffset,
		xy,
		liveOffsets,
		liveIds,
		cuts,
		stats: { lostFraction: new Float32Array(frameCount), cutNcc: [] },
	};
}
