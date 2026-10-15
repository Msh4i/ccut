const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CHANNELS } = require("../stems-ipc");
const { LIMITS, SAMPLE_RATES, STEMS, maxFramesFor } = require("../stems-jobs");

// window.ccutStems in preload.js, run for real with a fake `electron` module (a sandboxed
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
	return { api: exposed.get("ccutStems"), calls };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

const INVALID = "CCUT_STEMS:INVALID";
const token = "ab".repeat(32);
const foreign = (code) => vm.runInNewContext(code);

describe("preload.js: window.ccutStems", () => {
	test("one frozen object with exactly the eleven functions; the channels are main's", () => {
		const { api } = loadPreload();
		expect(Object.keys(api).sort()).toEqual(["begin", "cancel", "cancelInstall", "install", "jobStatus", "read", "release", "removeEngine", "run", "status", "write"]);
		expect(Object.isFrozen(api)).toBe(true);
		for (const fn of Object.values(api)) expect(typeof fn).toBe("function");
		const block = source.slice(source.indexOf("// window.ccutStems"));
		for (const channel of Object.values(CHANNELS)) expect(block).toContain(`"${channel}"`);
	});

	test("valid calls reach the right channel with the known fields only (extra properties dropped)", async () => {
		const { api, calls } = loadPreload({ invoke: async (channel) => (channel === CHANNELS.read ? new Uint8Array(3) : "ok") });
		const junk = "x".repeat(10_000);
		const data = new Uint8Array(8);
		await api.status({ junk });
		await api.install({ junk });
		await api.cancelInstall({ junk });
		await api.removeEngine({ junk });
		await api.begin({ frames: 1000, sampleRate: 48000, junk, path: "/etc/passwd" });
		await api.write({ token, position: 4, data, junk });
		await api.run({ token, junk });
		await api.jobStatus({ token, junk });
		await api.read({ token, stem: "drums", offset: 5, length: 3, junk });
		await api.cancel({ token, junk });
		await api.release({ token, junk });
		expect(calls).toEqual([
			{ channel: CHANNELS.status, args: [] },
			{ channel: CHANNELS.install, args: [] },
			{ channel: CHANNELS.cancelInstall, args: [] },
			{ channel: CHANNELS.removeEngine, args: [] },
			{ channel: CHANNELS.begin, args: [{ frames: 1000, sampleRate: 48000 }] },
			{ channel: CHANNELS.write, args: [{ token, position: 4, data }] },
			{ channel: CHANNELS.run, args: [{ token }] },
			{ channel: CHANNELS.jobStatus, args: [{ token }] },
			{ channel: CHANNELS.read, args: [{ token, stem: "drums", offset: 5, length: 3 }] },
			{ channel: CHANNELS.cancel, args: [{ token }] },
			{ channel: CHANNELS.release, args: [{ token }] },
		]);
	});

	test("begin: whole frames and a whitelisted rate, else invalid; longer than 15 minutes at that rate is too-long; nothing is sent", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [undefined, null, "x", [], Object.create({ frames: 10, sampleRate: 44100 }), { frames: 0, sampleRate: 44100 }, { frames: -1, sampleRate: 44100 }, { frames: 1.5, sampleRate: 44100 }, { frames: "10", sampleRate: 44100 }, { frames: Number.NaN, sampleRate: 44100 }, { frames: Number.POSITIVE_INFINITY, sampleRate: 44100 }, { frames: 10 }, { frames: 10, sampleRate: 12345 }, { frames: 10, sampleRate: 192000 }, { frames: 10, sampleRate: "44100" }, { frames: 10, sampleRate: 44100.5 }]) {
			expect(await api.begin(bad)).toEqual({ ok: false, code: "invalid" });
		}
		for (const sampleRate of SAMPLE_RATES) {
			expect(await api.begin({ frames: maxFramesFor(sampleRate) + 1, sampleRate })).toEqual({ ok: false, code: "too-long" });
		}
		expect(calls).toEqual([]);
		for (const sampleRate of SAMPLE_RATES) await api.begin({ frames: maxFramesFor(sampleRate), sampleRate });
		expect(calls).toHaveLength(SAMPLE_RATES.length);
	});

	test("write: a token, a whole position >= 0, a Uint8Array of 1 byte .. 8 MiB whose backing buffer is that small too", async () => {
		const { api, calls } = loadPreload();
		const view = new Uint8Array(new ArrayBuffer(LIMITS.maxChunkBytes + 1), 0, 16);
		for (const bad of [undefined, null, "x", [], { token, position: 0 }, { position: 0, data: new Uint8Array(4) }, { token: 5, position: 0, data: new Uint8Array(4) }, { token: "t".repeat(129), position: 0, data: new Uint8Array(4) }, { token, position: -1, data: new Uint8Array(4) }, { token, position: 1.5, data: new Uint8Array(4) }, { token, position: "0", data: new Uint8Array(4) }, { token, position: 0, data: new Uint8Array(0) }, { token, position: 0, data: new Uint8Array(LIMITS.maxChunkBytes + 1) }, { token, position: 0, data: view }, { token, position: 0, data: new Int16Array(4) }, { token, position: 0, data: [1, 2, 3] }, { token, position: 0, data: "abcd" }, { token, position: 0, data: new ArrayBuffer(4) }]) {
			expect(await rejection(api.write(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
		expect(await rejection(api.write({ token, position: 0, data: new Uint8Array(LIMITS.maxChunkBytes) }))).toBe("resolved");
		expect(await rejection(api.write({ token, position: 2 ** 40, data: new Uint8Array(1) }))).toBe("resolved"); // main judges the position
	});

	test("run: a bad request is { ok: false, code: 'invalid' }; jobStatus, cancel, release throw INVALID; nothing is sent", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [undefined, null, "x", [], { token: 5 }, { token: {} }, { token: "t".repeat(129) }, {}]) {
			expect(await api.run(bad)).toEqual({ ok: false, code: "invalid" });
			for (const fn of [api.jobStatus, api.cancel, api.release]) expect(await rejection(fn(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
	});

	test("read: a known stem, offset a whole number >= 0, length 1 .. 8 MiB, else INVALID and nothing sent", async () => {
		const { api, calls } = loadPreload({ invoke: async () => new Uint8Array(1) });
		const ok = { token, stem: "bass", offset: 0, length: 1 };
		for (const bad of [
			undefined,
			{ ...ok, stem: "piano" },
			{ ...ok, stem: "toString" },
			{ ...ok, stem: 5 },
			{ token, offset: 0, length: 1 },
			{ ...ok, offset: -1 },
			{ ...ok, offset: 1.5 },
			{ ...ok, offset: "0" },
			{ ...ok, offset: Number.NaN },
			{ ...ok, offset: 2 ** 60 },
			{ ...ok, length: 0 },
			{ ...ok, length: LIMITS.maxReadBytes + 1 },
			{ ...ok, length: Number.POSITIVE_INFINITY },
			{ ...ok, length: undefined },
			{ ...ok, token: 5 },
		]) {
			expect(await rejection(api.read(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
		expect(await rejection(api.read({ ...ok, length: LIMITS.maxReadBytes }))).toBe("resolved");
	});

	test("read: what comes back must be a Uint8Array no longer than asked, else READ_FAILED", async () => {
		for (const answer of ["bytes", [1, 2], new Uint16Array(1), new Uint8Array(5), null, { byteLength: 1 }]) {
			const { api } = loadPreload({ invoke: async () => answer });
			expect(await rejection(api.read({ token, stem: "drums", offset: 0, length: 4 }))).toBe("CCUT_STEMS:READ_FAILED");
		}
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const { api } = loadPreload({ invoke: async () => bytes });
		expect(await api.read({ token, stem: "drums", offset: 0, length: 4 })).toBe(bytes);
	});

	test("values from the page's own realm are accepted", async () => {
		const { api, calls } = loadPreload();
		await api.begin(foreign(`({ frames: 44100, sampleRate: 44100 })`));
		await api.write(foreign(`({ token: ${JSON.stringify(token)}, position: 0, data: new Uint8Array(4) })`));
		await api.jobStatus(foreign(`({ token: ${JSON.stringify(token)} })`));
		await api.read(foreign(`({ token: ${JSON.stringify(token)}, stem: "vocals", offset: 0, length: 2 })`)).catch(() => {});
		expect(calls.map((call) => call.channel)).toEqual([CHANNELS.begin, CHANNELS.write, CHANNELS.jobStatus, CHANNELS.read]);
	});

	test("the numbers and lists repeated in preload.js (it cannot import them) match the main process's", () => {
		expect(LIMITS.maxChunkBytes).toBe(8 * 1024 * 1024);
		expect(LIMITS.maxReadBytes).toBe(8 * 1024 * 1024);
		expect([...SAMPLE_RATES]).toEqual([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]);
		expect(maxFramesFor(1)).toBe(900);
		expect([...STEMS]).toEqual(["drums", "bass", "other", "vocals"]);
		const block = source.slice(source.indexOf("// window.ccutStems"));
		expect(block).toContain("MAX_STEMS_CHUNK_BYTES = 8 * 1024 * 1024");
		expect(block).toContain("MAX_STEMS_READ_BYTES = 8 * 1024 * 1024");
		expect(block).toContain("STEMS_SAMPLE_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]");
		expect(block).toContain("STEMS_MAX_SECONDS = 900");
		expect(block).toContain(`STEM_NAMES = ["drums", "bass", "other", "vocals"]`);
	});
});
