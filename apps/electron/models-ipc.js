// Smart cutout models (round 9): the one small ONNX file the "Smart cutout" feature needs, downloaded
// on the owner's click and kept in <userData>/models/<id>/model.onnx. Five channels, each checks the
// sender first (the app's own main frame, isTrustedSender), then the payload. The page can only name
// a model id from MODELS below; it never names a URL or a path. The bytes reach the page's worker
// only through `read`, after the file's size and SHA-256 were checked again. The download is
// stems-download.js `downloadVerified` as it is (https, host allow-list on every redirect hop, size
// cap, SHA-256, 0600 temp file); the install is an atomic rename. Errors to the page: "CCUT_MODELS:<CODE>".
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { DownloadError, downloadVerified } = require("./stems-download");
const { isTrustedSender } = require("./export-files");

const CHANNELS = Object.freeze({
	status: "ccut-models:status",
	install: "ccut-models:install",
	cancelInstall: "ccut-models:cancel-install",
	remove: "ccut-models:remove",
	read: "ccut-models:read",
});

// The model file is ONE constant per model: changing the model (for instance if the licence of this
// file cannot be confirmed) is this table plus the web side's SMART_CUTOUT_MODEL (same id and sha256).
const MODELS = Object.freeze({
	u2netp: Object.freeze({
		id: "u2netp",
		label: "U²-Net-P (small, 4.6 MB)",
		url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
		sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
		sizeBytes: 4_574_861,
		hosts: Object.freeze(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]),
	}),
});

class ModelsError extends Error {
	constructor(code) {
		super(`CCUT_MODELS:${code}`);
		this.name = "ModelsError";
		this.code = code;
	}
}

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/** { modelId } for a known model, or null. */
function parseModelRequest(request) {
	if (!isPlainObject(request) || typeof request.modelId !== "string") return null;
	return Object.hasOwn(MODELS, request.modelId) ? { modelId: request.modelId } : null;
}

function registerModelsIpc({ ipcMain, dialog, app, getWindow, origin, log, fetch = globalThis.fetch, fsApi = fsp, models = MODELS }) {
	const root = path.join(app.getPath("userData"), "models");
	const dirOf = (id) => path.join(root, id);
	const fileOf = (id) => path.join(dirOf(id), "model.onnx");
	/** modelId -> { controller, percent } while a download runs. */
	const installing = new Map();

	const confirm = async (options) => {
		const win = getWindow();
		const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		return response === 0;
	};

	/** The installed bytes, if the file is exactly the pinned one; null otherwise. */
	async function readVerified(model) {
		let bytes;
		try {
			const stat = await fsApi.stat(fileOf(model.id));
			if (!stat.isFile() || stat.size !== model.sizeBytes) return null;
			bytes = await fsApi.readFile(fileOf(model.id));
		} catch {
			return null;
		}
		return bytes.byteLength === model.sizeBytes && crypto.createHash("sha256").update(bytes).digest("hex") === model.sha256 ? bytes : null;
	}

	/** modelId -> { mtimeMs, size, ok }: the file is hashed again only when it changed on disk. */
	const verifiedCache = new Map();
	async function isVerified(model) {
		let stat;
		try {
			stat = await fsApi.stat(fileOf(model.id));
		} catch {
			return false;
		}
		if (!stat.isFile() || stat.size !== model.sizeBytes) return false;
		const cached = verifiedCache.get(model.id);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ok;
		const ok = (await readVerified(model)) !== null;
		verifiedCache.set(model.id, { mtimeMs: stat.mtimeMs, size: stat.size, ok });
		return ok;
	}

	const statusOf = async (model) => {
		const installed = await isVerified(model);
		const running = installing.get(model.id);
		return { modelId: model.id, label: model.label, sizeBytes: model.sizeBytes, installed, installing: Boolean(running), percent: running ? running.percent : null };
	};

	async function install(model) {
		if (installing.has(model.id)) return { ok: false, code: "busy" };
		// The slot is taken BEFORE the question: a second install meanwhile is "busy", not a second dialog.
		const controller = new AbortController();
		const job = { controller, percent: 0 };
		installing.set(model.id, job);
		try {
			if (await isVerified(model)) return { ok: true };
			return await installReserved(model, job);
		} finally {
			installing.delete(model.id);
		}
	}

	async function installReserved(model, job) {
		const { controller } = job;
		const accepted = await confirm({
			type: "question",
			title: "Download the smart cutout model?",
			message: `Download the smart cutout model (${model.label})?`,
			detail: `${(model.sizeBytes / 1_000_000).toFixed(1)} MB (${model.sizeBytes.toLocaleString("en-US")} bytes) from ${new URL(model.url).hostname}. The file is checked against a fixed SHA-256 before it is used. Nothing from your projects is uploaded. Licence: U²-Net is Apache-2.0, but the terms of this particular download (the rembg release file) have not been confirmed.`,
			buttons: ["Download", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		});
		if (!accepted) return { ok: false, code: "consent-declined" };
		const temp = path.join(dirOf(model.id), `.download-${crypto.randomBytes(8).toString("hex")}`);
		try {
			await fsApi.mkdir(dirOf(model.id), { recursive: true, mode: 0o700 });
			await downloadVerified({
				fetch,
				fsApi,
				url: model.url,
				hosts: model.hosts,
				destPath: temp,
				expectedSha256: model.sha256,
				expectedSize: model.sizeBytes,
				signal: controller.signal,
				onProgress: (bytes) => {
					job.percent = Math.min(100, Math.floor((bytes / model.sizeBytes) * 100));
				},
			});
			await fsApi.rename(temp, fileOf(model.id));
			return { ok: true };
		} catch (error) {
			await fsApi.unlink(temp).catch(() => {});
			if (error instanceof DownloadError) return { ok: false, code: error.code === "cancelled" ? "cancelled" : error.code };
			log(`[ccut] models install failed: ${error && error.stack ? error.stack : error}`);
			return { ok: false, code: "install-failed" };
		}
	}

	// A crash or kill during a download leaves a `.download-*` file behind: removed at start.
	const swept = (async () => {
		try {
			for (const id of await fsApi.readdir(root)) {
				const dir = path.join(root, id);
				for (const name of await fsApi.readdir(dir).catch(() => [])) {
					if (name.startsWith(".download-")) await fsApi.unlink(path.join(dir, name)).catch(() => {});
				}
			}
		} catch {}
	})();

	const handle = (channel, handler) => {
		ipcMain.handle(channel, async (event, ...args) => {
			const win = getWindow();
			const webContents = win && !win.isDestroyed() ? win.webContents : null;
			if (!isTrustedSender({ event, webContents, origin })) throw new ModelsError("FORBIDDEN");
			const parsed = parseModelRequest(args[0]);
			if (!parsed) throw new ModelsError("INVALID");
			try {
				return await handler(models[parsed.modelId]);
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				log(`[ccut] models ${channel} failed: ${error && error.stack ? error.stack : error}`);
				throw new ModelsError("FAILED");
			}
		});
	};

	handle(CHANNELS.status, (model) => statusOf(model));
	handle(CHANNELS.install, (model) => install(model));
	handle(CHANNELS.cancelInstall, async (model) => {
		const running = installing.get(model.id);
		running?.controller.abort(new Error("cancelled"));
		return { ok: Boolean(running) };
	});
	handle(CHANNELS.remove, async (model) => {
		if (installing.has(model.id)) return { ok: false, code: "busy" };
		const accepted = await confirm({
			type: "question",
			title: "Remove the smart cutout model?",
			message: `Remove the smart cutout model (${model.label})?`,
			detail: "You can download it again later.",
			buttons: ["Remove", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		});
		if (!accepted) return { ok: false, code: "consent-declined" };
		await fsApi.rm(dirOf(model.id), { recursive: true, force: true });
		return { ok: true };
	});
	handle(CHANNELS.read, async (model) => {
		const bytes = await readVerified(model);
		if (!bytes) throw new ModelsError("MISSING");
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	});

	return {
		/** Resolves when the start-up sweep is done (tests). */
		ready: swept,
		shutdown() {
			for (const job of installing.values()) job.controller.abort(new Error("quit"));
		},
	};
}

module.exports = { CHANNELS, MODELS, ModelsError, parseModelRequest, registerModelsIpc };
