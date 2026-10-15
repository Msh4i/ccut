// "Import from link": running yt-dlp. No Electron import; `spawn` and `kill` are injected.
//
// - spawn(binary, ARRAY, { shell: false }): no shell ever, no command string.
// - The environment is built from nothing (buildChildEnv): PATH (absolute entries only: a
//   yt-dlp script may need "env python3", and yt-dlp looks for an optional JavaScript runtime
//   there), HOME/XDG/APPDATA/TEMP inside the job directory so no user config, plugin or cache
//   directory is found, a UTF-8 locale; on Windows SystemRoot/windir/PATHEXT (Python's sockets
//   need SystemRoot). Nothing else: no proxy variables, no PYTHONPATH/PYTHONHOME/LD_PRELOAD,
//   none of the app's secrets.
// - Its own process group on Linux/macOS (detached), so cancel ends yt-dlp AND anything it
//   started (the PyInstaller bootloader's child, a JavaScript runtime): SIGTERM to the group,
//   SIGKILL after a grace period. Windows has no groups: taskkill /T /F ends the tree.
// - A wall-clock limit and an inactivity limit (no output for that long).
// - Output is read line by line with a per-line cap; nothing is buffered beyond one line.
const path = require("node:path");
const { createLineSplitter } = require("./link-import-parse");

const DEFAULT_LIMITS = Object.freeze({
	wallMs: 30 * 60 * 1000,
	idleMs: 5 * 60 * 1000,
	maxLineChars: 4096,
	killGraceMs: 3000,
	closeWaitMs: 2000,
});

function envValue({ env, name }) {
	const wanted = name.toUpperCase();
	for (const [key, value] of Object.entries(env ?? {})) {
		if (key.toUpperCase() === wanted && typeof value === "string" && value !== "") return value;
	}
	return null;
}

/** The child's whole environment. `jobDir` is absolute; home/ and tmp/ inside it exist. */
function buildChildEnv({ parentEnv, platform, jobDir }) {
	const api = platform === "win32" ? path.win32 : path.posix;
	const entries = [];
	for (const raw of (envValue({ env: parentEnv, name: "PATH" }) ?? "").split(api.delimiter)) {
		const entry = platform === "win32" ? raw.replace(/^"(.*)"$/, "$1") : raw;
		if (entry === "" || !api.isAbsolute(entry) || entries.includes(entry)) continue;
		entries.push(entry);
	}
	const home = api.join(jobDir, "home");
	const tmp = api.join(jobDir, "tmp");
	const locale = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
	if (platform === "win32") {
		const system = {};
		for (const name of ["SystemRoot", "windir", "PATHEXT"]) {
			const value = envValue({ env: parentEnv, name });
			if (value !== null) system[name] = value;
		}
		return {
			PATH: entries.join(api.delimiter),
			...system,
			HOME: home,
			USERPROFILE: home,
			APPDATA: api.join(home, "AppData", "Roaming"),
			LOCALAPPDATA: api.join(home, "AppData", "Local"),
			TEMP: tmp,
			TMP: tmp,
			...locale,
		};
	}
	return {
		PATH: entries.join(api.delimiter),
		HOME: home,
		XDG_CONFIG_HOME: api.join(home, ".config"),
		XDG_CACHE_HOME: api.join(home, ".cache"),
		XDG_DATA_HOME: api.join(home, ".local", "share"),
		XDG_STATE_HOME: api.join(home, ".local", "state"),
		TMPDIR: tmp,
		...locale,
	};
}

/**
 * Starts the process. `done` resolves (never rejects) with { reason, exitCode, signal }:
 * reason "exit" (it ended by itself), "spawn-error", or whatever stopped it: "cancelled",
 * "timeout" (wall clock), "idle" (no output), or a reason given to stop().
 */
function runProcess({ spawn, binary, args, cwd, env, platform, onLine, limits: overrides = {}, kill = (pid, signal) => process.kill(pid, signal) }) {
	const limits = { ...DEFAULT_LIMITS, ...overrides };
	const isWindows = platform === "win32";
	let resolveDone;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});
	let settled = false;
	let stopReason = null;
	let exitInfo = null;
	let wallTimer = null;
	let idleTimer = null;
	let killTimer = null;
	let closeTimer = null;
	let child = null;

	const clearTimers = () => {
		for (const timer of [wallTimer, idleTimer, killTimer, closeTimer]) if (timer) clearTimeout(timer);
	};
	const finish = (outcome) => {
		if (settled) return;
		settled = true;
		clearTimers();
		resolveDone(outcome);
	};

	const splitters = {
		stdout: createLineSplitter({ maxLineChars: limits.maxLineChars, onLine: (line) => onLine({ stream: "stdout", line }) }),
		stderr: createLineSplitter({ maxLineChars: limits.maxLineChars, onLine: (line) => onLine({ stream: "stderr", line }) }),
	};

	const signalTree = (signal) => {
		if (!child || typeof child.pid !== "number") return;
		if (isWindows) {
			const root = envValue({ env, name: "SystemRoot" }) ?? "C:\\Windows";
			try {
				const killer = spawn(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
					shell: false,
					windowsHide: true,
					stdio: "ignore",
				});
				killer.on("error", () => {});
			} catch {}
			try {
				child.kill();
			} catch {}
			return;
		}
		try {
			kill(-child.pid, signal); // the whole group
		} catch {
			try {
				child.kill(signal);
			} catch {}
		}
	};

	const stop = (reason) => {
		if (settled || exitInfo || stopReason) return;
		stopReason = reason;
		signalTree("SIGTERM");
		killTimer = setTimeout(() => signalTree("SIGKILL"), limits.killGraceMs);
	};

	const killSync = () => {
		if (settled || exitInfo) return;
		stopReason = stopReason ?? "cancelled";
		signalTree("SIGKILL");
	};

	const touch = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => stop("idle"), limits.idleMs);
	};

	const complete = () => {
		if (settled) return;
		splitters.stdout.end();
		splitters.stderr.end();
		finish({ reason: stopReason ?? "exit", exitCode: exitInfo ? exitInfo.code : null, signal: exitInfo ? exitInfo.signal : null });
	};

	try {
		child = spawn(binary, args, { cwd, env, shell: false, detached: !isWindows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		finish({ reason: "spawn-error", exitCode: null, signal: null });
		return { done, stop: () => {}, cancel: () => {}, killSync: () => {}, pid: null, droppedLines: () => 0 };
	}

	child.on("error", () => {
		// Before it ran: the binary is missing or not executable. After: a failed kill, nothing to do.
		if (!exitInfo && !stopReason) finish({ reason: "spawn-error", exitCode: null, signal: null });
	});
	child.on("exit", (code, signal) => {
		exitInfo = { code, signal };
		if (killTimer) clearTimeout(killTimer);
		// The leader is gone; anything it started that is still in its group (an ffmpeg or a
		// JavaScript runtime hanging on shutdown) must not outlive the job. An empty group
		// throws ESRCH, which is fine. Windows: taskkill /T already ran on stop.
		if (!isWindows && typeof child.pid === "number") {
			try {
				kill(-child.pid, "SIGKILL");
			} catch {}
		}
		// stdout/stderr may still hold the last lines: wait for "close", but not forever.
		closeTimer = setTimeout(() => {
			child.stdout?.destroy?.();
			child.stderr?.destroy?.();
			complete();
		}, limits.closeWaitMs);
	});
	child.on("close", (code, signal) => {
		exitInfo = exitInfo ?? { code, signal };
		complete();
	});
	for (const stream of ["stdout", "stderr"]) {
		child[stream]?.on("data", (chunk) => {
			touch();
			splitters[stream].push(chunk);
		});
	}
	wallTimer = setTimeout(() => stop("timeout"), limits.wallMs);
	touch();

	return {
		done,
		stop,
		cancel: () => stop("cancelled"),
		killSync,
		pid: typeof child.pid === "number" ? child.pid : null,
		droppedLines: () => splitters.stdout.droppedLines() + splitters.stderr.droppedLines(),
	};
}

module.exports = { DEFAULT_LIMITS, buildChildEnv, runProcess };
