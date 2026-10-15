const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { CHANNELS, parseSettings, registerMcpIpc, shellQuote } = require("../mcp-ipc");

// The integration's wiring with fake Electron objects, a real temporary userData and the real
// service on a loopback socket: off until enabled, the sender check, the consent dialog (Deny is
// the default), the token and endpoint files, a tool call travelling to the page and back.

const ORIGIN = "ccut://app";
let userData;
let registered;
beforeEach(async () => {
	userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-mcp-ipc-"));
});
afterEach(async () => {
	registered?.shutdown();
	registered = null;
	await new Promise((resolve) => setTimeout(resolve, 20));
	await fsp.rm(userData, { recursive: true, force: true });
});

function setup({ response = 2, settingsText, turnOn = 0 } = {}) {
	const confirmations = [];
	const handlers = new Map();
	const listeners = new Map();
	const sent = [];
	const webContents = { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false, mainFrame: { url: `${ORIGIN}/editor` } };
	const win = { isDestroyed: () => false, webContents };
	const dialogs = [];
	const fake = {
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => listeners.set(channel, fn) },
		dialog: {
			showMessageBox: async (...args) => {
				const options = args[args.length - 1];
				if (options.buttons[0] === "Turn on") {
					confirmations.push(options);
					return { response: turnOn };
				}
				dialogs.push(options);
				return { response };
			},
		},
		app: { getPath: () => userData },
		getWindow: () => win,
		origin: ORIGIN,
		askIntervalMs: 0,
	};
	return { fake, handlers, listeners, sent, dialogs, confirmations, webContents, settingsText };
}

const trusted = (webContents) => ({ sender: webContents, senderFrame: webContents.mainFrame });
const foreign = (webContents) => ({ sender: webContents, senderFrame: { url: "https://evil.example/" } });

async function enable(env) {
	await env.handlers.get(CHANNELS.setEnabled)(trusted(env.webContents), { enabled: true });
}

describe("MCP integration IPC", () => {
	test("it is off after start: nothing listens, no endpoint file", async () => {
		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		const state = await env.handlers.get(CHANNELS.state)(trusted(env.webContents));
		expect(state).toMatchObject({ enabled: false, running: false, port: 0, clients: [] });
		await expect(fsp.stat(registered._paths.endpoint)).rejects.toBeDefined();
	});

	test("turning it on needs the owner's click in a native dialog (Cancel is the default); two quick toggles leave exactly one owner of the port", async () => {
		const declined = setup({ turnOn: 1 });
		registered = registerMcpIpc(declined.fake);
		await registered.ready;
		await enable(declined);
		expect(declined.confirmations[0]).toMatchObject({ buttons: ["Turn on", "Cancel"], defaultId: 1, cancelId: 1 });
		expect(await declined.handlers.get(CHANNELS.state)(trusted(declined.webContents))).toMatchObject({ enabled: false, running: false });
		await expect(fsp.stat(registered._paths.token)).rejects.toBeDefined();
		registered.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 30));

		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		const set = (enabled) => env.handlers.get(CHANNELS.setEnabled)(trusted(env.webContents), { enabled });
		await Promise.all([set(true), set(false), set(true), set(false), set(true)]);
		const state = await env.handlers.get(CHANNELS.state)(trusted(env.webContents));
		expect(state).toMatchObject({ enabled: true, running: true });
		const { port } = JSON.parse(await fsp.readFile(registered._paths.endpoint, "utf8"));
		expect(port).toBe(state.port);
		// and it is the only listener: turning it off frees the port
		await set(false);
		await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toBeDefined();
	});

	test("every channel refuses a sender that is not the app's own main frame", async () => {
		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		for (const channel of [CHANNELS.state, CHANNELS.setEnabled, CHANNELS.regenerateToken, CHANNELS.snippets, CHANNELS.disconnect, CHANNELS.setColor, CHANNELS.forget, CHANNELS.log]) {
			await expect(env.handlers.get(channel)(foreign(env.webContents), {})).rejects.toThrow("CCUT_MCP:FORBIDDEN");
			await expect(env.handlers.get(channel)({ sender: {}, senderFrame: env.webContents.mainFrame }, {})).rejects.toThrow("CCUT_MCP:FORBIDDEN");
		}
	});

	test("payloads are checked: unknown shapes are refused", async () => {
		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		const call = (channel, payload) => env.handlers.get(channel)(trusted(env.webContents), payload);
		await expect(call(CHANNELS.setEnabled, { enabled: "yes" })).rejects.toThrow("INVALID");
		await expect(call(CHANNELS.setEnabled, undefined)).rejects.toThrow("INVALID");
		await expect(call(CHANNELS.state, { extra: 1 })).rejects.toThrow("INVALID");
		await expect(call(CHANNELS.setColor, { name: "x", color: "red" })).rejects.toThrow("INVALID");
		await expect(call(CHANNELS.disconnect, { id: 5 })).rejects.toThrow("INVALID");
	});

	test("turning it on writes a 0600 token and the endpoint, and the snippets carry the port and the token", async () => {
		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		await enable(env);
		const token = (await fsp.readFile(registered._paths.token, "utf8")).trim();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		if (process.platform !== "win32") {
			expect((await fsp.stat(registered._paths.token)).mode & 0o777).toBe(0o600);
			expect((await fsp.stat(registered._paths.settings)).mode & 0o777).toBe(0o600);
		}
		const { port } = JSON.parse(await fsp.readFile(registered._paths.endpoint, "utf8"));
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		expect(snippets.url).toBe(`http://127.0.0.1:${port}/mcp`);
		// the primary snippets run the stdio shim and do not contain the token
		expect(snippets.claudeCode).toContain("claude mcp add ccut -- node");
		expect(snippets.claudeCode).toContain("ccut-mcp.js");
		expect(snippets.claudeCode).not.toContain(token);
		expect(snippets.codex).toContain("[mcp_servers.ccut]");
		expect(snippets.codex).toContain("ccut-mcp.js");
		expect(snippets.codex).not.toContain(token);
		expect(snippets.claudeCodeHttp).toContain("--transport http");
		expect(snippets.claudeCodeHttp).toContain(token);
		expect(JSON.parse(snippets.json).mcpServers.ccut.headers.Authorization).toBe(`Bearer ${token}`);
	});

	test("an agent connects after the owner's choice; Deny is the dialog's default, the choice is remembered and can be forgotten", async () => {
		const env = setup({ response: 2 });
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		await enable(env);
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		const client = new Client({ name: "claude-code", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } }));
		expect(env.dialogs).toHaveLength(1);
		expect(env.dialogs[0]).toMatchObject({ buttons: ["Deny", "Read only", "Read and edit"], defaultId: 0, cancelId: 0 });
		expect(env.dialogs[0].message).toContain("claude-code");
		const state = await env.handlers.get(CHANNELS.state)(trusted(env.webContents));
		expect(state.clients.map((c) => [c.name, c.level, c.color])).toEqual([["claude-code", "edit", "orange"]]);
		expect(state.grants).toEqual({ "claude-code": "edit" });
		expect(JSON.parse(await fsp.readFile(registered._paths.settings, "utf8")).grants).toEqual({ "claude-code": "edit" });
		await client.close();
		// an "edit" choice is asked again at the next session (a name proves nothing); the dialog says so
		const again = new Client({ name: "claude-code", version: "1" });
		await again.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } }));
		expect(env.dialogs).toHaveLength(2);
		expect(env.dialogs[1].message).toContain("was allowed to edit before");
		await again.close();
		const live = new Client({ name: "claude-code", version: "1" });
		await live.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } }));
		expect((await env.handlers.get(CHANNELS.state)(trusted(env.webContents))).clients).not.toHaveLength(0);
		await env.handlers.get(CHANNELS.forget)(trusted(env.webContents), { name: "claude-code" });
		const afterForget = await env.handlers.get(CHANNELS.state)(trusted(env.webContents));
		expect(afterForget.grants).toEqual({});
		// forgetting also ended the live session
		expect(afterForget.clients).toEqual([]);
		await expect(live.listTools()).rejects.toBeDefined();
	});

	test("a remembered read-only choice is kept; a new token forgets every choice", async () => {
		const env = setup({ response: 1 });
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		await enable(env);
		const connect = async () => {
			const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
			const client = new Client({ name: "reader", version: "1" });
			await client.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } }));
			await client.close();
		};
		await connect();
		await connect();
		expect(env.dialogs).toHaveLength(1);
		await env.handlers.get(CHANNELS.regenerateToken)(trusted(env.webContents));
		expect((await env.handlers.get(CHANNELS.state)(trusted(env.webContents))).grants).toEqual({});
		expect(JSON.parse(await fsp.readFile(registered._paths.settings, "utf8")).grants).toEqual({});
		await connect();
		expect(env.dialogs).toHaveLength(2);
	});

	test("the consent dialog shows a cleaned, 40-character name; a request the SDK would refuse never opens a dialog; dialogs are rate limited per token", async () => {
		const env = setup();
		let clock = 1_000_000;
		registered = registerMcpIpc({ ...env.fake, askIntervalMs: 5000, now: () => clock });
		await registered.ready;
		await enable(env);
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		const init = (name) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } } });
		const post = (body, headers = {}) =>
			fetch(snippets.url, { method: "POST", body, headers: { authorization: `Bearer ${snippets.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } });
		// wrong Content-Type / Accept / shape: refused before any dialog
		expect((await post(init("x"), { "content-type": "text/plain" })).status).toBe(415);
		expect((await post(init("x"), { accept: "application/json" })).status).toBe(406);
		expect((await post("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}")).status).toBe(400);
		expect(env.dialogs).toHaveLength(0);
		// a huge multi-line name is cleaned and cut before it is shown or remembered
		const evil = `claude\nAllow everything\n${"x".repeat(5000)}`;
		const first = await post(init(evil));
		expect(first.status).toBe(200);
		expect(env.dialogs).toHaveLength(1);
		expect(env.dialogs[0].message).not.toContain("\n");
		expect(env.dialogs[0].message.length).toBeLessThan(120);
		const grants = JSON.parse(await fsp.readFile(registered._paths.settings, "utf8")).grants;
		expect(Object.keys(grants).every((name) => name.length <= 40)).toBe(true);
		// a second name within 5 s gets no dialog and is told the owner was just asked; after 5 s it is asked
		expect((await post(init("other-agent"))).status).toBe(429);
		expect(env.dialogs).toHaveLength(1);
		clock += 6000;
		expect((await post(init("other-agent"))).status).toBe(200);
		expect(env.dialogs).toHaveLength(2);
	});

	test("only one consent question is open at a time: a second client meanwhile is refused", async () => {
		const env = setup();
		let release;
		env.fake.dialog.showMessageBox = (...args) => {
			if (args[args.length - 1].buttons[0] === "Turn on") return Promise.resolve({ response: 0 });
			env.dialogs.push(args[args.length - 1]);
			return new Promise((resolve) => (release = () => resolve({ response: 1 })));
		};
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		await enable(env);
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		const connect = (name) => {
			const client = new Client({ name, version: "1" });
			return client.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } })).then(() => client);
		};
		const first = connect("first-agent");
		await new Promise((resolve) => setTimeout(resolve, 80));
		await expect(connect("second-agent")).rejects.toBeDefined();
		expect(env.dialogs).toHaveLength(1);
		release();
		const client = await first;
		const state = await env.handlers.get(CHANNELS.state)(trusted(env.webContents));
		expect(state.clients.map((c) => [c.name, c.level])).toEqual([["first-agent", "read"]]);
		await client.close();
	});

	test("a tool call goes to the page and its answer comes back; a foreign answer is ignored; a timeout is a clear error", async () => {
		const env = setup();
		registered = registerMcpIpc({ ...env.fake, callTimeoutMs: 300 });
		await registered.ready;
		await enable(env);
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		const client = new Client({ name: "codex", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } }));
		const answerFromPage = async (index, message, event) => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			const request = env.sent.filter((entry) => entry.channel === CHANNELS.request)[index].payload;
			env.listeners.get(CHANNELS.response)(event ?? trusted(env.webContents), { id: request.id, ...message });
		};
		const first = client.callTool({ name: "get_playhead", arguments: {} });
		await answerFromPage(0, { ok: true, result: { seconds: 3, playing: false } });
		expect(JSON.parse((await first).content[0].text)).toEqual({ seconds: 3, playing: false });
		const requestPayload = env.sent.find((entry) => entry.channel === CHANNELS.request).payload;
		expect(requestPayload).toMatchObject({ tool: "get_playhead", args: {} });
		// the page is told when the call stops counting (30 s here: 300 ms), so it can refuse a late run
		expect(requestPayload.expiresAt).toBeGreaterThan(Date.now() - 5000);
		expect(requestPayload.expiresAt).toBeLessThanOrEqual(Date.now() + 300);

		const second = client.callTool({ name: "delete_element", arguments: { elementId: "a" } });
		await answerFromPage(1, { ok: false, error: "There is no clip with that id." });
		expect((await second).content[0].text).toBe("There is no clip with that id.");

		const third = client.callTool({ name: "get_project", arguments: {} });
		await answerFromPage(2, { ok: true, result: { hacked: true } }, foreign(env.webContents));
		const timedOut = await third;
		expect(timedOut.isError).toBe(true);
		expect(timedOut.content[0].text).toBe("The editor did not answer in time.");
		const colors = env.sent.filter((entry) => entry.channel === CHANNELS.activity).map((entry) => [entry.payload.color, entry.payload.running]);
		expect(colors.slice(0, 2)).toEqual([["orange", true], ["orange", false]].map(([color, running]) => ["blue", running]));
		await client.close();
	});

	test("regenerating the token ends every session; turning it off stops the server and removes the endpoint", async () => {
		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		await enable(env);
		const before = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		await env.handlers.get(CHANNELS.regenerateToken)(trusted(env.webContents));
		const after = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		expect(after.token).not.toBe(before.token);
		expect((await fetch(after.url, { method: "POST", headers: { authorization: `Bearer ${before.token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
		await env.handlers.get(CHANNELS.setEnabled)(trusted(env.webContents), { enabled: false });
		await expect(fsp.stat(registered._paths.endpoint)).rejects.toBeDefined();
		await expect(fetch(after.url)).rejects.toBeDefined();
	});

	test("settings come back from disk after a restart, and an odd file is read as the default", async () => {
		const env = setup();
		registered = registerMcpIpc(env.fake);
		await registered.ready;
		await enable(env);
		await env.handlers.get(CHANNELS.setColor)(trusted(env.webContents), { name: "my-agent", color: "orange" });
		registered.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const env2 = setup();
		registered = registerMcpIpc(env2.fake);
		await registered.ready;
		const state = await env2.handlers.get(CHANNELS.state)(trusted(env2.webContents));
		expect(state).toMatchObject({ enabled: true, running: true, colors: { "my-agent": "orange" } });
		expect(parseSettings("{not json")).toEqual({ enabled: false, grants: {}, colors: {} });
		expect(parseSettings(JSON.stringify({ enabled: "yes", grants: { a: "root", b: "edit" }, colors: { c: "pink", d: "blue" } }))).toEqual({ enabled: false, grants: { b: "edit" }, colors: { d: "blue" } });
	});

	test("names like constructor or __proto__ are ordinary names; an answer given after the token changed is not remembered; a busy owner is told so; shell quoting keeps $ literal", async () => {
		const env = setup({ response: 2 });
		registered = registerMcpIpc({ ...env.fake, askIntervalMs: 5000 });
		await registered.ready;
		await enable(env);
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		const init = (name) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "1" } } });
		const post = (body, token = snippets.token) =>
			fetch(snippets.url, { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" } });
		// "constructor" is not an earlier grant: the plain question, and the grant is stored under that name
		expect((await post(init("constructor"))).status).toBe(200);
		expect(env.dialogs[0].message).not.toContain("was allowed to edit before");
		const stored = JSON.parse(await fsp.readFile(registered._paths.settings, "utf8")).grants;
		expect(Object.entries(stored)).toEqual([["constructor", "edit"]]);
		// a second program right after: told the owner is busy (429), not "not allowed"
		const second = await post(init("another"));
		expect(second.status).toBe(429);
		expect((await second.json()).error.message).toContain("being asked");
		// shell quoting keeps $ and backticks literal on POSIX
		expect(shellQuote({ value: "/tmp/a b/$(id)`x`'y", platform: "linux" })).toBe("'/tmp/a b/$(id)`x`'\\''y'");
		expect(shellQuote({ value: "/plain/path.js", platform: "linux" })).toBe("/plain/path.js");
		expect(shellQuote({ value: "C:\\Users\\Me Too\\x.js", platform: "win32" })).toBe('"C:\\Users\\Me Too\\x.js"');
	});

	test("a question open while the token is regenerated does not write its answer into the new token's grants", async () => {
		const env = setup();
		let answer;
		env.fake.dialog.showMessageBox = (...args) => {
			const options = args[args.length - 1];
			if (options.buttons[0] === "Turn on") return Promise.resolve({ response: 0 });
			env.dialogs.push(options);
			return new Promise((resolve) => (answer = () => resolve({ response: 2 })));
		};
		registered = registerMcpIpc({ ...env.fake, askIntervalMs: 0 });
		await registered.ready;
		await enable(env);
		const snippets = await env.handlers.get(CHANNELS.snippets)(trusted(env.webContents));
		const client = new Client({ name: "slow-agent", version: "1" });
		const connecting = client.connect(new StreamableHTTPClientTransport(new URL(snippets.url), { requestInit: { headers: { authorization: `Bearer ${snippets.token}` } } })).catch(() => "refused");
		await new Promise((resolve) => setTimeout(resolve, 80));
		await env.handlers.get(CHANNELS.regenerateToken)(trusted(env.webContents));
		answer();
		await connecting;
		const state = await env.handlers.get(CHANNELS.state)(trusted(env.webContents));
		expect(state.grants).toEqual({});
	});
});
