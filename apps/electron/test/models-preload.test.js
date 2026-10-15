const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CHANNELS, MODELS } = require("../models-ipc");

// window.ccutModels in preload.js, run for real with a fake `electron` module: the channel names
// match models-ipc.js, only a known model id is ever sent, the list of ids matches MODELS.

const preloadPath = path.join(__dirname, "../preload.js");
const source = fs.readFileSync(preloadPath, "utf8");

function loadPreload() {
	const invoked = [];
	const exposed = new Map();
	const electron = {
		contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
		ipcRenderer: { invoke: async (channel, ...args) => (invoked.push({ channel, args }), "ok"), send: () => {}, on: () => {}, removeListener: () => {} },
	};
	vm.compileFunction(source, ["require"], { filename: preloadPath })((name) => {
		if (name !== "electron") throw new Error(`a sandboxed preload cannot require ${name}`);
		return electron;
	});
	return { api: exposed.get("ccutModels"), invoked };
}

describe("window.ccutModels", () => {
	test("each call uses the channel models-ipc.js handles and sends the model id only", async () => {
		const { api, invoked } = loadPreload();
		await api.status({ modelId: "u2netp", url: "https://evil.example/x" });
		await api.install({ modelId: "u2netp" });
		await api.cancelInstall({ modelId: "u2netp" });
		await api.remove({ modelId: "u2netp" });
		await api.read({ modelId: "u2netp" });
		expect(invoked.map((entry) => entry.channel)).toEqual([CHANNELS.status, CHANNELS.install, CHANNELS.cancelInstall, CHANNELS.remove, CHANNELS.read]);
		expect(invoked.every((entry) => JSON.stringify(entry.args) === JSON.stringify([{ modelId: "u2netp" }]))).toBe(true);
	});

	test("an unknown id or a wrong shape is refused before any invoke", async () => {
		const { api, invoked } = loadPreload();
		await expect(api.install({ modelId: "evil" })).rejects.toThrow("CCUT_MODELS:INVALID");
		await expect(api.read("u2netp")).rejects.toThrow("CCUT_MODELS:INVALID");
		expect(invoked).toEqual([]);
	});

	test("the preload's id list is the main process's MODELS", () => {
		expect(source).toContain(`const MODEL_IDS = ${JSON.stringify(Object.keys(MODELS))};`);
	});
});
