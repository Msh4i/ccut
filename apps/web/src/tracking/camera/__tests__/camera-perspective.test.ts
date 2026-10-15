/**
 * A camera that pans over a flat distant scene moves the picture by a
 * homography, not a similarity (plan table M3). The solver must show that:
 * the similarity drifts at the box corners, the homography does not, and the
 * residual gate that decides whether to compute H opens. Which model to use is
 * decided by how far the similarity is from the renderer's best
 * `R(theta) * diag(sx, sy)` fit of H (2 px@480); the fit itself is slice T3, so
 * the tests carry their own copy of it (see `compareModelsOnBox`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { perspectiveSuspected } from "../classify";
import { solvePin } from "../solve-pin";
import {
	analyseHomography,
	compareModelsOnBox,
	getWorld,
	releaseCaches,
	report,
} from "./camera-fixtures";

afterAll(releaseCaches);

const FRAMES = 240;

describe("a pan of 10 degrees at 60 degrees field of view (box 100 x 50)", () => {
	const world = () => getWorld({ key: "main", seed: 1 });
	const run = () =>
		analyseHomography({
			world: world(),
			hfovDeg: 60,
			yawMaxDeg: 10,
			pitchMaxDeg: 3,
			frameCount: FRAMES,
		});
	let cache: ReturnType<typeof run> | null = null;
	const analysis = () => (cache ??= run());

	function compare({ x, y }: { x: number; y: number }) {
		const { tracks, truth } = analysis();
		const result = compareModelsOnBox({
			similarity: solvePin({ tracks, f0: 0, model: "S", mode: "scene" }),
			homography: solvePin({ tracks, f0: 0, model: "H", mode: "scene" }),
			pin: { x, y },
			truthMapAt: ({ t, x: px, y: py }) => truth.truthPoint({ t, x: px, y: py }),
		});
		report({
			label: `perspective yaw 10, pin (${x},${y})`,
			values: {
				frames: result.frames,
				"S error": result.similarityError,
				"RS error": result.rotationScaleError,
				"H error": result.homographyError,
				disagreement: result.disagreement,
			},
		});
		return result;
	}

	test("at the centre: the rotation-scale fit of H is within 2.5 px, the similarity is not", () => {
		const r = compare({ x: 240, y: 135 });
		expect(r.frames).toBeGreaterThan(100);
		expect(r.rotationScaleError).toBeLessThanOrEqual(2.5);
		expect(r.similarityError).toBeGreaterThanOrEqual(3);
		// the full homography (what a renderer with four corners would draw)
		expect(r.homographyError).toBeLessThanOrEqual(1);
		// the model choice: they differ by more than 2 px, so H wins
		expect(r.disagreement).toBeGreaterThan(2);
	});

	test("near the edge the similarity is far off and the fit of H still holds", () => {
		const r = compare({ x: 410, y: 135 });
		expect(r.frames).toBeGreaterThan(60);
		// the plan measured 1.89 here; the limit of 2.5 is for the centre pin
		expect(r.rotationScaleError).toBeLessThanOrEqual(3.5);
		expect(r.similarityError).toBeGreaterThanOrEqual(10);
		expect(r.homographyError).toBeLessThanOrEqual(1);
		expect(r.disagreement).toBeGreaterThan(2);
	});

	test("the residual gate opens, so H gets computed", () => {
		const { tracks } = analysis();
		const similarity = solvePin({ tracks, f0: 0, model: "S", mode: "scene" });
		const { suspected, p90 } = perspectiveSuspected({ solution: similarity });
		report({ label: "perspective gate yaw 10", values: { p90 } });
		expect(p90).toBeGreaterThan(0.8);
		expect(suspected).toBe(true);
	});

	test("it never loses the scene while it pans", () => {
		const { tracks } = analysis();
		expect(tracks.cuts).toEqual([]);
		for (const model of ["S", "H"] as const) {
			const solution = solvePin({ tracks, f0: 0, model, mode: "scene" });
			expect(solution.ok.every((v) => v === 1)).toBe(true);
		}
	});
});
