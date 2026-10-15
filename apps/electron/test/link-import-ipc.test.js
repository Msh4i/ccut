const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CHANNELS, parseReadRequest, parseStartRequest, readLinkImportSeam, registerLinkImportIpc } = require("../link-import-ipc");
const { FAKE_MEDIA_BYTES, fakeMediaBytes } = require("./fixtures/fake-media");

// The IPC wiring with fake Electron objects, a real temporary userData and the fake yt-dlp:
// the sender check on every channel, payload checks in main, the test seam (unpackaged only),
// the consent dialog, window events, quit.

const ORIGIN = "ccut://app";
const FAKE = path.join(__dirname, "fixtures", "fake-yt-dlp.js");
const OPENPGP = path.join(__dirname, "fixtures", "openpgp");
const fixture = (name) => fs.readFileSync(path.join(OPENPGP, name));
let userData;
let registered;
beforeEach(async () => {
	userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-link-ipc-"));
});
afterEach(async () => {
	registered?.shutdown();
	registered = null;
	await fsp.rm(userData, { recursive: true, force: true });
});

function setup({ isPackaged = false, env = { PATH: process.env.PATH, CCUT_TEST_YTDLP: FAKE }, dialogAnswer = 1, fetch, platform = "linux", arch = "x64", signingKey } = {}) {
	const handlers = new Map();
	const listeners = new Map();
	const mainFrame = { url: `${ORIGIN}/editor/1` };
	const webContents = { id: 3, mainFrame, on: (name, fn) => listeners.set(name, fn) };
	const win = { webContents, isDestroyed: () => false };
	const dialogCalls = [];
	const logs = [];
	registered = registerLinkImportIpc({
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		dialog: {
			showMessageBox: async (parent, options) => {
				dialogCalls.push({ parent, options });
				return { response: dialogAnswer };
			},
		},
		app: { isPackaged, getPath: (name) => (name === "userData" ? userData : path.join(userData, name)) },
		getWindow: () => win,
		origin: ORIGIN,
		env,
		log: (line) => logs.push(line),
		platform,
		arch,
		fetch: fetch ?? (async () => Promise.reject(new Error("no network in tests"))),
		limits: { killGraceMs: 300 },
		signingKey,
	});
	const trusted = { sender: webContents, senderFrame: mainFrame };
	const call = (channel, ...args) => handlers.get(channel)(trusted, ...args);
	return { handlers, listeners, call, trusted, webContents, win, dialogCalls, logs };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

async function waitForState({ call, token, states, rounds = 200 }) {
	let status;
	for (let round = 0; round < rounds; round++) {
		status = await call(CHANNELS.status, { token });
		if (states.includes(status.state)) return status;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out; last ${JSON.stringify(status)}`);
}

const start = (overrides = {}) => ({ url: "https://www.youtube.com/watch?v=ok", mode: "video", quality: "best", ...overrides });
const jobDirs = () => {
	const dir = path.join(userData, "link-import", "jobs");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe("link import IPC wiring", () => {
	test("exactly the seven channels, and preload.js exposes exactly those under window.ccutLinkImport", () => {
		const { handlers } = setup();
		expect([...handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort());
		const preload = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
		const used = [...preload.matchAll(/"(ccut-link-import:[a-z-]+)"/g)].map((m) => m[1]).sort();
		expect(used).toEqual(Object.values(CHANNELS).sort());
		expect([...preload.matchAll(/exposeInMainWorld\("ccutLinkImport"/g)]).toHaveLength(1);
	});

	test("every channel refuses a sub-frame, another webContents, a null frame or another origin, before doing anything", async () => {
		const { handlers, webContents, dialogCalls } = setup();
		const untrusted = [
			{ sender: webContents, senderFrame: { url: `${ORIGIN}/x` } },
			{ sender: {}, senderFrame: webContents.mainFrame },
			{ sender: webContents, senderFrame: null },
		];
		for (const channel of Object.values(CHANNELS)) {
			for (const event of untrusted) {
				expect(await rejection(handlers.get(channel)(event, start()))).toBe("CCUT_LINK_IMPORT:FORBIDDEN");
			}
		}
		for (const url of ["https://evil.example/", "ccut://evil/editor", "https://app/editor"]) {
			webContents.mainFrame.url = url;
			expect(await rejection(handlers.get(CHANNELS.start)({ sender: webContents, senderFrame: webContents.mainFrame }, start()))).toBe("CCUT_LINK_IMPORT:FORBIDDEN");
		}
		expect(dialogCalls).toEqual([]);
		expect(jobDirs()).toEqual([]);
		expect(registered.jobs.isBusy()).toBe(false);
	});

	test("start with a malformed request is 'invalid' and starts nothing", async () => {
		const { call } = setup();
		for (const bad of [
			null,
			"https://www.youtube.com/watch?v=ok",
			[],
			start({ url: 5 }),
			start({ url: "x".repeat(2049) }),
			start({ mode: "exe" }),
			start({ mode: undefined }),
			start({ quality: "8k" }),
			start({ quality: 720 }),
			start({ quality: "__proto__" }),
			Object.assign(Object.create({ polluted: true }), start()),
		]) {
			expect(await call(CHANNELS.start, bad)).toEqual({ ok: false, code: "invalid" });
		}
		expect(registered.jobs.isBusy()).toBe(false);
	});

	test("the mux worker's mediabunny: in the packaged app only the vendored bundle (none here: no combining), in the repository the package", () => {
		const { resolveMediabunnyPath, muxWorkerPath } = require("../link-import-mux");
		const vendored = path.join(path.dirname(muxWorkerPath()), "vendor", "mediabunny.cjs");
		const expectedPackaged = fs.existsSync(vendored) ? vendored : null;
		setup({ isPackaged: true });
		expect(registered.jobs.mediabunnyPath).toBe(expectedPackaged);
		registered.jobs.shutdownSync();
		setup({ isPackaged: null }); // not known to be unpackaged: treated as packaged
		expect(registered.jobs.mediabunnyPath).toBe(expectedPackaged);
		registered.jobs.shutdownSync();
		setup({ isPackaged: false });
		expect(registered.jobs.mediabunnyPath).toBe(resolveMediabunnyPath({ workerDir: path.dirname(muxWorkerPath()), packaged: false }));
		expect(registered.jobs.mediabunnyPath).not.toBeNull();
	});

	test("a refused URL comes back as its code, not as an exception", async () => {
		const { call } = setup();
		expect(await call(CHANNELS.start, start({ url: "https://youtube.com.evil.com/watch?v=x" }))).toEqual({ ok: false, code: "url-refused" });
		expect(await call(CHANNELS.start, start({ url: "--exec=rm" }))).toEqual({ ok: false, code: "url-refused" });
	});

	test("the whole path through the channels: start, status until ready, chunked read, release", async () => {
		const { call } = setup();
		// a TikTok link: the single-file path, whose bytes are the fake's fixed pattern
		const started = await call(CHANNELS.start, start({ url: "https://www.tiktok.com/@someone/video/7234567890123456789?v=ok" }));
		expect(started).toEqual({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
		const status = await waitForState({ call, token: started.token, states: ["ready", "failed"] });
		expect(status.state).toBe("ready");
		expect(status.file.size).toBe(FAKE_MEDIA_BYTES);
		const parts = [];
		for (let offset = 0, round = 0; offset < status.file.size && round < 100; round++) {
			const bytes = await call(CHANNELS.read, { token: started.token, offset, length: 100_000 });
			parts.push(Buffer.from(bytes));
			offset += bytes.byteLength;
		}
		expect(Buffer.concat(parts).equals(fakeMediaBytes())).toBe(true);
		expect(await call(CHANNELS.release, { token: started.token })).toBe(true);
		expect(jobDirs()).toEqual([]);
		expect(await rejection(call(CHANNELS.status, { token: started.token }))).toBe("CCUT_LINK_IMPORT:UNKNOWN_JOB");
	});

	test("a YouTube video through the channels: combined from two streams into one MP4 (status says so, the bytes start with ftyp)", async () => {
		const { call } = setup();
		const started = await call(CHANNELS.start, start());
		const status = await waitForState({ call, token: started.token, states: ["ready", "failed"] });
		expect(status).toMatchObject({ state: "ready", fraction: null, file: { ext: "mp4", mime: "video/mp4", combined: true, width: 128, height: 72 } });
		const head = await call(CHANNELS.read, { token: started.token, offset: 0, length: 16 });
		expect(Buffer.from(head).subarray(4, 8).toString("latin1")).toBe("ftyp");
		expect(await call(CHANNELS.release, { token: started.token })).toBe(true);
		expect(jobDirs()).toEqual([]);
	});

	test("read/status/cancel/release with a malformed request: INVALID in main (nothing touched)", async () => {
		const { call } = setup();
		for (const channel of [CHANNELS.status, CHANNELS.cancel, CHANNELS.release, CHANNELS.read]) {
			for (const bad of [null, "token", [], { token: 5 }, { token: "t".repeat(129) }]) {
				expect(await rejection(call(channel, bad))).toBe("CCUT_LINK_IMPORT:INVALID");
			}
		}
		const token = "a".repeat(64);
		for (const bad of [{ token, offset: "0", length: 1 }, { token, offset: 0 }, { token, offset: 0, length: { valueOf: () => 1 } }]) {
			expect(await rejection(call(CHANNELS.read, bad))).toBe("CCUT_LINK_IMPORT:INVALID");
		}
	});

	test("an unexpected failure reaches the page as FAILED only; its text (paths) is logged", async () => {
		const { call, logs } = setup();
		registered.jobs.status = () => {
			throw new Error(`disk on fire at ${userData}/secret`);
		};
		expect(await rejection(call(CHANNELS.status, { token: "a".repeat(64) }))).toBe("CCUT_LINK_IMPORT:FAILED");
		expect(logs.some((line) => line.includes("secret"))).toBe(true);
	});

	test("the window navigates away, crashes or is destroyed: its job is stopped and deleted; same-document navigation is not", async () => {
		for (const fire of [
			(l) => l.get("did-start-navigation")({ isMainFrame: true, isSameDocument: false }),
			(l) => l.get("render-process-gone")(),
			(l) => l.get("destroyed")(),
		]) {
			const { call, listeners } = setup();
			const { token } = await call(CHANNELS.start, start({ url: "https://www.youtube.com/watch?v=slow" }));
			await waitForState({ call, token, states: ["downloading"] });
			listeners.get("did-start-navigation")({ isMainFrame: true, isSameDocument: true });
			listeners.get("did-start-navigation")({ isMainFrame: false, isSameDocument: false });
			// Long enough for a wrongly stopped job to have ended and been released.
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect((await call(CHANNELS.status, { token })).state).toBe("downloading");
			fire(listeners);
			for (let round = 0; round < 200 && registered.jobs.isBusy(); round++) await new Promise((resolve) => setTimeout(resolve, 20));
			expect(registered.jobs.isBusy()).toBe(false);
			expect(jobDirs()).toEqual([]);
			registered.shutdown();
			registered = null;
		}
	});

	test("shutdown (app quit) stops the running job and deletes its directory synchronously", async () => {
		const { call } = setup();
		const { token } = await call(CHANNELS.start, start({ url: "https://www.youtube.com/watch?v=slow" }));
		await waitForState({ call, token, states: ["downloading"] });
		registered.shutdown();
		expect(jobDirs()).toEqual([]);
	});

	test("startup sweep: leftovers of an earlier run are deleted (job dirs and half-downloaded tools)", async () => {
		const leftover = path.join(userData, "link-import", "jobs", "0123456789abcdef0123456789abcdef");
		await fsp.mkdir(leftover, { recursive: true });
		await fsp.mkdir(path.join(userData, "bin"), { recursive: true });
		await fsp.writeFile(path.join(userData, "bin", ".yt-dlp-0123456789abcdef.download"), "x");
		setup();
		await registered.ready;
		expect(jobDirs()).toEqual([]);
		expect(fs.readdirSync(path.join(userData, "bin"))).toEqual([]);
	});
});

describe("the test seam (CCUT_TEST_YTDLP)", () => {
	test("read only in an unpackaged build, only an absolute path", () => {
		expect(readLinkImportSeam({ isPackaged: false, env: { CCUT_TEST_YTDLP: FAKE } })).toBe(FAKE);
		expect(readLinkImportSeam({ isPackaged: true, env: { CCUT_TEST_YTDLP: FAKE } })).toBeNull();
		expect(readLinkImportSeam({ isPackaged: undefined, env: { CCUT_TEST_YTDLP: FAKE } })).toBeNull();
		expect(readLinkImportSeam({ isPackaged: false, env: { CCUT_TEST_YTDLP: "fake-yt-dlp.js" } })).toBeNull();
		expect(readLinkImportSeam({ isPackaged: false, env: {} })).toBeNull();
	});

	test("packaged: the seam variable is ignored; with no yt-dlp anywhere the consent dialog is asked; declining ends the job", async () => {
		const { call, dialogCalls, win, logs } = setup({ isPackaged: true, env: { PATH: "", CCUT_TEST_YTDLP: FAKE }, dialogAnswer: 1 });
		const { token } = await call(CHANNELS.start, start());
		const status = await waitForState({ call, token, states: ["failed", "ready"] });
		expect(status).toMatchObject({ state: "failed", code: "consent-declined" });
		expect(dialogCalls).toHaveLength(1);
		const { parent, options } = dialogCalls[0];
		expect(parent).toBe(win);
		expect(options.buttons).toEqual(["Download yt-dlp", "Cancel"]);
		expect(options.defaultId).toBe(1); // Enter does not download
		expect(options.cancelId).toBe(1);
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(options.detail).toContain('"yt-dlp_linux"');
		expect(options.detail).toContain("https://github.com/yt-dlp/yt-dlp/releases");
		expect(options.detail).toContain("SHA2-256SUMS");
		expect(options.detail).toContain("signature by the yt-dlp signing key built into Ccut");
		expect(options.detail).toContain("AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581");
		expect(options.detail).toContain("Unlicense");
		expect(options.detail).toContain("200 MB");
		expect(options.detail).toContain(path.join(userData, "bin"));
		expect(options.detail).toContain("It was not found on this computer.");
		expect(options.message).toBe("Download yt-dlp to import from links?");
		expect(logs.some((line) => line.includes("seam"))).toBe(false);
	});

	test("packaged, the yt-dlp on PATH is too old: the dialog names it, its version, the one needed and how to update; declining is tool-outdated", async () => {
		const oldBin = path.join(userData, "old-bin");
		fs.mkdirSync(oldBin);
		fs.writeFileSync(path.join(oldBin, "yt-dlp"), "#!/bin/sh\necho 2025.02.19\n", { mode: 0o755 });
		const { call, dialogCalls, logs } = setup({ isPackaged: true, env: { PATH: oldBin }, dialogAnswer: 1 });
		const { token } = await call(CHANNELS.start, start());
		const status = await waitForState({ call, token, states: ["failed", "ready"] });
		expect(status).toMatchObject({ state: "failed", code: "tool-outdated" });
		expect(dialogCalls).toHaveLength(1);
		const { options } = dialogCalls[0];
		expect(options.message).toBe("The yt-dlp on this computer is too old. Download a current copy for Ccut?");
		expect(options.detail).toContain(`The yt-dlp found at ${JSON.stringify(path.join(oldBin, "yt-dlp"))} is version 2025.02.19; Ccut needs 2025.03.21 or newer.`);
		expect(options.detail).toContain("yt-dlp -U");
		expect(options.detail).toContain("pip install -U yt-dlp");
		expect(options.detail).not.toContain("It was not found on this computer.");
		expect(options.buttons).toEqual(["Download yt-dlp", "Cancel"]);
		expect(options.defaultId).toBe(1);
		expect(logs.some((line) => line.includes("2025.02.19") && line.includes("2025.03.21"))).toBe(true);
	});

	test("packaged, consent given: the official binary is fetched, its signed sums verified, installed 0755, then run with the job's arguments", async () => {
		const tag = "2025.09.26";
		// The "binary": a shell script standing in for yt-dlp_linux that answers like a private video.
		// Its sums are signed by the test key (fixtures/openpgp), which this test passes as the signing key.
		const binary = fixture("release.sh");
		const sha = crypto.createHash("sha256").update(binary).digest("hex");
		const signingKey = { armored: fixture("test-key.asc").toString("utf8"), fingerprint: "9A837733E6D8970CF21377578E3B95A0078605B9" };
		const host = "https://release-assets.githubusercontent.com";
		const routes = {
			"https://github.com/yt-dlp/yt-dlp/releases/latest": { status: 302, location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`]: { status: 302, location: `${host}/sums` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS.sig`]: { status: 302, location: `${host}/sig` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux`]: { status: 302, location: `${host}/bin` },
			[`${host}/sums`]: { status: 200, body: fixture("test-sums") },
			[`${host}/sig`]: { status: 200, body: fixture("test-sums.sig") },
			[`${host}/bin`]: { status: 200, body: binary },
		};
		const fetched = [];
		const fetch = async (url, init) => {
			fetched.push(url);
			expect(init.redirect).toBe("manual");
			const route = routes[url] ?? { status: 404 };
			const headers = new Headers(route.location ? { location: route.location } : {});
			return { status: route.status, headers, body: { async *[Symbol.asyncIterator]() { if (route.body) yield new Uint8Array(route.body); } } };
		};
		const { call, dialogCalls } = setup({ isPackaged: true, env: { PATH: "" }, dialogAnswer: 0, fetch, signingKey });
		const { token } = await call(CHANNELS.start, start());
		const status = await waitForState({ call, token, states: ["failed", "ready"] });
		expect(dialogCalls).toHaveLength(1);
		expect(fetched).toHaveLength(7);
		expect(status).toMatchObject({ state: "failed", code: "private" }); // the installed binary really ran
		const installed = path.join(userData, "bin", "yt-dlp");
		expect(fs.statSync(installed).mode & 0o777).toBe(0o755);
		const manifest = JSON.parse(fs.readFileSync(path.join(userData, "bin", "yt-dlp.manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ sha256: sha, signingKey: signingKey.fingerprint });
		// The second import uses the installed copy: no dialog, nothing fetched.
		const second = await call(CHANNELS.start, start());
		expect(await waitForState({ call, token: second.token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "private" });
		expect(dialogCalls).toHaveLength(1);
		expect(fetched).toHaveLength(7);
	});

	test("packaged, consent given, but the sums are not signed by the embedded yt-dlp key: tool-signature-failed, nothing installed or run", async () => {
		const tag = "2025.09.26";
		const host = "https://release-assets.githubusercontent.com";
		const routes = {
			"https://github.com/yt-dlp/yt-dlp/releases/latest": { status: 302, location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`]: { status: 302, location: `${host}/sums` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS.sig`]: { status: 302, location: `${host}/sig` },
			[`${host}/sums`]: { status: 200, body: fixture("test-sums") },
			[`${host}/sig`]: { status: 200, body: fixture("test-sums.sig") }, // the test key's, not yt-dlp's
		};
		const fetched = [];
		const fetch = async (url) => {
			fetched.push(url);
			const route = routes[url] ?? { status: 404 };
			const headers = new Headers(route.location ? { location: route.location } : {});
			return { status: route.status, headers, body: { async *[Symbol.asyncIterator]() { if (route.body) yield new Uint8Array(route.body); } } };
		};
		const { call } = setup({ isPackaged: true, env: { PATH: "" }, dialogAnswer: 0, fetch });
		const { token } = await call(CHANNELS.start, start());
		expect(await waitForState({ call, token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "tool-signature-failed" });
		expect(fetched.some((url) => url.endsWith("/yt-dlp_linux"))).toBe(false);
		expect(fs.readdirSync(path.join(userData, "bin"))).toEqual([]);
	});
});

describe("request parsers", () => {
	test("start: only the three known fields come through", () => {
		expect(parseStartRequest({ ...start(), path: "/etc/passwd", extra: 1 })).toEqual(start());
	});

	test("start: refused in main already, before the job manager (which checks again)", () => {
		for (const bad of [
			null,
			[],
			"x",
			start({ url: 5 }),
			start({ url: "h".repeat(2049) }),
			start({ mode: "exe" }),
			start({ mode: ["video"] }),
			start({ quality: "8k" }),
			start({ quality: 720 }),
			start({ quality: "hasOwnProperty" }),
			Object.assign(Object.create({ polluted: true }), start()),
		]) {
			expect(parseStartRequest(bad)).toBeNull();
		}
		expect(parseStartRequest(start({ url: "h".repeat(2048) }))).not.toBeNull();
	});

	test("read: token, offset and length only, as given (the job manager checks the ranges)", () => {
		expect(parseReadRequest({ token: "a", offset: -1, length: 1e12, x: 1 })).toEqual({ token: "a", offset: -1, length: 1e12 });
		expect(parseReadRequest({ token: "a", offset: 0 })).toBeNull();
	});
});

describe("packaging", () => {
	test("every local module link-import-ipc.js loads (transitively) is in electron-builder's files list", () => {
		const files = require("../package.json").build.files;
		const seen = new Set();
		const visit = (name) => {
			if (seen.has(name)) return;
			seen.add(name);
			const text = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
			for (const [, required] of text.matchAll(/require\("\.\/([^"]+)"\)/g)) visit(required.endsWith(".js") ? required : `${required}.js`);
		};
		visit("link-import-ipc.js");
		expect([...seen].sort()).toEqual([
			"export-files.js",
			"link-import-args.js",
			"link-import-ipc.js",
			"link-import-jobs.js",
			"link-import-mux-worker.js",
			"link-import-mux.js",
			"link-import-openpgp.js",
			"link-import-parse.js",
			"link-import-process.js",
			"link-import-tool.js",
			"link-import-update.js",
			"link-import-url.js",
			"link-import-ytdlp-key.js",
		]);
		for (const name of seen) expect(files).toContain(name);
		// The mux worker runs as a plain Node worker: it and the mediabunny bundle it loads are
		// kept outside app.asar (link-import-mux.js muxWorkerPath), and bundle.js creates the bundle.
		expect(files).toContain("vendor/mediabunny.cjs");
		expect(require("../package.json").build.asarUnpack).toEqual(["link-import-mux-worker.js", "vendor/mediabunny.cjs", "stems_demucs_driver.py", "ccut-mcp.js"]);
		expect(fs.readFileSync(path.join(__dirname, "..", "bundle.js"), "utf8")).toContain("vendorMediabunny({ webDir: web, targetDir: __dirname })");
		// The worker loads nothing of the main process's modules (they stay inside app.asar).
		const worker = fs.readFileSync(path.join(__dirname, "..", "link-import-mux-worker.js"), "utf8");
		// ... and never mediabunny by name (only the absolute path the main process gives).
		expect([...worker.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]).sort()).toEqual(["node:fs", "node:fs/promises", "node:path", "node:worker_threads"]);
		const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
		expect(main).toContain('require("./link-import-ipc")');
	});
});
