const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const MB = require("mediabunny");
const { MUX_LIMITS, MuxError, copyPackets, loadMediabunny, muxPair: muxPairWith, takeVideoNext, writableFor } = require("../link-import-mux-worker");
const { MUX_RUN_LIMITS, muxWorkerPath, resolveMediabunnyPath, runMuxWorker: runMuxWorkerWith } = require("../link-import-mux");
const { oneByteTable, squeezedSamples, wholeFileSamples } = require("./fixtures/hostile-media");
const { MEDIABUNNY_CJS_SHA256, VENDOR_FILE, vendorMediabunny } = require("../link-import-vendor");

// The pair's last step: an H.264 video-only MP4 and an AAC m4a become ONE MP4 by copying their
// encoded packets (no decode, no encode) with mediabunny. Real mediabunny on small committed
// fixtures (fixtures/media/README.md); ffmpeg is never needed here.

const MEDIA = path.join(__dirname, "fixtures", "media");
const STUB = path.join(__dirname, "fixtures", "mux-worker-stub.js");
const posixOnly = process.platform === "win32" ? test.skip : test;
// The worker loads mediabunny from an absolute path it is given (never a bare require). In the
// repository that is the installed package's CJS bundle.
const MB_PATH = require.resolve("mediabunny");
const muxPair = (options) => muxPairWith({ mediabunnyPath: MB_PATH, ...options });
const runMuxWorker = (options) => runMuxWorkerWith({ mediabunnyPath: MB_PATH, ...options });

let dir;
beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-mux-"));
});
afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

/** How the job describes a checked file: size, and device + file id as exact decimal strings. */
async function describeChecked(file) {
	const stat = await fsp.lstat(file, { bigint: true });
	return { path: file, size: Number(stat.size), dev: String(stat.dev), ino: String(stat.ino) };
}

/** A copy of a fixture in the test directory, described like the job describes a checked file. */
async function input(name, { as = name, bytes } = {}) {
	const file = path.join(dir, as);
	await fsp.writeFile(file, bytes ?? (await fsp.readFile(path.join(MEDIA, name))));
	return describeChecked(file);
}

async function describeFile(file) {
	const source = new MB.BufferSource(await fsp.readFile(file));
	const media = new MB.Input({ source, formats: MB.ALL_FORMATS });
	try {
		const tracks = [];
		for (const track of await media.getTracks()) {
			const sink = new MB.EncodedPacketSink(track);
			const hash = crypto.createHash("sha256");
			const timestamps = [];
			const kinds = [];
			for (let packet = await sink.getFirstPacket(), n = 0; packet && n < 10_000; packet = await sink.getNextPacket(packet), n++) {
				hash.update(packet.data);
				timestamps.push(packet.timestamp);
				kinds.push(packet.type);
			}
			tracks.push({ type: track.type, codec: track.codec, count: timestamps.length, timestamps, kinds, sha256: hash.digest("hex") });
		}
		return tracks;
	} finally {
		media.dispose();
	}
}

const outPath = () => path.join(dir, "final", "media.mp4");
async function prepareFinal() {
	await fsp.mkdir(path.join(dir, "final"), { mode: 0o700 });
	return outPath();
}

/** The packets of an m4a written as ADTS (raw AAC frames) with mediabunny, for the demuxer test. */
async function adtsBytes(file) {
	const source = new MB.Input({ source: new MB.BufferSource(await fsp.readFile(file)), formats: MB.ALL_FORMATS });
	const [track] = await source.getAudioTracks();
	const target = new MB.BufferTarget();
	const output = new MB.Output({ format: new MB.AdtsOutputFormat(), target });
	const packets = new MB.EncodedAudioPacketSource("aac");
	output.addAudioTrack(packets);
	await output.start();
	const sink = new MB.EncodedPacketSink(track);
	let meta = { decoderConfig: await track.getDecoderConfig() };
	for (let packet = await sink.getFirstPacket(), n = 0; packet && n < 1000; packet = await sink.getNextPacket(packet), n++) {
		await packets.add(packet, meta);
		meta = undefined;
	}
	packets.close();
	await output.finalize();
	source.dispose();
	return Buffer.from(target.buffer);
}

async function muxError(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof MuxError ? error.code : `other: ${error && error.message}`;
	}
	return "resolved";
}

describe("muxPair: packets copied unchanged into one MP4", () => {
	test("fragmented H.264 video-only + fragmented AAC: one video and one audio track, every packet byte-identical, 0600, starts with ftyp", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		const progress = [];
		const result = await muxPair({ video, audio, outPath: out, onProgress: ({ fraction }) => progress.push(fraction) });
		expect(result).toMatchObject({ packets: 55, shift: 0, width: 128, height: 72 });
		expect(result.duration).toBeGreaterThan(0.99);
		const [inVideo] = await describeFile(video.path);
		const [inAudio] = await describeFile(audio.path);
		const outTracks = await describeFile(out);
		expect(outTracks.map((t) => [t.type, t.codec, t.count])).toEqual([
			["video", "avc", 10],
			["audio", "aac", 45],
		]);
		expect(outTracks[0].sha256).toBe(inVideo.sha256);
		expect(outTracks[1].sha256).toBe(inAudio.sha256);
		expect(outTracks[0].timestamps).toEqual(inVideo.timestamps);
		expect(outTracks[1].timestamps).toEqual(inAudio.timestamps);
		// key frames stay key frames, delta frames stay delta frames
		expect(outTracks[0].kinds).toEqual(inVideo.kinds);
		expect(inVideo.kinds.filter((kind) => kind === "key")).toHaveLength(2);
		const head = (await fsp.readFile(out)).subarray(4, 8).toString("latin1");
		expect(head).toBe("ftyp");
		if (process.platform !== "win32") expect(fs.statSync(out).mode & 0o777).toBe(0o600);
		expect(progress.length).toBeGreaterThan(1);
		expect(progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= progress[i - 1]))).toBe(true);
		expect(progress.at(-1)).toBe(1);
	});

	test("the output is flushed to disk (fsync) before the mux reports success", async () => {
		const synced = [];
		const fsApi = {
			...fsp,
			open: async (file, flags, mode) => {
				const handle = await fsp.open(file, flags, mode);
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					synced.push(file);
					return sync();
				};
				return handle;
			},
		};
		const out = await prepareFinal();
		await muxPair({ video: await input("video-frag.mp4"), audio: await input("audio-frag.m4a"), outPath: out, fsApi });
		expect(synced).toEqual([out]);
	});

	test("B-frames: the decode order, the presentation timestamps (composition != decode time) and the key frames are kept; progress never goes back", async () => {
		const video = await input("video-bframes.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		const progress = [];
		await muxPair({ video, audio, outPath: out, onProgress: ({ fraction }) => progress.push(fraction) });
		const [inVideo] = await describeFile(video.path);
		const [outVideo] = await describeFile(out);
		const outOfOrder = (ts) => ts.filter((t, i) => i > 0 && t < ts[i - 1]).length;
		expect(outOfOrder(inVideo.timestamps)).toBeGreaterThan(0);
		expect(outVideo.timestamps).toEqual(inVideo.timestamps);
		expect(outVideo.kinds).toEqual(inVideo.kinds);
		expect(outVideo.sha256).toBe(inVideo.sha256);
		expect(progress.length).toBeGreaterThan(2);
		expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true);
	});

	test("AAC priming edit list (first audio packet at -1024/44100 s): BOTH tracks move by that amount, no packet is dropped", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-priming.m4a");
		const out = await prepareFinal();
		const result = await muxPair({ video, audio, outPath: out });
		expect(result.shift).toBeCloseTo(1024 / 44100, 9);
		const [outVideo, outAudio] = await describeFile(out);
		const [inAudio] = await describeFile(audio.path);
		expect(outAudio.count).toBe(45);
		expect(outAudio.sha256).toBe(inAudio.sha256);
		expect(outAudio.timestamps[0]).toBeCloseTo(0, 6);
		// the video's first frame keeps its distance to the audio (within the output timescale's rounding)
		expect(Math.abs(outVideo.timestamps[0] - 1024 / 44100)).toBeLessThan(1e-4);
	});
});

describe("muxPair: refused inputs end as bad-output and leave no output file", () => {
	const refused = async ({ video, audio }) => {
		const out = await prepareFinal();
		const code = await muxError(muxPair({ video, audio, outPath: out }));
		return { code, left: fs.existsSync(out) };
	};

	test("a wrong codec (VP9 video), swapped inputs, an HTML page, a truncated or header-only file", async () => {
		const audio = await input("audio-frag.m4a");
		const full = await fsp.readFile(path.join(MEDIA, "video-frag.mp4"));
		const cases = [
			["vp9", await input("video-vp9.mp4"), audio],
			["swapped", audio, await input("video-frag.mp4")],
			["html", await input("x", { as: "page.mp4", bytes: Buffer.from("<!DOCTYPE html><html>Sign in</html>".repeat(40)) }), audio],
			["truncated", await input("x", { as: "half.mp4", bytes: full.subarray(0, Math.floor(full.length / 2)) }), audio],
			["header-only", await input("x", { as: "head.mp4", bytes: full.subarray(0, 900) }), audio],
		];
		for (const [name, video, sound] of cases) {
			const result = await refused({ video, audio: sound });
			expect({ name, ...result }).toEqual({ name, code: "bad-output", left: false });
			await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		}
	});

	test("the refusal names the codec it expected and the one it found (the log says why)", async () => {
		const out = await prepareFinal();
		let message = "";
		try {
			await muxPair({ video: await input("video-vp9.mp4"), audio: await input("audio-frag.m4a"), outPath: out });
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("expected video/avc, got video/vp9");
	});

	test("a file with video AND audio in the video slot (not video-only) is refused: exactly one track per input", async () => {
		const combined = path.join(dir, "combined.mp4");
		await muxPair({ video: await input("video-frag.mp4"), audio: await input("audio-frag.m4a"), outPath: combined });
		expect((await describeFile(combined)).map((track) => track.type)).toEqual(["video", "audio"]);
		const video = await describeChecked(combined);
		expect(await refused({ video, audio: await input("audio-frag.m4a", { as: "a2.m4a" }) })).toEqual({ code: "bad-output", left: false });
	});

	posixOnly("a symlinked input is not followed (O_NOFOLLOW), even though it points at a valid file", async () => {
		const real = await input("video-frag.mp4");
		const link = path.join(dir, "link.mp4");
		fs.symlinkSync(real.path, link);
		const audio = await input("audio-frag.m4a");
		expect(await refused({ video: { ...real, path: link }, audio })).toEqual({ code: "bad-output", left: false });
	});

	test("an input replaced after the job checked it (another inode, or another size) is refused", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		expect(await refused({ video: { ...video, size: video.size + 1 }, audio })).toEqual({ code: "bad-output", left: false });
		await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		// the file id is compared exactly (bigint), on Windows too (file index + volume serial)
		expect(await refused({ video, audio: { ...audio, ino: String(BigInt(audio.ino) + 1n) } })).toEqual({ code: "bad-output", left: false });
		await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		expect(await refused({ video: { ...video, dev: String(BigInt(video.dev) + 1n) }, audio })).toEqual({ code: "bad-output", left: false });
		// with Windows' open flags ("r") the id is compared just the same
		await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		const out = await prepareFinal();
		expect(await muxError(muxPair({ video, audio: { ...audio, ino: String(BigInt(audio.ino) + 1n) }, outPath: out, platform: "win32" }))).toBe("bad-output");
		await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		expect((await muxPair({ video, audio, outPath: await prepareFinal(), platform: "win32" })).packets).toBe(55);
	});

	test("an output that already exists is not touched (O_EXCL)", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		await fsp.writeFile(out, "already here");
		expect(await muxError(muxPair({ video, audio, outPath: out }))).toBe("bad-output");
		expect(await fsp.readFile(out, "utf8")).toBe("already here");
	});

	posixOnly("an output path that is a symlink is not followed: the link's target is not written", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		const victim = path.join(dir, "victim.txt");
		await fsp.writeFile(victim, "must stay");
		fs.symlinkSync(victim, out);
		expect(await muxError(muxPair({ video, audio, outPath: out }))).toBe("bad-output");
		expect(await fsp.readFile(victim, "utf8")).toBe("must stay");
		expect(fs.lstatSync(out).isSymbolicLink()).toBe(true);
	});

	test("only the MP4 demuxer is enabled: a raw AAC (ADTS) stream that mediabunny could read otherwise is refused", async () => {
		const adts = await adtsBytes(path.join(MEDIA, "audio-frag.m4a"));
		const probe = new MB.Input({ source: new MB.BufferSource(adts), formats: MB.ALL_FORMATS });
		expect((await probe.getTracks()).map((track) => track.codec)).toEqual(["aac"]);
		probe.dispose();
		const video = await input("video-frag.mp4");
		const audio = await input("x", { as: "audio.m4a", bytes: adts });
		expect(await refused({ video, audio })).toEqual({ code: "bad-output", left: false });
	});

	test("wider or taller than the limit, or longer than the duration limit: bad-output", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		expect(await muxError(muxPair({ video, audio, outPath: await prepareFinal(), limits: { maxDimension: 100 } }))).toBe("bad-output");
		await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		expect(await muxError(muxPair({ video, audio, outPath: await prepareFinal(), limits: { maxDurationSeconds: 0.5 } }))).toBe("bad-output");
		await fsp.rm(path.join(dir, "final"), { recursive: true, force: true });
		// exactly at the limits it works (128x72, 1.02 s)
		expect((await muxPair({ video, audio, outPath: await prepareFinal(), limits: { maxDimension: 128, maxDurationSeconds: 1.1 } })).packets).toBe(55);
		expect(MUX_LIMITS.maxDimension).toBe(8192);
		expect(MUX_LIMITS.maxDurationSeconds).toBe(6 * 3600);
	});

	posixOnly("an input swapped for a FIFO is refused at once (opened non-blocking), not waited on", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const fifo = path.join(dir, "fifo.mp4");
		const made = require("node:child_process").spawnSync("mkfifo", [fifo]);
		expect(made.status).toBe(0);
		const t0 = Date.now();
		try {
			expect(await refused({ video: { ...video, path: fifo }, audio })).toEqual({ code: "bad-output", left: false });
		} finally {
			// a reader stuck in open() (the bug this test guards against) is released by a writer
			try {
				fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
			} catch {}
		}
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	test("more packets than the limit: bad-output, the partial output is deleted", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		expect(await muxError(muxPair({ video, audio, outPath: out, limits: { maxPackets: 20 } }))).toBe("bad-output");
		expect(fs.existsSync(out)).toBe(false);
		expect(MUX_LIMITS.maxPackets).toBe(1_000_000);
	});
});

describe("muxPair: hostile inputs are bounded by bytes (generated at test time), and still end quickly as bad-output", () => {
	const hostile = async ({ bytes, limits }) => {
		const video = await input("video-frag.mp4");
		const audio = await input("x", { as: "hostile.m4a", bytes });
		const out = await prepareFinal();
		const t0 = Date.now();
		const code = await muxError(muxPair({ video, audio, outPath: out, limits }));
		return { code, left: fs.existsSync(out), fast: Date.now() - t0 < 3000 };
	};

	test("every one of 300 samples is the whole file (disk amplification): refused once a track's packets add up to more than its file", async () => {
		const bytes = wholeFileSamples({ samples: 300, padding: 20_000 });
		expect(await hostile({ bytes })).toEqual({ code: "bad-output", left: false, fast: true });
	});

	test("one sample larger than the read limit (memory): refused before the bytes are read", async () => {
		const bytes = wholeFileSamples({ samples: 1, padding: 300_000 });
		expect(bytes.length).toBeGreaterThan(64 * 1024);
		expect(await hostile({ bytes, limits: { maxReadBytes: 64 * 1024 } })).toEqual({ code: "bad-output", left: false, fast: true });
	});

	test("a sample table larger than the read limit: refused while reading the moov box", async () => {
		const bytes = oneByteTable({ samples: 20_000 });
		expect(await hostile({ bytes, limits: { maxReadBytes: 16 * 1024 } })).toEqual({ code: "bad-output", left: false, fast: true });
	});

	test("contiguous samples squeezed into 1/44100 s steps (the muxer holds a chunk until it spans 0.5 s): refused once one track's chunk holds more than the limit", async () => {
		const bytes = squeezedSamples({ samples: 10, sampleBytes: 20 * 1024 });
		// each read is small and the samples add up to less than the file: only the chunk bound sees it
		expect(await hostile({ bytes, limits: { maxChunkBytes: 64 * 1024 } })).toEqual({ code: "bad-output", left: false, fast: true });
	});

	test("the legit fixtures still mux under the tightest limits used above", async () => {
		const out = await prepareFinal();
		const result = await muxPair({ video: await input("video-bframes.mp4"), audio: await input("audio-priming.m4a"), outPath: out, limits: { maxReadBytes: 16 * 1024, maxChunkBytes: 64 * 1024 } });
		expect(result.packets).toBe(55);
		expect(MUX_LIMITS.maxChunkBytes).toBe(64 * 1024 * 1024);
		expect(MUX_LIMITS.maxReadBytes).toBe(16 * 1024 * 1024);
		expect(MUX_LIMITS.outputSlackBytes).toBe(64 * 1024 * 1024);
	});

	test("copyPackets: the packets of EACH track may add up to at most its file's size (a fake mediabunny feeds the packets)", async () => {
		const packet = (timestamp, bytes) => ({ timestamp, type: "key", data: new Uint8Array(bytes), clone: () => packet(timestamp, bytes) });
		class FakeSink {
			constructor(track) {
				this.list = track.packets;
			}
			async getFirstPacket() {
				return this.list[0] ?? null;
			}
			async getNextPacket(current) {
				return this.list[this.list.indexOf(current) + 1] ?? null;
			}
		}
		const run = async ({ video, audio, sizes }) => {
			const added = [];
			const source = { add: async (p) => added.push(p.data.byteLength), close: () => {} };
			const target = { handle: { sync: async () => {} }, output: { start: async () => {}, finalize: async () => {} }, videoSource: source, audioSource: source };
			const parsed = { v: { track: { packets: video, displayWidth: 2, displayHeight: 2 }, decoderConfig: {} }, a: { track: { packets: audio }, decoderConfig: {} }, end: 1, shift: 0 };
			try {
				await copyPackets({ MB: { EncodedPacketSink: FakeSink }, parsed, sizes, target, limits: MUX_LIMITS, checkAbort: () => {}, onProgress: () => {} });
				return { ok: true, added };
			} catch (error) {
				return { code: error.code, message: error.message };
			}
		};
		const three = (bytes) => [packet(0, bytes), packet(0.6, bytes), packet(1.2, bytes)];
		expect((await run({ video: three(10), audio: three(10), sizes: { video: 30, audio: 30 } })).ok).toBe(true);
		const video = await run({ video: three(10), audio: three(10), sizes: { video: 29, audio: 1000 } });
		expect(video).toMatchObject({ code: "bad-output" });
		expect(video.message).toContain("video packets add up");
		const audio = await run({ video: three(10), audio: three(10), sizes: { video: 1000, audio: 29 } });
		expect(audio).toMatchObject({ code: "bad-output" });
		expect(audio.message).toContain("audio packets add up");
	});

	test("copyPackets: the bytes one muxer chunk holds (mediabunny 1.41.0: a new chunk when it spans >= 0.5 s, start = earliest timestamp) are bounded per track", async () => {
		const packet = (timestamp, bytes) => ({ timestamp, type: "key", data: new Uint8Array(bytes), clone: () => packet(timestamp, bytes) });
		class FakeSink {
			constructor(track) {
				this.list = track.packets;
			}
			async getFirstPacket() {
				return this.list[0] ?? null;
			}
			async getNextPacket(current) {
				return this.list[this.list.indexOf(current) + 1] ?? null;
			}
		}
		const source = { add: async () => {}, close: () => {} };
		const target = { handle: { sync: async () => {} }, output: { start: async () => {}, finalize: async () => {} }, videoSource: source, audioSource: source };
		const run = async ({ video, audio = [], maxChunkBytes = 25 }) => {
			const parsed = { v: { track: { packets: video, displayWidth: 2, displayHeight: 2 }, decoderConfig: {} }, a: { track: { packets: audio }, decoderConfig: {} }, end: 10, shift: 0 };
			try {
				await copyPackets({ MB: { EncodedPacketSink: FakeSink }, parsed, sizes: { video: 1e9, audio: 1e9 }, target, limits: { ...MUX_LIMITS, maxChunkBytes }, checkAbort: () => {}, onProgress: () => {} });
				return "ok";
			} catch (error) {
				return error.message.includes("half a second") ? "refused" : error.message;
			}
		};
		const at = (...times) => times.map((t) => packet(t, 10));
		// spread out: every packet starts a new chunk, many bytes in total are fine
		expect(await run({ video: at(0, 0.5, 1, 1.5, 2, 2.5, 3) })).toBe("ok");
		// squeezed: three packets within 0.5 s hold 30 bytes > 25
		expect(await run({ video: at(0, 0.1, 0.2) })).toBe("refused");
		// exactly 0.5 s apart starts a new chunk; 0.49 does not
		expect(await run({ video: at(0, 0.25, 0.5, 0.75) })).toBe("ok");
		expect(await run({ video: at(0, 0.25, 0.49) })).toBe("refused");
		// B-frames: the chunk starts at its earliest timestamp, so 0.6 - 0.0 >= 0.5 starts a new one
		expect(await run({ video: at(0.4, 0, 0.6, 0.7) })).toBe("ok");
		// per track: 20 video + 20 audio bytes in the same half second are two chunks of 20
		expect(await run({ video: at(0, 0.1), audio: at(0.05, 0.15) })).toBe("ok");
		expect(await run({ video: at(0, 0.1), audio: at(0.05, 0.15, 0.2) })).toBe("refused");
	});

	test("copyPackets: the chunk bound counts the timestamps the muxer gets (moved by the priming shift), exact at the 0.5 s boundary", async () => {
		// clone({ timestamp }) like mediabunny's EncodedPacket: the muxer only ever sees the moved packet.
		const packet = ({ timestamp, bytes = 10 }) => ({ timestamp, type: "key", data: new Uint8Array(bytes), clone: ({ timestamp: moved }) => packet({ timestamp: moved, bytes }) });
		class FakeSink {
			constructor(track) {
				this.list = track.packets;
			}
			async getFirstPacket() {
				return this.list[0] ?? null;
			}
			async getNextPacket(current) {
				return this.list[this.list.indexOf(current) + 1] ?? null;
			}
		}
		const run = async ({ times, shift, track = "video" }) => {
			const added = [];
			const packets = times.map((timestamp) => packet({ timestamp }));
			const source = { add: async (moved) => void added.push(moved.timestamp), close: () => {} };
			const target = { handle: { sync: async () => {} }, output: { start: async () => {}, finalize: async () => {} }, videoSource: source, audioSource: source };
			const video = track === "video" ? packets : [];
			const audio = track === "audio" ? packets : [];
			const parsed = { v: { track: { packets: video, displayWidth: 2, displayHeight: 2 }, decoderConfig: {} }, a: { track: { packets: audio }, decoderConfig: {} }, end: 10, shift };
			try {
				await copyPackets({ MB: { EncodedPacketSink: FakeSink }, parsed, sizes: { video: 1e9, audio: 1e9 }, target, limits: { ...MUX_LIMITS, maxChunkBytes: 15 }, checkAbort: () => {}, onProgress: () => {} });
				return { result: "ok", added };
			} catch (error) {
				return { result: error.message.includes("half a second") ? "refused" : error.message, added };
			}
		};
		// mediabunny 1.41.0 starts a new chunk when (moved t) - (moved start) >= 0.5 (mediabunny.cjs 23094).
		const shift = 1024 / 44100; // AAC priming: the shift a real m4a with an edit list gives
		const muxerSplits = ([t0, t1]) => t1 + shift - (t0 + shift) >= 0.5;
		// 0.5 apart before the shift, 0.4999999999999999 after it: the muxer keeps ONE chunk of 20 bytes
		const under = 0.4768;
		expect(under + 0.5 - under).toBe(0.5);
		expect(muxerSplits([under, under + 0.5])).toBe(false);
		for (const track of ["video", "audio"]) expect((await run({ times: [under, under + 0.5], shift, track })).result).toBe("refused");
		// 0.49999999999999994 apart before the shift, exactly 0.5 after it: the muxer starts a new chunk (10 + 10)
		const over = 4 / 15000;
		expect(over + 0.5 - over).toBeLessThan(0.5);
		expect(muxerSplits([over, over + 0.5])).toBe(true);
		for (const track of ["video", "audio"]) {
			expect(await run({ times: [over, over + 0.5], shift, track })).toEqual({ result: "ok", added: [over + shift, over + 0.5 + shift] });
		}
		// without a shift nothing changes
		expect((await run({ times: [0, 0.5], shift: 0 })).result).toBe("ok");
		expect((await run({ times: [0, 0.49], shift: 0 })).result).toBe("refused");
	});

	test("the output stream refuses to grow past its budget (inputs + slack): nothing is written past it", async () => {
		const file = path.join(dir, "budget.bin");
		const handle = await fsp.open(file, "w");
		try {
			const writer = writableFor({ handle, maxBytes: 10 }).getWriter();
			await writer.write({ type: "write", data: new Uint8Array(6).fill(1), position: 0 });
			await writer.write({ type: "write", data: new Uint8Array(4).fill(2), position: 6 });
			let refusedCode = null;
			await writer.write({ type: "write", data: new Uint8Array(1).fill(3), position: 10 }).catch((error) => {
				refusedCode = error.code;
			});
			expect(refusedCode).toBe("bad-output");
		} finally {
			await handle.close();
		}
		expect([...(await fsp.readFile(file))]).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
	});
});

describe("takeVideoNext: interleaving by presentation time", () => {
	const at = (timestamp) => ({ timestamp });
	test("the earlier packet goes first; a tie goes to the video; when one track is done the other continues", () => {
		expect(takeVideoNext({ videoPacket: at(0.1), audioPacket: at(0.2), videoMax: -Infinity })).toBe(true);
		expect(takeVideoNext({ videoPacket: at(0.3), audioPacket: at(0.2), videoMax: -Infinity })).toBe(false);
		expect(takeVideoNext({ videoPacket: at(0.2), audioPacket: at(0.2), videoMax: -Infinity })).toBe(true);
		expect(takeVideoNext({ videoPacket: null, audioPacket: at(0.2), videoMax: 5 })).toBe(false);
		expect(takeVideoNext({ videoPacket: at(9), audioPacket: null, videoMax: 9 })).toBe(true);
	});

	test("B-frames: a video packet whose timestamp goes back does not pull the video ahead of where it already is", () => {
		// decode order I(0) P(0.3) B(0.1): after P the video is at 0.3 even though B says 0.1
		expect(takeVideoNext({ videoPacket: at(0.1), audioPacket: at(0.2), videoMax: 0.3 })).toBe(false);
		expect(takeVideoNext({ videoPacket: at(0.1), audioPacket: at(0.35), videoMax: 0.3 })).toBe(true);
	});
});

describe("muxPair: cancel", () => {
	test("cancelled while copying: code cancelled, the partial output is deleted", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		const controller = new AbortController();
		const code = await muxError(
			muxPair({
				video,
				audio,
				outPath: out,
				signal: controller.signal,
				onProgress: ({ fraction }) => {
					if (fraction > 0) controller.abort();
				},
			}),
		);
		expect(code).toBe("cancelled");
		expect(fs.existsSync(out)).toBe(false);
	});

	test("cancelled before it starts: nothing is opened or created", async () => {
		const video = await input("video-frag.mp4");
		const audio = await input("audio-frag.m4a");
		const out = await prepareFinal();
		const controller = new AbortController();
		controller.abort();
		expect(await muxError(muxPair({ video, audio, outPath: out, signal: controller.signal }))).toBe("cancelled");
		expect(fs.readdirSync(path.join(dir, "final"))).toEqual([]);
	});
});

describe("mediabunny is loaded from one absolute path chosen by the main process, never by a bare require", () => {
	test("loadMediabunny loads exactly the absolute path it is given; no path, or a relative one, is refused", async () => {
		await fsp.mkdir(path.join(dir, "vendor"));
		await fsp.writeFile(path.join(dir, "vendor", "mediabunny.cjs"), "module.exports = { vendored: true };");
		expect(loadMediabunny({ modulePath: path.join(dir, "vendor", "mediabunny.cjs") }).vendored).toBe(true);
		for (const modulePath of [undefined, null, "", "mediabunny", "vendor/mediabunny.cjs", 5]) {
			expect(() => loadMediabunny({ modulePath })).toThrow(MuxError);
		}
		expect(await muxError(muxPairWith({ video: await input("video-frag.mp4"), audio: await input("audio-frag.m4a"), outPath: await prepareFinal() }))).toBe("bad-output");
	});

	test("resolveMediabunnyPath: the vendored bundle next to the worker; in the packaged app nothing else (no search path), in the repository the installed package", async () => {
		expect(resolveMediabunnyPath({ workerDir: dir, packaged: true })).toBeNull();
		expect(resolveMediabunnyPath({ workerDir: dir, packaged: false })).toBe(MB_PATH);
		await fsp.mkdir(path.join(dir, "vendor"));
		await fsp.writeFile(path.join(dir, "vendor", "mediabunny.cjs"), "module.exports = {};");
		expect(resolveMediabunnyPath({ workerDir: dir, packaged: true })).toBe(path.join(dir, "vendor", "mediabunny.cjs"));
		expect(resolveMediabunnyPath({ workerDir: dir, packaged: false })).toBe(path.join(dir, "vendor", "mediabunny.cjs"));
	});

	test("without a module path no worker is started (the job falls back to one file)", async () => {
		let started = 0;
		class CountingWorker {
			constructor() {
				started++;
			}
		}
		const outcome = await runMuxWorkerWith({ job: { video: {}, audio: {}, outPath: "/o" }, mediabunnyPath: null, WorkerClass: CountingWorker }).done;
		expect(outcome).toMatchObject({ ok: false, reason: "failed" });
		expect(started).toBe(0);
	});

	test("the real worker itself, started with a bare 'mediabunny' as its module path, refuses it (no module search)", async () => {
		const { Worker } = require("node:worker_threads");
		const job = { video: await input("video-frag.mp4"), audio: await input("audio-frag.m4a"), outPath: await prepareFinal() };
		const worker = new Worker(muxWorkerPath(), { workerData: { kind: "ccut-link-import-mux", job, mediabunnyPath: "mediabunny" } });
		try {
			const message = await new Promise((resolve) => worker.on("message", resolve));
			expect(message).toMatchObject({ type: "error", code: "bad-output" });
			expect(message.detail).toContain("no mediabunny module path");
		} finally {
			await worker.terminate();
		}
		expect(fs.existsSync(outPath())).toBe(false);
	});

	test("the runner refuses a non-absolute module path before starting a worker", async () => {
		const outcome = await runMuxWorkerWith({ job: {}, mediabunnyPath: "mediabunny", WorkerClass: class {} }).done;
		expect(outcome).toMatchObject({ ok: false, reason: "failed", code: "bad-output" });
	});

	test("the installed package is the same 1.41.0 the web app uses", () => {
		const loaded = loadMediabunny({ modulePath: MB_PATH });
		expect(typeof loaded.EncodedPacketSink).toBe("function");
		const web = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "web", "package.json"), "utf8"));
		const installed = JSON.parse(fs.readFileSync(path.resolve(path.dirname(require.resolve("mediabunny")), "..", "..", "package.json"), "utf8"));
		expect(installed.version).toBe(web.dependencies.mediabunny);
	});
});

describe("runMuxWorker: the worker thread, its limits and its end", () => {
	const job = async () => ({ video: await input("video-frag.mp4"), audio: await input("audio-frag.m4a"), outPath: await prepareFinal() });

	test("the real worker muxes the pair; progress is reported 0..1", async () => {
		const progress = [];
		const run = runMuxWorker({ job: await job(), onProgress: (fraction) => progress.push(fraction) });
		const outcome = await run.done;
		expect(outcome).toMatchObject({ ok: true, result: { packets: 55, shift: 0, width: 128, height: 72 } });
		expect((await fsp.readFile(outPath())).subarray(4, 8).toString("latin1")).toBe("ftyp");
		expect(progress.at(-1)).toBe(1);
		expect(progress.every((f) => f >= 0 && f <= 1)).toBe(true);
	});

	test("the real worker refuses a wrong codec: failed with bad-output, no file", async () => {
		const run = runMuxWorker({ job: { ...(await job()), video: await input("video-vp9.mp4") } });
		expect(await run.done).toMatchObject({ ok: false, reason: "failed", code: "bad-output" });
		expect(fs.existsSync(outPath())).toBe(false);
	});

	test("the heap cap and the worker data are passed to the Worker", async () => {
		const seen = [];
		class FakeWorker {
			constructor(file, options) {
				seen.push({ file, options });
				this.handlers = {};
				setTimeout(() => this.handlers.message?.({ type: "done", result: { packets: 1, shift: 0, width: 2, height: 2, duration: 1 } }), 5);
			}
			on(name, handler) {
				this.handlers[name] = handler;
			}
			postMessage() {}
			terminate() {
				return Promise.resolve(0);
			}
		}
		const data = { video: { path: "/v" }, audio: { path: "/a" }, outPath: "/o" };
		const outcome = await runMuxWorker({ job: data, WorkerClass: FakeWorker, workerPath: "/w.js", limits: { heapMb: 123 } }).done;
		expect(outcome.ok).toBe(true);
		expect(seen).toEqual([{ file: "/w.js", options: { workerData: { kind: "ccut-link-import-mux", job: data, mediabunnyPath: MB_PATH }, resourceLimits: { maxOldGenerationSizeMb: 123 } } }]);
		expect(MUX_RUN_LIMITS).toEqual({ wallMs: 10 * 60 * 1000, idleMs: 60 * 1000, killGraceMs: 3000, heapMb: 384, terminateWaitMs: 5000 });
	});

	test("the outcome is reported only after terminate() has finished (Windows: no open handles when the job deletes files), but not waited on forever", async () => {
		const events = [];
		const fakeWorker = ({ terminateMs }) =>
			class {
				constructor() {
					this.handlers = {};
					setTimeout(() => this.handlers.message?.({ type: "error", code: "bad-output" }), 5);
				}
				on(name, handler) {
					this.handlers[name] = handler;
				}
				postMessage() {}
				terminate() {
					events.push("terminate called");
					return terminateMs === null ? new Promise(() => {}) : new Promise((resolve) => setTimeout(() => resolve(events.push("terminated")), terminateMs));
				}
			};
		const outcome = await runMuxWorker({ job: {}, WorkerClass: fakeWorker({ terminateMs: 100 }), workerPath: "/w.js" }).done;
		events.push("settled");
		expect(outcome).toMatchObject({ ok: false, reason: "failed" });
		expect(events).toEqual(["terminate called", "terminated", "settled"]);
		events.length = 0;
		const t0 = Date.now();
		await runMuxWorker({ job: {}, WorkerClass: fakeWorker({ terminateMs: null }), workerPath: "/w.js", limits: { terminateWaitMs: 150 } }).done;
		expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	test("a done that arrives after a cancel, idle or timeout stop is not a success", async () => {
		const run = runMuxWorker({ job: { stub: "late-done" }, workerPath: STUB });
		await new Promise((resolve) => setTimeout(resolve, 100));
		run.cancel();
		expect(await run.done).toMatchObject({ ok: false, reason: "cancelled" });
		expect(await runMuxWorker({ job: { stub: "late-done" }, workerPath: STUB, limits: { idleMs: 150 } }).done).toMatchObject({ ok: false, reason: "idle" });
	});

	test("cancel: the worker is asked to stop and answers cancelled", async () => {
		const run = runMuxWorker({ job: { stub: "obey" }, workerPath: STUB });
		await new Promise((resolve) => setTimeout(resolve, 100));
		run.cancel();
		expect(await run.done).toMatchObject({ ok: false, reason: "cancelled" });
	});

	test("cancel: a worker that ignores it is terminated after the grace period", async () => {
		const run = runMuxWorker({ job: { stub: "hang" }, workerPath: STUB, limits: { killGraceMs: 200 } });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const t0 = Date.now();
		run.cancel();
		expect(await run.done).toMatchObject({ ok: false, reason: "cancelled" });
		expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
	});

	test("no progress for the idle limit: stopped as idle; endless progress past the wall-time limit: stopped as timeout", async () => {
		expect(await runMuxWorker({ job: { stub: "silent" }, workerPath: STUB, limits: { idleMs: 200, killGraceMs: 100 } }).done).toMatchObject({ ok: false, reason: "idle" });
		expect(await runMuxWorker({ job: { stub: "slow" }, workerPath: STUB, limits: { wallMs: 300, idleMs: 5000, killGraceMs: 100 } }).done).toMatchObject({ ok: false, reason: "timeout" });
	});

	test("a worker that throws or exits on its own: crashed (never ok)", async () => {
		expect(await runMuxWorker({ job: { stub: "crash" }, workerPath: STUB }).done).toMatchObject({ ok: false, reason: "crashed" });
		expect(await runMuxWorker({ job: { stub: "exit" }, workerPath: STUB }).done).toMatchObject({ ok: false, reason: "crashed" });
	});

	test("a done message with a malformed result is not a success", async () => {
		expect(await runMuxWorker({ job: { stub: "bad-done" }, workerPath: STUB }).done).toMatchObject({ ok: false, reason: "failed", code: "bad-output" });
	});

	test("malformed messages are ignored; out-of-range fractions never reach the caller", async () => {
		const progress = [];
		const outcome = await runMuxWorker({ job: { stub: "garbage" }, workerPath: STUB, onProgress: (f) => progress.push(f) }).done;
		expect(outcome.ok).toBe(true);
		expect(progress).toEqual([]);
	});

	test("terminate (app quit): ends at once as cancelled", async () => {
		const run = runMuxWorker({ job: { stub: "hang" }, workerPath: STUB });
		await new Promise((resolve) => setTimeout(resolve, 50));
		run.terminate();
		expect(await run.done).toMatchObject({ ok: false, reason: "cancelled" });
	});
});

describe("muxWorkerPath: the worker runs from outside app.asar in the packaged app", () => {
	test("app.asar -> app.asar.unpacked; other paths unchanged", () => {
		expect(muxWorkerPath({ dir: "/opt/Ccut/resources/app.asar" })).toBe(path.join("/opt/Ccut/resources/app.asar.unpacked", "link-import-mux-worker.js"));
		expect(muxWorkerPath({ dir: "C:\\Ccut\\resources\\app.asar" })).toBe(path.join("C:\\Ccut\\resources\\app.asar.unpacked", "link-import-mux-worker.js"));
		expect(muxWorkerPath({ dir: "/src/apps/electron" })).toBe(path.join("/src/apps/electron", "link-import-mux-worker.js"));
		expect(muxWorkerPath({ dir: "/x/app.asarx" })).toBe(path.join("/x/app.asarx", "link-import-mux-worker.js"));
	});
});

describe("shipping mediabunny to the main process (bundle.js -> vendor/mediabunny.cjs)", () => {
	const WEB = path.join(__dirname, "..", "..", "web");
	// inside the repository (test/out is git-ignored) so the package resolves from there
	const repoTemp = () => {
		fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
		return fs.mkdtempSync(path.join(__dirname, "out", "vendor-"));
	};

	test("the package's own CJS bundle is copied unmodified, only at the version apps/web pins", async () => {
		const target = repoTemp();
		try {
			const { version, file } = vendorMediabunny({ webDir: WEB, targetDir: target });
			expect(version).toBe(JSON.parse(fs.readFileSync(path.join(WEB, "package.json"), "utf8")).dependencies.mediabunny);
			expect(file).toBe(path.join(target, VENDOR_FILE));
			expect(fs.readFileSync(file).equals(fs.readFileSync(require.resolve("mediabunny")))).toBe(true);
			expect(path.basename(require.resolve("mediabunny"))).toBe("mediabunny.cjs");
		} finally {
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	test("the bundle's sha256 is pinned (checked against the npm tarball of mediabunny 1.41.0); another file is refused, nothing copied", () => {
		expect(MEDIABUNNY_CJS_SHA256).toBe("8fe8bf0510bd5e522cfe59fe9bceb6ba6d8534389e7cbdb049a6d13cc6a819e4");
		expect(crypto.createHash("sha256").update(fs.readFileSync(require.resolve("mediabunny"))).digest("hex")).toBe(MEDIABUNNY_CJS_SHA256);
		const target = repoTemp();
		try {
			expect(() => vendorMediabunny({ webDir: WEB, targetDir: target, expectedSha256: "0".repeat(64) })).toThrow("sha256");
			expect(fs.existsSync(path.join(target, VENDOR_FILE))).toBe(false);
		} finally {
			fs.rmSync(target, { recursive: true, force: true });
		}
	});

	test("another version pinned than installed: refused, nothing copied", () => {
		const web = repoTemp();
		try {
			fs.writeFileSync(path.join(web, "package.json"), JSON.stringify({ dependencies: { mediabunny: "9.9.9" } }));
			expect(() => vendorMediabunny({ webDir: web, targetDir: web })).toThrow("apps/web pins 9.9.9");
			expect(fs.existsSync(path.join(web, VENDOR_FILE))).toBe(false);
		} finally {
			fs.rmSync(web, { recursive: true, force: true });
		}
	});

	test("the packaged layout: the worker next to vendor/mediabunny.cjs, where the package itself cannot be found, muxes the pair", async () => {
		const app = path.join(dir, "app.asar.unpacked");
		fs.mkdirSync(app);
		fs.copyFileSync(path.join(__dirname, "..", "link-import-mux-worker.js"), path.join(app, "link-import-mux-worker.js"));
		const web = repoTemp();
		try {
			const { file } = vendorMediabunny({ webDir: WEB, targetDir: web });
			fs.mkdirSync(path.join(app, "vendor"));
			fs.copyFileSync(file, path.join(app, VENDOR_FILE));
		} finally {
			fs.rmSync(web, { recursive: true, force: true });
		}
		expect(() => require.resolve("mediabunny", { paths: [app] })).toThrow();
		const job = { video: await input("video-frag.mp4"), audio: await input("audio-frag.m4a"), outPath: await prepareFinal() };
		const workerPath = muxWorkerPath({ dir: path.join(dir, "app.asar") });
		const mediabunnyPath = resolveMediabunnyPath({ workerDir: path.dirname(workerPath), packaged: true });
		expect(mediabunnyPath).toBe(path.join(app, VENDOR_FILE));
		const outcome = await runMuxWorkerWith({ job, workerPath, mediabunnyPath }).done;
		expect(outcome).toMatchObject({ ok: true, result: { packets: 55 } });
	});
});
