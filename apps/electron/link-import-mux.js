// "Import from link": runs the pair's mux (link-import-mux-worker.js) in a worker_threads Worker
// of the main process. No Electron import (the Worker class is injectable for tests).
//
// Why a worker: mediabunny parses media that came from the network. In a worker its V8 heap is
// capped (resourceLimits), a hang is ended with terminate() without blocking the thread that
// answers the window's IPC, and a crash stays in the worker. The main thread only sees small
// messages: { type: "progress", fraction }, { type: "done", result }, { type: "error", code }.
//
// Limits: wall time, inactivity (no progress message), and a grace period after "cancel"
// before terminate(). `done` settles only after terminate() has finished (at most
// terminateWaitMs): on Windows a file the worker still holds cannot be deleted. `done` never
// rejects: { ok: true, result } or
// { ok: false, reason: "cancelled" | "timeout" | "idle" | "failed" | "crashed", code?, detail? }.
//
// mediabunny: the worker loads exactly the absolute path given here (resolveMediabunnyPath).
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { WORKER_KIND } = require("./link-import-mux-worker");

const MUX_RUN_LIMITS = Object.freeze({
	wallMs: 10 * 60 * 1000,
	idleMs: 60 * 1000,
	killGraceMs: 3000,
	heapMb: 384,
	terminateWaitMs: 5000,
});

/**
 * The mediabunny the worker may load: the vendored CJS bundle next to the worker
 * (vendor/mediabunny.cjs, bundle.js copies it); in the repository (not packaged) the installed
 * package. In the packaged app nothing else: a module search from app.asar.unpacked could reach
 * a node_modules others can write to (an AppImage is mounted under /tmp). null = no combining.
 */
function resolveMediabunnyPath({ workerDir, packaged }) {
	const vendored = path.join(workerDir, "vendor", "mediabunny.cjs");
	if (fs.existsSync(vendored)) return vendored;
	if (packaged) return null;
	try {
		return require.resolve("mediabunny");
	} catch {
		return null;
	}
}

/**
 * Where the worker file is. The packaged app keeps it (and vendor/mediabunny.cjs) outside the
 * asar archive (asarUnpack in package.json), so a plain Node worker can load it.
 */
function muxWorkerPath({ dir = __dirname } = {}) {
	return path.join(dir.replace(/app\.asar(?=$|[\\/])/, "app.asar.unpacked"), "link-import-mux-worker.js");
}

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const isFraction = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function resultOf(value) {
	if (!isPlainObject(value)) return null;
	const { packets, shift, width, height, duration } = value;
	if (![packets, shift, width, height, duration].every(isCount)) return null;
	return { packets, shift, width, height, duration };
}

/**
 * Starts the worker for one job ({ video, audio, outPath }). Returns { done, cancel, terminate }:
 * cancel() asks the worker to stop and terminates it after the grace period; terminate() ends
 * it at once (app quit).
 */
function runMuxWorker({ job, mediabunnyPath, onProgress = () => {}, limits = {}, workerPath = muxWorkerPath(), WorkerClass = Worker }) {
	const lim = { ...MUX_RUN_LIMITS, ...limits };
	let settle;
	const done = new Promise((resolve) => {
		settle = resolve;
	});
	let finished = false;
	let stopReason = null;
	let worker = null;
	let wallTimer = null;
	let idleTimer = null;
	let killTimer = null;

	const finish = (outcome) => {
		if (finished) return;
		finished = true;
		clearTimeout(wallTimer);
		clearTimeout(idleTimer);
		clearTimeout(killTimer);
		if (!worker) {
			settle(outcome);
			return;
		}
		// Settle once the worker is gone (its file handles closed), or after terminateWaitMs.
		let waited = null;
		const bounded = new Promise((resolve) => {
			waited = setTimeout(resolve, lim.terminateWaitMs);
		});
		const terminated = Promise.resolve()
			.then(() => worker.terminate())
			.catch(() => {});
		Promise.race([terminated, bounded]).then(() => {
			clearTimeout(waited);
			settle(outcome);
		});
	};
	const stop = (reason) => {
		if (finished || stopReason) return;
		stopReason = reason;
		try {
			worker?.postMessage({ type: "cancel" });
		} catch {}
		killTimer = setTimeout(() => finish({ ok: false, reason }), lim.killGraceMs);
	};
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => stop("idle"), lim.idleMs);
	};

	if (typeof mediabunnyPath !== "string" || !path.isAbsolute(mediabunnyPath)) {
		finish({ ok: false, reason: "failed", code: "bad-output", detail: "mediabunny is not available" });
		return { done, cancel: () => {}, terminate: () => {} };
	}
	try {
		worker = new WorkerClass(workerPath, { workerData: { kind: WORKER_KIND, job, mediabunnyPath }, resourceLimits: { maxOldGenerationSizeMb: lim.heapMb } });
	} catch (error) {
		finish({ ok: false, reason: "crashed", detail: String(error && error.message).slice(0, 300) });
		return { done, cancel: () => {}, terminate: () => {} };
	}
	worker.on("message", (message) => {
		if (finished || !isPlainObject(message)) return;
		if (message.type === "progress") {
			if (!isFraction(message.fraction)) return;
			armIdle();
			if (!stopReason) onProgress(message.fraction);
		} else if (message.type === "done") {
			const result = resultOf(message.result);
			if (stopReason) finish({ ok: false, reason: stopReason });
			else finish(result ? { ok: true, result } : { ok: false, reason: "failed", code: "bad-output" });
		} else if (message.type === "error") {
			const code = message.code === "cancelled" ? "cancelled" : "bad-output";
			const detail = typeof message.detail === "string" ? message.detail.slice(0, 300) : "";
			finish({ ok: false, reason: stopReason ?? (code === "cancelled" ? "cancelled" : "failed"), code, detail });
		}
	});
	worker.on("error", (error) => finish({ ok: false, reason: stopReason ?? "crashed", detail: String(error && error.message).slice(0, 300) }));
	worker.on("exit", (exitCode) => finish({ ok: false, reason: stopReason ?? "crashed", detail: `exit ${exitCode}` }));
	wallTimer = setTimeout(() => stop("timeout"), lim.wallMs);
	armIdle();
	return {
		done,
		cancel: () => stop("cancelled"),
		terminate: () => finish({ ok: false, reason: stopReason ?? "cancelled" }),
	};
}

module.exports = { MUX_RUN_LIMITS, muxWorkerPath, resolveMediabunnyPath, runMuxWorker };
