// Stems (round 5): the managed engine A installer and its checks. Linux x64 only (every other
// platform answers "unsupported"). No Electron import: fetch, spawn, the file system, the consent
// dialog and the pins are injected, so bun runs all of it with fakes.
//
// Everything lives in the Ccut-owned <userData>/stems/engine (plus the model checkpoint in
// <userData>/stems/torch, TORCH_HOME). One consent dialog (shown by the main process) comes first.
// Steps, any failure or Cancel removes everything of this install:
//   a. the pinned uv release tarball (stems-download.js: https, GitHub hosts, size cap, hashed while
//      streamed to a 0600 file, SHA-256 must equal the pin), only the `uv` member is extracted;
//   b. `uv venv --python <pinned>` and `uv pip sync --require-hashes --no-build <lock>` (the lock is
//      stems-requirements.lock with hashes, produced by the owner's local session; uv's cache,
//      its Python installs and HOME are inside engine/, the cache is deleted afterwards);
//   c. the pinned Demucs checkpoint into TORCH_HOME/hub/checkpoints/<file name>, same download rules;
//   d. a smoke run (the engine's python imports demucs and loads the model offline);
//   e. engine/manifest.json (versions, SHA-256 of the driver and of the python interpreter, the
//      checkpoint's size), written last: no manifest means no engine.
// Before every separation verifyEngine() re-hashes the driver and the interpreter and checks the
// manifest and the checkpoint's size: any difference is "broken".
// While any pin is null (stems-pins.json as shipped from the cloud) or the lock is missing or a
// placeholder, install() answers "pins-missing" BEFORE the dialog and before any download.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { downloadVerified, DownloadError } = require("./stems-download");
const { OFFLINE_ENV, stemsPaths } = require("./stems-engine");
const { buildChildEnv, runProcess } = require("./link-import-process");
const { DOWNLOAD_HOSTS } = require("./link-import-tool");
const { extractMember } = require("./stems-tar");

const MODEL_ID = "htdemucs";
const UV_URL_PREFIX = "https://github.com/astral-sh/uv/releases/download/";
const UV_MEMBER = "uv-x86_64-unknown-linux-gnu/uv";
const MAX_UV_BINARY_BYTES = 200 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_DRIVER_BYTES = 1024 * 1024;
const MAX_PYTHON_BYTES = 512 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024 * 1024;
const MINIMAL_PATH = "/usr/bin:/bin";
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const VERSION = /^\d{1,3}(?:\.\d{1,3}){1,3}$/;
const TOOL_LOG_CHARS = 4096;

// Where the install bar is while each step runs (percent of the whole).
const PHASE = Object.freeze({ uvStart: 0, uvEnd: 5, venvEnd: 15, syncEnd: 75, modelEnd: 97, smokeEnd: 99 });
const LIMITS = Object.freeze({ venvWallMs: 20 * 60 * 1000, syncWallMs: 60 * 60 * 1000, smokeWallMs: 5 * 60 * 1000, progressPollMs: 2000 });

// The smoke run: refuse a missing pinned checkpoint before demucs gets a chance to fetch another one.
const smokeScript = () =>
	[
		"import os, sys",
		"if not os.path.isfile(sys.argv[1]):",
		'    sys.stderr.write("the pinned checkpoint is missing: " + sys.argv[1] + "\\n")',
		"    sys.exit(3)",
		"from demucs.pretrained import get_model",
		`get_model(${JSON.stringify(MODEL_ID)})`,
	].join("\n");

class InstallError extends Error {
	constructor(code) {
		super(`stems install: ${code}`);
		this.name = "InstallError";
		this.code = code;
	}
}
const fail = (code) => {
	throw new InstallError(code);
};

const isSize = (value) => Number.isSafeInteger(value) && value > 0;
const isSupported = ({ platform, arch }) => platform === "linux" && arch === "x64";

/** The pins file -> { ok: true, value } with every required field present and well-formed, else { ok: false }. */
function validatePins(pins) {
	const none = { ok: false };
	if (!pins || typeof pins !== "object") return none;
	const { uv, python, model, lockFile, syncCacheBytes, installSizeBytes } = pins;
	if (!uv || !python || !model) return none;
	if (typeof uv.version !== "string" || !VERSION.test(uv.version)) return none;
	if (typeof uv.url !== "string" || !uv.url.startsWith(UV_URL_PREFIX) || !uv.url.includes(`/${uv.version}/`) || !SHA256.test(uv.sha256 ?? "") || !isSize(uv.sizeBytes)) return none;
	if (typeof python.version !== "string" || !VERSION.test(python.version)) return none;
	// OPTIONAL pin of the interpreter's SHA-256 (python.interpreterSha256). Without it the interpreter that uv
	// installs is trusted on first use: it is hashed after the install, recorded in the manifest and checked
	// on every run, but nothing says the first hash was the right one.
	const interpreter = python.interpreterSha256 ?? null;
	if (interpreter !== null && (typeof interpreter !== "string" || !SHA256.test(interpreter))) return none;
	if (lockFile !== "stems-requirements.lock" || !isSize(syncCacheBytes) || !isSize(installSizeBytes)) return none;
	if (model.id !== MODEL_ID || typeof model.fileName !== "string" || !FILE_NAME.test(model.fileName) || !SHA256.test(model.sha256 ?? "") || !isSize(model.sizeBytes)) return none;
	let modelUrl;
	try {
		modelUrl = new URL(model.url);
	} catch {
		return none;
	}
	if (modelUrl.protocol !== "https:" || modelUrl.username !== "" || modelUrl.password !== "" || modelUrl.port !== "") return none;
	const redirectHosts = Array.isArray(model.redirectHosts) ? model.redirectHosts : [];
	if (redirectHosts.length > 4 || !redirectHosts.every((host) => typeof host === "string" && HOST_NAME.test(host))) return none;
	return {
		ok: true,
		value: Object.freeze({
			uv: Object.freeze({ version: uv.version, url: uv.url, sha256: uv.sha256, sizeBytes: uv.sizeBytes }),
			pythonVersion: python.version,
			interpreterSha256: interpreter,
			lockFile,
			syncCacheBytes,
			installSizeBytes,
			model: Object.freeze({ id: model.id, fileName: model.fileName, url: model.url, sha256: model.sha256, sizeBytes: model.sizeBytes, hosts: Object.freeze([modelUrl.hostname, ...redirectHosts]) }),
		}),
	};
}

// What `uv pip compile --generate-hashes` writes, and nothing else. uv installs whatever this file says, so
// anything that could name another place to fetch from (an index, a URL, a path, a VCS) or change how uv
// resolves is refused.
const LOCK_INDEX_HOSTS = Object.freeze(["pypi.org", "download.pytorch.org"]);
const LOCK_INDEX_LINE = /^--(?:extra-)?index-url https:\/\/([a-z0-9.-]+)(?:\/[A-Za-z0-9._~%+/-]*)?$/;
const LOCK_REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9.!+_-]+)(?:\s*;\s*([^;]+))?$/;
const LOCK_MARKER = /^[A-Za-z0-9 ._,'"()<>=!~*+-]+$/;
const LOCK_HASHES = /^--hash=sha256:[0-9a-f]{64}(?: +--hash=sha256:[0-9a-f]{64})*$/;

function lockUsable(text) {
	if (typeof text !== "string" || text.length === 0 || text.length > MAX_LOCK_BYTES) return false;
	const normal = text.replace(/\r\n/g, "\n");
	if (/[\r\0]/.test(normal) || normal.trimEnd().endsWith("\\")) return false; // no continuation into nothing
	// A comment that ends in a backslash could swallow the next line in one parser and not in another.
	if (normal.split("\n").some((line) => line.trim().startsWith("#") && line.trimEnd().endsWith("\\"))) return false;
	let requirements = 0;
	for (const raw of normal.replace(/\\\n/g, " ").split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const index = LOCK_INDEX_LINE.exec(line);
		if (index) {
			if (!LOCK_INDEX_HOSTS.includes(index[1])) return false;
			continue;
		}
		const at = line.indexOf("--hash=");
		if (at < 1 || !LOCK_HASHES.test(line.slice(at))) return false;
		const requirement = LOCK_REQUIREMENT.exec(line.slice(0, at).trim());
		if (!requirement) return false;
		const marker = requirement[3]?.trim();
		if (marker !== undefined && (marker === "" || !LOCK_MARKER.test(marker))) return false;
		requirements++;
	}
	return requirements > 0;
}

const DISK_HEADROOM = 1.25;
const DISK_EXTRA_BYTES = 256 * 1024 * 1024;

const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;

function consentOptions({ pins, engineDir, signal }) {
	return {
		type: "question",
		buttons: ["Download and install", "Cancel"],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
		title: "Stems",
		message: "Install the stem separator?",
		detail: [
			`Separating a song into drums, bass, other and vocals needs a Python runtime, PyTorch (CPU) and Demucs. Ccut can install them for you: about ${gigabytes(pins.installSizeBytes)} on disk.`,
			"",
			"Where from:",
			`  github.com: the uv installer (astral-sh/uv, ${megabytes(pins.uv.sizeBytes)}) and the Python runtime that uv fetches (astral-sh/python-build-standalone)`,
			"  pypi.org (the package index), files.pythonhosted.org (the Python packages) and download.pytorch.org (PyTorch): every file is listed with hashes that uv checks",
			`  ${pins.model.hosts[0]}: the Demucs model file (${megabytes(pins.model.sizeBytes)}, SHA-256 checked)`,
			"",
			"It is kept in:",
			engineDir,
			"",
			"After this, separating works offline. You can remove it again in the app.",
			"Demucs is released under the MIT license; the model weights come with their own license, which Ccut has not checked.",
		].join("\n"),
		signal,
	};
}

function removeOptions({ pins, engineDir }) {
	return {
		type: "question",
		buttons: ["Remove", "Cancel"],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
		title: "Stems",
		message: "Remove the stem separator?",
		detail: [
			`This deletes the Python runtime, PyTorch, Demucs and the model${pins ? ` (about ${gigabytes(pins.installSizeBytes)})` : ""} from:`,
			engineDir,
			"",
			"Stems cannot be separated until you install it again. Your projects and the stems already cached are not touched.",
		].join("\n"),
	};
}

/** SHA-256 of a regular file, read in 1 MiB pieces (never the whole file in memory). */
async function sha256OfFile({ fsApi, file, maxBytes }) {
	const handle = await fsApi.open(file, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("file too large");
		const hash = crypto.createHash("sha256");
		const buffer = Buffer.alloc(1024 * 1024);
		for (let position = 0; position <= stat.size; ) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		return hash.digest("hex");
	} finally {
		await handle.close().catch(() => {});
	}
}

async function measureDir({ fsApi, dir, maxEntries = 200_000 }) {
	let total = 0;
	let seen = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = await fsApi.readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > maxEntries) return total;
			const file = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(file);
			else if (entry.isFile()) total += await fsApi.lstat(file).then((stat) => stat.size, () => 0);
		}
	}
	return total;
}

function createStemsInstaller({
	userData,
	pins,
	readLock,
	driverPath,
	spawn,
	fetch,
	confirm,
	confirmRemove = async () => false,
	platform = process.platform,
	arch = process.arch,
	fsApi = fsp,
	fsSync = fs,
	isJobBusy = () => false,
	log = () => {},
	kill,
	now = Date.now,
	randomHex = () => crypto.randomBytes(8).toString("hex"),
	limits: overrides = {},
	measure = (dir) => measureDir({ fsApi, dir }),
}) {
	const limits = { ...LIMITS, ...overrides };
	const paths = stemsPaths({ userData });
	const checkpointDir = path.join(paths.torchHome, "hub", "checkpoints");
	const supported = isSupported({ platform, arch });
	const parsedPins = validatePins(pins);
	let current = null;
	let removing = false;

	const setPercent = (percent) => {
		if (current && percent > current.percent) current.percent = Math.min(100, Math.round(percent));
	};
	const throwIfAborted = (signal) => {
		if (signal.aborted) fail("install-failed");
	};

	async function wipe() {
		await fsApi.rm(paths.engineDir, { recursive: true, force: true });
		await fsApi.rm(paths.torchHome, { recursive: true, force: true });
	}

	/** Runs uv (or the engine's python) like link-import runs yt-dlp: no shell, minimal environment, killable tree. */
	async function runTool({ binary, args, extraEnv, wallMs, signal }) {
		let tail = "";
		const env = { ...buildChildEnv({ parentEnv: { PATH: MINIMAL_PATH }, platform, jobDir: paths.engineDir }), ...extraEnv };
		const run = runProcess({
			spawn,
			binary,
			args,
			cwd: paths.engineDir,
			env,
			platform,
			kill,
			limits: { wallMs, idleMs: wallMs, maxLineChars: 1024 },
			onLine: ({ line }) => {
				tail = (tail + line + "\n").slice(-TOOL_LOG_CHARS);
			},
		});
		const onAbort = () => (signal.reason === "quit" ? run.killSync() : run.cancel());
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		const outcome = await run.done;
		signal.removeEventListener("abort", onAbort);
		throwIfAborted(signal);
		if (outcome.reason !== "exit" || outcome.exitCode !== 0) {
			log(`[ccut] stems install: ${path.basename(binary)} ${args[0]} ended (${outcome.reason}, exit ${outcome.exitCode}); output tail: ${JSON.stringify(tail)}`);
			return false;
		}
		return true;
	}

	const uvBinary = path.join(paths.engineDir, "bin", "uv");
	const uvEnv = () => ({
		UV_CACHE_DIR: path.join(paths.engineDir, "cache"),
		UV_PYTHON_INSTALL_DIR: path.join(paths.engineDir, "python"),
		UV_NO_CONFIG: "1",
		UV_PYTHON_PREFERENCE: "only-managed",
		UV_LINK_MODE: "hardlink",
		UV_NO_PROGRESS: "1",
	});

	async function installSteps({ signal }) {
		await wipe();
		for (const dir of [paths.engineDir, path.join(paths.engineDir, "bin"), path.join(paths.engineDir, "home"), path.join(paths.engineDir, "tmp"), path.join(paths.engineDir, "cache"), checkpointDir]) {
			await fsApi.mkdir(dir, { recursive: true, mode: 0o700 });
		}
		await fsApi.chmod(paths.root, 0o700);
		await fsApi.chmod(paths.engineDir, 0o700);
		const value = parsedPins.value;

		// a. uv
		const archive = path.join(paths.engineDir, "tmp", "uv.tar.gz");
		await downloadVerified({
			fetch,
			fsApi,
			url: value.uv.url,
			hosts: DOWNLOAD_HOSTS,
			destPath: archive,
			expectedSha256: value.uv.sha256,
			expectedSize: value.uv.sizeBytes,
			signal,
			onProgress: (bytes) => setPercent(PHASE.uvStart + ((PHASE.uvEnd - PHASE.uvStart) * bytes) / value.uv.sizeBytes),
		});
		throwIfAborted(signal);
		const uvTemp = path.join(paths.engineDir, "bin", `.uv-${randomHex()}.tmp`);
		try {
			await extractMember({ archivePath: archive, member: UV_MEMBER, destPath: uvTemp, maxBytes: MAX_UV_BINARY_BYTES });
		} catch (error) {
			log(`[ccut] stems install: uv archive: ${error && error.message}`);
			await fsApi.unlink(uvTemp).catch(() => {});
			fail("verify-failed");
		}
		await fsApi.chmod(uvTemp, 0o755);
		await fsApi.rename(uvTemp, uvBinary);
		await fsApi.unlink(archive).catch(() => {});
		setPercent(PHASE.uvEnd);

		// b. Python + packages
		throwIfAborted(signal);
		if (!(await runTool({ binary: uvBinary, args: ["venv", "--python", value.pythonVersion, paths.venvDir], extraEnv: uvEnv(), wallMs: limits.venvWallMs, signal }))) fail("install-failed");
		setPercent(PHASE.venvEnd);
		const lockPath = path.join(paths.engineDir, "requirements.lock");
		// uv cannot read inside the asar archive: the lock is copied out first.
		await fsApi.writeFile(lockPath, await readLock(), { flag: "wx", mode: 0o600 });
		const cacheDir = path.join(paths.engineDir, "cache");
		let polling = false;
		const poll = setInterval(() => {
			if (polling) return;
			polling = true;
			measure(cacheDir)
				.then((bytes) => setPercent(PHASE.venvEnd + Math.min(0.99, bytes / value.syncCacheBytes) * (PHASE.syncEnd - PHASE.venvEnd)))
				.catch(() => {})
				.finally(() => {
					polling = false;
				});
		}, limits.progressPollMs);
		try {
			const synced = await runTool({
				binary: uvBinary,
				args: ["pip", "sync", "--require-hashes", "--no-build", "--python", paths.venvPython, lockPath],
				extraEnv: uvEnv(),
				wallMs: limits.syncWallMs,
				signal,
			});
			if (!synced) fail("install-failed");
		} finally {
			clearInterval(poll);
		}
		await fsApi.rm(cacheDir, { recursive: true, force: true });
		setPercent(PHASE.syncEnd);

		// c. the model checkpoint
		throwIfAborted(signal);
		const checkpoint = path.join(checkpointDir, value.model.fileName);
		const part = path.join(checkpointDir, `.${value.model.fileName}.${randomHex()}.part`);
		await downloadVerified({
			fetch,
			fsApi,
			url: value.model.url,
			hosts: value.model.hosts,
			destPath: part,
			expectedSha256: value.model.sha256,
			expectedSize: value.model.sizeBytes,
			signal,
			onProgress: (bytes) => setPercent(PHASE.syncEnd + ((PHASE.modelEnd - PHASE.syncEnd) * bytes) / value.model.sizeBytes),
		});
		await fsApi.rename(part, checkpoint);
		setPercent(PHASE.modelEnd);

		// d. the engine must really load THE pinned file, offline. No proxy that works (a wrong file
		// name would make torch.hub download another checkpoint), the file must exist before get_model
		// runs, and afterwards it is the same file and nothing else appeared next to it.
		throwIfAborted(signal);
		const before = await snapshotCheckpoints(value.model.fileName);
		const loaded = await runTool({
			binary: paths.venvPython,
			args: ["-I", "-c", smokeScript(), checkpoint],
			extraEnv: { TORCH_HOME: paths.torchHome, ...OFFLINE_ENV },
			wallMs: limits.smokeWallMs,
			signal,
		});
		if (!loaded) fail("verify-failed");
		const after = await snapshotCheckpoints(value.model.fileName);
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			log("[ccut] stems install: the checkpoint folder changed during the smoke run (another file was fetched or the pinned one was replaced)");
			fail("verify-failed");
		}
		setPercent(PHASE.smokeEnd);

		// e. the interpreter (pinned: it must be exactly that file), then the manifest, last
		const pythonSha256 = await hashPython();
		if (value.interpreterSha256 !== null && pythonSha256 !== value.interpreterSha256) {
			log("[ccut] stems install: the interpreter's SHA-256 is not the pinned one");
			fail("verify-failed");
		}
		const manifest = {
			schema: 1,
			installedAt: new Date(now()).toISOString(),
			uvVersion: value.uv.version,
			pythonVersion: value.pythonVersion,
			modelId: value.model.id,
			modelFileName: value.model.fileName,
			modelSizeBytes: value.model.sizeBytes,
			modelSha256: value.model.sha256,
			driverSha256: await sha256OfFile({ fsApi, file: driverPath, maxBytes: MAX_DRIVER_BYTES }),
			pythonSha256,
			interpreterSha256: value.interpreterSha256,
		};
		const temp = path.join(paths.engineDir, `.manifest-${randomHex()}.tmp`);
		await fsApi.writeFile(temp, `${JSON.stringify(manifest, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		await fsApi.rename(temp, paths.manifest);
		await fsApi.rm(path.join(paths.engineDir, "tmp"), { recursive: true, force: true }).catch(() => {});
		setPercent(100);
	}

	/** The checkpoint folder's entries and the pinned file's inode and size, for a before/after comparison. */
	async function snapshotCheckpoints(fileName) {
		const stat = await fsApi.lstat(path.join(checkpointDir, fileName));
		if (!stat.isFile()) fail("verify-failed");
		return { entries: (await fsApi.readdir(checkpointDir)).sort(), ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
	}

	/** The interpreter the venv's python really is: a file inside the engine directory. */
	async function enginePython() {
		const real = await fsApi.realpath(paths.venvPython);
		const engineReal = await fsApi.realpath(paths.engineDir);
		if (!real.startsWith(engineReal + path.sep)) throw new Error("the engine's python is outside the engine directory");
		return real;
	}

	const hashPython = async () => sha256OfFile({ fsApi, file: await enginePython(), maxBytes: MAX_PYTHON_BYTES });

	const statKey = async (file) => {
		const stat = await fsApi.lstat(file);
		return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
	};

	// The result of the last full check, valid while the manifest, the interpreter, the driver and the
	// checkpoint keep the same size, modification time and inode. Concurrent callers share one run.
	let verifyCache = null;
	let verifyInflight = null;
	let verifiedManifest = null;

	async function verifyOnce() {
		verifiedManifest = null;
		if (!supported || !parsedPins.ok) return false;
		try {
			const stat = await fsApi.lstat(paths.manifest);
			if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return false;
			const manifest = JSON.parse(await fsApi.readFile(paths.manifest, "utf8"));
			if (!manifest || manifest.schema !== 1 || manifest.modelId !== MODEL_ID) return false;
			if (!SHA256.test(manifest.driverSha256) || !SHA256.test(manifest.pythonSha256) || !SHA256.test(manifest.modelSha256)) return false;
			if (typeof manifest.modelFileName !== "string" || !FILE_NAME.test(manifest.modelFileName) || !isSize(manifest.modelSizeBytes)) return false;
			// The manifest must describe the install these pins ask for (an old or foreign install is "broken").
			const pinned = parsedPins.value;
			if (manifest.modelFileName !== pinned.model.fileName || manifest.modelSha256 !== pinned.model.sha256 || manifest.modelSizeBytes !== pinned.model.sizeBytes) return false;
			if (manifest.uvVersion !== pinned.uv.version || manifest.pythonVersion !== pinned.pythonVersion) return false;
			if (pinned.interpreterSha256 !== null && (manifest.interpreterSha256 !== pinned.interpreterSha256 || manifest.pythonSha256 !== pinned.interpreterSha256)) return false;
			const python = await enginePython();
			const checkpoint = path.join(checkpointDir, manifest.modelFileName);
			const checkpointStat = await fsApi.lstat(checkpoint);
			if (!checkpointStat.isFile() || checkpointStat.size !== manifest.modelSizeBytes) return false;
			const key = (await Promise.all([paths.manifest, python, driverPath, checkpoint].map(statKey))).join("|");
			let ok;
			if (verifyCache && verifyCache.key === key) ok = verifyCache.ok;
			else {
				ok =
					(await sha256OfFile({ fsApi, file: driverPath, maxBytes: MAX_DRIVER_BYTES })) === manifest.driverSha256 &&
					(await sha256OfFile({ fsApi, file: python, maxBytes: MAX_PYTHON_BYTES })) === manifest.pythonSha256 &&
					(await sha256OfFile({ fsApi, file: checkpoint, maxBytes: MAX_CHECKPOINT_BYTES })) === manifest.modelSha256;
				verifyCache = { key, ok };
			}
			if (ok) verifiedManifest = manifest;
			return ok;
		} catch {
			return false;
		}
	}

	/** True only if the manifest is sound and the driver, the interpreter and the checkpoint still match it. */
	function verifyEngine() {
		verifyInflight ??= verifyOnce().finally(() => {
			verifyInflight = null;
		});
		return verifyInflight;
	}

	async function engineState() {
		if (current) return "installing";
		const hasManifest = await fsApi.lstat(paths.manifest).then(() => true, () => false);
		if (!hasManifest) return "missing";
		return (await verifyEngine()) ? "ready" : "broken";
	}

	/** Free bytes for this user on the volume that holds userData (the nearest folder that exists), or null if unknown. */
	async function freeBytes() {
		for (let dir = userData; ; dir = path.dirname(dir)) {
			try {
				const stat = await fsApi.statfs(dir);
				const free = Number(stat.bavail) * Number(stat.bsize);
				return Number.isFinite(free) && free >= 0 ? free : null;
			} catch {
				if (path.dirname(dir) === dir) return null;
			}
		}
	}

	async function runInstall(job) {
		const { signal } = job.abort;
		try {
			if (await verifyEngine()) return { ok: true }; // already installed and sound
			const lock = parsedPins.ok ? await readLock().catch(() => null) : null;
			if (!parsedPins.ok || !lockUsable(lock)) return { ok: false, code: "pins-missing" };
			const free = await freeBytes();
			if (free !== null && free < Math.ceil(parsedPins.value.installSizeBytes * DISK_HEADROOM) + DISK_EXTRA_BYTES) return { ok: false, code: "no-disk-space" };
			if (!(await confirm(consentOptions({ pins: parsedPins.value, engineDir: paths.engineDir, signal })))) return { ok: false, code: "consent-declined" };
			throwIfAborted(signal);
			await installSteps({ signal });
			return { ok: true };
		} catch (error) {
			if (!(error instanceof InstallError) && !(error instanceof DownloadError)) log(`[ccut] stems install failed: ${error && error.stack ? error.stack : error}`);
			await wipe().catch((wipeError) => log(`[ccut] stems install: cleanup failed: ${wipeError && wipeError.code ? wipeError.code : wipeError}`));
			const code = error instanceof DownloadError ? error.code : error instanceof InstallError ? error.code : "install-failed";
			return { ok: false, code: code === "download-failed" || code === "verify-failed" ? code : "install-failed" };
		} finally {
			current = null;
		}
	}

	return {
		paths,
		isSupported: () => supported,
		isInstalling: () => current !== null,
		verifyEngine,
		/** The checkpoint file the last successful check covered (the manifest's name), or null. */
		checkpointPath: () => (verifiedManifest ? path.join(checkpointDir, verifiedManifest.modelFileName) : null),

		/** { supported, engine, installSizeBytes, installPercent, modelId } */
		async status() {
			const installSizeBytes = parsedPins.ok ? parsedPins.value.installSizeBytes : null;
			if (!supported) return { supported: false, engine: "missing", installSizeBytes, installPercent: null, modelId: MODEL_ID };
			const engine = await engineState();
			return { supported: true, engine, installSizeBytes, installPercent: engine === "installing" && current ? current.percent : null, modelId: MODEL_ID };
		},

		/** { ok: true } or { ok: false, code }. Resolves when the install has ended; progress is read through status(). */
		async install() {
			if (!supported) return { ok: false, code: "unsupported" };
			if (current || removing || isJobBusy()) return { ok: false, code: "busy" };
			const job = { abort: new AbortController(), percent: 0 };
			current = job; // claimed before anything is awaited
			job.done = runInstall(job);
			return job.done;
		},

		/** Stops a running install and removes what it made. */
		async cancelInstall() {
			const job = current;
			if (!job) return { ok: false };
			job.abort.abort("cancelled");
			await job.done;
			return { ok: true };
		},

		/** Deletes the engine and the model after the user confirmed in a main-process dialog. Refused while an install or a separation runs. */
		async remove() {
			if (current || removing || isJobBusy()) return { ok: false };
			removing = true;
			try {
				if (!(await confirmRemove(removeOptions({ pins: parsedPins.ok ? parsedPins.value : null, engineDir: paths.engineDir })))) return { ok: false };
				if (current || isJobBusy()) return { ok: false }; // something started while the dialog was open
				await wipe();
				return { ok: true };
			} catch (error) {
				log(`[ccut] stems: could not remove the engine: ${error && error.code ? error.code : error}`);
				return { ok: false };
			} finally {
				removing = false;
			}
		},

		/** Start-up: an install that never finished (no manifest) is deleted. */
		async sweepLeftovers() {
			const hasEngine = await fsApi.lstat(paths.engineDir).then(() => true, () => false);
			const hasManifest = await fsApi.lstat(paths.manifest).then(() => true, () => false);
			if (hasEngine && !hasManifest && !current) await wipe().catch(() => {});
		},

		/** Quit: a running install is killed and removed synchronously. */
		shutdownSync() {
			if (!current) return;
			current.abort.abort("quit");
			try {
				fsSync.rmSync(paths.engineDir, { recursive: true, force: true });
				fsSync.rmSync(paths.torchHome, { recursive: true, force: true });
			} catch {}
		},
	};
}

module.exports = { MODEL_ID, createStemsInstaller, lockUsable, validatePins };
