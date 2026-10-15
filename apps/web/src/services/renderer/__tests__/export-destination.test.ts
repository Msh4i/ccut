import { describe, expect, spyOn, test } from "bun:test";
import { BufferTarget } from "mediabunny";
import type { ExportOptions } from "@/export";
import { createFileErrorFor } from "@/export/errors";
import { estimateExportBytes } from "@/export/memory-limit";
import type { ExportSink, openExportSink } from "@/export/sink";
import type { SceneTracks } from "@/timeline";
import { EXPORT_CACHE_BUDGET_BYTES, RendererManager } from "@/core/managers/renderer-manager";
import { videoCache } from "@/services/video-cache/service";

// RendererManager.exportProject and the destination: the save dialog (openSink)
// comes before any work, a cancelled dialog is a cancel, and once a destination
// is open every way out that is not a success aborts it (no file left behind).

const EMPTY_TRACKS: SceneTracks = {
	overlay: [],
	main: { id: "main", name: "Main", type: "video", elements: [], muted: false, hidden: false },
	audio: [],
};

function managerFor({ duration = 120_000 }: { duration?: number } = {}) {
	// Object.create returns any: the fake only has what exportProject reads.
	const editor = Object.assign(Object.create(null), {
		scenes: { getActiveScene: () => ({ tracks: EMPTY_TRACKS }) },
		media: { getAssets: () => [] },
		project: {
			getActive: () => ({
				metadata: { name: "Holiday" },
				settings: {
					fps: { numerator: 30, denominator: 1 },
					canvasSize: { width: 1920, height: 1080 },
					background: { type: "color", color: "#000000" },
				},
			}),
		},
		timeline: { getTotalDuration: () => duration },
	});
	return new RendererManager(editor);
}

function createSpySink() {
	const events: string[] = [];
	const sink: ExportSink = {
		target: new BufferTarget(),
		fastStart: "in-memory",
		commit: async () => {
			events.push("commit");
			return { kind: "buffer", buffer: new ArrayBuffer(1), bytes: 1 };
		},
		abort: async () => {
			events.push("abort");
		},
	};
	return { sink, events };
}

function openerFor({ result }: { result: () => Promise<ExportSink | null> }) {
	const calls: Parameters<typeof openExportSink>[0][] = [];
	const openSink: typeof openExportSink = async (args) => {
		calls.push(args);
		return result();
	};
	return { openSink, calls };
}

const options: ExportOptions = { format: "mp4", quality: "high", includeAudio: false };

describe("RendererManager.exportProject, destination first", () => {
	test("the save dialog gets the project name and the size estimate, before fonts or anything else", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const order: string[] = [];
		const { sink, events } = createSpySink();
		const { openSink, calls } = openerFor({
			result: async () => {
				order.push("dialog");
				return sink;
			},
		});
		await managerFor().exportProject({ options, openSink, bridge: null, prepare: async () => order.push("fonts") });

		expect(order).toEqual(["dialog", "fonts"]);
		expect(calls).toEqual([
			{
				bridge: null,
				format: "mp4",
				suggestedName: "Holiday",
				estimatedBytes: estimateExportBytes({ format: "mp4", quality: "high", width: 1920, height: 1080, durationSeconds: 1, includeAudio: false }),
			},
		]);
		// Past here this runtime has no OffscreenCanvas: the export fails, and the destination is aborted.
		expect(events).toEqual(["abort"]);
		consoleError.mockRestore();
	});

	test("a cancelled save dialog is a cancel: no error, nothing else runs", async () => {
		let prepared = false;
		const { openSink } = openerFor({ result: async () => null });
		const result = await managerFor().exportProject({
			options,
			openSink,
			bridge: null,
			prepare: async () => {
				prepared = true;
			},
		});
		expect(result).toEqual({ success: false, cancelled: true });
		expect(prepared).toBe(false);
	});

	test("an empty project never opens the dialog", async () => {
		const { openSink, calls } = openerFor({ result: async () => createSpySink().sink });
		const result = await managerFor({ duration: 0 }).exportProject({ options, openSink, bridge: null });
		expect(result).toEqual({ success: false, error: "Project is empty" });
		expect(calls).toEqual([]);
	});

	test("a destination that cannot be opened (busy) is the error the user sees", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const busy = createFileErrorFor({ code: "EXPORT_BUSY", detail: "busy" });
		const { openSink } = openerFor({
			result: async () => {
				throw busy;
			},
		});
		const result = await managerFor().exportProject({ options, openSink, bridge: null });
		expect(result).toEqual({ success: false, error: busy.message });
		consoleError.mockRestore();
	});

	test("cancelled while the dialog was open: the chosen destination is aborted at once", async () => {
		const controller = new AbortController();
		const { sink, events } = createSpySink();
		const { openSink } = openerFor({
			result: async () => {
				controller.abort();
				return sink;
			},
		});
		const result = await managerFor().exportProject({ options, openSink, bridge: null, signal: controller.signal });
		expect(result).toEqual({ success: false, cancelled: true });
		expect(events).toEqual(["abort"]);
	});

	test("a failure in the work after the dialog (fonts) aborts the destination, and is reported", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const { sink, events } = createSpySink();
		const { openSink } = openerFor({ result: async () => sink });
		const result = await managerFor().exportProject({
			options,
			openSink,
			bridge: null,
			prepare: async () => {
				throw new Error("fonts broke");
			},
		});
		expect(result).toEqual({ success: false, error: "fonts broke" });
		expect(events).toEqual(["abort"]);
		consoleError.mockRestore();
	});
});

describe("RendererManager.exportProject and the playback cache", () => {
	test("the cache is held small once the destination is open and let go however the export ends", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const events: string[] = [];
		let released = 0;
		const hold = spyOn(videoCache, "holdBudgetAtMost").mockImplementation(({ capBytes }) => {
			events.push(`hold:${capBytes}`);
			return () => {
				released += 1;
				events.push("release");
			};
		});
		try {
			const { sink } = createSpySink();
			const abort = sink.abort;
			sink.abort = async () => {
				events.push("abort");
				await abort();
			};
			await managerFor().exportProject({ options, openSink: openerFor({ result: async () => sink }).openSink, bridge: null });
			// A cancelled save dialog never gets this far: nothing is held.
			const cancelled = await managerFor().exportProject({ options, openSink: openerFor({ result: async () => null }).openSink, bridge: null });
			expect(cancelled).toEqual({ success: false, cancelled: true });
		} finally {
			hold.mockRestore();
			consoleError.mockRestore();
		}
		expect(events).toEqual([`hold:${EXPORT_CACHE_BUDGET_BYTES}`, "release", "abort"]);
		expect(released).toBe(1);
	});
});

