import { afterAll, describe, expect, test } from "bun:test";
import { projectToFrame } from "@/scene3d/camera";
import {
	SYNTH3D_SCENES,
	makeScene,
	metricPixel,
	releaseSynthTextures,
	renderFrame,
	surfaceAtPixel,
	syntheticTracks,
	wallPlane,
} from "../synth3d";

afterAll(releaseSynthTextures);

describe("synthetic 3D scenes", () => {
	test("every scene has a camera per frame with a finite pose and focal", () => {
		for (const name of SYNTH3D_SCENES) {
			const scene = makeScene({ name, frameCount: 30 });
			expect(scene.frameCount).toBe(30);
			for (let t = 0; t < scene.frameCount; t++) {
				const camera = scene.cameraAt(t);
				expect(camera.focalPx).toBeGreaterThan(100);
				for (const value of [...camera.rotation, ...camera.position]) expect(Number.isFinite(value)).toBe(true);
			}
		}
	});

	test("the tripod camera never moves; the others do", () => {
		const tripod = makeScene({ name: "tripod", frameCount: 40 });
		const first = tripod.cameraAt(0).position;
		for (let t = 0; t < 40; t++) expect(tripod.cameraAt(t).position).toEqual(first);
		const walk = makeScene({ name: "fixed-walk", frameCount: 40 });
		const a = walk.cameraAt(0).position;
		const b = walk.cameraAt(39).position;
		expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(1);
	});

	test("zoom changes the focal length; fixed scenes keep it", () => {
		const zoom = makeScene({ name: "zoom", frameCount: 40 });
		expect(zoom.cameraAt(39).focalPx / zoom.cameraAt(0).focalPx).toBeGreaterThan(1.5);
		const walk = makeScene({ name: "fixed-walk", frameCount: 40 });
		expect(walk.cameraAt(39).focalPx).toBe(walk.cameraAt(0).focalPx);
	});
});

describe("rendering", () => {
	test("a frame is deterministic for a seed and has the analysis size", () => {
		const scene = makeScene({ name: "fixed-walk", frameCount: 10 });
		const a = renderFrame({ scene, frame: 3, width: 160 });
		const b = renderFrame({ scene, frame: 3, width: 160 });
		expect(a.w).toBe(160);
		expect(a.h).toBe(90);
		expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
	});

	test("the ray of a pixel hits the surface the renderer drew there (z-buffer)", () => {
		const scene = makeScene({ name: "foreground", frameCount: 10 });
		const camera = scene.cameraAt(5);
		// the box is nearer than the wall: a box pixel must report the box, not the wall behind it
		const names = new Set<string>();
		for (let y = 20; y < 1080; y += 60) {
			for (let x = 20; x < 1920; x += 60) {
				const hit = surfaceAtPixel({ scene, frame: 5, x, y });
				if (!hit) continue;
				names.add(scene.surfaces[hit.surface].name);
				const back = projectToFrame({ camera, frameWidth: 1920, frameHeight: 1080, point: hit.point });
				expect(back).not.toBeNull();
				expect(Math.abs((back?.x ?? 0) - x)).toBeLessThan(1e-6);
				expect(Math.abs((back?.y ?? 0) - y)).toBeLessThan(1e-6);
				// nothing nearer along that ray
				for (let s = 0; s < scene.surfaces.length; s++) {
					if (s === hit.surface) continue;
					const other = surfaceAtPixel({ scene, frame: 5, x, y, only: s });
					if (other) expect(other.depth).toBeGreaterThanOrEqual(hit.depth);
				}
			}
		}
		expect(names.has("wall")).toBe(true);
		expect(names.has("box-front")).toBe(true);
	});

	test("a textured wall is textured and the textureless scene is flat", () => {
		const spread = ({ data }: { data: Uint8Array }): number => {
			let mean = 0;
			for (const v of data) mean += v;
			mean /= data.length;
			let variance = 0;
			for (const v of data) variance += (v - mean) * (v - mean);
			return Math.sqrt(variance / data.length);
		};
		const textured = renderFrame({ scene: makeScene({ name: "fixed-walk", frameCount: 10 }), frame: 0, width: 240 });
		const flat = renderFrame({ scene: makeScene({ name: "textureless", frameCount: 10 }), frame: 0, width: 240 });
		expect(spread(textured)).toBeGreaterThan(12);
		expect(spread(flat)).toBeLessThan(4);
	});
});

describe("metric support", () => {
	test("the metric pixel lies on the wall with wall all around it at the middle frame", () => {
		for (const name of SYNTH3D_SCENES) {
			if (name === "textureless") continue;
			const scene = makeScene({ name, frameCount: 60 });
			const f0 = Math.floor((scene.frameCount - 1) / 2);
			const pixel = metricPixel({ scene, frame: f0 });
			expect(pixel).not.toBeNull();
			if (!pixel) continue;
			const hit = surfaceAtPixel({ scene, frame: f0, x: pixel.x, y: pixel.y });
			expect(hit?.surface).toBe(scene.wall);
			const plane = wallPlane(scene);
			expect(plane.normal[2]).toBeCloseTo(-1, 12);
		}
	});
});

describe("ideal tracks", () => {
	test("tracks are the noisy projections of known points, in analysis index pixels", () => {
		const scene = makeScene({ name: "pan-parallax", frameCount: 20 });
		const { tracks, points } = syntheticTracks({ scene, width: 480, noise: 0, pointCount: 200, seed: 1 });
		expect(tracks.w).toBe(480);
		expect(tracks.h).toBe(270);
		expect(tracks.frameCount).toBe(20);
		let checked = 0;
		for (let id = 0; id < tracks.trackStart.length; id++) {
			for (let j = 0; j < tracks.trackLen[id]; j++) {
				const frame = tracks.trackStart[id] + j;
				const projected = projectToFrame({
					camera: scene.cameraAt(frame),
					frameWidth: 1920,
					frameHeight: 1080,
					point: points[id],
				});
				expect(projected).not.toBeNull();
				const x = tracks.xy[tracks.trackOffset[id] + 2 * j];
				const y = tracks.xy[tracks.trackOffset[id] + 2 * j + 1];
				expect(Math.abs((x + 0.5) * 4 - (projected?.x ?? 0))).toBeLessThan(1e-3);
				expect(Math.abs((y + 0.5) * 4 - (projected?.y ?? 0))).toBeLessThan(1e-3);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(1000);
		// the live lists agree with the track ranges
		for (let f = 0; f < tracks.frameCount; f++) {
			for (let q = tracks.liveOffsets[f]; q < tracks.liveOffsets[f + 1]; q++) {
				const id = tracks.liveIds[q];
				expect(f).toBeGreaterThanOrEqual(tracks.trackStart[id]);
				expect(f).toBeLessThan(tracks.trackStart[id] + tracks.trackLen[id]);
			}
		}
	});
});
