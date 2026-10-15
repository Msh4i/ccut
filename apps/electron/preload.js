// Bridges between the page and the main process. window.ccutExport: five functions
// for exporting a video to a file the user picks (export-v2 plan, section d). No raw
// ipcRenderer, no read API, no path argument.
//
// Sandboxed preload: it can require "electron" and nothing of the app's own, so the checks
// below live in this file. They run BEFORE ipcRenderer.invoke: the main process has to
// deserialize a message before it can refuse it, so a huge or hostile payload is stopped here
// (the main process still checks everything again). Only the known fields are sent, each of the
// expected type. Errors have the shape the main process uses ("CCUT_EXPORT:<CODE>"); the numbers
// repeat export-files.js (LIMITS.maxChunkBytes, MAX_SUGGESTED_NAME_CHARS), preload.test.js locks them.
const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = {
	begin: "ccut-export:begin",
	write: "ccut-export:write",
	finish: "ccut-export:finish",
	abort: "ccut-export:abort",
	reveal: "ccut-export:reveal",
};

const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_SUGGESTED_NAME_CHARS = 1000;
const MAX_CONTAINER_CHARS = 16; // "mp4", "webm"
const MAX_TOKEN_CHARS = 128; // a UUID is 36

const invalid = () => new Error("CCUT_EXPORT:INVALID");

// The page's objects may come from another JavaScript realm (the contextBridge copies them,
// but this must not depend on it): no `=== Object.prototype`, no `instanceof Uint8Array`.
function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function isUint8Array(value) {
	return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

const isToken = (value) => typeof value === "string" && value.length <= MAX_TOKEN_CHARS;

async function begin(request) {
	if (!isPlainObject(request)) return { ok: false, reason: "invalid" };
	const { suggestedName, container, estimatedBytes } = request;
	if (
		typeof suggestedName !== "string" ||
		suggestedName.length > MAX_SUGGESTED_NAME_CHARS ||
		typeof container !== "string" ||
		container.length > MAX_CONTAINER_CHARS ||
		typeof estimatedBytes !== "number"
	) {
		return { ok: false, reason: "invalid" };
	}
	return ipcRenderer.invoke(CHANNELS.begin, { suggestedName, container, estimatedBytes });
}

async function write(request) {
	if (!isPlainObject(request)) throw invalid();
	const { token, position, data } = request;
	if (!isToken(token) || typeof position !== "number" || !isUint8Array(data)) throw invalid();
	// A view is sent with its whole backing buffer: that is what must stay small.
	if (data.byteLength > MAX_CHUNK_BYTES || data.buffer.byteLength > MAX_CHUNK_BYTES) throw invalid();
	return ipcRenderer.invoke(CHANNELS.write, { token, position, data });
}

async function finish(request) {
	if (!isPlainObject(request)) throw invalid();
	const { token, totalBytes } = request;
	if (!isToken(token) || typeof totalBytes !== "number") throw invalid();
	return ipcRenderer.invoke(CHANNELS.finish, { token, totalBytes });
}

async function abort(request) {
	if (!isPlainObject(request) || !isToken(request.token)) throw invalid();
	return ipcRenderer.invoke(CHANNELS.abort, { token: request.token });
}

async function reveal(request) {
	if (!isPlainObject(request) || !isToken(request.token)) return false;
	return ipcRenderer.invoke(CHANNELS.reveal, { token: request.token });
}

contextBridge.exposeInMainWorld("ccutExport", Object.freeze({ begin, write, finish, abort, reveal }));

// window.ccutSystem: a second, separate bridge (the notes at the top are about window.ccutExport).
// Memory figures for the adaptive frame cache, read only (system-memory-ipc.js): no argument is
// ever sent, whatever the page passes, and a failing call (no handler, window closing) answers
// null instead of rejecting. The channel name repeats system-memory-ipc.js CHANNEL (preload.test.js).
const SYSTEM_MEMORY_CHANNEL = "ccut-system:memory-info";

async function memoryInfo() {
	try {
		return await ipcRenderer.invoke(SYSTEM_MEMORY_CHANNEL);
	} catch {
		return null;
	}
}

contextBridge.exposeInMainWorld("ccutSystem", Object.freeze({ memoryInfo }));

// window.ccutLinkImport: import a video or its audio from a YouTube/TikTok link
// (link-import-ipc.js). The page sends a URL, a mode and a quality, then polls a token; the
// main process validates the URL, asks before downloading yt-dlp, runs it and hands the file
// back in chunks of at most 8 MiB. Same rules as above: checked here before invoke, known
// fields only, checked again in main. The numbers repeat link-import-jobs.js (LIMITS.maxReadBytes),
// link-import-url.js (MAX_URL_CHARS) and link-import-args.js; link-import-preload.test.js locks them.
{
	const LINK_CHANNELS = {
		start: "ccut-link-import:start",
		status: "ccut-link-import:status",
		cancel: "ccut-link-import:cancel",
		read: "ccut-link-import:read",
		release: "ccut-link-import:release",
		updateCheck: "ccut-link-import:update-check",
		update: "ccut-link-import:update",
	};
	const MAX_READ_BYTES = 8 * 1024 * 1024;
	const MAX_URL_CHARS = 2048;
	const LINK_MODES = ["video", "audio"];
	const LINK_QUALITIES = ["best", "1080", "720"];
	const linkError = (code) => new Error(`CCUT_LINK_IMPORT:${code}`);
	const tokenRequest = (request) => {
		if (!isPlainObject(request) || !isToken(request.token)) throw linkError("INVALID");
		return { token: request.token };
	};

	const start = async (request) => {
		if (!isPlainObject(request)) return { ok: false, code: "invalid" };
		const { url, mode, quality } = request;
		if (typeof url !== "string" || url.length > MAX_URL_CHARS || !LINK_MODES.includes(mode) || !LINK_QUALITIES.includes(quality)) {
			return { ok: false, code: "invalid" };
		}
		return ipcRenderer.invoke(LINK_CHANNELS.start, { url, mode, quality });
	};
	const status = async (request) => ipcRenderer.invoke(LINK_CHANNELS.status, tokenRequest(request));
	const cancel = async (request) => ipcRenderer.invoke(LINK_CHANNELS.cancel, tokenRequest(request));
	const release = async (request) => ipcRenderer.invoke(LINK_CHANNELS.release, tokenRequest(request));
	const read = async (request) => {
		const { token } = tokenRequest(request);
		const { offset, length } = request;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_READ_BYTES) {
			throw linkError("INVALID");
		}
		const bytes = await ipcRenderer.invoke(LINK_CHANNELS.read, { token, offset, length });
		if (!isUint8Array(bytes) || bytes.byteLength > length) throw linkError("READ_FAILED");
		return bytes;
	};

	// L9 (link-import-update.js): no argument on either call; what comes back is a release tag
	// or one of a fixed set of codes, nothing else (checked here and again by the page).
	const RELEASE_TAG = /^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,10})?$/;
	const UPDATE_CODES = ["tool-missing", "consent-declined", "tool-download-failed", "tool-verify-failed", "tool-signature-failed", "busy", "up-to-date"];
	const checkUpdate = async () => {
		const answer = await ipcRenderer.invoke(LINK_CHANNELS.updateCheck);
		return isPlainObject(answer) && typeof answer.version === "string" && RELEASE_TAG.test(answer.version) ? answer.version : null;
	};
	const updateTool = async () => {
		const answer = await ipcRenderer.invoke(LINK_CHANNELS.update);
		if (isPlainObject(answer) && answer.ok === true && typeof answer.version === "string" && RELEASE_TAG.test(answer.version)) {
			return { ok: true, version: answer.version };
		}
		if (isPlainObject(answer) && answer.ok === false && typeof answer.code === "string" && UPDATE_CODES.includes(answer.code)) {
			return { ok: false, code: answer.code };
		}
		throw linkError("READ_FAILED");
	};

	contextBridge.exposeInMainWorld("ccutLinkImport", Object.freeze({ start, status, cancel, read, release, checkUpdate, updateTool }));
}

// window.ccutStems: separate a song into drums, bass, other and vocals (stems-ipc.js). The
// page installs the engine (the consent dialog is shown by the main process), streams the clip's
// PCM in chunks of at most 8 MiB, polls a token and reads each stem back as Int16 bytes. Same
// rules as above: checked here before invoke, known fields only, checked again in main. The
// numbers repeat stems-jobs.js (LIMITS.maxChunkBytes/maxReadBytes, SAMPLE_RATES, MAX_SECONDS,
// STEMS); stems-preload.test.js locks them.
{
	const STEMS_CHANNELS = {
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
	};
	const MAX_STEMS_CHUNK_BYTES = 8 * 1024 * 1024;
	const MAX_STEMS_READ_BYTES = 8 * 1024 * 1024;
	const STEMS_SAMPLE_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000];
	const STEMS_MAX_SECONDS = 900;
	const STEM_NAMES = ["drums", "bass", "other", "vocals"];
	const stemsError = (code) => new Error(`CCUT_STEMS:${code}`);
	const stemsTokenRequest = (request) => {
		if (!isPlainObject(request) || !isToken(request.token)) throw stemsError("INVALID");
		return { token: request.token };
	};

	// No argument is ever sent on these four, whatever the page passes.
	const stemsStatus = async () => ipcRenderer.invoke(STEMS_CHANNELS.status);
	const stemsInstall = async () => ipcRenderer.invoke(STEMS_CHANNELS.install);
	const stemsCancelInstall = async () => ipcRenderer.invoke(STEMS_CHANNELS.cancelInstall);
	const stemsRemoveEngine = async () => ipcRenderer.invoke(STEMS_CHANNELS.removeEngine);

	const stemsBegin = async (request) => {
		if (!isPlainObject(request)) return { ok: false, code: "invalid" };
		const { frames, sampleRate } = request;
		if (!Number.isSafeInteger(frames) || frames < 1 || !STEMS_SAMPLE_RATES.includes(sampleRate)) return { ok: false, code: "invalid" };
		if (frames > STEMS_MAX_SECONDS * sampleRate) return { ok: false, code: "too-long" };
		return ipcRenderer.invoke(STEMS_CHANNELS.begin, { frames, sampleRate });
	};
	const stemsWrite = async (request) => {
		if (!isPlainObject(request)) throw stemsError("INVALID");
		const { token, position, data } = request;
		if (!isToken(token) || !Number.isSafeInteger(position) || position < 0 || !isUint8Array(data)) throw stemsError("INVALID");
		// A view is sent with its whole backing buffer: that is what must stay small.
		if (data.byteLength < 1 || data.byteLength > MAX_STEMS_CHUNK_BYTES || data.buffer.byteLength > MAX_STEMS_CHUNK_BYTES) throw stemsError("INVALID");
		return ipcRenderer.invoke(STEMS_CHANNELS.write, { token, position, data });
	};
	const stemsRun = async (request) => {
		if (!isPlainObject(request) || !isToken(request.token)) return { ok: false, code: "invalid" };
		return ipcRenderer.invoke(STEMS_CHANNELS.run, { token: request.token });
	};
	const stemsJobStatus = async (request) => ipcRenderer.invoke(STEMS_CHANNELS.jobStatus, stemsTokenRequest(request));
	const stemsCancel = async (request) => ipcRenderer.invoke(STEMS_CHANNELS.cancel, stemsTokenRequest(request));
	const stemsRelease = async (request) => ipcRenderer.invoke(STEMS_CHANNELS.release, stemsTokenRequest(request));
	const stemsRead = async (request) => {
		const { token } = stemsTokenRequest(request);
		const { stem, offset, length } = request;
		if (typeof stem !== "string" || !STEM_NAMES.includes(stem)) throw stemsError("INVALID");
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_STEMS_READ_BYTES) throw stemsError("INVALID");
		const bytes = await ipcRenderer.invoke(STEMS_CHANNELS.read, { token, stem, offset, length });
		if (!isUint8Array(bytes) || bytes.byteLength > length) throw stemsError("READ_FAILED");
		return bytes;
	};

	contextBridge.exposeInMainWorld(
		"ccutStems",
		Object.freeze({
			status: stemsStatus,
			install: stemsInstall,
			cancelInstall: stemsCancelInstall,
			removeEngine: stemsRemoveEngine,
			begin: stemsBegin,
			write: stemsWrite,
			run: stemsRun,
			jobStatus: stemsJobStatus,
			read: stemsRead,
			cancel: stemsCancel,
			release: stemsRelease,
		}),
	);
}

// window.ccutModels: the "Smart cutout" model file (models-ipc.js). The page asks for the status,
// installs (the consent dialog is shown by the main process), cancels, removes, and reads the verified
// model bytes for its worker. It names a model id only; the id list repeats models-ipc.js MODELS
// (models-preload.test.js locks the channel names).
{
	const MODELS_CHANNELS = {
		status: "ccut-models:status",
		install: "ccut-models:install",
		cancelInstall: "ccut-models:cancel-install",
		remove: "ccut-models:remove",
		read: "ccut-models:read",
	};
	const MODEL_IDS = ["u2netp"];
	const modelRequest = (request) => {
		if (!isPlainObject(request) || !MODEL_IDS.includes(request.modelId)) throw new Error("CCUT_MODELS:INVALID");
		return { modelId: request.modelId };
	};
	const call = (channel) => async (request) => ipcRenderer.invoke(channel, modelRequest(request));
	contextBridge.exposeInMainWorld(
		"ccutModels",
		Object.freeze({
			status: call(MODELS_CHANNELS.status),
			install: call(MODELS_CHANNELS.install),
			cancelInstall: call(MODELS_CHANNELS.cancelInstall),
			remove: call(MODELS_CHANNELS.remove),
			read: call(MODELS_CHANNELS.read),
		}),
	);
}

// window.ccutMcp: the "Integrations" switch and the agent bridge (mcp-ipc.js). The settings page
// reads the state, turns the MCP server on or off and manages the connected agents; the editor
// listens for the requests an agent makes (onRequest) and answers each one. The page never sees a
// path or a socket. The token appears only inside the snippets the owner copies. Channel names
// repeat mcp-ipc.js (CHANNELS); mcp-preload.test.js locks them.
{
	const MCP = {
		state: "ccut-mcp:state",
		setEnabled: "ccut-mcp:set-enabled",
		regenerateToken: "ccut-mcp:regenerate-token",
		snippets: "ccut-mcp:snippets",
		disconnect: "ccut-mcp:disconnect",
		setColor: "ccut-mcp:set-color",
		forget: "ccut-mcp:forget",
		log: "ccut-mcp:log",
		stateChanged: "ccut-mcp:state-changed",
		activity: "ccut-mcp:activity",
		request: "ccut-mcp:request",
		response: "ccut-mcp:response",
	};
	const MCP_COLORS = ["orange", "blue", "violet"];
	const MAX_MCP_NAME_CHARS = 40;
	const MAX_MCP_ID_CHARS = 64;
	const mcpInvalid = () => new Error("CCUT_MCP:INVALID");

	// The listener wrappers hand the page only the payload, never the Electron event.
	const subscribe = (channel, listener) => {
		if (typeof listener !== "function") throw mcpInvalid();
		const wrapped = (_event, payload) => listener(payload);
		ipcRenderer.on(channel, wrapped);
		return () => ipcRenderer.removeListener(channel, wrapped);
	};

	contextBridge.exposeInMainWorld(
		"ccutMcp",
		Object.freeze({
			state: async () => ipcRenderer.invoke(MCP.state),
			setEnabled: async (enabled) => {
				if (typeof enabled !== "boolean") throw mcpInvalid();
				return ipcRenderer.invoke(MCP.setEnabled, { enabled });
			},
			regenerateToken: async () => ipcRenderer.invoke(MCP.regenerateToken),
			snippets: async () => ipcRenderer.invoke(MCP.snippets),
			disconnect: async (id) => {
				if (typeof id !== "string" || id.length < 1 || id.length > MAX_MCP_ID_CHARS) throw mcpInvalid();
				return ipcRenderer.invoke(MCP.disconnect, { id });
			},
			setColor: async (name, color) => {
				if (typeof name !== "string" || name.length < 1 || name.length > MAX_MCP_NAME_CHARS || !MCP_COLORS.includes(color)) throw mcpInvalid();
				return ipcRenderer.invoke(MCP.setColor, { name, color });
			},
			forget: async (name) => {
				if (typeof name !== "string" || name.length < 1 || name.length > MAX_MCP_NAME_CHARS) throw mcpInvalid();
				return ipcRenderer.invoke(MCP.forget, { name });
			},
			log: async () => ipcRenderer.invoke(MCP.log),
			onStateChanged: (listener) => subscribe(MCP.stateChanged, listener),
			onActivity: (listener) => subscribe(MCP.activity, listener),
			// handler({ id, tool, args }) resolves the tool's result or throws a short message.
			onRequest: (handler) => {
				if (typeof handler !== "function") throw mcpInvalid();
				return subscribe(MCP.request, async (payload) => {
					if (!isPlainObject(payload) || !Number.isSafeInteger(payload.id)) return;
					// The main process told the agent this call failed once its time was up; a page that was
					// busy and only now gets to it must not run it (an edit the agent was told failed).
					if (Number.isFinite(payload.expiresAt) && Date.now() > payload.expiresAt) {
						ipcRenderer.send(MCP.response, { id: payload.id, ok: false, error: "The request had already timed out." });
						return;
					}
					try {
						const result = await handler({ id: payload.id, tool: payload.tool, args: payload.args });
						ipcRenderer.send(MCP.response, { id: payload.id, ok: true, result });
					} catch (error) {
						ipcRenderer.send(MCP.response, { id: payload.id, ok: false, error: error instanceof Error ? error.message : "The editor could not do that." });
					}
				});
			},
		}),
	);
}
