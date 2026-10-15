const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createStemsInstaller, lockUsable, validatePins } = require("../stems-install");
const { extractMember } = require("../stems-tar");
const shippedPins = require("../stems-pins.json");

// The installer with fake fetch, spawn and dialog on a real temporary userData: pins and lock
// gates, consent, hash checks, host rules, cancel, the manifest check before every run.

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// --- a tiny tar.gz writer (ustar) ---
function tarEntry({ name, body = Buffer.alloc(0), type = "0", prefix = "" }) {
	const header = Buffer.alloc(512);
	header.write(name, 0, "utf8");
	header.write("0000644\0", 100);
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write(type, 156);
	header.write("ustar\0", 257, "latin1");
	header.write(prefix, 345, "utf8");
	header.write("        ", 148); // checksum placeholder
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
	return Buffer.concat([header, body, pad]);
}
const tarGz = (entries) => zlib.gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));

const UV_BODY = Buffer.from("#!fake uv binary\n".repeat(50));
const UV_ARCHIVE = tarGz([
	{ name: "uv-x86_64-unknown-linux-gnu/", type: "5" },
	{ name: "uv-x86_64-unknown-linux-gnu/uvx", body: Buffer.from("not this one") },
	{ name: "uv-x86_64-unknown-linux-gnu/uv", body: UV_BODY },
]);
const MODEL_BODY = Buffer.from("model weights ".repeat(1000));
const LOCK = "torch==2.5.0 \\\n    --hash=sha256:" + "ab".repeat(32) + "\n";

const UV_URL = "https://github.com/astral-sh/uv/releases/download/0.5.0/uv-x86_64-unknown-linux-gnu.tar.gz";
const MODEL_URL = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th";

const goodPins = () => ({
	schema: 1,
	uv: { version: "0.5.0", url: UV_URL, sha256: sha256(UV_ARCHIVE), sizeBytes: UV_ARCHIVE.length },
	python: { version: "3.12.7" },
	lockFile: "stems-requirements.lock",
	syncCacheBytes: 1000,
	installSizeBytes: 950_000_000,
	model: { id: "htdemucs", fileName: "955717e8-8726e21a.th", url: MODEL_URL, sha256: sha256(MODEL_BODY), sizeBytes: MODEL_BODY.length, redirectHosts: [] },
});

let userData;
let driverPath;
beforeEach(async () => {
	userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-stems-install-"));
	driverPath = path.join(userData, "driver.py");
	await fsp.writeFile(driverPath, "print('driver')\n");
});
afterEach(async () => {
	await fsp.rm(userData, { recursive: true, force: true });
});

const engineDir = () => path.join(userData, "stems", "engine");
const torchDir = () => path.join(userData, "stems", "torch");
const exists = (file) => fs.existsSync(file);

// The engine check caches on size, modification time and inode. Two same-size writes within one clock
// tick would keep the key, so every rewrite gets its own, strictly later, modification time.
let mtimeTick = 0;
const stamp = (file) => {
	const when = new Date(Date.now() + 1000 * ++mtimeTick);
	fs.utimesSync(file, when, when);
};
const rewrite = (file, content) => {
	fs.writeFileSync(file, content);
	stamp(file);
};
const append = (file, content) => {
	fs.appendFileSync(file, content);
	stamp(file);
};

// A volume with plenty of room (the real one would make the tests depend on the machine's free space).
const roomyFs = { ...fsp, statfs: async () => ({ bavail: 2 ** 30, bsize: 4096 }) };

function routes(overrides = {}) {
	return new Map([
		[UV_URL, { body: UV_ARCHIVE }],
		[MODEL_URL, { body: MODEL_BODY }],
		...Object.entries(overrides),
	]);
}

function fakeFetch(table) {
	const requested = [];
	const fetch = async (url, options) => {
		requested.push({ url, options });
		const entry = table.get(url);
		if (!entry) return new Response("not found", { status: 404 });
		if (entry.redirect) return new Response(null, { status: 302, headers: { location: entry.redirect } });
		return new Response(entry.body, { status: 200, headers: { "content-length": String(entry.body.length) } });
	};
	return { fetch, requested };
}

/** uv and python as scripts: `handlers` map the first argument ("venv", "pip", "-I") to a function. */
function fakeTools(handlers = {}) {
	const spawned = [];
	const kills = [];
	const children = [];
	const spawn = (binary, args, options) => {
		const child = new EventEmitter();
		child.pid = 5000 + spawned.length;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		children.push(child);
		spawned.push({ binary, args, options });
		let exited = false;
		const exit = (code, signal = null) => {
			if (exited) return;
			exited = true;
			child.emit("exit", code, signal);
			child.emit("close", code, signal);
		};
		child.exitNow = exit;
		const handler = handlers[args[0]] ?? defaults[args[0]];
		queueMicrotask(async () => {
			try {
				const result = await handler({ args, options, exit });
				if (result !== "hang") exit(0);
			} catch {
				exit(1);
			}
		});
		return child;
	};
	const kill = (target, signal) => {
		kills.push({ target, signal });
		for (const child of children) child.exitNow(null, signal);
	};
	return { spawn, kill, spawned, kills };
}
const defaults = {
	venv: async ({ options }) => {
		const real = path.join(options.cwd, "python", "cpython-3.12", "bin", "python3.12");
		await fsp.mkdir(path.dirname(real), { recursive: true });
		await fsp.writeFile(real, "PYTHON INTERPRETER 1");
		await fsp.mkdir(path.join(options.cwd, "venv", "bin"), { recursive: true });
		await fsp.symlink(real, path.join(options.cwd, "venv", "bin", "python"));
	},
	pip: async ({ options, args }) => {
		expect(await fsp.readFile(args.at(-1), "utf8")).toBe(LOCK);
		await fsp.mkdir(options.env.UV_CACHE_DIR, { recursive: true });
		await fsp.writeFile(path.join(options.env.UV_CACHE_DIR, "wheel"), "x".repeat(500));
	},
	"-I": async () => {},
};

function setup({ pins = goodPins(), fetchTable = routes(), tools = fakeTools(), consent = true, confirmRemove = true, fsApi = roomyFs, platform = "linux", arch = "x64", lock = LOCK, isJobBusy = () => false, limits } = {}) {
	const net = fakeFetch(fetchTable);
	const dialogs = [];
	const removeDialogs = [];
	const logs = [];
	const installer = createStemsInstaller({
		userData,
		fsApi,
		pins,
		readLock: async () => {
			if (lock === null) throw new Error("ENOENT");
			return lock;
		},
		driverPath,
		spawn: tools.spawn,
		kill: tools.kill,
		fetch: net.fetch,
		confirm: async (options) => {
			dialogs.push(options);
			return typeof consent === "function" ? consent(options) : consent;
		},
		confirmRemove: async (options) => {
			removeDialogs.push(options);
			return confirmRemove;
		},
		platform,
		arch,
		isJobBusy,
		log: (line) => logs.push(line),
		limits,
		measure: async () => 0,
	});
	return { installer, net, tools, dialogs, removeDialogs, logs };
}

describe("pins and lock gates", () => {
	test("the pins shipped with the app are filled and valid (filled by the local session, see _note)", () => {
		expect(validatePins(shippedPins).ok).toBe(true);
		const fields = [shippedPins.uv.version, shippedPins.uv.url, shippedPins.uv.sha256, shippedPins.uv.sizeBytes, shippedPins.python.version, shippedPins.syncCacheBytes, shippedPins.installSizeBytes, shippedPins.model.fileName, shippedPins.model.url, shippedPins.model.sha256, shippedPins.model.sizeBytes];
		expect(fields.every((value) => value !== null && value !== undefined)).toBe(true);
		expect(shippedPins._note).toContain("LOCAL session");
	});

	test("pins-missing: no dialog, no download, no process, nothing on disk (a bad lock, or a null or malformed field)", async () => {
		const bad = goodPins();
		bad.model.sha256 = null;
		const short = goodPins();
		short.uv.sha256 = "abc";
		const insecure = goodPins();
		insecure.model.url = "http://dl.fbaipublicfiles.com/x.th";
		const traversal = goodPins();
		traversal.model.fileName = "../../evil";
		const elsewhere = goodPins();
		elsewhere.uv.url = "https://evil.example/0.5.0/uv.tar.gz";
		const cases = [
			{ pins: bad },
			{ pins: short },
			{ pins: insecure },
			{ pins: traversal },
			{ pins: elsewhere },
			{ lock: null },
			{ lock: "" },
			{ lock: "# placeholder: the local session fills this file\n" },
		];
		for (const options of cases) {
			const { installer, net, tools, dialogs } = setup(options);
			expect(await installer.install()).toEqual({ ok: false, code: "pins-missing" });
			expect(net.requested).toEqual([]);
			expect(tools.spawned).toEqual([]);
			expect(dialogs).toEqual([]);
			expect(exists(path.join(userData, "stems"))).toBe(false);
		}
		expect(validatePins(goodPins()).ok).toBe(true);
		expect(lockUsable(LOCK)).toBe(true);
	});

	test("not Linux x64: unsupported, and status says so", async () => {
		for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "arm64"]]) {
			const { installer, net, dialogs } = setup({ platform, arch });
			expect(await installer.install()).toEqual({ ok: false, code: "unsupported" });
			expect(await installer.status()).toEqual({ supported: false, engine: "missing", installSizeBytes: 950_000_000, installPercent: null, modelId: "htdemucs" });
			expect(net.requested).toEqual([]);
			expect(dialogs).toEqual([]);
		}
	});

	test("status: shipped pins give their installSizeBytes; a fresh machine is missing", async () => {
		expect(await setup({ pins: shippedPins }).installer.status()).toEqual({ supported: true, engine: "missing", installSizeBytes: shippedPins.installSizeBytes, installPercent: null, modelId: "htdemucs" });
	});
});

describe("consent", () => {
	test("declined: consent-declined, nothing downloaded, nothing started, nothing on disk", async () => {
		const { installer, net, tools } = setup({ consent: false });
		expect(await installer.install()).toEqual({ ok: false, code: "consent-declined" });
		expect(net.requested).toEqual([]);
		expect(tools.spawned).toEqual([]);
		expect(exists(engineDir())).toBe(false);
		expect((await installer.status()).engine).toBe("missing");
	});

	test("the dialog says what, where from, how big, where it is kept, offline afterwards, removable", async () => {
		const { installer, dialogs } = setup({ consent: false });
		await installer.install();
		expect(dialogs).toHaveLength(1);
		const { detail, buttons, message, signal } = dialogs[0];
		expect(buttons).toEqual(["Download and install", "Cancel"]);
		expect(message).toContain("stem");
		expect(signal).toBeInstanceOf(AbortSignal);
		for (const part of ["Python", "PyTorch", "Demucs", "0.95 GB", "github.com", "astral-sh/uv", "pypi.org", "files.pythonhosted.org", "download.pytorch.org", "dl.fbaipublicfiles.com", "offline", "remove", engineDir()]) {
			expect(detail).toContain(part);
		}
	});
});

describe("a full install", () => {
	test("downloads, verifies, builds the engine and ends ready; the check passes, then fails when anything it covers changes", async () => {
		const percents = [];
		let installerRef;
		const tools = fakeTools({
			venv: async (call) => {
				percents.push(await installerRef.status());
				await defaults.venv(call);
			},
		});
		const { installer, net, dialogs } = setup({ tools });
		installerRef = installer;
		expect(await installer.install()).toEqual({ ok: true });

		// progress was visible through status() while it ran
		expect(percents[0]).toMatchObject({ engine: "installing", installPercent: 5 });
		expect(await installer.status()).toEqual({ supported: true, engine: "ready", installSizeBytes: 950_000_000, installPercent: null, modelId: "htdemucs" });
		expect(dialogs).toHaveLength(1);

		// uv: only the `uv` member, executable, hashes and URLs as pinned
		const uv = path.join(engineDir(), "bin", "uv");
		expect(fs.readFileSync(uv).equals(UV_BODY)).toBe(true);
		expect(fs.statSync(uv).mode & 0o777).toBe(0o755);
		expect(net.requested.map((r) => r.url)).toEqual([UV_URL, MODEL_URL]);
		expect(net.requested.every((r) => r.options.redirect === "manual")).toBe(true);

		// processes: no shell, uv venv / pip sync / the smoke run, a clean environment inside engine/
		const [venv, sync, smoke] = tools.spawned;
		expect(venv.binary).toBe(uv);
		expect(venv.args).toEqual(["venv", "--python", "3.12.7", path.join(engineDir(), "venv")]);
		expect(sync.args).toEqual(["pip", "sync", "--require-hashes", "--no-build", "--python", path.join(engineDir(), "venv", "bin", "python"), path.join(engineDir(), "requirements.lock")]);
		expect(smoke.binary).toBe(path.join(engineDir(), "venv", "bin", "python"));
		expect(smoke.args.slice(0, 2)).toEqual(["-I", "-c"]);
		expect(smoke.args[2]).toContain("get_model(\"htdemucs\")");
		expect(smoke.args[2]).toContain("os.path.isfile(sys.argv[1])"); // the pinned file must exist before demucs runs
		expect(smoke.args[3]).toBe(path.join(torchDir(), "hub", "checkpoints", "955717e8-8726e21a.th"));
		for (const call of tools.spawned) {
			expect(call.options.shell).toBe(false);
			expect(call.options.env.HOME).toBe(path.join(engineDir(), "home"));
			expect(call.options.env.PATH).toBe("/usr/bin:/bin");
			expect(Object.keys(call.options.env).some((key) => /^PYTHON(?!IOENCODING|UTF8)/i.test(key))).toBe(false);
		}
		// uv sees no proxy variables; the smoke run only a dead one, so nothing can be downloaded there
		for (const call of [venv, sync]) expect(Object.keys(call.options.env).some((key) => /proxy/i.test(key))).toBe(false);
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(smoke.options.env[name]).toBe("http://127.0.0.1:9");
		expect(smoke.options.env.NO_PROXY).toBeUndefined();
		expect(venv.options.env).toMatchObject({ UV_CACHE_DIR: path.join(engineDir(), "cache"), UV_NO_CONFIG: "1", UV_PYTHON_PREFERENCE: "only-managed" });
		expect(smoke.options.env.TORCH_HOME).toBe(torchDir());

		// leftovers: the uv cache is gone, the model is in TORCH_HOME, the manifest is last
		expect(exists(path.join(engineDir(), "cache"))).toBe(false);
		expect(fs.readFileSync(path.join(torchDir(), "hub", "checkpoints", "955717e8-8726e21a.th")).equals(MODEL_BODY)).toBe(true);
		const manifest = JSON.parse(fs.readFileSync(path.join(engineDir(), "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ schema: 1, uvVersion: "0.5.0", pythonVersion: "3.12.7", modelId: "htdemucs", modelSizeBytes: MODEL_BODY.length, driverSha256: sha256(fs.readFileSync(driverPath)), pythonSha256: sha256(Buffer.from("PYTHON INTERPRETER 1")) });
		expect(fs.statSync(path.join(engineDir(), "manifest.json")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(engineDir()).mode & 0o777).toBe(0o700);

		// the check before every run
		expect(await installer.verifyEngine()).toBe(true);
		append(driverPath, "# changed\n");
		expect(await installer.verifyEngine()).toBe(false);
		expect((await installer.status()).engine).toBe("broken");
		rewrite(driverPath, "print('driver')\n");
		expect(await installer.verifyEngine()).toBe(true);
		const interpreter = path.join(engineDir(), "python", "cpython-3.12", "bin", "python3.12");
		rewrite(interpreter, "PYTHON INTERPRETER 2");
		expect(await installer.verifyEngine()).toBe(false);
		rewrite(interpreter, "PYTHON INTERPRETER 1");
		const checkpoint = path.join(torchDir(), "hub", "checkpoints", "955717e8-8726e21a.th");
		append(checkpoint, "x");
		expect(await installer.verifyEngine()).toBe(false);
		rewrite(checkpoint, MODEL_BODY);
		expect(await installer.verifyEngine()).toBe(true);
		// same size, one byte different: the checkpoint is hashed, not only measured
		const flipped = Buffer.from(MODEL_BODY);
		flipped[5] ^= 1;
		rewrite(checkpoint, flipped);
		expect(await installer.verifyEngine()).toBe(false);
		expect(installer.checkpointPath()).toBeNull();
		rewrite(checkpoint, MODEL_BODY);
		expect(await installer.verifyEngine()).toBe(true);
		expect(installer.checkpointPath()).toBe(checkpoint);
	});

	test("many parallel checks share one run, and an unchanged engine is not hashed again", async () => {
		await setup().installer.install();
		const opened = new Map();
		const counting = {
			...fsp,
			open: async (file, ...rest) => {
				opened.set(file, (opened.get(file) ?? 0) + 1);
				return fsp.open(file, ...rest);
			},
		};
		const { installer } = setup({ fsApi: counting });
		const answers = await Promise.all(Array.from({ length: 50 }, () => installer.status()));
		expect(answers.every((answer) => answer.engine === "ready")).toBe(true);
		const interpreter = path.join(engineDir(), "python", "cpython-3.12", "bin", "python3.12");
		expect(opened.get(interpreter)).toBe(1);
		expect(opened.get(driverPath)).toBe(1);
		expect(opened.get(path.join(torchDir(), "hub", "checkpoints", "955717e8-8726e21a.th"))).toBe(1);
		await installer.status();
		await installer.verifyEngine();
		expect(opened.get(interpreter)).toBe(1);
		// a changed file (new modification time) is hashed again
		rewrite(interpreter, "PYTHON INTERPRETER 2");
		expect(await installer.verifyEngine()).toBe(false);
		expect(opened.get(interpreter)).toBe(2);
	});

	test("a python that points outside the engine directory is not accepted", async () => {
		const outside = path.join(userData, "system-python");
		fs.writeFileSync(outside, "PYTHON INTERPRETER 1");
		const tools = fakeTools({
			venv: async ({ options }) => {
				await fsp.mkdir(path.join(options.cwd, "venv", "bin"), { recursive: true });
				await fsp.symlink(outside, path.join(options.cwd, "venv", "bin", "python"));
			},
		});
		const { installer } = setup({ tools });
		expect((await installer.install()).ok).toBe(false);
		expect(exists(engineDir())).toBe(false);
	});

	test("already installed and sound: install answers ok at once, no dialog, no download", async () => {
		const first = setup();
		await first.installer.install();
		const second = setup();
		expect(await second.installer.install()).toEqual({ ok: true });
		expect(second.dialogs).toEqual([]);
		expect(second.net.requested).toEqual([]);
	});

	test("remove asks first (a main-process dialog): declined deletes nothing, confirmed deletes the engine and the model", async () => {
		await setup().installer.install();
		const declined = setup({ confirmRemove: false });
		expect(await declined.installer.remove()).toEqual({ ok: false });
		expect(declined.removeDialogs).toHaveLength(1);
		expect(declined.removeDialogs[0]).toMatchObject({ buttons: ["Remove", "Cancel"], defaultId: 1, cancelId: 1 });
		expect(declined.removeDialogs[0].detail).toContain(engineDir());
		expect((await declined.installer.status()).engine).toBe("ready");
		const accepted = setup();
		expect(await accepted.installer.remove()).toEqual({ ok: true });
		expect(accepted.removeDialogs).toHaveLength(1);
		expect(exists(engineDir())).toBe(false);
		expect(exists(torchDir())).toBe(false);
	});

	test("broken: install replaces it; remove deletes the engine and the model", async () => {
		const first = setup();
		await first.installer.install();
		fs.appendFileSync(driverPath, "# changed\n");
		const second = setup();
		expect((await second.installer.status()).engine).toBe("broken");
		expect(await second.installer.install()).toEqual({ ok: true });
		expect(second.net.requested).toHaveLength(2);
		expect(await second.installer.remove()).toEqual({ ok: true });
		expect(exists(engineDir())).toBe(false);
		expect(exists(torchDir())).toBe(false);
		expect((await second.installer.status()).engine).toBe("missing");
	});
});

describe("failures remove everything of the install", () => {
	const expectClean = () => {
		expect(exists(engineDir())).toBe(false);
		expect(exists(torchDir())).toBe(false);
	};

	test("uv archive with a wrong hash (same size): verify-failed, the file is deleted, no process was started", async () => {
		const tampered = Buffer.from(UV_ARCHIVE);
		tampered[tampered.length - 12] ^= 0xff; // inside the compressed data, same length
		const { installer, tools } = setup({ fetchTable: routes({ [UV_URL]: { body: tampered } }) });
		expect(await installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expect(tools.spawned).toEqual([]);
		expectClean();
		expect((await installer.status()).engine).toBe("missing");
	});

	test("model with a wrong hash: verify-failed, no checkpoint, no manifest, nothing left", async () => {
		const tampered = Buffer.from(MODEL_BODY);
		tampered[10] ^= 1;
		const { installer } = setup({ fetchTable: routes({ [MODEL_URL]: { body: tampered } }) });
		expect(await installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expectClean();
	});

	test("a body longer or shorter than pinned is verify-failed", async () => {
		for (const body of [Buffer.concat([MODEL_BODY, Buffer.from("more")]), MODEL_BODY.subarray(0, MODEL_BODY.length - 1)]) {
			const { installer } = setup({ fetchTable: routes({ [MODEL_URL]: { body } }) });
			expect(await installer.install()).toEqual({ ok: false, code: "verify-failed" });
			expectClean();
		}
	});

	test("a redirect to a host that is not allowed, or to http, is download-failed; a 404 too", async () => {
		const MODEL_ALIAS = "https://dl.fbaipublicfiles.com/other";
		for (const table of [
			routes({ [UV_URL]: { redirect: "https://evil.example/uv.tar.gz" } }),
			routes({ [UV_URL]: { redirect: "http://github.com/uv.tar.gz" } }),
			routes({ [MODEL_URL]: { redirect: "https://evil.example/model.th" } }),
			routes({ [MODEL_URL]: { redirect: `${MODEL_ALIAS}` }, [MODEL_ALIAS]: { redirect: "https://user:pw@dl.fbaipublicfiles.com/x" } }),
			(() => {
				const t = routes();
				t.delete(MODEL_URL);
				return t;
			})(),
		]) {
			const { installer } = setup({ fetchTable: table });
			expect(await installer.install()).toEqual({ ok: false, code: "download-failed" });
			expectClean();
		}
	});

	test("a redirect inside the allow-list is followed (GitHub release assets)", async () => {
		const cdn = "https://release-assets.githubusercontent.com/some/path";
		const { installer, net } = setup({ fetchTable: routes({ [UV_URL]: { redirect: cdn }, [cdn]: { body: UV_ARCHIVE } }) });
		expect(await installer.install()).toEqual({ ok: true });
		expect(net.requested.map((r) => r.url).slice(0, 2)).toEqual([UV_URL, cdn]);
	});

	test("an archive without a `uv` member is verify-failed", async () => {
		const archive = tarGz([{ name: "uv-x86_64-unknown-linux-gnu/uvx", body: Buffer.from("x") }]);
		const pins = goodPins();
		pins.uv.sha256 = sha256(archive);
		pins.uv.sizeBytes = archive.length;
		const { installer, tools } = setup({ pins, fetchTable: routes({ [UV_URL]: { body: archive } }) });
		expect(await installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expect(tools.spawned).toEqual([]);
		expectClean();
	});

	test("uv failing is install-failed; the smoke run failing is verify-failed", async () => {
		const venvFails = setup({ tools: fakeTools({ venv: async () => { throw new Error("no python"); } }) });
		expect(await venvFails.installer.install()).toEqual({ ok: false, code: "install-failed" });
		expectClean();
		const syncFails = setup({ tools: fakeTools({ pip: async () => { throw new Error("hash mismatch"); } }) });
		expect(await syncFails.installer.install()).toEqual({ ok: false, code: "install-failed" });
		expectClean();
		const smokeFails = setup({ tools: fakeTools({ "-I": async () => { throw new Error("ImportError"); } }) });
		expect(await smokeFails.installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expectClean();
	});

	test("the smoke run: a second checkpoint appearing next to the pinned one, or the pinned file being replaced, is verify-failed", async () => {
		const folder = () => path.join(torchDir(), "hub", "checkpoints");
		const extraFile = setup({ tools: fakeTools({ "-I": async () => fsp.writeFile(path.join(folder(), "other-checkpoint.th"), "downloaded by torch.hub") }) });
		expect(await extraFile.installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expectClean();
		const replaced = setup({
			tools: fakeTools({
				"-I": async () => {
					const file = path.join(folder(), "955717e8-8726e21a.th");
					await fsp.rm(file);
					await fsp.writeFile(file, MODEL_BODY); // same bytes, a different file
				},
			}),
		});
		expect(await replaced.installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expectClean();
	});

	test("cancel while uv runs: the process group is killed, install ends, everything is removed", async () => {
		let started;
		const running = new Promise((resolve) => (started = resolve));
		const tools = fakeTools({ pip: async () => (started(), "hang") });
		const { installer } = setup({ tools });
		const install = installer.install();
		await running;
		expect((await installer.status()).engine).toBe("installing");
		expect(await installer.cancelInstall()).toEqual({ ok: true });
		expect(await install).toEqual({ ok: false, code: "install-failed" });
		expect(tools.kills.some((kill) => kill.signal === "SIGTERM" && kill.target < 0)).toBe(true);
		expectClean();
		expect(await installer.cancelInstall()).toEqual({ ok: false });
		expect((await installer.status()).engine).toBe("missing");
	});

	test("cancel while the consent dialog is open: nothing is downloaded and nothing remains", async () => {
		let answer;
		const asked = new Promise((resolve) => (answer = resolve));
		let installerRef;
		const { installer, net } = setup({
			consent: (options) =>
				new Promise((resolve) => {
					options.signal.addEventListener("abort", () => resolve(false));
					answer();
				}),
		});
		installerRef = installer;
		const install = installer.install();
		await asked;
		expect(await installerRef.cancelInstall()).toEqual({ ok: true });
		expect(await install).toMatchObject({ ok: false });
		expect(net.requested).toEqual([]);
		expectClean();
	});

	test("cancel while the model downloads: the part file is deleted", async () => {
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		let reached;
		const atModel = new Promise((resolve) => (reached = resolve));
		const net = fakeFetch(routes());
		const slowFetch = async (url, options) => {
			if (url !== MODEL_URL) return net.fetch(url, options);
			const stream = new ReadableStream({
				async start(controller) {
					controller.enqueue(MODEL_BODY.subarray(0, 100));
					reached();
					await gate;
					controller.error(new Error("aborted"));
				},
			});
			return new Response(stream, { status: 200, headers: { "content-length": String(MODEL_BODY.length) } });
		};
		const installer = createStemsInstaller({
			userData, pins: goodPins(), readLock: async () => LOCK, driverPath, spawn: fakeTools().spawn, kill: () => {}, fetch: slowFetch, confirm: async () => true, platform: "linux", arch: "x64", measure: async () => 0,
		});
		const install = installer.install();
		await atModel;
		const cancelled = installer.cancelInstall();
		release();
		await cancelled;
		expect(await install).toEqual({ ok: false, code: "install-failed" });
		expectClean();
	});
});

describe("busy and leftovers", () => {
	test("a second install, an install during a separation, and a remove during either are refused", async () => {
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		let reached;
		const atVenv = new Promise((resolve) => (reached = resolve));
		const tools = fakeTools({ venv: async (call) => (reached(), await gate, defaults.venv(call)) });
		const { installer } = setup({ tools });
		const first = installer.install();
		await atVenv;
		expect(await installer.install()).toEqual({ ok: false, code: "busy" });
		expect(await installer.remove()).toEqual({ ok: false });
		release();
		expect(await first).toEqual({ ok: true });

		const busyJob = setup({ isJobBusy: () => true });
		expect(await busyJob.installer.install()).toEqual({ ok: false, code: "busy" });
		expect(await busyJob.installer.remove()).toEqual({ ok: false });
		expect(busyJob.dialogs).toEqual([]);
		expect(busyJob.removeDialogs).toEqual([]);
	});

	test("start-up sweep: an engine directory without a manifest is deleted, a finished one is kept", async () => {
		await fsp.mkdir(path.join(engineDir(), "venv"), { recursive: true });
		const { installer } = setup();
		await installer.sweepLeftovers();
		expect(exists(engineDir())).toBe(false);

		await setup().installer.install();
		await installer.sweepLeftovers();
		expect(exists(path.join(engineDir(), "manifest.json"))).toBe(true);
	});

	test("quit during an install: shutdownSync kills the tool and deletes the engine synchronously", async () => {
		let started;
		const running = new Promise((resolve) => (started = resolve));
		const tools = fakeTools({ pip: async () => (started(), "hang") });
		const { installer } = setup({ tools });
		const install = installer.install();
		await running;
		installer.shutdownSync();
		expect(tools.kills.some((kill) => kill.signal === "SIGKILL" && kill.target < 0)).toBe(true);
		expect(exists(engineDir())).toBe(false);
		expect(exists(torchDir())).toBe(false);
		await install;
	});
});

describe("tar extraction", () => {
	const extract = async (archive, member = "pkg/uv", maxBytes = 1 << 20) => {
		const file = path.join(userData, "a.tar.gz");
		const dest = path.join(userData, "out-uv");
		fs.writeFileSync(file, archive);
		return { written: await extractMember({ archivePath: file, member, destPath: dest, maxBytes }), dest };
	};

	test("writes only the exact member (0600), skipping others, directories, links and look-alikes", async () => {
		const body = Buffer.from("A".repeat(1500));
		const { written, dest } = await extract(
			tarGz([
				{ name: "pkg/", type: "5" },
				{ name: "pkg/uv", type: "2" }, // a symbolic link of that name: not a regular file
				{ name: "pkg/uvx", body: Buffer.from("no") },
				{ name: "../pkg/uv", body: Buffer.from("no") },
				{ name: "other/pkg/uv", body: Buffer.from("no") },
				{ name: "./pkg/uv", body },
				{ name: "pkg/uv", body: Buffer.from("second, ignored") },
			]),
		);
		expect(written).toBe(1500);
		expect(fs.readFileSync(dest).equals(body)).toBe(true);
		expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
	});

	test("long names (GNU L, pax path, ustar prefix) are matched", async () => {
		const longName = `pkg/${"d".repeat(120)}/uv`;
		const paxRecord = `path=${longName}\n`;
		const paxBody = Buffer.from(`${paxRecord.length + 4} ${paxRecord}`); // "<length> <key=value>\n", the length counts its own 3 digits and the space
		for (const entries of [
			[{ name: "././@LongLink", type: "L", body: Buffer.from(`${longName}\0`) }, { name: longName.slice(0, 99), body: Buffer.from("payload") }],
			[{ name: "PaxHeader", type: "x", body: paxBody }, { name: "short", body: Buffer.from("payload") }],
		]) {
			const { dest } = await extract(tarGz(entries), longName);
			expect(fs.readFileSync(dest, "utf8")).toBe("payload");
			fs.rmSync(dest);
		}
		const { dest } = await extract(tarGz([{ name: "uv", prefix: "pkg", body: Buffer.from("prefixed") }]));
		expect(fs.readFileSync(dest, "utf8")).toBe("prefixed");
	});

	test("a missing member, a member over the cap, a truncated or corrupt archive: it throws and leaves no file", async () => {
		const full = tarGz([{ name: "pkg/uv", body: Buffer.alloc(100_000, 7) }]);
		for (const [archive, member, cap] of [
			[tarGz([{ name: "pkg/uvx", body: Buffer.from("x") }]), "pkg/uv", 1 << 20],
			[full, "pkg/uv", 99_999],
			[full.subarray(0, full.length - 60), "pkg/uv", 1 << 20],
			[Buffer.from("this is not gzip at all"), "pkg/uv", 1 << 20],
		]) {
			let message = "resolved";
			try {
				await extract(archive, member, cap);
			} catch (error) {
				message = error.message;
			}
			expect(message).not.toBe("resolved");
			expect(exists(path.join(userData, "out-uv"))).toBe(false);
		}
	});
});

describe("the lock file: only what uv compile writes (uv is told what to install from it)", () => {
	const HASH = "ab".repeat(32);
	const GOOD = [
		"# This file was autogenerated by uv via the following command:",
		"#    uv pip compile requirements.in --generate-hashes",
		"--index-url https://pypi.org/simple",
		"--extra-index-url https://download.pytorch.org/whl/cpu",
		"",
		"colorama==0.4.6 ; sys_platform == 'win32' \\",
		`    --hash=sha256:${HASH}`,
		"    # via tqdm",
		"torch==2.14.1+cpu \\",
		`    --hash=sha256:${HASH} \\`,
		`    --hash=sha256:${"cd".repeat(32)}`,
		"    # via demucs",
		`numpy==2.1.0 --hash=sha256:${HASH}`,
		"",
	].join("\n");

	test("a realistic uv output is accepted (continuations, markers, several hashes, CRLF)", () => {
		expect(lockUsable(GOOD)).toBe(true);
		expect(lockUsable(GOOD.replace(/\n/g, "\r\n"))).toBe(true);
		expect(lockUsable(LOCK)).toBe(true);
	});

	const one = (line) => `torch==2.5.0 --hash=sha256:${HASH}\n${line}\n`;
	const rejected = {
		"nothing / placeholder": ["", "# placeholder, the local session fills this file\n", "\n\n"],
		"a requirement without a hash": ["torch==2.5.0\n", `torch==2.5.0 ; sys_platform == 'linux'\n`],
		"a wrong hash": ["torch==2.5.0 --hash=sha256:abc\n", `torch==2.5.0 --hash=md5:${HASH}\n`, `torch==2.5.0 --hash=sha256:${HASH.toUpperCase()}\n`, `torch==2.5.0 --hash=sha256:${HASH}00\n`, `torch==2.5.0 --hash=sha256:${HASH} --trusted-host x\n`],
		"an editable or recursive or constraint line": [one("-e ."), one("-e git+https://github.com/x/y#egg=y"), one("-r other.txt"), one("-c constraints.txt"), one("--requirement other.txt"), one("./local/pkg")],
		"an option that changes where or how uv looks": [one("--find-links https://example.org/wheels"), one("-f /tmp/wheels"), one("--no-index"), one("--trusted-host example.org"), one("--pre"), one("--no-binary :all:"), one("--prefer-binary"), one("--constraint c.txt")],
		"an index that is not https or not on the list": [
			one("--index-url http://pypi.org/simple"),
			one("--extra-index-url https://evil.example/simple"),
			one("--index-url https://pypi.org.evil.example/simple"),
			one("--index-url https://user:pw@pypi.org/simple"),
			one("--index-url https://pypi.org:8443/simple"),
			one("--index-url=https://pypi.org/simple"),
			one("--index-url https://files.pythonhosted.org/simple"), // not an index
			one("--index-url file:///tmp/index"),
			one("--index-url https://pypi.org/simple?x=1"),
		],
		"a VCS, URL or direct-reference requirement": [
			one("torch @ https://example.org/torch.whl"),
			one(`torch==2.5.0 @ https://example.org/torch.whl --hash=sha256:${HASH}`),
			one(`torch @ file:///tmp/torch.whl --hash=sha256:${HASH}`),
			one(`git+https://github.com/x/y.git --hash=sha256:${HASH}`),
			one(`https://example.org/torch-2.5.0.whl --hash=sha256:${HASH}`),
			one(`/tmp/torch.whl --hash=sha256:${HASH}`),
			one(`torch==https://example.org/x --hash=sha256:${HASH}`),
		],
		"a marker with a path, an @ or a backslash": [
			one(`foo==1.0 ; python_version < "3.12" or '/etc' == 'x' --hash=sha256:${HASH}`),
			one(`foo==1.0 ; extra == "a@b" --hash=sha256:${HASH}`),
			one(`foo==1.0 ; sys_platform == 'x\\y' --hash=sha256:${HASH}`),
			one(`foo==1.0 ; --hash=sha256:${HASH}`),
		],
		"a requirement that is not name==version": [
			one(`foo>=1.0 --hash=sha256:${HASH}`),
			one(`foo~=1.0 --hash=sha256:${HASH}`),
			one(`foo==1.0,<2 --hash=sha256:${HASH}`),
			one(`foo[extra]==1.0 --hash=sha256:${HASH}`),
			one(`foo --hash=sha256:${HASH}`),
			one(`==1.0 --hash=sha256:${HASH}`),
			one(`-foo==1.0 --hash=sha256:${HASH}`),
			one(`foo==1.0 bar==2.0 --hash=sha256:${HASH}`),
			one(`foo==1.0; bar --hash=sha256:${HASH}; baz`),
		],
		"a line that is only a hash, or an odd character": [one(`--hash=sha256:${HASH}`), one("torch==2.5.0\u0000"), "torch==2.5.0 --hash=sha256:" + HASH + "\r\n\rx\n", one("`rm -rf /`"), one("$(id)")],
		"a trailing continuation or a comment that could swallow the next line": [`torch==2.5.0 --hash=sha256:${HASH} \\\n`, `# note \\\n-e .\n${GOOD}`, `#\\\n--find-links x\n${GOOD}`, one("\\")],
	};
	for (const [label, inputs] of Object.entries(rejected)) {
		test(`rejected: ${label}`, () => {
			for (const input of inputs) expect([input, lockUsable(input)]).toEqual([input, false]);
		});
	}

	test("rejected: not a string, empty, or longer than 4 MiB", () => {
		for (const input of [undefined, null, 5, {}, "", "x".repeat(4 * 1024 * 1024 + 1)]) expect(lockUsable(input)).toBe(false);
	});
});

describe("the install must match the pins (an old, foreign or tampered install is broken)", () => {
	const manifestFile = () => path.join(engineDir(), "manifest.json");
	const edit = (changes) => {
		const manifest = JSON.parse(fs.readFileSync(manifestFile(), "utf8"));
		rewrite(manifestFile(), JSON.stringify({ ...manifest, ...changes }));
	};

	test("the manifest values equal the pins; any other value is broken, and so are invalid pins", async () => {
		const { installer } = setup();
		expect(await installer.install()).toEqual({ ok: true });
		expect(await installer.verifyEngine()).toBe(true);
		const other = "ef".repeat(32);
		for (const changes of [{ modelSha256: other }, { modelFileName: "other.th" }, { modelSizeBytes: MODEL_BODY.length + 1 }, { uvVersion: "0.4.0" }, { pythonVersion: "3.11.0" }]) {
			const original = fs.readFileSync(manifestFile(), "utf8");
			edit(changes);
			expect([changes, await installer.verifyEngine()]).toEqual([changes, false]);
			rewrite(manifestFile(), original);
			expect(await installer.verifyEngine()).toBe(true);
		}
	});

	test("the same files under different pins are broken (a new model or runtime asks for a new install)", async () => {
		await setup().installer.install();
		const newModel = goodPins();
		newModel.model.sha256 = "ef".repeat(32);
		const newPython = goodPins();
		newPython.python.version = "3.13.0";
		const newUv = goodPins();
		newUv.uv.version = "0.6.0";
		newUv.uv.url = "https://github.com/astral-sh/uv/releases/download/0.6.0/uv-x86_64-unknown-linux-gnu.tar.gz";
		for (const pins of [newModel, newPython, newUv]) {
			const { installer } = setup({ pins });
			expect(await installer.verifyEngine()).toBe(false);
			expect((await installer.status()).engine).toBe("broken");
		}
	});

	test("invalid pins (any field null or malformed) make an installed engine broken, never ready", async () => {
		await setup().installer.install();
		const nulled = goodPins();
		nulled.model.sha256 = null;
		const malformed = goodPins();
		malformed.uv.sha256 = "xyz";
		for (const pins of [nulled, malformed, shippedPins, null]) {
			const { installer } = setup({ pins });
			expect(await installer.verifyEngine()).toBe(false);
			expect((await installer.status()).engine).toBe("broken");
		}
	});
});

describe("the optional interpreter pin (python.interpreterSha256)", () => {
	const INTERPRETER_SHA = sha256(Buffer.from("PYTHON INTERPRETER 1"));
	const pinned = (value) => {
		const pins = goodPins();
		pins.python.interpreterSha256 = value;
		return pins;
	};
	const expectClean = () => {
		expect(exists(engineDir())).toBe(false);
		expect(exists(torchDir())).toBe(false);
	};

	test("absent or null: accepted (trust on first use, the manifest still records the hash); malformed: pins invalid", () => {
		expect(validatePins(goodPins()).value.interpreterSha256).toBeNull();
		expect(validatePins(pinned(null)).ok).toBe(true);
		expect(validatePins(pinned(INTERPRETER_SHA)).value.interpreterSha256).toBe(INTERPRETER_SHA);
		for (const bad of ["abc", INTERPRETER_SHA.toUpperCase(), INTERPRETER_SHA + "0", 5, {}, ""]) expect([bad, validatePins(pinned(bad)).ok]).toEqual([bad, false]);
	});

	test("the right pin: installed, recorded, and checked on every run", async () => {
		const { installer } = setup({ pins: pinned(INTERPRETER_SHA) });
		expect(await installer.install()).toEqual({ ok: true });
		const manifest = JSON.parse(fs.readFileSync(path.join(engineDir(), "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ interpreterSha256: INTERPRETER_SHA, pythonSha256: INTERPRETER_SHA });
		expect(await installer.verifyEngine()).toBe(true);
		// a manifest that was edited to drop the pin is not enough
		const text = JSON.stringify({ ...manifest, interpreterSha256: null });
		rewrite(path.join(engineDir(), "manifest.json"), text);
		expect(await installer.verifyEngine()).toBe(false);
		// and pins that now ask for another interpreter make it broken
		rewrite(path.join(engineDir(), "manifest.json"), JSON.stringify(manifest));
		expect(await setup({ pins: pinned("ef".repeat(32)) }).installer.verifyEngine()).toBe(false);
	});

	test("the wrong pin: verify-failed, before the manifest, everything removed", async () => {
		const { installer, logs } = setup({ pins: pinned("ef".repeat(32)) });
		expect(await installer.install()).toEqual({ ok: false, code: "verify-failed" });
		expectClean();
		expect(logs.join("\n")).toContain("interpreter");
	});

	test("no pin: the manifest records interpreterSha256 null and the engine is ready", async () => {
		const { installer } = setup();
		await installer.install();
		const manifest = JSON.parse(fs.readFileSync(path.join(engineDir(), "manifest.json"), "utf8"));
		expect(manifest.interpreterSha256).toBeNull();
		expect(manifest.pythonSha256).toBe(INTERPRETER_SHA);
		expect(await installer.verifyEngine()).toBe(true);
	});
});

describe("free disk space is checked before anything else happens", () => {
	const REQUIRED = Math.ceil(950_000_000 * 1.25) + 256 * 1024 * 1024;
	const volume = (free, seen = []) => ({
		...fsp,
		statfs: async (dir) => {
			seen.push(dir);
			return { bavail: free, bsize: 1 };
		},
	});

	test("too little: no-disk-space, no dialog, no download, no process, nothing on disk", async () => {
		for (const free of [0, 1, REQUIRED - 1]) {
			const { installer, net, tools, dialogs } = setup({ fsApi: volume(free) });
			expect(await installer.install()).toEqual({ ok: false, code: "no-disk-space" });
			expect(dialogs).toEqual([]);
			expect(net.requested).toEqual([]);
			expect(tools.spawned).toEqual([]);
			expect(exists(engineDir())).toBe(false);
			expect((await installer.status()).engine).toBe("missing");
		}
	});

	test("exactly enough (installSizeBytes x 1.25 + 256 MiB) goes on to the dialog, on the userData volume", async () => {
		const seen = [];
		const { installer, dialogs } = setup({ fsApi: volume(REQUIRED, seen), consent: false });
		expect(await installer.install()).toEqual({ ok: false, code: "consent-declined" });
		expect(dialogs).toHaveLength(1);
		expect(seen).toEqual([userData]);
	});

	test("a volume that cannot be asked does not block (the folder may not exist yet: the parent is asked)", async () => {
		const seen = [];
		const asked = {
			...fsp,
			statfs: async (dir) => {
				seen.push(dir);
				if (dir === userData) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				return { bavail: 2 ** 40, bsize: 1 };
			},
		};
		const first = setup({ fsApi: asked, consent: false });
		expect(await first.installer.install()).toEqual({ ok: false, code: "consent-declined" });
		expect(seen).toEqual([userData, path.dirname(userData)]);
		const never = setup({ fsApi: { ...fsp, statfs: async () => { throw new Error("no statfs"); } }, consent: false });
		expect(await never.installer.install()).toEqual({ ok: false, code: "consent-declined" });
	});

	test("an engine that is already installed does not need room", async () => {
		await setup().installer.install();
		const { installer } = setup({ fsApi: volume(0) });
		expect(await installer.install()).toEqual({ ok: true });
	});
});
