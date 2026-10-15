import type { LinkImportBridge } from "./bridge";
import { fileNameFor, tempNameFor } from "./file-name";
import {
	LinkTransferError,
	TRANSFER_CHUNK_BYTES,
	type TempFileStorage,
	transferToTempFile,
} from "./transfer";
import type {
	LinkFileInfo,
	LinkImportErrorCode,
	LinkImportMode,
	LinkImportQuality,
	LinkImportRequest,
	LinkJobStatus,
	LinkProgress,
	PreparingStep,
} from "./types";

// The page side of one "Import from link": start the job in the main process, poll it, copy
// the finished file into temporary storage, release the job, then hand the File to the
// editor's normal import pipeline (the same one the file picker uses). Every way out of here
// leaves no job and no temporary file behind, except the temporary file of a successful
// import, which the new asset's File points at for this page session.

export const POLL_MS = 500;
// The main process's own limits (apps/electron: link-import-tool.js downloadTimeoutMs,
// link-import-jobs.js wallMs and muxWallMs; link-import-jobs.test.js checks this copy).
export const MAIN_PROCESS_LIMITS_MS = {
	toolDownload: 10 * 60 * 1000,
	ytDlpRun: 30 * 60 * 1000,
	mux: 10 * 60 * 1000,
} as const;
// The longest job: the yt-dlp download, the pair run, combining, then the single-file fallback
// run, plus 5 minutes. The consent dialog's wait comes on top. This only bounds the loop: the
// main process's limits decide first.
export const MAX_POLLS = Math.ceil(
	(MAIN_PROCESS_LIMITS_MS.toolDownload +
		2 * MAIN_PROCESS_LIMITS_MS.ytDlpRun +
		MAIN_PROCESS_LIMITS_MS.mux +
		5 * 60 * 1000) /
		POLL_MS,
);
// After Cancel: up to ~10 s for the job to end in the main process (it deletes its files first).
const SETTLE_POLLS = 20;

export type LinkJobView =
	| { phase: "starting" }
	/** "Update yt-dlp and retry": Ccut's own copy is being updated (the main process's dialog may be open). */
	| { phase: "updating" }
	| { phase: "preparing"; step: PreparingStep }
	| { phase: "downloading"; progress: LinkProgress | null }
	| { phase: "processing"; fraction: number | null }
	| { phase: "transferring"; transferredBytes: number; totalBytes: number }
	| { phase: "importing"; fileName: string };

export type LinkImportOutcome =
	| {
			kind: "done";
			fileName: string;
			mode: LinkImportMode;
			quality: LinkImportQuality;
			width: number | null;
			height: number | null;
			/** Combined from a video-only and an audio-only download (YouTube, Video). */
			combined: boolean;
			/** Combining was attempted (if `combined` is false, the single file was the fallback). */
			combineTried: boolean;
	  }
	| { kind: "error"; code: LinkImportErrorCode }
	| { kind: "cancelled" };

export interface LinkImportDeps {
	bridge: LinkImportBridge;
	storage: TempFileStorage;
	/** The editor's import pipeline; true when an asset was added for this File. */
	importFile: (file: File) => Promise<boolean>;
	/** True when the app's storage can take this many more bytes. */
	canStore: (bytes: number) => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	randomHex: () => string;
	/** Temporary files this page session still uses (never swept). */
	keepNames: Set<string>;
}

const failed = (code: LinkImportErrorCode): LinkImportOutcome => ({
	kind: "error",
	code,
});
const CANCELLED: LinkImportOutcome = { kind: "cancelled" };

function mimeFitsMode({ mime, mode }: { mime: string; mode: LinkImportMode }) {
	return mode === "audio" ? mime.startsWith("audio/") : mime.startsWith("video/");
}

/** Cancels the job and waits (bounded) until the main process says it ended. */
async function cancelJob({
	deps,
	token,
	pollMs,
}: {
	deps: LinkImportDeps;
	token: string;
	pollMs: number;
}): Promise<void> {
	await deps.bridge.cancel({ token }).catch(() => false);
	let ended = false;
	for (let round = 0; round < SETTLE_POLLS && !ended; round++) {
		const status: LinkJobStatus | null = await deps.bridge
			.status({ token })
			.catch(() => null);
		if (!status) break;
		ended = status.state === "cancelled" || status.state === "failed";
		if (!ended) await deps.sleep(pollMs);
	}
	// Unknown end (no answer, or still running): make sure nothing stays.
	if (!ended) await deps.bridge.release({ token }).catch(() => false);
}

export async function runLinkImport({
	request,
	deps,
	onView,
	signal,
	pollMs = POLL_MS,
	maxPolls = MAX_POLLS,
	chunkBytes = TRANSFER_CHUNK_BYTES,
}: {
	request: LinkImportRequest;
	deps: LinkImportDeps;
	onView: (view: LinkJobView) => void;
	signal?: AbortSignal;
	pollMs?: number;
	maxPolls?: number;
	chunkBytes?: number;
}): Promise<LinkImportOutcome> {
	const { bridge } = deps;
	onView({ phase: "starting" });
	const started = await bridge.start(request);
	if (!started.ok) return failed(started.code);
	const { token } = started;
	const release = () => bridge.release({ token }).catch(() => false);

	let file: LinkFileInfo | null = null;
	for (let round = 0; round < maxPolls && !file; round++) {
		if (signal?.aborted) {
			await cancelJob({ deps, token, pollMs });
			return CANCELLED;
		}
		let status: LinkJobStatus;
		try {
			status = await bridge.status({ token });
		} catch {
			await cancelJob({ deps, token, pollMs });
			return failed("bridge-failed");
		}
		if (status.state === "preparing") onView({ phase: "preparing", step: status.step });
		else if (status.state === "downloading") onView({ phase: "downloading", progress: status.progress });
		else if (status.state === "processing") onView({ phase: "processing", fraction: status.fraction });
		else if (status.state === "ready") file = status.file;
		else if (status.state === "failed") {
			await release();
			return failed(status.code);
		} else {
			await release();
			return CANCELLED;
		}
		if (!file) await deps.sleep(pollMs);
	}
	if (!file) {
		await cancelJob({ deps, token, pollMs });
		return failed("timeout");
	}

	if (!mimeFitsMode({ mime: file.mime, mode: request.mode })) {
		await release();
		return failed("bad-output");
	}
	if (signal?.aborted) {
		await release();
		return CANCELLED;
	}
	// A temporary copy and the project's copy exist at the same time.
	if (!(await deps.canStore(file.size * 2).catch(() => false))) {
		await release();
		return failed("storage-full");
	}

	const tempName = tempNameFor({ ext: file.ext, randomHex: deps.randomHex });
	deps.keepNames.add(tempName);
	let tempFile: File;
	try {
		onView({ phase: "transferring", transferredBytes: 0, totalBytes: file.size });
		tempFile = await transferToTempFile({
			bridge,
			token,
			size: file.size,
			name: tempName,
			storage: deps.storage,
			chunkBytes,
			signal,
			onProgress: ({ transferredBytes, totalBytes }) =>
				onView({ phase: "transferring", transferredBytes, totalBytes }),
		});
	} catch (error) {
		deps.keepNames.delete(tempName);
		await release();
		return error instanceof LinkTransferError && error.code === "cancelled"
			? CANCELLED
			: failed("transfer-failed");
	}
	await release();

	const fileName = fileNameFor({ title: file.title, ext: file.ext, mode: request.mode });
	// A File over the stored one: still disk-backed, now with the asset's name and type.
	const media = new File([tempFile], fileName, { type: file.mime });
	onView({ phase: "importing", fileName });
	const added = await deps.importFile(media).catch(() => false);
	if (!added) {
		deps.keepNames.delete(tempName);
		await deps.storage.remove(tempName).catch(() => {});
		return failed("import-failed");
	}
	return {
		kind: "done",
		fileName,
		mode: request.mode,
		quality: request.quality,
		width: file.width,
		height: file.height,
		combined: file.combined,
		combineTried: file.combineTried,
	};
}

/**
 * "Update yt-dlp and retry" (the copy Ccut manages): the user's click updates it through the
 * main process's verified path, then the SAME request runs once more. Exactly one update and one
 * run: there is no loop here, and the dialog offers the button again only after the user starts
 * a new import (state.ts). A failed update ends the attempt with its own code and runs nothing.
 */
export async function runUpdateThenImport({
	request,
	deps,
	onView,
	signal,
	pollMs,
	maxPolls,
	chunkBytes,
}: {
	request: LinkImportRequest;
	deps: LinkImportDeps;
	onView: (view: LinkJobView) => void;
	signal?: AbortSignal;
	pollMs?: number;
	maxPolls?: number;
	chunkBytes?: number;
}): Promise<LinkImportOutcome> {
	onView({ phase: "updating" });
	const updated = await deps.bridge.updateTool();
	if (!updated.ok) return failed(updated.code);
	if (signal?.aborted) return CANCELLED;
	return runLinkImport({ request, deps, onView, signal, pollMs, maxPolls, chunkBytes });
}
