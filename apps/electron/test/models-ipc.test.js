const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CHANNELS, MODELS, parseModelRequest, registerModelsIpc } = require("../models-ipc");

const ORIGIN = "ccut://app";
const BYTES = Buffer.from("tiny model bytes");
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const URL_OK = "https://github.com/x/y/releases/download/v0/tiny.onnx";
const TINY = { id: "u2netp", label: "Tiny", url: URL_OK, sha256: sha(BYTES), sizeBytes: BYTES.length, hosts: ["github.com", "objects.githubusercontent.com"] };

let userData;
beforeEach(async () => {
	userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-models-"));
});
afterEach(() => fsp.rm(userData, { recursive: true, force: true }));

const stream = (buffer) => new Response(buffer, { status: 200, headers: { "content-length": String(buffer.length) } });

function setup({ fetch, answer = 0, models = { u2netp: TINY } } = {}) {
	const handlers = new Map();
	const mainFrame = { url: `${ORIGIN}/editor/1` };
	const webContents = { id: 1, mainFrame };
	const dialogs = [];
	registerModelsIpc({
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		dialog: { showMessageBox: async (...args) => (dialogs.push(args[args.length - 1]), { response: answer }) },
		app: { getPath: () => userData },
		getWindow: () => ({ webContents, isDestroyed: () => false }),
		origin: ORIGIN,
		log: () => {},
		fetch,
		models,
	});
	const call = (channel, request, event = { sender: webContents, senderFrame: mainFrame }) => handlers.get(channel)(event, request);
	return { call, dialogs, webContents };
}

const modelFile = () => path.join(userData, "models", "u2netp", "model.onnx");

describe("models IPC", () => {
	test("the shipped pin is the one the owner ordered", () => {
		expect(MODELS.u2netp.sizeBytes).toBe(4_574_861);
		expect(MODELS.u2netp.sha256).toBe("309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8");
		expect([...MODELS.u2netp.hosts]).toEqual(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
	});

	test("only a known model id passes; a stranger's frame is refused", async () => {
		expect(parseModelRequest({ modelId: "u2netp" })).toEqual({ modelId: "u2netp" });
		expect(parseModelRequest({ modelId: "__proto__" })).toBeNull();
		expect(parseModelRequest({ modelId: "u2netp", url: "https://evil" })).toEqual({ modelId: "u2netp" });
		expect(parseModelRequest("u2netp")).toBeNull();
		const { call } = setup({ fetch: async () => stream(BYTES) });
		await expect(call(CHANNELS.status, { modelId: "u2netp" }, { sender: {}, senderFrame: {} })).rejects.toThrow("CCUT_MODELS:FORBIDDEN");
		await expect(call(CHANNELS.status, { modelId: "nope" })).rejects.toThrow("CCUT_MODELS:INVALID");
	});

	test("install: the consent dialog defaults to Cancel and shows the size; Cancel downloads nothing", async () => {
		let fetched = 0;
		const { call, dialogs } = setup({ answer: 1, fetch: async () => (fetched++, stream(BYTES)) });
		expect(await call(CHANNELS.install, { modelId: "u2netp" })).toEqual({ ok: false, code: "consent-declined" });
		expect(fetched).toBe(0);
		expect(dialogs[0].defaultId).toBe(1);
		expect(dialogs[0].buttons[1]).toBe("Cancel");
		expect(dialogs[0].detail).toContain(String(BYTES.length));
	});

	test("install writes the verified file atomically; read returns exactly those bytes", async () => {
		const { call } = setup({ fetch: async () => stream(BYTES) });
		expect(await call(CHANNELS.status, { modelId: "u2netp" })).toMatchObject({ installed: false, sizeBytes: BYTES.length });
		expect(await call(CHANNELS.install, { modelId: "u2netp" })).toEqual({ ok: true });
		expect(Buffer.from(await call(CHANNELS.read, { modelId: "u2netp" }))).toEqual(BYTES);
		expect((await fsp.readdir(path.dirname(modelFile()))).sort()).toEqual(["model.onnx"]);
		expect(await call(CHANNELS.status, { modelId: "u2netp" })).toMatchObject({ installed: true });
	});

	test("a wrong hash leaves nothing behind; a redirect to another host is refused", async () => {
		const wrong = setup({ fetch: async () => stream(Buffer.from("tiny model bytez")) });
		expect(await wrong.call(CHANNELS.install, { modelId: "u2netp" })).toEqual({ ok: false, code: "verify-failed" });
		expect(await fsp.readdir(path.dirname(modelFile()))).toEqual([]);
		const requested = [];
		const evil = setup({
			fetch: async (url) => {
				requested.push(url);
				return new Response(null, { status: 302, headers: { location: "https://evil.example/model.onnx" } });
			},
		});
		expect(await evil.call(CHANNELS.install, { modelId: "u2netp" })).toEqual({ ok: false, code: "download-failed" });
		expect(requested).toEqual([URL_OK]);
	});

	test("read refuses a file that was changed on disk after the install", async () => {
		const { call } = setup({ fetch: async () => stream(BYTES) });
		await call(CHANNELS.install, { modelId: "u2netp" });
		await fsp.writeFile(modelFile(), Buffer.from("tiny model bytez"));
		await expect(call(CHANNELS.read, { modelId: "u2netp" })).rejects.toThrow("CCUT_MODELS:MISSING");
	});

	test("remove asks first and then deletes the folder", async () => {
		const declined = setup({ answer: 1, fetch: async () => stream(BYTES) });
		expect(await declined.call(CHANNELS.remove, { modelId: "u2netp" })).toEqual({ ok: false, code: "consent-declined" });
		const { call } = setup({ fetch: async () => stream(BYTES) });
		await call(CHANNELS.install, { modelId: "u2netp" });
		expect(await call(CHANNELS.remove, { modelId: "u2netp" })).toEqual({ ok: true });
		expect(await call(CHANNELS.status, { modelId: "u2netp" })).toMatchObject({ installed: false });
	});

	test("two installs at once show ONE dialog (the second is busy); status says 'installed' only for the verified file", async () => {
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		const { call, dialogs } = setup({ fetch: async () => (await gate, stream(BYTES)) });
		const first = call(CHANNELS.install, { modelId: "u2netp" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await call(CHANNELS.install, { modelId: "u2netp" })).toEqual({ ok: false, code: "busy" });
		release();
		expect(await first).toEqual({ ok: true });
		expect(dialogs).toHaveLength(1);
		// the same size, other bytes: not installed
		await fsp.writeFile(modelFile(), Buffer.from("tiny model bytez"));
		expect(await call(CHANNELS.status, { modelId: "u2netp" })).toMatchObject({ installed: false });
	});

	test("leftover .download-* files of a crashed download are removed at start", async () => {
		const dir = path.join(userData, "models", "u2netp");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, ".download-abc"), "partial");
		await fsp.writeFile(path.join(dir, "model.onnx"), BYTES);
		const handlers = new Map();
		const ipc = registerModelsIpc({
			ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
			dialog: { showMessageBox: async () => ({ response: 1 }) },
			app: { getPath: () => userData },
			getWindow: () => null,
			origin: ORIGIN,
			log: () => {},
			fetch: async () => stream(BYTES),
			models: { u2netp: TINY },
		});
		await ipc.ready;
		expect((await fsp.readdir(dir)).sort()).toEqual(["model.onnx"]);
	});
});
