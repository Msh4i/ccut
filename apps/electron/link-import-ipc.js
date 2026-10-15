// "Import from link" IPC: seven channels, each one checks the sender first (the app's own main
// frame, isTrustedSender from export-files.js), then the payload, then hands over to
// LinkImportJobs. The page sends a URL, a mode and a quality; it gets a token, statuses with
// codes, and the downloaded file's bytes in capped chunks. It never names a path, never sees
// one, and never sees yt-dlp's text. The consent dialog for downloading yt-dlp is shown here,
// in the main process. Two channels (L9, link-import-update.js) take no payload at all: "update-check"
// answers a release tag (a version string) or null, "update" is the user's click on "Update" and
// answers { ok, version } or { ok: false, code }.
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isTrustedSender } = require("./export-files");
const { MODES, QUALITY_HEIGHTS } = require("./link-import-args");
const { LIMITS: JOB_LIMITS, LinkImportError, LinkImportJobs } = require("./link-import-jobs");
const { muxWorkerPath, resolveMediabunnyPath } = require("./link-import-mux");
const { buildChildEnv, runProcess } = require("./link-import-process");
const {
	LIMITS: TOOL_LIMITS,
	MIN_VERSION,
	RELEASES,
	YT_DLP_SIGNING_KEY,
	createToolResolver,
	findOnPath,
	compareVersions,
	installManagedBinary,
	parseVersion,
	readManagedBinary,
	resolveLatestTag,
	sweepToolLeftovers,
} = require("./link-import-tool");
const { createUpdateService } = require("./link-import-update");
const { MAX_URL_CHARS } = require("./link-import-url");

const CHANNELS = Object.freeze({
	start: "ccut-link-import:start",
	status: "ccut-link-import:status",
	cancel: "ccut-link-import:cancel",
	read: "ccut-link-import:read",
	release: "ccut-link-import:release",
	updateCheck: "ccut-link-import:update-check",
	update: "ccut-link-import:update",
});

const MAX_TOKEN_CHARS = 128;
const EXPIRE_INTERVAL_MS = 60_000;
const VERSION_TIMEOUT_MS = 30_000;

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const isToken = (value) => typeof value === "string" && value.length <= MAX_TOKEN_CHARS;

/** { url, mode, quality } or null. The URL itself is judged by the job manager (link-import-url.js). */
function parseStartRequest(request) {
	if (!isPlainObject(request)) return null;
	const { url, mode, quality } = request;
	if (typeof url !== "string" || url.length > MAX_URL_CHARS) return null;
	if (typeof mode !== "string" || !MODES.includes(mode)) return null;
	if (typeof quality !== "string" || !Object.hasOwn(QUALITY_HEIGHTS, quality)) return null;
	return { url, mode, quality };
}

function parseTokenRequest(request) {
	return isPlainObject(request) && isToken(request.token) ? { token: request.token } : null;
}

/** { token, offset, length } with number types, or null; the ranges are checked by the job manager. */
function parseReadRequest(request) {
	if (!isPlainObject(request) || !isToken(request.token)) return null;
	const { token, offset, length } = request;
	if (typeof offset !== "number" || typeof length !== "number") return null;
	return { token, offset, length };
}

/**
 * The test seam: only an unpackaged build reads CCUT_TEST_YTDLP (an absolute path to a
 * stand-in binary, see test/fixtures/fake-yt-dlp.js). It replaces PATH lookup, the installed
 * copy and the consent dialog. A packaged build never reads it.
 */
function readLinkImportSeam({ isPackaged, env }) {
	if (isPackaged !== false) return null;
	const binary = env.CCUT_TEST_YTDLP;
	return typeof binary === "string" && binary !== "" && path.isAbsolute(binary) ? binary : null;
}

function envPathOf(env) {
	for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === "PATH") return value;
	return undefined;
}

/** The first stdout line of `yt-dlp --ignore-config --version`, run like a job (env, cwd). */
async function runVersionWith({ spawn, platform, binary, env, cwd, signal }) {
	const lines = [];
	const run = runProcess({
		spawn,
		binary,
		args: ["--ignore-config", "--version"],
		cwd,
		env,
		platform,
		limits: { wallMs: VERSION_TIMEOUT_MS, idleMs: VERSION_TIMEOUT_MS, maxLineChars: 256 },
		onLine: ({ stream, line }) => {
			if (stream === "stdout" && lines.length < 4) lines.push(line);
		},
	});
	const stop = () => run.cancel();
	signal?.addEventListener("abort", stop, { once: true });
	const outcome = await run.done;
	signal?.removeEventListener("abort", stop);
	return outcome.reason === "exit" && outcome.exitCode === 0 && lines.length > 0 ? `${lines[0]}\n` : null;
}

/**
 * The consent dialog. `outdated` ({ binary, version } of a yt-dlp on PATH older than MIN_VERSION,
 * or null) changes the first paragraph: it names that copy, its version, the one needed and how
 * to update it instead. Its path is the user's own and only shown in this main-process dialog.
 */
function consentOptions({ asset, binDir, signal, outdated, update = null, signingKey }) {
	const fingerprint = signingKey.fingerprint.match(/.{4}/g).join(" ");
	const outdatedIntro = [
		`The yt-dlp found at ${JSON.stringify(outdated?.binary)} is version ${outdated?.version}; Ccut needs ${MIN_VERSION} or newer.`,
		'You can update it instead (for example "yt-dlp -U", "pip install -U yt-dlp" or your package manager) and import again.',
	];
	const missingIntro = ["Importing from a YouTube or TikTok link needs yt-dlp, a free command-line downloader. It was not found on this computer."];
	const updateIntro = [`Ccut's own copy of yt-dlp is version ${update?.current}; the newest release is ${update?.latest} (as GitHub reports it). Ccut never changes a yt-dlp that you installed yourself.`];
	let intro = missingIntro;
	if (update) intro = updateIntro;
	else if (outdated) intro = outdatedIntro;
	return {
		type: "question",
		buttons: [update ? "Update yt-dlp" : "Download yt-dlp", "Cancel"],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
		title: "Import from link",
		message: update ? "Update Ccut's copy of yt-dlp?" : outdated ? "The yt-dlp on this computer is too old. Download a current copy for Ccut?" : "Download yt-dlp to import from links?",
		detail: [
			...intro,
			"",
			`Ccut can download the official release file "${asset}" from ${RELEASES} (the latest release${update ? ", replacing the copy there" : ""}; its size is not known in advance, the download stops at ${TOOL_LIMITS.maxBinaryBytes / (1024 * 1024)} MB) and keep it in:`,
			binDir,
			"",
			`Before anything is installed, the release's SHA2-256SUMS file must carry a valid signature by the yt-dlp signing key built into Ccut (fingerprint ${fingerprint}), and the file's SHA-256 checksum must match it.`,
			"yt-dlp is released under the Unlicense (public domain); the standalone file also contains Python and other libraries under their own licenses.",
		].join("\n"),
		signal,
	};
}

/**
 * Registers the handlers. Electron's ipcMain, dialog and app, the window getter, the app
 * origin, the environment and a logger are required; spawn, fetch, platform, arch, limits and
 * the release signing key have real defaults and are injected by the tests (main.js passes none
 * of them: the signing key is always yt-dlp's embedded one there).
 */
function registerLinkImportIpc({
	ipcMain,
	dialog,
	app,
	getWindow,
	origin,
	env,
	log,
	spawn = childProcess.spawn,
	fetch = globalThis.fetch,
	platform = process.platform,
	arch = process.arch,
	limits = {},
	signingKey = YT_DLP_SIGNING_KEY,
}) {
	const userData = app.getPath("userData");
	const root = path.join(userData, "link-import");
	const binDir = path.join(userData, "bin");
	const seam = readLinkImportSeam({ isPackaged: app.isPackaged, env });
	if (seam) log(`[ccut] link import test seam ON: ${seam} is used as yt-dlp, no consent dialog`);

	const confirmDownload = async ({ asset, signal, outdated }) => {
		const win = getWindow();
		const options = consentOptions({ asset, binDir, signal, outdated, signingKey });
		const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		return response === 0;
	};

	const confirmUpdate = async ({ asset, current, latest }) => {
		const win = getWindow();
		const options = consentOptions({ asset, binDir, outdated: null, update: { current, latest }, signingKey });
		const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		return response === 0;
	};

	// Is the yt-dlp on PATH one a job would use (at or above MIN_VERSION)? Asked the way a job asks:
	// a throwaway directory like a job's (its name is one the startup sweep knows), the same
	// environment and time limit. Only the answer yes/no leaves this function.
	const usablePathTool = async () => {
		const binary = await findOnPath({ envPath: envPathOf(env), platform, log });
		if (!binary) return false;
		const dir = path.join(root, crypto.randomBytes(16).toString("hex"));
		try {
			await fsp.mkdir(root, { recursive: true, mode: 0o700 });
			await fsp.mkdir(dir, { mode: 0o700 });
			await fsp.mkdir(path.join(dir, "home"), { mode: 0o700 });
			await fsp.mkdir(path.join(dir, "tmp"), { mode: 0o700 });
			const text = await runVersionWith({ spawn, platform, binary, env: buildChildEnv({ parentEnv: env, platform, jobDir: dir }), cwd: dir });
			const version = parseVersion(text);
			return version !== null && compareVersions(version, parseVersion(MIN_VERSION)) >= 0;
		} catch {
			return false;
		} finally {
			await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	};

	const resolveTool = seam
		? async () => ({ binary: seam, version: "test", source: "seam" })
		: createToolResolver({
				findOnPath: () => findOnPath({ envPath: envPathOf(env), platform, log }),
				runVersion: ({ binary, env: childEnv, cwd, signal }) => runVersionWith({ spawn, platform, binary, env: childEnv, cwd, signal }),
				readManaged: () => readManagedBinary({ binDir, platform, signingKey }),
				confirmDownload,
				install: ({ signal }) => installManagedBinary({ fetch, binDir, platform, arch, signal, signingKey }),
				platform,
				arch,
				log,
			});

	// Combining YouTube's two streams needs mediabunny in the main process: in the packaged app
	// (or when it is not known to be unpackaged) only the vendored bundle next to the worker.
	const mediabunnyPath = resolveMediabunnyPath({ workerDir: path.dirname(muxWorkerPath()), packaged: app.isPackaged !== false });
	const jobs = new LinkImportJobs({ root, spawn, platform, parentEnv: env, resolveTool, log, fsApi: fsp, fsSync: fs, limits: { ...limits }, mediabunnyPath, isUpdating: () => updates.isUpdating() });
	// The test seam has no managed copy: nothing to update.
	const updates = createUpdateService({
		binDir,
		platform,
		arch,
		readManaged: async () => (seam ? null : readManagedBinary({ binDir, platform, signingKey })),
		usablePathTool,
		fetchLatestTag: ({ signal }) => resolveLatestTag({ fetch, signal }),
		confirmUpdate,
		install: ({ newerThan }) => installManagedBinary({ fetch, binDir, platform, arch, signingKey, newerThan }),
		isBusy: () => jobs.isBusy(),
		log,
	});
	const ready = Promise.all([jobs.sweepLeftovers(), sweepToolLeftovers({ binDir })]).catch(() => {});

	// A page that reloads, navigates away, crashes or closes loses its job (and its directory).
	const watched = new WeakSet();
	const watch = (webContents) => {
		if (watched.has(webContents)) return;
		watched.add(webContents);
		const id = webContents.id;
		const drop = () => void jobs.abortOwner(id).catch(() => {});
		webContents.on("did-start-navigation", (details) => {
			if (details && details.isMainFrame && !details.isSameDocument) drop();
		});
		webContents.on("render-process-gone", drop);
		webContents.on("destroyed", drop);
	};

	const handle = (channel, handler) => {
		ipcMain.handle(channel, async (event, ...args) => {
			const win = getWindow();
			const webContents = win && !win.isDestroyed() ? win.webContents : null;
			if (!isTrustedSender({ event, webContents, origin })) throw new LinkImportError("FORBIDDEN");
			watch(webContents);
			try {
				return await handler({ ownerId: webContents.id, request: args[0] });
			} catch (error) {
				if (error instanceof LinkImportError) throw error;
				// Anything else may carry a path or system text: logged here, never sent.
				log(`[ccut] link import ${channel} failed: ${error && error.stack ? error.stack : error}`);
				throw new LinkImportError("FAILED");
			}
		});
	};

	const tokenOf = (request) => {
		const parsed = parseTokenRequest(request);
		if (!parsed) throw new LinkImportError("INVALID");
		return parsed.token;
	};

	handle(CHANNELS.start, async ({ ownerId, request }) => {
		const parsed = parseStartRequest(request);
		if (!parsed) return { ok: false, code: "invalid" };
		return jobs.start({ ownerId, ...parsed });
	});
	handle(CHANNELS.status, async ({ ownerId, request }) => jobs.status({ ownerId, token: tokenOf(request) }));
	handle(CHANNELS.cancel, async ({ ownerId, request }) => jobs.cancel({ ownerId, token: tokenOf(request) }));
	handle(CHANNELS.release, async ({ ownerId, request }) => jobs.release({ ownerId, token: tokenOf(request) }));
	handle(CHANNELS.read, async ({ ownerId, request }) => {
		const parsed = parseReadRequest(request);
		if (!parsed) throw new LinkImportError("INVALID");
		return jobs.read({ ownerId, ...parsed });
	});

	// No payload on either: anything the page sends along is refused, not ignored.
	const noPayload = (request) => {
		if (request !== undefined) throw new LinkImportError("INVALID");
	};
	handle(CHANNELS.updateCheck, async ({ request }) => {
		noPayload(request);
		return { version: await updates.check() };
	});
	handle(CHANNELS.update, async ({ request }) => {
		noPayload(request);
		return updates.update();
	});

	const expiry = setInterval(() => void jobs.expire().catch(() => {}), EXPIRE_INTERVAL_MS);
	expiry.unref?.();

	return {
		jobs,
		/** Resolves when the startup sweep is done (tests). */
		ready,
		/** On quit: synchronous, the app does not wait for promises. */
		shutdown() {
			clearInterval(expiry);
			jobs.shutdownSync();
		},
	};
}

module.exports = { CHANNELS, JOB_LIMITS, parseReadRequest, parseStartRequest, readLinkImportSeam, registerLinkImportIpc };
