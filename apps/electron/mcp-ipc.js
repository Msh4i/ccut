// MCP server (round 8) IPC: the settings of the integration, the consent question and the bridge
// between the MCP service (mcp-server.js) and the editor in the page. OFF until the owner turns it
// on in Settings > Integrations. Same rules as the other *-ipc.js modules: every channel checks
// the sender first (the app's own main frame), then the payload; the page gets plain data. Files
// (all under <userData>/mcp, mode 0600): settings.json, token, endpoint.json (the port, for the
// stdio shim). The token is shown to the owner in the page only inside the snippets to copy.
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isTrustedSender } = require("./export-files");
const { createToken } = require("./mcp-auth");
const { COLOR_NAMES, cleanName, isColorName } = require("./mcp-clients");
const { createMcpService } = require("./mcp-server");
const { loadSdk } = require("./mcp-sdk");

const CHANNELS = Object.freeze({
	state: "ccut-mcp:state",
	setEnabled: "ccut-mcp:set-enabled",
	regenerateToken: "ccut-mcp:regenerate-token",
	snippets: "ccut-mcp:snippets",
	disconnect: "ccut-mcp:disconnect",
	setColor: "ccut-mcp:set-color",
	forget: "ccut-mcp:forget",
	log: "ccut-mcp:log",
	// main -> page
	stateChanged: "ccut-mcp:state-changed",
	activity: "ccut-mcp:activity",
	request: "ccut-mcp:request",
	// page -> main (no answer)
	response: "ccut-mcp:response",
});

const CALL_TIMEOUT_MS = 30_000;
// At most one consent dialog per token in this time, whoever asks and whatever name they give.
const ASK_INTERVAL_MS = 5000;
const MAX_NAME_CHARS = 40;
// Names are strings the program chose: "constructor", "toString" and "__proto__" must be ordinary keys, never
// the object's own methods or prototype.
const hasOwn = (object, key) => Object.hasOwn(object, key);
const setOwn = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

class McpIpcError extends Error {
	constructor(code) {
		super(`CCUT_MCP:${code}`);
		this.name = "McpIpcError";
	}
}

/** POSIX shells: single quotes keep $ and backticks literal. Windows: double quotes (cmd does not expand $). */
function shellQuote({ value, platform }) {
	if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
	return platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

function mcpPaths({ userData }) {
	const root = path.join(userData, "mcp");
	return { root, settings: path.join(root, "settings.json"), token: path.join(root, "token"), endpoint: path.join(root, "endpoint.json") };
}

/** settings.json as { enabled, grants, colors }; anything unreadable or odd is the default (off, no grants). */
function parseSettings(text) {
	const base = { enabled: false, grants: {}, colors: {} };
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return base;
	}
	if (!isPlainObject(data)) return base;
	const grants = {};
	if (isPlainObject(data.grants)) {
		for (const [name, level] of Object.entries(data.grants)) if (name.length <= MAX_NAME_CHARS && (level === "read" || level === "edit")) setOwn(grants, name, level);
	}
	const colors = {};
	if (isPlainObject(data.colors)) {
		for (const [name, color] of Object.entries(data.colors)) if (name.length <= MAX_NAME_CHARS && isColorName(color)) setOwn(colors, name, color);
	}
	return { enabled: data.enabled === true, grants, colors };
}

function registerMcpIpc({ ipcMain, dialog, app, getWindow, origin, log = () => {}, fsApi = fsp, sdk, version = "0.1.0", callTimeoutMs = CALL_TIMEOUT_MS, autoStart = true, askIntervalMs = ASK_INTERVAL_MS, now = Date.now }) {
	const paths = mcpPaths({ userData: app.getPath("userData") });
	let settings = { enabled: false, grants: {}, colors: {} };
	let token = null;
	let service = null;
	let nextCallId = 1;
	const pending = new Map();

	const webContentsOf = () => {
		const win = getWindow();
		return win && !win.isDestroyed() ? win.webContents : null;
	};
	const send = (channel, payload) => {
		const webContents = webContentsOf();
		if (webContents && !webContents.isDestroyed?.()) webContents.send(channel, payload);
	};

	async function ensureDir() {
		await fsApi.mkdir(paths.root, { recursive: true, mode: 0o700 });
	}
	async function writePrivate(file, text) {
		await ensureDir();
		const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		await fsApi.writeFile(temp, text, { mode: 0o600 });
		await fsApi.rename(temp, file);
	}
	const saveSettings = () => writePrivate(paths.settings, JSON.stringify(settings, null, 2));

	async function loadToken() {
		if (token) return token;
		try {
			const stored = (await fsApi.readFile(paths.token, "utf8")).trim();
			if (/^[0-9a-f]{64}$/.test(stored)) {
				token = stored;
				return token;
			}
		} catch {}
		token = createToken();
		await writePrivate(paths.token, token);
		return token;
	}

	// The page runs the tool; the answer comes back on CHANNELS.response.
	const bridge = {
		call({ tool, args }) {
			const webContents = webContentsOf();
			if (!webContents) return Promise.reject(new Error("The Ccut window is not open."));
			const id = nextCallId++;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error("The editor did not answer in time."));
				}, callTimeoutMs);
				pending.set(id, { resolve, reject, timer });
				webContents.send(CHANNELS.request, { id, tool, args, expiresAt: now() + callTimeoutMs });
			});
		},
	};

	// One question at a time: a client that connects while the dialog is open is refused, so a
	// program with the token cannot bury the owner under dialogs.
	let asking = false;
	let lastAskedAt = -Infinity;
	// Bumped with every new token: an answer to a question asked under the old token is not remembered.
	let tokenGeneration = 0;
	async function askPermission({ clientName: rawName }) {
		// The name is only shown and remembered after it was cleaned: printable, at most 40 characters.
		const clientName = cleanName(rawName);
		const known = hasOwn(settings.grants, clientName) ? settings.grants[clientName] : undefined;
		// A name is only what the program says about itself; the token is all it has to show. So a
		// remembered "read" is kept, but "edit" is asked again at every new session.
		if (known === "read") return known;
		// Distinct from a "no": the owner is busy with another question, or was just asked.
		if (asking || now() - lastAskedAt < askIntervalMs) return "busy";
		asking = true;
		lastAskedAt = now();
		const generation = tokenGeneration;
		try {
			return await askOwner({ clientName, previous: known, generation });
		} finally {
			asking = false;
		}
	}

	async function askOwner({ clientName, previous, generation }) {
		const win = getWindow();
		const options = {
			type: "question",
			buttons: ["Deny", "Read only", "Read and edit"],
			defaultId: 0,
			cancelId: 0,
			title: "Allow an agent to connect?",
			message: previous ? `"${clientName}" was allowed to edit before. Allow it again?` : `Allow "${clientName}" to connect to Ccut?`,
			detail: "Read only: it can look at the project. Read and edit: it can also change it; every change is one undo step. The name is what the program calls itself, it is not proof of who it is: only allow what you started yourself. You can disconnect it any time in Settings > Integrations.",
			noLink: true,
		};
		const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		const level = response === 1 ? "read" : response === 2 ? "edit" : "deny";
		if (level !== "deny" && generation !== tokenGeneration) return "deny"; // the token changed while the question was open
		if (level !== "deny") {
			setOwn(settings.grants, clientName, level);
			await saveSettings().catch(() => {});
		}
		return level;
	}

	async function confirmEnable() {
		const win = getWindow();
		const options = {
			type: "question",
			buttons: ["Turn on", "Cancel"],
			defaultId: 1,
			cancelId: 1,
			title: "Let agents connect?",
			message: "Turn on the agent (MCP) server?",
			detail: "Ccut will listen on this computer only (127.0.0.1). A program that has the token can then ask to look at or change your project; you are asked for each program. You can turn it off in Settings > Integrations.",
			noLink: true,
		};
		const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		return response === 0;
	}

	const snapshot = () => ({
		enabled: settings.enabled,
		running: Boolean(service?.isRunning()),
		port: service?.getPort() ?? 0,
		clients: service?.clients() ?? [],
		grants: { ...settings.grants },
		colors: { ...settings.colors },
		colorNames: COLOR_NAMES,
	});
	const announce = () => send(CHANNELS.stateChanged, snapshot());

	// Start and stop run one at a time: two quick toggles cannot leave a listener nobody owns.
	let lifecycleChain = Promise.resolve();
	const lifecycle = (task) => {
		const run = lifecycleChain.then(task, task);
		lifecycleChain = run.catch(() => {});
		return run;
	};
	const startService = () => lifecycle(doStartService);
	const stopService = () => lifecycle(doStopService);

	async function doStartService() {
		if (service?.isRunning()) return;
		await loadToken();
		service = createMcpService({
			sdk: sdk ?? loadSdk(),
			bridge,
			getToken: () => token,
			askPermission,
			onChange: announce,
			onActivity: (event) => send(CHANNELS.activity, event),
			colorOverrides: settings.colors,
			version,
		});
		const port = await service.start();
		// The pid lets the stdio shim tell a live app from a file a crash left behind.
		await writePrivate(paths.endpoint, JSON.stringify({ port, pid: process.pid }));
		log(`[ccut] MCP server listening on 127.0.0.1:${port}`);
	}
	async function doStopService() {
		const closing = service;
		service = null;
		await closing?.stop().catch(() => {});
		await fsApi.unlink(paths.endpoint).catch(() => {});
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("The integration was turned off."));
			pending.delete(id);
		}
	}

	const handle = (channel, handler) => {
		ipcMain.handle(channel, async (event, ...args) => {
			if (!isTrustedSender({ event, webContents: webContentsOf(), origin })) throw new McpIpcError("FORBIDDEN");
			try {
				return await handler(args[0]);
			} catch (error) {
				if (error instanceof McpIpcError) throw error;
				log(`[ccut] mcp ${channel} failed: ${error?.stack ?? error}`);
				throw new McpIpcError("FAILED");
			}
		});
	};
	const noPayload = (request) => {
		if (request !== undefined) throw new McpIpcError("INVALID");
	};

	handle(CHANNELS.state, (request) => {
		noPayload(request);
		return snapshot();
	});
	handle(CHANNELS.setEnabled, async (request) => {
		if (!isPlainObject(request) || typeof request.enabled !== "boolean") throw new McpIpcError("INVALID");
		// Turning it on is the owner's click in a native dialog, not only the page's say-so: a script in the
		// page must not be able to open a door to the whole project on its own.
		return lifecycle(async () => {
			if (request.enabled && !settings.enabled && !(await confirmEnable())) return snapshot();
			settings.enabled = request.enabled;
			await saveSettings();
			if (request.enabled) await doStartService();
			else await doStopService();
			announce();
			return snapshot();
		});
	});
	handle(CHANNELS.regenerateToken, async (request) => {
		noPayload(request);
		// Every session was opened with the old token: they all end.
		await lifecycle(async () => {
			const wasRunning = Boolean(service?.isRunning());
			if (wasRunning) await doStopService();
			token = createToken();
			tokenGeneration += 1;
			await writePrivate(paths.token, token);
			// The remembered choices belonged to the old token: whoever holds the new one asks again.
			settings.grants = {};
			await saveSettings();
			if (wasRunning) await doStartService();
		});
		announce();
		return snapshot();
	});
	handle(CHANNELS.snippets, async (request) => {
		noPayload(request);
		if (!service?.isRunning()) return null;
		const url = `http://127.0.0.1:${service.getPort()}/mcp`;
		const currentToken = await loadToken();
		// Inside the packaged app the shim is unpacked next to app.asar: a plain `node` cannot read from the archive.
		const shim = path.join(__dirname, "ccut-mcp.js").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
		const userData = path.dirname(paths.root);
		const quote = (value) => shellQuote({ value, platform: process.platform });
		return {
			url,
			// The token never goes on a command line (visible in `ps` and shell history, stored in plain text by the client):
			// the shim reads it from the 0600 file in userData.
			claudeCode: `claude mcp add ccut -- node ${quote(shim)} --user-data ${quote(userData)}`,
			codex: `[mcp_servers.ccut]\ncommand = "node"\nargs = [${JSON.stringify(shim)}, "--user-data", ${JSON.stringify(userData)}]`,
			// Advanced: clients that can only speak HTTP. These carry the token.
			token: currentToken,
			claudeCodeHttp: `claude mcp add --transport http ccut ${url} --header "Authorization: Bearer ${currentToken}"`,
			json: JSON.stringify({ mcpServers: { ccut: { type: "http", url, headers: { Authorization: `Bearer ${currentToken}` } } } }, null, 2),
		};
	});
	handle(CHANNELS.disconnect, async (request) => {
		if (!isPlainObject(request) || typeof request.id !== "string" || request.id.length > 64) throw new McpIpcError("INVALID");
		const closed = (await service?.disconnect(request.id)) ?? false;
		announce();
		return closed;
	});
	handle(CHANNELS.setColor, async (request) => {
		if (!isPlainObject(request) || typeof request.name !== "string" || request.name.length > MAX_NAME_CHARS || !isColorName(request.color)) throw new McpIpcError("INVALID");
		const colorName = cleanName(request.name);
		setOwn(settings.colors, colorName, request.color);
		service?.setColor({ name: colorName, color: request.color });
		await saveSettings();
		announce();
		return true;
	});
	handle(CHANNELS.forget, async (request) => {
		if (!isPlainObject(request) || typeof request.name !== "string" || request.name.length > MAX_NAME_CHARS) throw new McpIpcError("INVALID");
		const name = cleanName(request.name);
		if (hasOwn(settings.grants, name)) delete settings.grants[name];
		await saveSettings();
		// What was allowed is taken back at once: the live sessions of that client end too.
		await service?.disconnectByName(name);
		announce();
		return true;
	});
	handle(CHANNELS.log, (request) => {
		noPayload(request);
		return service?.log() ?? [];
	});

	// The page's answer to a tool request.
	ipcMain.on(CHANNELS.response, (event, message) => {
		if (!isTrustedSender({ event, webContents: webContentsOf(), origin })) return;
		if (!isPlainObject(message) || !Number.isSafeInteger(message.id)) return;
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.ok === true) entry.resolve(message.result);
		else entry.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 300) : "The editor could not do that."));
	});

	const ready = (async () => {
		try {
			settings = parseSettings(await fsApi.readFile(paths.settings, "utf8"));
		} catch {}
		// A leftover endpoint file belongs to a run that is over.
		await fsApi.unlink(paths.endpoint).catch(() => {});
		if (autoStart && settings.enabled) await startService().catch((error) => log(`[ccut] MCP server did not start: ${error?.message ?? error}`));
	})();

	return {
		ready,
		shutdown: () => void stopService().catch(() => {}),
		_paths: paths,
	};
}

module.exports = { CHANNELS, McpIpcError, mcpPaths, parseSettings, registerMcpIpc, shellQuote };
