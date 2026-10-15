// Stems (round 5) IPC: eleven channels, each one checks the sender first (the app's own main
// frame, isTrustedSender from export-files.js), then the payload (plain objects, known fields,
// types), then hands over to the installer (stems-install.js) or the job manager
// (stems-jobs.js). The page sends integers, a token and PCM chunks; it gets codes, statuses and
// Int16 bytes. It never names a path, never sees one, never sees the engine's or uv's text. The
// consent dialog for installing the engine is shown here, in the main process. Errors thrown to
// the page are "CCUT_STEMS:<CODE>". Contract: docs/ccut/stems-design.md, section 4.
const childProcess = require("node:child_process");
const fsSync = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isTrustedSender } = require("./export-files");
const { createEngineRunner, resolveDriverPath, stemsPaths } = require("./stems-engine");
const { createStemsInstaller } = require("./stems-install");
const { LIMITS: JOB_LIMITS, STEMS, StemsError, StemsJobs } = require("./stems-jobs");

const CHANNELS = Object.freeze({
	status: "ccut-stems:status",
	install: "ccut-stems:install",
	cancelInstall: "ccut-stems:cancel-install",
	removeEngine: "ccut-stems:remove-engine",
	begin: "ccut-stems:begin",
	write: "ccut-stems:write",
	run: "ccut-stems:run",
	jobStatus: "ccut-stems:job-status",
	read: "ccut-stems:read",
	cancel: "ccut-stems:cancel",
	release: "ccut-stems:release",
});

const MAX_TOKEN_CHARS = 128;
const EXPIRE_INTERVAL_MS = 60_000;

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const isToken = (value) => typeof value === "string" && value.length <= MAX_TOKEN_CHARS;
const isBytes = (value) => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";

/** { frames, sampleRate } as numbers, or null. The ranges and the rate whitelist are judged by the job manager. */
function parseBeginRequest(request) {
	if (!isPlainObject(request)) return null;
	const { frames, sampleRate } = request;
	return typeof frames === "number" && typeof sampleRate === "number" ? { frames, sampleRate } : null;
}

function parseTokenRequest(request) {
	return isPlainObject(request) && isToken(request.token) ? { token: request.token } : null;
}

/** { token, position, data }: a number position and a Uint8Array whose backing buffer is small too (a view clones all of it). */
function parseWriteRequest(request) {
	if (!isPlainObject(request) || !isToken(request.token)) return null;
	const { token, position, data } = request;
	if (typeof position !== "number" || !isBytes(data)) return null;
	if (data.byteLength > JOB_LIMITS.maxChunkBytes || data.buffer.byteLength > JOB_LIMITS.maxChunkBytes) return null;
	return { token, position, data };
}

/** { token, stem, offset, length } with the right types, or null; the ranges are checked by the job manager. */
function parseReadRequest(request) {
	if (!isPlainObject(request) || !isToken(request.token)) return null;
	const { token, stem, offset, length } = request;
	if (typeof stem !== "string" || !STEMS.includes(stem) || typeof offset !== "number" || typeof length !== "number") return null;
	return { token, stem, offset, length };
}

/**
 * Registers the handlers. Electron's ipcMain, dialog and app, the window getter, the app origin
 * and a logger are required; everything else has a real default and is injected by the tests.
 * `runEngine` replaces the Python engine (tests); `pins` and `readLock` replace the shipped files.
 */
function registerStemsIpc({
	ipcMain,
	dialog,
	app,
	getWindow,
	origin,
	log,
	spawn = childProcess.spawn,
	fetch = globalThis.fetch,
	platform = process.platform,
	arch = process.arch,
	cores = os.cpus().length,
	setPriority = os.setPriority,
	pins = require("./stems-pins.json"),
	readLock = () => fsp.readFile(path.join(__dirname, "stems-requirements.lock"), "utf8"),
	runEngine,
	driverPath = resolveDriverPath(),
	limits = {},
}) {
	const userData = app.getPath("userData");
	const paths = stemsPaths({ userData });

	const confirm = async (options) => {
		const win = getWindow();
		const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		return response === 0;
	};

	// The jobs and the installer need each other's answer: a separation blocks an install and a
	// remove; an engine that is not installed (or not sound) blocks a separation.
	let jobs;
	const installer = createStemsInstaller({
		userData,
		pins,
		readLock,
		driverPath,
		spawn,
		fetch,
		confirm,
		confirmRemove: confirm, // the page cannot delete the engine without the user's click in main
		platform,
		arch,
		fsApi: fsp,
		fsSync,
		isJobBusy: () => jobs.isBusy(),
		log,
		limits: limits.install,
	});
	const engine = runEngine ?? createEngineRunner({ userData, driverPath, spawn, platform, cores, setPriority, fsApi: fsp, log, limits: limits.engine, checkpointPath: async () => installer.checkpointPath() });
	jobs = new StemsJobs({
		root: paths.root,
		// The driver and the interpreter are hashed again right before every run.
		runEngine: async (args) => ((await installer.verifyEngine()) ? engine(args) : { ok: false, code: "engine-failed" }),
		engineReady: () => installer.verifyEngine(),
		log,
		fsApi: fsp,
		fsSync,
		limits: limits.jobs,
	});
	const ready = Promise.all([jobs.sweepLeftovers(), installer.sweepLeftovers()]).catch(() => {});

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
			if (!isTrustedSender({ event, webContents, origin })) throw new StemsError("FORBIDDEN");
			watch(webContents);
			try {
				return await handler({ ownerId: webContents.id, request: args[0] });
			} catch (error) {
				if (error instanceof StemsError) throw error;
				// Anything else may carry a path or system text: logged here, never sent.
				log(`[ccut] stems ${channel} failed: ${error && error.stack ? error.stack : error}`);
				throw new StemsError("FAILED");
			}
		});
	};

	// No payload on these: anything the page sends along is refused, not ignored.
	const noPayload = (request) => {
		if (request !== undefined) throw new StemsError("INVALID");
	};
	const tokenOf = (request) => {
		const parsed = parseTokenRequest(request);
		if (!parsed) throw new StemsError("INVALID");
		return parsed.token;
	};

	handle(CHANNELS.status, async ({ request }) => {
		noPayload(request);
		return installer.status();
	});
	handle(CHANNELS.install, async ({ request }) => {
		noPayload(request);
		return installer.install();
	});
	handle(CHANNELS.cancelInstall, async ({ request }) => {
		noPayload(request);
		return installer.cancelInstall();
	});
	handle(CHANNELS.removeEngine, async ({ request }) => {
		noPayload(request);
		return installer.remove();
	});
	handle(CHANNELS.begin, async ({ ownerId, request }) => {
		const parsed = parseBeginRequest(request);
		if (!parsed) return { ok: false, code: "invalid" };
		return jobs.begin({ ownerId, ...parsed });
	});
	handle(CHANNELS.write, async ({ ownerId, request }) => {
		const parsed = parseWriteRequest(request);
		if (!parsed) throw new StemsError("INVALID");
		return jobs.write({ ownerId, ...parsed });
	});
	handle(CHANNELS.run, async ({ ownerId, request }) => {
		const parsed = parseTokenRequest(request);
		if (!parsed) return { ok: false, code: "invalid" };
		return jobs.run({ ownerId, token: parsed.token });
	});
	handle(CHANNELS.jobStatus, async ({ ownerId, request }) => jobs.status({ ownerId, token: tokenOf(request) }));
	handle(CHANNELS.read, async ({ ownerId, request }) => {
		const parsed = parseReadRequest(request);
		if (!parsed) throw new StemsError("INVALID");
		return jobs.read({ ownerId, ...parsed });
	});
	handle(CHANNELS.cancel, async ({ ownerId, request }) => jobs.cancel({ ownerId, token: tokenOf(request) }));
	handle(CHANNELS.release, async ({ ownerId, request }) => jobs.release({ ownerId, token: tokenOf(request) }));

	const expiry = setInterval(() => void jobs.expire().catch(() => {}), EXPIRE_INTERVAL_MS);
	expiry.unref?.();

	return {
		jobs,
		installer,
		/** Resolves when the start-up sweep is done (tests). */
		ready,
		/** On quit: synchronous, the app does not wait for promises. */
		shutdown() {
			clearInterval(expiry);
			jobs.shutdownSync();
			installer.shutdownSync();
		},
	};
}

module.exports = { CHANNELS, JOB_LIMITS, parseBeginRequest, parseReadRequest, parseWriteRequest, registerStemsIpc };
