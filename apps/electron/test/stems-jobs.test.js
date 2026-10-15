const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LIMITS, SAMPLE_RATES, STEMS, StemsJobs, expectedStemSamples, maxFramesFor } = require("../stems-jobs");

// The job manager with a real temporary directory and a fake engine that writes small .f32
// files. The job's own task is awaited directly (jobs.job.task): no polling.

let root;
beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-stems-jobs-"));
});
afterEach(async () => {
	await fsp.rm(root, { recursive: true, force: true });
});

const FRAMES = 1000;
const RATE = 44100;
const SAMPLES = expectedStemSamples({ frames: FRAMES, sampleRate: RATE }); // 500
const OWNER = 3;

function writeStems({ jobDir, samples = SAMPLES, values = () => 0, only = STEMS }) {
	for (const name of only) {
		const data = new Float32Array(samples);
		for (let i = 0; i < samples; i++) data[i] = values({ name, i });
		fs.writeFileSync(path.join(jobDir, `${name}.f32`), Buffer.from(data.buffer));
	}
}

function makeJobs({ runEngine, engineReady, now, limits } = {}) {
	const calls = [];
	const jobs = new StemsJobs({
		root,
		runEngine:
			runEngine ??
			(async (args) => {
				calls.push(args);
				writeStems({ jobDir: args.jobDir });
				return { ok: true };
			}),
		engineReady,
		now,
		limits,
	});
	return { jobs, calls };
}

const pcm = (bytes) => new Uint8Array(bytes).map((_, i) => i % 251);
const jobDirOf = (jobs) => jobs.job.dir;

async function begin(jobs, { frames = FRAMES, sampleRate = RATE } = {}) {
	const answer = await jobs.begin({ ownerId: OWNER, frames, sampleRate });
	expect(answer.ok).toBe(true);
	return answer.token;
}

async function receiveAll(jobs, token, frames = FRAMES) {
	await jobs.write({ ownerId: OWNER, token, position: 0, data: pcm(frames * 4) });
}

async function runToEnd(jobs, token) {
	expect(await jobs.run({ ownerId: OWNER, token })).toEqual({ ok: true });
	await jobs.job.task;
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "resolved";
}

async function readAll({ jobs, token, stem }) {
	const first = await jobs.read({ ownerId: OWNER, token, stem, offset: 0, length: 1 << 20 });
	return Int16Array.from({ length: first.byteLength / 2 }, (_, i) => new DataView(first.buffer, first.byteOffset).getInt16(i * 2, true));
}

describe("begin", () => {
	test("frames and sampleRate are validated; the longest clip is 15 minutes at that rate", async () => {
		const { jobs } = makeJobs();
		for (const bad of [
			{ frames: 0, sampleRate: RATE },
			{ frames: -5, sampleRate: RATE },
			{ frames: 1.5, sampleRate: RATE },
			{ frames: Number.NaN, sampleRate: RATE },
			{ frames: "100", sampleRate: RATE },
			{ frames: 100, sampleRate: 12345 },
			{ frames: 100, sampleRate: 192000 },
			{ frames: 100, sampleRate: "44100" },
			{ frames: 100 },
		]) {
			expect(await jobs.begin({ ownerId: OWNER, ...bad })).toEqual({ ok: false, code: "invalid" });
		}
		expect(await jobs.begin({ ownerId: OWNER, frames: maxFramesFor(48000) + 1, sampleRate: 48000 })).toEqual({ ok: false, code: "too-long" });
		expect(maxFramesFor(44100)).toBe(39_690_000);
		const longest = await jobs.begin({ ownerId: OWNER, frames: maxFramesFor(96000), sampleRate: 96000 });
		expect(longest.ok).toBe(true);
	});

	test("busy is answered before the engine is checked again", async () => {
		let checks = 0;
		const { jobs } = makeJobs({ engineReady: async () => (checks++, true) });
		await begin(jobs);
		expect(checks).toBe(1);
		for (let i = 0; i < 5; i++) expect(await jobs.begin({ ownerId: OWNER, frames: FRAMES, sampleRate: RATE })).toEqual({ ok: false, code: "busy" });
		expect(checks).toBe(1);
	});

	test("no engine: engine-missing, nothing created", async () => {
		const { jobs } = makeJobs({ engineReady: async () => false });
		expect(await jobs.begin({ ownerId: OWNER, frames: FRAMES, sampleRate: RATE })).toEqual({ ok: false, code: "engine-missing" });
		expect(fs.existsSync(path.join(root, "jobs"))).toBe(false);
	});

	test("one job at a time, even for two begins at once", async () => {
		const { jobs } = makeJobs();
		const [a, b] = await Promise.all([jobs.begin({ ownerId: OWNER, frames: FRAMES, sampleRate: RATE }), jobs.begin({ ownerId: 4, frames: FRAMES, sampleRate: RATE })]);
		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		expect([a, b].find((answer) => !answer.ok)).toEqual({ ok: false, code: "busy" });
	});

	test("the job directory is a random 16 hex name, mode 0700, with a 0600 input file", async () => {
		const { jobs } = makeJobs();
		await begin(jobs);
		const dir = jobDirOf(jobs);
		expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(dir, "input.pcm")).mode & 0o777).toBe(0o600);
	});
});

describe("write: strictly sequential, capped", () => {
	test("the position must equal the bytes already received; the file holds exactly what was sent", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		const data = pcm(FRAMES * 4);
		await jobs.write({ ownerId: OWNER, token, position: 0, data: data.subarray(0, 1000) });
		for (const position of [0, 999, 1001, 2000, -1, 1000.5, Number.NaN]) {
			expect(await rejection(jobs.write({ ownerId: OWNER, token, position, data: data.subarray(1000, 1100) }))).toBe("CCUT_STEMS:INVALID");
		}
		await jobs.write({ ownerId: OWNER, token, position: 1000, data: data.subarray(1000, 4000) });
		expect(Buffer.compare(fs.readFileSync(path.join(jobDirOf(jobs), "input.pcm")), Buffer.from(data))).toBe(0);
	});

	test("two writes at the same position: only one wins", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		const chunk = pcm(100);
		const results = await Promise.all([
			rejection(jobs.write({ ownerId: OWNER, token, position: 0, data: chunk })),
			rejection(jobs.write({ ownerId: OWNER, token, position: 0, data: chunk })),
		]);
		expect(results.sort()).toEqual(["CCUT_STEMS:INVALID", "resolved"]);
	});

	test("the total never passes frames * 4; empty chunks, non-bytes and chunks over 8 MiB are refused", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		expect(await rejection(jobs.write({ ownerId: OWNER, token, position: 0, data: pcm(FRAMES * 4 + 1) }))).toBe("CCUT_STEMS:INVALID");
		expect(await rejection(jobs.write({ ownerId: OWNER, token, position: 0, data: new Uint8Array(0) }))).toBe("CCUT_STEMS:INVALID");
		expect(await rejection(jobs.write({ ownerId: OWNER, token, position: 0, data: new Int16Array(4) }))).toBe("CCUT_STEMS:INVALID");
		expect(await rejection(jobs.write({ ownerId: OWNER, token, position: 0, data: [1, 2, 3] }))).toBe("CCUT_STEMS:INVALID");
		await receiveAll(jobs, token);
		expect(await rejection(jobs.write({ ownerId: OWNER, token, position: FRAMES * 4, data: pcm(1) }))).toBe("CCUT_STEMS:INVALID");

		const big = makeJobs();
		const bigToken = await begin(big.jobs, { frames: 3_000_000 }); // 12 MB announced
		expect(await rejection(big.jobs.write({ ownerId: OWNER, token: bigToken, position: 0, data: new Uint8Array(LIMITS.maxChunkBytes + 1) }))).toBe("CCUT_STEMS:INVALID");
		expect(await rejection(big.jobs.write({ ownerId: OWNER, token: bigToken, position: 0, data: new Uint8Array(LIMITS.maxChunkBytes) }))).toBe("resolved");
	});

	test("a page that fires its chunks all at once cannot queue more than 32 MiB in memory: BUSY, and the position has not moved", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs, { frames: 12_000_000 }); // 48 MB announced
		const chunk = new Uint8Array(LIMITS.maxChunkBytes);
		const step = LIMITS.maxChunkBytes;
		const results = await Promise.all([0, 1, 2, 3, 4].map((i) => rejection(jobs.write({ ownerId: OWNER, token, position: i * step, data: chunk }))));
		expect(results).toEqual(["resolved", "resolved", "resolved", "resolved", "CCUT_STEMS:BUSY"]);
		// the refused chunk is simply sent again once the queue has drained
		expect(await rejection(jobs.write({ ownerId: OWNER, token, position: 4 * step, data: chunk }))).toBe("resolved");
		expect(fs.statSync(path.join(jobDirOf(jobs), "input.pcm")).size).toBe(5 * step);
	});

	test("another owner's or an unknown token is UNKNOWN_JOB", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		expect(await rejection(jobs.write({ ownerId: 99, token, position: 0, data: pcm(4) }))).toBe("CCUT_STEMS:UNKNOWN_JOB");
		expect(await rejection(jobs.write({ ownerId: OWNER, token: "nope", position: 0, data: pcm(4) }))).toBe("CCUT_STEMS:UNKNOWN_JOB");
		expect(await rejection(Promise.resolve().then(() => jobs.status({ ownerId: 99, token })))).toBe("CCUT_STEMS:UNKNOWN_JOB");
	});
});

describe("run", () => {
	test("needs exactly frames * 4 bytes, once", async () => {
		const { jobs, calls } = makeJobs();
		const token = await begin(jobs);
		expect(await jobs.run({ ownerId: OWNER, token })).toEqual({ ok: false, code: "invalid" });
		await jobs.write({ ownerId: OWNER, token, position: 0, data: pcm(FRAMES * 4 - 4) });
		expect(await jobs.run({ ownerId: OWNER, token })).toEqual({ ok: false, code: "invalid" });
		await jobs.write({ ownerId: OWNER, token, position: FRAMES * 4 - 4, data: pcm(4) });
		expect(await jobs.run({ ownerId: 99, token })).toEqual({ ok: false, code: "invalid" });
		expect(await jobs.run({ ownerId: OWNER, token: "nope" })).toEqual({ ok: false, code: "invalid" });
		expect(await jobs.run({ ownerId: OWNER, token })).toEqual({ ok: true });
		expect(await jobs.run({ ownerId: OWNER, token })).toEqual({ ok: false, code: "invalid" });
		await jobs.job.task;
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ jobDir: jobDirOf(jobs), frames: FRAMES, sampleRate: RATE });
	});

	test("progress is mapped to 0..95 and never goes back; done is 100 with the stems' length", async () => {
		let seen;
		const { jobs } = makeJobs({
			runEngine: async ({ jobDir, onProgress }) => {
				onProgress(0.5);
				onProgress(0.2);
				onProgress(Number.NaN);
				onProgress(7);
				seen = jobs.status({ ownerId: OWNER, token: jobs.job.token });
				writeStems({ jobDir });
				return { ok: true };
			},
		});
		const token = await begin(jobs);
		await receiveAll(jobs, token);
		await runToEnd(jobs, token);
		expect(seen).toEqual({ state: "running", percent: 95 });
		expect(jobs.status({ ownerId: OWNER, token })).toEqual({ state: "done", percent: 100, samples: SAMPLES });
	});
});

describe("outputs: validation and conversion", () => {
	test("float32 becomes Int16 mono: scaled by 32768, rounded, clamped; the .f32 files and the input are deleted", async () => {
		const table = [0, 0.5, -0.5, 1, -1, 2, -3, 1 / 32768, 0.00001, 0.99999, -0.000016, 1e30];
		const { jobs } = makeJobs({
			runEngine: async ({ jobDir }) => {
				writeStems({ jobDir, values: ({ name, i }) => (name === "vocals" ? table[i % table.length] : 0.25) });
				return { ok: true };
			},
		});
		const token = await begin(jobs);
		await receiveAll(jobs, token);
		await runToEnd(jobs, token);
		const vocals = await readAll({ jobs, token, stem: "vocals" });
		expect(vocals.length).toBe(SAMPLES);
		expect(Array.from(vocals.subarray(0, table.length))).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768, 1, 0, 32767, -1, 32767]);
		expect((await readAll({ jobs, token, stem: "drums" }))[7]).toBe(8192);
		expect(fs.readdirSync(jobDirOf(jobs)).sort()).toEqual(["bass.s16", "drums.s16", "other.s16", "vocals.s16"]);
		expect(fs.statSync(path.join(jobDirOf(jobs), "drums.s16")).mode & 0o777).toBe(0o600);
	});

	const failing = [
		["a NaN sample", ({ jobDir }) => writeStems({ jobDir, values: ({ name, i }) => (name === "bass" && i === 400 ? Number.NaN : 0.1) })],
		["an infinite sample", ({ jobDir }) => writeStems({ jobDir, values: ({ name, i }) => (name === "other" && i === 3 ? Number.POSITIVE_INFINITY : 0.1) })],
		["a missing stem", ({ jobDir }) => writeStems({ jobDir, only: ["drums", "bass", "other"] })],
		["stems of different lengths", ({ jobDir }) => {
			writeStems({ jobDir });
			fs.appendFileSync(path.join(jobDir, "other.f32"), Buffer.alloc(4));
		}],
		["a length that does not match the input (too short)", ({ jobDir }) => writeStems({ jobDir, samples: SAMPLES - 3 })],
		["a length that does not match the input (too long)", ({ jobDir }) => writeStems({ jobDir, samples: SAMPLES + 3 })],
		["a file that is not a whole number of floats", ({ jobDir }) => {
			writeStems({ jobDir });
			for (const name of STEMS) fs.appendFileSync(path.join(jobDir, `${name}.f32`), Buffer.alloc(2));
		}],
		["a symbolic link in place of a stem", ({ jobDir }) => {
			writeStems({ jobDir, only: ["drums", "bass", "other"] });
			fs.writeFileSync(path.join(jobDir, "secret.txt"), Buffer.alloc(SAMPLES * 4));
			fs.symlinkSync(path.join(jobDir, "secret.txt"), path.join(jobDir, "vocals.f32"));
		}],
	];
	for (const [label, produce] of failing) {
		test(`${label}: the job fails with invalid-output and its directory is gone`, async () => {
			const { jobs } = makeJobs({
				runEngine: async (args) => {
					produce(args);
					return { ok: true };
				},
			});
			const token = await begin(jobs);
			await receiveAll(jobs, token);
			const dir = jobDirOf(jobs);
			await runToEnd(jobs, token);
			expect(jobs.status({ ownerId: OWNER, token })).toEqual({ state: "failed", percent: expect.any(Number), code: "invalid-output" });
			expect(fs.existsSync(dir)).toBe(false);
			expect(jobs.isBusy()).toBe(false);
		});
	}

	test("a length off by up to two samples is accepted", async () => {
		for (const samples of [SAMPLES - 2, SAMPLES + 2]) {
			const { jobs } = makeJobs({
				runEngine: async ({ jobDir }) => {
					writeStems({ jobDir, samples });
					return { ok: true };
				},
			});
			const token = await begin(jobs);
			await receiveAll(jobs, token);
			await runToEnd(jobs, token);
			expect(jobs.status({ ownerId: OWNER, token })).toMatchObject({ state: "done", samples });
		}
	});

	test("every accepted rate begins a job; the list is the contract's", async () => {
		expect([...SAMPLE_RATES]).toEqual([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]);
		for (const sampleRate of SAMPLE_RATES) {
			const { jobs } = makeJobs();
			expect((await jobs.begin({ ownerId: OWNER, frames: 100, sampleRate })).ok).toBe(true);
			expect((await jobs.begin({ ownerId: OWNER, frames: maxFramesFor(sampleRate) + 1, sampleRate })).code).toBe("too-long");
			jobs.shutdownSync();
		}
	});

	test("the expected length follows the clip's rate: round(frames * 22050 / rate)", () => {
		expect(expectedStemSamples({ frames: 48000, sampleRate: 48000 })).toBe(22050);
		expect(expectedStemSamples({ frames: 1001, sampleRate: 44100 })).toBe(501);
		expect(expectedStemSamples({ frames: 96000, sampleRate: 32000 })).toBe(66150);
	});

	test("an engine failure keeps its code (timeout, invalid-output); anything else, or a throw, is engine-failed", async () => {
		const cases = [
			[{ ok: false, code: "timeout" }, "timeout"],
			[{ ok: false, code: "invalid-output" }, "invalid-output"],
			[{ ok: false, code: "out-of-memory" }, "out-of-memory"],
			[{ ok: false, code: "/etc/passwd" }, "engine-failed"],
			[undefined, "engine-failed"],
			[new Error("boom /secret/path"), "engine-failed"],
		];
		for (const [answer, code] of cases) {
			const { jobs } = makeJobs({
				runEngine: async () => {
					if (answer instanceof Error) throw answer;
					return answer;
				},
			});
			const token = await begin(jobs);
			await receiveAll(jobs, token);
			await runToEnd(jobs, token);
			expect(jobs.status({ ownerId: OWNER, token })).toMatchObject({ state: "failed", code });
		}
	});
});

describe("read", () => {
	async function doneJob() {
		const made = makeJobs({
			runEngine: async ({ jobDir }) => {
				writeStems({ jobDir, values: ({ i }) => i / 32768 });
				return { ok: true };
			},
		});
		const token = await begin(made.jobs);
		await receiveAll(made.jobs, token);
		await runToEnd(made.jobs, token);
		return { ...made, token };
	}

	test("ranges: inside the file, 1 byte .. 8 MiB, capped at the end; known stems only", async () => {
		const { jobs, token } = await doneJob();
		const size = SAMPLES * 2;
		const read = (overrides) => jobs.read({ ownerId: OWNER, token, stem: "drums", offset: 0, length: 10, ...overrides });
		const middle = await read({ offset: 4, length: 6 });
		expect(Array.from(new Int16Array(middle.buffer, middle.byteOffset, 3))).toEqual([2, 3, 4]);
		expect((await read({ offset: size - 2, length: 100 })).byteLength).toBe(2);
		expect((await read({ offset: 0, length: LIMITS.maxReadBytes })).byteLength).toBe(size);
		for (const bad of [{ offset: size }, { offset: -1 }, { offset: 1.5 }, { offset: Number.NaN }, { length: 0 }, { length: LIMITS.maxReadBytes + 1 }, { length: 2.5 }, { stem: "piano" }, { stem: "../drums" }, { stem: 5 }]) {
			expect(await rejection(read(bad))).toBe("CCUT_STEMS:INVALID");
		}
	});

	test("not readable before the job is done", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		expect(await rejection(jobs.read({ ownerId: OWNER, token, stem: "drums", offset: 0, length: 4 }))).toBe("CCUT_STEMS:NOT_READY");
	});

	test("a stem file that was swapped after the checks is not served", async () => {
		const { jobs, token } = await doneJob();
		const file = path.join(jobDirOf(jobs), "drums.s16");
		fs.rmSync(file);
		fs.writeFileSync(file, Buffer.alloc(SAMPLES * 2));
		expect(await rejection(jobs.read({ ownerId: OWNER, token, stem: "drums", offset: 0, length: 4 }))).toBe("CCUT_STEMS:READ_FAILED");
	});

	test("release deletes the directory and forgets the token; releasing twice is { ok: false }", async () => {
		const { jobs, token } = await doneJob();
		const dir = jobDirOf(jobs);
		expect(await jobs.release({ ownerId: 99, token })).toEqual({ ok: false });
		expect(await jobs.release({ ownerId: OWNER, token })).toEqual({ ok: true });
		expect(fs.existsSync(dir)).toBe(false);
		expect(await jobs.release({ ownerId: OWNER, token })).toEqual({ ok: false });
		expect(await rejection(Promise.resolve().then(() => jobs.status({ ownerId: OWNER, token })))).toBe("CCUT_STEMS:UNKNOWN_JOB");
		expect(jobs.isBusy()).toBe(false);
	});
});

describe("cancel, expiry, sweep, quit", () => {
	test("cancel while the engine runs: the abort signal reaches it, the job ends cancelled, the directory is gone, a new job can begin", async () => {
		let engineSignal;
		const { jobs } = makeJobs({
			runEngine: ({ signal }) =>
				new Promise((resolve) => {
					engineSignal = signal;
					signal.addEventListener("abort", () => resolve({ ok: false, code: "cancelled" }));
				}),
		});
		const token = await begin(jobs);
		await receiveAll(jobs, token);
		await jobs.run({ ownerId: OWNER, token });
		const dir = jobDirOf(jobs);
		expect(await jobs.cancel({ ownerId: OWNER, token })).toEqual({ ok: true });
		expect(engineSignal.aborted).toBe(true);
		expect(jobs.status({ ownerId: OWNER, token })).toMatchObject({ state: "cancelled" });
		expect(fs.existsSync(dir)).toBe(false);
		expect(await jobs.cancel({ ownerId: OWNER, token })).toEqual({ ok: false });
		expect((await jobs.begin({ ownerId: OWNER, frames: FRAMES, sampleRate: RATE })).ok).toBe(true);
	});

	test("cancel while receiving deletes the directory; cancel of a done job releases it", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		const dir = jobDirOf(jobs);
		expect(await jobs.cancel({ ownerId: OWNER, token })).toEqual({ ok: true });
		expect(jobs.status({ ownerId: OWNER, token })).toMatchObject({ state: "cancelled" });
		expect(fs.existsSync(dir)).toBe(false);

		const second = await begin(jobs);
		await receiveAll(jobs, second);
		await runToEnd(jobs, second);
		const doneDir = jobDirOf(jobs);
		expect(await jobs.cancel({ ownerId: OWNER, token: second })).toEqual({ ok: true });
		expect(fs.existsSync(doneDir)).toBe(false);
	});

	test("an unclaimed job (receiving or done) expires after 15 minutes of no activity; a running one does not", async () => {
		let clock = 1_000_000;
		const { jobs } = makeJobs({ now: () => clock });
		const token = await begin(jobs);
		await receiveAll(jobs, token);
		await runToEnd(jobs, token);
		const dir = jobDirOf(jobs);
		clock += 15 * 60 * 1000 - 1;
		await jobs.expire();
		expect(fs.existsSync(dir)).toBe(true);
		clock += 2;
		await jobs.expire();
		expect(fs.existsSync(dir)).toBe(false);
		expect(jobs.isBusy()).toBe(false);

		let release;
		const slow = makeJobs({ now: () => clock, runEngine: () => new Promise((resolve) => (release = resolve)) });
		const running = await begin(slow.jobs);
		await receiveAll(slow.jobs, running);
		await slow.jobs.run({ ownerId: OWNER, token: running });
		clock += 60 * 60 * 1000;
		await slow.jobs.expire();
		expect(slow.jobs.isBusy()).toBe(true);
		release({ ok: false, code: "timeout" });
		await slow.jobs.job.task;
	});

	test("the start-up sweep deletes job directories of a crash, and only names this module makes", async () => {
		const { jobs } = makeJobs();
		const jobsRoot = path.join(root, "jobs");
		fs.mkdirSync(path.join(jobsRoot, "0123456789abcdef"), { recursive: true });
		fs.writeFileSync(path.join(jobsRoot, "0123456789abcdef", "input.pcm"), "x");
		fs.mkdirSync(path.join(jobsRoot, "not-a-job"));
		await jobs.sweepLeftovers();
		expect(fs.readdirSync(jobsRoot)).toEqual(["not-a-job"]);
	});

	test("shutdownSync aborts the engine and deletes the directory synchronously", async () => {
		let engineSignal;
		const { jobs } = makeJobs({ runEngine: ({ signal }) => new Promise(() => (engineSignal = signal)) });
		const token = await begin(jobs);
		await receiveAll(jobs, token);
		await jobs.run({ ownerId: OWNER, token });
		const dir = jobDirOf(jobs);
		jobs.shutdownSync();
		expect(engineSignal.aborted).toBe(true);
		expect(engineSignal.reason).toBe("quit");
		expect(fs.existsSync(dir)).toBe(false);
	});

	test("a closed window (abortOwner) drops only its own job", async () => {
		const { jobs } = makeJobs();
		const token = await begin(jobs);
		const dir = jobDirOf(jobs);
		await jobs.abortOwner(99);
		expect(fs.existsSync(dir)).toBe(true);
		await jobs.abortOwner(OWNER);
		expect(fs.existsSync(dir)).toBe(false);
		expect(await rejection(Promise.resolve().then(() => jobs.status({ ownerId: OWNER, token })))).toBe("CCUT_STEMS:UNKNOWN_JOB");
	});
});
