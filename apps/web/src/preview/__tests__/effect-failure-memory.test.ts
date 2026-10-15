import { describe, expect, test } from "bun:test";
import {
	EffectFailureMemory,
	RenderErrorReporter,
	drawPreviewFrame,
	previewDrawOutcome,
} from "../render-gate";

// Once the effects of a scene (render tree) failed, the preview draws that
// scene without them until the scene changes (an edit builds a new tree):
// no doomed attempt with effects on every frame, and the notice stays up
// instead of being dismissed by the frames that drew fine without effects.

describe("EffectFailureMemory", () => {
	test("a scene whose effects failed is drawn without them until the scene changes", () => {
		const memory = new EffectFailureMemory<object>();
		const sceneA = {};
		const sceneB = {};
		expect(memory.tryEffects(sceneA)).toBe(true);
		memory.record({ scene: sceneA, effectsFailed: true });
		expect(memory.tryEffects(sceneA)).toBe(false);
		// an edit: another tree is tried with its effects
		expect(memory.tryEffects(sceneB)).toBe(true);
	});

	test("a scene that drew with its effects makes it forget the failed one", () => {
		const memory = new EffectFailureMemory<object>();
		const sceneA = {};
		const sceneB = {};
		memory.record({ scene: sceneA, effectsFailed: true });
		memory.record({ scene: sceneB, effectsFailed: false });
		expect(memory.tryEffects(sceneA)).toBe(true);
	});
});

describe("drawPreviewFrame without the effects attempt", () => {
	test("draws once, without effects", async () => {
		const calls: boolean[] = [];
		const result = await drawPreviewFrame({
			draw: async ({ effects }) => {
				calls.push(effects);
				return 4;
			},
			serialNow: () => 1,
			effectsFirst: false,
		});
		expect(calls).toEqual([false]);
		expect(result).toEqual({ serial: 4, error: null, effectsDropped: false });
	});

	test("a failure of that draw is reported as not drawn", async () => {
		const failure = new Error("Image load failed");
		const result = await drawPreviewFrame({
			draw: async () => {
				throw failure;
			},
			serialNow: () => 2,
			effectsFirst: false,
		});
		expect(result).toEqual({ serial: 2, error: failure, effectsDropped: false });
	});
});

describe("previewDrawOutcome", () => {
	const gpuError = new Error("GPU error: x");

	test("clean, still failing (effects skipped for this scene), or a failure to report", () => {
		expect(
			previewDrawOutcome({ error: null, effectsDropped: false, gpuError: null, skippedEffects: false }),
		).toEqual({ action: "clean" });
		expect(
			previewDrawOutcome({ error: null, effectsDropped: false, gpuError: null, skippedEffects: true }),
		).toEqual({ action: "still-failing" });
		const error = new Error("effect failed");
		expect(
			previewDrawOutcome({ error, effectsDropped: true, gpuError: null, skippedEffects: false }),
		).toEqual({ action: "report", error, kind: "drawn-without-effects" });
		// a new GPU error or a failed draw is reported also while effects are skipped
		expect(
			previewDrawOutcome({ error: null, effectsDropped: false, gpuError, skippedEffects: true }),
		).toEqual({ action: "report", error: gpuError, kind: "gpu-error" });
		expect(
			previewDrawOutcome({ error, effectsDropped: false, gpuError: null, skippedEffects: true }),
		).toEqual({ action: "report", error, kind: "not-drawn" });
	});
});

describe("a scene whose effect fails on every frame, played for 60 frames", () => {
	test("tries its effects once, shows one notice that stays, and an edit that fixes it dismisses it", async () => {
		const memory = new EffectFailureMemory<object>();
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		const broken = {};
		const fixed = {};
		let effectAttempts = 0;
		let notices = 0;
		let dismissals = 0;
		const drawScene = async ({ scene, nowMs }: { scene: object; nowMs: number }) => {
			const effectsFirst = memory.tryEffects(scene);
			const { error, effectsDropped } = await drawPreviewFrame({
				draw: async ({ effects }) => {
					if (effects) effectAttempts += 1;
					if (effects && scene === broken) throw new Error("effect failed");
					return 1;
				},
				serialNow: () => 1,
				effectsFirst,
			});
			memory.record({ scene, effectsFailed: effectsDropped || !effectsFirst });
			const outcome = previewDrawOutcome({
				error,
				effectsDropped,
				gpuError: null,
				skippedEffects: !effectsFirst,
			});
			if (outcome.action === "clean") {
				if (reporter.clear({ nowMs })) dismissals += 1;
			} else if (outcome.action === "still-failing") {
				reporter.stillFailing({ nowMs });
			} else if (reporter.report({ error: outcome.error, kind: outcome.kind, nowMs })) {
				notices += 1;
			}
		};
		for (let frame = 0; frame < 60; frame++) {
			await drawScene({ scene: broken, nowMs: frame * 16.7 });
		}
		expect([effectAttempts, notices, dismissals]).toEqual([1, 1, 0]);
		// the user edits the effect: a new tree, drawn with its effects; the
		// notice goes once the draws stayed clean for a second
		for (let frame = 60; frame < 180; frame++) {
			await drawScene({ scene: fixed, nowMs: frame * 16.7 });
		}
		expect(effectAttempts).toBe(1 + 120);
		expect([notices, dismissals]).toEqual([1, 1]);
	});
});
