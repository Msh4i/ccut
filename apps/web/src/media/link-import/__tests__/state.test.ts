import { describe, expect, test } from "bun:test";
import {
	INITIAL_DIALOG_STATE,
	canCancel,
	canUpdateAndRetry,
	jobPercent,
	jobStageLine,
	jobStatusLine,
	outcomeLines,
	reduceLinkImport,
	type DialogState,
} from "../state";

// The dialog's state machine: form -> (one-time notice) -> running(job view) -> finished.
// Pure, so every step and label is tested without a DOM.

const submit = (overrides = {}) => ({ type: "submit" as const, input: "https://www.youtube.com/watch?v=x", mode: "video" as const, quality: "best" as const, noticeAcknowledged: true, ...overrides });
const request = { url: "https://www.youtube.com/watch?v=x", mode: "video" as const, quality: "best" as const };

describe("reduceLinkImport", () => {
	test("submit with a valid link and the notice acknowledged: running, starting", () => {
		expect(reduceLinkImport({ state: INITIAL_DIALOG_STATE, action: submit() })).toEqual({ step: "running", request, job: { phase: "starting" }, cancelling: false, retried: false });
	});

	test("submit with a refused link: stays on the form with the code (validating step)", () => {
		expect(reduceLinkImport({ state: INITIAL_DIALOG_STATE, action: submit({ input: "https://evil.example/" }) })).toEqual({ step: "form", error: "url-refused" });
		expect(reduceLinkImport({ state: INITIAL_DIALOG_STATE, action: submit({ input: "https://www.youtube.com/playlist?list=x" }) })).toEqual({ step: "form", error: "playlist-refused" });
	});

	test("first time: the notice comes first; acknowledging it starts; Back returns to the form", () => {
		const notice = reduceLinkImport({ state: INITIAL_DIALOG_STATE, action: submit({ noticeAcknowledged: false }) });
		expect(notice).toEqual({ step: "notice", request });
		expect(reduceLinkImport({ state: notice, action: { type: "acknowledge-notice" } })).toEqual({ step: "running", request, job: { phase: "starting" }, cancelling: false, retried: false });
		expect(reduceLinkImport({ state: notice, action: { type: "back" } })).toEqual({ step: "form", error: null });
	});

	test("job views replace each other while running; cancel marks it cancelling and later views keep that", () => {
		let state: DialogState = { step: "running", request, job: { phase: "starting" }, cancelling: false, retried: false };
		state = reduceLinkImport({ state, action: { type: "job", view: { phase: "downloading", progress: null } } });
		expect(state).toEqual({ step: "running", request, job: { phase: "downloading", progress: null }, cancelling: false, retried: false });
		state = reduceLinkImport({ state, action: { type: "cancel" } });
		state = reduceLinkImport({ state, action: { type: "job", view: { phase: "downloading", progress: null } } });
		expect(state).toMatchObject({ step: "running", cancelling: true, retried: false });
	});

	test("finished from running; Back to the form from there", () => {
		const running: DialogState = { step: "running", request, job: { phase: "starting" }, cancelling: false, retried: false };
		const finished = reduceLinkImport({ state: running, action: { type: "finished", outcome: { kind: "cancelled" } } });
		expect(finished).toEqual({ step: "finished", request, outcome: { kind: "cancelled" }, retried: false });
		expect(reduceLinkImport({ state: finished, action: { type: "back" } })).toEqual({ step: "form", error: null });
	});

	test("actions that do not fit the step change nothing (a late job view after the end, a submit while running)", () => {
		const finished: DialogState = { step: "finished", request, outcome: { kind: "cancelled" }, retried: false };
		expect(reduceLinkImport({ state: finished, action: { type: "job", view: { phase: "starting" } } })).toBe(finished);
		const running: DialogState = { step: "running", request, job: { phase: "starting" }, cancelling: false, retried: false };
		expect(reduceLinkImport({ state: running, action: submit() })).toBe(running);
		expect(reduceLinkImport({ state: INITIAL_DIALOG_STATE, action: { type: "finished", outcome: { kind: "cancelled" } } })).toBe(INITIAL_DIALOG_STATE);
		expect(reduceLinkImport({ state: INITIAL_DIALOG_STATE, action: { type: "cancel" } })).toBe(INITIAL_DIALOG_STATE);
	});
});

describe("labels", () => {
	test("each job phase has its line; download progress shows percent, size, speed and time left", () => {
		expect(jobStatusLine({ job: { phase: "starting" } })).toBe("Starting…");
		expect(jobStatusLine({ job: { phase: "preparing", step: "tool-check" } })).toBe("Looking for yt-dlp…");
		expect(jobStatusLine({ job: { phase: "preparing", step: "consent" } })).toBe("Waiting for your answer in the yt-dlp download window…");
		expect(jobStatusLine({ job: { phase: "preparing", step: "tool-download" } })).toBe("Downloading and checking yt-dlp…");
		expect(jobStatusLine({ job: { phase: "downloading", progress: null } })).toBe("Downloading…");
		expect(jobStatusLine({ job: { phase: "processing", fraction: null } })).toBe("Combining video and audio…");
		expect(jobStatusLine({ job: { phase: "processing", fraction: 0.5 } })).toBe("Combining video and audio: 50%");
		expect(jobStatusLine({ job: { phase: "downloading", progress: { downloadedBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, speed: 1.5 * 1024 * 1024, eta: 75 } } })).toBe(
			"Downloading: 25% of 20 MB · 1.5 MB/s · 1:15 left",
		);
		expect(jobStatusLine({ job: { phase: "downloading", progress: { downloadedBytes: 3 * 1024 * 1024, totalBytes: null, speed: null, eta: null } } })).toBe("Downloading: 3.0 MB");
		expect(jobStatusLine({ job: { phase: "transferring", transferredBytes: 30, totalBytes: 60 } })).toBe("Copying into Ccut: 50%");
		expect(jobStatusLine({ job: { phase: "importing", fileName: "Clip.mp4" } })).toBe("Adding “Clip.mp4” to the project…");
	});

	test("percent: only where a total is known, never above 100", () => {
		expect(jobPercent({ job: { phase: "starting" } })).toBeNull();
		expect(jobPercent({ job: { phase: "downloading", progress: { downloadedBytes: 5, totalBytes: null, speed: null, eta: null } } })).toBeNull();
		expect(jobPercent({ job: { phase: "downloading", progress: { downloadedBytes: 150, totalBytes: 100, speed: null, eta: null } } })).toBe(100);
		expect(jobPercent({ job: { phase: "transferring", transferredBytes: 1, totalBytes: 3 } })).toBe(33);
		expect(jobPercent({ job: { phase: "processing", fraction: 0.426 } })).toBe(43);
		expect(jobPercent({ job: { phase: "processing", fraction: null } })).toBeNull();
	});

	test("Cancel is offered until the file is being added to the project, and not twice", () => {
		expect(canCancel({ state: { step: "running", request, job: { phase: "downloading", progress: null }, cancelling: false, retried: false } })).toBe(true);
		expect(canCancel({ state: { step: "running", request, job: { phase: "transferring", transferredBytes: 0, totalBytes: 1 }, cancelling: false, retried: false } })).toBe(true);
		expect(canCancel({ state: { step: "running", request, job: { phase: "processing", fraction: 0.5 }, cancelling: false, retried: false } })).toBe(true);
		expect(canCancel({ state: { step: "running", request, job: { phase: "importing", fileName: "a" }, cancelling: false, retried: false } })).toBe(false);
		expect(canCancel({ state: { step: "running", request, job: { phase: "starting" }, cancelling: true, retried: false } })).toBe(false);
		expect(canCancel({ state: INITIAL_DIALOG_STATE })).toBe(false);
	});
});

describe("jobStageLine: what a screen reader hears (the stage, never the progress numbers)", () => {
	const down = (downloadedBytes: number) => ({ phase: "downloading" as const, progress: { downloadedBytes, totalBytes: 1000, speed: 5, eta: 3 } });

	test("the same text for every progress tick of one stage, a different one for each stage", () => {
		const downloading = [0, 100, 999].map((n) => jobStageLine({ job: down(n), cancelling: false }));
		expect(new Set(downloading)).toEqual(new Set(["Downloading…"]));
		expect(jobStageLine({ job: { phase: "downloading", progress: null }, cancelling: false })).toBe("Downloading…");
		expect(jobStageLine({ job: { phase: "processing", fraction: 0.1 }, cancelling: false })).toBe(jobStageLine({ job: { phase: "processing", fraction: 0.9 }, cancelling: false }));
		expect(jobStageLine({ job: { phase: "transferring", transferredBytes: 1, totalBytes: 9 }, cancelling: false })).toBe(jobStageLine({ job: { phase: "transferring", transferredBytes: 8, totalBytes: 9 }, cancelling: false }));
		const stages = [
			{ phase: "starting" as const },
			{ phase: "preparing" as const, step: "tool-check" as const },
			{ phase: "preparing" as const, step: "consent" as const },
			down(1),
			{ phase: "processing" as const, fraction: null },
			{ phase: "transferring" as const, transferredBytes: 0, totalBytes: 9 },
			{ phase: "importing" as const, fileName: "a.mp4" },
		].map((job) => jobStageLine({ job, cancelling: false }));
		expect(new Set(stages).size).toBe(stages.length);
		for (const line of stages) expect(line).not.toMatch(/\d+%|\/s|left/);
	});

	test("after Cancel: 'Stopping…'", () => {
		expect(jobStageLine({ job: down(5), cancelling: true })).toBe("Stopping…");
	});
});

describe("outcomeLines: what the user is told at the end (the resolution actually obtained)", () => {
	test("video: the name and the resolution obtained", () => {
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "best", width: 640, height: 360, combined: true, combineTried: true } })).toEqual([
			"Added “Clip.mp4” (640×360).",
		]);
	});

	test("a quality was asked for and the single file is lower: said plainly; why depends on whether combining was tried", () => {
		// TikTok (and other single-file links): combining is never tried
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "1080", width: 640, height: 360, combined: false, combineTried: false } })).toEqual([
			"Added “Clip.mp4” (640×360).",
			"The best single-file version was 360p, lower than the 1080p you chose.",
		]);
		// YouTube: the separate streams could not be used, the single file was the fallback
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "1080", width: 640, height: 360, combined: false, combineTried: true } })).toEqual([
			"Added “Clip.mp4” (640×360).",
			"Ccut could not combine separate video and audio for this link, so the best single file was used: 360p, lower than the 1080p you chose.",
		]);
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "720", width: 1280, height: 720, combined: false, combineTried: false } })).toEqual(["Added “Clip.mp4” (1280×720)."]);
	});

	test("the limit is on the short side: a portrait 1080x1920 meets 1080p, a 720x1280 one is 720p", () => {
		expect(outcomeLines({ outcome: { kind: "done", fileName: "T.mp4", mode: "video", quality: "1080", width: 1080, height: 1920, combined: false, combineTried: false } })).toEqual(["Added “T.mp4” (1080×1920)."]);
		expect(outcomeLines({ outcome: { kind: "done", fileName: "T.mp4", mode: "video", quality: "1080", width: 720, height: 1280, combined: false, combineTried: false } })).toEqual([
			"Added “T.mp4” (720×1280).",
			"The best single-file version was 720p, lower than the 1080p you chose.",
		]);
	});

	test("combined from separate video and audio, still lower than asked: the video itself has no higher H.264 version", () => {
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "1080", width: 1280, height: 720, combined: true, combineTried: true } })).toEqual([
			"Added “Clip.mp4” (1280×720).",
			"The best H.264 version of this video is 720p, lower than the 1080p you chose.",
		]);
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "1080", width: 1920, height: 1080, combined: true, combineTried: true } })).toEqual(["Added “Clip.mp4” (1920×1080)."]);
	});

	test("unknown resolution, audio only, errors, cancelled", () => {
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Clip.mp4", mode: "video", quality: "best", width: null, height: null, combined: false, combineTried: false } })).toEqual(["Added “Clip.mp4”."]);
		expect(outcomeLines({ outcome: { kind: "done", fileName: "Song.m4a", mode: "audio", quality: "best", width: null, height: null, combined: false, combineTried: false } })).toEqual(["Added “Song.m4a” (audio only)."]);
		expect(outcomeLines({ outcome: { kind: "error", code: "private" } })).toEqual(["This video is private."]);
		expect(outcomeLines({ outcome: { kind: "cancelled" } })).toEqual(["Cancelled. Nothing was added."]);
	});
});

describe("Update yt-dlp and retry: at most one automatic retry per user click", () => {
	const failedWith = ({ code, retried = false }: { code: "extractor-failed" | "path-tool-stale" | "unknown"; retried?: boolean }): DialogState => ({ step: "finished", request, outcome: { kind: "error", code }, retried });

	test("offered only after a broken extractor of Ccut's own copy, never after another error or the retry itself", () => {
		expect(canUpdateAndRetry({ state: failedWith({ code: "extractor-failed" }) })).toBe(true);
		expect(canUpdateAndRetry({ state: failedWith({ code: "path-tool-stale" }) })).toBe(false);
		expect(canUpdateAndRetry({ state: failedWith({ code: "unknown" }) })).toBe(false);
		expect(canUpdateAndRetry({ state: failedWith({ code: "extractor-failed", retried: true }) })).toBe(false);
		expect(canUpdateAndRetry({ state: INITIAL_DIALOG_STATE })).toBe(false);
	});

	test("the click starts the same request as the retry; when that fails the same way the button is gone and the action does nothing", () => {
		const retry = reduceLinkImport({ state: failedWith({ code: "extractor-failed" }), action: { type: "update-and-retry" } });
		expect(retry).toEqual({ step: "running", request, job: { phase: "updating" }, cancelling: false, retried: true });
		const again = reduceLinkImport({ state: retry, action: { type: "finished", outcome: { kind: "error", code: "extractor-failed" } } });
		expect(again).toMatchObject({ step: "finished", retried: true });
		expect(canUpdateAndRetry({ state: again })).toBe(false);
		expect(reduceLinkImport({ state: again, action: { type: "update-and-retry" } })).toBe(again);
		// a new import starts fresh
		const fresh = reduceLinkImport({ state: reduceLinkImport({ state: again, action: { type: "back" } }), action: submit() });
		expect(fresh).toMatchObject({ step: "running", retried: false });
	});

	test("the update is not cancellable from the page", () => {
		expect(canCancel({ state: { step: "running", request, job: { phase: "updating" }, cancelling: false, retried: true } })).toBe(false);
	});
});
