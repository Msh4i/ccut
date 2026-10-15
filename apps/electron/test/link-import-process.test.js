const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildChildEnv, runProcess } = require("../link-import-process");

// yt-dlp runs as a child process: never through a shell, in its own process group, with an
// environment built from nothing, a wall-clock and an inactivity timeout, and output read
// line by line with a cap.

let dir;
beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-link-proc-"));
});
afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

// A killed grandchild is reparented and may stay a zombie until init reaps it (containers):
// on Linux a zombie ("Z" in /proc/<pid>/stat) counts as dead.
const isAlive = (pid) => {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return true;
	}
};

describe("buildChildEnv", () => {
	const parentEnv = {
		PATH: "/usr/local/bin:relative/bin:.::/usr/bin:/usr/bin",
		HOME: "/home/owner",
		HTTPS_PROXY: "http://proxy:3128",
		http_proxy: "http://proxy:3128",
		NO_PROXY: "localhost",
		PYTHONPATH: "/home/owner/evil",
		PYTHONHOME: "/x",
		PYTHONSTARTUP: "/x/start.py",
		LD_PRELOAD: "/x/hook.so",
		YTDLP_CONFIG: "x",
		AWS_SECRET_ACCESS_KEY: "secret",
		BETTER_AUTH_SECRET: "secret",
		XDG_CONFIG_HOME: "/home/owner/.config",
		SystemRoot: "C:\\Windows",
	};

	test("Linux/macOS: only PATH (absolute entries), HOME/XDG/TMP inside the job dir, a UTF-8 locale; nothing else of the parent", () => {
		const env = buildChildEnv({ parentEnv, platform: "linux", jobDir: "/data/link-import/jobs/abc" });
		expect(env).toEqual({
			PATH: "/usr/local/bin:/usr/bin",
			HOME: "/data/link-import/jobs/abc/home",
			XDG_CONFIG_HOME: "/data/link-import/jobs/abc/home/.config",
			XDG_CACHE_HOME: "/data/link-import/jobs/abc/home/.cache",
			XDG_DATA_HOME: "/data/link-import/jobs/abc/home/.local/share",
			XDG_STATE_HOME: "/data/link-import/jobs/abc/home/.local/state",
			TMPDIR: "/data/link-import/jobs/abc/tmp",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			PYTHONIOENCODING: "utf-8",
			PYTHONUTF8: "1",
		});
	});

	test("Windows: SystemRoot/windir/PATHEXT kept (sockets need SystemRoot), every user folder inside the job dir; names are case-insensitive", () => {
		const env = buildChildEnv({
			parentEnv: { Path: "C:\\Windows\\system32;tools;C:\\yt", SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows", PATHEXT: ".COM;.EXE", HTTPS_PROXY: "x", APPDATA: "C:\\Users\\o\\AppData\\Roaming" },
			platform: "win32",
			jobDir: "C:\\data\\jobs\\abc",
		});
		expect(env).toEqual({
			PATH: "C:\\Windows\\system32;C:\\yt",
			SystemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			PATHEXT: ".COM;.EXE",
			HOME: "C:\\data\\jobs\\abc\\home",
			USERPROFILE: "C:\\data\\jobs\\abc\\home",
			APPDATA: "C:\\data\\jobs\\abc\\home\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\data\\jobs\\abc\\home\\AppData\\Local",
			TEMP: "C:\\data\\jobs\\abc\\tmp",
			TMP: "C:\\data\\jobs\\abc\\tmp",
			LANG: "C.UTF-8",
			LC_ALL: "C.UTF-8",
			PYTHONIOENCODING: "utf-8",
			PYTHONUTF8: "1",
		});
	});

	test("no PATH at all in the parent: an empty PATH (never the current directory)", () => {
		expect(buildChildEnv({ parentEnv: {}, platform: "linux", jobDir: "/j" }).PATH).toBe("");
	});
});

describe("runProcess: spawn options (fake spawn)", () => {
	function fakeSpawn() {
		const calls = [];
		const spawn = (command, args, options) => {
			const child = new EventEmitter();
			child.pid = 4242;
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = () => true;
			calls.push({ command, args, options, child });
			return child;
		};
		return { spawn, calls };
	}

	test("argument ARRAY, shell false, own process group, stdin closed, the given cwd and env only", () => {
		const { spawn, calls } = fakeSpawn();
		const env = { PATH: "/usr/bin" };
		const run = runProcess({ spawn, binary: "/usr/bin/yt-dlp", args: ["--", "https://youtu.be/x"], cwd: dir, env, platform: "linux", onLine: () => {}, limits: { wallMs: 60_000, idleMs: 60_000 } });
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("/usr/bin/yt-dlp");
		expect(calls[0].args).toEqual(["--", "https://youtu.be/x"]);
		expect(calls[0].options).toEqual({ cwd: dir, env, shell: false, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		calls[0].child.emit("exit", 0, null);
		calls[0].child.emit("close", 0, null);
		return run.done;
	});

	test("Windows: not detached (no process groups there; the tree is ended with taskkill /T)", () => {
		const { spawn, calls } = fakeSpawn();
		const run = runProcess({ spawn, binary: "C:\\yt\\yt-dlp.exe", args: [], cwd: dir, env: {}, platform: "win32", onLine: () => {}, limits: { wallMs: 60_000, idleMs: 60_000 } });
		expect(calls[0].options.detached).toBe(false);
		run.cancel();
		const taskkill = calls.find((call) => call.command.toLowerCase().endsWith("taskkill.exe"));
		expect(taskkill.args).toEqual(["/PID", "4242", "/T", "/F"]);
		expect(taskkill.options.shell).toBe(false);
		calls[0].child.emit("exit", null, "SIGTERM");
		calls[0].child.emit("close", null, "SIGTERM");
		return run.done;
	});
});

// Real child processes: bun itself runs a tiny inline script.
const bun = process.execPath;
const realRun = ({ script, limits = {}, onLine = () => {} }) =>
	runProcess({
		spawn: childProcess.spawn,
		binary: bun,
		args: ["-e", script],
		cwd: dir,
		env: { PATH: process.env.PATH ?? "" },
		platform: process.platform,
		onLine,
		limits: { wallMs: 20_000, idleMs: 20_000, maxLineChars: 1000, killGraceMs: 300, ...limits },
	});

describe("runProcess: real child processes", () => {
	test("stdout and stderr lines arrive with their stream; the exit code comes back", async () => {
		const lines = [];
		const run = realRun({ script: `console.log("one"); console.error("two"); console.log("three"); process.exit(3)`, onLine: (line) => lines.push(line) });
		const outcome = await run.done;
		expect(outcome).toEqual({ reason: "exit", exitCode: 3, signal: null });
		expect(lines.filter((l) => l.stream === "stdout").map((l) => l.line)).toEqual(["one", "three"]);
		expect(lines.filter((l) => l.stream === "stderr").map((l) => l.line)).toEqual(["two"]);
	});

	test("the wall-clock limit ends a process that keeps talking", async () => {
		const run = realRun({ script: `setInterval(() => console.log("tick"), 20)`, limits: { wallMs: 300, idleMs: 10_000 } });
		const outcome = await run.done;
		expect(outcome.reason).toBe("timeout");
		expect(isAlive(run.pid)).toBe(false);
	});

	test("output resets the inactivity limit: a process that keeps talking runs past it and ends by itself", async () => {
		const run = realRun({ script: `let n = 0; const t = setInterval(() => { console.log("tick"); if (++n === 15) { clearInterval(t); process.exit(0); } }, 40)`, limits: { wallMs: 20_000, idleMs: 250 } });
		expect(await run.done).toEqual({ reason: "exit", exitCode: 0, signal: null });
	});

	test("the inactivity limit ends a process that went quiet", async () => {
		const run = realRun({ script: `console.log("hello"); setTimeout(() => {}, 30_000)`, limits: { wallMs: 20_000, idleMs: 300 } });
		const outcome = await run.done;
		expect(outcome.reason).toBe("idle");
		expect(isAlive(run.pid)).toBe(false);
	});

	test("cancel ends the whole process group: the child AND a grandchild it started", async () => {
		const pidFile = path.join(dir, "grandchild.pid");
		const script = `
			const cp = require("node:child_process");
			const grandchild = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
			require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
			console.log("started");
			setTimeout(() => {}, 30000);
		`;
		let started;
		const ready = new Promise((resolve) => (started = resolve));
		const run = realRun({ script, onLine: ({ line }) => line === "started" && started() });
		await ready;
		const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
		expect(isAlive(grandchild)).toBe(true);
		run.cancel();
		const outcome = await run.done;
		expect(outcome.reason).toBe("cancelled");
		// The group got SIGTERM; give the grandchild the grace period to die.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(isAlive(run.pid)).toBe(false);
		expect(isAlive(grandchild)).toBe(false);
	});

	// Security review L1: a grandchild that outlives its leader (natural exit or SIGTERM) was never SIGKILLed.
	test.skipIf(process.platform === "win32")("a grandchild still running when the leader exits is killed with the group", async () => {
		const pidFile = path.join(dir, "straggler.pid");
		const script = `
			const cp = require("node:child_process");
			const straggler = cp.spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], { stdio: "ignore" });
			require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(straggler.pid));
			setTimeout(() => process.exit(0), 200);
		`;
		const run = realRun({ script });
		const outcome = await run.done;
		expect(outcome.reason).toBe("exit");
		const straggler = Number(fs.readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(isAlive(straggler)).toBe(false);
	});

	test("a process that ignores SIGTERM is SIGKILLed after the grace period", async () => {
		const run = realRun({ script: `process.on("SIGTERM", () => {}); console.log("x"); setInterval(() => {}, 1000)`, limits: { killGraceMs: 200 } });
		await new Promise((resolve) => setTimeout(resolve, 300));
		run.cancel();
		const outcome = await run.done;
		expect(outcome.reason).toBe("cancelled");
		expect(isAlive(run.pid)).toBe(false);
	});

	test("killSync (app quit) kills at once, without waiting", async () => {
		const run = realRun({ script: `process.on("SIGTERM", () => {}); setInterval(() => console.log("x"), 50)` });
		await new Promise((resolve) => setTimeout(resolve, 200));
		run.killSync();
		const outcome = await run.done;
		expect(outcome.reason).toBe("cancelled");
		expect(isAlive(run.pid)).toBe(false);
	});

	test("a binary that does not exist: spawn-error, no throw", async () => {
		const run = runProcess({ spawn: childProcess.spawn, binary: path.join(dir, "missing-yt-dlp"), args: [], cwd: dir, env: {}, platform: process.platform, onLine: () => {}, limits: {} });
		expect((await run.done).reason).toBe("spawn-error");
	});

	test("megabytes of output without a line break are never buffered (lines are capped)", async () => {
		const lines = [];
		const run = realRun({ script: `process.stdout.write("x".repeat(4 * 1024 * 1024)); process.stdout.write("\\nok\\n")`, onLine: ({ line }) => lines.push(line), limits: { maxLineChars: 1000 } });
		const outcome = await run.done;
		expect(outcome.reason).toBe("exit");
		expect(lines).toEqual(["ok"]);
		expect(run.droppedLines()).toBe(1);
	});
});
