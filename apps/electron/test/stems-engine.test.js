const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MAX_LINE_CHARS, OFFLINE_ENV, createEngineRunner, engineTimeoutMs, memoryLimitBytes, parseEngineLine, resolveDriverPath, stemsPaths, threadsFor } = require("../stems-engine");

// The engine runner with a fake child process: command and environment, progress parsing,
// garbage ignored, the exit/timeout/cancel mapping.

let userData;
let jobDir;
beforeEach(async () => {
	userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-stems-engine-"));
	jobDir = path.join(userData, "stems", "jobs", "0123456789abcdef");
	await fsp.mkdir(jobDir, { recursive: true });
});
afterEach(async () => {
	await fsp.rm(userData, { recursive: true, force: true });
});

/** A child that is driven by the test: script({ child, finish }) runs after the spawn. */
function fakeSpawn({ script, pid = 4242, failSpawn = false }) {
	const spawned = [];
	const kills = [];
	let child;
	let exited = false;
	const spawn = (binary, args, options) => {
		if (failSpawn) throw new Error("ENOENT");
		child = new EventEmitter();
		child.pid = pid;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		child.once("exit", () => (exited = true));
		spawned.push({ binary, args, options });
		queueMicrotask(() => script?.({ child, stdout: (text) => child.stdout.emit("data", Buffer.from(text)), stderr: (text) => child.stderr.emit("data", Buffer.from(text)), exit: (code, signal = null) => {
			child.emit("exit", code, signal);
			child.emit("close", code, signal);
		} }));
		return child;
	};
	// A killed process group ends the child.
	const kill = (target, signal) => {
		kills.push({ target, signal });
		if (exited) return; // the group is already empty (ESRCH in real life)
		child.emit("exit", null, signal);
		child.emit("close", null, signal);
	};
	return { spawn, spawned, kills, kill };
}

const CHECKPOINT = "/data/stems/torch/hub/checkpoints/955717e8-8726e21a.th";
const base = (extra) => ({ userData, driverPath: "/app/stems_demucs_driver.py", platform: "linux", cores: 12, fsApi: fsp, checkpointPath: async () => CHECKPOINT, ...extra });
const request = (extra) => ({ jobDir, frames: 441000, sampleRate: 44100, onProgress: () => {}, ...extra });

describe("command and environment", () => {
	test("an argument array, no shell, an isolated python, absolute paths, our own process group", async () => {
		const fake = fakeSpawn({ script: ({ stdout, exit }) => (stdout('{"done": true}\n'), exit(0)) });
		const priorities = [];
		const run = createEngineRunner(base({ spawn: fake.spawn, setPriority: (pid, nice) => priorities.push([pid, nice]) }));
		expect(await run(request({ sampleRate: 48000, frames: 480000 }))).toEqual({ ok: true });
		const { binary, args, options } = fake.spawned[0];
		expect(binary).toBe(path.join(userData, "stems", "engine", "venv", "bin", "python"));
		expect(args).toEqual(["-I", "/app/stems_demucs_driver.py", "--rate", "48000", "--channels", "2", "--frames", "480000", "--input", path.join(jobDir, "input.pcm"), "--out", jobDir, "--checkpoint", CHECKPOINT]);
		expect(options.shell).toBe(false);
		expect(options.detached).toBe(true);
		expect(options.cwd).toBe(jobDir);
		expect(priorities).toEqual([[4242, 10]]);
	});

	test("without a verified checkpoint file there is no run at all", async () => {
		for (const checkpointPath of [async () => null, async () => "relative/model.th", async () => 5]) {
			const fake = fakeSpawn({});
			expect(await createEngineRunner(base({ spawn: fake.spawn, checkpointPath }))(request())).toEqual({ ok: false, code: "engine-failed" });
			expect(fake.spawned).toEqual([]);
		}
	});

	test("the environment is built from nothing: a minimal PATH, TORCH_HOME, OMP_NUM_THREADS, HOME inside the job; no proxy, no PYTHON*, no app variables", async () => {
		process.env.CCUT_STEMS_TEST_SECRET = "leak";
		process.env.PYTHONNOHTTPSVERIFY = "1";
		try {
			const fake = fakeSpawn({ script: ({ exit, stdout }) => (stdout('{"done":true}'), exit(0)) });
			await createEngineRunner(base({ spawn: fake.spawn }))(request());
			expect(fake.spawned[0].options.env).toEqual({
				PATH: "/usr/bin:/bin",
				HOME: path.join(jobDir, "home"),
				XDG_CONFIG_HOME: path.join(jobDir, "home", ".config"),
				XDG_CACHE_HOME: path.join(jobDir, "home", ".cache"),
				XDG_DATA_HOME: path.join(jobDir, "home", ".local", "share"),
				XDG_STATE_HOME: path.join(jobDir, "home", ".local", "state"),
				TMPDIR: path.join(jobDir, "tmp"),
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				PYTHONIOENCODING: "utf-8",
				PYTHONUTF8: "1",
				TORCH_HOME: path.join(userData, "stems", "torch"),
				OMP_NUM_THREADS: "10",
				...OFFLINE_ENV,
			});
			// every proxy variable points at a closed port, NO_PROXY is not set: no download can succeed
			expect(Object.keys(OFFLINE_ENV).sort()).toEqual(["ALL_PROXY", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_OFFLINE", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "http_proxy", "https_proxy"]);
			expect(OFFLINE_ENV.HF_HUB_OFFLINE).toBe("1");
			expect(OFFLINE_ENV.HF_HUB_DISABLE_TELEMETRY).toBe("1");
			for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(OFFLINE_ENV[name]).toBe("http://127.0.0.1:9");
			expect(fake.spawned[0].options.env.NO_PROXY).toBeUndefined();
			expect((await fsp.stat(path.join(jobDir, "home"))).isDirectory()).toBe(true);
			expect((await fsp.stat(path.join(jobDir, "tmp"))).isDirectory()).toBe(true);
		} finally {
			delete process.env.CCUT_STEMS_TEST_SECRET;
			delete process.env.PYTHONNOHTTPSVERIFY;
		}
	});

	test("threads: cores - 2, at least 1, at most 10; the limit is 3 x the audio, never under 10 minutes", () => {
		expect([1, 2, 3, 4, 12, 64].map(threadsFor)).toEqual([1, 1, 1, 2, 10, 10]);
		expect(engineTimeoutMs({ frames: 60 * 44100, sampleRate: 44100 })).toBe(10 * 60 * 1000);
		expect(engineTimeoutMs({ frames: 20 * 60 * 48000, sampleRate: 48000 })).toBe(60 * 60 * 1000);
		expect(engineTimeoutMs({ frames: 15 * 60 * 96000, sampleRate: 96000 })).toBe(45 * 60 * 1000);
	});

	test("the driver is looked up outside the asar archive in a packaged app", () => {
		expect(resolveDriverPath({ dir: "/opt/Ccut/resources/app.asar" })).toBe("/opt/Ccut/resources/app.asar.unpacked/stems_demucs_driver.py");
		expect(resolveDriverPath({ dir: "/src/apps/electron" })).toBe("/src/apps/electron/stems_demucs_driver.py");
		expect(stemsPaths({ userData: "/u" }).venvPython).toBe("/u/stems/engine/venv/bin/python");
	});

	test("a failing setPriority does not stop the run", async () => {
		const fake = fakeSpawn({ script: ({ stdout, exit }) => (stdout('{"done":true}\n'), exit(0)) });
		const logs = [];
		const run = createEngineRunner(base({ spawn: fake.spawn, log: (line) => logs.push(line), setPriority: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); } }));
		expect(await run(request())).toEqual({ ok: true });
		expect(logs.join("\n")).toContain("EPERM");
	});
});

describe("stdout parsing", () => {
	test("parseEngineLine: progress is clamped to 0..1, done needs true, everything else is null", () => {
		expect(parseEngineLine('{"progress": 0.25}')).toEqual({ progress: 0.25 });
		expect(parseEngineLine('{"progress": 7}')).toEqual({ progress: 1 });
		expect(parseEngineLine('{"progress": -1}')).toEqual({ progress: 0 });
		expect(parseEngineLine('{"done": true}')).toEqual({ done: true });
		for (const junk of ['{"done": 1}', '{"done": "true"}', '{"progress": "0.5"}', '{"progress": null}', "[0.5]", "0.5", "null", "Traceback (most recent call last):", "{broken", '{"other": 1}', "/home/x/secret"]) {
			expect(parseEngineLine(junk)).toBeNull();
		}
	});

	test("progress reaches onProgress in order; garbage and an over-long line are ignored; done ends it", async () => {
		const heard = [];
		const fake = fakeSpawn({
			script: ({ stdout, exit }) => {
				stdout('{"progress": 0.1}\nloading model...\n{"progress": 0.5}\n{"progress": "x"}\n');
				stdout(`{"progress": 0.9, "pad": "${"x".repeat(MAX_LINE_CHARS)}"}\n`);
				stdout('{"progress": 0.75}\n{"done": true}\n');
				exit(0);
			},
		});
		const result = await createEngineRunner(base({ spawn: fake.spawn }))(request({ onProgress: (value) => heard.push(value) }));
		expect(result).toEqual({ ok: true });
		expect(heard).toEqual([0.1, 0.5, 0.75]);
	});
});

describe("ending", () => {
	const run = async ({ script, limits, signal, log }) => {
		const fake = fakeSpawn({ script });
		const result = await createEngineRunner(base({ spawn: fake.spawn, kill: fake.kill, limits, log }))(request({ signal }));
		return { result, fake };
	};

	test("exit 0 without a done line is invalid-output; a non-zero exit, a signal, or no spawn at all is engine-failed", async () => {
		expect((await run({ script: ({ stdout, exit }) => (stdout('{"progress": 1}\n'), exit(0)) })).result).toEqual({ ok: false, code: "invalid-output" });
		expect((await run({ script: ({ stdout, exit }) => (stdout('{"done": true}\n'), exit(1)) })).result).toEqual({ ok: false, code: "engine-failed" });
		expect((await run({ script: ({ exit }) => exit(null, "SIGSEGV") })).result).toEqual({ ok: false, code: "engine-failed" });
		const fake = fakeSpawn({ failSpawn: true });
		expect(await createEngineRunner(base({ spawn: fake.spawn }))(request())).toEqual({ ok: false, code: "engine-failed" });
	});

	test("stderr is only logged, capped to its last 4 KiB, and never part of the answer", async () => {
		const logs = [];
		const { result } = await run({
			log: (line) => logs.push(line),
			script: ({ stderr, exit }) => {
				for (let i = 0; i < 100; i++) stderr(`${"e".repeat(200)} line ${i}\n`);
				exit(1);
			},
		});
		expect(result).toEqual({ ok: false, code: "engine-failed" });
		const text = logs.join("\n");
		expect(text).toContain("line 99");
		expect(text).not.toContain("line 10 ");
		expect(text.length).toBeLessThan(6000);
	});

	test("a run past its time limit is killed as a process group and ends as timeout", async () => {
		const { result, fake } = await run({ limits: { wallMs: 30, killGraceMs: 10 }, script: () => {} });
		expect(result).toEqual({ ok: false, code: "timeout" });
		expect(fake.kills[0]).toEqual({ target: -4242, signal: "SIGTERM" });
	});

	test("an abort signal cancels the run (the whole process group); an already aborted one never spawns", async () => {
		const controller = new AbortController();
		const { result, fake } = await run({ signal: controller.signal, script: () => queueMicrotask(() => controller.abort("cancelled")) });
		expect(result).toEqual({ ok: false, code: "cancelled" });
		expect(fake.kills[0]).toEqual({ target: -4242, signal: "SIGTERM" });

		const gone = fakeSpawn({});
		const aborted = new AbortController();
		aborted.abort("cancelled");
		expect(await createEngineRunner(base({ spawn: gone.spawn }))(request({ signal: aborted.signal }))).toEqual({ ok: false, code: "cancelled" });
		expect(gone.spawned).toEqual([]);
	});

	describe("memory watchdog", () => {
		const GiB = 1024 ** 3;
		const watched = async ({ rss, total = 32 * GiB, platform = "linux", reads }) => {
			const fake = fakeSpawn({ script: () => {} });
			const logs = [];
			const run = createEngineRunner(base({
				spawn: fake.spawn,
				kill: fake.kill,
				platform,
				log: (line) => logs.push(line),
				totalMemory: () => total,
				readRss: async (pid) => {
					reads?.push(pid);
					return typeof rss === "function" ? rss() : rss;
				},
				limits: { memoryPollMs: 5, wallMs: 120, killGraceMs: 10 },
			}));
			return { result: await run(request()), fake, logs };
		};

		test("the limit is the smaller of 6 GiB and 60% of the machine's memory", () => {
			expect(memoryLimitBytes({ total: 32 * GiB })).toBe(6 * GiB);
			expect(memoryLimitBytes({ total: 8 * GiB })).toBe(Math.floor(4.8 * GiB));
			expect(memoryLimitBytes({ total: 4 * GiB })).toBe(Math.floor(2.4 * GiB));
		});

		test("an engine over the limit is ended as a process group and the job gets out-of-memory", async () => {
			const reads = [];
			const { result, fake, logs } = await watched({ rss: 7 * GiB, reads });
			expect(result).toEqual({ ok: false, code: "out-of-memory" });
			expect(reads[0]).toBe(4242);
			expect(fake.kills[0]).toEqual({ target: -4242, signal: "SIGTERM" });
			expect(logs.join("\n")).toContain("ending it");
		});

		test("a small machine lowers the limit (60% of 4 GiB = 2.4 GiB)", async () => {
			expect((await watched({ rss: 3 * GiB, total: 4 * GiB })).result).toEqual({ ok: false, code: "out-of-memory" });
		});

		test("under the limit, an unreadable /proc, or a reader that throws: nothing is killed (the wall clock ends this fake run)", async () => {
			for (const rss of [1 * GiB, null, () => { throw new Error("EACCES"); }]) {
				const { result } = await watched({ rss });
				expect(result).toEqual({ ok: false, code: "timeout" });
			}
		});

		test("not on Linux: no polling at all", async () => {
			const reads = [];
			const { result } = await watched({ rss: 99 * GiB, platform: "darwin", reads });
			expect(result).toEqual({ ok: false, code: "timeout" });
			expect(reads).toEqual([]);
		});
	});

	test("on quit (abort reason 'quit') the group gets SIGKILL at once", async () => {
		const controller = new AbortController();
		const { fake } = await run({ signal: controller.signal, script: () => queueMicrotask(() => controller.abort("quit")) });
		expect(fake.kills[0]).toEqual({ target: -4242, signal: "SIGKILL" });
	});
});
