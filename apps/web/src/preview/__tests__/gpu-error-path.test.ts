import { describe, expect, test } from "bun:test";
import {
	GpuErrorWatcher,
	RenderErrorReporter,
	drawFailure,
	renderErrorNoticeText,
} from "../render-gate";

// GPU errors no longer panic: the device records them (count + last message,
// getGpuErrorStats). On the WebGL2 fallback they arrive during the draw and
// the draw fails with "GPU error: ..." (the retry path). On WebGPU they arrive
// later as a browser event, after a draw that looked fine: the preview
// compares the count after each draw and reports new ones through the same
// RenderErrorReporter, once.

describe("GpuErrorWatcher", () => {
	test("reports the errors recorded since the last check, once", () => {
		const watcher = new GpuErrorWatcher();
		expect(watcher.check({ count: 0, lastMessage: null })).toBeNull();
		const first = watcher.check({ count: 1, lastMessage: "Validation Error: bad bind group" });
		expect(first?.message).toBe("GPU error: Validation Error: bad bind group");
		expect(watcher.check({ count: 1, lastMessage: "Validation Error: bad bind group" })).toBeNull();
		const more = watcher.check({ count: 4, lastMessage: "Out of memory" });
		expect(more?.message).toBe("GPU error: Out of memory (and 2 more)");
	});

	test("no stats (a wasm build without the export) is nothing to report", () => {
		const watcher = new GpuErrorWatcher();
		expect(watcher.check(null)).toBeNull();
		expect(watcher.check({ count: 2, lastMessage: "x" })?.message).toBe("GPU error: x (and 1 more)");
	});

	test("a count that went down (a new GPU device) starts over without a report", () => {
		const watcher = new GpuErrorWatcher();
		watcher.check({ count: 5, lastMessage: "x" });
		expect(watcher.check({ count: 0, lastMessage: null })).toBeNull();
		expect(watcher.check({ count: 1, lastMessage: "y" })?.message).toBe("GPU error: y");
	});
});

describe("drawFailure", () => {
	const gpuError = new Error("GPU error: x");

	test("a clean draw without new GPU errors is no failure", () => {
		expect(drawFailure({ error: null, effectsDropped: false, gpuError: null })).toBeNull();
	});

	test("a failed draw is reported as such, a GPU error seen with it is already in it", () => {
		const error = new Error("GPU error: x");
		expect(drawFailure({ error, effectsDropped: true, gpuError })).toEqual({
			error,
			kind: "drawn-without-effects",
		});
		expect(drawFailure({ error, effectsDropped: false, gpuError })).toEqual({
			error,
			kind: "not-drawn",
		});
	});

	test("a draw that looked fine but the GPU reported an error since", () => {
		expect(drawFailure({ error: null, effectsDropped: false, gpuError })).toEqual({
			error: gpuError,
			kind: "gpu-error",
		});
	});
});

describe("renderErrorNoticeText", () => {
	test("each kind has its own toast and console line, and every toast stays until dismissed", () => {
		expect(renderErrorNoticeText({ message: "m", kind: "drawn-without-effects" })).toEqual({
			level: "warning",
			title: "An effect could not be drawn",
			description:
				"The preview hides the effects of this scene until the problem is fixed, and exporting this project will fail. m",
			consoleLabel: "Preview render failed, drawn without effects:",
			duration: Number.POSITIVE_INFINITY,
		});
		expect(renderErrorNoticeText({ message: "m", kind: "not-drawn" })).toEqual({
			level: "error",
			title: "The preview could not draw this frame",
			description: "m",
			consoleLabel: "Preview render failed:",
			duration: Number.POSITIVE_INFINITY,
		});
		expect(renderErrorNoticeText({ message: "GPU error: m", kind: "gpu-error" })).toEqual({
			level: "warning",
			title: "The GPU reported an error",
			description: "The preview may show this frame wrong until the problem is fixed. GPU error: m",
			consoleLabel: "Preview: the GPU reported an error:",
			duration: Number.POSITIVE_INFINITY,
		});
	});
});

describe("a GPU error on every frame of a playback", () => {
	test("is announced once through the RenderErrorReporter", () => {
		const watcher = new GpuErrorWatcher();
		const reporter = new RenderErrorReporter({ quietMs: 1000 });
		let notices = 0;
		for (let frame = 0; frame < 300; frame++) {
			// one more uncaptured error per frame (a broken pass on every frame)
			const gpuError = watcher.check({ count: frame + 1, lastMessage: "Validation Error: bad bind group" });
			const failure = drawFailure({ error: null, effectsDropped: false, gpuError });
			if (failure === null) {
				reporter.clear({ nowMs: frame * 16.7 });
				continue;
			}
			if (reporter.report({ ...failure, nowMs: frame * 16.7 })) notices += 1;
		}
		expect(notices).toBe(1);
	});
});
