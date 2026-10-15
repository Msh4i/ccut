const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CHANNELS, parseBeginRequest, registerExportIpc } = require("../export-ipc");

// The IPC wiring with fake Electron objects and a real temporary directory: sender
// checks on every channel, the dialog as the only path source, the seam, reveal.

const ORIGIN = "ccut://app";
let dir;
let registered;
beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-export-ipc-"));
});
afterEach(async () => {
	registered?.shutdown();
	registered = null;
	await fsp.rm(dir, { recursive: true, force: true });
});

function setup({ isPackaged = true, env = {}, dialogAnswer, dialogError, noVideosDir = false } = {}) {
	const handlers = new Map();
	const listeners = new Map();
	const mainFrame = { url: `${ORIGIN}/editor/1` };
	const webContents = {
		id: 3,
		mainFrame,
		on: (name, fn) => listeners.set(name, fn),
	};
	const win = { webContents, isDestroyed: () => false };
	const dialogCalls = [];
	const revealed = [];
	const logs = [];
	let uuid = 0;
	registered = registerExportIpc({
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		dialog: {
			showSaveDialog: async (parent, options) => {
				dialogCalls.push({ parent, options });
				if (dialogError) throw dialogError;
				return dialogAnswer ?? { canceled: true };
			},
		},
		shell: { showItemInFolder: (p) => revealed.push(p) },
		app: {
			isPackaged,
			getPath: (name) => {
				if (name === "videos" && noVideosDir) throw new Error("Failed to get 'videos' path");
				return name === "videos" ? path.join(dir, "Videos") : path.join(dir, "Home");
			},
		},
		getWindow: () => win,
		fs,
		fsp,
		origin: ORIGIN,
		env,
		log: (line) => logs.push(line),
		randomUUID: () => `uuid-${++uuid}`,
	});
	registered.watchWindow(win);
	const trusted = { sender: webContents, senderFrame: mainFrame };
	const call = (channel, ...args) => handlers.get(channel)(trusted, ...args);
	return { handlers, listeners, call, trusted, webContents, dialogCalls, revealed, logs, win };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

const request = (overrides = {}) => ({ suggestedName: "My film", container: "mp4", estimatedBytes: 1000, ...overrides });

describe("export IPC wiring", () => {
	test("exactly the five channels, and preload.js exposes exactly those under window.ccutExport", () => {
		const { handlers } = setup();
		expect([...handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort());
		const preload = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
		const used = [...preload.matchAll(/"(ccut-export:[a-z]+)"/g)].map((m) => m[1]).sort();
		expect(used).toEqual(Object.values(CHANNELS).sort());
		expect([...preload.matchAll(/exposeInMainWorld\("ccutExport"/g)]).toHaveLength(1); // every exposed name: preload.test.js
		expect(preload).not.toMatch(/ipcRenderer\s*[,)]\s*$/m); // ipcRenderer itself is never handed out
	});

	test("every channel refuses a sub-frame, another webContents or another origin, before doing anything", async () => {
		const { handlers, webContents, dialogCalls } = setup();
		const untrusted = [
			{ sender: webContents, senderFrame: { url: `${ORIGIN}/x` } },
			{ sender: {}, senderFrame: webContents.mainFrame },
			{ sender: webContents, senderFrame: null },
		];
		for (const channel of Object.values(CHANNELS)) {
			for (const event of untrusted) {
				expect(await rejection(handlers.get(channel)(event, request()))).toBe("CCUT_EXPORT:FORBIDDEN");
			}
		}
		webContents.mainFrame.url = "https://evil.example/";
		expect(await rejection(handlers.get(CHANNELS.begin)({ sender: webContents, senderFrame: webContents.mainFrame }, request()))).toBe(
			"CCUT_EXPORT:FORBIDDEN",
		);
		expect(dialogCalls).toEqual([]);
	});

	test("begin opens the save dialog in Videos with a cleaned name and the container's filter; the renderer never names a path", async () => {
		const { call, dialogCalls, win } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "chosen.mp4") } });
		const result = await call(CHANNELS.begin, request({ suggestedName: "../../etc/CON" }));
		// The page learns the token and the name: no path, no free-space figure.
		expect(result).toStrictEqual({ ok: true, token: "uuid-1", displayName: "chosen.mp4" });
		expect(dialogCalls).toHaveLength(1);
		expect(dialogCalls[0].parent).toBe(win);
		expect(dialogCalls[0].options.defaultPath).toBe(path.join(dir, "Videos", "etc-CON.mp4"));
		expect(dialogCalls[0].options.filters).toEqual([{ name: "MP4 video", extensions: ["mp4"] }]);
		expect(fs.readdirSync(dir).sort()).toEqual(["chosen.mp4.ccut-part"]);
		await call(CHANNELS.abort, { token: result.token });
	});

	test("begin with a malformed request is 'invalid' and opens no dialog", async () => {
		const { call, dialogCalls } = setup();
		for (const bad of [
			null,
			"x",
			[],
			request({ container: "exe" }),
			request({ suggestedName: 5 }),
			request({ suggestedName: "a".repeat(1001) }),
			request({ estimatedBytes: -1 }),
			request({ estimatedBytes: Number.NaN }),
			request({ estimatedBytes: "1" }),
			Object.assign(Object.create({ polluted: true }), request()),
		]) {
			expect(await call(CHANNELS.begin, bad)).toEqual({ ok: false, reason: "invalid" });
		}
		expect(dialogCalls).toEqual([]);
	});

	test("an unexpected failure (here the dialog) reaches the page as WRITE_FAILED only: its text, with paths, is logged, not sent", async () => {
		const { call, logs } = setup({ dialogError: new Error(`dialog failed for ${dir}/secret`) });
		expect(await rejection(call(CHANNELS.begin, request()))).toBe("CCUT_EXPORT:WRITE_FAILED");
		expect(logs.some((line) => line.includes("secret"))).toBe(true);
		expect(registered.sessions.isBusy()).toBe(false);
	});

	test("no Videos folder known: the dialog starts in the home folder", async () => {
		const { call, dialogCalls } = setup({ noVideosDir: true });
		await call(CHANNELS.begin, request());
		expect(dialogCalls[0].options.defaultPath).toBe(path.join(dir, "Home", "My film.mp4"));
	});

	test("a cancelled dialog is 'cancelled' and leaves nothing behind", async () => {
		const { call } = setup({ dialogAnswer: { canceled: true, filePath: "" } });
		expect(await call(CHANNELS.begin, request())).toEqual({ ok: false, reason: "cancelled" });
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("write/finish/abort with a non-object request are INVALID", async () => {
		const { call } = setup();
		for (const channel of [CHANNELS.write, CHANNELS.finish, CHANNELS.abort]) {
			expect(await rejection(call(channel, "uuid-1", 0, new Uint8Array(1)))).toBe("CCUT_EXPORT:INVALID");
		}
		expect(await call(CHANNELS.reveal, "uuid-1")).toBe(false);
	});

	test("reload of the page (main-frame navigation) deletes the part file; same-document navigation does not", async () => {
		const { call, listeners } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "a.mp4") } });
		const { token } = await call(CHANNELS.begin, request());
		await call(CHANNELS.write, { token, position: 0, data: new Uint8Array(10) });
		listeners.get("did-start-navigation")({ isMainFrame: true, isSameDocument: true });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fs.readdirSync(dir)).toEqual(["a.mp4.ccut-part"]);
		listeners.get("did-start-navigation")({ isMainFrame: true, isSameDocument: false });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("a sub-frame navigating (an iframe, an ad) does not touch the export; the main frame's own events and the window's end do", async () => {
		const { call, listeners } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "a.mp4") } });
		const { token } = await call(CHANNELS.begin, request());
		await call(CHANNELS.write, { token, position: 0, data: new Uint8Array(10) });
		listeners.get("did-start-navigation")({ isMainFrame: false, isSameDocument: false });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fs.readdirSync(dir)).toEqual(["a.mp4.ccut-part"]);
		expect(registered.hasOpenExport()).toBe(true);
	});

	for (const event of ["render-process-gone", "destroyed"]) {
		test(`${event}: the window's part file is deleted and the export lock is released`, async () => {
			const { call, listeners } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "a.mp4") } });
			const { token } = await call(CHANNELS.begin, request());
			await call(CHANNELS.write, { token, position: 0, data: new Uint8Array(10) });
			expect(fs.readdirSync(dir)).toEqual(["a.mp4.ccut-part"]);
			listeners.get(event)();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fs.readdirSync(dir)).toEqual([]);
			expect(registered.hasOpenExport()).toBe(false);
		});
	}

	test("the renderer's keepalive (a zero-length write) passes through the channel and writes nothing", async () => {
		const { call } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "a.mp4") } });
		const { token } = await call(CHANNELS.begin, request());
		await call(CHANNELS.write, { token, position: 0, data: new Uint8Array(0) });
		await call(CHANNELS.write, { token, position: 0, data: new Uint8Array([1, 2, 3]) });
		await call(CHANNELS.write, { token, position: 0, data: new Uint8Array(0) });
		expect(fs.statSync(path.join(dir, "a.mp4.ccut-part")).size).toBe(3);
		await call(CHANNELS.abort, { token });
	});

	test("a long project name: the dialog's suggestion stays within the file system's limits (bytes, not characters)", async () => {
		const { call, dialogCalls } = setup({ dialogAnswer: { canceled: true } });
		for (const suggestedName of ["中".repeat(200), "😀".repeat(250), "a".repeat(1000), "é".repeat(1000)]) {
			await call(CHANNELS.begin, request({ suggestedName }));
		}
		expect(dialogCalls).toHaveLength(4);
		for (const { options } of dialogCalls) {
			const base = path.basename(options.defaultPath);
			expect(Buffer.byteLength(`${base}.ccut-part`)).toBeLessThanOrEqual(255);
			expect(base.endsWith(".mp4")).toBe(true);
		}
	});

	test("a chosen name that is too long for the file system comes back as its own reason", async () => {
		const { call } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, `${"a".repeat(260)}.mp4`) } });
		expect(await call(CHANNELS.begin, request())).toEqual({ ok: false, reason: "name-too-long" });
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("hasOpenExport is true from begin until the export is finished or aborted", async () => {
		const { call } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "a.mp4") } });
		expect(registered.hasOpenExport()).toBe(false);
		const { token } = await call(CHANNELS.begin, request());
		expect(registered.hasOpenExport()).toBe(true);
		await call(CHANNELS.abort, { token });
		expect(registered.hasOpenExport()).toBe(false);
	});

	test("shutdown deletes an open part file at once", async () => {
		const { call } = setup({ dialogAnswer: { canceled: false, filePath: path.join(dir, "a.mp4") } });
		await call(CHANNELS.begin, request());
		registered.shutdown();
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});

describe("export IPC test seam", () => {
	test("packaged: the seam variables are ignored and the dialog is used", async () => {
		const { call, dialogCalls, logs } = setup({ isPackaged: true, env: { CCUT_TEST_EXPORT_DIR: dir } });
		expect(await call(CHANNELS.begin, request())).toEqual({ ok: false, reason: "cancelled" });
		expect(dialogCalls).toHaveLength(1);
		expect(logs).toEqual([]);
	});

	test("unpackaged with the seam: no dialog, a cleaned name in the seam dir, one stderr line, reveal goes to reveal.log", async () => {
		const { call, dialogCalls, logs, revealed } = setup({ isPackaged: false, env: { CCUT_TEST_EXPORT_DIR: dir } });
		expect(logs).toHaveLength(1);
		const { token, displayName } = await call(CHANNELS.begin, request({ suggestedName: "../evil/name" }));
		expect(displayName).toBe("evil-name.mp4");
		expect(dialogCalls).toEqual([]);
		expect(await call(CHANNELS.reveal, { token })).toBe(false); // not completed yet
		const box = (size, type) => {
			const b = Buffer.alloc(size);
			b.writeUInt32BE(size, 0);
			b.write(type, 4, "latin1");
			return b;
		};
		const file = new Uint8Array(Buffer.concat([box(16, "ftyp"), box(8, "moov"), box(8, "mdat")]));
		await call(CHANNELS.write, { token, position: 0, data: file });
		expect(await call(CHANNELS.finish, { token, totalBytes: file.length })).toEqual({ displayName: "evil-name.mp4", bytes: file.length });
		expect(await call(CHANNELS.reveal, { token })).toBe(true);
		expect(revealed).toEqual([]);
		expect(fs.readFileSync(path.join(dir, "reveal.log"), "utf8")).toBe(`${path.join(dir, "evil-name.mp4")}\n`);
	});

	test("the seam's byte limit makes a write fail as DISK_FULL and leaves no file", async () => {
		const { call } = setup({ isPackaged: false, env: { CCUT_TEST_EXPORT_DIR: dir, CCUT_TEST_EXPORT_FAIL_AFTER_BYTES: "100" } });
		const { token } = await call(CHANNELS.begin, request());
		await call(CHANNELS.write, { token, position: 0, data: new Uint8Array(100) });
		expect(await rejection(call(CHANNELS.write, { token, position: 100, data: new Uint8Array(1) }))).toBe("CCUT_EXPORT:DISK_FULL");
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});

describe("packaging", () => {
	test("every local module main.js, export-ipc.js, system-memory-ipc.js and perf-switches.js load, and preload.js, are in electron-builder's files list", () => {
		const files = require("../package.json").build.files;
		const local = new Set(["preload.js"]);
		for (const source of ["main.js", "export-ipc.js", "system-memory-ipc.js", "perf-switches.js"]) {
			const text = fs.readFileSync(path.join(__dirname, "..", source), "utf8");
			for (const [, name] of text.matchAll(/require\("\.\/([^"]+)"\)/g)) local.add(name.endsWith(".js") ? name : `${name}.js`);
		}
		// Other features' modules (link-import-ipc.js, ...) have their own packaging tests.
		expect([...local]).toEqual(expect.arrayContaining(["env.js", "export-files.js", "export-ipc.js", "preload.js", "stub-env.js"]));
		for (const name of local) expect(files).toContain(name);
	});
});

describe("parseBeginRequest", () => {
	test("keeps only the three known fields", () => {
		expect(parseBeginRequest({ ...request(), path: "/etc/passwd" })).toEqual(request());
	});
});
