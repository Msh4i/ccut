// Stems (round 5): the jobs of the main process. No Electron import (the engine runner and the
// file system are injected), so bun runs all of it with a fake engine. Contract: docs/ccut/stems-design.md.
//
// - At most ONE job exists at a time, app-wide (receiving, running, or done and not yet released).
// - A job belongs to the webContents that began it; every call names it by a random 256-bit token.
//   Another owner's token is "unknown".
// - begin() creates <root>/jobs/<random 16 hex> (0700) and input.pcm (0600), opened for strictly
//   sequential writes: a chunk's `position` must equal the bytes already received, the total never
//   passes frames * 4, a chunk is at most 8 MiB. run() needs exactly frames * 4 bytes.
// - The engine (injected runEngine) writes drums/bass/other/vocals.f32 (mono float32 at 22,050 Hz).
//   Afterwards the four files are validated (regular files, equal sizes, a multiple of 4, the
//   length the input implies +-2 samples, every sample finite) and converted in ONE pass to
//   <stem>.s16 (Int16 mono, clamped and rounded). input.pcm and the .f32 files are deleted.
// - read() serves the Int16 bytes in capped ranges. release() deletes the directory; so do a
//   failure, a cancel, a closed window, quit, and an unclaimed job after 15 minutes. Leftovers of a
//   crash are swept at start-up.
// - The page gets codes only: never a path, never the engine's text (which is only logged).
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const STEMS = Object.freeze(["drums", "bass", "other", "vocals"]);
const SAMPLE_RATES = Object.freeze([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]);
const MAX_SECONDS = 15 * 60;
const STEM_RATE = 22050;
const INPUT_NAME = "input.pcm";
const BYTES_PER_FRAME = 4; // interleaved stereo int16
const JOB_DIR_NAME = /^[0-9a-f]{16}$/;

const LIMITS = Object.freeze({
	maxChunkBytes: 8 * 1024 * 1024,
	maxReadBytes: 8 * 1024 * 1024,
	unclaimedTtlMs: 15 * 60 * 1000,
	endedTtlMs: 5 * 60 * 1000,
	maxQueuedBytes: 32 * 1024 * 1024,
	convertChunkSamples: 256 * 1024,
	lengthSlackSamples: 2,
});

// Read-only, never following a link, never blocking.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

const RECEIVING = "receiving";
const RUNNING = "running";
const DONE = "done";

// Errors of the IPC calls (not of the separation, which ends as a status code). The message is
// "CCUT_STEMS:<CODE>" and nothing else.
class StemsError extends Error {
	constructor(code) {
		super(`CCUT_STEMS:${code}`);
		this.name = "StemsError";
		this.code = code;
	}
}
const fail = (code) => {
	throw new StemsError(code);
};

// Marks the failures that are the engine's output being wrong (code "invalid-output").
class OutputError extends Error {}

const isBytes = (value) => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";

/** The longest input for a rate, in frames. */
const maxFramesFor = (sampleRate) => MAX_SECONDS * sampleRate;
/** Samples each stem has: the input's length at 22,050 Hz. */
const expectedStemSamples = ({ frames, sampleRate }) => Math.round((frames * STEM_RATE) / sampleRate);

class StemsJobs {
	constructor({
		root,
		runEngine,
		engineReady = async () => true,
		log = () => {},
		now = Date.now,
		randomHex = (bytes) => crypto.randomBytes(bytes).toString("hex"),
		fsApi = fsp,
		fsSync = fs,
		pathApi = path,
		limits = {},
	}) {
		this.jobsRoot = pathApi.join(root, "jobs");
		this.runEngine = runEngine;
		this.engineReady = engineReady;
		this.log = log;
		this.now = now;
		this.randomHex = randomHex;
		this.fs = fsApi;
		this.fsSync = fsSync;
		this.path = pathApi;
		this.limits = { ...LIMITS, ...limits };
		this.job = null;
	}

	isBusy() {
		return this.job !== null && (this.job.state === RECEIVING || this.job.state === RUNNING || this.job.state === DONE);
	}

	/** { ok: true, token } or { ok: false, code: "invalid"|"too-long"|"busy"|"engine-missing" }. */
	async begin({ ownerId, frames, sampleRate }) {
		await this.expire();
		if (!Number.isSafeInteger(frames) || frames < 1 || !SAMPLE_RATES.includes(sampleRate)) return { ok: false, code: "invalid" };
		if (frames > maxFramesFor(sampleRate)) return { ok: false, code: "too-long" };
		// Busy first: a page that keeps asking must not make the main process re-check the engine each time.
		if (this.isBusy()) return { ok: false, code: "busy" };
		if (!(await this.engineReady())) return { ok: false, code: "engine-missing" };
		// From here to `this.job = job` nothing is awaited: two begins cannot both pass.
		if (this.isBusy()) return { ok: false, code: "busy" };
		const job = {
			token: this.randomHex(32),
			ownerId,
			dir: this.path.join(this.jobsRoot, this.randomHex(8)),
			frames,
			sampleRate,
			expectedBytes: frames * BYTES_PER_FRAME,
			received: 0,
			queued: 0,
			handle: null,
			chain: Promise.resolve(),
			state: RECEIVING,
			percent: 0,
			code: null,
			samples: null,
			stems: new Map(),
			abort: new AbortController(),
			cancelRequested: false,
			reading: false,
			task: null,
			lastActivity: this.now(),
			endedAt: null,
		};
		this.job = job;
		try {
			await this.fs.mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
			await this.fs.chmod(this.jobsRoot, 0o700);
			await this.fs.mkdir(job.dir, { mode: 0o700 }); // fails if it exists: never reuse a directory
			await this.fs.chmod(job.dir, 0o700);
			job.handle = await this.fs.open(this.path.join(job.dir, INPUT_NAME), "wx", 0o600);
		} catch (error) {
			this.log(`[ccut] stems begin failed: ${error && error.code ? error.code : error}`);
			await this.drop(job);
			return fail("FAILED");
		}
		return { ok: true, token: job.token };
	}

	jobFor({ ownerId, token }) {
		const job = this.job;
		if (!job || typeof token !== "string" || job.token !== token || job.ownerId !== ownerId) fail("UNKNOWN_JOB");
		return job;
	}

	/** Appends one chunk. Strictly sequential: `position` is the number of bytes already sent. */
	async write({ ownerId, token, position, data }) {
		const job = this.jobFor({ ownerId, token });
		if (job.state !== RECEIVING || !isBytes(data)) fail("INVALID");
		const length = data.byteLength;
		if (!Number.isSafeInteger(position) || position !== job.received) fail("INVALID");
		if (length < 1 || length > this.limits.maxChunkBytes || position + length > job.expectedBytes) fail("INVALID");
		// A page that fires every chunk at once must not park hundreds of MB in this process: the page
		// waits for its writes and retries this chunk (the position has not moved).
		if (job.queued + length > this.limits.maxQueuedBytes) fail("BUSY");
		job.received += length; // reserved now: a second write at the same position is refused
		job.queued += length;
		job.lastActivity = this.now();
		const bytes = Buffer.from(data.buffer, data.byteOffset, length);
		const operation = job.chain.then(() => this.writeAll({ handle: job.handle, bytes, position }));
		job.chain = operation.catch(() => {}).finally(() => {
			job.queued -= length;
		});
		try {
			await operation;
		} catch (error) {
			this.log(`[ccut] stems write failed: ${error && error.code ? error.code : error}`);
			await this.drop(job);
			return fail("WRITE_FAILED");
		}
		return { ok: true };
	}

	async writeAll({ handle, bytes, position }) {
		let done = 0;
		for (let round = 0; done < bytes.length && round <= bytes.length; round++) {
			const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, position + done);
			if (bytesWritten === 0) break;
			done += bytesWritten;
		}
		if (done !== bytes.length) throw new Error("short write");
	}

	/** { ok: true } or { ok: false, code: "invalid" } (unknown token, wrong state, bytes missing). */
	async run({ ownerId, token }) {
		const job = this.job;
		if (!job || typeof token !== "string" || job.token !== token || job.ownerId !== ownerId) return { ok: false, code: "invalid" };
		if (job.state !== RECEIVING || job.received !== job.expectedBytes) return { ok: false, code: "invalid" };
		job.state = RUNNING; // synchronously: no second run, no further write
		await job.chain;
		if (job.state !== RUNNING) return { ok: false, code: "invalid" }; // a write failed meanwhile
		try {
			await job.handle.close();
		} catch {}
		job.handle = null;
		job.lastActivity = this.now();
		job.task = this.runJob(job);
		return { ok: true };
	}

	/** What the page may know: state, percent, a code, the stems' length. Never a path. */
	status({ ownerId, token }) {
		const job = this.jobFor({ ownerId, token });
		const answer = { state: job.state, percent: job.percent };
		if (job.code) answer.code = job.code;
		if (job.state === DONE) answer.samples = job.samples;
		return answer;
	}

	async runJob(job) {
		let code = null;
		try {
			const result = await this.runEngine({
				jobDir: job.dir,
				frames: job.frames,
				sampleRate: job.sampleRate,
				signal: job.abort.signal,
				onProgress: (fraction) => {
					if (typeof fraction === "number" && Number.isFinite(fraction)) job.percent = Math.max(job.percent, Math.min(95, Math.round(fraction * 95)));
				},
			});
			if (!job.cancelRequested) {
				if (!result || result.ok !== true) code = result && typeof result.code === "string" ? result.code : "engine-failed";
				else {
					job.percent = Math.max(job.percent, 95);
					job.samples = await this.convertOutputs(job);
				}
			}
		} catch (error) {
			if (!job.cancelRequested) {
				this.log(`[ccut] stems job failed: ${error && error.message ? error.message : error}`);
				code = error instanceof OutputError ? "invalid-output" : "engine-failed";
			}
		}
		if (job.cancelRequested) {
			job.state = "cancelled";
			job.endedAt = this.now();
			await this.removeDir(job);
			return;
		}
		if (code !== null) {
			job.state = "failed";
			job.code = ["engine-failed", "timeout", "invalid-output", "out-of-memory"].includes(code) ? code : "engine-failed";
			job.endedAt = this.now();
			await this.removeDir(job);
			return;
		}
		await this.removeIntermediates(job);
		job.percent = 100;
		job.state = DONE;
		job.lastActivity = this.now();
	}

	/** Validates the four engine files and writes <stem>.s16 next to them; returns the stems' length. */
	async convertOutputs(job) {
		const expected = expectedStemSamples({ frames: job.frames, sampleRate: job.sampleRate });
		const infos = [];
		for (const name of STEMS) {
			const file = this.path.join(job.dir, `${name}.f32`);
			let stat;
			try {
				stat = await this.fs.lstat(file);
			} catch {
				throw new OutputError(`${name}.f32 is missing`);
			}
			if (!stat.isFile() || stat.size === 0 || stat.size % 4 !== 0) throw new OutputError(`${name}.f32 is not a whole float32 file`);
			infos.push({ name, file, size: stat.size });
		}
		const samples = infos[0].size / 4;
		if (infos.some((info) => info.size !== infos[0].size)) throw new OutputError("the stems differ in length");
		if (Math.abs(samples - expected) > this.limits.lengthSlackSamples) throw new OutputError(`stem length ${samples}, expected ${expected}`);
		try {
			for (const info of infos) {
				if (job.cancelRequested) return samples;
				await this.convertOne({ file: info.file, target: this.path.join(job.dir, `${info.name}.s16`), samples });
				job.percent = Math.max(job.percent, 95 + infos.indexOf(info) + 1);
			}
		} catch (error) {
			for (const info of infos) await this.fs.rm(this.path.join(job.dir, `${info.name}.s16`), { force: true }).catch(() => {});
			throw error;
		}
		for (const info of infos) {
			const stat = await this.fs.stat(this.path.join(job.dir, `${info.name}.s16`));
			job.stems.set(info.name, { path: this.path.join(job.dir, `${info.name}.s16`), size: stat.size, ino: stat.ino, dev: stat.dev });
		}
		return samples;
	}

	/** float32 LE -> Int16 LE (x * 32768, rounded, clamped), checking every sample is finite. */
	async convertOne({ file, target, samples }) {
		const chunk = this.limits.convertChunkSamples;
		let input = null;
		let output = null;
		try {
			input = await this.fs.open(file, READ_FLAGS);
			output = await this.fs.open(target, "wx", 0o600);
			const source = Buffer.alloc(chunk * 4);
			const sink = Buffer.alloc(chunk * 2);
			for (let done = 0; done < samples; ) {
				const count = Math.min(chunk, samples - done);
				const { bytesRead } = await input.read(source, 0, count * 4, done * 4);
				// A short read of a regular file of the checked size: treat it as a bad file.
				if (bytesRead !== count * 4) throw new OutputError("short read");
				for (let i = 0; i < count; i++) {
					const value = source.readFloatLE(i * 4);
					if (!Number.isFinite(value)) throw new OutputError("a sample is not finite");
					const scaled = Math.round(value * 32768);
					sink.writeInt16LE(scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled, i * 2);
				}
				await output.write(sink, 0, count * 2, done * 2);
				done += count;
			}
			await output.sync();
		} finally {
			if (input) await input.close().catch(() => {});
			if (output) await output.close().catch(() => {});
		}
	}

	/** { ok: boolean }: stops a running job (it ends "cancelled"), releases a done one. */
	async cancel({ ownerId, token }) {
		const job = this.job;
		if (!job || typeof token !== "string" || job.token !== token || job.ownerId !== ownerId) return { ok: false };
		if (job.state === DONE) return this.release({ ownerId, token });
		if (job.state === RECEIVING) {
			job.cancelRequested = true;
			job.state = "cancelled";
			job.endedAt = this.now();
			await this.closeHandle(job);
			await this.removeDir(job);
			return { ok: true };
		}
		if (job.state !== RUNNING) return { ok: false };
		job.cancelRequested = true;
		job.abort.abort("cancelled");
		await job.task;
		return { ok: true };
	}

	/** Serves bytes of one stem as Int16 mono. offset/length are in bytes; length is capped at the end of the file. */
	async read({ ownerId, token, stem, offset, length }) {
		const job = this.jobFor({ ownerId, token });
		if (job.state !== DONE) fail("NOT_READY");
		if (typeof stem !== "string" || !STEMS.includes(stem)) fail("INVALID");
		const file = job.stems.get(stem);
		if (!file) fail("NOT_READY");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.size) fail("INVALID");
		if (!Number.isSafeInteger(length) || length < 1 || length > this.limits.maxReadBytes) fail("INVALID");
		if (job.reading) fail("BUSY"); // one read in flight per job
		job.reading = true;
		const count = Math.min(length, file.size - offset);
		let handle = null;
		try {
			handle = await this.fs.open(file.path, READ_FLAGS);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size !== file.size || stat.ino !== file.ino || stat.dev !== file.dev) fail("READ_FAILED");
			const bytes = new Uint8Array(count);
			let done = 0;
			for (let round = 0; done < count && round <= count; round++) {
				const { bytesRead } = await handle.read(bytes, done, count - done, offset + done);
				if (bytesRead === 0) break;
				done += bytesRead;
			}
			if (done !== count) fail("READ_FAILED");
			job.lastActivity = this.now();
			return bytes;
		} catch (error) {
			if (error instanceof StemsError) throw error;
			this.log(`[ccut] stems read failed: ${error && error.code ? error.code : error}`);
			return fail("READ_FAILED");
		} finally {
			if (handle) await handle.close().catch(() => {});
			job.reading = false;
		}
	}

	/** { ok: boolean }: deletes the job and its directory (stopping the engine first if it still runs). */
	async release({ ownerId, token }) {
		const job = this.job;
		if (!job || typeof token !== "string" || job.token !== token || job.ownerId !== ownerId) return { ok: false };
		await this.drop(job);
		return { ok: true };
	}

	async drop(job) {
		if (job.state === RUNNING) {
			job.cancelRequested = true;
			job.abort.abort("cancelled");
			await job.task;
		}
		job.cancelRequested = true;
		job.state = "released";
		if (this.job === job) this.job = null;
		await this.closeHandle(job);
		await this.removeDir(job);
	}

	/** The owner's page reloaded, navigated away, crashed or closed. */
	async abortOwner(ownerId) {
		const job = this.job;
		if (job && job.ownerId === ownerId) await this.drop(job);
	}

	/** App quit: kill and delete synchronously (the app does not wait for promises). */
	shutdownSync() {
		const job = this.job;
		if (!job) return;
		job.cancelRequested = true;
		job.abort.abort("quit");
		job.state = "released";
		this.job = null;
		try {
			this.fsSync.rmSync(job.dir, { recursive: true, force: true });
		} catch {}
	}

	/** An unclaimed job (never run to the end, or never read and released) expires; an ended job's status is forgotten after a while. */
	async expire() {
		const job = this.job;
		if (!job) return;
		const now = this.now();
		if ((job.state === RECEIVING || job.state === DONE) && now - job.lastActivity > this.limits.unclaimedTtlMs) {
			await this.drop(job);
		} else if ((job.state === "failed" || job.state === "cancelled") && now - job.endedAt > this.limits.endedTtlMs) {
			this.job = null;
		}
	}

	/** Job directories left by a crash. Only names this module creates are touched. */
	async sweepLeftovers() {
		let names;
		try {
			names = await this.fs.readdir(this.jobsRoot);
		} catch {
			return;
		}
		const current = this.job ? this.path.basename(this.job.dir) : null;
		for (const name of names) {
			if (!JOB_DIR_NAME.test(name) || name === current) continue;
			await this.fs.rm(this.path.join(this.jobsRoot, name), { recursive: true, force: true }).catch(() => {});
		}
	}

	async closeHandle(job) {
		const handle = job.handle;
		job.handle = null;
		if (handle) await handle.close().catch(() => {});
	}

	async removeDir(job) {
		try {
			await this.fs.rm(job.dir, { recursive: true, force: true });
		} catch (error) {
			this.log(`[ccut] stems: could not delete a job directory: ${error && error.code ? error.code : error}`);
		}
	}

	/** After a good conversion: the input, the float files and the engine's scratch directories go. */
	async removeIntermediates(job) {
		const names = [INPUT_NAME, ...STEMS.map((name) => `${name}.f32`), "home", "tmp"];
		for (const name of names) await this.fs.rm(this.path.join(job.dir, name), { recursive: true, force: true }).catch(() => {});
	}
}

module.exports = { LIMITS, SAMPLE_RATES, STEMS, STEM_RATE, StemsError, StemsJobs, expectedStemSamples, maxFramesFor };
