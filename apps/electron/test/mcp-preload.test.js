const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CHANNELS } = require("../mcp-ipc");

// window.ccutMcp in preload.js, run for real with a fake `electron` module: the channel names
// match mcp-ipc.js, bad input is refused before any invoke, listeners get the payload only.

const preloadPath = path.join(__dirname, "../preload.js");
const source = fs.readFileSync(preloadPath, "utf8");

function loadPreload() {
	const invoked = [];
	const sent = [];
	const listeners = new Map();
	const exposed = new Map();
	const electron = {
		contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
		ipcRenderer: {
			invoke: async (channel, ...args) => (invoked.push({ channel, args }), "ok"),
			send: (channel, payload) => sent.push({ channel, payload }),
			on: (channel, fn) => listeners.set(channel, fn),
			removeListener: (channel, fn) => listeners.get(channel) === fn && listeners.delete(channel),
		},
	};
	vm.compileFunction(source, ["require"], { filename: preloadPath })((name) => {
		if (name !== "electron") throw new Error(`a sandboxed preload cannot require ${name}`);
		return electron;
	});
	return { api: exposed.get("ccutMcp"), invoked, sent, listeners };
}

describe("window.ccutMcp", () => {
	test("each call uses the channel mcp-ipc.js handles", async () => {
		const { api, invoked } = loadPreload();
		await api.state();
		await api.setEnabled(true);
		await api.regenerateToken();
		await api.snippets();
		await api.disconnect("abc");
		await api.setColor("claude-code", "blue");
		await api.forget("claude-code");
		await api.log();
		expect(invoked.map((call) => call.channel)).toEqual([CHANNELS.state, CHANNELS.setEnabled, CHANNELS.regenerateToken, CHANNELS.snippets, CHANNELS.disconnect, CHANNELS.setColor, CHANNELS.forget, CHANNELS.log]);
		expect(invoked[1].args).toEqual([{ enabled: true }]);
	});

	test("bad input never reaches invoke", async () => {
		const { api, invoked } = loadPreload();
		await expect(api.setEnabled("yes")).rejects.toThrow("CCUT_MCP:INVALID");
		await expect(api.disconnect("")).rejects.toThrow("CCUT_MCP:INVALID");
		await expect(api.disconnect("x".repeat(65))).rejects.toThrow("CCUT_MCP:INVALID");
		await expect(api.setColor("a", "red")).rejects.toThrow("CCUT_MCP:INVALID");
		await expect(api.forget(5)).rejects.toThrow("CCUT_MCP:INVALID");
		expect(invoked).toEqual([]);
	});

	test("the editor's handler answers a request on the response channel, an error as a short message", async () => {
		const { api, sent, listeners } = loadPreload();
		api.onRequest(async ({ tool }) => {
			if (tool === "boom") throw new Error("No such clip.");
			return { seconds: 2 };
		});
		const fire = listeners.get(CHANNELS.request);
		await fire({}, { id: 1, tool: "get_playhead", args: {} });
		await fire({}, { id: 2, tool: "boom", args: {} });
		await fire({}, { id: "bad", tool: "x", args: {} });
		expect(sent).toEqual([
			{ channel: CHANNELS.response, payload: { id: 1, ok: true, result: { seconds: 2 } } },
			{ channel: CHANNELS.response, payload: { id: 2, ok: false, error: "No such clip." } },
		]);
	});

	test("a request whose time is already up is not run: it is answered with an error", async () => {
		const { api, sent, listeners } = loadPreload();
		let ran = 0;
		api.onRequest(async () => {
			ran += 1;
			return { ok: true };
		});
		const fire = listeners.get(CHANNELS.request);
		await fire({}, { id: 7, tool: "delete_element", args: {}, expiresAt: Date.now() - 1 });
		await fire({}, { id: 8, tool: "get_playhead", args: {}, expiresAt: Date.now() + 60_000 });
		expect(ran).toBe(1);
		expect(sent[0]).toEqual({ channel: CHANNELS.response, payload: { id: 7, ok: false, error: "The request had already timed out." } });
		expect(sent[1].payload).toMatchObject({ id: 8, ok: true });
	});

	test("listeners get the payload only and can be removed", () => {
		const { api, listeners } = loadPreload();
		const seen = [];
		const stop = api.onActivity((payload) => seen.push(payload));
		listeners.get(CHANNELS.activity)({ sender: "secret" }, { running: true });
		expect(seen).toEqual([{ running: true }]);
		stop();
		expect(listeners.has(CHANNELS.activity)).toBe(false);
		expect(() => api.onStateChanged("nope")).toThrow("CCUT_MCP:INVALID");
	});
});
