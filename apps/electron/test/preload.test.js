const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CHANNELS } = require("../export-ipc");
const { LIMITS, MAX_SUGGESTED_NAME_CHARS } = require("../export-files");
const { CHANNEL: SYSTEM_MEMORY_CHANNEL } = require("../system-memory-ipc");

// preload.js with a fake `electron` module. A sandboxed preload can require nothing but
// electron (and a few Node built-ins), so its checks live in the file itself and the real
// file is what runs here: the source is compiled as a function of `require` and called with a stand-in.

const preloadPath = path.join(__dirname, "../preload.js");
const source = fs.readFileSync(preloadPath, "utf8");

function loadPreload({ invoke = async () => "invoked" } = {}) {
	const calls = [];
	const required = [];
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
		required.push(name);
		if (name !== "electron") throw new Error(`a sandboxed preload cannot require ${name}`);
		return electron;
	});
	return { api: exposed.get("ccutExport"), exposed, calls, required };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

const INVALID = "CCUT_EXPORT:INVALID";
const token = "3f1c9b0e-2d4a-4a8e-9a55-0d6f3c1b7e21";
const beginRequest = (overrides = {}) => ({ suggestedName: "My film", container: "mp4", estimatedBytes: 1000, ...overrides });
const foreign = (code) => vm.runInNewContext(code); // a value of another JavaScript realm, like the page's

describe("preload.js", () => {
	test("requires only 'electron' (a sandboxed preload cannot load the app's own modules); ccutExport is one frozen object with five functions", () => {
		const { api, exposed, required } = loadPreload();
		expect(required).toEqual(["electron"]);
		// The whole surface: ccutExport, ccutLinkImport (link-import-preload.test.js), ccutStems (stems-preload.test.js), ccutMcp (mcp-preload.test.js) and ccutSystem (below).
		expect([...exposed.keys()].sort()).toEqual(["ccutExport", "ccutLinkImport", "ccutMcp", "ccutModels", "ccutStems", "ccutSystem"]);
		expect(Object.keys(api).sort()).toEqual(["abort", "begin", "finish", "reveal", "write"]);
		expect(Object.isFrozen(api)).toBe(true);
		for (const fn of Object.values(api)) expect(typeof fn).toBe("function");
	});

	test("valid calls reach the right channel with the known fields only (an extra property, however big, is dropped)", async () => {
		const junk = "x".repeat(10_000);
		const data = new Uint8Array([1, 2, 3]);
		const { api, calls } = loadPreload();
		await api.begin({ ...beginRequest(), path: "/etc/passwd", junk });
		await api.write({ token, position: 7, data, junk });
		await api.finish({ token, totalBytes: 9, junk });
		await api.abort({ token, junk });
		await api.reveal({ token, junk });
		expect(calls).toEqual([
			{ channel: CHANNELS.begin, args: [beginRequest()] },
			{ channel: CHANNELS.write, args: [{ token, position: 7, data }] },
			{ channel: CHANNELS.finish, args: [{ token, totalBytes: 9 }] },
			{ channel: CHANNELS.abort, args: [{ token }] },
			{ channel: CHANNELS.reveal, args: [{ token }] },
		]);
		expect(calls[1].args[0].data).toBe(data); // the bytes themselves are not copied
	});

	test("what the main process answers or throws comes back unchanged", async () => {
		const failure = new Error("Error invoking remote method 'ccut-export:write': ExportIpcError: CCUT_EXPORT:DISK_FULL");
		const { api } = loadPreload({
			invoke: async (channel) => {
				if (channel === CHANNELS.write) throw failure;
				return { ok: true, token, displayName: "a.mp4" };
			},
		});
		expect(await api.begin(beginRequest())).toEqual({ ok: true, token, displayName: "a.mp4" });
		expect(await rejection(api.write({ token, position: 0, data: new Uint8Array(1) }))).toBe(failure.message);
	});
});

describe("preload.js: begin is checked before anything is sent (the main process would deserialize it first)", () => {
	test("not a plain object: invalid, nothing sent", async () => {
		const { api, calls } = loadPreload();
		class Request {}
		for (const bad of [undefined, null, "x", 5, [], [beginRequest()], new Request(), Object.create({ container: "mp4" }), () => {}, new Map()]) {
			expect(await api.begin(bad)).toEqual({ ok: false, reason: "invalid" });
		}
		expect(calls).toEqual([]);
	});

	test("a suggested name of more than 1000 characters (the main process's own limit) is invalid; 1000 is not", async () => {
		const { api, calls } = loadPreload();
		expect(await api.begin(beginRequest({ suggestedName: "a".repeat(MAX_SUGGESTED_NAME_CHARS + 1) }))).toEqual({ ok: false, reason: "invalid" });
		expect(calls).toEqual([]);
		await api.begin(beginRequest({ suggestedName: "a".repeat(MAX_SUGGESTED_NAME_CHARS) }));
		expect(calls).toHaveLength(1);
	});

	test("wrong types, or a container that is a long string, are invalid", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [
			beginRequest({ suggestedName: 5 }),
			beginRequest({ suggestedName: { toString: () => "x" } }),
			beginRequest({ container: 3 }),
			beginRequest({ container: "m".repeat(100_000) }),
			beginRequest({ estimatedBytes: "1" }),
			beginRequest({ estimatedBytes: { valueOf: () => 1 } }),
			{ suggestedName: "x", container: "mp4" },
		]) {
			expect(await api.begin(bad)).toEqual({ ok: false, reason: "invalid" });
		}
		expect(calls).toEqual([]);
	});

	test("values from the page's own JavaScript realm are accepted: a plain object and a Uint8Array made there", async () => {
		const { api, calls } = loadPreload();
		const pageObject = foreign(`({ suggestedName: "My film", container: "mp4", estimatedBytes: 1000 })`);
		expect(Object.getPrototypeOf(pageObject)).not.toBe(Object.prototype); // really another realm
		await api.begin(pageObject);
		const pageBytes = foreign(`new Uint8Array([1, 2, 3])`);
		expect(pageBytes instanceof Uint8Array).toBe(false);
		await api.write(foreign(`({ token: ${JSON.stringify(token)}, position: 0, data: new Uint8Array([1, 2, 3]) })`));
		await api.write({ token, position: 0, data: pageBytes });
		expect(calls.map((call) => call.channel)).toEqual([CHANNELS.begin, CHANNELS.write, CHANNELS.write]);
	});
});

describe("preload.js: write", () => {
	const chunk = (size) => new Uint8Array(size);

	test("not a plain object: INVALID, nothing sent", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [undefined, null, "x", [], [token, 0, chunk(1)], Object.create({ token, position: 0, data: chunk(1) })]) {
			expect(await rejection(api.write(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
	});

	test("data that is not a Uint8Array is INVALID: strings, arrays, ArrayBuffer, other typed arrays, DataView, look-alikes", async () => {
		const { api, calls } = loadPreload();
		const lookAlike = { byteLength: 3, buffer: new ArrayBuffer(3), [Symbol.toStringTag]: "Uint8Array" };
		for (const data of ["abc", [1, 2, 3], new ArrayBuffer(3), new Uint16Array(2), new Uint8ClampedArray(3), new DataView(new ArrayBuffer(3)), lookAlike, null, undefined, 3]) {
			expect(await rejection(api.write({ token, position: 0, data }))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
	});

	test("32 MiB (the main process's chunk limit) is the most one write may carry; empty is fine (the keepalive)", async () => {
		const { api, calls } = loadPreload();
		expect(await rejection(api.write({ token, position: 0, data: chunk(LIMITS.maxChunkBytes + 1) }))).toBe(INVALID);
		expect(calls).toEqual([]);
		expect(await rejection(api.write({ token, position: 0, data: chunk(LIMITS.maxChunkBytes) }))).toBe("resolved");
		expect(await rejection(api.write({ token, position: 0, data: chunk(0) }))).toBe("resolved");
		expect(calls).toHaveLength(2);
	});

	test("a small view into a huge buffer is refused: the whole backing buffer would cross the IPC", async () => {
		const { api, calls } = loadPreload();
		const huge = new ArrayBuffer(LIMITS.maxChunkBytes + 1);
		expect(await rejection(api.write({ token, position: 0, data: new Uint8Array(huge, 0, 4) }))).toBe(INVALID);
		expect(calls).toEqual([]);
	});

	test("a token that is not a short string, or a position that is not a number, is INVALID", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [
			{ token: 5, position: 0, data: chunk(1) },
			{ token: { id: token }, position: 0, data: chunk(1) },
			{ token: "t".repeat(100_000), position: 0, data: chunk(1) },
			{ token, position: "0", data: chunk(1) },
			{ token, position: { valueOf: () => 0 }, data: chunk(1) },
			{ token },
		]) {
			expect(await rejection(api.write(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
	});
});

describe("preload.js: finish, abort and reveal", () => {
	test("finish and abort refuse anything but a plain object with the right field types", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [undefined, null, "x", [], { token: 5, totalBytes: 1 }, { token, totalBytes: "1" }, { token: "t".repeat(100_000), totalBytes: 1 }]) {
			expect(await rejection(api.finish(bad))).toBe(INVALID);
		}
		for (const bad of [undefined, null, "x", [], { token: 5 }, { token: {} }, { token: "t".repeat(100_000) }]) {
			expect(await rejection(api.abort(bad))).toBe(INVALID);
		}
		expect(calls).toEqual([]);
	});

	test("reveal answers false, like the main process, for anything that is not a plain object with a token", async () => {
		const { api, calls } = loadPreload();
		for (const bad of [undefined, null, "x", [], { token: 5 }, { token: "t".repeat(100_000) }, {}]) {
			expect(await api.reveal(bad)).toBe(false);
		}
		expect(calls).toEqual([]);
	});
});

describe("preload.js: the limits are the main process's", () => {
	test("the numbers repeated in preload.js (it cannot import them) match export-files.js", () => {
		expect(LIMITS.maxChunkBytes).toBe(32 * 1024 * 1024);
		expect(MAX_SUGGESTED_NAME_CHARS).toBe(1000);
	});
});

describe("preload.js: window.ccutSystem (system-memory-ipc.js)", () => {
	const answer = { totalBytes: 1, availableBytes: 1, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: 1 };

	test("one frozen object with memoryInfo() only", () => {
		const { exposed } = loadPreload();
		const system = exposed.get("ccutSystem");
		expect(Object.keys(system)).toEqual(["memoryInfo"]);
		expect(Object.isFrozen(system)).toBe(true);
		expect(typeof system.memoryInfo).toBe("function");
	});

	test("invokes the one channel with no argument, whatever the page passes", async () => {
		const { exposed, calls } = loadPreload({ invoke: async () => answer });
		const system = exposed.get("ccutSystem");
		expect(await system.memoryInfo()).toEqual(answer);
		await system.memoryInfo("/etc/passwd", { path: "/x" }, "x".repeat(100_000));
		expect(calls).toEqual([
			{ channel: SYSTEM_MEMORY_CHANNEL, args: [] },
			{ channel: SYSTEM_MEMORY_CHANNEL, args: [] },
		]);
		expect(SYSTEM_MEMORY_CHANNEL).toBe("ccut-system:memory-info");
	});

	test("the main process's null comes back as null; a failing invoke (no handler, closed window) is null too, never a rejection", async () => {
		const nothing = loadPreload({ invoke: async () => null }).exposed.get("ccutSystem");
		expect(await nothing.memoryInfo()).toBeNull();
		const failing = loadPreload({
			invoke: async () => {
				throw new Error("No handler registered for 'ccut-system:memory-info'");
			},
		}).exposed.get("ccutSystem");
		expect(await rejection(failing.memoryInfo())).toBe("resolved");
		expect(await failing.memoryInfo()).toBeNull();
	});
});
