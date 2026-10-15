const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CHANNELS } = require("../link-import-ipc");
const { MODES, QUALITY_HEIGHTS } = require("../link-import-args");
const { LIMITS } = require("../link-import-jobs");
const { MAX_URL_CHARS } = require("../link-import-url");

// window.ccutLinkImport in preload.js, run for real with a fake `electron` module (a sandboxed
// preload can require nothing else). Every call is checked BEFORE ipcRenderer.invoke and only
// the known fields are sent; the main process checks everything again.

const preloadPath = path.join(__dirname, "../preload.js");
const source = fs.readFileSync(preloadPath, "utf8");

function loadPreload({ invoke = async () => "invoked" } = {}) {
	const calls = [];
	const exposed = new Map();
	const electron = {
		contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
		ipcRenderer: {
			invoke: (channel, ...args) => {
				calls.push({ channel, args });
				return invoke(channel, ...args);
			},
		},
	};
	vm.compileFunction(source, ["require"], { filename: preloadPath })((name) => {
		if (name !== "electron") throw new Error(`a sandboxed preload cannot require ${name}`);
		return electron;
	});
	return { api: exposed.get("ccutLinkImport"), calls };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

const INVALID = "CCUT_LINK_IMPORT:INVALID";
const token = "ab".repeat(32);
const startRequest = (overrides = {}) => ({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", mode: "video", quality: "best", ...overrides });
const foreign = (code) => vm.runInNewContext(code);

describe("preload.js: window.ccutLinkImport", () => {
	test("one frozen object with exactly seven functions", () => {
		const { api } = loadPreload();
		expect(Object.keys(api).sort()).toEqual(["cancel", "checkUpdate", "read", "release", "start", "status", "updateTool"]);
		expect(Object.isFrozen(api)).toBe(true);
		for (const fn of Object.values(api)) expect(typeof fn).toBe("function");
	});

	test("valid calls reach the right channel with the known fields only (extra properties dropped)", async () => {
		const { api, calls } = loadPreload({ invoke: async (channel) => (channel === CHANNELS.read ? new Uint8Array(3) : "ok") });
		const junk = "x".repeat(10_000);
		await api.start({ ...startRequest(), path: "/etc/passwd", junk });
		await api.status({ token, junk });
		await api.cancel({ token, junk });
		await api.read({ token, offset: 5, length: 3, junk });
		await api.release({ token, junk });
		expect(calls).toEqual([
			{ channel: CHANNELS.start, args: [startRequest()] },
			{ channel: CHANNELS.status, args: [{ token }] },
			{ channel: CHANNELS.cancel, args: [{ token }] },
			{ channel: CHANNELS.read, args: [{ token, offset: 5, length: 3 }] },
			{ channel: CHANNELS.release, args: [{ token }] },
		]);
	});

	test("start: anything malformed is { ok: false, code: 'invalid' } and nothing is sent", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [
			undefined,
			null,
			"https://youtu.be/x",
			[],
			Object.create({ url: "https://youtu.be/x" }),
			startRequest({ url: 5 }),
			startRequest({ url: { toString: () => "https://youtu.be/x" } }),
			startRequest({ url: "h".repeat(MAX_URL_CHARS + 1) }),
			startRequest({ mode: "both" }),
			startRequest({ mode: "v".repeat(100_000) }),
			startRequest({ quality: 720 }),
			startRequest({ quality: "toString" }),
		]) {
			expect(await api.start(bad)).toEqual({ ok: false, code: "invalid" });
		}
		expect(calls).toEqual([]);
		await api.start(startRequest({ url: "h".repeat(MAX_URL_CHARS) })); // the length limit itself passes (main judges the URL)
		expect(calls).toHaveLength(1);
	});

	test("status, cancel, release: a non-object or a token that is not a short string is INVALID, nothing sent", async () => {
		const { api, calls } = loadPreload();
		for (const fn of [api.status, api.cancel, api.release]) {
			for (const bad of [undefined, null, "x", [], { token: 5 }, { token: {} }, { token: "t".repeat(129) }, {}]) {
				expect(await rejection(fn(bad))).toBe(INVALID);
			}
		}
		expect(calls).toEqual([]);
	});

	test("read: offset a whole number >= 0, length 1 .. 8 MiB, else INVALID and nothing sent", async () => {
		const { api, calls } = loadPreload({ invoke: async () => new Uint8Array(1) });
		for (const bad of [
			{ token, offset: -1, length: 1 },
			{ token, offset: 1.5, length: 1 },
			{ token, offset: "0", length: 1 },
			{ token, offset: Number.NaN, length: 1 },
			{ token, offset: 2 ** 60, length: 1 },
			{ token, offset: 0, length: 0 },
			{ token, offset: 0, length: LIMITS.maxReadBytes + 1 },
			{ token, offset: 0, length: Number.POSITIVE_INFINITY },
			{ token, offset: 0 },
			{ token: 5, offset: 0, length: 1 },
		]) {
			expect(await rejection(api.read(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
		expect(await rejection(api.read({ token, offset: 0, length: LIMITS.maxReadBytes }))).toBe("resolved");
	});

	test("read: what comes back must be a Uint8Array no longer than asked, else READ_FAILED", async () => {
		for (const answer of ["bytes", [1, 2], new Uint16Array(1), new Uint8Array(5), null, { byteLength: 1 }]) {
			const { api } = loadPreload({ invoke: async () => answer });
			expect(await rejection(api.read({ token, offset: 0, length: 4 }))).toBe("CCUT_LINK_IMPORT:READ_FAILED");
		}
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const { api } = loadPreload({ invoke: async () => bytes });
		expect(await api.read({ token, offset: 0, length: 4 })).toBe(bytes);
	});

	test("values from the page's own realm are accepted", async () => {
		const { api, calls } = loadPreload();
		await api.start(foreign(`({ url: "https://youtu.be/dQw4w9WgXcQ", mode: "audio", quality: "720" })`));
		await api.status(foreign(`({ token: ${JSON.stringify(token)} })`));
		expect(calls.map((call) => call.channel)).toEqual([CHANNELS.start, CHANNELS.status]);
	});

	test("the numbers and lists repeated in preload.js (it cannot import them) match the main process's", () => {
		expect(LIMITS.maxReadBytes).toBe(8 * 1024 * 1024);
		expect(MAX_URL_CHARS).toBe(2048);
		expect([...MODES]).toEqual(["video", "audio"]);
		expect(Object.keys(QUALITY_HEIGHTS).sort()).toEqual(["1080", "720", "best"]);
		const block = source.slice(source.indexOf("// window.ccutLinkImport"));
		expect(block).toContain(`MAX_READ_BYTES = 8 * 1024 * 1024`);
		expect(block).toContain(`MAX_URL_CHARS = 2048`);
		expect(block).toContain(`LINK_MODES = ["video", "audio"]`);
		expect(block).toContain(`LINK_QUALITIES = ["best", "1080", "720"]`);
	});

	test("checkUpdate / updateTool: no argument is sent, and only a release tag or a known code comes back", async () => {
		const answers = new Map();
		const { api, calls } = loadPreload({ invoke: async (channel) => answers.get(channel) });
		answers.set(CHANNELS.updateCheck, { version: "2026.09.30", path: "/home/x" });
		expect(await api.checkUpdate({ junk: 1 })).toBe("2026.09.30");
		for (const bad of [{ version: "<img>" }, { version: "2026.09.30\n" }, { version: 5 }, "2026.09.30", null, undefined]) {
			answers.set(CHANNELS.updateCheck, bad);
			expect(await api.checkUpdate()).toBeNull();
		}
		answers.set(CHANNELS.update, { ok: true, version: "2026.09.30", extra: 1 });
		expect(await api.updateTool({ junk: 1 })).toEqual({ ok: true, version: "2026.09.30" });
		answers.set(CHANNELS.update, { ok: false, code: "up-to-date", text: "/etc/passwd" });
		expect(await api.updateTool()).toEqual({ ok: false, code: "up-to-date" });
		for (const bad of [{ ok: true, version: "latest" }, { ok: false, code: "/etc/passwd" }, { ok: false, code: "extractor-failed" }, null, "x"]) {
			answers.set(CHANNELS.update, bad);
			expect(await rejection(api.updateTool())).toBe("CCUT_LINK_IMPORT:READ_FAILED");
		}
		expect(calls.filter((call) => call.args.length > 0)).toEqual([]);
	});
});
