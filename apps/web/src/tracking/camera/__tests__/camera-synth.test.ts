import { describe, expect, test } from "bun:test";
import {
	generateHomographySequence,
	generateSequence,
	groundTruthMap,
	makeWorld,
	renderSequence,
	type World,
} from "../camera-synth";
import { createRng, gaussianSample } from "../random";
import { applySim } from "../similarity";

/** Small world so these tests stay fast: the camera is centred on it. */
const WORLD_W = 900;
const WORLD_H = 700;
const CENTRE = { wcx: 450, wcy: 350 };

function smallWorld(seed = 3): World {
	return makeWorld({ width: WORLD_W, height: WORLD_H, seed });
}

function mean(values: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < values.length; i++) sum += values[i];
	return sum / values.length;
}

function std(values: ArrayLike<number>): number {
	const m = mean(values);
	let sum = 0;
	for (let i = 0; i < values.length; i++) sum += (values[i] - m) ** 2;
	return Math.sqrt(sum / values.length);
}

function bilinear({
	data,
	w,
	x,
	y,
}: {
	data: Uint8Array;
	w: number;
	x: number;
	y: number;
}): number {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const fx = x - ix;
	const fy = y - iy;
	const i = iy * w + ix;
	return (
		(data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) +
		(data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy
	);
}

function meanAbsDiff({ a, b }: { a: ArrayLike<number>; b: ArrayLike<number> }): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / a.length;
}

describe("createRng", () => {
	test("the same seed repeats the stream, another seed does not", () => {
		const a = createRng({ seed: 42 });
		const b = createRng({ seed: 42 });
		const c = createRng({ seed: 43 });
		const first = Array.from({ length: 8 }, () => a());
		const second = Array.from({ length: 8 }, () => b());
		const other = Array.from({ length: 8 }, () => c());
		expect(second).toEqual(first);
		expect(other).not.toEqual(first);
	});

	test("values are in [0, 1) and average one half", () => {
		const random = createRng({ seed: 9 });
		const values = Array.from({ length: 20000 }, () => random());
		expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...values)).toBeLessThan(1);
		expect(Math.abs(mean(values) - 0.5)).toBeLessThan(0.01);
	});
});

describe("gaussianSample", () => {
	test("is standard normal: mean 0, deviation 1, symmetric tails", () => {
		const random = createRng({ seed: 5 });
		const values = Array.from({ length: 40000 }, () =>
			gaussianSample({ random }),
		);
		expect(Math.abs(mean(values))).toBeLessThan(0.03);
		expect(Math.abs(std(values) - 1)).toBeLessThan(0.03);
		const beyond = values.filter((v) => Math.abs(v) > 3).length;
		expect(beyond).toBeGreaterThan(40000 * 0.001);
		expect(beyond).toBeLessThan(40000 * 0.006);
	});

	test("survives a stream that yields zero first", () => {
		const draws = [0, 0.25, 0.5];
		let i = 0;
		const value = gaussianSample({ random: () => draws[Math.min(i++, 2)] });
		expect(Number.isFinite(value)).toBe(true);
	});
});

describe("makeWorld", () => {
	test("is deterministic and stays inside 0..255", () => {
		const a = makeWorld({ width: 160, height: 120, seed: 7 });
		const b = makeWorld({ width: 160, height: 120, seed: 7 });
		const c = makeWorld({ width: 160, height: 120, seed: 8 });
		expect(a.width).toBe(160);
		expect(a.height).toBe(120);
		expect(a.data.length).toBe(160 * 120);
		expect(Array.from(b.data)).toEqual(Array.from(a.data));
		expect(Array.from(c.data)).not.toEqual(Array.from(a.data));
		expect(Math.min(...a.data)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...a.data)).toBeLessThanOrEqual(255);
	});

	test("the texture amount scales the detail (edge energy)", () => {
		const edgeEnergy = (world: World) => {
			let sum = 0;
			for (let y = 0; y < world.height; y++) {
				for (let x = 1; x < world.width; x++) {
					sum += Math.abs(world.data[y * world.width + x] - world.data[y * world.width + x - 1]);
				}
			}
			return sum / (world.width * world.height);
		};
		const rich = makeWorld({ width: 300, height: 200, seed: 7, texture: 1 });
		const poor = makeWorld({ width: 300, height: 200, seed: 7, texture: 0.1 });
		expect(edgeEnergy(poor)).toBeLessThan(edgeEnergy(rich) * 0.25);
	});

	test("rejects a world that has no pixels", () => {
		expect(() => makeWorld({ width: 0, height: 10, seed: 1 })).toThrow();
		expect(() => makeWorld({ width: 10, height: -5, seed: 1 })).toThrow();
	});
});

describe("generateSequence", () => {
	const world = smallWorld();
	const base = { frameCount: 12, extra: CENTRE } as const;

	test("is deterministic: the same options give the same frames and truth", () => {
		const options = { ...base, kind: "hand", seed: 4 } as const;
		const a = generateSequence({ world, options });
		const b = generateSequence({ world, options });
		expect(a.frames.length).toBe(12);
		expect(a.frames[0].w).toBe(480);
		expect(a.frames[0].h).toBe(270);
		expect(a.truth).toEqual(b.truth);
		for (let i = 0; i < a.frames.length; i++) {
			expect(Array.from(b.frames[i].data)).toEqual(Array.from(a.frames[i].data));
		}
		const other = generateSequence({ world, options: { ...options, seed: 5 } });
		expect(Array.from(other.frames[0].data)).not.toEqual(
			Array.from(a.frames[0].data),
		);
	});

	test("a static camera without noise shows the same image on every frame", () => {
		const { frames } = generateSequence({
			world,
			options: { ...base, kind: "static", noise: 0 },
		});
		for (const f of frames) {
			expect(Array.from(f.data)).toEqual(Array.from(frames[0].data));
		}
	});

	test("the truth map sends frame 0 content to where frame t shows it", () => {
		for (const kind of ["pan", "zoom", "rot", "combo"] as const) {
			const seq = generateSequence({
				world,
				options: { ...base, frameCount: 30, kind, noise: 0, extra: { ...CENTRE, deg: 12 } },
			});
			const t = 22;
			const g = groundTruthMap({ truth: seq.truth, f0: 0, t, width: 480, height: 270 });
			const first = seq.frames[0].data;
			const later = seq.frames[t].data;
			let wrong = 0;
			let right = 0;
			let count = 0;
			for (let y = 60; y < 210; y += 9) {
				for (let x = 60; x < 420; x += 11) {
					const p = applySim({ map: g, x, y });
					if (p.x < 2 || p.y < 2 || p.x > 476 || p.y > 266) continue;
					right += Math.abs(
						first[y * 480 + x] - bilinear({ data: later, w: 480, x: p.x, y: p.y }),
					);
					wrong += Math.abs(
						first[y * 480 + x] - bilinear({ data: later, w: 480, x, y }),
					);
					count++;
				}
			}
			expect(count).toBeGreaterThan(100);
			// Bilinear resampling of 2 px detail costs a few gray levels, an
			// unrelated pixel costs tens.
			expect(right / count).toBeLessThan(3.5);
			expect(wrong / count).toBeGreaterThan(8);
		}
	});

	test("the pose paths follow their definitions", () => {
		const pan = generateSequence({ world, options: { ...base, kind: "pan", noise: 0 } });
		expect(pan.truth[5].dx).toBeCloseTo(-10, 9);
		expect(pan.truth[5].dy).toBeCloseTo(-2, 9);
		const zoom = generateSequence({
			world,
			options: { ...base, kind: "zoom", noise: 0, extra: { ...CENTRE, zoom: 2 } },
		});
		expect(zoom.truth[0].s).toBeCloseTo(1, 9);
		expect(zoom.truth[11].s).toBeCloseTo(2, 9);
		const rot = generateSequence({
			world,
			options: { ...base, frameCount: 41, kind: "rot", noise: 0, extra: { ...CENTRE, deg: 10 } },
		});
		expect(rot.truth[10].theta).toBeCloseTo((10 * Math.PI) / 180, 9);
		expect(rot.truth[30].theta).toBeCloseTo((-10 * Math.PI) / 180, 9);
	});

	test("a cut shows the second world from the cut frame on", () => {
		const other = smallWorld(11);
		const { frames } = generateSequence({
			world,
			options: { ...base, kind: "static", noise: 0, cutAt: 6, worldAfterCut: other },
		});
		const before = meanAbsDiff({ a: frames[4].data, b: frames[5].data });
		const across = meanAbsDiff({ a: frames[5].data, b: frames[6].data });
		const after = meanAbsDiff({ a: frames[6].data, b: frames[7].data });
		expect(before).toBe(0);
		expect(after).toBe(0);
		expect(across).toBeGreaterThan(15);
	});

	test("a foreground disk covers only its own radius", () => {
		const options = { ...base, kind: "static", noise: 0 } as const;
		const clean = generateSequence({ world, options });
		const withDisk = generateSequence({
			world,
			options: {
				...options,
				foregrounds: [{ x0: 200, y0: 120, vx: 0, vy: 0, radius: 30 }],
			},
		});
		const a = clean.frames[3].data;
		const b = withDisk.frames[3].data;
		let insideChanged = 0;
		for (let y = 0; y < 270; y++) {
			for (let x = 0; x < 480; x++) {
				const d = Math.hypot(x - 200, y - 120);
				const changed = a[y * 480 + x] !== b[y * 480 + x];
				if (d > 33) expect(changed).toBe(false);
				if (d < 28 && changed) insideChanged++;
			}
		}
		expect(insideChanged).toBeGreaterThan(0.8 * Math.PI * 28 * 28);
		expect(withDisk.foregroundTruth[3][0]).toEqual({ x: 200, y: 120, visible: true });
	});

	test("an exposure change applies gain and offset to the frames in its window", () => {
		const options = { ...base, kind: "static", noise: 0 } as const;
		const clean = generateSequence({ world, options });
		const flashed = generateSequence({
			world,
			options: { ...options, exposure: [{ t0: 4, t1: 6, gain: 1.5, offset: 10 }] },
		});
		expect(Array.from(flashed.frames[3].data)).toEqual(Array.from(clean.frames[3].data));
		expect(Array.from(flashed.frames[6].data)).toEqual(Array.from(clean.frames[6].data));
		const m0 = mean(clean.frames[4].data);
		const m1 = mean(flashed.frames[4].data);
		expect(m1).toBeGreaterThan(m0 * 1.3);
		expect(m1).toBeLessThan(m0 * 1.5 + 11);
	});

	test("motion blur smooths a moving camera but leaves a still one alone", () => {
		const gradientEnergy = (data: Uint8Array) => {
			let sum = 0;
			for (let y = 0; y < 270; y++) {
				for (let x = 1; x < 480; x++) sum += Math.abs(data[y * 480 + x] - data[y * 480 + x - 1]);
			}
			return sum;
		};
		const moving = { ...base, kind: "fastpan", noise: 0, extra: { ...CENTRE, speed: 14 } } as const;
		const sharp = generateSequence({ world, options: moving });
		const blurred = generateSequence({ world, options: { ...moving, blur: 1 } });
		expect(gradientEnergy(blurred.frames[5].data)).toBeLessThan(
			gradientEnergy(sharp.frames[5].data) * 0.8,
		);
		const still = { ...base, kind: "static", noise: 0 } as const;
		const a = generateSequence({ world, options: still });
		const b = generateSequence({ world, options: { ...still, blur: 1 } });
		expect(meanAbsDiff({ a: a.frames[5].data, b: b.frames[5].data })).toBeLessThan(0.01);
	});

	test("sensor noise has the requested deviation in both noise models", () => {
		for (const noiseModel of ["table", "exact"] as const) {
			const { frames } = generateSequence({
				world,
				options: { ...base, kind: "static", noise: 6, noiseModel },
			});
			const diff = new Float64Array(480 * 270);
			for (let i = 0; i < diff.length; i++) {
				diff[i] = frames[2].data[i] - frames[3].data[i];
			}
			// two independent frames: the difference has sqrt(2) times sigma
			expect(Math.abs(std(diff) / Math.SQRT2 - 6)).toBeLessThan(0.45);
			expect(Math.abs(mean(diff))).toBeLessThan(0.15);
		}
	});

	test("streaming hands out the same frames, in order, as the collecting call", () => {
		const options = { ...base, kind: "combo", seed: 8 } as const;
		const collected = generateSequence({ world, options });
		const seen: number[] = [];
		const copies: Uint8Array[] = [];
		const truth = renderSequence({
			world,
			options,
			onFrame: ({ frame, index }) => {
				seen.push(index);
				copies.push(frame.data.slice());
			},
		});
		expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => i));
		expect(truth.truth).toEqual(collected.truth);
		for (let i = 0; i < 12; i++) {
			expect(Array.from(copies[i])).toEqual(Array.from(collected.frames[i].data));
		}
	});

	test("rejects an empty sequence", () => {
		expect(() =>
			generateSequence({ world, options: { kind: "static", frameCount: 0 } }),
		).toThrow();
	});
});

describe("generateHomographySequence", () => {
	const world = smallWorld(6);
	const make = (yawMaxDeg: number) =>
		generateHomographySequence({
			world,
			hfovDeg: 60,
			yawMaxDeg,
			pitchMaxDeg: 0,
			frameCount: 20,
			noise: 0,
			onFrame: () => {},
		});

	test("frame 0 maps to itself", () => {
		const truth = make(10);
		const p = truth.truthPoint({ t: 0, x: 123, y: 77 });
		expect(p.x).toBeCloseTo(123, 6);
		expect(p.y).toBeCloseTo(77, 6);
		expect(truth.frameCount).toBe(20);
	});

	test("a yaw of 10 degrees moves the centre by f * tan(10 deg)", () => {
		const truth = make(10);
		const f = 240 / Math.tan((30 * Math.PI) / 180);
		const p = truth.truthPoint({ t: 19, x: 240, y: 135 });
		expect(Math.abs(p.x - 240)).toBeCloseTo(f * Math.tan((10 * Math.PI) / 180), 0);
		expect(Math.abs(p.y - 135)).toBeLessThan(0.5);
	});

	test("the rendered frames agree with the truth map", () => {
		const frames: Uint8Array[] = [];
		const truth = generateHomographySequence({
			world,
			hfovDeg: 60,
			yawMaxDeg: 8,
			pitchMaxDeg: 3,
			frameCount: 12,
			noise: 0,
			onFrame: ({ frame }) => frames.push(frame.data.slice()),
		});
		let right = 0;
		let wrong = 0;
		let count = 0;
		for (let y = 70; y < 200; y += 10) {
			for (let x = 70; x < 400; x += 13) {
				const p = truth.truthPoint({ t: 11, x, y });
				if (p.x < 2 || p.y < 2 || p.x > 476 || p.y > 266) continue;
				right += Math.abs(
					frames[0][y * 480 + x] - bilinear({ data: frames[11], w: 480, x: p.x, y: p.y }),
				);
				wrong += Math.abs(frames[0][y * 480 + x] - frames[11][y * 480 + x]);
				count++;
			}
		}
		expect(count).toBeGreaterThan(100);
		expect(right / count).toBeLessThan(3.5);
		expect(wrong / count).toBeGreaterThan(8);
	});
});
