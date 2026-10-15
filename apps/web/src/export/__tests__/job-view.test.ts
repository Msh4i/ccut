import { describe, expect, test } from "bun:test";
import type { ExportState } from "../index";
import { IDLE_EXPORT_STATE, exportJobView, formatEta, formatFileSize, revealOutcomeMessage, unreadableAudioQuestion } from "../job-view";

const running = (overrides: Partial<ExportState>): ExportState => ({
	...IDLE_EXPORT_STATE,
	isExporting: true,
	phase: "encoding",
	...overrides,
});

describe("exportJobView", () => {
	test("idle, or after a cancel: the settings, closable", () => {
		expect(exportJobView({ state: IDLE_EXPORT_STATE })).toMatchObject({ view: "settings", canClose: true });
		expect(exportJobView({ state: { ...IDLE_EXPORT_STATE, result: { success: false, cancelled: true } } })).toMatchObject({
			view: "settings",
			canClose: true,
		});
	});

	test("preparing: no bar value (indeterminate), cannot be closed", () => {
		expect(exportJobView({ state: running({ phase: "preparing" }) })).toEqual({
			view: "running",
			canClose: false,
			status: "Preparing fonts, stickers and audio…",
			announce: "Preparing fonts, stickers and audio…",
			percent: null,
			eta: null,
			cancel: { label: "Cancel", disabled: false },
		});
	});

	test("before the first phase the save dialog is open: it says so instead of claiming to prepare fonts", () => {
		expect(exportJobView({ state: running({ phase: null }) })).toEqual({
			view: "running",
			canClose: false,
			status: "Waiting for the save location…",
			announce: "Waiting for the save location…",
			percent: null,
			eta: null,
			cancel: { label: "Cancel", disabled: false },
		});
	});

	test("encoding: frame counter, percent of frames, time left once known; only the phase is announced", () => {
		expect(exportJobView({ state: running({ framesDone: 45, frameCount: 180, etaSeconds: null }) })).toEqual({
			view: "running",
			canClose: false,
			status: "Encoding frame 45 of 180",
			announce: "Encoding",
			percent: 25,
			eta: "Estimating time left…",
			cancel: { label: "Cancel", disabled: false },
		});
		expect(exportJobView({ state: running({ framesDone: 90, frameCount: 180, etaSeconds: 130 }) })).toMatchObject({
			announce: "Encoding",
			percent: 50,
			eta: "About 3 min left",
		});
	});

	test("finalizing: indeterminate, cannot be closed, and there is nothing to cancel (the file is being saved)", () => {
		expect(exportJobView({ state: running({ phase: "finalizing", framesDone: 180, frameCount: 180 }) })).toEqual({
			view: "running",
			canClose: false,
			status: "Finishing the file…",
			announce: "Finishing the file…",
			percent: null,
			eta: null,
			cancel: null,
		});
	});

	test("Cancel was pressed: the button says so and is disabled, in every phase before the file is finished", () => {
		const cancelling = { cancelling: true };
		expect(exportJobView({ state: running({ ...cancelling, phase: "preparing" }) })).toEqual({
			view: "running",
			canClose: false,
			status: "Stopping the export…",
			announce: "Cancelling",
			percent: null,
			eta: null,
			cancel: { label: "Cancelling…", disabled: true },
		});
		expect(exportJobView({ state: running({ ...cancelling, phase: null }) })).toMatchObject({ cancel: { label: "Cancelling…", disabled: true } });
		expect(exportJobView({ state: running({ ...cancelling, framesDone: 90, frameCount: 180, etaSeconds: 30 }) })).toEqual({
			view: "running",
			canClose: false,
			status: "Stopping the export…",
			announce: "Cancelling",
			percent: 50,
			eta: null,
			cancel: { label: "Cancelling…", disabled: true },
		});
	});

	test("Cancel pressed too late (the file is already being finished): no cancel control, the file is saved as the view says", () => {
		expect(exportJobView({ state: running({ cancelling: true, phase: "finalizing", framesDone: 180, frameCount: 180 }) })).toMatchObject({
			status: "Finishing the file…",
			cancel: null,
		});
	});

	test("an unreadable-audio question blocks closing and shows the question", () => {
		const view = exportJobView({
			state: running({ phase: "preparing", audioQuestion: { skipped: [{ name: "a.mp3", reason: "x" }], allUnreadable: false } }),
		});
		expect(view).toMatchObject({ view: "question", canClose: false });
	});

	test("done on disk: the name and the size, and it can be shown in its folder", () => {
		const state: ExportState = {
			...IDLE_EXPORT_STATE,
			result: { success: true, file: { displayName: "clip.mp4", bytes: 61_234_567, revealToken: "t" } },
		};
		expect(exportJobView({ state })).toEqual({ view: "done", canClose: true, message: "Saved clip.mp4 (61.2 MB)", canReveal: true });
	});

	test("done in a browser: downloaded, nothing to reveal", () => {
		const state: ExportState = { ...IDLE_EXPORT_STATE, result: { success: true, buffer: new ArrayBuffer(2048) } };
		expect(exportJobView({ state })).toEqual({ view: "done", canClose: true, message: "Downloaded (2.0 KB)", canReveal: false });
	});

	test("failed: the error text, closable", () => {
		const state: ExportState = { ...IDLE_EXPORT_STATE, result: { success: false, error: "The disk is full. Details: DISK_FULL" } };
		expect(exportJobView({ state })).toEqual({ view: "error", canClose: true, error: "The disk is full. Details: DISK_FULL" });
		expect(exportJobView({ state: { ...IDLE_EXPORT_STATE, result: { success: false } } })).toMatchObject({ error: "Unknown error occurred" });
	});
});

describe("revealOutcomeMessage", () => {
	test("nothing to say when the folder opened; otherwise a short message that names the file", () => {
		expect(revealOutcomeMessage({ revealed: true, displayName: "clip.mp4" })).toBeNull();
		const message = revealOutcomeMessage({ revealed: false, displayName: "clip.mp4" });
		expect(message).toContain('"clip.mp4"');
		expect(message).toMatch(/folder/i);
	});
});

describe("formatters", () => {
	test("formatEta rounds up and never shows 0", () => {
		expect(formatEta({ seconds: 0 })).toBe("Almost done");
		expect(formatEta({ seconds: 1 })).toBe("About 5 s left");
		expect(formatEta({ seconds: 42 })).toBe("About 45 s left");
		expect(formatEta({ seconds: 59 })).toBe("About 1 min left");
		expect(formatEta({ seconds: 61 })).toBe("About 2 min left");
		expect(formatEta({ seconds: 3600 })).toBe("About 1 h left");
		expect(formatEta({ seconds: 3661 })).toBe("About 1 h 2 min left");
	});

	test("formatFileSize in decimal units, one decimal", () => {
		expect(formatFileSize({ bytes: 500 })).toBe("500 B");
		expect(formatFileSize({ bytes: 1500 })).toBe("1.5 KB");
		expect(formatFileSize({ bytes: 61_234_567 })).toBe("61.2 MB");
		expect(formatFileSize({ bytes: 4_200_000_000 })).toBe("4.2 GB");
	});

	test("unreadableAudioQuestion names the clips, or says all audio is unreadable", () => {
		expect(unreadableAudioQuestion({ skipped: [{ name: "a.mp3", reason: "x" }], allUnreadable: false })).toBe(
			'The audio of "a.mp3" could not be read. It will be silent in the exported file.',
		);
		expect(
			unreadableAudioQuestion({
				skipped: [
					{ name: "a.mp3", reason: "x" },
					{ name: "b.wav", reason: "y" },
					{ name: "a.mp3", reason: "z" },
				],
				allUnreadable: false,
			}),
		).toBe('The audio of 2 clips ("a.mp3", "b.wav") could not be read. They will be silent in the exported file.');
		expect(unreadableAudioQuestion({ skipped: [], allUnreadable: true })).toBe(
			"None of the project's audio could be read. The exported file will have no sound.",
		);
	});
});
