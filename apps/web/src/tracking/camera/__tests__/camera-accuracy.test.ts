/**
 * The measured accuracy of the camera tracker on synthetic ground truth
 * (plan tables M1, M3 and the seed sweep). Thresholds are about twice the
 * measured values; `px@480` is pixels of the analysis frame.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { groundTruthMap, type SequenceOptions } from "../camera-synth";
import { perspectiveSuspected } from "../classify";
import { applySim } from "../similarity";
import { solvePin } from "../solve-pin";
import {
	analyse,
	cachedAnalysis,
	compareModelsOnBox,
	evaluatePins,
	FG_COMBO,
	FG_LONG,
	getWorld,
	releaseCaches,
	report,
	standardPins,
	type Analysis,
	type PinSpec,
} from "./camera-fixtures";

const CORE_FRAMES = 120;
const SWEEP_FRAMES = 60;

afterAll(releaseCaches);

const mainWorld = () => getWorld({ key: "main", seed: 1 });

function solveScene({ analysis, spec }: { analysis: Analysis; spec: PinSpec }) {
	return solvePin({ tracks: analysis.tracks, f0: spec.f0, model: "S", mode: "scene" });
}

const CORE: Record<string, SequenceOptions> = {
	pan: { kind: "pan", frameCount: CORE_FRAMES },
	zoom: { kind: "zoom", frameCount: CORE_FRAMES, extra: { zoom: 1.5 } },
	rotation: { kind: "rot", frameCount: CORE_FRAMES, extra: { deg: 10 } },
	handheld: { kind: "hand", frameCount: CORE_FRAMES },
	combined: { kind: "combo", frameCount: CORE_FRAMES, foregrounds: FG_COMBO },
};

function coreAnalysis(name: string): Analysis {
	return cachedAnalysis({
		key: `core-${name}`,
		make: () => analyse({ world: mainWorld(), options: { seed: 5, ...CORE[name] } }),
	});
}

/**
 * Limits per sequence, about twice what was measured (the plan's own limits for
 * all five are 0.8 px corner, 0.3 rms, 0.3 % scale, 0.25 deg, 0.6 drift). A
 * regression has to show on the sequence it hurts, not hide under the loosest.
 */
const LIMITS: Record<
	string,
	{ corner: number; cornerRms: number; posRms: number; scalePct: number; rotDeg: number; drift: number }
> = {
	pan: { corner: 0.25, cornerRms: 0.12, posRms: 0.08, scalePct: 0.12, rotDeg: 0.08, drift: 0.15 },
	zoom: { corner: 0.4, cornerRms: 0.2, posRms: 0.13, scalePct: 0.1, rotDeg: 0.08, drift: 0.3 },
	rotation: { corner: 0.45, cornerRms: 0.22, posRms: 0.12, scalePct: 0.08, rotDeg: 0.15, drift: 0.3 },
	handheld: { corner: 0.2, cornerRms: 0.1, posRms: 0.05, scalePct: 0.07, rotDeg: 0.05, drift: 0.1 },
	combined: { corner: 0.4, cornerRms: 0.18, posRms: 0.12, scalePct: 0.1, rotDeg: 0.08, drift: 0.28 },
};

describe("similarity camera, 4 pins per sequence (M1)", () => {
	for (const name of Object.keys(CORE)) {
		test(`${name}: corner error, scale, rotation and drift stay inside the limits`, () => {
			const analysis = coreAnalysis(name);
			const worst = evaluatePins({
				analysis,
				pins: standardPins({ frameCount: CORE_FRAMES }),
				solve: (spec) => solveScene({ analysis, spec }),
			});
			report({
				label: `M1 ${name} (${CORE_FRAMES} frames)`,
				values: {
					rows: worst.rows,
					"corner max": worst.cornerMax,
					"corner rms": worst.cornerRms,
					"pos rms": worst.posRms,
					"scale %": worst.scaleMaxPct,
					"rot deg": worst.rotMaxDeg,
					drift: worst.drift,
				},
			});
			// not vacuous: the pins are visible for a good part of the clip, and solved
			expect(worst.rows).toBeGreaterThan(150);
			expect(worst.solved).toBe(worst.rows);
			const limit = LIMITS[name];
			expect(worst.cornerMax).toBeLessThanOrEqual(limit.corner);
			expect(worst.cornerRms).toBeLessThanOrEqual(limit.cornerRms);
			expect(worst.posRms).toBeLessThanOrEqual(limit.posRms);
			expect(worst.scaleMaxPct).toBeLessThanOrEqual(limit.scalePct);
			expect(worst.rotMaxDeg).toBeLessThanOrEqual(limit.rotDeg);
			expect(worst.drift).toBeLessThanOrEqual(limit.drift);
			expect(worst.over1px).toBe(0);
		});
	}

	test("about ninety features stay alive on every one of them", () => {
		for (const name of Object.keys(CORE)) {
			const { tracks } = coreAnalysis(name);
			let live = 0;
			for (let f = 0; f < tracks.frameCount; f++) {
				live += tracks.liveOffsets[f + 1] - tracks.liveOffsets[f];
			}
			expect(live / tracks.frameCount).toBeGreaterThan(80);
			expect(live / tracks.frameCount).toBeLessThanOrEqual(110);
		}
	});

	test("no scene cut is ever invented", () => {
		for (const name of Object.keys(CORE)) expect(coreAnalysis(name).tracks.cuts).toEqual([]);
	});
});

describe("model choice on similarity cameras", () => {
	const truthMapAt = ({ analysis, f0 }: { analysis: Analysis; f0: number }) =>
		({ t, x, y }: { t: number; x: number; y: number }) =>
			applySim({
				map: groundTruthMap({ truth: analysis.truth.truth, f0, t, width: 480, height: 270 }),
				x,
				y,
			});

	for (const name of ["handheld", "rotation", "combined"]) {
		test(`${name}: the similarity and the homography agree to 2 px, so the similarity is kept`, () => {
			const analysis = coreAnalysis(name);
			const pin = { x: 110, y: 200 };
			const comparison = compareModelsOnBox({
				similarity: solvePin({ tracks: analysis.tracks, f0: 0, model: "S", mode: "scene" }),
				homography: solvePin({ tracks: analysis.tracks, f0: 0, model: "H", mode: "scene" }),
				pin,
				truthMapAt: truthMapAt({ analysis, f0: 0 }),
			});
			report({
				label: `model choice ${name}`,
				values: {
					frames: comparison.frames,
					disagreement: comparison.disagreement,
					"S error": comparison.similarityError,
					"RS error": comparison.rotationScaleError,
				},
			});
			expect(comparison.frames).toBeGreaterThan(40);
			expect(comparison.disagreement).toBeLessThanOrEqual(2);
			expect(comparison.similarityError).toBeLessThanOrEqual(0.8);
		});
	}

	test("the perspective gate stays shut for hand, zoom and combined motion", () => {
		for (const name of ["handheld", "zoom", "combined"]) {
			const analysis = coreAnalysis(name);
			const solution = solveScene({ analysis, spec: { f0: 0, pin: { x: 240, y: 135 } } });
			const { suspected, p90 } = perspectiveSuspected({ solution });
			report({ label: `perspective gate ${name}`, values: { p90 } });
			expect(p90).toBeLessThan(0.55);
			expect(suspected).toBe(false);
		}
	});
});

interface SweepCase {
	options: SequenceOptions;
	worldIndex: number;
}

/** 9 sequences over 3 worlds with 1-2 moving objects each, laid out like the prototype sweep. */
function sweepCases({ frameCount, longFrameCount }: { frameCount: number; longFrameCount: number }): SweepCase[] {
	const kinds = ["combo", "hand", "zoom", "rot", "combo", "long", "combo", "pan", "combo"] as const;
	return kinds.map((kind, i) => {
		const rr = (k: number) => ((i * 7919 + k * 104729) % 1000) / 1000;
		const objects = i % 3 === 0 ? 2 : 1;
		const foregrounds = Array.from({ length: objects }, (_, j) => ({
			x0: 30 + rr(j) * 380,
			y0: 30 + rr(j + 5) * 200,
			vx: (rr(j + 9) - 0.5) * 2.4,
			vy: (rr(j + 13) - 0.5) * 1.2,
			radius: 30 + Math.floor(rr(j + 17) * 40),
			ax: 30 * rr(j + 21),
			ay: 25 * rr(j + 25),
		}));
		return {
			worldIndex: i % 3,
			options: {
				kind,
				frameCount: kind === "long" ? longFrameCount : frameCount,
				seed: 100 + i,
				foregrounds,
				extra: kind === "zoom" ? { zoom: 1.6 } : {},
			},
		};
	});
}

describe("seed sweep: 9 sequences x 4 pins", () => {
	test("the worst corner is under 1.2 px and no solved frame is over 1 px", () => {
		let worst = 0;
		let over1px = 0;
		let rows = 0;
		let solved = 0;
		for (const { options, worldIndex } of sweepCases({ frameCount: SWEEP_FRAMES, longFrameCount: SWEEP_FRAMES })) {
			const world = getWorld({ key: `sweep${worldIndex}`, seed: worldIndex * 13 + 14 });
			const analysis = analyse({ world, options });
			const pins: PinSpec[] = [
				{ f0: 0, pin: { x: 240, y: 135 } },
				{ f0: 0, pin: { x: 150, y: 190 } },
				{ f0: Math.floor(options.frameCount / 2), pin: { x: 320, y: 100 } },
				{ f0: Math.floor(options.frameCount / 3), pin: { x: 200, y: 80 } },
			];
			const result = evaluatePins({ analysis, pins, solve: (spec) => solveScene({ analysis, spec }) });
			worst = Math.max(worst, result.cornerMax);
			over1px += result.over1px;
			rows += result.rows;
			solved += result.solved;
		}
		report({
			label: `sweep (${SWEEP_FRAMES} frames x 9 x 4 pins)`,
			values: { rows, solved, "worst corner": worst, "over 1 px": over1px },
		});
		expect(rows).toBeGreaterThan(1000);
		expect(solved / rows).toBeGreaterThan(0.99);
		expect(worst).toBeLessThanOrEqual(1.2);
		expect(over1px).toBe(0);
	});
});

describe("a 30 second clip (900 frames, zoom + rotation + shake + a moving object)", () => {
	test("the last 30 frames sit within 0.8 px of the truth", () => {
		const options: SequenceOptions = { kind: "long", frameCount: 900, seed: 5, foregrounds: FG_LONG };
		const analysis = analyse({ world: mainWorld(), options });
		const worst = evaluatePins({
			analysis,
			pins: standardPins({ frameCount: 900 }),
			solve: (spec) => solveScene({ analysis, spec }),
		});
		report({
			label: "30 s (900 frames)",
			values: {
				rows: worst.rows,
				drift: worst.drift,
				"corner max": worst.cornerMax,
				"scale %": worst.scaleMaxPct,
				"rot deg": worst.rotMaxDeg,
				"track bytes": analysis.tracks.xy.byteLength + analysis.tracks.liveIds.byteLength,
			},
		});
		expect(worst.rows).toBeGreaterThan(1000);
		expect(worst.drift).toBeLessThanOrEqual(0.8);
		expect(worst.cornerMax).toBeLessThanOrEqual(0.8);
		expect(worst.scaleMaxPct).toBeLessThanOrEqual(0.3);
		expect(worst.rotMaxDeg).toBeLessThanOrEqual(0.25);
		// 900 frames of tracks fit in a few megabytes
		const bytes = analysis.tracks.xy.byteLength + analysis.tracks.liveIds.byteLength;
		expect(bytes).toBeLessThan(2.5e6);
	});
});
