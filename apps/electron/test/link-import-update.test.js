const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CHANNELS, registerLinkImportIpc } = require("../link-import-ipc");
const { ToolError, installManagedBinary, resolveLatestTag } = require("../link-import-tool");
const { DAY_MS, STATE_NAME, createUpdateService, readUpdateState } = require("../link-import-update");

// The update POLICY (L9): a once-a-day tag check for the managed copy only, an update only on the
// user's click and only through the signed install, never a change to a yt-dlp on PATH.

const OPENPGP = path.join(__dirname, "fixtures", "openpgp");
const fixture = (name) => fs.readFileSync(path.join(OPENPGP, name));
const TEST_KEY = Object.freeze({ armored: fixture("test-key.asc").toString("utf8"), fingerprint: "9A837733E6D8970CF21377578E3B95A0078605B9" });
const RELEASE = fixture("release.sh");
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

let dir;
let binDir;
beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-link-update-"));
	binDir = path.join(dir, "bin");
	await fsp.mkdir(binDir, { recursive: true });
});
afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

const statePath = () => path.join(binDir, STATE_NAME);
const writeState = (value) => fs.writeFileSync(statePath(), typeof value === "string" ? value : JSON.stringify(value));

/** The service with a fake clock and fake tag/install/dialog; `calls` records what happened. */
function service(overrides = {}) {
	const calls = { tags: 0, dialog: [], install: [] };
	const clock = { now: T0 };
	const deps = {
		binDir,
		platform: "linux",
		arch: "x64",
		readManaged: async () => ({ path: path.join(binDir, "yt-dlp"), version: "2025.09.01", sha256: "a".repeat(64) }),
		usablePathTool: async () => false,
		fetchLatestTag: async () => {
			calls.tags++;
			return "2026.09.30";
		},
		confirmUpdate: async (info) => {
			calls.dialog.push(info);
			return true;
		},
		install: async (info) => {
			calls.install.push(info);
			return { version: "2026.09.30" };
		},
		isBusy: () => false,
		log: () => {},
		now: () => clock.now,
		...overrides,
	};
	return { svc: createUpdateService(deps), calls, clock };
}

describe("check: once a day, managed copy only, a version string and nothing else", () => {
	test("first open queries once and offers the newer tag; the same day answers from the stored result without a request; a day later it asks again", async () => {
		const { svc, calls, clock } = service();
		expect(await svc.check()).toBe("2026.09.30");
		expect(calls.tags).toBe(1);
		clock.now += DAY_MS - 1;
		expect(await svc.check()).toBe("2026.09.30");
		expect(calls.tags).toBe(1);
		clock.now += 1;
		expect(await svc.check()).toBe("2026.09.30");
		expect(calls.tags).toBe(2);
		expect(JSON.parse(fs.readFileSync(statePath(), "utf8"))).toEqual({ checkedAt: clock.now, latest: "2026.09.30" });
		expect(fs.readdirSync(binDir)).toEqual([STATE_NAME]); // no temp file left
	});

	test("concurrent opens share one query", async () => {
		const { svc, calls } = service();
		const answers = await Promise.all([svc.check(), svc.check(), svc.check()]);
		expect(answers).toEqual(["2026.09.30", "2026.09.30", "2026.09.30"]);
		expect(calls.tags).toBe(1);
	});

	test("a failed query counts as the day's attempt (no retry storm) and offers nothing", async () => {
		const { svc, calls } = service({
			fetchLatestTag: async () => {
				throw new ToolError("tool-download-failed");
			},
		});
		expect(await svc.check()).toBeNull();
		expect(await svc.check()).toBeNull();
		expect(calls.tags).toBe(0);
		expect(JSON.parse(fs.readFileSync(statePath(), "utf8"))).toEqual({ checkedAt: T0, latest: null });
	});

	test("corrupt, oversize, wrong-shaped or future-dated state is 'never checked': it queries and replaces the file", async () => {
		const bad = ["{not json", "", "[]", "null", JSON.stringify({ checkedAt: "x", latest: null }), JSON.stringify({ checkedAt: T0, latest: "<script>" }), JSON.stringify({ checkedAt: T0 + 10 * DAY_MS, latest: null }), JSON.stringify({ checkedAt: -5, latest: null }), `{"checkedAt":${T0},"latest":null,"pad":"${"x".repeat(2000)}"}`];
		for (const text of bad) {
			writeState(text);
			const { svc, calls } = service();
			expect(await svc.check()).toBe("2026.09.30");
			expect(calls.tags).toBe(1);
			expect(await readUpdateState({ binDir, now: T0 })).toEqual({ checkedAt: T0, latest: "2026.09.30" });
		}
		// a symlink in the state's place is not followed
		fs.rmSync(statePath());
		fs.writeFileSync(path.join(dir, "elsewhere.json"), JSON.stringify({ checkedAt: T0, latest: null }));
		fs.symlinkSync(path.join(dir, "elsewhere.json"), statePath());
		expect(await readUpdateState({ binDir, now: T0 })).toBeNull();
	});

	test("a clock a few minutes ahead is tolerated; a stored time in the past of more than a day is due", async () => {
		writeState({ checkedAt: T0 + 60_000, latest: null });
		const first = service();
		expect(await first.svc.check()).toBeNull();
		expect(first.calls.tags).toBe(0);
		writeState({ checkedAt: T0 - DAY_MS - 1, latest: null });
		const second = service();
		expect(await second.svc.check()).toBe("2026.09.30");
	});

	test("a state file that cannot be written means no query at all", async () => {
		const { svc, calls } = service({ fsApi: { ...fsp, writeFile: async () => Promise.reject(new Error("EROFS")), lstat: fsp.lstat, readFile: fsp.readFile, unlink: fsp.unlink, rename: fsp.rename } });
		expect(await svc.check()).toBeNull();
		expect(calls.tags).toBe(0);
	});

	test("nothing is asked when there is no managed copy, or a yt-dlp on PATH meets the floor (the managed one is not in use)", async () => {
		for (const overrides of [{ readManaged: async () => null }, { usablePathTool: async () => true }]) {
			const { svc, calls } = service(overrides);
			expect(await svc.check()).toBeNull();
			expect(calls.tags).toBe(0);
			expect(fs.existsSync(statePath())).toBe(false);
		}
	});

	test("a running job: no PATH process and no query (the offer waits for the next open)", async () => {
		let pathChecks = 0;
		const { svc, calls } = service({ isBusy: () => true, usablePathTool: async () => (pathChecks++, false) });
		expect(await svc.check()).toBeNull();
		expect(pathChecks).toBe(0);
		expect(calls.tags).toBe(0);
	});

	test("the PATH version check is remembered for a minute (fake clock), then asked again", async () => {
		let pathChecks = 0;
		const { svc, clock } = service({ usablePathTool: async () => (pathChecks++, true) });
		await svc.check();
		clock.now += 59_000;
		await svc.check();
		expect(pathChecks).toBe(1);
		clock.now += 1_000;
		await svc.check();
		expect(pathChecks).toBe(2);
	});

	test("a tag that is not newer than the installed copy, or not a tag at all, is never offered", async () => {
		for (const tag of ["2025.09.01", "2025.08.01", "garbage", "", null, "2026.09.30\n", "2026.09.30 ; rm"]) {
			fs.rmSync(statePath(), { force: true });
			const { svc } = service({ fetchLatestTag: async () => tag });
			expect(await svc.check()).toBeNull();
		}
	});
});

describe("the tag query is the installer's hardened one: a failed or malicious answer never offers an update", () => {
	const answer = ({ status = 302, location }) => async () => ({ status, headers: new Headers(location ? { location } : {}), body: { cancel() {} } });
	const offered = async (fetch) => {
		fs.rmSync(statePath(), { force: true });
		const { svc } = service({ fetchLatestTag: ({ signal }) => resolveLatestTag({ fetch, signal }) });
		return svc.check();
	};

	test("a real redirect to a tag page is offered; everything else is not", async () => {
		expect(await offered(answer({ location: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.09.30" }))).toBe("2026.09.30");
		for (const bad of [
			answer({ status: 200 }),
			answer({ status: 404 }),
			answer({ location: "https://evil.example/yt-dlp/yt-dlp/releases/tag/2026.09.30" }),
			answer({ location: "http://github.com/yt-dlp/yt-dlp/releases/tag/2026.09.30" }),
			answer({ location: "https://github.com/evil/yt-dlp/releases/tag/2026.09.30" }),
			answer({ location: "https://github.com/yt-dlp/yt-dlp/releases/tag/latest" }),
			answer({ location: "https://github.com/yt-dlp/yt-dlp/releases/tag/2026.09.30?x=1" }),
			answer({ location: "https://github.com/yt-dlp/yt-dlp/releases/tag/9999.99.99.99999999999" }),
			async () => Promise.reject(new Error("offline")),
		]) {
			expect(await offered(bad)).toBeNull();
		}
	});

	test("a query that never answers ends at its time limit", async () => {
		const { svc } = service({ tagTimeoutMs: 30, fetchLatestTag: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
		expect(await svc.check()).toBeNull();
	});
});

describe("update: the user's click", () => {
	test("shows the dialog with the installed and the newest version, installs through the verified path (newerThan = installed), remembers it", async () => {
		const { svc, calls } = service();
		expect(await svc.update()).toEqual({ ok: true, version: "2026.09.30" });
		expect(calls.dialog).toEqual([{ asset: "yt-dlp_linux", current: "2025.09.01", latest: "2026.09.30" }]);
		expect(calls.install).toEqual([{ newerThan: "2025.09.01" }]);
		expect(await readUpdateState({ binDir, now: T0 })).toEqual({ checkedAt: T0, latest: "2026.09.30" });
	});

	test("while it installs the job manager is told (isUpdating) and a click can not start another; it is false again afterwards", async () => {
		let release;
		let during = null;
		const { svc } = service({ install: () => new Promise((resolve) => (release = () => resolve({ version: "2026.09.30" }))) });
		const click = svc.update();
		await new Promise((resolve) => setTimeout(resolve, 10));
		during = svc.isUpdating();
		release();
		await click;
		expect(during).toBe(true);
		expect(svc.isUpdating()).toBe(false);
	});

	test("declined: nothing is installed; already the newest: no dialog and no install", async () => {
		const declined = service({ confirmUpdate: async () => false });
		expect(await declined.svc.update()).toEqual({ ok: false, code: "consent-declined" });
		expect(declined.calls.install).toEqual([]);
		const same = service({ fetchLatestTag: async () => "2025.09.01" });
		expect(await same.svc.update()).toEqual({ ok: false, code: "up-to-date" });
		expect(same.calls.dialog).toEqual([]);
	});

	test("no managed copy, a platform without a binary, a job running, or a second click while one runs: refused", async () => {
		expect(await service({ readManaged: async () => null }).svc.update()).toEqual({ ok: false, code: "tool-missing" });
		expect(await service({ arch: "arm64" }).svc.update()).toEqual({ ok: false, code: "tool-missing" });
		expect(await service({ isBusy: () => true }).svc.update()).toEqual({ ok: false, code: "busy" });
		let release;
		const slow = service({ confirmUpdate: () => new Promise((resolve) => (release = resolve)) });
		const first = slow.svc.update();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await slow.svc.update()).toEqual({ ok: false, code: "busy" });
		release(true);
		expect(await first).toEqual({ ok: true, version: "2026.09.30" });
	});

	test("install failures come back as their code (never text); anything unexpected is tool-download-failed", async () => {
		for (const [error, code] of [
			[new ToolError("tool-signature-failed"), "tool-signature-failed"],
			[new ToolError("tool-verify-failed"), "tool-verify-failed"],
			[new Error("/home/me/secret path"), "tool-download-failed"],
		]) {
			const { svc } = service({
				install: async () => {
					throw error;
				},
			});
			expect(await svc.update()).toEqual({ ok: false, code });
		}
	});
});

describe("installManagedBinary with newerThan: a stale redirect cannot replace a newer copy with an older one", () => {
	function github(tag) {
		const host = "https://release-assets.githubusercontent.com";
		const routes = {
			"https://github.com/yt-dlp/yt-dlp/releases/latest": { status: 302, location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`]: { status: 302, location: `${host}/sums` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS.sig`]: { status: 302, location: `${host}/sig` },
			[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux`]: { status: 302, location: `${host}/bin` },
			[`${host}/sums`]: { status: 200, body: fixture("test-sums") },
			[`${host}/sig`]: { status: 200, body: fixture("test-sums.sig") },
			[`${host}/bin`]: { status: 200, body: RELEASE },
		};
		const urls = [];
		const fetch = async (url) => {
			urls.push(url);
			const route = routes[url] ?? { status: 404 };
			return { status: route.status, headers: new Headers(route.location ? { location: route.location } : {}), body: { async *[Symbol.asyncIterator]() { if (route.body) yield new Uint8Array(route.body); } } };
		};
		return { fetch, urls };
	}
	const run = ({ fetch, newerThan }) => installManagedBinary({ fetch, binDir, platform: "linux", arch: "x64", signingKey: TEST_KEY, newerThan });

	test("an equal or older tag is refused after the tag request alone", async () => {
		for (const tag of ["2025.09.01", "2025.04.01"]) {
			const { fetch, urls } = github(tag);
			await expect(run({ fetch, newerThan: "2025.09.01" })).rejects.toMatchObject({ code: "tool-download-failed" });
			expect(urls).toEqual(["https://github.com/yt-dlp/yt-dlp/releases/latest"]);
		}
		expect(fs.existsSync(path.join(binDir, "yt-dlp"))).toBe(false);
	});

	test("a newer tag installs", async () => {
		const { fetch } = github("2025.09.26");
		expect(await run({ fetch, newerThan: "2025.09.01" })).toMatchObject({ version: "2025.09.26" });
	});
});

// --- through the real IPC registration: sender check, no payload, the signed install, PATH untouched ---

const ORIGIN = "ccut://app";
let registered;
afterEach(() => {
	registered?.shutdown();
	registered = null;
});

function ipc({ env, fetch, signingKey = TEST_KEY, dialogAnswer = 0, dialogGate = null }) {
	const handlers = new Map();
	const mainFrame = { url: `${ORIGIN}/editor/1` };
	const webContents = { id: 3, mainFrame, on() {} };
	const win = { webContents, isDestroyed: () => false };
	const dialogCalls = [];
	registered = registerLinkImportIpc({
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		dialog: {
			showMessageBox: async (_parent, options) => {
				dialogCalls.push(options);
				if (dialogGate) await dialogGate;
				return { response: dialogAnswer };
			},
		},
		app: { isPackaged: true, getPath: () => dir },
		getWindow: () => win,
		origin: ORIGIN,
		env,
		log: () => {},
		platform: "linux",
		arch: "x64",
		fetch,
		signingKey,
	});
	const trusted = { sender: webContents, senderFrame: mainFrame };
	const call = (channel, ...args) => handlers.get(channel)(trusted, ...args);
	return { handlers, webContents, call, dialogCalls };
}

function fakeGitHub({ tag, sums = fixture("test-sums"), sig = fixture("test-sums.sig") }) {
	const host = "https://release-assets.githubusercontent.com";
	const routes = {
		"https://github.com/yt-dlp/yt-dlp/releases/latest": { status: 302, location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}` },
		[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`]: { status: 302, location: `${host}/sums` },
		[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS.sig`]: { status: 302, location: `${host}/sig` },
		[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux`]: { status: 302, location: `${host}/bin` },
		[`${host}/sums`]: { status: 200, body: sums },
		[`${host}/sig`]: { status: 200, body: sig },
		[`${host}/bin`]: { status: 200, body: RELEASE },
	};
	const urls = [];
	const fetch = async (url) => {
		urls.push(url);
		const route = routes[url] ?? { status: 404 };
		return { status: route.status, headers: new Headers(route.location ? { location: route.location } : {}), body: { async *[Symbol.asyncIterator]() { if (route.body) yield new Uint8Array(route.body); } } };
	};
	return { fetch, urls };
}

/** An older managed copy, installed for real (verified with the test key) from a fake release. */
async function installOlderManagedCopy() {
	await installManagedBinary({ fetch: fakeGitHub({ tag: "2025.04.01" }).fetch, binDir, platform: "linux", arch: "x64", signingKey: TEST_KEY });
	return fs.readFileSync(path.join(binDir, "yt-dlp"));
}

const manifestVersion = () => JSON.parse(fs.readFileSync(path.join(binDir, "yt-dlp.manifest.json"), "utf8")).version;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

describe("the IPC channels", () => {
	test("both refuse an untrusted sender before anything else, and refuse any payload", async () => {
		const { handlers, webContents, call, dialogCalls } = ipc({ env: { PATH: "" }, fetch: async () => Promise.reject(new Error("offline")) });
		for (const channel of [CHANNELS.updateCheck, CHANNELS.update]) {
			for (const event of [{ sender: webContents, senderFrame: { url: `${ORIGIN}/x` } }, { sender: {}, senderFrame: webContents.mainFrame }, { sender: webContents, senderFrame: null }]) {
				await expect(handlers.get(channel)(event)).rejects.toThrow("CCUT_LINK_IMPORT:FORBIDDEN");
			}
			for (const payload of [{}, { version: "2026.09.30" }, "x", null, 0]) {
				await expect(call(channel, payload)).rejects.toThrow("CCUT_LINK_IMPORT:INVALID");
			}
		}
		expect(dialogCalls).toEqual([]);
	});

	test("no managed copy: update-check answers null without a request; update answers tool-missing without a dialog", async () => {
		const requests = [];
		const { call, dialogCalls } = ipc({ env: { PATH: "" }, fetch: async (url) => (requests.push(url), Promise.reject(new Error("offline"))) });
		expect(await call(CHANNELS.updateCheck)).toEqual({ version: null });
		expect(await call(CHANNELS.update)).toEqual({ ok: false, code: "tool-missing" });
		expect(requests).toEqual([]);
		expect(dialogCalls).toEqual([]);
	});

	test("an older managed copy: the check offers the newer tag (once a day), the click shows what is downloaded from where and to where, and installs the signed release", async () => {
		await installOlderManagedCopy();
		expect(manifestVersion()).toBe("2025.04.01");
		const github = fakeGitHub({ tag: "2025.09.26" });
		const { call, dialogCalls } = ipc({ env: { PATH: "" }, fetch: github.fetch });
		expect(await call(CHANNELS.updateCheck)).toEqual({ version: "2025.09.26" });
		expect(await call(CHANNELS.updateCheck)).toEqual({ version: "2025.09.26" });
		expect(github.urls).toEqual(["https://github.com/yt-dlp/yt-dlp/releases/latest"]); // one tag request, no binary, no sums
		expect(dialogCalls).toEqual([]);

		expect(await call(CHANNELS.update)).toEqual({ ok: true, version: "2025.09.26" });
		expect(dialogCalls).toHaveLength(1);
		const [options] = dialogCalls;
		expect(options.buttons).toEqual(["Update yt-dlp", "Cancel"]);
		expect(options.defaultId).toBe(1);
		expect(options.detail).toContain("2025.04.01");
		expect(options.detail).toContain("2025.09.26");
		expect(options.detail).toContain("https://github.com/yt-dlp/yt-dlp/releases");
		expect(options.detail).toContain(binDir);
		expect(options.detail).toContain("9A83 7733 E6D8 970C F213 7757 8E3B 95A0 0786 05B9"); // the key the signature must match
		expect(manifestVersion()).toBe("2025.09.26");
		expect(await call(CHANNELS.updateCheck)).toEqual({ version: null });
	});

	test("sums that do not match their signature (the signing key is the one the install pins): tool-signature-failed, the binary is never requested, the old copy stays", async () => {
		const before = await installOlderManagedCopy();
		const tampered = Buffer.from(fixture("test-sums"));
		tampered[0] = tampered[0] === 0x30 ? 0x31 : 0x30;
		const github = fakeGitHub({ tag: "2025.09.26", sums: tampered });
		const { call } = ipc({ env: { PATH: "" }, fetch: github.fetch });
		expect(await call(CHANNELS.update)).toEqual({ ok: false, code: "tool-signature-failed" });
		expect(github.urls.some((url) => url.endsWith("/yt-dlp_linux"))).toBe(false);
		expect(fs.readFileSync(path.join(binDir, "yt-dlp"))).toEqual(before);
		expect(manifestVersion()).toBe("2025.04.01");
	});

	test("a start while an update is waiting in its dialog or installing is busy (both directions)", async () => {
		await installOlderManagedCopy();
		let open;
		const gate = new Promise((resolve) => (open = resolve));
		const { call } = ipc({ env: { PATH: "" }, fetch: fakeGitHub({ tag: "2025.09.26" }).fetch, dialogGate: gate });
		const click = call(CHANNELS.update);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await call(CHANNELS.start, { url: "https://www.youtube.com/watch?v=x", mode: "video", quality: "best" })).toEqual({ ok: false, code: "busy" });
		open();
		expect(await click).toEqual({ ok: true, version: "2025.09.26" });
		expect(manifestVersion()).toBe("2025.09.26");
	});

	test("declined in the dialog: no signature or binary request, nothing changes", async () => {
		await installOlderManagedCopy();
		const github = fakeGitHub({ tag: "2025.09.26" });
		const { call } = ipc({ env: { PATH: "" }, fetch: github.fetch, dialogAnswer: 1 });
		expect(await call(CHANNELS.update)).toEqual({ ok: false, code: "consent-declined" });
		expect(github.urls).toEqual(["https://github.com/yt-dlp/yt-dlp/releases/latest"]);
		expect(manifestVersion()).toBe("2025.04.01");
	});

	test("a yt-dlp on PATH that meets the floor: no offer, no request; and it is never modified by any of this", async () => {
		await installOlderManagedCopy();
		const pathDir = path.join(dir, "pathbin");
		fs.mkdirSync(pathDir, { mode: 0o755 });
		const tool = path.join(pathDir, "yt-dlp");
		fs.writeFileSync(tool, "#!/bin/sh\necho 2025.09.01\n", { mode: 0o755 });
		const snapshot = () => ({ names: fs.readdirSync(pathDir), bytes: fs.readFileSync(tool, "utf8"), mtime: fs.statSync(tool).mtimeMs, mode: fs.statSync(tool).mode });
		const before = snapshot();
		const github = fakeGitHub({ tag: "2025.09.26" });
		const { call } = ipc({ env: { PATH: pathDir }, fetch: github.fetch });
		expect(await call(CHANNELS.updateCheck)).toEqual({ version: null });
		expect(github.urls).toEqual([]);
		// the explicit click (a page that offers it only for the managed copy) still only touches bin/
		expect(await call(CHANNELS.update)).toEqual({ ok: true, version: "2025.09.26" });
		expect(snapshot()).toEqual(before);
		expect(manifestVersion()).toBe("2025.09.26");
	});

	test("a yt-dlp on PATH below the floor does not hide the managed copy's update offer", async () => {
		await installOlderManagedCopy();
		const pathDir = path.join(dir, "pathbin");
		fs.mkdirSync(pathDir, { mode: 0o755 });
		fs.writeFileSync(path.join(pathDir, "yt-dlp"), "#!/bin/sh\necho 2024.01.01\n", { mode: 0o755 });
		const { call } = ipc({ env: { PATH: pathDir }, fetch: fakeGitHub({ tag: "2025.09.26" }).fetch });
		expect(await call(CHANNELS.updateCheck)).toEqual({ version: "2025.09.26" });
		expect(fs.readdirSync(path.join(dir, "link-import"))).toEqual([]); // the throwaway directory of the version check is gone
	});
});
