import { describe, expect, test } from "bun:test";
import {
	RenderErrorReporter,
	drawFailure,
	drawPreviewFrame,
	renderErrorMessage,
	renderErrorNoticeText,
	shouldRetryWithoutEffects,
} from "../render-gate";

// "The blur effect does not work, the clip just freezes": a frame whose effect
// failed in the compositor was never drawn, the error only went to the console
// (on every frame while playing) and the canvas kept its last picture. Now the
// preview draws the same frame again without effects, and tells the user once.

describe("drawPreviewFrame with an effect that fails", () => {
	test("a draw that succeeds is not retried and keeps its effects", async () => {
		const calls: boolean[] = [];
		const result = await drawPreviewFrame({
			draw: async ({ effects }) => {
				calls.push(effects);
				return 9;
			},
			serialNow: () => 5,
		});
		expect(calls).toEqual([true]);
		expect(result).toEqual({ serial: 9, error: null, effectsDropped: false });
	});

	test("a failed draw is drawn again once without effects; the first error is reported", async () => {
		const failure = new Error("Failed to apply effects: At least one effect pass is required");
		const calls: boolean[] = [];
		const result = await drawPreviewFrame({
			draw: async ({ effects }) => {
				calls.push(effects);
				if (effects) throw failure;
				return 12;
			},
			serialNow: () => 5,
		});
		expect(calls).toEqual([true, false]);
		expect(result).toEqual({ serial: 12, error: failure, effectsDropped: true });
	});

	test("no second draw when the caller says no (an export started meanwhile)", async () => {
		const failure = new Error("effect failed");
		const calls: boolean[] = [];
		const result = await drawPreviewFrame({
			draw: async ({ effects }) => {
				calls.push(effects);
				throw failure;
			},
			serialNow: () => 7,
			mayRetry: () => false,
		});
		expect(calls).toEqual([true]);
		expect(result).toEqual({ serial: 7, error: failure, effectsDropped: false });
	});

	test("when the frame fails without effects too, nothing was drawn and that error is reported", async () => {
		const withEffects = new Error("effect failed");
		const withoutEffects = new Error("Image load failed");
		const calls: boolean[] = [];
		const result = await drawPreviewFrame({
			draw: async ({ effects }) => {
				calls.push(effects);
				throw effects ? withEffects : withoutEffects;
			},
			serialNow: () => 7,
		});
		expect(calls).toEqual([true, false]);
		expect(result).toEqual({ serial: 7, error: withoutEffects, effectsDropped: false });
	});

	test("the retry never rejects either, also when the draw throws synchronously or with null", async () => {
		const sync = await drawPreviewFrame({
			draw: () => {
				throw new Error("sync");
			},
			serialNow: () => 3,
		});
		expect(sync.serial).toBe(3);
		expect(sync.effectsDropped).toBe(false);

		const nulls = await drawPreviewFrame({
			draw: () => Promise.reject(null),
			serialNow: () => 3,
		});
		expect(nulls.error).not.toBeNull();
		expect(nulls.effectsDropped).toBe(false);

		const nullThenDrawn = await drawPreviewFrame({
			draw: ({ effects }) => (effects ? Promise.reject(null) : Promise.resolve(4)),
			serialNow: () => 3,
		});
		expect(nullThenDrawn.error).not.toBeNull();
		expect(nullThenDrawn.effectsDropped).toBe(true);
		expect(nullThenDrawn.serial).toBe(4);
	});
});

describe("shouldRetryWithoutEffects", () => {
	test("only a frame that had Effects-panel work, and never during an export", () => {
		expect(shouldRetryWithoutEffects({ isExporting: false, effectGroups: 2 })).toBe(true);
		// a lost surface on a project without effects: no "an effect could not be drawn"
		expect(shouldRetryWithoutEffects({ isExporting: false, effectGroups: 0 })).toBe(false);
		expect(shouldRetryWithoutEffects({ isExporting: true, effectGroups: 2 })).toBe(false);
	});

	test("without effect work a failed draw is reported as not drawn, with the neutral notice", async () => {
		const failure = new Error("The output surface does not support the required texture format");
		const calls: boolean[] = [];
		const result = await drawPreviewFrame({
			draw: async ({ effects }) => {
				calls.push(effects);
				throw failure;
			},
			serialNow: () => 3,
			mayRetry: () => shouldRetryWithoutEffects({ isExporting: false, effectGroups: 0 }),
		});
		expect(calls).toEqual([true]);
		expect(drawFailure({ ...result, gpuError: null })).toEqual({ error: failure, kind: "not-drawn" });
		expect(renderErrorNoticeText({ message: "m", kind: "not-drawn" }).title).toBe(
			"The preview could not draw this frame",
		);
	});
});

describe("renderErrorMessage", () => {
	test("short text for whatever was thrown", () => {
		expect(renderErrorMessage(new Error("Invalid frame descriptor: x"))).toBe(
			"Invalid frame descriptor: x",
		);
		// wasm-bindgen errors from Rust arrive as plain strings
		expect(renderErrorMessage("Failed to apply effects: At least one effect pass is required")).toBe(
			"Failed to apply effects: At least one effect pass is required",
		);
		expect(renderErrorMessage(null)).toBe("null");
		expect(renderErrorMessage({ reason: 1 })).toBe("[object Object]");
		expect(renderErrorMessage(new Error(""))).toBe("Error");
	});

	test("a long message is cut to 200 characters", () => {
		const message = renderErrorMessage(new Error("x".repeat(5000)));
		expect(message.length).toBe(200);
		expect(message.endsWith("...")).toBe(true);
	});
});

describe("RenderErrorReporter", () => {
	const failure = { error: new Error("effect failed"), kind: "drawn-without-effects" as const };

	test("a failure on every frame of a playback is announced once", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		const notices = [];
		for (let frame = 0; frame < 300; frame++) {
			const notice = reporter.report({ ...failure, nowMs: frame * 16 });
			if (notice) notices.push(notice);
		}
		expect(notices).toEqual([{ message: "effect failed", kind: "drawn-without-effects" }]);
	});

	test("the notice stays while the failure lasts, also for a minute, and is dismissed once draws are clean", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		let notices = 0;
		for (let frame = 0; frame < 3600; frame++) {
			if (reporter.report({ ...failure, nowMs: frame * 16.7 })) notices += 1;
		}
		expect(notices).toBe(1);
		const lastFailure = 3599 * 16.7;
		// a clean draw right after the last failure does not end it yet
		expect(reporter.clear({ nowMs: lastFailure + 17 })).toBe(false);
		// a clean draw a quiet second later does: dismiss the notice, once
		expect(reporter.clear({ nowMs: lastFailure + 1000 })).toBe(true);
		expect(reporter.clear({ nowMs: lastFailure + 1017 })).toBe(false);
	});

	test("after it ended, the same failure is news again at once", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		expect(reporter.report({ ...failure, nowMs: 0 })).not.toBeNull();
		expect(reporter.clear({ nowMs: 2000 })).toBe(true);
		expect(reporter.report({ ...failure, nowMs: 2016 })).not.toBeNull();
	});

	test("a failure on every other frame neither flickers nor storms: one notice, one dismissal after it stops", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		let notices = 0;
		let dismissals = 0;
		for (let frame = 0; frame < 1200; frame++) {
			const nowMs = frame * 16.7;
			if (frame % 2 === 0) {
				if (reporter.clear({ nowMs })) dismissals += 1;
			} else if (reporter.report({ ...failure, nowMs })) {
				notices += 1;
			}
		}
		expect([notices, dismissals]).toEqual([1, 0]);
		expect(reporter.clear({ nowMs: 1200 * 16.7 + 1000 })).toBe(true);
	});

	test("while a failure is active another message of the same kind is not announced, another kind is", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		expect(reporter.report({ error: "x", kind: "drawn-without-effects", nowMs: 0 })).not.toBeNull();
		expect(reporter.report({ error: "y", kind: "drawn-without-effects", nowMs: 1 })).toBeNull();
		expect(reporter.report({ error: "x", kind: "not-drawn", nowMs: 2 })).toEqual({
			message: "x",
			kind: "not-drawn",
		});
		expect(reporter.report({ error: "x", kind: "gpu-error", nowMs: 3 })).toEqual({
			message: "x",
			kind: "gpu-error",
		});
		expect(reporter.report({ error: "z", kind: "gpu-error", nowMs: 4 })).toBeNull();
	});

	test("a draw that skipped the effects which failed for this scene keeps the failure active", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		reporter.report({ ...failure, nowMs: 0 });
		for (let frame = 1; frame <= 120; frame++) {
			reporter.stillFailing({ nowMs: frame * 16.7 });
		}
		expect(reporter.clear({ nowMs: 120 * 16.7 + 17 })).toBe(false);
		expect(reporter.report({ ...failure, nowMs: 120 * 16.7 + 34 })).toBeNull();
	});

	test("another project ends the failure: dismiss the notice, and its failures are news", () => {
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		expect(reporter.resetFor({ scope: "project-a" })).toBe(false);
		reporter.report({ ...failure, nowMs: 0 });
		expect(reporter.resetFor({ scope: "project-a" })).toBe(false);
		expect(reporter.resetFor({ scope: "project-b" })).toBe(true);
		expect(reporter.report({ ...failure, nowMs: 10 })).not.toBeNull();
		expect(reporter.resetFor({ scope: "project-b" })).toBe(false);
		expect(reporter.clear({ nowMs: 5000 })).toBe(true);
		// nothing active: another project needs no dismissal
		expect(reporter.resetFor({ scope: "project-c" })).toBe(false);
	});
});
