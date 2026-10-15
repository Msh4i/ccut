// features-camera.js test footage: a textured "world" seen through a moving camera, rendered in Node and encoded with ffmpeg.
// The world carries two pure green square markers (the ground truth: the exact marker centre of every frame comes from the
// camera maths, not from the tracker). The element that gets stuck is a magenta two-ring PNG (no magenta in the footage).
// Everything is written to CACHE_DIR (outside the repo, under CCUT_E2E_DIR or the system temp folder) and reused while GEN_VERSION is unchanged.
//
// Camera models (see docs/ccut/camera-tracking-v2.md section e):
//   similarity  pan + zoom + roll (+ shake): frame = z R(theta) (world - C) + centre            (E2.1, E2.2, E2.3, E2.5, E2.6, E2.7)
//   yaw         a camera that turns about its vertical axis in front of a plane (homography)   (E2.8)
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const FFMPEG = "/usr/bin/ffmpeg";
const GEN_VERSION = 4;
const CACHE_DIR = path.join(process.env.CCUT_E2E_DIR ?? require("node:os").tmpdir(), "ccut-camera-e2e", "assets");

// Marker world positions relative to the camera start centre (C0). Both on the same row so the ring pair starts horizontal.
const MARKER_HALF = 24; // 48 x 48 world px squares
const MARKERS_REL = [
	{ dx: 250, dy: 0 },
	{ dx: 550, dy: 0 },
];

// ---------------------------------------------------------------- random / world
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function addNoiseOctave({ img, width, height, cell, amp, random }) {
	const gw = Math.ceil(width / cell) + 2;
	const gh = Math.ceil(height / cell) + 2;
	const lattice = new Float32Array(gw * gh);
	for (let i = 0; i < lattice.length; i++) lattice[i] = random() * 2 - 1;
	for (let y = 0; y < height; y++) {
		const fy = y / cell;
		const iy = Math.floor(fy);
		const ty = fy - iy;
		const sy = ty * ty * (3 - 2 * ty);
		for (let x = 0; x < width; x++) {
			const fx = x / cell;
			const ix = Math.floor(fx);
			const tx = fx - ix;
			const sx = tx * tx * (3 - 2 * tx);
			const a = lattice[iy * gw + ix];
			const b = lattice[iy * gw + ix + 1];
			const c = lattice[(iy + 1) * gw + ix];
			const d = lattice[(iy + 1) * gw + ix + 1];
			img[y * width + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
		}
	}
}

function fillShapes({ img, width, height, count, random, ampLo, ampHi, maxSize }) {
	for (let k = 0; k < count; k++) {
		const kind = random();
		const cx = random() * width;
		const cy = random() * height;
		const size = 6 + random() * random() * maxSize;
		const delta = (random() < 0.5 ? -1 : 1) * (ampLo + random() * (ampHi - ampLo));
		const x0 = Math.max(0, Math.floor(cx - size));
		const x1 = Math.min(width - 1, Math.ceil(cx + size));
		const y0 = Math.max(0, Math.floor(cy - size));
		const y1 = Math.min(height - 1, Math.ceil(cy + size));
		if (kind < 0.45) {
			const hw = size * (0.3 + random());
			const hh = size * (0.3 + random());
			const ang = random() * Math.PI;
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const dx = x - cx;
					const dy = y - cy;
					const u = dx * c + dy * s;
					const v = -dx * s + dy * c;
					if (Math.abs(u) < hw && Math.abs(v) < hh) img[y * width + x] += delta;
				}
			}
		} else if (kind < 0.8) {
			const rr = size * 0.6;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const dx = x - cx;
					const dy = y - cy;
					if (dx * dx + dy * dy < rr * rr) img[y * width + x] += delta;
				}
			}
		} else {
			const ang = random() * Math.PI;
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			const len = size * 1.5;
			const th = 1.5 + random() * 3;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const dx = x - cx;
					const dy = y - cy;
					const u = dx * c + dy * s;
					const v = -dx * s + dy * c;
					if (Math.abs(u) < len && Math.abs(v) < th) img[y * width + x] += delta * 1.3;
				}
			}
		}
	}
}

// Same recipe as apps/web/src/tracking/camera/camera-synth-world.ts: octaves of value noise plus random rectangles, discs and bars.
function makeWorld({ width, height, seed, texture = 1, shapes = 700, maxSize = 160 }) {
	const random = mulberry32(seed);
	const img = new Float32Array(width * height).fill(128);
	if (texture > 0) {
		const cells = [256, 128, 64, 32, 16, 8, 4, 2];
		const amps = [22, 18, 14, 12, 11, 10, 9, 8];
		for (let i = 0; i < cells.length; i++) addNoiseOctave({ img, width, height, cell: cells[i], amp: texture * amps[i], random });
		fillShapes({ img, width, height, count: Math.round(shapes * texture), random, ampLo: 10, ampHi: 40, maxSize });
	}
	for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(255, img[i]));
	return { data: img, width, height, mark: new Float32Array(width * height) };
}

// Square markers: pixels cx-24 .. cx+23 (their centre in pixel-index coordinates is cx - 0.5)
function stampMarkers(world, centres) {
	for (const { x: cx, y: cy } of centres) {
		for (let y = cy - MARKER_HALF; y < cy + MARKER_HALF; y++) {
			for (let x = cx - MARKER_HALF; x < cx + MARKER_HALF; x++) world.mark[y * world.width + x] = 1;
		}
	}
}

// ---------------------------------------------------------------- cameras
// A camera pose -> { toWorld(u, v), fromWorld(wx, wy) } in pixel-index coordinates
function similarityCamera({ cx, cy, zoom, thetaDeg, centreU, centreV }) {
	const th = (thetaDeg * Math.PI) / 180;
	const c = Math.cos(th);
	const s = Math.sin(th);
	const a = c / zoom;
	const b = s / zoom;
	const d = -s / zoom;
	const e = c / zoom;
	return {
		kind: "affine",
		a,
		b,
		d,
		e,
		c0: cx - (a * centreU + b * centreV),
		f0: cy - (d * centreU + e * centreV),
		fromWorld: (wx, wy) => {
			const dx = wx - cx;
			const dy = wy - cy;
			return [centreU + zoom * (c * dx - s * dy), centreV + zoom * (s * dx + c * dy)];
		},
		zoom,
		thetaDeg,
	};
}

// Camera turning about its vertical axis (yaw psi) in front of the plane z = f; at psi = 0 pixel (u, v) sees world (cx + du, cy + dv)
function yawCamera({ cx, cy, focal, psiDeg, centreU, centreV }) {
	const psi = (psiDeg * Math.PI) / 180;
	const c = Math.cos(psi);
	const s = Math.sin(psi);
	return {
		kind: "yaw",
		c,
		s,
		focal,
		cx,
		cy,
		centreU,
		centreV,
		fromWorld: (wx, wy) => {
			const a = wx - cx;
			const b = wy - cy;
			const x = a * c - focal * s;
			const z = a * s + focal * c;
			return [centreU + (focal * x) / z, centreV + (focal * b) / z];
		},
		psiDeg,
	};
}

// ---------------------------------------------------------------- rendering
function polygonCentroid(points) {
	let area = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < points.length; i++) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[(i + 1) % points.length];
		const cross = x0 * y1 - x1 * y0;
		area += cross;
		cx += (x0 + x1) * cross;
		cy += (y0 + y1) * cross;
	}
	area /= 2;
	return [cx / (6 * area), cy / (6 * area)];
}

function renderWorldFrame({ out, width, height, world, cam, noise, frameIndex }) {
	const { data, mark, width: ww, height: wh } = world;
	const maxX = ww - 2;
	const maxY = wh - 2;
	const noiseLen = noise.length;
	let o = 0;
	let column = null;
	if (cam.kind === "yaw") {
		// per column: X, Z (depend on u only)
		column = { wxBase: new Float64Array(width), scale: new Float64Array(width) };
		for (let u = 0; u < width; u++) {
			const x = u - cam.centreU;
			const X = x * cam.c + cam.focal * cam.s;
			const Z = -x * cam.s + cam.focal * cam.c;
			column.wxBase[u] = cam.cx + (X * cam.focal) / Z;
			column.scale[u] = cam.focal / Z;
		}
	}
	for (let v = 0; v < height; v++) {
		for (let u = 0; u < width; u++) {
			let wx;
			let wy;
			if (column) {
				wx = column.wxBase[u];
				wy = cam.cy + (v - cam.centreV) * column.scale[u];
			} else {
				wx = cam.a * u + cam.b * v + cam.c0;
				wy = cam.d * u + cam.e * v + cam.f0;
			}
			if (wx < 1) wx = 1;
			else if (wx > maxX) wx = maxX;
			if (wy < 1) wy = 1;
			else if (wy > maxY) wy = maxY;
			const ix = wx | 0;
			const iy = wy | 0;
			const fx = wx - ix;
			const fy = wy - iy;
			const i00 = iy * ww + ix;
			const i10 = i00 + 1;
			const i01 = i00 + ww;
			const i11 = i01 + 1;
			const w00 = (1 - fx) * (1 - fy);
			const w10 = fx * (1 - fy);
			const w01 = (1 - fx) * fy;
			const w11 = fx * fy;
			const g = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
			const m = mark[i00] * w00 + mark[i10] * w10 + mark[i01] * w01 + mark[i11] * w11;
			const n = noise[(o * 7 + frameIndex * 131) % noiseLen];
			// slightly warm-tinted grey world (r ~ g - 3, g, b ~ g - 8 + ...) vs pure green marker (20, 235, 20)
			const r = g * (1 - m) + 20 * m + n;
			const gr = (g + 6) * (1 - m) + 235 * m + n;
			const b = (g - 8) * (1 - m) + 20 * m + n;
			out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
			out[o + 1] = gr < 0 ? 0 : gr > 255 ? 255 : gr;
			out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
			o += 3;
		}
	}
}

// Textured orange disc painted over the frame (a moving object, independent of the camera)
function paintDisc({ out, width, height, disc, tile }) {
	const { u: cu, v: cv, r } = disc;
	const x0 = Math.max(0, Math.floor(cu - r));
	const x1 = Math.min(width - 1, Math.ceil(cu + r));
	const y0 = Math.max(0, Math.floor(cv - r));
	const y1 = Math.min(height - 1, Math.ceil(cv + r));
	const size = tile.size;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - cu;
			const dy = y - cv;
			if (dx * dx + dy * dy > r * r) continue;
			const tx = Math.min(size - 1, Math.max(0, Math.round(dx + r)));
			const ty = Math.min(size - 1, Math.max(0, Math.round(dy + r)));
			const g = tile.data[ty * size + tx];
			const o = (y * width + x) * 3;
			out[o] = Math.min(255, g * 1.15 + 40);
			out[o + 1] = g * 0.55 + 25;
			out[o + 2] = g * 0.15 + 10;
		}
	}
}

function makeDiscTile(radius, seed) {
	const size = Math.ceil(radius * 2) + 2;
	const random = mulberry32(seed);
	const img = new Float32Array(size * size).fill(120);
	for (const [cell, amp] of [[24, 40], [10, 36], [5, 30], [3, 24]]) addNoiseOctave({ img, width: size, height: size, cell, amp, random });
	for (let i = 0; i < img.length; i++) img[i] = Math.max(10, Math.min(235, img[i]));
	return { data: img, size };
}

async function encodeVideo({ file, width, height, fps, outWidth, outHeight, frames }) {
	const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", "-an"];
	if (outWidth && outWidth !== width) args.push("-vf", `scale=${outWidth}:${outHeight}:flags=bicubic`);
	args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "30", "-movflags", "+faststart", file);
	const child = cp.spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	let stdinError = null;
	child.stdin.on("error", (error) => (stdinError = error));
	const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
	for await (const frame of frames) {
		if (stdinError) break;
		if (!child.stdin.write(frame)) {
			await new Promise((resolve) => {
				const done = () => {
					child.stdin.off("drain", done);
					child.stdin.off("error", done);
					resolve();
				};
				child.stdin.once("drain", done);
				child.stdin.once("error", done);
			});
		}
	}
	child.stdin.end();
	const code = await exited;
	if (code !== 0 || stdinError) throw new Error(`ffmpeg failed (${code}) ${stdinError?.message ?? ""}: ${stderr.slice(-500)}`);
}

// ---------------------------------------------------------------- footage definitions
// kind "similarity": pose(t) -> { cx, cy, zoom, thetaDeg } ; kind "yaw": pose(t) -> { psiDeg }
const SECONDS = 6;
const FPS = 30;
const C0 = { x: 1500, y: 1050 }; // camera start centre in the 3200 x 2200 world

function shake(t) {
	const s = (f, p) => Math.sin(2 * Math.PI * f * t + p);
	return {
		dx: 9 * s(2.3, 0.4) + 5 * s(5.1, 1.7) + 2.5 * s(9.7, 0.2),
		dy: 7 * s(1.9, 2.1) + 4 * s(6.3, 0.9) + 2 * s(11.1, 1.3),
		roll: 1.2 * s(3.1, 0.5) + 0.6 * s(6.7, 1.0),
		zoomFactor: 1 + 0.01 * s(1.7, 0.3),
	};
}

const PAN_ZOOM_ROLL = (t) => ({ cx: C0.x + 100 * t, cy: C0.y + 15 * t, zoom: 1 + 0.4 * (t / SECONDS), thetaDeg: 8 * Math.sin((2 * Math.PI * t) / SECONDS) });
const STILL_POSE = () => ({ cx: C0.x, cy: C0.y, zoom: 1, thetaDeg: 0 });
const SHAKE_POSE = (t) => {
	const k = shake(t);
	return { cx: C0.x + k.dx, cy: C0.y + k.dy, zoom: k.zoomFactor, thetaDeg: k.roll };
};
const GENTLE_PAN = (t) => ({ cx: C0.x + 60 * t, cy: C0.y + 10 * t, zoom: 1 + 0.15 * (t / SECONDS), thetaDeg: 0 });

const FOOTAGE = {
	// E2.1 / E2.1t / E2.10 : pan 100 px/s + zoom 1 -> 1.4 + roll +-8 degrees
	"pan-zoom-roll": { kind: "similarity", pose: PAN_ZOOM_ROLL, markers: true, texture: 1, noiseSigma: 2 },
	// E2.2 : hand shake (three sines + noise)
	shake: { kind: "similarity", pose: SHAKE_POSE, markers: true, texture: 1, noiseSigma: 3 },
	// E2.3 : an object crosses the picture, in front of the markers
	occluder: { kind: "similarity", pose: GENTLE_PAN, markers: true, texture: 1, noiseSigma: 2, discs: [{ r: 110, seed: 5, at: (t) => ({ u: -150 + (1580 * t) / SECONDS, v: 300 + 40 * Math.sin(t * 2) }) }] },
	// E2.4 : flat grey wall, camera pans
	flat: { kind: "similarity", pose: (t) => ({ cx: C0.x + 100 * t, cy: C0.y, zoom: 1, thetaDeg: 0 }), markers: false, texture: 0, noiseSigma: 1 },
	// E2.5 : tripod
	still: { kind: "similarity", pose: STILL_POSE, markers: true, texture: 1, noiseSigma: 2 },
	// E2.6 : a textured disc moves across the scene; camera shakes a little
	"moving-disc": { kind: "similarity", pose: (t) => ({ cx: C0.x + 40 * t, cy: C0.y, zoom: 1 + 0.1 * (t / SECONDS), thetaDeg: 0 }), markers: true, texture: 1, noiseSigma: 2, discs: [{ r: 120, seed: 9, at: (t) => ({ u: 420 + 110 * t, v: 360 + 90 * Math.sin((t * 2 * Math.PI) / SECONDS) }) }] },
	// E2.7 : the world is replaced at 3.0 s (hard cut), camera keeps panning
	cut: { kind: "similarity", pose: (t) => ({ cx: C0.x + 80 * t, cy: C0.y + 10 * t, zoom: 1 + 0.1 * (t / SECONDS), thetaDeg: 0 }), markers: true, texture: 1, noiseSigma: 2, cutAtSeconds: 3.0 },
	// E2.8 : perspective: camera turns 12 degrees about its vertical axis (60 degree horizontal field of view)
	yaw: { kind: "yaw", pose: (t) => ({ psiDeg: 12 * (t / SECONDS) }), markers: true, texture: 1, noiseSigma: 2 },
};

// Output: { file, json, ... }. `variant` { width, height, seconds, outWidth, outHeight } overrides for the long 1080p clip.
async function makeFootage({ name, outName = name, width = 1280, height = 720, seconds = SECONDS, outWidth = null, outHeight = null, poseOverride = null, log = () => {} }) {
	const spec = FOOTAGE[name];
	if (!spec) throw new Error(`unknown footage ${name}`);
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	const file = path.join(CACHE_DIR, `${outName}-v${GEN_VERSION}.mp4`);
	const jsonFile = path.join(CACHE_DIR, `${outName}-v${GEN_VERSION}.json`);
	if (fs.existsSync(file) && fs.existsSync(jsonFile)) return { file, ...JSON.parse(fs.readFileSync(jsonFile, "utf8")), cached: true };
	const started = Date.now();
	const frameCount = Math.round(seconds * FPS);
	const worldW = 3200;
	const worldH = 2200;
	const world = makeWorld({ width: worldW, height: worldH, seed: 20261003, texture: spec.texture });
	const markerCentres = MARKERS_REL.map((m) => ({ x: C0.x + m.dx, y: C0.y + m.dy }));
	if (spec.markers) stampMarkers(world, markerCentres);
	const worldB = spec.cutAtSeconds ? makeWorld({ width: worldW, height: worldH, seed: 777, texture: spec.texture }) : null;
	const noiseRand = mulberry32(31337);
	const noise = new Float32Array(1 << 16);
	for (let i = 0; i < noise.length; i++) noise[i] = ((noiseRand() + noiseRand() + noiseRand() - 1.5) * 2) * spec.noiseSigma;
	const discTiles = (spec.discs ?? []).map((disc) => makeDiscTile(disc.r, disc.seed));
	const centreU = (width - 1) / 2;
	const centreV = (height - 1) / 2;
	const focal = (width / 2) / Math.tan((30 * Math.PI) / 180);
	const truth = { video: { width: outWidth ?? width, height: outHeight ?? height, fps: FPS, seconds, renderWidth: width, renderHeight: height }, markerSize: MARKER_HALF * 2, cutAtSeconds: spec.cutAtSeconds ?? null, kind: spec.kind, frames: [] };
	const pose = poseOverride ?? spec.pose;

	async function* frames() {
		const out = Buffer.alloc(width * height * 3);
		for (let i = 0; i < frameCount; i++) {
			const t = i / FPS;
			const p = pose(t);
			const cam = spec.kind === "yaw" ? yawCamera({ cx: C0.x, cy: C0.y, focal, psiDeg: p.psiDeg, centreU, centreV }) : similarityCamera({ cx: p.cx, cy: p.cy, zoom: p.zoom, thetaDeg: p.thetaDeg, centreU, centreV });
			const cutDone = spec.cutAtSeconds && t >= spec.cutAtSeconds - 1e-9;
			renderWorldFrame({ out, width, height, world: cutDone ? worldB : world, cam, noise, frameIndex: i });
			const entry = { frame: i, t, markers: [], objects: [] };
			if (spec.markers && !cutDone) {
				for (const c of markerCentres) {
					const x0 = c.x - MARKER_HALF - 0.5;
					const x1 = c.x + MARKER_HALF - 0.5;
					const y0 = c.y - MARKER_HALF - 0.5;
					const y1 = c.y + MARKER_HALF - 0.5;
					const [u, v] = polygonCentroid([cam.fromWorld(x0, y0), cam.fromWorld(x1, y0), cam.fromWorld(x1, y1), cam.fromWorld(x0, y1)]);
					entry.markers.push({ x: u + 0.5, y: v + 0.5 }); // edge-based video pixel coordinates (0..width)
				}
			}
			for (let k = 0; k < (spec.discs ?? []).length; k++) {
				const at = spec.discs[k].at(t);
				paintDisc({ out, width, height, disc: { ...at, r: spec.discs[k].r }, tile: discTiles[k] });
				entry.objects.push({ x: at.u + 0.5, y: at.v + 0.5, r: spec.discs[k].r });
			}
			entry.zoom = cam.zoom ?? null;
			entry.rollDeg = cam.thetaDeg ?? null;
			entry.yawDeg = cam.psiDeg ?? null;
			truth.frames.push(entry);
			yield Buffer.from(out);
		}
	}
	await encodeVideo({ file, width, height, fps: FPS, outWidth, outHeight, frames: frames() });
	truth.generatedSeconds = Number(((Date.now() - started) / 1000).toFixed(1));
	fs.writeFileSync(jsonFile, JSON.stringify(truth));
	log(`footage ${outName}: ${frameCount} frames in ${truth.generatedSeconds} s`);
	return { file, ...truth, cached: false };
}

// ---------------------------------------------------------------- the magenta two-ring PNG
// 640 x 360 (16:9): fitted to a 1920 x 1080 canvas at scale 1 it is 1920 x 1080, so image px x 3 = canvas px at Scale 1.
const RING = { width: 640, height: 360, centreSpacingNative: 375, outerR: 58, innerR: 46 };

function crc32(buffer) {
	return zlib.crc32(buffer) >>> 0;
}
function pngChunk(type, body) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	const typeAndBody = Buffer.concat([Buffer.from(type, "ascii"), body]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndBody));
	return Buffer.concat([length, typeAndBody, crc]);
}
function encodePngRgba({ width, height, data }) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}
function makeRingPng(file, { single = false } = {}) {
	const { width, height, centreSpacingNative, outerR, innerR } = RING;
	const data = Buffer.alloc(width * height * 4);
	const centres = single
		? [[width / 2, height / 2]]
		: [
				[width / 2 - centreSpacingNative / 2, height / 2],
				[width / 2 + centreSpacingNative / 2, height / 2],
			];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let alpha = 0;
			for (const [cx, cy] of centres) {
				const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
				const coverage = Math.max(0, Math.min(1, outerR - d + 0.5)) * Math.max(0, Math.min(1, d - innerR + 0.5));
				alpha = Math.max(alpha, coverage);
			}
			const o = (y * width + x) * 4;
			data[o] = 255;
			data[o + 1] = 0;
			data[o + 2] = 255;
			data[o + 3] = Math.round(alpha * 255);
		}
	}
	fs.writeFileSync(file, encodePngRgba({ width, height, data }));
	return { file, ...RING };
}

// Copy with a 90 degree display-rotation side data (phone video held upright). Returns { ok, file, rotation }.
function makeRotatedCopy(source, target) {
	if (!fs.existsSync(target)) {
		const attempts = [
			["-display_rotation:v:0", "90", "-i", source, "-c", "copy", target],
			["-i", source, "-c", "copy", "-metadata:s:v", "rotate=90", target],
		];
		for (const args of attempts) {
			const result = cp.spawnSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
			if (result.status === 0) break;
		}
	}
	const probe = cp.spawnSync("/usr/bin/ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", target]);
	const info = probe.status === 0 ? JSON.parse(probe.stdout.toString()) : {};
	const video = info.streams?.find((stream) => stream.codec_type === "video");
	const rotation = video?.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? video?.tags?.rotate;
	return { ok: rotation !== undefined && Math.abs(Number(rotation)) === 90, file: target, rotation: rotation === undefined ? null : Number(rotation) };
}

module.exports = { makeFootage, makeRingPng, makeRotatedCopy, encodePngRgba, RING, FOOTAGE, MARKER_HALF, CACHE_DIR, GEN_VERSION, SECONDS, FPS, C0, MARKERS_REL, PAN_ZOOM_ROLL };
