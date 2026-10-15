import { describe, expect, test } from "bun:test";
import type { LinkImportBridge } from "../bridge";
import { LinkBridgeError } from "../bridge";
import { type LinkImportDeps, type LinkJobView, MAIN_PROCESS_LIMITS_MS, MAX_POLLS, POLL_MS, runLinkImport, runUpdateThenImport } from "../run";
import type { TempFileStorage } from "../transfer";
import type { LinkFileInfo, LinkImportRequest, LinkJobStatus, StartResult, UpdateResult } from "../types";

// The whole page-side flow with fakes: start, poll, copy into temporary storage, release,
// hand the File to the import pipeline. Every way out releases the job in the main process.

const token = "cd".repeat(32);
const request: LinkImportRequest = { url: "https://www.youtube.com/watch?v=x", mode: "video", quality: "720" };
const fileInfo: LinkFileInfo = { size: 10, ext: "mp4", mime: "video/mp4", title: "A / clip", width: 640, height: 360, duration: 6, vcodec: "avc1", combined: false, combineTried: false };

function setup({
	start = { ok: true, token } as StartResult,
	statuses = [{ state: "preparing", step: "tool-check" }, { state: "downloading", progress: { downloadedBytes: 5, totalBytes: 10, speed: 1, eta: 5 } }, { state: "ready", progress: null, file: fileInfo }] as LinkJobStatus[],
	statusError = null as unknown,
	readError = false,
	canStore = true,
	added = true,
	onSleep = (_round: number) => {},
	updateResult = { ok: true, version: "2026.10.01" } as UpdateResult,
} = {}) {
	const calls: string[] = [];
	let polled = 0;
	const bridge: LinkImportBridge = {
		async start() {
			calls.push("start");
			return start;
		},
		async status() {
			calls.push("status");
			if (statusError) throw statusError;
			const status = statuses[Math.min(polled, statuses.length - 1)];
			polled++;
			return status;
		},
		async cancel() {
			calls.push("cancel");
			statuses = [{ state: "cancelled" }];
			polled = 0;
			return true;
		},
		async read({ length }) {
			calls.push("read");
			if (readError) throw new LinkBridgeError({ bridgeCode: "READ_FAILED" });
			return new Uint8Array(length).fill(7);
		},
		async release() {
			calls.push("release");
			return true;
		},
		async checkUpdate() {
			calls.push("checkUpdate");
			return null;
		},
		async updateTool() {
			calls.push("updateTool");
			return updateResult;
		},
	};
	const stored = new Map<string, Uint8Array[]>();
	const storage: TempFileStorage = {
		async create(name) {
			stored.set(name, []);
			return {
				write: async (chunk) => void stored.get(name)?.push(chunk),
				close: async () => {},
				abort: async () => {},
			};
		},
		getFile: async (name) => new File((stored.get(name) ?? []).map((part) => new Uint8Array(part)), name),
		remove: async (name) => void stored.delete(name),
		list: async () => [...stored.keys()],
	};
	const imported: File[] = [];
	let round = 0;
	const deps: LinkImportDeps = {
		bridge,
		storage,
		importFile: async (file) => {
			imported.push(file);
			return added;
		},
		canStore: async () => canStore,
		sleep: async () => {
			onSleep(round++);
		},
		randomHex: () => "feed",
		keepNames: new Set<string>(),
	};
	const views: LinkJobView[] = [];
	return { deps, calls, stored, imported, views, onView: (view: LinkJobView) => views.push(view) };
}

describe("runLinkImport: success", () => {
	test("a YouTube video combined in the main process: the processing phase with its fraction is shown, and the outcome says combined", async () => {
		const { deps, views, onView } = setup({
			statuses: [
				{ state: "downloading", progress: { downloadedBytes: 10, totalBytes: 10, speed: null, eta: null } },
				{ state: "processing", fraction: 0.5 },
				{ state: "ready", progress: null, file: { ...fileInfo, combined: true, combineTried: true } },
			] as LinkJobStatus[],
		});
		const outcome = await runLinkImport({ request, deps, onView });
		expect(outcome).toMatchObject({ kind: "done", combined: true, combineTried: true, width: 640, height: 360 });
		expect(views.map((view) => view.phase)).toEqual(["starting", "downloading", "processing", "transferring", "transferring", "importing"]);
		expect(views[2]).toEqual({ phase: "processing", fraction: 0.5 });
	});

	test("start -> preparing -> downloading -> transferring -> importing -> done; released; a disk-backed File with the title's name and the MIME type", async () => {
		const { deps, calls, imported, views, onView } = setup();
		const outcome = await runLinkImport({ request, deps, onView });
		expect(outcome).toEqual({ kind: "done", fileName: "A - clip.mp4", mode: "video", quality: "720", width: 640, height: 360, combined: false, combineTried: false });
		expect(views.map((view) => view.phase)).toEqual(["starting", "preparing", "downloading", "transferring", "transferring", "importing"]);
		expect(calls).toEqual(["start", "status", "status", "status", "read", "release"]);
		expect(imported).toHaveLength(1);
		expect(imported[0].name).toBe("A - clip.mp4");
		expect(imported[0].type).toBe("video/mp4");
		expect(imported[0].size).toBe(10);
		expect(deps.keepNames.has("feed.mp4")).toBe(true); // the asset's File points at it for this session
	});
});

describe("runLinkImport: failures (each releases or never had a job)", () => {
	test("start refused: its code, nothing else called", async () => {
		const { deps, calls, onView } = setup({ start: { ok: false, code: "busy" } });
		expect(await runLinkImport({ request, deps, onView })).toEqual({ kind: "error", code: "busy" });
		expect(calls).toEqual(["start"]);
	});

	test("the job failed: its code, and the job is released", async () => {
		const { deps, calls, onView } = setup({ statuses: [{ state: "failed", code: "geo-blocked" }] });
		expect(await runLinkImport({ request, deps, onView })).toEqual({ kind: "error", code: "geo-blocked" });
		expect(calls.at(-1)).toBe("release");
	});

	test("the bridge answers nonsense or rejects: bridge-failed, the job is cancelled and released", async () => {
		const { deps, calls, onView } = setup({ statusError: new LinkBridgeError({ bridgeCode: null }) });
		expect(await runLinkImport({ request, deps, onView })).toEqual({ kind: "error", code: "bridge-failed" });
		expect(calls).toContain("cancel");
		expect(calls).toContain("release");
	});

	test("not enough storage for the file (twice its size: temporary copy + project copy): storage-full, released, nothing read", async () => {
		const { deps, calls, onView } = setup({ canStore: false });
		const asked: number[] = [];
		const canStore = deps.canStore;
		deps.canStore = async (bytes) => {
			asked.push(bytes);
			return canStore(bytes);
		};
		expect(await runLinkImport({ request, deps, onView })).toEqual({ kind: "error", code: "storage-full" });
		expect(asked).toEqual([2 * fileInfo.size]);
		expect(calls).not.toContain("read");
		expect(calls.at(-1)).toBe("release");
	});

	test("the copy fails: transfer-failed, released, no temporary file kept", async () => {
		const { deps, calls, stored, onView } = setup({ readError: true });
		expect(await runLinkImport({ request, deps, onView })).toEqual({ kind: "error", code: "transfer-failed" });
		expect(calls.at(-1)).toBe("release");
		expect(stored.size).toBe(0);
		expect(deps.keepNames.size).toBe(0);
	});

	test("the import pipeline refuses the file: import-failed, the temporary file is deleted", async () => {
		const { deps, stored, onView } = setup({ added: false });
		expect(await runLinkImport({ request, deps, onView })).toEqual({ kind: "error", code: "import-failed" });
		expect(stored.size).toBe(0);
		expect(deps.keepNames.size).toBe(0);
	});

	test("a ready file whose type does not fit the mode (audio asked, video came): bad-output, released", async () => {
		const { deps, calls, onView } = setup();
		const outcome = await runLinkImport({ request: { ...request, mode: "audio" }, deps, onView });
		expect(outcome).toEqual({ kind: "error", code: "bad-output" });
		expect(calls.at(-1)).toBe("release");
	});

	test("polling is bounded: a job that never ends is cancelled after the limit (timeout)", async () => {
		const { deps, calls, onView } = setup({ statuses: [{ state: "downloading", progress: null }] });
		const outcome = await runLinkImport({ request, deps, onView, maxPolls: 5 });
		expect(outcome).toEqual({ kind: "error", code: "timeout" });
		expect(calls.filter((call) => call === "status").length).toBeLessThanOrEqual(5 + 20);
		expect(calls).toContain("cancel");
	});
});

describe("runLinkImport: cancel", () => {
	test("while downloading: the job is cancelled in the main process and waited for; outcome cancelled", async () => {
		const controller = new AbortController();
		const { deps, calls, onView } = setup({
			statuses: [{ state: "downloading", progress: null }],
			onSleep: (round) => {
				if (round === 1) controller.abort();
			},
		});
		expect(await runLinkImport({ request, deps, onView, signal: controller.signal })).toEqual({ kind: "cancelled" });
		expect(calls.filter((call) => call === "cancel")).toHaveLength(1);
		expect(calls.at(-1)).toBe("status"); // it saw the job end
	});

	test("before start answered: the job that comes back is cancelled at once", async () => {
		const controller = new AbortController();
		controller.abort();
		const { deps, calls, onView } = setup();
		expect(await runLinkImport({ request, deps, onView, signal: controller.signal })).toEqual({ kind: "cancelled" });
		expect(calls).toContain("cancel");
	});

	test("while copying: the temporary file is removed and the job released", async () => {
		const controller = new AbortController();
		const { deps, calls, stored, onView } = setup({ statuses: [{ state: "ready", progress: null, file: { ...fileInfo, size: 3 * 1024 * 1024 } }] });
		const read = deps.bridge.read;
		deps.bridge.read = async (input) => {
			controller.abort();
			return read(input);
		};
		const outcome = await runLinkImport({ request, deps, onView, signal: controller.signal, chunkBytes: 1024 * 1024 });
		expect(outcome).toEqual({ kind: "cancelled" });
		expect(stored.size).toBe(0);
		expect(calls.at(-1)).toBe("release");
	});
});

describe("the poll budget covers the longest job the main process allows", () => {
	test("yt-dlp download (consent aside) + the pair run + combining + the single-file fallback run, with room to spare", () => {
		const { toolDownload, ytDlpRun, mux } = MAIN_PROCESS_LIMITS_MS;
		const longest = toolDownload + ytDlpRun + mux + ytDlpRun;
		expect(longest).toBe(80 * 60 * 1000);
		expect(MAX_POLLS * POLL_MS).toBeGreaterThanOrEqual(longest + 5 * 60 * 1000);
	});
});

describe("runUpdateThenImport (Update yt-dlp and retry)", () => {
	test("one update, then the same request runs once", async () => {
		const { deps, calls, onView } = setup();
		const views: LinkJobView[] = [];
		const outcome = await runUpdateThenImport({ request, deps, onView: (view) => (views.push(view), onView(view)) });
		expect(outcome.kind).toBe("done");
		expect(calls.filter((call) => call === "updateTool")).toHaveLength(1);
		expect(calls.filter((call) => call === "start")).toHaveLength(1);
		expect(calls.indexOf("updateTool")).toBeLessThan(calls.indexOf("start"));
		expect(views[0]).toEqual({ phase: "updating" });
	});

	test("a failed update ends it with the update's code and starts no job", async () => {
		const { deps, calls, onView } = setup({ updateResult: { ok: false, code: "tool-signature-failed" } });
		expect(await runUpdateThenImport({ request, deps, onView })).toEqual({ kind: "error", code: "tool-signature-failed" });
		expect(calls).not.toContain("start");
	});

	test("when the retried job fails the same way it is not run again: one update, one start", async () => {
		const { deps, calls, onView } = setup({ statuses: [{ state: "failed", code: "extractor-failed" }] });
		expect(await runUpdateThenImport({ request, deps, onView })).toEqual({ kind: "error", code: "extractor-failed" });
		expect(calls.filter((call) => call === "updateTool")).toHaveLength(1);
		expect(calls.filter((call) => call === "start")).toHaveLength(1);
	});
});
