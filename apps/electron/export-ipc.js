// Export-to-disk IPC (export-v2 plan S2, section d): five channels, each one checks
// the sender, then hands over to ExportSessions (export-files.js). The renderer never
// sends a path: the only path source is the native save dialog (or, in an unpackaged
// build only, the test seam directory).
const path = require("node:path");
const {
	ExportIpcError,
	ExportSessions,
	MAX_SUGGESTED_NAME_CHARS,
	createFailingHandle,
	forceExtension,
	isTrustedSender,
	readSeamEnv,
	sanitizeBaseName,
} = require("./export-files");

const CHANNELS = Object.freeze({
	begin: "ccut-export:begin",
	write: "ccut-export:write",
	finish: "ccut-export:finish",
	abort: "ccut-export:abort",
	reveal: "ccut-export:reveal",
});

const SWEEP_INTERVAL_MS = 60_000;
const FILTERS = { mp4: { name: "MP4 video", extensions: ["mp4"] }, webm: { name: "WebM video", extensions: ["webm"] } };

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/** The begin request, or null: { suggestedName: string, container: "mp4"|"webm", estimatedBytes: number >= 0 }. */
function parseBeginRequest(request) {
	if (!isPlainObject(request)) return null;
	const { suggestedName, container, estimatedBytes } = request;
	if (typeof suggestedName !== "string" || suggestedName.length > MAX_SUGGESTED_NAME_CHARS) return null;
	if (container !== "mp4" && container !== "webm") return null;
	if (typeof estimatedBytes !== "number" || !Number.isFinite(estimatedBytes) || estimatedBytes < 0) return null;
	return { suggestedName, container, estimatedBytes };
}

/**
 * Registers the handlers. `deps` are Electron's ipcMain, dialog, shell and app, the
 * window getter, node:fs and node:fs/promises, the app origin, the environment and a
 * logger; all injected so the wiring can be tested without Electron.
 */
function registerExportIpc({ ipcMain, dialog, shell, app, getWindow, fs, fsp, origin, env, log, randomUUID }) {
	const seam = readSeamEnv({ isPackaged: app.isPackaged, env });
	const videosDir = () => {
		try {
			return app.getPath("videos");
		} catch {
			return app.getPath("home"); // no Videos folder known on this system
		}
	};
	if (seam) log(`[ccut] export test seam ON: files go to ${seam.dir}, no save dialog`);

	const sessions = new ExportSessions({
		fs: fsp,
		randomUUID,
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		wrapHandle: seam && seam.failAfterBytes !== null ? (handle) => createFailingHandle({ handle, failAfterBytes: seam.failAfterBytes }) : undefined,
	});

	// Every channel: only the app's own main frame; the owner is that webContents.
	const handle = (channel, handler) => {
		ipcMain.handle(channel, async (event, ...args) => {
			const win = getWindow();
			const webContents = win && !win.isDestroyed() ? win.webContents : null;
			if (!isTrustedSender({ event, webContents, origin })) throw new ExportIpcError("FORBIDDEN");
			try {
				return await handler({ win, ownerId: webContents.id, args });
			} catch (error) {
				if (error instanceof ExportIpcError) throw error;
				// Anything else (dialog, file system) may name a path: logged here, never sent.
				log(`[ccut] export ${channel} failed: ${error && error.stack ? error.stack : error}`);
				throw new ExportIpcError("WRITE_FAILED");
			}
		});
	};

	handle(CHANNELS.begin, async ({ win, ownerId, args }) => {
		const request = parseBeginRequest(args[0]);
		if (!request) return { ok: false, reason: "invalid" };
		const fileName = forceExtension(sanitizeBaseName(request.suggestedName), request.container);
		const choosePath = seam
			? async () => path.join(seam.dir, fileName)
			: async () => {
					const result = await dialog.showSaveDialog(win, {
						defaultPath: path.join(videosDir(), fileName),
						filters: [FILTERS[request.container]],
						properties: ["showOverwriteConfirmation", "createDirectory"],
					});
					return result.canceled || !result.filePath ? null : result.filePath;
				};
		return sessions.begin({ ownerId, container: request.container, choosePath });
	});

	handle(CHANNELS.write, async ({ ownerId, args }) => {
		const [request] = args;
		if (!isPlainObject(request)) throw new ExportIpcError("INVALID");
		await sessions.write({ ownerId, token: request.token, position: request.position, data: request.data });
	});

	handle(CHANNELS.finish, async ({ ownerId, args }) => {
		const [request] = args;
		if (!isPlainObject(request)) throw new ExportIpcError("INVALID");
		return sessions.finish({ ownerId, token: request.token, totalBytes: request.totalBytes });
	});

	handle(CHANNELS.abort, async ({ ownerId, args }) => {
		const [request] = args;
		if (!isPlainObject(request)) throw new ExportIpcError("INVALID");
		await sessions.abort({ ownerId, token: request.token });
	});

	handle(CHANNELS.reveal, async ({ ownerId, args }) => {
		const [request] = args;
		const finalPath = isPlainObject(request) ? sessions.revealPath({ ownerId, token: request.token }) : null;
		if (!finalPath) return false;
		if (seam) {
			await fsp.appendFile(path.join(seam.dir, "reveal.log"), `${finalPath}\n`);
		} else {
			shell.showItemInFolder(finalPath);
		}
		return true;
	});

	const sweep = setInterval(() => sessions.sweep(), SWEEP_INTERVAL_MS);
	sweep.unref?.();

	return {
		sessions,
		/** Reload, navigation away, crash or close of the window: its part files are deleted. */
		watchWindow(win) {
			const id = win.webContents.id;
			const drop = () => void sessions.abortOwner(id);
			win.webContents.on("did-start-navigation", (details) => {
				if (details.isMainFrame && !details.isSameDocument) drop();
			});
			win.webContents.on("render-process-gone", drop);
			win.webContents.on("destroyed", drop);
		},
		/** True while an export writes (or its save dialog is open): leaving would delete it. */
		hasOpenExport: () => sessions.isBusy(),
		/** On quit: synchronous, the app does not wait for promises. */
		shutdown() {
			clearInterval(sweep);
			sessions.abortAllSync({ closeSync: fs.closeSync, unlinkSync: fs.unlinkSync });
		},
	};
}

module.exports = { CHANNELS, parseBeginRequest, registerExportIpc };
