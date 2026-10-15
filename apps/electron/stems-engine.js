// Stems (round 5): running engine A, the managed Python + Demucs driver. No Electron import:
// spawn, the file system, os.setPriority and the core count are injected.
//
// Command (no shell, an argument array, absolute paths only; the page contributes nothing but
// two validated integers, frames and sampleRate):
//   <userData>/stems/engine/venv/bin/python -I <driver> --rate R --channels 2 --frames N
//        --input <jobDir>/input.pcm --out <jobDir> --checkpoint <TORCH_HOME>/hub/checkpoints/<pinned file>
// `-I` (isolated): no PYTHON* variables, no user site, and the driver's directory is not put on
// the import path. Environment: built from nothing (link-import-process.js buildChildEnv: a
// minimal PATH, HOME/TMPDIR inside the job directory) plus TORCH_HOME and OMP_NUM_THREADS. Every
// proxy variable points at a dead local port (OFFLINE_ENV), no PYTHONNOHTTPSVERIFY, none of the app's variables.
// Priority: nice 10 right after the spawn. Own process group, killed as a tree.
// stdout is JSON lines: {"progress": 0..1} and a last {"done": true}; anything else is ignored.
// stderr is kept (last 4 KiB) for the log only. The result is { ok: true } or { ok: false, code }
// with code "engine-failed" | "timeout" | "invalid-output" | "out-of-memory" | "cancelled".
const os = require("node:os");
const path = require("node:path");
const { buildChildEnv, runProcess } = require("./link-import-process");

const CHANNELS = 2;
const NICE = 10;
const TIMEOUT_FLOOR_MS = 10 * 60 * 1000;
const TIMEOUT_AUDIO_FACTOR = 3;
const MAX_LINE_CHARS = 4096;
const STDERR_TAIL_CHARS = 4096;
// The engine is ended when its resident memory passes the smaller of 6 GiB and 60% of the machine's RAM.
const MEMORY_CAP_BYTES = 6 * 1024 * 1024 * 1024;
const MEMORY_SHARE = 0.6;
const MEMORY_POLL_MS = 1000;
const MINIMAL_PATH = "/usr/bin:/bin";
// No network can succeed. First layer: the Hugging Face hub libraries are told to stay offline and not to
// phone home (HF_HUB_OFFLINE saves about 20 s per job that would go into a failing lookup). Second layer:
// every proxy variable points at a closed local port (the discard port) and NO_PROXY is not set. Demucs must
// load the pinned checkpoint from TORCH_HOME; if it ever tried to download another one (torch.hub does, for
// a file name it does not find), the request fails instead of fetching it.
const DEAD_PROXY = "http://127.0.0.1:9";
const OFFLINE_ENV = Object.freeze({
	HF_HUB_OFFLINE: "1",
	HF_HUB_DISABLE_TELEMETRY: "1",
	HTTP_PROXY: DEAD_PROXY,
	HTTPS_PROXY: DEAD_PROXY,
	ALL_PROXY: DEAD_PROXY,
	http_proxy: DEAD_PROXY,
	https_proxy: DEAD_PROXY,
	all_proxy: DEAD_PROXY,
});

/** Every place the feature owns, below <userData>/stems. */
function stemsPaths({ userData, pathApi = path }) {
	const root = pathApi.join(userData, "stems");
	const engineDir = pathApi.join(root, "engine");
	return {
		root,
		engineDir,
		venvDir: pathApi.join(engineDir, "venv"),
		venvPython: pathApi.join(engineDir, "venv", "bin", "python"),
		manifest: pathApi.join(engineDir, "manifest.json"),
		torchHome: pathApi.join(root, "torch"),
		jobsRoot: pathApi.join(root, "jobs"),
	};
}

/** The driver sits outside the asar archive in a packaged app (asarUnpack): Python cannot read an archive. */
function resolveDriverPath({ dir = __dirname } = {}) {
	return path.join(dir.replace(/app\.asar(?=$|[\\/])/, "app.asar.unpacked"), "stems_demucs_driver.py");
}

/** Wall-clock limit: 3 x the audio's length, never under 10 minutes. */
function engineTimeoutMs({ frames, sampleRate }) {
	return Math.max(TIMEOUT_FLOOR_MS, Math.ceil((TIMEOUT_AUDIO_FACTOR * frames * 1000) / sampleRate));
}

const memoryLimitBytes = ({ total }) => Math.min(MEMORY_CAP_BYTES, Math.floor(MEMORY_SHARE * total));

/** Resident memory of a process in bytes from /proc/<pid>/status (Linux), or null when it cannot be read. */
async function readProcRss({ pid, fsApi }) {
	try {
		const match = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(await fsApi.readFile(`/proc/${pid}/status`, "utf8"));
		return match ? Number(match[1]) * 1024 : null;
	} catch {
		return null;
	}
}

const threadsFor = (cores) => Math.max(1, Math.min(10, (Number.isFinite(cores) ? cores : 1) - 2));

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/** One stdout line -> { progress } (0..1) | { done: true } | null. */
function parseEngineLine(line) {
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isPlainObject(value)) return null;
	if (value.done === true) return { done: true };
	if (typeof value.progress === "number" && Number.isFinite(value.progress)) return { progress: Math.min(1, Math.max(0, value.progress)) };
	return null;
}

function createEngineRunner({
	userData,
	driverPath = resolveDriverPath(),
	spawn,
	platform = process.platform,
	cores = 1,
	setPriority = () => {},
	fsApi,
	log = () => {},
	limits = {},
	kill,
	// The checkpoint file the installer verified (or null: then there is no run).
	checkpointPath = async () => null,
	// Test seams for the memory watchdog.
	totalMemory = () => os.totalmem(),
	readRss = (pid) => readProcRss({ pid, fsApi }),
}) {
	const paths = stemsPaths({ userData });
	return async function runEngine({ jobDir, frames, sampleRate, signal, onProgress }) {
		if (signal?.aborted) return { ok: false, code: "cancelled" };
		const checkpoint = await checkpointPath();
		if (typeof checkpoint !== "string" || !path.isAbsolute(checkpoint)) return { ok: false, code: "engine-failed" };
		const env = {
			...buildChildEnv({ parentEnv: { PATH: MINIMAL_PATH }, platform, jobDir }),
			...OFFLINE_ENV,
			TORCH_HOME: paths.torchHome,
			OMP_NUM_THREADS: String(threadsFor(cores)),
		};
		await fsApi.mkdir(path.join(jobDir, "home"), { recursive: true, mode: 0o700 });
		await fsApi.mkdir(path.join(jobDir, "tmp"), { recursive: true, mode: 0o700 });
		const args = [
			"-I",
			driverPath,
			"--rate",
			String(sampleRate),
			"--channels",
			String(CHANNELS),
			"--frames",
			String(frames),
			"--input",
			path.join(jobDir, "input.pcm"),
			"--out",
			jobDir,
			"--checkpoint",
			checkpoint,
		];
		let doneSeen = false;
		let stderrTail = "";
		const wallMs = limits.wallMs ?? engineTimeoutMs({ frames, sampleRate });
		const run = runProcess({
			spawn,
			binary: paths.venvPython,
			args,
			cwd: jobDir,
			env,
			platform,
			kill,
			// Demucs can be quiet for a while on a slow machine: only the wall clock ends a stalled run.
			limits: { wallMs, idleMs: wallMs, maxLineChars: MAX_LINE_CHARS, ...(limits.killGraceMs ? { killGraceMs: limits.killGraceMs } : {}) },
			onLine: ({ stream, line }) => {
				if (stream === "stderr") {
					stderrTail = (stderrTail + line + "\n").slice(-STDERR_TAIL_CHARS);
					return;
				}
				const parsed = parseEngineLine(line);
				if (!parsed) return;
				if (parsed.done) doneSeen = true;
				else onProgress(parsed.progress);
			},
		});
		if (run.pid !== null) {
			try {
				setPriority(run.pid, NICE);
			} catch (error) {
				log(`[ccut] stems: could not lower the engine's priority: ${error && error.code ? error.code : error}`);
			}
		}
		// Memory watchdog (Linux): a runaway engine is ended before it takes the machine down. An unreadable
		// /proc entry (the process just ended, no /proc) is ignored.
		let outOfMemory = false;
		let watchdog = null;
		if (platform === "linux" && run.pid !== null) {
			const limit = memoryLimitBytes({ total: totalMemory() });
			let reading = false;
			watchdog = setInterval(async () => {
				if (reading || outOfMemory) return;
				reading = true;
				try {
					const rss = await readRss(run.pid);
					if (typeof rss === "number" && rss > limit) {
						outOfMemory = true;
						log(`[ccut] stems: the engine used ${Math.round(rss / 1048576)} MiB (limit ${Math.round(limit / 1048576)} MiB), ending it`);
						run.stop("out-of-memory");
					}
				} catch {
				} finally {
					reading = false;
				}
			}, limits.memoryPollMs ?? MEMORY_POLL_MS);
			watchdog.unref?.();
		}
		const onAbort = () => (signal.reason === "quit" ? run.killSync() : run.cancel());
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		const outcome = await run.done;
		if (watchdog) clearInterval(watchdog);
		signal?.removeEventListener("abort", onAbort);

		let result;
		if (outcome.reason === "out-of-memory") result = { ok: false, code: "out-of-memory" };
		else if (outcome.reason === "cancelled") result = { ok: false, code: "cancelled" };
		else if (outcome.reason === "timeout" || outcome.reason === "idle") result = { ok: false, code: "timeout" };
		else if (outcome.reason !== "exit" || outcome.exitCode !== 0) result = { ok: false, code: "engine-failed" };
		else if (!doneSeen) result = { ok: false, code: "invalid-output" };
		else result = { ok: true };
		if (!result.ok && result.code !== "cancelled") {
			log(`[ccut] stems engine ended: ${result.code} (${outcome.reason}, exit ${outcome.exitCode}, signal ${outcome.signal}); stderr tail: ${JSON.stringify(stderrTail)}`);
		}
		return result;
	};
}

module.exports = { CHANNELS, MAX_LINE_CHARS, OFFLINE_ENV, STDERR_TAIL_CHARS, createEngineRunner, engineTimeoutMs, memoryLimitBytes, parseEngineLine, resolveDriverPath, stemsPaths, threadsFor };
