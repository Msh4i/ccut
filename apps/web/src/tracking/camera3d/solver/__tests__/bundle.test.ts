import { describe, expect, test } from "bun:test";
import { createRng, gaussianSample } from "@/tracking/camera/random";
import { bundleAdjust, refinePoint, refinePose, type BundleProblem } from "../bundle";
import { mat3Apply, mat3Mul, mat3Transpose, rotExp, rotLog } from "../linalg";

const noYield = async (): Promise<void> => {};

interface Truth {
	rotations: Float64Array;
	centers: Float64Array;
	focal: number;
	points: Float64Array;
}

/** Six cameras sliding sideways in front of a cloud of points, focal 1500 px. */
function makeTruth({ seed, cameraCount = 6, pointCount = 120 }: { seed: number; cameraCount?: number; pointCount?: number }): Truth {
	const random = createRng({ seed });
	const rotations = new Float64Array(cameraCount * 9);
	const centers = new Float64Array(cameraCount * 3);
	for (let c = 0; c < cameraCount; c++) {
		rotations.set(rotExp([0.02 * c, -0.04 * c, 0.01 * Math.sin(c)]), c * 9);
		centers.set([0.4 * c, -0.05 * c, 0.1 * c], c * 3);
	}
	const points = new Float64Array(pointCount * 3);
	for (let p = 0; p < pointCount; p++) {
		points.set([random() * 8 - 2, random() * 4 - 2, 6 + random() * 8], p * 3);
	}
	return { rotations, centers, focal: 1500, points };
}

function project({ truth, camera, point, focal }: { truth: Truth; camera: number; point: ArrayLike<number>; focal: number }): [number, number] | null {
	const r = truth.rotations.subarray(camera * 9, camera * 9 + 9);
	const c = truth.centers.subarray(camera * 3, camera * 3 + 3);
	const x = mat3Apply({ m: r, v: [point[0] - c[0], point[1] - c[1], point[2] - c[2]] });
	if (!(x[2] > 0)) return null;
	const u = (focal * x[0]) / x[2];
	const v = (focal * x[1]) / x[2];
	if (Math.abs(u) > 960 || Math.abs(v) > 540) return null;
	return [u, v];
}

function makeProblem({ truth, noise, seed, outlierShare = 0 }: { truth: Truth; noise: number; seed: number; outlierShare?: number }): BundleProblem {
	const random = createRng({ seed });
	const cameraCount = truth.centers.length / 3;
	const pointCount = truth.points.length / 3;
	const camera: number[] = [];
	const point: number[] = [];
	const uv: number[] = [];
	for (let p = 0; p < pointCount; p++) {
		for (let c = 0; c < cameraCount; c++) {
			const projected = project({ truth, camera: c, point: truth.points.subarray(p * 3, p * 3 + 3), focal: truth.focal });
			if (!projected) continue;
			let [u, v] = projected;
			u += noise * gaussianSample({ random });
			v += noise * gaussianSample({ random });
			if (random() < outlierShare) {
				u += 40 + random() * 60;
				v -= 30 + random() * 60;
			}
			camera.push(c);
			point.push(p);
			uv.push(u, v);
		}
	}
	return {
		cameras: {
			count: cameraCount,
			rotations: Float64Array.from(truth.rotations),
			centers: Float64Array.from(truth.centers),
			focals: new Float64Array(cameraCount).fill(truth.focal),
		},
		points: Float64Array.from(truth.points),
		observations: {
			count: camera.length,
			camera: Int32Array.from(camera),
			point: Int32Array.from(point),
			uv: Float64Array.from(uv),
			active: new Uint8Array(camera.length).fill(1),
		},
	};
}

/** Perturbs every camera but the first, the focal lengths and every point. */
function perturb({ problem, seed, focalFactor }: { problem: BundleProblem; seed: number; focalFactor: number }): void {
	const random = createRng({ seed });
	const { cameras, points } = problem;
	for (let c = 1; c < cameras.count; c++) {
		const r = cameras.rotations.subarray(c * 9, c * 9 + 9);
		r.set(mat3Mul({ a: rotExp([0.01 * (random() - 0.5), 0.01 * (random() - 0.5), 0.01 * (random() - 0.5)]), b: r }));
		for (let k = 0; k < 3; k++) cameras.centers[c * 3 + k] += 0.05 * (random() - 0.5);
	}
	for (let c = 0; c < cameras.count; c++) cameras.focals[c] *= focalFactor;
	for (let i = 0; i < points.length; i++) points[i] += 0.1 * (random() - 0.5);
}

function reprojectionRms(problem: BundleProblem): number {
	const { cameras, points, observations } = problem;
	let sum = 0;
	let count = 0;
	for (let o = 0; o < observations.count; o++) {
		if (!observations.active[o]) continue;
		const c = observations.camera[o];
		const p = observations.point[o];
		const r = cameras.rotations.subarray(c * 9, c * 9 + 9);
		const x = mat3Apply({
			m: r,
			v: [
				points[p * 3] - cameras.centers[c * 3],
				points[p * 3 + 1] - cameras.centers[c * 3 + 1],
				points[p * 3 + 2] - cameras.centers[c * 3 + 2],
			],
		});
		const f = cameras.focals[c];
		sum += ((f * x[0]) / x[2] - observations.uv[2 * o]) ** 2 + ((f * x[1]) / x[2] - observations.uv[2 * o + 1]) ** 2;
		count++;
	}
	return Math.sqrt(sum / count);
}

describe("bundleAdjust", () => {
	test("brings perturbed cameras, points and a shared focal back to the noise level", async () => {
		const truth = makeTruth({ seed: 1 });
		const problem = makeProblem({ truth, noise: 0.5, seed: 2 });
		perturb({ problem, seed: 3, focalFactor: 1.08 });
		// the scale gauge is camera 5's x: keep it at the truth so the cameras can be compared
		problem.cameras.centers[15] = truth.centers[15];
		const before = reprojectionRms(problem);
		const fixedPose = new Uint8Array(problem.cameras.count);
		fixedPose[0] = 1;
		const result = await bundleAdjust({
			problem,
			options: {
				fixedPose,
				fixPositions: false,
				focal: "shared",
				focalSmoothness: null,
				fixedFocal: null,
				fixedPoints: null,
				huber: 2,
				maxIterations: 50,
				scaleAnchor: { camera: 5, axis: 0 },
			},
			step: noYield,
		});
		const after = reprojectionRms(problem);
		expect(before).toBeGreaterThan(10);
		// 2D noise of 0.5 px per axis: the residual rms is a little below 0.5 * sqrt(2)
		expect(after).toBeLessThan(0.75);
		expect(result.iterations).toBeGreaterThan(0);
		expect(Math.abs(problem.cameras.focals[3] / truth.focal - 1)).toBeLessThan(0.01);
		// the gauge: camera 0 untouched, camera 5 kept its x
		expect(problem.cameras.centers[0]).toBe(truth.centers[0]);
		expect(problem.cameras.centers[15]).toBeCloseTo(truth.centers[15], 12);
		// with the gauge pinned like the truth, the cameras come back
		for (let c = 1; c < 6; c++) {
			for (let k = 0; k < 3; k++) {
				expect(Math.abs(problem.cameras.centers[c * 3 + k] - truth.centers[c * 3 + k])).toBeLessThan(0.02);
			}
			const r = problem.cameras.rotations.subarray(c * 9, c * 9 + 9);
			const delta = rotLog(mat3Mul({ a: r, b: mat3Transpose(truth.rotations.subarray(c * 9, c * 9 + 9)) }));
			expect(Math.hypot(...delta)).toBeLessThan(0.002);
		}
	});

	test("the Huber loss keeps gross outliers from pulling the solution", async () => {
		const truth = makeTruth({ seed: 4 });
		const problem = makeProblem({ truth, noise: 0.3, seed: 5, outlierShare: 0.08 });
		perturb({ problem, seed: 6, focalFactor: 1 });
		problem.cameras.centers[15] = truth.centers[15];
		const fixedPose = new Uint8Array(problem.cameras.count);
		fixedPose[0] = 1;
		await bundleAdjust({
			problem,
			options: {
				fixedPose,
				fixPositions: false,
				focal: "fixed",
				focalSmoothness: null,
				fixedFocal: null,
				fixedPoints: null,
				huber: 1,
				maxIterations: 60,
				scaleAnchor: { camera: 5, axis: 0 },
			},
			step: noYield,
		});
		for (let c = 1; c < 6; c++) {
			for (let k = 0; k < 3; k++) {
				expect(Math.abs(problem.cameras.centers[c * 3 + k] - truth.centers[c * 3 + k])).toBeLessThan(0.03);
			}
		}
	});

	test("per-camera focal lengths follow a zoom", async () => {
		const truth = makeTruth({ seed: 7, cameraCount: 8 });
		const problem = makeProblem({ truth, noise: 0.3, seed: 8 });
		// re-project with a zoom: focal 1500 -> 2200
		const focals = Array.from({ length: 8 }, (_, c) => 1500 + (700 * c) / 7);
		const { observations } = problem;
		for (let o = 0; o < observations.count; o++) {
			const c = observations.camera[o];
			observations.uv[2 * o] *= focals[c] / 1500;
			observations.uv[2 * o + 1] *= focals[c] / 1500;
		}
		perturb({ problem, seed: 9, focalFactor: 1 });
		problem.cameras.focals.fill(1700);
		const fixedPose = new Uint8Array(8);
		fixedPose[0] = 1;
		await bundleAdjust({
			problem,
			options: {
				fixedPose,
				fixPositions: false,
				focal: "per-camera",
				focalSmoothness: new Float64Array(7).fill(1),
				fixedFocal: null,
				fixedPoints: null,
				huber: 2,
				maxIterations: 80,
				scaleAnchor: { camera: 7, axis: 0 },
			},
			step: noYield,
		});
		for (let c = 0; c < 8; c++) expect(Math.abs(problem.cameras.focals[c] / focals[c] - 1)).toBeLessThan(0.02);
	});

	test("yields through the step callback", async () => {
		const truth = makeTruth({ seed: 10 });
		const problem = makeProblem({ truth, noise: 0.5, seed: 11 });
		perturb({ problem, seed: 12, focalFactor: 1 });
		let steps = 0;
		const fixedPose = new Uint8Array(problem.cameras.count);
		fixedPose[0] = 1;
		await bundleAdjust({
			problem,
			options: {
				fixedPose,
				fixPositions: false,
				focal: "fixed",
				focalSmoothness: null,
				fixedFocal: null,
				fixedPoints: null,
				huber: 2,
				maxIterations: 5,
				scaleAnchor: { camera: 5, axis: 0 },
			},
			step: async () => {
				steps++;
			},
		});
		expect(steps).toBeGreaterThan(0);
	});
});

describe("single-camera and single-point refinement", () => {
	test("refinePose recovers a pose (and a focal length) from fixed points", () => {
		const truth = makeTruth({ seed: 13 });
		const camera = 3;
		const points: number[] = [];
		const uv: number[] = [];
		const random = createRng({ seed: 14 });
		for (let p = 0; p < 120; p++) {
			const point = truth.points.subarray(p * 3, p * 3 + 3);
			const projected = project({ truth, camera, point, focal: 1800 });
			if (!projected) continue;
			points.push(...point);
			uv.push(projected[0] + 0.3 * gaussianSample({ random }), projected[1] + 0.3 * gaussianSample({ random }));
		}
		const rotation = mat3Mul({ a: rotExp([0.01, -0.01, 0.005]), b: truth.rotations.subarray(27, 36) });
		const center = Float64Array.from([truth.centers[9] + 0.05, truth.centers[10] - 0.04, truth.centers[11] + 0.08]);
		const result = refinePose({
			rotation,
			center,
			focal: 1600,
			points: Float64Array.from(points),
			uv: Float64Array.from(uv),
			huber: 2,
			iterations: 30,
			refineFocal: true,
			fixPosition: false,
		});
		expect(result.focal).toBeGreaterThan(1780);
		expect(result.focal).toBeLessThan(1820);
		for (let k = 0; k < 3; k++) expect(Math.abs(result.center[k] - truth.centers[9 + k])).toBeLessThan(0.02);
		expect(result.rms).toBeLessThan(0.5);
	});

	test("refinePoint moves a point to its least-squares position", () => {
		const truth = makeTruth({ seed: 15 });
		const point = Float64Array.from([1, 0.5, 9]);
		const uv: number[] = [];
		for (let c = 0; c < 6; c++) {
			const projected = project({ truth, camera: c, point, focal: truth.focal });
			if (projected) uv.push(...projected);
		}
		const start = Float64Array.from([1.3, 0.2, 8]);
		const refined = refinePoint({
			point: start,
			rotations: truth.rotations,
			centers: truth.centers,
			focals: new Float64Array(6).fill(truth.focal),
			cameras: Int32Array.from([0, 1, 2, 3, 4, 5]),
			uv: Float64Array.from(uv),
			iterations: 10,
		});
		for (let k = 0; k < 3; k++) expect(refined.point[k]).toBeCloseTo(point[k], 6);
		expect(refined.rms).toBeLessThan(1e-6);
	});
});
