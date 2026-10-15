const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildYtDlpArgs } = require("../link-import-args");
const { LIMITS, LinkImportError, LinkImportJobs, OUTPUT_TYPES, containerMatches } = require("../link-import-jobs");
const { muxWorkerPath, resolveMediabunnyPath, runMuxWorker } = require("../link-import-mux");
const { ToolError } = require("../link-import-tool");
const { FAKE_MEDIA_BYTES, fakeMediaBytes } = require("./fixtures/fake-media");

// The job manager with the REAL spawn path: the fake yt-dlp (fixtures/fake-yt-dlp.js, no
// network) runs as a child process in a private job directory. One job at a time, owned by
// one webContents, read back in capped chunks, cleaned on success, failure, cancel and quit.

const FAKE = path.join(__dirname, "fixtures", "fake-yt-dlp.js");
const OWNER = 7;
const OTHER = 8;
// A YouTube link in Video mode takes the pair path (two streams, muxed); a TikTok link (and Audio
// only) the single-file path. The fake reads its scenario from the v= parameter in both.
const yt = (scenario) => `https://www.youtube.com/watch?v=${scenario}`;
const tt = (scenario) => `https://www.tiktok.com/@someone/video/7234567890123456789?v=${scenario}`;

let root;
let jobs;
let logs;
beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-link-jobs-"));
	logs = [];
});
afterEach(async () => {
	jobs?.shutdownSync();
	jobs = null;
	await fsp.rm(root, { recursive: true, force: true });
});

function create(overrides = {}) {
	jobs = new LinkImportJobs({
		root,
		spawn: childProcess.spawn,
		platform: process.platform,
		parentEnv: { PATH: process.env.PATH, HTTPS_PROXY: "http://proxy.invalid:3128", PYTHONPATH: "/evil" },
		resolveTool: async () => ({ binary: FAKE, version: "2025.09.26", source: "test" }),
		log: (line) => logs.push(line),
		// the repository's package (the packaged app passes the vendored bundle, link-import-ipc.js)
		mediabunnyPath: resolveMediabunnyPath({ workerDir: path.dirname(muxWorkerPath()), packaged: false }),
		...overrides,
		limits: { killGraceMs: 300, ...overrides.limits },
	});
	return jobs;
}

// Bounded polling: at most `rounds` x 20 ms.
async function waitFor({ token, owner = OWNER, states, rounds = 200 }) {
	let status;
	for (let round = 0; round < rounds; round++) {
		status = jobs.status({ ownerId: owner, token });
		if (states.includes(status.state)) return status;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${states.join("/")}; last ${JSON.stringify(status)}`);
}

async function codeOf(fn) {
	try {
		await fn();
	} catch (error) {
		return error instanceof LinkImportError ? error.code : `other: ${error && error.message}`;
	}
	return "resolved";
}

const jobsDir = () => path.join(root, "jobs");
const jobDirs = () => (fs.existsSync(jobsDir()) ? fs.readdirSync(jobsDir()) : []);

async function readAll({ token, chunk = 64 * 1024 }) {
	const status = jobs.status({ ownerId: OWNER, token });
	const parts = [];
	let offset = 0;
	for (let round = 0; offset < status.file.size && round < 1000; round++) {
		const bytes = await jobs.read({ ownerId: OWNER, token, offset, length: chunk });
		expect(bytes).toBeInstanceOf(Uint8Array);
		expect(bytes.byteLength).toBeLessThanOrEqual(chunk);
		expect(bytes.buffer.byteLength).toBe(bytes.byteLength); // no hidden extra bytes cross the IPC
		parts.push(Buffer.from(bytes));
		offset += bytes.byteLength;
	}
	return Buffer.concat(parts);
}

describe("a successful video import (single file: TikTok)", () => {
	test("start -> ready; the file is described (size, type from the allow-list, sanitized title, size) without any path", async () => {
		create();
		const started = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "best" });
		expect(started.ok).toBe(true);
		expect(started.token).toMatch(/^[0-9a-f]{64}$/);
		const status = await waitFor({ token: started.token, states: ["ready", "failed"] });
		expect(status).toEqual({
			state: "ready",
			phase: null,
			progress: { downloadedBytes: FAKE_MEDIA_BYTES, totalBytes: FAKE_MEDIA_BYTES, speed: 123456.789, eta: 0 },
			file: {
				size: FAKE_MEDIA_BYTES,
				ext: "mp4",
				mime: "video/mp4",
				title: 'Fake ok: "quotes" <tags> & a/slash second line',
				width: 640,
				height: 360,
				duration: 6,
				vcodec: "avc1.42001E",
				combined: false,
				combineTried: false,
			},
			fraction: null,
			code: null,
		});
		expect(JSON.stringify(status)).not.toContain(root);
	});

	test("chunked reads give back exactly the downloaded bytes; then release deletes the job directory", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "720" });
		await waitFor({ token, states: ["ready"] });
		expect(jobDirs()).toHaveLength(1);
		const bytes = await readAll({ token });
		expect(bytes.equals(fakeMediaBytes())).toBe(true);
		expect(await jobs.release({ ownerId: OWNER, token })).toBe(true);
		expect(jobDirs()).toEqual([]);
		expect(await codeOf(() => jobs.read({ ownerId: OWNER, token, offset: 0, length: 10 }))).toBe("UNKNOWN_JOB");
		expect(jobs.isBusy()).toBe(false);
	});

	test("audio only: an m4a with an audio MIME type", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "audio", quality: "best" });
		const status = await waitFor({ token, states: ["ready", "failed"] });
		expect(status.file).toMatchObject({ ext: "m4a", mime: "audio/mp4", width: null, height: null });
	});

	test("the process gets exactly the builder's arguments (URL last, after --): the pair for YouTube, the single file for TikTok", async () => {
		create({ randomHex: sequenceHex() });
		const first = await jobs.start({ ownerId: OWNER, url: yt("args"), mode: "video", quality: "1080" });
		await waitFor({ token: first.token, states: ["ready", "failed"] });
		const seenPair = JSON.parse(fs.readFileSync(path.join(jobsDir(), jobDirs()[0], "args.json"), "utf8"));
		expect(seenPair).toEqual(buildYtDlpArgs({ url: yt("args"), mode: "video", quality: "1080", nonce: "02".repeat(16), strategy: "pair" }));
		await jobs.release({ ownerId: OWNER, token: first.token });
		const second = await jobs.start({ ownerId: OWNER, url: tt("args"), mode: "video", quality: "1080" });
		await waitFor({ token: second.token, states: ["ready", "failed"] });
		const seenSingle = JSON.parse(fs.readFileSync(path.join(jobsDir(), jobDirs()[0], "args.json"), "utf8"));
		expect(seenSingle).toEqual(buildYtDlpArgs({ url: tt("args"), mode: "video", quality: "1080", nonce: "05".repeat(16) }));
	});

	test("the job directory is private (0700) and the process sees only the scrubbed environment pointing into it", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("env"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["ready", "failed"] });
		const [dirName] = jobDirs();
		const jobDir = path.join(jobsDir(), dirName);
		expect(dirName).toMatch(/^[0-9a-f]{32}$/);
		expect(fs.statSync(jobDir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(jobsDir()).mode & 0o777).toBe(0o700);
		const env = JSON.parse(fs.readFileSync(path.join(jobDir, "env.json"), "utf8"));
		expect(env.HOME).toBe(path.join(jobDir, "home"));
		expect(env.TMPDIR).toBe(path.join(jobDir, "tmp"));
		expect(env.HTTPS_PROXY).toBeUndefined();
		expect(env.PYTHONPATH).toBeUndefined();
	});
});

// Deterministic randomHex: call n returns byte n repeated (the job dir is call 1, the nonce call 2, ...).
function sequenceHex() {
	let n = 0;
	return (bytes) => {
		n++;
		return n.toString(16).padStart(2, "0").repeat(bytes);
	};
}

describe("read: only the owner, only inside the file, only capped chunks", () => {
	test("beyond EOF, negative, fractional or huge offsets/lengths, another owner's or an unknown token: refused", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["ready"] });
		const read = (request) => codeOf(() => jobs.read({ ownerId: OWNER, token, ...request }));
		expect(await read({ offset: FAKE_MEDIA_BYTES, length: 1 })).toBe("INVALID");
		expect(await read({ offset: FAKE_MEDIA_BYTES + 10, length: 1 })).toBe("INVALID");
		expect(await read({ offset: -1, length: 1 })).toBe("INVALID");
		expect(await read({ offset: 1.5, length: 1 })).toBe("INVALID");
		expect(await read({ offset: 0, length: 0 })).toBe("INVALID");
		expect(await read({ offset: 0, length: LIMITS.maxReadBytes + 1 })).toBe("INVALID");
		expect(await read({ offset: 0, length: Number.MAX_SAFE_INTEGER })).toBe("INVALID");
		expect(await read({ offset: "0", length: 1 })).toBe("INVALID");
		expect(await codeOf(() => jobs.read({ ownerId: OTHER, token, offset: 0, length: 1 }))).toBe("UNKNOWN_JOB");
		expect(await codeOf(() => jobs.read({ ownerId: OWNER, token: "f".repeat(64), offset: 0, length: 1 }))).toBe("UNKNOWN_JOB");
		expect(await codeOf(() => jobs.read({ ownerId: OWNER, token: 5, offset: 0, length: 1 }))).toBe("UNKNOWN_JOB");
		// The last bytes: a read that starts inside the file is clipped to its end.
		const tail = await jobs.read({ ownerId: OWNER, token, offset: FAKE_MEDIA_BYTES - 3, length: 100 });
		expect(Buffer.from(tail).equals(fakeMediaBytes().subarray(FAKE_MEDIA_BYTES - 3))).toBe(true);
	});

	test("one read at a time per job: a second read while one is in flight is BUSY (no pile of 8 MiB buffers in main)", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["ready"] });
		const reads = Array.from({ length: 5 }, () => jobs.read({ ownerId: OWNER, token, offset: 0, length: 1000 }).then(() => "ok", (error) => error.code));
		const results = await Promise.all(reads);
		expect(results[0]).toBe("ok");
		expect(results.slice(1)).toEqual(["BUSY", "BUSY", "BUSY", "BUSY"]);
		// Afterwards the next read works again.
		expect((await jobs.read({ ownerId: OWNER, token, offset: 0, length: 10 })).byteLength).toBe(10);
	});

	test("status, cancel and release of another owner's job are refused like an unknown job", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "best" });
		expect(await codeOf(() => jobs.status({ ownerId: OTHER, token }))).toBe("UNKNOWN_JOB");
		expect(await codeOf(() => jobs.cancel({ ownerId: OTHER, token }))).toBe("UNKNOWN_JOB");
		expect(await codeOf(() => jobs.release({ ownerId: OTHER, token }))).toBe("UNKNOWN_JOB");
		await waitFor({ token, states: ["ready"] });
	});

	test("reading before the file is ready is refused", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("slow"), mode: "video", quality: "best" });
		expect(await codeOf(() => jobs.read({ ownerId: OWNER, token, offset: 0, length: 1 }))).toBe("NOT_READY");
		await jobs.cancel({ ownerId: OWNER, token });
	});

	test("the file is replaced after the check (same size, another inode), or by a symlink: READ_FAILED", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["ready"] });
		const file = path.join(jobsDir(), jobDirs()[0], "out", "media.mp4");
		// The new file exists before the old one goes, so it cannot get the old inode number.
		fs.writeFileSync(`${file}.new`, fakeMediaBytes());
		fs.renameSync(`${file}.new`, file);
		expect(await codeOf(() => jobs.read({ ownerId: OWNER, token, offset: 0, length: 10 }))).toBe("READ_FAILED");
		const elsewhere = path.join(root, "elsewhere.bin");
		fs.writeFileSync(elsewhere, fakeMediaBytes());
		fs.rmSync(file);
		fs.symlinkSync(elsewhere, file);
		expect(await codeOf(() => jobs.read({ ownerId: OWNER, token, offset: 0, length: 10 }))).toBe("READ_FAILED");
	});
});

describe("one job at a time", () => {
	test("no job starts while an update of the managed yt-dlp installs", async () => {
		let updating = true;
		create({ isUpdating: () => updating });
		expect(await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" })).toEqual({ ok: false, code: "busy" });
		expect(jobDirs()).toEqual([]);
		updating = false;
		expect((await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" })).ok).toBe(true);
	});

	test("a second start while one runs is busy; after it ended a new one may start", async () => {
		create();
		const first = await jobs.start({ ownerId: OWNER, url: yt("slow"), mode: "video", quality: "best" });
		expect(await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" })).toEqual({ ok: false, code: "busy" });
		expect(await jobs.start({ ownerId: OTHER, url: yt("ok"), mode: "video", quality: "best" })).toEqual({ ok: false, code: "busy" });
		expect(await jobs.cancel({ ownerId: OWNER, token: first.token })).toBe(true);
		await waitFor({ token: first.token, states: ["cancelled"] });
		const second = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		expect(second.ok).toBe(true);
		await waitFor({ token: second.token, states: ["ready"] });
	});

	test("a ready file that is never released blocks new jobs only until it expires", async () => {
		let clock = 1_000_000;
		create({ now: () => clock });
		const { token } = await jobs.start({ ownerId: OWNER, url: tt("ok"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["ready"] });
		expect((await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" })).code).toBe("busy");
		clock += LIMITS.readyTtlMs + 1;
		await jobs.expire();
		expect(jobDirs()).toEqual([]);
		expect((await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" })).ok).toBe(true);
	});

	test("refused input never creates a job or a directory", async () => {
		create();
		expect(await jobs.start({ ownerId: OWNER, url: "https://evil.example/x", mode: "video", quality: "best" })).toEqual({ ok: false, code: "url-refused" });
		expect(await jobs.start({ ownerId: OWNER, url: "https://www.youtube.com/playlist?list=PL1", mode: "video", quality: "best" })).toEqual({ ok: false, code: "playlist-refused" });
		expect(await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "both", quality: "best" })).toEqual({ ok: false, code: "invalid" });
		expect(await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "4k" })).toEqual({ ok: false, code: "invalid" });
		expect(jobDirs()).toEqual([]);
		expect(jobs.isBusy()).toBe(false);
	});
});

describe("stopping: cancel, timeouts, window closed, quit", () => {
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

	async function startChild() {
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("child"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["downloading"] });
		let pids = null;
		for (let round = 0; round < 200 && !pids; round++) {
			const file = path.join(jobsDir(), jobDirs()[0] ?? "none", "pids.json");
			if (fs.existsSync(file)) pids = JSON.parse(fs.readFileSync(file, "utf8"));
			else await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(isAlive(pids.child)).toBe(true);
		expect(isAlive(pids.grandchild)).toBe(true);
		return { token, pids };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

	test("cancel: the process tree ends, the job directory is gone, the state is cancelled", async () => {
		create();
		const { token, pids } = await startChild();
		expect(await jobs.cancel({ ownerId: OWNER, token })).toBe(true);
		expect((await waitFor({ token, states: ["cancelled", "failed"] })).state).toBe("cancelled");
		await settle();
		expect(isAlive(pids.child)).toBe(false);
		expect(isAlive(pids.grandchild)).toBe(false);
		expect(jobDirs()).toEqual([]);
	});

	test("the window closes or reloads (abortOwner): same; another owner's job is untouched", async () => {
		create();
		const { token, pids } = await startChild();
		await jobs.abortOwner(OTHER);
		expect(jobs.status({ ownerId: OWNER, token }).state).toBe("downloading");
		await jobs.abortOwner(OWNER);
		await settle();
		expect(isAlive(pids.child)).toBe(false);
		expect(isAlive(pids.grandchild)).toBe(false);
		expect(jobDirs()).toEqual([]);
		expect(jobs.isBusy()).toBe(false);
	});

	test("app quit (shutdownSync): killed and deleted synchronously", async () => {
		create();
		const { pids } = await startChild();
		jobs.shutdownSync();
		expect(jobDirs()).toEqual([]);
		await settle();
		expect(isAlive(pids.child)).toBe(false);
		expect(isAlive(pids.grandchild)).toBe(false);
	});

	test("wall-clock timeout: failed with code timeout, process gone, directory gone", async () => {
		create({ limits: { wallMs: 400 } });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("slow"), mode: "video", quality: "best" });
		expect(await waitFor({ token, states: ["failed", "cancelled", "ready"] })).toMatchObject({ state: "failed", code: "timeout" });
		expect(jobDirs()).toEqual([]);
	});

	test("inactivity timeout: a silent process is ended the same way", async () => {
		create({ limits: { idleMs: 400 } });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("hang"), mode: "video", quality: "best" });
		expect(await waitFor({ token, states: ["failed", "cancelled", "ready"] })).toMatchObject({ state: "failed", code: "timeout" });
	});

	test("cancel while the tool is still being prepared (consent dialog, download): the resolver's signal is aborted", async () => {
		let seenSignal = null;
		let reached;
		const resolverReached = new Promise((resolve) => (reached = resolve));
		create({
			resolveTool: ({ signal }) =>
				new Promise((resolve, reject) => {
					seenSignal = signal;
					signal.addEventListener("abort", () => reject(new ToolError("consent-declined")));
					reached();
				}),
		});
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		await resolverReached;
		expect(jobs.status({ ownerId: OWNER, token }).state).toBe("preparing");
		await jobs.cancel({ ownerId: OWNER, token });
		expect((await waitFor({ token, states: ["cancelled", "failed"] })).state).toBe("cancelled");
		expect(seenSignal.aborted).toBe(true);
		expect(jobDirs()).toEqual([]);
	});

	test("the download grows past the size cap (seen in the progress line): stopped as too-large", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("huge"), mode: "video", quality: "best" });
		expect(await waitFor({ token, states: ["failed", "cancelled", "ready"] })).toMatchObject({ state: "failed", code: "too-large" });
		expect(jobDirs()).toEqual([]);
	});
});

describe("failures become codes; the job directory is always removed", () => {
	const cases = [
		["private", "private"],
		["geo", "geo-blocked"],
		["429", "rate-limited"],
		["unsupported", "unsupported"],
		["format", "no-compatible-format"],
		["network", "network"],
		["big", "too-large"],
		["two", "bad-output"],
		["symlink", "bad-output"],
		["badext", "bad-output"],
		["mismatch", "bad-output"],
		["empty", "bad-output"],
		["noresult", "bad-output"],
		["notmedia", "bad-output"],
	];
	for (const [scenario, code] of cases) {
		test(`${scenario} -> ${code} (single file)`, async () => {
			create();
			const { token } = await jobs.start({ ownerId: OWNER, url: tt(scenario), mode: "video", quality: "best" });
			const status = await waitFor({ token, states: ["failed", "ready", "cancelled"] });
			expect(status).toMatchObject({ state: "failed", code, file: null });
			expect(jobDirs()).toEqual([]);
			expect(jobs.isBusy()).toBe(false);
		});
	}

	test("yt-dlp's raw text goes to the log (truncated), never into the status", async () => {
		create();
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("private"), mode: "video", quality: "best" });
		const status = await waitFor({ token, states: ["failed"] });
		expect(JSON.stringify(status)).not.toContain("Sign in");
		expect(logs.some((line) => line.includes("Private video"))).toBe(true);
		expect(logs.every((line) => line.length <= 4000)).toBe(true);
	});

	test("tool problems: the resolver's code is the job's code; anything else is unknown", async () => {
		for (const [error, code] of [
			[new ToolError("consent-declined"), "consent-declined"],
			[new ToolError("tool-verify-failed"), "tool-verify-failed"],
			[new Error("boom /home/owner/secret"), "unknown"],
		]) {
			create({ resolveTool: async () => Promise.reject(error) });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
			const status = await waitFor({ token, states: ["failed"] });
			expect(status.code).toBe(code);
			expect(JSON.stringify(status)).not.toContain("secret");
			jobs.shutdownSync();
		}
	});

	test("a binary that cannot be started: tool-missing", async () => {
		create({ resolveTool: async () => ({ binary: path.join(root, "nope", "yt-dlp"), version: "2025.09.26", source: "test" }) });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		expect((await waitFor({ token, states: ["failed"] })).code).toBe("tool-missing");
	});
});

describe("startup sweep", () => {
	test("leftover job directories from a crash are deleted; other names are left alone", async () => {
		await fsp.mkdir(path.join(jobsDir(), "0123456789abcdef0123456789abcdef", "out"), { recursive: true });
		await fsp.writeFile(path.join(jobsDir(), "0123456789abcdef0123456789abcdef", "out", "media.mp4"), "x");
		await fsp.mkdir(path.join(jobsDir(), "keep-me"));
		create();
		await jobs.sweepLeftovers();
		expect(jobDirs()).toEqual(["keep-me"]);
	});
});

describe("checkOutput: the one-file rule, decided on a fake file system (order and each check controlled)", () => {
	const dirent = (name, kind = "file") => ({ name, isFile: () => kind === "file" });
	const stat = ({ kind = "file", size = 1000 } = {}) => ({ isFile: () => kind === "file", size, dev: 1, ino: 2 });
	const check = ({ entries, lstat = stat(), ext = "mp4", mode = "video", limits }) => {
		const fakeFs = { readdir: async () => entries, lstat: async () => lstat };
		const manager = new LinkImportJobs({ root: "/data", spawn: () => null, fsApi: fakeFs, pathApi: path.posix, resolveTool: async () => null, limits });
		return manager.checkOutput({ job: { dir: "/data/jobs/x" }, mode, ext });
	};

	test("exactly one regular file named media.<ext>: accepted with the allow-list's MIME type", async () => {
		expect(await check({ entries: [dirent("media.mp4")] })).toEqual({ file: { path: "/data/jobs/x/out/media.mp4", size: 1000, ext: "mp4", mime: "video/mp4", dev: 1, ino: 2 } });
		expect((await check({ entries: [dirent("media.webm")], ext: "webm", mode: "audio" })).file.mime).toBe("audio/webm");
	});

	test("a second file, whichever comes first: bad-output", async () => {
		expect(await check({ entries: [dirent("media.mp4"), dirent("media.webm")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.webm"), dirent("media.mp4")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.mp4"), dirent("media.mp4.part")] })).toEqual({ code: "bad-output" });
	});

	test("the entry is a link or a directory (the Dirent says so), or lstat says so (it changed after readdir): bad-output", async () => {
		expect(await check({ entries: [dirent("media.mp4", "symlink")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.mp4", "dir")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.mp4")], lstat: stat({ kind: "symlink" }) })).toEqual({ code: "bad-output" });
	});

	test("empty: bad-output; above the size cap (even if no progress line showed it): too-large", async () => {
		expect(await check({ entries: [dirent("media.mp4")], lstat: stat({ size: 0 }) })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.mp4")], lstat: stat({ size: 1024 ** 2 + 1 }), limits: { maxFilesizeBytes: 1024 ** 2 } })).toEqual({ code: "too-large" });
	});

	test("an extension off the mode's list, or a name that does not match the result's ext: bad-output", async () => {
		expect(await check({ entries: [dirent("media.exe")], ext: "exe" })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.m4a")], ext: "m4a", mode: "video" })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.mp4")], ext: "webm" })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("other.mp4")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("media.mp4")], ext: "constructor" })).toEqual({ code: "bad-output" });
	});
});

describe("containerMatches: the file starts like the container its extension names", () => {
	const head = (...bytes) => Buffer.from(bytes);
	const ascii = (text) => [...Buffer.from(text, "latin1")];
	test("MP4/M4A ftyp box, WebM EBML, Ogg, MP3 (ID3 or a frame sync)", () => {
		expect(containerMatches({ ext: "mp4", head: head(0, 0, 0, 24, ...ascii("ftypisom")) })).toBe(true);
		expect(containerMatches({ ext: "m4a", head: head(0, 0, 0, 32, ...ascii("ftypM4A ")) })).toBe(true);
		expect(containerMatches({ ext: "webm", head: head(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4) })).toBe(true);
		expect(containerMatches({ ext: "ogg", head: head(...ascii("OggS"), 0, 2, 0, 0) })).toBe(true);
		expect(containerMatches({ ext: "opus", head: head(...ascii("OggS"), 0, 2, 0, 0) })).toBe(true);
		expect(containerMatches({ ext: "mp3", head: head(...ascii("ID3"), 4, 0, 0, 0, 0) })).toBe(true);
		expect(containerMatches({ ext: "mp3", head: head(0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0) })).toBe(true);
	});

	test("anything else is refused: HTML, a script, an EXE, a truncated head, a mismatched pair", () => {
		expect(containerMatches({ ext: "mp4", head: head(...ascii("<!DOCTYPE html>")) })).toBe(false);
		expect(containerMatches({ ext: "mp4", head: head(...ascii("#!/bin/sh\nrm -rf")) })).toBe(false);
		expect(containerMatches({ ext: "mp4", head: head(...ascii("MZ\x90\x00\x03\x00\x00\x00")) })).toBe(false);
		expect(containerMatches({ ext: "mp4", head: head(0, 0, 0) })).toBe(false);
		expect(containerMatches({ ext: "webm", head: head(0, 0, 0, 24, ...ascii("ftypisom")) })).toBe(false);
		expect(containerMatches({ ext: "mp3", head: head(0xff, 0x00, 0, 0) })).toBe(false);
		expect(containerMatches({ ext: "exe", head: head(0, 0, 0, 24, ...ascii("ftypisom")) })).toBe(false);
	});
});

describe("output types", () => {
	test("the allow-list and the MIME types the main process derives", () => {
		expect(OUTPUT_TYPES).toEqual({
			video: { mp4: "video/mp4", webm: "video/webm" },
			audio: { m4a: "audio/mp4", webm: "audio/webm", mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg" },
		});
	});
});

describe("YouTube in Video mode: an H.264 video-only stream and an AAC m4a, combined into one MP4", () => {
	const MEDIA = path.join(__dirname, "fixtures", "media");
	const sizeOf = (name) => fs.statSync(path.join(MEDIA, name)).size;
	const posixOnly = process.platform === "win32" ? test.skip : test;

	// Every spawn of the fake with its -f value: the pair's selector has a comma, the single file's not.
	function recordingSpawn() {
		const formats = [];
		return {
			formats,
			kinds: () => formats.map((format) => (format.includes(",") ? "pair" : "single")),
			spawn: (binary, args, options) => {
				formats.push(args[args.indexOf("-f") + 1]);
				return childProcess.spawn(binary, args, options);
			},
		};
	}

	// A mux that reports 40 % and then waits until it is cancelled or terminated.
	function holdingMux() {
		const calls = { started: [], cancelled: 0, terminated: 0 };
		const mux = ({ job, onProgress, limits, mediabunnyPath }) => {
			calls.started.push({ job, limits, mediabunnyPath });
			onProgress(0.4);
			let settle;
			const done = new Promise((resolve) => {
				settle = resolve;
			});
			return {
				done,
				cancel: () => {
					calls.cancelled++;
					settle({ ok: false, reason: "cancelled" });
				},
				terminate: () => {
					calls.terminated++;
					settle({ ok: false, reason: "cancelled" });
				},
			};
		};
		return { calls, mux };
	}

	const fallbackLogged = () => logs.some((line) => line.includes("separate video and audio not used"));

	test("pair -> ready: one MP4 with an H.264 and an AAC track, described as combined, the inputs deleted, ONE yt-dlp run", async () => {
		const recorder = recordingSpawn();
		create({ spawn: recorder.spawn });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "1080" });
		const status = await waitFor({ token, states: ["ready", "failed", "cancelled"] });
		expect(status).toMatchObject({
			state: "ready",
			phase: null,
			fraction: null,
			code: null,
			file: { ext: "mp4", mime: "video/mp4", width: 128, height: 72, vcodec: "avc1.64000b", duration: 1, combined: true, combineTried: true, title: 'Fake ok: "quotes" <tags> & a/slash second line' },
		});
		const both = sizeOf("video-frag.mp4") + sizeOf("audio-frag.m4a");
		expect(status.progress).toMatchObject({ downloadedBytes: both, totalBytes: both });
		expect(recorder.kinds()).toEqual(["pair"]);
		expect(fallbackLogged()).toBe(false);
		const jobDir = path.join(jobsDir(), jobDirs()[0]);
		expect(fs.existsSync(path.join(jobDir, "out"))).toBe(false);
		expect(fs.readdirSync(path.join(jobDir, "final"))).toEqual(["media.mp4"]);
		if (process.platform !== "win32") expect(fs.statSync(path.join(jobDir, "final")).mode & 0o777).toBe(0o700);
		const bytes = await readAll({ token });
		expect(bytes.length).toBe(status.file.size);
		const MB = require("mediabunny");
		const media = new MB.Input({ source: new MB.BufferSource(bytes), formats: [MB.MP4] });
		expect((await media.getTracks()).map((track) => `${track.type}/${track.codec}`)).toEqual(["video/avc", "audio/aac"]);
		media.dispose();
		await jobs.release({ ownerId: OWNER, token });
		expect(jobDirs()).toEqual([]);
	});

	test("while combining: state processing with the mux's fraction and the summed download progress; the mux gets the checked files and the limits", async () => {
		const { calls, mux } = holdingMux();
		create({ mux });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		const status = await waitFor({ token, states: ["processing", "ready", "failed"] });
		const both = sizeOf("video-frag.mp4") + sizeOf("audio-frag.m4a");
		expect(status).toMatchObject({ state: "processing", phase: null, fraction: 0.4, file: null, code: null, progress: { downloadedBytes: both, totalBytes: both } });
		const [{ job, limits, mediabunnyPath }] = calls.started;
		const jobDir = path.join(jobsDir(), jobDirs()[0]);
		expect(job.video).toMatchObject({ path: path.join(jobDir, "out", "137.mp4"), size: sizeOf("video-frag.mp4") });
		expect(job.audio).toMatchObject({ path: path.join(jobDir, "out", "140.m4a"), size: sizeOf("audio-frag.m4a") });
		// device and file id as exact decimal strings (bigint stat), compared again in the worker
		const exact = fs.lstatSync(job.video.path, { bigint: true });
		expect(job.video).toMatchObject({ dev: String(exact.dev), ino: String(exact.ino) });
		expect(mediabunnyPath).toBe(resolveMediabunnyPath({ workerDir: path.dirname(muxWorkerPath()), packaged: false }));
		expect(job.outPath).toBe(path.join(jobDir, "final", "media.mp4"));
		expect(limits).toEqual({ wallMs: LIMITS.muxWallMs, idleMs: LIMITS.muxIdleMs, killGraceMs: LIMITS.muxKillGraceMs, heapMb: LIMITS.muxHeapMb });
		expect(JSON.stringify(status)).not.toContain(root);
		// still one job at a time while combining
		expect(await jobs.start({ ownerId: OTHER, url: tt("ok"), mode: "video", quality: "best" })).toEqual({ ok: false, code: "busy" });
		expect(jobs.isBusy()).toBe(true);
		await jobs.cancel({ ownerId: OWNER, token });
	});

	test("cancel while combining: the mux is cancelled, the state is cancelled, the job directory is gone", async () => {
		const { calls, mux } = holdingMux();
		create({ mux });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		await waitFor({ token, states: ["processing"] });
		expect(await jobs.cancel({ ownerId: OWNER, token })).toBe(true);
		expect((await waitFor({ token, states: ["cancelled", "failed", "ready"] })).state).toBe("cancelled");
		expect(calls.cancelled).toBe(1);
		expect(jobDirs()).toEqual([]);
		expect(jobs.isBusy()).toBe(false);
	});

	test("a cancel that lands just before the mux starts still stops it", async () => {
		const held = holdingMux();
		let token = null;
		create({
			mux: (options) => {
				void jobs.cancel({ ownerId: OWNER, token });
				return held.mux(options);
			},
		});
		({ token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" }));
		expect((await waitFor({ token, states: ["cancelled", "failed", "ready"] })).state).toBe("cancelled");
		expect(held.calls.cancelled).toBe(1);
		expect(jobDirs()).toEqual([]);
	});

	test("the window closes while combining (abortOwner): the mux is cancelled and the directory deleted; app quit terminates it", async () => {
		const first = holdingMux();
		create({ mux: first.mux });
		const started = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		await waitFor({ token: started.token, states: ["processing"] });
		await jobs.abortOwner(OWNER);
		expect(first.calls.cancelled).toBe(1);
		expect(jobDirs()).toEqual([]);
		jobs.shutdownSync();
		const second = holdingMux();
		create({ mux: second.mux });
		const again = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		await waitFor({ token: again.token, states: ["processing"] });
		jobs.shutdownSync();
		expect(second.calls.terminated).toBe(1);
		expect(jobDirs()).toEqual([]);
	});

	describe("fallback: anything but a valid, combinable pair reruns ONCE with today's single-file selector", () => {
		const cases = [
			["pairformat", "yt-dlp: no H.264 video-only or no m4a within the height cap (Requested format is not available)"],
			["noavc", "only the m4a was found (one file, one result line)"],
			["nom4a", "only the video was found"],
			["pairvp9", "the result line says the video is not H.264"],
			["pairnames", "the files do not have the names of the result lines"],
			["pairextra", "a third file in out/"],
			["pairbadmedia", "the video file starts like an MP4 but mediabunny cannot read it (the real mux fails)"],
			["pairbig", "yt-dlp refused one stream as larger than max-filesize (exit 0): a single file is much smaller (360p)"],
			["pair403", "HTTP 403 on the stream (not a final error for the pair): the single file may still work"],
		];
		for (const [scenario, why] of cases) {
			test(`${scenario}: ${why}`, async () => {
				const recorder = recordingSpawn();
				create({ spawn: recorder.spawn });
				const { token } = await jobs.start({ ownerId: OWNER, url: yt(scenario), mode: "video", quality: "1080" });
				const status = await waitFor({ token, states: ["ready", "failed", "cancelled"] });
				expect(status).toMatchObject({ state: "ready", file: { size: FAKE_MEDIA_BYTES, ext: "mp4", combined: false, combineTried: true, width: 640, height: 360 } });
				expect(recorder.kinds()).toEqual(["pair", "single"]);
				expect(fallbackLogged()).toBe(true);
				const jobDir = path.join(jobsDir(), jobDirs()[0]);
				expect(fs.readdirSync(path.join(jobDir, "out"))).toEqual(["media.mp4"]);
				expect(fs.existsSync(path.join(jobDir, "final"))).toBe(false);
				expect((await readAll({ token })).equals(fakeMediaBytes())).toBe(true);
			});
		}

		posixOnly("pairsymlink: one of the two files is a symlink", async () => {
			const recorder = recordingSpawn();
			create({ spawn: recorder.spawn });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("pairsymlink"), mode: "video", quality: "best" });
			expect(await waitFor({ token, states: ["ready", "failed"] })).toMatchObject({ state: "ready", file: { combined: false } });
			expect(recorder.kinds()).toEqual(["pair", "single"]);
		});

		test("the two files together are larger than the cap (seen in the progress lines), or one file is (seen on disk): fallback, the single file fits", async () => {
			for (const scenario of ["pairsum", "pairpadded"]) {
				const recorder = recordingSpawn();
				create({ spawn: recorder.spawn, limits: { maxFilesizeBytes: 1024 ** 2 } });
				const { token } = await jobs.start({ ownerId: OWNER, url: yt(scenario), mode: "video", quality: "best" });
				expect(await waitFor({ token, states: ["ready", "failed"] })).toMatchObject({ state: "ready", file: { combined: false, size: FAKE_MEDIA_BYTES } });
				expect(recorder.kinds()).toEqual(["pair", "single"]);
				expect(logs.some((line) => line.includes("too large"))).toBe(true);
				jobs.shutdownSync();
				logs.length = 0;
			}
		});

		test("too large for the single file too: too-large, after exactly two runs", async () => {
			const recorder = recordingSpawn();
			create({ spawn: recorder.spawn });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("huge"), mode: "video", quality: "best" });
			expect(await waitFor({ token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "too-large" });
			expect(recorder.kinds()).toEqual(["pair", "single"]);
			expect(jobDirs()).toEqual([]);
		});

		test("HTTP 403 on both runs: extractor-failed (the page may offer an update), after exactly two runs", async () => {
			const recorder = recordingSpawn();
			create({ spawn: recorder.spawn });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("403"), mode: "video", quality: "best" });
			expect(await waitFor({ token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "extractor-failed" });
			expect(recorder.kinds()).toEqual(["pair", "single"]);
		});

		test("the same failure with a yt-dlp from PATH is path-tool-stale: Ccut never updates that copy, the page says so", async () => {
			create({ resolveTool: async () => ({ binary: FAKE, version: "2025.09.26", source: "path" }) });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("403"), mode: "video", quality: "best" });
			expect(await waitFor({ token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "path-tool-stale" });
			create({ resolveTool: async () => ({ binary: FAKE, version: "2025.09.26", source: "managed" }) });
			const second = await jobs.start({ ownerId: OWNER, url: yt("403"), mode: "video", quality: "best" });
			expect(await waitFor({ token: second.token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "extractor-failed" });
		});

		test("the mux worker crashes, or reports success but leaves no MP4: fallback too", async () => {
			const crashed = () => ({ done: Promise.resolve({ ok: false, reason: "crashed", detail: "exit 1" }), cancel: () => {}, terminate: () => {} });
			const lying = ({ job }) => {
				fs.writeFileSync(job.outPath, "<!DOCTYPE html>");
				return { done: Promise.resolve({ ok: true, result: { packets: 1, shift: 0, width: 2, height: 2, duration: 1 } }), cancel: () => {}, terminate: () => {} };
			};
			for (const mux of [crashed, lying]) {
				const recorder = recordingSpawn();
				create({ spawn: recorder.spawn, mux });
				const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
				expect(await waitFor({ token, states: ["ready", "failed"] })).toMatchObject({ state: "ready", file: { combined: false, size: FAKE_MEDIA_BYTES } });
				expect(recorder.kinds()).toEqual(["pair", "single"]);
				jobs.shutdownSync();
			}
		});

		posixOnly("pairfinal: something is already at final/ (yt-dlp should never write there): refused before any mux, the link's target untouched", async () => {
			const recorder = recordingSpawn();
			let muxStarted = false;
			create({
				spawn: recorder.spawn,
				mux: (options) => {
					muxStarted = true;
					return runMuxWorker(options);
				},
			});
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("pairfinal"), mode: "video", quality: "best" });
			expect(await waitFor({ token, states: ["ready", "failed"] })).toMatchObject({ state: "ready", file: { combined: false } });
			expect(muxStarted).toBe(false);
			expect(logs.some((line) => line.includes("final directory (EEXIST)"))).toBe(true);
			const jobDir = path.join(jobsDir(), jobDirs()[0]);
			expect(fs.readFileSync(path.join(jobDir, "victim.txt"), "utf8")).toBe("must stay");
		});

		test("the fallback fails too (no single file either): no-compatible-format after exactly two runs", async () => {
			const recorder = recordingSpawn();
			create({ spawn: recorder.spawn });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("format"), mode: "video", quality: "best" });
			expect(await waitFor({ token, states: ["failed", "ready"] })).toMatchObject({ state: "failed", code: "no-compatible-format" });
			expect(recorder.kinds()).toEqual(["pair", "single"]);
			expect(jobDirs()).toEqual([]);
		});
	});

	describe("no retry: errors that a single file would hit too end the job after the pair run", () => {
		const cases = [
			["private", "private"],
			["geo", "geo-blocked"],
			["429", "rate-limited"],
			["network", "network"],
			["unsupported", "unsupported"],
		];
		for (const [scenario, code] of cases) {
			test(`${scenario} -> ${code}`, async () => {
				const recorder = recordingSpawn();
				create({ spawn: recorder.spawn });
				const { token } = await jobs.start({ ownerId: OWNER, url: yt(scenario), mode: "video", quality: "best" });
				expect(await waitFor({ token, states: ["failed", "ready", "cancelled"] })).toMatchObject({ state: "failed", code, file: null });
				expect(recorder.kinds()).toEqual(["pair"]);
				expect(fallbackLogged()).toBe(false);
				expect(jobDirs()).toEqual([]);
			});
		}

		test("timeout and cancel during the pair download: no second run", async () => {
			const timed = recordingSpawn();
			create({ spawn: timed.spawn, limits: { wallMs: 400 } });
			const first = await jobs.start({ ownerId: OWNER, url: yt("slow"), mode: "video", quality: "best" });
			expect(await waitFor({ token: first.token, states: ["failed", "ready", "cancelled"] })).toMatchObject({ state: "failed", code: "timeout" });
			expect(timed.kinds()).toEqual(["pair"]);
			jobs.shutdownSync();
			const cancelled = recordingSpawn();
			create({ spawn: cancelled.spawn });
			const second = await jobs.start({ ownerId: OWNER, url: yt("slow"), mode: "video", quality: "best" });
			await waitFor({ token: second.token, states: ["downloading"] });
			await jobs.cancel({ ownerId: OWNER, token: second.token });
			expect((await waitFor({ token: second.token, states: ["cancelled", "failed", "ready"] })).state).toBe("cancelled");
			expect(cancelled.kinds()).toEqual(["pair"]);
			expect(jobDirs()).toEqual([]);
		});
	});

	test("the size the mux reports is used when it is a plausible size (1..100000 px), else yt-dlp's", async () => {
		const reporting = ({ width, height }) => (options) => {
			const run = runMuxWorker(options);
			return { ...run, done: run.done.then((outcome) => (outcome.ok ? { ...outcome, result: { ...outcome.result, width, height } } : outcome)) };
		};
		for (const [reported, expected] of [
			[{ width: 640, height: 360 }, { width: 640, height: 360 }],
			[{ width: 3.5e13, height: 0 }, { width: 128, height: 72 }],
			[{ width: 100_001, height: 1.5 }, { width: 128, height: 72 }],
		]) {
			create({ mux: reporting(reported) });
			const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
			expect((await waitFor({ token, states: ["ready", "failed"] })).file).toMatchObject({ combined: true, ...expected });
			jobs.shutdownSync();
		}
	});

	describe("unchanged single-file path", () => {
		test("a TikTok link in Video mode, and Audio only on YouTube: one single-file run, nothing combined", async () => {
			for (const [url, mode] of [
				[tt("ok"), "video"],
				[yt("ok"), "audio"],
			]) {
				const recorder = recordingSpawn();
				create({ spawn: recorder.spawn });
				const { token } = await jobs.start({ ownerId: OWNER, url, mode, quality: "best" });
				expect(await waitFor({ token, states: ["ready", "failed"] })).toMatchObject({ state: "ready", file: { combined: false, combineTried: false } });
				expect(recorder.kinds()).toEqual(["single"]);
				jobs.shutdownSync();
			}
		});
	});
});

describe("checkPairOutput: exactly the two files the result lines name", () => {
	const dirent = (name, kind = "file") => ({ name, isFile: () => kind === "file" });
	const stat = ({ kind = "file", size = 1000 } = {}) => ({ isFile: () => kind === "file", size, dev: 1, ino: 2 });
	const pair = { video: { formatId: "137" }, audio: { formatId: "140" } };
	let lastOptions = null;
	const check = ({ entries, lstat = () => stat(), limits }) => {
		const fakeFs = {
			readdir: async () => entries,
			lstat: async (file, options) => {
				lastOptions = options;
				return lstat(file);
			},
		};
		const manager = new LinkImportJobs({ root: "/data", spawn: () => null, fsApi: fakeFs, pathApi: path.posix, resolveTool: async () => null, limits });
		return manager.checkPairOutput({ job: { dir: "/data/jobs/x" }, result: pair });
	};

	test("the two files: described with their paths, sizes and device + file id (exact decimal strings)", async () => {
		expect(await check({ entries: [dirent("140.m4a"), dirent("137.mp4")] })).toEqual({
			files: {
				video: { path: "/data/jobs/x/out/137.mp4", size: 1000, ext: "mp4", dev: "1", ino: "2" },
				audio: { path: "/data/jobs/x/out/140.m4a", size: 1000, ext: "m4a", dev: "1", ino: "2" },
			},
		});
	});

	test("a file id above 2^53 (NTFS ids with a sequence number in the high bits) is passed on exactly, from a bigint stat", async () => {
		const exact = 2n ** 53n + 1n;
		const lstat = (file, options) =>
			options && options.bigint ? { isFile: () => true, size: 1000n, dev: 7n, ino: exact } : { isFile: () => true, size: 1000, dev: 7, ino: Number(exact) };
		const result = await check({ entries: [dirent("137.mp4"), dirent("140.m4a")], lstat: (file) => lstat(file, lastOptions) });
		expect(result.files.video).toMatchObject({ ino: "9007199254740993", dev: "7", size: 1000 });
	});

	test("a missing, extra, renamed or non-regular file: bad-output", async () => {
		expect(await check({ entries: [dirent("137.mp4")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("137.mp4"), dirent("140.m4a"), dirent("x")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("137.mp4"), dirent("140.mp4")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("137.mp4", "symlink"), dirent("140.m4a")] })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("137.mp4"), dirent("140.m4a")], lstat: (file) => stat({ kind: file.endsWith("m4a") ? "dir" : "file" }) })).toEqual({ code: "bad-output" });
		expect(await check({ entries: [dirent("137.mp4"), dirent("140.m4a")], lstat: (file) => stat({ size: file.endsWith("m4a") ? 0 : 5 }) })).toEqual({ code: "bad-output" });
	});

	test("one file above the cap, or both together: too-large", async () => {
		const limits = { maxFilesizeBytes: 1000 };
		expect(await check({ entries: [dirent("137.mp4"), dirent("140.m4a")], limits, lstat: (file) => stat({ size: file.endsWith("mp4") ? 1001 : 1 }) })).toEqual({ code: "too-large" });
		expect(await check({ entries: [dirent("137.mp4"), dirent("140.m4a")], limits, lstat: () => stat({ size: 600 }) })).toEqual({ code: "too-large" });
		expect((await check({ entries: [dirent("137.mp4"), dirent("140.m4a")], limits, lstat: () => stat({ size: 500 }) })).files).toBeDefined();
	});
});

describe("readHead: opened without blocking", () => {
	(process.platform === "win32" ? test.skip : test)("a FIFO where a file was is not waited on", async () => {
		create();
		const fifo = path.join(root, "fifo.mp4");
		expect(childProcess.spawnSync("mkfifo", [fifo]).status).toBe(0);
		const t0 = Date.now();
		try {
			const head = await jobs.readHead(fifo);
			expect(head === null || head.length === 0).toBe(true);
		} finally {
			try {
				fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
			} catch {}
		}
		expect(Date.now() - t0).toBeLessThan(2000);
	});
});

describe("the page's poll budget (apps/web/src/media/link-import/run.ts) uses these limits", () => {
	test("its copy of the main process's limits matches link-import-tool.js and link-import-jobs.js", () => {
		const { LIMITS: TOOL_LIMITS } = require("../link-import-tool");
		const runTs = fs.readFileSync(path.join(__dirname, "..", "..", "web", "src", "media", "link-import", "run.ts"), "utf8");
		const minutes = (name) => Number(new RegExp(`\\b${name}: (\\d+) \\* 60 \\* 1000\\b`).exec(runTs)?.[1]) * 60 * 1000;
		expect(minutes("toolDownload")).toBe(TOOL_LIMITS.downloadTimeoutMs);
		expect(minutes("ytDlpRun")).toBe(LIMITS.wallMs);
		expect(minutes("mux")).toBe(LIMITS.muxWallMs);
	});
});

describe("defaults and precedence", () => {
	test("without a mediabunny path (the default: never a search by package name) a YouTube video is not combined: one file, once", async () => {
		expect(new LinkImportJobs({ root, spawn: childProcess.spawn, resolveTool: async () => null }).mediabunnyPath).toBeNull();
		create({ mediabunnyPath: null });
		const { token } = await jobs.start({ ownerId: OWNER, url: yt("ok"), mode: "video", quality: "best" });
		expect(await waitFor({ token, states: ["ready", "failed"] })).toMatchObject({ state: "ready", file: { combined: false, combineTried: true, size: FAKE_MEDIA_BYTES } });
	});

	test("endedByStop: a cancel wins over a too-large stop that happened at the same time", async () => {
		const removed = [];
		const manager = new LinkImportJobs({ root: "/data", spawn: () => null, resolveTool: async () => null, fsApi: { rm: async (dir) => removed.push(dir) }, pathApi: path.posix });
		const job = { state: "downloading", dir: "/data/jobs/x", cancelRequested: true };
		expect(await manager.endedByStop({ job, outcome: { reason: "too-large" }, tail: [] })).toBe(true);
		expect(job).toMatchObject({ state: "cancelled", code: null });
		const plain = { state: "downloading", dir: "/data/jobs/y", cancelRequested: false };
		expect(await manager.endedByStop({ job: plain, outcome: { reason: "too-large" }, tail: [] })).toBe(true);
		expect(plain).toMatchObject({ state: "failed", code: "too-large" });
		expect(removed).toEqual(["/data/jobs/x", "/data/jobs/y"]);
	});
});
