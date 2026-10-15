// "Import from link": the jobs of the main process. No Electron import (spawn, the tool
// resolver and the file system are injected), so bun runs all of it with a fake yt-dlp.
//
// - At most ONE job exists at a time (preparing, downloading, processing, or ready and not yet
//   released).
// - A job belongs to the webContents that started it; every call names it by a random
//   256-bit token, and another owner's token is "unknown".
// - Each job has a fresh private directory <root>/jobs/<random> (0700) with home/ and tmp/
//   for the child's HOME/TMPDIR; yt-dlp writes out/ and the result file there.
// - Single file (Audio only, TikTok, and the fallback): exactly one output file is accepted:
//   out/media.<ext> where ext is on the mode's allow-list and equals the result line's ext, a
//   regular file (no link, no directory), 1 byte .. the size cap. The MIME type is derived
//   here from that allow-list.
// - Pair (a YouTube link in Video mode, link-import-args.js chooseStrategy): ONE yt-dlp run
//   downloads out/<format id>.mp4 (H.264 video-only) and out/<format id>.m4a (AAC); exactly
//   those two regular files, named by the two result lines, each and together within the
//   size cap, each starting with "ftyp". After yt-dlp has exited, the main process creates
//   final/ (0700, yt-dlp never writes there) and a worker thread copies the packets of both
//   into final/media.mp4 (link-import-mux.js; state "processing"). That file is checked like
//   a single file and is what the renderer reads; the two downloads are deleted. Anything
//   that is not a valid, combinable pair (one file only, no matching format, too large, an
//   error yt-dlp's text does not explain, a wrong codec or name, a mux failure or a worker
//   crash) deletes out/, final/ and the result file and runs yt-dlp ONCE more with the
//   single-file selector (logged): the single file is another, usually much smaller format.
//   Errors a single file would hit too (PAIR_FINAL_CODES: private, login, region, HTTP 429,
//   network, unsupported, unavailable, outdated tool) and timeout or cancel end the job.
// - The renderer reads it in chunks of at most 8 MiB, checked against the size and the inode
//   found at the check. release() deletes the directory; failure, cancel, a closed window,
//   quit, and an expired ready job do too; leftovers of a crash are swept at startup.
// - yt-dlp's text is only logged (truncated); the page gets codes.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { DEFAULT_MAX_FILESIZE_BYTES, MODES, OUTPUT_DIR, QUALITY_HEIGHTS, RESULT_FILE, buildYtDlpArgs, chooseStrategy, progressPrefix } = require("./link-import-args");
const { MUX_RUN_LIMITS, runMuxWorker } = require("./link-import-mux");
const { mapYtDlpError, parsePairResultText, parseProgressLine, parseResultText, sanitizeTitle } = require("./link-import-parse");
const { buildChildEnv, runProcess } = require("./link-import-process");
const { ToolError } = require("./link-import-tool");
const { validateLinkUrl } = require("./link-import-url");

const LIMITS = Object.freeze({
	maxReadBytes: 8 * 1024 * 1024,
	maxFilesizeBytes: DEFAULT_MAX_FILESIZE_BYTES,
	maxResultBytes: 256 * 1024,
	wallMs: 30 * 60 * 1000,
	idleMs: 5 * 60 * 1000,
	killGraceMs: 3000,
	readyTtlMs: 10 * 60 * 1000,
	endedTtlMs: 5 * 60 * 1000,
	maxTailLines: 40,
	maxTailLineChars: 500,
	maxLogChars: 3000,
	muxWallMs: MUX_RUN_LIMITS.wallMs,
	muxIdleMs: MUX_RUN_LIMITS.idleMs,
	muxKillGraceMs: MUX_RUN_LIMITS.killGraceMs,
	muxHeapMb: MUX_RUN_LIMITS.heapMb,
});

// The pair's combined file: created by the mux worker in a directory yt-dlp never writes to.
const FINAL_DIR = "final";
const FINAL_NAME = "media.mp4";
// Progress lines of at most this many format ids are added up (the pair downloads two).
const MAX_PROGRESS_PARTS = 4;
// The pair's errors that a single file would hit just the same: they end the job. Anything
// else from the pair run (no matching format, too large, an unrecognised error) falls back.
const PAIR_FINAL_CODES = Object.freeze(["private", "login-required", "geo-blocked", "rate-limited", "network", "unsupported", "unavailable", "tool-outdated"]);
// Read-only, never following a link, never blocking (a FIFO swapped in cannot hang a thread).
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
// A width/height the worker reports is used only when plausible (as parse.js optionalDimension).
const plausibleDimension = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 100_000;

const OUTPUT_TYPES = Object.freeze({
	video: Object.freeze({ mp4: "video/mp4", webm: "video/webm" }),
	audio: Object.freeze({ m4a: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg" }),
});

const JOB_DIR_NAME = /^[0-9a-f]{32}$/;
const HEAD_BYTES = 16;

const startsWith = ({ head, at = 0, bytes }) => bytes.every((byte, i) => head[at + i] === byte);
const latin1 = (text) => [...Buffer.from(text, "latin1")];

/**
 * The file's first bytes are those of the container its extension names: MP4/M4A an "ftyp"
 * box, WebM the EBML magic, Ogg/Opus "OggS", MP3 an ID3 tag or a frame sync. Not a decode
 * check (the editor's import does that); it refuses a page, script or program that came back
 * under a media name.
 */
function containerMatches({ ext, head }) {
	if (!head || head.length < 4) return false;
	switch (ext) {
		case "mp4":
		case "m4a":
			return head.length >= 8 && startsWith({ head, at: 4, bytes: latin1("ftyp") });
		case "webm":
			return startsWith({ head, bytes: [0x1a, 0x45, 0xdf, 0xa3] });
		case "ogg":
		case "opus":
			return startsWith({ head, bytes: latin1("OggS") });
		case "mp3":
			return startsWith({ head, bytes: latin1("ID3") }) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
		default:
			return false;
	}
}
const ACTIVE = new Set(["preparing", "downloading", "processing", "ready"]);
const RUNNING = new Set(["preparing", "downloading", "processing"]);

/**
 * The pair's progress: the latest line of each format id, added up. The total is known once
 * every started download has one (the second file's total is not known before it starts).
 */
function addProgress({ parts, progress }) {
	if (!parts.has(progress.formatId) && parts.size >= MAX_PROGRESS_PARTS) return null;
	parts.set(progress.formatId, { downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes });
	let downloadedBytes = 0;
	let totalBytes = 0;
	for (const part of parts.values()) {
		downloadedBytes += part.downloadedBytes;
		totalBytes = totalBytes === null || part.totalBytes === null ? null : totalBytes + part.totalBytes;
	}
	return { downloadedBytes, totalBytes, speed: progress.speed, eta: progress.eta };
}

// Errors of the IPC calls (not of the download, which ends as a status code). The message
// is "CCUT_LINK_IMPORT:<CODE>" and nothing else.
class LinkImportError extends Error {
	constructor(code) {
		super(`CCUT_LINK_IMPORT:${code}`);
		this.name = "LinkImportError";
		this.code = code;
	}
}
const fail = (code) => {
	throw new LinkImportError(code);
};

class LinkImportJobs {
	constructor({
		root,
		spawn,
		platform = process.platform,
		parentEnv = {},
		resolveTool,
		log = () => {},
		now = Date.now,
		randomHex = (bytes) => crypto.randomBytes(bytes).toString("hex"),
		kill,
		fsApi = fsp,
		fsSync = fs,
		pathApi = path,
		limits = {},
		mux = runMuxWorker,
		// link-import-ipc.js passes it (resolveMediabunnyPath); without one nothing is combined
		// (never a search by package name).
		mediabunnyPath = null,
		// An update of the managed yt-dlp is installing (link-import-update.js): no job starts meanwhile.
		isUpdating = () => false,
	}) {
		this.jobsRoot = pathApi.join(root, "jobs");
		this.spawn = spawn;
		this.platform = platform;
		this.parentEnv = parentEnv;
		this.resolveTool = resolveTool;
		this.log = log;
		this.now = now;
		this.randomHex = randomHex;
		this.kill = kill;
		this.fs = fsApi;
		this.fsSync = fsSync;
		this.path = pathApi;
		this.limits = { ...LIMITS, ...limits };
		this.mux = mux;
		this.mediabunnyPath = mediabunnyPath;
		this.isUpdating = isUpdating;
		this.job = null;
	}

	isBusy() {
		return this.job !== null && ACTIVE.has(this.job.state);
	}

	/** { ok: true, token } or { ok: false, code: "invalid"|"url-refused"|"playlist-refused"|"busy" }. */
	async start({ ownerId, url, mode, quality }) {
		await this.expire();
		if (!MODES.includes(mode) || typeof quality !== "string" || !Object.hasOwn(QUALITY_HEIGHTS, quality)) return { ok: false, code: "invalid" };
		const checked = validateLinkUrl(url);
		if (!checked.ok) return { ok: false, code: checked.code };
		if (this.isBusy() || this.isUpdating()) return { ok: false, code: "busy" };
		const dir = this.path.join(this.jobsRoot, this.randomHex(16));
		const nonce = this.randomHex(16);
		const token = this.randomHex(32);
		const job = {
			token,
			ownerId,
			nonce,
			dir,
			state: "preparing",
			phase: "tool-check",
			progress: null,
			fraction: null,
			file: null,
			code: null,
			toolSource: null,
			run: null,
			muxRun: null,
			abort: new AbortController(),
			cancelRequested: false,
			lastActivity: this.now(),
			endedAt: null,
		};
		this.job = job;
		job.task = this.runJob({ job, url: checked.url, platform: checked.platform, mode, quality });
		return { ok: true, token };
	}

	jobFor({ ownerId, token }) {
		const job = this.job;
		if (!job || typeof token !== "string" || job.token !== token || job.ownerId !== ownerId) fail("UNKNOWN_JOB");
		return job;
	}

	/**
	 * What the page may know: state, phase, download progress, the mux fraction while
	 * "processing", the file's description (never a path; `combined` when it was muxed,
	 * `combineTried` when the pair was attempted), a code.
	 */
	status({ ownerId, token }) {
		const job = this.jobFor({ ownerId, token });
		const { file } = job;
		return {
			state: job.state,
			phase: job.phase,
			progress: job.progress ? { ...job.progress } : null,
			file: file
				? { size: file.size, ext: file.ext, mime: file.mime, title: file.title, width: file.width, height: file.height, duration: file.duration, vcodec: file.vcodec, combined: file.combined, combineTried: file.combineTried }
				: null,
			fraction: job.state === "processing" ? job.fraction : null,
			code: job.code,
		};
	}

	/** Stops a running job (its end state becomes "cancelled"), or releases a ready one. */
	async cancel({ ownerId, token }) {
		const job = this.jobFor({ ownerId, token });
		if (job.state === "ready") return this.release({ ownerId, token });
		if (!RUNNING.has(job.state)) return false;
		job.cancelRequested = true;
		job.abort.abort();
		job.run?.cancel();
		job.muxRun?.cancel();
		return true;
	}

	async read({ ownerId, token, offset, length }) {
		const job = this.jobFor({ ownerId, token });
		if (job.state !== "ready") fail("NOT_READY");
		const { file } = job;
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) fail("INVALID");
		if (!Number.isSafeInteger(length) || length < 1 || length > this.limits.maxReadBytes) fail("INVALID");
		// One read in flight per job: a page that fires reads in parallel cannot pile up buffers here.
		if (job.reading) fail("BUSY");
		job.reading = true;
		const count = Math.min(length, file.size - offset);
		const flags = this.platform === "win32" ? "r" : READ_FLAGS;
		let handle = null;
		try {
			handle = await this.fs.open(file.path, flags);
			const stat = await handle.stat();
			const sameFile = stat.isFile() && stat.size === file.size && (this.platform === "win32" || (stat.ino === file.ino && stat.dev === file.dev));
			if (!sameFile) fail("READ_FAILED");
			// Exactly `count` bytes in a buffer of exactly that size: nothing else crosses the IPC.
			const bytes = new Uint8Array(count);
			let done = 0;
			for (let round = 0; done < count && round <= count; round++) {
				const { bytesRead } = await handle.read(bytes, done, count - done, offset + done);
				if (bytesRead === 0) break;
				done += bytesRead;
			}
			if (done !== count) fail("READ_FAILED");
			job.lastActivity = this.now();
			return bytes;
		} catch (error) {
			if (error instanceof LinkImportError) throw error;
			this.log(`[ccut] link import read failed: ${error && error.code ? error.code : error}`);
			return fail("READ_FAILED");
		} finally {
			if (handle) await handle.close().catch(() => {});
			job.reading = false;
		}
	}

	/** Deletes the job and its directory (stopping it first if it still runs). */
	async release({ ownerId, token }) {
		const job = this.jobFor({ ownerId, token });
		await this.drop(job);
		return true;
	}

	async drop(job) {
		if (RUNNING.has(job.state)) {
			job.cancelRequested = true;
			job.abort.abort();
			job.run?.cancel();
			job.muxRun?.cancel();
			await job.task;
		}
		job.state = "released";
		if (this.job === job) this.job = null;
		await this.removeDir(job);
	}

	/** The owner's page reloaded, navigated away, crashed or closed. */
	async abortOwner(ownerId) {
		const job = this.job;
		if (job && job.ownerId === ownerId) await this.drop(job);
	}

	/** App quit: kill and delete synchronously (the app does not wait for promises). */
	shutdownSync() {
		const job = this.job;
		if (!job) return;
		job.cancelRequested = true;
		job.abort.abort();
		job.run?.killSync();
		job.muxRun?.terminate();
		job.state = "released";
		this.job = null;
		try {
			this.fsSync.rmSync(job.dir, { recursive: true, force: true });
		} catch {}
	}

	/** A ready file nobody reads expires; an ended job's status is forgotten after a while. */
	async expire() {
		const job = this.job;
		if (!job) return;
		const now = this.now();
		if (job.state === "ready" && now - job.lastActivity > this.limits.readyTtlMs) {
			await this.drop(job);
		} else if ((job.state === "failed" || job.state === "cancelled") && now - job.endedAt > this.limits.endedTtlMs) {
			this.job = null;
		}
	}

	/** Job directories left by a crash or power loss. Only names this module creates are touched. */
	async sweepLeftovers() {
		let names;
		try {
			names = await this.fs.readdir(this.jobsRoot);
		} catch {
			return;
		}
		const current = this.job ? this.path.basename(this.job.dir) : null;
		for (const name of names) {
			if (!JOB_DIR_NAME.test(name) || name === current) continue;
			await this.fs.rm(this.path.join(this.jobsRoot, name), { recursive: true, force: true }).catch(() => {});
		}
	}

	// --- internals ---

	async createJobDir(job) {
		const posix = this.platform !== "win32";
		await this.fs.mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
		if (posix) await this.fs.chmod(this.jobsRoot, 0o700);
		await this.fs.mkdir(job.dir, { mode: 0o700 }); // fails if it exists: never reuse a directory
		if (posix) await this.fs.chmod(job.dir, 0o700);
		await this.fs.mkdir(this.path.join(job.dir, "home"), { mode: 0o700 });
		await this.fs.mkdir(this.path.join(job.dir, "tmp"), { mode: 0o700 });
	}

	async removeDir(job) {
		try {
			await this.fs.rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		} catch (error) {
			this.log(`[ccut] link import: could not delete a job directory (${error && error.code})`);
		}
	}

	/** The directory goes first: once the page sees "failed"/"cancelled", nothing of the job is left. */
	async end({ job, state, code = null }) {
		if (job.state === "released") return;
		job.file = null;
		await this.removeDir(job);
		if (job.state === "released") return;
		job.state = state;
		// A broken extractor of a yt-dlp on PATH: Ccut never updates that one, the page is told to say so.
		job.code = code === "extractor-failed" && job.toolSource === "path" ? "path-tool-stale" : code;
		job.phase = null;
		job.fraction = null;
		job.endedAt = this.now();
	}

	logTail({ tail, why }) {
		const text = tail.slice(-10).join(" | ");
		this.log(`[ccut] link import ${why}: ${text.slice(0, this.limits.maxLogChars)}`);
	}

	async runJob({ job, url, platform, mode, quality }) {
		try {
			await this.createJobDir(job);
			if (job.cancelRequested) return this.end({ job, state: "cancelled" });
			const env = buildChildEnv({ parentEnv: this.parentEnv, platform: this.platform, jobDir: job.dir });
			const tool = await this.resolveTool({
				onPhase: (phase) => {
					if (job.state === "preparing") job.phase = phase;
				},
				signal: job.abort.signal,
				env,
				cwd: job.dir,
			});
			job.toolSource = tool.source;
			if (job.cancelRequested) return this.end({ job, state: "cancelled" });
			if (chooseStrategy({ mode, platform }) === "pair") {
				job.combineTried = true;
				const pair = await this.runPair({ job, tool, env, url, quality });
				if (pair.ended) return undefined;
				this.log(`[ccut] link import: separate video and audio not used (${pair.why}); trying the single-file format once`.slice(0, this.limits.maxLogChars));
				await this.clearForFallback(job);
				if (job.cancelRequested) return this.end({ job, state: "cancelled" });
			}
			return await this.runSingle({ job, tool, env, url, mode, quality });
		} catch (error) {
			if (job.cancelRequested) return this.end({ job, state: "cancelled" });
			const code = error instanceof ToolError ? error.code : "unknown";
			if (code === "unknown") this.log(`[ccut] link import failed: ${String(error && error.stack ? error.stack : error).slice(0, this.limits.maxLogChars)}`);
			return this.end({ job, state: "failed", code });
		}
	}

	/** Runs yt-dlp once; progress lines feed job.progress (summed per format id with `withFormatId`) and the size watchdog. */
	async download({ job, tool, env, args, withFormatId }) {
		const prefix = progressPrefix({ nonce: job.nonce });
		const cap = this.limits.maxFilesizeBytes;
		const tail = [];
		const parts = new Map();
		job.state = "downloading";
		job.phase = null;
		job.progress = null;
		job.fraction = null;
		let run = null;
		run = runProcess({
			spawn: this.spawn,
			binary: tool.binary,
			args,
			cwd: job.dir,
			env,
			platform: this.platform,
			kill: this.kill,
			limits: { wallMs: this.limits.wallMs, idleMs: this.limits.idleMs, killGraceMs: this.limits.killGraceMs },
			onLine: ({ line }) => {
				const progress = parseProgressLine({ line, prefix, withFormatId });
				if (progress) {
					const current = withFormatId ? addProgress({ parts, progress }) : progress;
					if (!current) return;
					job.progress = current;
					job.lastActivity = this.now();
					if (current.downloadedBytes > cap || (current.totalBytes !== null && current.totalBytes > cap)) run?.stop("too-large");
					return;
				}
				tail.push(line.slice(0, this.limits.maxTailLineChars));
				if (tail.length > this.limits.maxTailLines) tail.shift();
			},
		});
		job.run = run;
		if (job.cancelRequested) run.cancel();
		const outcome = await run.done;
		job.run = null;
		return { outcome, tail };
	}

	/** Ends the job for a run that was stopped or could not start; false when it exited by itself. */
	async endedByStop({ job, outcome, tail }) {
		if (job.cancelRequested || outcome.reason === "cancelled") {
			await this.end({ job, state: "cancelled" });
			return true;
		}
		if (outcome.reason === "too-large") {
			await this.end({ job, state: "failed", code: "too-large" });
			return true;
		}
		if (outcome.reason === "timeout" || outcome.reason === "idle") {
			this.logTail({ tail, why: `stopped (${outcome.reason})` });
			await this.end({ job, state: "failed", code: "timeout" });
			return true;
		}
		if (outcome.reason === "spawn-error") {
			await this.end({ job, state: "failed", code: "tool-missing" });
			return true;
		}
		return false;
	}

	/** Today's path: one file with video and sound (or audio only). */
	async runSingle({ job, tool, env, url, mode, quality }) {
		const args = buildYtDlpArgs({ url, mode, quality, nonce: job.nonce, maxFilesizeBytes: this.limits.maxFilesizeBytes });
		const { outcome, tail } = await this.download({ job, tool, env, args, withFormatId: false });
		if (await this.endedByStop({ job, outcome, tail })) return undefined;
		if (outcome.exitCode !== 0) {
			this.logTail({ tail, why: `failed (exit ${outcome.exitCode})` });
			return this.end({ job, state: "failed", code: mapYtDlpError({ lines: tail }) });
		}
		const result = parseResultText(await this.readResult(job));
		if (!result.ok) {
			this.logTail({ tail, why: "ended without a result" });
			const code = mapYtDlpError({ lines: tail });
			return this.end({ job, state: "failed", code: code === "unknown" ? "bad-output" : code });
		}
		const checked = await this.checkOutput({ job, mode, ext: result.info.ext });
		if (!checked.file) return this.end({ job, state: "failed", code: checked.code });
		if (!containerMatches({ ext: checked.file.ext, head: await this.readHead(checked.file.path) })) {
			this.log(`[ccut] link import: the ${checked.file.ext} file does not start like one`);
			return this.end({ job, state: "failed", code: "bad-output" });
		}
		if (job.cancelRequested) return this.end({ job, state: "cancelled" });
		const { info } = result;
		job.file = { ...checked.file, title: sanitizeTitle(info.title), width: info.width, height: info.height, duration: info.duration, vcodec: info.vcodec, combined: false, combineTried: job.combineTried === true };
		job.state = "ready";
		job.lastActivity = this.now();
		return undefined;
	}

	/**
	 * The pair: { ended: true } when the job reached an end state (ready, failed, cancelled),
	 * { ended: false, why } when the single-file path should be tried instead.
	 */
	async runPair({ job, tool, env, url, quality }) {
		const ended = async ({ state, code = null }) => {
			await this.end({ job, state, code });
			return { ended: true };
		};
		const args = buildYtDlpArgs({ url, mode: "video", quality, nonce: job.nonce, maxFilesizeBytes: this.limits.maxFilesizeBytes, strategy: "pair" });
		const { outcome, tail } = await this.download({ job, tool, env, args, withFormatId: true });
		// Too large as a pair is not too large as a single file (another, much smaller format).
		if (!job.cancelRequested && outcome.reason === "too-large") return { ended: false, why: "the two downloads are too large together" };
		if (await this.endedByStop({ job, outcome, tail })) return { ended: true };
		if (outcome.exitCode !== 0) {
			const code = mapYtDlpError({ lines: tail });
			if (!PAIR_FINAL_CODES.includes(code)) {
				this.logTail({ tail, why: `pair run failed (exit ${outcome.exitCode}, ${code})` });
				return { ended: false, why: `yt-dlp: ${code}` };
			}
			this.logTail({ tail, why: `failed (exit ${outcome.exitCode})` });
			return ended({ state: "failed", code });
		}
		const result = parsePairResultText(await this.readResult(job));
		if (!result.ok) {
			// yt-dlp may end with 0 after refusing a download (e.g. "larger than max-filesize").
			const code = mapYtDlpError({ lines: tail });
			if (PAIR_FINAL_CODES.includes(code)) {
				this.logTail({ tail, why: "ended without the two files" });
				return ended({ state: "failed", code });
			}
			return { ended: false, why: `result: ${result.reason}${code === "unknown" ? "" : ` (yt-dlp: ${code === "too-large" ? "too large" : code})`}` };
		}
		const checked = await this.checkPairOutput({ job, result });
		if (!checked.files) return { ended: false, why: checked.code === "too-large" ? "a downloaded file is too large" : "the downloaded files do not match the result" };
		for (const file of [checked.files.video, checked.files.audio]) {
			if (!containerMatches({ ext: file.ext, head: await this.readHead(file.path) })) return { ended: false, why: `the ${file.ext} file does not start like one` };
		}
		if (job.cancelRequested) return ended({ state: "cancelled" });
		const muxed = await this.combine({ job, files: checked.files });
		if (job.cancelRequested) return ended({ state: "cancelled" });
		if (!muxed.ok) return { ended: false, why: `combining failed (${muxed.reason}${muxed.detail ? `: ${muxed.detail}` : ""})` };
		const final = await this.checkFinalOutput({ job });
		if (!final.file || !containerMatches({ ext: "mp4", head: await this.readHead(final.file.path) })) return { ended: false, why: "the combined file is not usable" };
		// The two downloads are not needed any more (release() deletes the whole directory anyway).
		await this.fs.rm(this.path.join(job.dir, OUTPUT_DIR), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error) => {
			this.log(`[ccut] link import: could not delete the two downloads (${error && error.code})`);
		});
		if (job.cancelRequested) return ended({ state: "cancelled" });
		const { video } = result;
		job.file = {
			...final.file,
			title: sanitizeTitle(video.title),
			width: plausibleDimension(muxed.result.width) ? muxed.result.width : video.width,
			height: plausibleDimension(muxed.result.height) ? muxed.result.height : video.height,
			duration: video.duration,
			vcodec: video.vcodec,
			combined: true,
			combineTried: true,
		};
		job.state = "ready";
		job.fraction = null;
		job.lastActivity = this.now();
		return { ended: true };
	}

	/** The mux worker: final/ is created only now, after yt-dlp has exited. Never rejects. */
	async combine({ job, files }) {
		const finalDir = this.path.join(job.dir, FINAL_DIR);
		try {
			await this.fs.mkdir(finalDir, { mode: 0o700 }); // fails if anything is already there
			if (this.platform !== "win32") await this.fs.chmod(finalDir, 0o700);
		} catch (error) {
			return { ok: false, reason: "failed", detail: `final directory (${error && error.code})` };
		}
		job.state = "processing";
		job.fraction = 0;
		job.lastActivity = this.now();
		const describe = ({ path: filePath, size, dev, ino }) => ({ path: filePath, size, dev, ino });
		const run = this.mux({
			job: { video: describe(files.video), audio: describe(files.audio), outPath: this.path.join(finalDir, FINAL_NAME) },
			mediabunnyPath: this.mediabunnyPath,
			onProgress: (fraction) => {
				job.fraction = fraction;
				job.lastActivity = this.now();
			},
			limits: { wallMs: this.limits.muxWallMs, idleMs: this.limits.muxIdleMs, killGraceMs: this.limits.muxKillGraceMs, heapMb: this.limits.muxHeapMb },
		});
		job.muxRun = run;
		if (job.cancelRequested) run.cancel();
		const outcome = await run.done;
		job.muxRun = null;
		return outcome;
	}

	/** Before the single-file run: nothing of the pair attempt is left (files, result lines). */
	async clearForFallback(job) {
		for (const name of [OUTPUT_DIR, FINAL_DIR, RESULT_FILE]) {
			await this.fs.rm(this.path.join(job.dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}
		job.progress = null;
		job.fraction = null;
	}

	async readHead(filePath) {
		const flags = this.platform === "win32" ? "r" : READ_FLAGS;
		let handle = null;
		try {
			handle = await this.fs.open(filePath, flags);
			if (!(await handle.stat()).isFile()) return null;
			const head = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
			return head.subarray(0, bytesRead);
		} catch {
			return null;
		} finally {
			if (handle) await handle.close().catch(() => {});
		}
	}

	async readResult(job) {
		const file = this.path.join(job.dir, RESULT_FILE);
		// Opened without following a link, then checked on the open handle and read with a
		// bounded buffer: a swap between a path check and the read cannot skip the size cap.
		const flags = this.platform === "win32" ? "r" : READ_FLAGS;
		let handle;
		try {
			const before = await this.fs.lstat(file);
			if (!before.isFile()) return null;
			handle = await this.fs.open(file, flags);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > this.limits.maxResultBytes) return null;
			const buffer = Buffer.alloc(this.limits.maxResultBytes + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > this.limits.maxResultBytes) return null;
			return buffer.subarray(0, bytesRead).toString("utf8");
		} catch {
			return null;
		} finally {
			if (handle) await handle.close().catch(() => {});
		}
	}

	/** { file } for exactly one acceptable output file, else { code }. */
	async checkOutput({ job, mode, ext }) {
		const types = OUTPUT_TYPES[mode];
		if (!Object.hasOwn(types, ext)) return { code: "bad-output" };
		return this.checkOnlyFile({ dir: this.path.join(job.dir, OUTPUT_DIR), name: `media.${ext}`, ext, mime: types[ext] });
	}

	/** The pair's combined file: final/media.mp4 and nothing else there. */
	async checkFinalOutput({ job }) {
		return this.checkOnlyFile({ dir: this.path.join(job.dir, FINAL_DIR), name: FINAL_NAME, ext: "mp4", mime: OUTPUT_TYPES.video.mp4 });
	}

	async checkOnlyFile({ dir, name, ext, mime }) {
		let entries;
		try {
			entries = await this.fs.readdir(dir, { withFileTypes: true });
		} catch {
			return { code: "bad-output" };
		}
		// A Dirent describes the entry itself: a symlink is not isFile().
		if (entries.length !== 1 || entries[0].name !== name || !entries[0].isFile()) return { code: "bad-output" };
		const filePath = this.path.join(dir, name);
		const stat = await this.fs.lstat(filePath);
		if (!stat.isFile() || stat.size <= 0) return { code: "bad-output" };
		if (stat.size > this.limits.maxFilesizeBytes) return { code: "too-large" };
		return { file: { path: filePath, size: stat.size, ext, mime, dev: stat.dev, ino: stat.ino } };
	}

	/**
	 * { files: { video, audio } } when out/ holds exactly the two files the result lines name
	 * (<format id>.mp4 and <format id>.m4a), regular, not empty, each and together within the
	 * size cap; else { code: "bad-output" | "too-large" }.
	 */
	async checkPairOutput({ job, result }) {
		const outDir = this.path.join(job.dir, OUTPUT_DIR);
		let entries;
		try {
			entries = await this.fs.readdir(outDir, { withFileTypes: true });
		} catch {
			return { code: "bad-output" };
		}
		if (entries.length !== 2) return { code: "bad-output" };
		const cap = this.limits.maxFilesizeBytes;
		const files = {};
		let total = 0;
		for (const [role, ext] of [
			["video", "mp4"],
			["audio", "m4a"],
		]) {
			const name = `${result[role].formatId}.${ext}`;
			const entry = entries.find((candidate) => candidate.name === name);
			if (!entry || !entry.isFile()) return { code: "bad-output" };
			const filePath = this.path.join(outDir, name);
			// bigint: the worker compares device and file id exactly (also on Windows).
			const stat = await this.fs.lstat(filePath, { bigint: true });
			const size = Number(stat.size);
			if (!stat.isFile() || size <= 0) return { code: "bad-output" };
			if (size > cap) return { code: "too-large" };
			total += size;
			files[role] = { path: filePath, size, ext, dev: String(stat.dev), ino: String(stat.ino) };
		}
		if (total > cap) return { code: "too-large" };
		return { files };
	}
}

module.exports = { LIMITS, LinkImportError, LinkImportJobs, OUTPUT_TYPES, addProgress, containerMatches };
