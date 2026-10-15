const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CHANNELS, JOB_LIMITS, parseBeginRequest, parseReadRequest, parseWriteRequest, registerStemsIpc } = require("../stems-ipc");

// The IPC wiring with fake Electron objects, a real temporary userData and a fake engine: the
// sender check on every channel, payload checks in main, the whole flow, the engine check before
// a run, window events, quit.

const ORIGIN = "ccut://app";
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
let userData;
let driverPath;
let registered;
beforeEach(async () => {
	userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-stems-ipc-"));
	driverPath = path.join(userData, "driver.py");
	await fsp.writeFile(driverPath, "print('driver')\n");
});
afterEach(async () => {
	registered?.shutdown();
	registered = null;
	await fsp.rm(userData, { recursive: true, force: true });
});

/** An installed, sound engine on disk (what a finished install leaves). */
function installFakeEngine() {
	const engine = path.join(userData, "stems", "engine");
	const real = path.join(engine, "python", "bin", "python3");
	fs.mkdirSync(path.dirname(real), { recursive: true });
	fs.writeFileSync(real, "PYTHON");
	fs.mkdirSync(path.join(engine, "venv", "bin"), { recursive: true });
	fs.symlinkSync(real, path.join(engine, "venv", "bin", "python"));
	const checkpoints = path.join(userData, "stems", "torch", "hub", "checkpoints");
	fs.mkdirSync(checkpoints, { recursive: true });
	fs.writeFileSync(path.join(checkpoints, "model.th"), "MODEL");
	fs.writeFileSync(
		path.join(engine, "manifest.json"),
		JSON.stringify({ schema: 1, modelId: "htdemucs", modelFileName: "model.th", uvVersion: "0.5.0", pythonVersion: "3.12.7", interpreterSha256: null, modelSizeBytes: 5, modelSha256: sha256(Buffer.from("MODEL")), driverSha256: sha256(fs.readFileSync(driverPath)), pythonSha256: sha256(Buffer.from("PYTHON")) }),
	);
}

// Pins that describe exactly the engine installFakeEngine() leaves (the check compares the manifest to the pins).
const ENGINE_PINS = {
	schema: 1,
	uv: { version: "0.5.0", url: "https://github.com/astral-sh/uv/releases/download/0.5.0/uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "11".repeat(32), sizeBytes: 1000 },
	python: { version: "3.12.7" },
	lockFile: "stems-requirements.lock",
	syncCacheBytes: 1000,
	installSizeBytes: 1000,
	model: { id: "htdemucs", fileName: "model.th", url: "https://dl.fbaipublicfiles.com/demucs/model.th", sha256: sha256(Buffer.from("MODEL")), sizeBytes: 5, redirectHosts: [] },
};

const FRAMES = 1000;
const SAMPLES = 500;
function fakeEngine({ jobDir }) {
	for (const name of ["drums", "bass", "other", "vocals"]) {
		const data = new Float32Array(SAMPLES).fill(name === "drums" ? 0.5 : 0);
		fs.writeFileSync(path.join(jobDir, `${name}.f32`), Buffer.from(data.buffer));
	}
	return Promise.resolve({ ok: true });
}

function setup({ runEngine = fakeEngine, platform = "linux", arch = "x64", pins } = {}) {
	const handlers = new Map();
	const listeners = new Map();
	const mainFrame = { url: `${ORIGIN}/editor/1` };
	const webContents = { id: 3, mainFrame, on: (name, fn) => listeners.set(name, fn) };
	const win = { webContents, isDestroyed: () => false };
	const dialogCalls = [];
	const logs = [];
	registered = registerStemsIpc({
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		dialog: {
			showMessageBox: async (...args) => {
				dialogCalls.push(args);
				return { response: 1 };
			},
		},
		app: { getPath: () => userData },
		getWindow: () => win,
		origin: ORIGIN,
		log: (line) => logs.push(line),
		platform,
		arch,
		runEngine,
		driverPath,
		pins: pins ?? require("../stems-pins.json"),
		readLock: async () => "",
		fetch: async () => Promise.reject(new Error("no network in tests")),
		spawn: () => {
			throw new Error("no processes in tests");
		},
	});
	const trusted = { sender: webContents, senderFrame: mainFrame };
	const call = (channel, ...args) => handlers.get(channel)(trusted, ...args);
	return { handlers, listeners, call, trusted, webContents, dialogCalls, logs };
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

const pcm = (bytes) => new Uint8Array(bytes).map((_, i) => i % 251);

describe("the sender check", () => {
	test("every one of the eleven channels refuses a foreign sender or frame before looking at the payload", async () => {
		installFakeEngine();
		const { handlers, call, webContents } = setup({ pins: ENGINE_PINS });
		expect(Object.values(CHANNELS)).toHaveLength(11);
		expect([...handlers.keys()].sort()).toEqual(Object.values(CHANNELS).sort());
		const other = { id: 9, mainFrame: { url: `${ORIGIN}/x` } };
		const subFrame = { url: `${ORIGIN}/editor/1` };
		const senders = [
			{ sender: other, senderFrame: other.mainFrame }, // another web contents
			{ sender: webContents, senderFrame: subFrame }, // not the main frame
			{ sender: webContents, senderFrame: null },
			undefined,
		];
		for (const channel of Object.values(CHANNELS)) {
			for (const event of senders) expect(await rejection(handlers.get(channel)(event, { token: "x" }))).toBe("CCUT_STEMS:FORBIDDEN");
		}
		const evil = { sender: webContents, senderFrame: webContents.mainFrame };
		for (const channel of Object.values(CHANNELS)) {
			webContents.mainFrame.url = "https://evil.example/editor/1"; // the right frame, but not our origin
			expect(await rejection(handlers.get(channel)(evil, {}))).toBe("CCUT_STEMS:FORBIDDEN");
		}
		webContents.mainFrame.url = `${ORIGIN}/editor/1`;
		expect(await rejection(call(CHANNELS.status))).toBe("resolved");
	});
});

describe("payload checks in main", () => {
	test("status, install, cancel-install, remove-engine take no payload at all", async () => {
		const { call } = setup();
		for (const channel of [CHANNELS.status, CHANNELS.install, CHANNELS.cancelInstall, CHANNELS.removeEngine]) {
			for (const payload of [{}, null, "x", 0, []]) expect(await rejection(call(channel, payload))).toBe("CCUT_STEMS:INVALID");
		}
		expect(await call(CHANNELS.status)).toEqual({ supported: true, engine: "missing", installSizeBytes: require("../stems-pins.json").installSizeBytes, installPercent: null, modelId: "htdemucs" });
		expect(await call(CHANNELS.cancelInstall)).toEqual({ ok: false });
	});

	test("remove-engine asks in the main process first; declined keeps everything", async () => {
		installFakeEngine();
		const { call, dialogCalls } = setup({ pins: ENGINE_PINS }); // the fake dialog answers "Cancel"
		expect(await call(CHANNELS.removeEngine)).toEqual({ ok: false });
		expect(dialogCalls).toHaveLength(1);
		expect(dialogCalls[0][1].message).toContain("Remove");
		expect(fs.existsSync(path.join(userData, "stems", "engine", "manifest.json"))).toBe(true);
		expect(await call(CHANNELS.status)).toMatchObject({ engine: "ready" });
	});

	test("install with the pins as shipped from the cloud: pins-missing, no dialog; elsewhere unsupported", async () => {
		const first = setup();
		expect(await first.call(CHANNELS.install)).toEqual({ ok: false, code: "pins-missing" });
		expect(first.dialogCalls).toEqual([]);
		registered.shutdown();
		const second = setup({ platform: "win32" });
		expect(await second.call(CHANNELS.install)).toEqual({ ok: false, code: "unsupported" });
	});

	test("begin: a malformed request is { ok: false, code: 'invalid' }; the ranges are the job manager's", async () => {
		installFakeEngine();
		const { call } = setup({ pins: ENGINE_PINS });
		for (const bad of [undefined, null, "x", [], { frames: "10", sampleRate: 44100 }, { frames: 10 }, { frames: 10, sampleRate: "44100" }, Object.create({ frames: 10, sampleRate: 44100 })]) {
			expect(await call(CHANNELS.begin, bad)).toEqual({ ok: false, code: "invalid" });
		}
		expect(await call(CHANNELS.begin, { frames: 10, sampleRate: 12345 })).toEqual({ ok: false, code: "invalid" });
		expect(await call(CHANNELS.begin, { frames: 15 * 60 * 44100 + 1, sampleRate: 44100 })).toEqual({ ok: false, code: "too-long" });
		expect(parseBeginRequest({ frames: 1, sampleRate: 2, path: "/etc" })).toEqual({ frames: 1, sampleRate: 2 });
	});

	test("begin without an installed engine: engine-missing", async () => {
		const { call } = setup();
		expect(await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 })).toEqual({ ok: false, code: "engine-missing" });
	});

	test("write: token, a number position, a small Uint8Array (a view of a big buffer is refused: it would clone all of it)", async () => {
		installFakeEngine();
		const { call } = setup({ pins: ENGINE_PINS });
		const { token } = await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 });
		const hugeBacking = new Uint8Array(new ArrayBuffer(JOB_LIMITS.maxChunkBytes + 1), 0, 16);
		for (const bad of [undefined, "x", { token, position: 0 }, { token, position: "0", data: pcm(4) }, { token: 5, position: 0, data: pcm(4) }, { token, position: 0, data: [1, 2] }, { token, position: 0, data: new Int16Array(2) }, { token, position: 0, data: hugeBacking }, { token, position: 0, data: new Uint8Array(JOB_LIMITS.maxChunkBytes + 1) }]) {
			expect(await rejection(call(CHANNELS.write, bad))).toBe("CCUT_STEMS:INVALID");
		}
		expect(parseWriteRequest({ token, position: 0, data: pcm(4), extra: 1 })).toEqual({ token, position: 0, data: pcm(4) });
		expect(await call(CHANNELS.write, { token, position: 0, data: pcm(8), extra: "ignored" })).toEqual({ ok: true });
	});

	test("job-status, cancel, release: a bad token is INVALID; a token nobody knows is UNKNOWN_JOB (status) or { ok: false }", async () => {
		const { call } = setup();
		for (const channel of [CHANNELS.jobStatus, CHANNELS.cancel, CHANNELS.release]) {
			for (const bad of [undefined, null, "x", {}, { token: 5 }, { token: "t".repeat(129) }]) expect(await rejection(call(channel, bad))).toBe("CCUT_STEMS:INVALID");
		}
		expect(await rejection(call(CHANNELS.jobStatus, { token: "nope" }))).toBe("CCUT_STEMS:UNKNOWN_JOB");
		expect(await call(CHANNELS.cancel, { token: "nope" })).toEqual({ ok: false });
		expect(await call(CHANNELS.release, { token: "nope" })).toEqual({ ok: false });
		expect(await call(CHANNELS.run, { token: "nope" })).toEqual({ ok: false, code: "invalid" });
		expect(await call(CHANNELS.run, { token: 5 })).toEqual({ ok: false, code: "invalid" });
	});

	test("read: a known stem and numbers, else INVALID", async () => {
		const { call } = setup();
		for (const bad of [undefined, { token: "t", stem: "piano", offset: 0, length: 1 }, { token: "t", stem: "drums", offset: "0", length: 1 }, { token: "t", stem: "drums", offset: 0 }, { token: "t", offset: 0, length: 1 }]) {
			expect(await rejection(call(CHANNELS.read, bad))).toBe("CCUT_STEMS:INVALID");
		}
		expect(parseReadRequest({ token: "t", stem: "bass", offset: 1, length: 2, x: 1 })).toEqual({ token: "t", stem: "bass", offset: 1, length: 2 });
	});
});

describe("a whole separation through the channels", () => {
	test("begin, write in chunks, run, status, read all four stems, release", async () => {
		installFakeEngine();
		const { call } = setup({ pins: ENGINE_PINS });
		const begun = await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 });
		expect(begun).toEqual({ ok: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 })).toEqual({ ok: false, code: "busy" });
		const { token } = begun;
		const data = pcm(FRAMES * 4);
		expect(await call(CHANNELS.write, { token, position: 0, data: data.slice(0, 1500) })).toEqual({ ok: true });
		expect(await rejection(call(CHANNELS.write, { token, position: 0, data: data.slice(0, 10) }))).toBe("CCUT_STEMS:INVALID");
		expect(await call(CHANNELS.run, { token })).toEqual({ ok: false, code: "invalid" });
		expect(await call(CHANNELS.write, { token, position: 1500, data: data.slice(1500) })).toEqual({ ok: true });
		expect(await call(CHANNELS.run, { token })).toEqual({ ok: true });
		await registered.jobs.job.task;
		expect(await call(CHANNELS.jobStatus, { token })).toEqual({ state: "done", percent: 100, samples: SAMPLES });
		const drums = await call(CHANNELS.read, { token, stem: "drums", offset: 0, length: 4 });
		expect(Array.from(new Int16Array(drums.buffer, drums.byteOffset, 2))).toEqual([16384, 16384]);
		const vocals = await call(CHANNELS.read, { token, stem: "vocals", offset: 0, length: 4 });
		expect(Array.from(vocals)).toEqual([0, 0, 0, 0]);
		expect(await call(CHANNELS.release, { token })).toEqual({ ok: true });
		expect(await rejection(call(CHANNELS.jobStatus, { token }))).toBe("CCUT_STEMS:UNKNOWN_JOB");
	});

	test("the engine is checked again right before the run: a changed driver ends the job as engine-failed without starting the engine", async () => {
		installFakeEngine();
		let started = false;
		const { call, logs } = setup({
			pins: ENGINE_PINS,
			runEngine: (args) => {
				started = true;
				return fakeEngine(args);
			},
		});
		const { token } = await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 });
		await call(CHANNELS.write, { token, position: 0, data: pcm(FRAMES * 4) });
		fs.appendFileSync(driverPath, "# tampered\n");
		await call(CHANNELS.run, { token });
		await registered.jobs.job.task;
		expect(await call(CHANNELS.jobStatus, { token })).toMatchObject({ state: "failed", code: "engine-failed" });
		expect(started).toBe(false);
		expect(await call(CHANNELS.status)).toMatchObject({ engine: "broken" });
		expect(logs.join("\n")).not.toContain(userData);
	});

	test("an engine that ran out of memory ends the job with the code out-of-memory (and no text)", async () => {
		installFakeEngine();
		const { call } = setup({ pins: ENGINE_PINS, runEngine: async () => ({ ok: false, code: "out-of-memory", detail: "/secret/path" }) });
		const { token } = await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 });
		await call(CHANNELS.write, { token, position: 0, data: pcm(FRAMES * 4) });
		await call(CHANNELS.run, { token });
		await registered.jobs.job.task;
		expect(await call(CHANNELS.jobStatus, { token })).toEqual({ state: "failed", percent: 0, code: "out-of-memory" });
	});

	test("the page's reload or navigation ends its job; quit deletes it", async () => {
		installFakeEngine();
		const { call, listeners } = setup({ pins: ENGINE_PINS });
		await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 });
		const dir = registered.jobs.job.dir;
		expect(fs.existsSync(dir)).toBe(true);
		listeners.get("did-start-navigation")({ isMainFrame: true, isSameDocument: true });
		expect(fs.existsSync(dir)).toBe(true);
		listeners.get("did-start-navigation")({ isMainFrame: true, isSameDocument: false });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fs.existsSync(dir)).toBe(false);

		await call(CHANNELS.begin, { frames: FRAMES, sampleRate: 44100 });
		const second = registered.jobs.job.dir;
		registered.shutdown();
		expect(fs.existsSync(second)).toBe(false);
	});

	test("the start-up sweep removes job directories and an unfinished install left by a crash", async () => {
		fs.mkdirSync(path.join(userData, "stems", "jobs", "0123456789abcdef"), { recursive: true });
		fs.mkdirSync(path.join(userData, "stems", "engine", "venv"), { recursive: true });
		setup();
		await registered.ready;
		expect(fs.existsSync(path.join(userData, "stems", "jobs", "0123456789abcdef"))).toBe(false);
		expect(fs.existsSync(path.join(userData, "stems", "engine"))).toBe(false);
	});
});
