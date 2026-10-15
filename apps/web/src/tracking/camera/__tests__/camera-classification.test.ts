/**
 * A pin can sit on the background or on something that moves on its own. The
 * classifier must find the movers (12 of 12 in the measurement) without
 * raising the alarm on the background (3 of 71). In object mode the solution
 * follows the mover instead of the scene.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { classifyPin } from "../classify";
import { mapPoint, solvePin } from "../solve-pin";
import {
	analyse,
	evaluateSimilarity,
	getWorld,
	releaseCaches,
	report,
	summarizeRows,
	type Analysis,
	type Point,
} from "./camera-fixtures";

afterAll(releaseCaches);

/** 60 frames: 4 of 71 background pins are wrongly called objects (2-4 from 60 to 240 frames, the plan measured 3 at 240). */
const FRAMES = 60;

interface PinCase {
	analysis: Analysis;
	f0: number;
	pin: Point;
	isObject: boolean;
	radius: number;
}

let cases: PinCase[] | null = null;

/** 12 sequences with one moving disk each; one pin on the disk, up to six on the background. */
function buildCases(): PinCase[] {
	const worlds = [getWorld({ key: "main", seed: 1 }), getWorld({ key: "w14", seed: 14 })];
	const out: PinCase[] = [];
	for (let i = 0; i < 12; i++) {
		const kind = (["static", "hand", "pan", "combo"] as const)[i % 4];
		const radius = 28 + (i % 3) * 12;
		const analysis = analyse({
			world: worlds[i % 2],
			options: {
				kind,
				frameCount: FRAMES,
				seed: 300 + i,
				foregrounds: [
					{
						x0: 100 + 30 * (i % 4),
						y0: 90 + 10 * (i % 3),
						vx: 0.7 + 0.15 * (i % 3),
						vy: 0.3,
						ax: 30,
						ay: 20,
						radius,
					},
				],
			},
		});
		const disk0 = analysis.truth.foregroundTruth[0][0];
		out.push({ analysis, f0: 0, pin: { x: disk0.x, y: disk0.y }, isObject: true, radius });
		const disk30 = analysis.truth.foregroundTruth[30][0];
		const candidates: [number, Point][] = [
			[0, { x: 380, y: 200 }],
			[0, { x: 60, y: 220 }],
			[30, { x: disk30.x + 60, y: disk30.y + 10 }],
			[0, { x: 240, y: 135 }],
			[15, { x: 300, y: 60 }],
			[15, { x: 150, y: 210 }],
		];
		for (const [f0, pin] of candidates) {
			const disk = analysis.truth.foregroundTruth[f0][0];
			if (Math.hypot(pin.x - disk.x, pin.y - disk.y) < radius + 8) continue;
			if (pin.x < 20 || pin.x > 460 || pin.y < 20 || pin.y > 250) continue;
			out.push({ analysis, f0, pin, isObject: false, radius });
		}
	}
	return out;
}

const allCases = () => (cases ??= buildCases());

function classify(c: PinCase) {
	const solution = solvePin({ tracks: c.analysis.tracks, f0: c.f0, model: "S", mode: "scene" });
	return classifyPin({ tracks: c.analysis.tracks, solution, pin: c.pin });
}

describe("classifyPin on moving disks (12 object pins, background pins)", () => {
	test("every pin on a moving object is found, almost no background pin is", () => {
		const objects = allCases().filter((c) => c.isObject);
		const background = allCases().filter((c) => !c.isObject);
		expect(objects.length).toBe(12);
		expect(background.length).toBeGreaterThan(55);
		const found = objects.filter((c) => classify(c).isObject).length;
		const falseAlarms = background.filter((c) => classify(c).isObject).length;
		report({
			label: `classification (${FRAMES} frames)`,
			values: { "object pins": objects.length, found, "background pins": background.length, "false alarms": falseAlarms },
		});
		expect(found).toBe(12);
		expect(falseAlarms / background.length).toBeLessThanOrEqual(0.06);
	});

	test("the object speed it reports is in the right range", () => {
		for (const c of allCases().filter((x) => x.isObject)) {
			const r = classify(c);
			// disks move 0.7-1.0 px/frame plus a sway; the pin is also riding a scene
			expect(r.velocity).toBeGreaterThan(0.1);
			expect(r.n).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("object mode follows the mover", () => {
	test("a pin on a disk of radius 40 or more stays on it within 2 px", () => {
		const big = allCases().filter((c) => c.isObject && c.radius >= 40);
		expect(big.length).toBeGreaterThanOrEqual(6);
		for (const c of big) {
			const solution = solvePin({
				tracks: c.analysis.tracks,
				f0: 0,
				model: "S",
				mode: "object",
				pin: c.pin,
			});
			const disk0 = c.analysis.truth.foregroundTruth[0][0];
			// ground truth for the disk is a pure shift of its centre
			let worst = 0;
			let solved = 0;
			for (let t = 0; t < FRAMES; t++) {
				if (!solution.ok[t]) continue;
				const d = c.analysis.truth.foregroundTruth[t][0];
				if (d.x < 0 || d.x > 480 || d.y < 0 || d.y > 270) continue;
				const got = mapPoint({ solution, t, x: c.pin.x, y: c.pin.y });
				worst = Math.max(worst, Math.hypot(got.x - c.pin.x - (d.x - disk0.x), got.y - c.pin.y - (d.y - disk0.y)));
				solved++;
			}
			report({ label: `object mode r=${c.radius}`, values: { solved, "worst px": worst } });
			expect(solved).toBeGreaterThan(40);
			expect(worst).toBeLessThanOrEqual(2);
		}
	});

	test("scene mode on the same pin gives the camera motion, not the disk's", () => {
		const c = allCases().find((x) => x.isObject && x.radius >= 40);
		if (!c) throw new Error("no object case");
		const solution = solvePin({ tracks: c.analysis.tracks, f0: 0, model: "S", mode: "scene" });
		const rows = evaluateSimilarity({
			solution,
			truth: c.analysis.truth,
			pin: c.pin,
		});
		// the reference here is the camera path, and the scene solution matches it
		expect(summarizeRows({ rows }).cornerMax).toBeLessThan(1);
	});
});
