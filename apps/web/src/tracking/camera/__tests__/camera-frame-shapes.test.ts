/**
 * Frames are not always 16:9. A vertical phone clip analyses as 480 x 853, a
 * 4:3 clip as 480 x 360: the features must still cover the whole picture, the
 * first frame must already have its full set (pins are most often placed at
 * the start of a clip, and right after every cut), and a pin anywhere must be
 * as exact as in the wide frame.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { solvePin } from "../solve-pin";
import { resolveTrackerOptions } from "../tracker";
import {
	analyse,
	evaluateSimilarity,
	getWorld,
	releaseCaches,
	report,
	summarizeRows,
	type Analysis,
} from "./camera-fixtures";

afterAll(releaseCaches);

const FRAMES = 30;

const SHAPES = [
	{ name: "wide 480 x 270", w: 480, h: 270 },
	{ name: "4:3 480 x 360", w: 480, h: 360 },
	{ name: "vertical 480 x 853", w: 480, h: 853 },
] as const;

const cache = new Map<string, Analysis>();

function analysisOf({ w, h }: { w: number; h: number }): Analysis {
	const key = `${w}x${h}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const made = analyse({
		world: getWorld({ key: "main", seed: 1 }),
		options: { kind: "hand", frameCount: FRAMES, width: w, height: h, seed: 5 },
	});
	cache.set(key, made);
	return made;
}

function liveAt({ analysis, f }: { analysis: Analysis; f: number }): number {
	return analysis.tracks.liveOffsets[f + 1] - analysis.tracks.liveOffsets[f];
}

/** Share of all live samples in the top, middle and bottom third of the frame. */
function thirds({ analysis }: { analysis: Analysis }): number[] {
	const t = analysis.tracks;
	const bands = [0, 0, 0];
	let total = 0;
	for (let f = 0; f < t.frameCount; f++) {
		for (let q = t.liveOffsets[f]; q < t.liveOffsets[f + 1]; q++) {
			const id = t.liveIds[q];
			const y = t.xy[t.trackOffset[id] + 2 * (f - t.trackStart[id]) + 1];
			bands[Math.min(2, Math.floor((3 * y) / t.h))]++;
			total++;
		}
	}
	return bands.map((b) => b / total);
}

for (const { name, w, h } of SHAPES) {
	describe(name, () => {
		test("features cover the whole picture: every third of the height holds at least 15 percent", () => {
			const share = thirds({ analysis: analysisOf({ w, h }) });
			report({ label: `${name} thirds`, values: { top: share[0], middle: share[1], bottom: share[2] } });
			for (const s of share) expect(s).toBeGreaterThanOrEqual(0.15);
		});

		test("the first frames already have nearly the full set, with no dip while the seeds settle", () => {
			const analysis = analysisOf({ w, h });
			const counts = Array.from({ length: 9 }, (_, f) => liveAt({ analysis, f }));
			report({ label: `${name} live f0..f8`, values: { counts: counts.join(",") } });
			expect(counts[0]).toBeGreaterThanOrEqual(85);
			expect(Math.min(...counts)).toBeGreaterThanOrEqual(80);
		});

		test("the first frame is about as densely seeded as a wide one: most grid cells hold a feature", () => {
			const analysis = analysisOf({ w, h });
			const cells = Math.ceil(w / 36) * Math.ceil(h / 36);
			// a 110 feature cap on a 336 cell vertical frame would leave two cells in three empty
			expect(liveAt({ analysis, f: 0 })).toBeGreaterThanOrEqual(0.7 * cells);
		});

		test("the live count stays under the cap of the frame", () => {
			const analysis = analysisOf({ w, h });
			const cap = resolveTrackerOptions({ w, h }).maxFeatures;
			for (let f = 0; f < FRAMES; f++) expect(liveAt({ analysis, f })).toBeLessThanOrEqual(cap);
		});

		test("a pin placed on the first frame anywhere in the picture is within 0.2 px", () => {
			const analysis = analysisOf({ w, h });
			const solution = solvePin({ tracks: analysis.tracks, f0: 0, model: "S", mode: "scene" });
			const worst: number[] = [];
			for (const fy of [0.15, 0.5, 0.85]) {
				const rows = evaluateSimilarity({ solution, truth: analysis.truth, pin: { x: w / 2, y: fy * h } });
				const summary = summarizeRows({ rows });
				expect(summary.rows).toBeGreaterThan(20);
				worst.push(summary.cornerMax);
			}
			report({ label: `${name} pin corner max (15/50/85 percent of the height)`, values: { worst: worst.map((v) => v.toFixed(2)).join(" ") } });
			for (const v of worst) expect(v).toBeLessThanOrEqual(0.2);
		});
	});
}
