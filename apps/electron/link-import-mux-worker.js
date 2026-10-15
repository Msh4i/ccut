// "Import from link", the pair's last step, run in a worker_threads Worker of the main process
// (link-import-mux.js starts it): an H.264 video-only MP4 and an AAC m4a audio-only file become
// ONE MP4 by copying their encoded packets with mediabunny. Nothing is decoded or re-encoded.
//
// - mediabunny is loaded from the one absolute path the main process gives (the vendored CJS
//   bundle in the packaged app); never by its package name, whose module search could reach a
//   directory others can write to (an AppImage mounts under /tmp).
// - Inputs are opened by this module without following links and without blocking (O_NOFOLLOW,
//   O_NONBLOCK: a FIFO swapped in cannot hang a thread) and must still be the regular files the
//   job checked: size, device and file id compared exactly (bigint; on Windows the file index and
//   the volume serial). mediabunny reads them through a StreamSource over those handles; only its
//   ISOBMFF/MP4 demuxer is enabled. (mediabunny's FilePathSource/FilePathTarget open by path with
//   'r'/'w': they would follow a link and truncate an existing file, so they are not used.)
// - Each input must have exactly one track: avc video, aac audio, with a decoder config.
// - Bounded by BYTES, not only by packets: one read is at most maxReadBytes (a huge declared
//   sample or box is refused, not allocated); the packets of a track add up to at most its file's
//   size (a sample table that points many samples at the same bytes is refused); the bytes one
//   muxer chunk holds are at most maxChunkBytes per track (mediabunny keeps a chunk's packet data
//   until the chunk spans 0.5 s: samples with squeezed timestamps would all pile up); the output
//   may not grow past both inputs + outputSlackBytes; at most maxPackets packets. mediabunny's
//   buffers are ArrayBuffers outside the worker's V8 heap cap, so these are what bound memory
//   and disk for hostile input.
// - The output is created new (O_CREAT|O_EXCL|O_NOFOLLOW, 0600); moov at the end
//   (fastStart: false), so only the sample tables stay in memory, written in 4 MiB chunks.
// - Packets are read one at a time (getFirstPacket/getNextPacket; mediabunny's packets()
//   iterator reads ahead "one second of consumption", i.e. as many bytes as the disk delivers
//   in a second) and interleaved by timestamp. mediabunny's muxer refuses negative timestamps
//   and writes no edit list: when a track starts before 0 (an AAC priming edit list), BOTH
//   tracks are moved by the same amount, so sync holds and no packet is dropped.
// - Every failure is a MuxError: "cancelled", or "bad-output" for anything else (mediabunny's
//   own errors included). A partial output is deleted when this code gets to run its cleanup;
//   after terminate() it cannot, and the job deletes final/ instead.
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const workerThreads = require("node:worker_threads");

const WORKER_KIND = "ccut-link-import-mux";

const MUX_LIMITS = Object.freeze({
	maxDurationSeconds: 6 * 3600,
	maxDimension: 8192,
	// About 0.2 KiB of sample table per packet stays in memory until the end: 1,000,000
	// packets is 2.7 h of 60 fps video with its audio. Longer videos fall back to one file.
	maxPackets: 1_000_000,
	cacheBytes: 4 * 1024 * 1024,
	chunkBytes: 4 * 1024 * 1024,
	// YouTube's DASH inputs are fragmented: their moov/moof boxes are small, a 4K key frame is a
	// few MiB. Measured (Node 22): legit 1080p/244 MB/20 min/935k-packet inputs unchanged, the
	// worst squeezed-samples input 187 MiB peak instead of 319 MiB at 64 MiB. A non-fragmented
	// input whose sample table needs a larger read is refused (the job uses one file instead).
	maxReadBytes: 16 * 1024 * 1024,
	// The output's own moov (sample tables) on top of the inputs' bytes.
	outputSlackBytes: 64 * 1024 * 1024,
	// Packet data the muxer holds for one track's open chunk (0.5 s of media: a few MiB in real files).
	maxChunkBytes: 64 * 1024 * 1024,
});

// mediabunny 1.41.0's non-fragmented MP4 muxer (dist/bundles/mediabunny.cjs): a chunk's start is
// the earliest timestamp in it (:23073) and a new chunk begins when the next sample is >= 0.5 s
// after that (:23094); only then is the old chunk written and its packet data released (:23138).
const MUXER_CHUNK_SECONDS = 0.5;

/** Bytes held by one track's open muxer chunk, as the muxer counts them. Throws past maxBytes. */
function chunkCounter({ role, maxBytes }) {
	let start = null;
	let bytes = 0;
	return (packet) => {
		const t = packet.timestamp;
		if (start === null) start = t;
		else {
			start = Math.min(start, t);
			if (t - start >= MUXER_CHUNK_SECONDS) {
				start = t;
				bytes = 0;
			}
		}
		bytes += packet.data.byteLength;
		if (bytes > maxBytes) throw badOutput(`more than ${maxBytes} bytes of ${role} in half a second`);
	};
}

class MuxError extends Error {
	constructor({ code, detail = "" }) {
		super(`link import mux: ${code}${detail ? ` (${detail})` : ""}`);
		this.name = "MuxError";
		this.code = code;
	}
}

const badOutput = (detail) => new MuxError({ code: "bad-output", detail });

/** mediabunny from exactly this absolute path (the vendored bundle, or the package in the repository). */
function loadMediabunny({ modulePath }) {
	if (typeof modulePath !== "string" || !path.isAbsolute(modulePath)) throw badOutput("no mediabunny module path");
	return require(modulePath);
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * Opens a checked input ({ path, size, dev, ino }, dev/ino as decimal strings) without following
 * a link or blocking; it must still be the same regular file.
 */
async function openInput({ fsApi, file, platform }) {
	const flags = platform === "win32" ? "r" : fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK;
	const handle = await fsApi.open(file.path, flags);
	try {
		const stat = await handle.stat({ bigint: true });
		const same = stat.isFile() && stat.size === BigInt(file.size) && String(stat.ino) === String(file.ino) && String(stat.dev) === String(file.dev);
		if (!same) throw badOutput("an input changed after the check");
		return handle;
	} catch (error) {
		await handle.close().catch(() => {});
		throw error;
	}
}

/** Reads exactly end - start bytes (fewer only at the end of the file), at most maxReadBytes. */
async function readRange({ handle, size, start, end, maxReadBytes }) {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size) throw badOutput("read outside the file");
	if (end - start > maxReadBytes) throw badOutput(`one read of ${end - start} bytes`);
	const length = end - start;
	const bytes = new Uint8Array(length);
	let done = 0;
	for (let round = 0; done < length && round <= length; round++) {
		const { bytesRead } = await handle.read(bytes, done, length - done, start + done);
		if (bytesRead === 0) break;
		done += bytesRead;
	}
	return done === length ? bytes : bytes.subarray(0, done);
}

function sourceFor({ MB, handle, size, limits }) {
	return new MB.StreamSource({
		getSize: () => size,
		read: (start, end) => readRange({ handle, size, start, end, maxReadBytes: limits.maxReadBytes }),
		maxCacheSize: limits.cacheBytes,
		prefetchProfile: "fileSystem",
	});
}

/**
 * A WritableStream for mediabunny's StreamTarget: each chunk written in full at its position,
 * and nothing at or past maxBytes.
 */
function writableFor({ handle, maxBytes }) {
	return new WritableStream({
		write: async (chunk) => {
			const { data, position } = chunk;
			if (position + data.byteLength > maxBytes) throw badOutput("the output grows past its inputs");
			let done = 0;
			for (let round = 0; done < data.byteLength && round <= data.byteLength; round++) {
				const { bytesWritten } = await handle.write(data, done, data.byteLength - done, position + done);
				if (bytesWritten <= 0) break;
				done += bytesWritten;
			}
			if (done !== data.byteLength) throw badOutput("short write");
		},
	});
}

async function onlyTrack({ input, type, codec }) {
	const tracks = await input.getTracks();
	if (tracks.length !== 1) throw badOutput(`${type} input has ${tracks.length} tracks`);
	const [track] = tracks;
	if (track.type !== type || track.codec !== codec) throw badOutput(`expected ${type}/${codec}, got ${track.type}/${track.codec}`);
	const decoderConfig = await track.getDecoderConfig();
	if (!decoderConfig) throw badOutput(`${type} has no decoder config`);
	return { track, decoderConfig };
}

/**
 * Interleaving by presentation time: the video packet goes next when it is not later than the
 * audio packet. Video comes in decode order (B-frames: timestamps go back and forth), so the
 * largest video timestamp so far stands for "where the video is".
 */
function takeVideoNext({ videoPacket, audioPacket, videoMax }) {
	if (!videoPacket) return false;
	if (!audioPacket) return true;
	return Math.max(videoMax, videoPacket.timestamp) <= audioPacket.timestamp;
}

/** One packet at a time in decode order: no read-ahead queue. */
function packetStepper({ MB, track, options }) {
	const sink = new MB.EncodedPacketSink(track);
	let current = null;
	let started = false;
	return async () => {
		current = started ? current && (await sink.getNextPacket(current, options)) : await sink.getFirstPacket(options);
		started = true;
		return current;
	};
}

/** Step 1: both inputs opened, checked and parsed; their timing. Handles and inputs go into `opened`. */
async function openInputs({ MB, video, audio, platform, limits, fsApi, opened }) {
	const parse = async ({ file, type, codec }) => {
		const handle = await openInput({ fsApi, file, platform });
		opened.handles.push(handle);
		const input = new MB.Input({ source: sourceFor({ MB, handle, size: file.size, limits }), formats: [MB.MP4] });
		opened.inputs.push(input);
		return onlyTrack({ input, type, codec });
	};
	const v = await parse({ file: video, type: "video", codec: "avc" });
	const a = await parse({ file: audio, type: "audio", codec: "aac" });
	if (v.track.codedWidth > limits.maxDimension || v.track.codedHeight > limits.maxDimension) throw badOutput("dimensions");
	const videoFirst = await v.track.getFirstTimestamp();
	const audioFirst = await a.track.getFirstTimestamp();
	const end = Math.max(await v.track.computeDuration(), await a.track.computeDuration());
	if (!Number.isFinite(videoFirst) || !Number.isFinite(audioFirst) || !(end > 0) || end > limits.maxDurationSeconds) throw badOutput("duration");
	return { v, a, end, shift: Math.max(0, -Math.min(videoFirst, audioFirst)) };
}

/** Step 2: the new output file and mediabunny's Output with one video and one audio track. */
async function createOutput({ MB, outPath, platform, maxBytes, limits, fsApi, v, a }) {
	const flags = platform === "win32" ? "wx" : fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW;
	const handle = await fsApi.open(outPath, flags, 0o600);
	const output = new MB.Output({
		format: new MB.Mp4OutputFormat({ fastStart: false }),
		target: new MB.StreamTarget(writableFor({ handle, maxBytes }), { chunked: true, chunkSize: limits.chunkBytes }),
	});
	const videoSource = new MB.EncodedVideoPacketSource("avc");
	const audioSource = new MB.EncodedAudioPacketSource("aac");
	output.addVideoTrack(videoSource, { rotation: v.track.rotation });
	output.addAudioTrack(audioSource, { languageCode: a.track.languageCode });
	return { handle, output, videoSource, audioSource };
}

/** Step 3: every packet, interleaved and moved by `shift`; each track's bytes within its file's size. */
async function copyPackets({ MB, parsed, sizes, target, limits, checkAbort, onProgress }) {
	const { v, a, end, shift } = parsed;
	const { output, videoSource, audioSource } = target;
	await output.start();
	const nextVideo = packetStepper({ MB, track: v.track, options: { verifyKeyPackets: true } });
	const nextAudio = packetStepper({ MB, track: a.track, options: {} });
	let videoPacket = await nextVideo();
	let audioPacket = await nextAudio();
	let videoMeta = { decoderConfig: v.decoderConfig };
	let audioMeta = { decoderConfig: a.decoderConfig };
	let videoMax = -Infinity;
	let videoBytes = 0;
	let audioBytes = 0;
	const videoChunk = chunkCounter({ role: "video", maxBytes: limits.maxChunkBytes });
	const audioChunk = chunkCounter({ role: "audio", maxBytes: limits.maxChunkBytes });
	let packets = 0;
	let reported = -1;
	const report = (fraction) => {
		if (fraction - reported < 0.01 && fraction !== 1) return;
		reported = fraction;
		onProgress({ fraction });
	};
	report(0);
	const moved = (packet) => (shift === 0 ? packet : packet.clone({ timestamp: packet.timestamp + shift }));
	// Interleaved by presentation time; decode order is kept inside each track. Every round
	// consumes one packet; the bound ends a file with more packets than the limit.
	for (let round = 0; videoPacket || audioPacket; round++) {
		if (round >= limits.maxPackets) throw badOutput("too many packets");
		checkAbort();
		if (takeVideoNext({ videoPacket, audioPacket, videoMax })) {
			videoBytes += videoPacket.data.byteLength;
			if (videoBytes > sizes.video) throw badOutput("the video packets add up to more than the video file");
			// The counter sees exactly the packet the muxer gets: t + shift is rounded, so the
			// unshifted difference can be 0.5 where the muxer's is 0.4999999999999999.
			const out = moved(videoPacket);
			videoChunk(out);
			videoMax = Math.max(videoMax, videoPacket.timestamp);
			await videoSource.add(out, videoMeta);
			videoMeta = undefined;
			videoPacket = await nextVideo();
		} else {
			audioBytes += audioPacket.data.byteLength;
			if (audioBytes > sizes.audio) throw badOutput("the audio packets add up to more than the audio file");
			const out = moved(audioPacket);
			audioChunk(out);
			await audioSource.add(out, audioMeta);
			audioMeta = undefined;
			audioPacket = await nextAudio();
		}
		packets++;
		const at = Math.min(videoPacket ? videoPacket.timestamp : end, audioPacket ? audioPacket.timestamp : end);
		report(Math.min(1, Math.max(0, at / end)) * 0.99);
	}
	videoSource.close();
	audioSource.close();
	await output.finalize();
	await target.handle.sync();
	report(1);
	return { packets, shift, width: v.track.displayWidth, height: v.track.displayHeight, duration: end + shift };
}

/**
 * Copies the packets of `video` and `audio` ({ path, size, dev, ino } as checked by the job)
 * into a new MP4 at `outPath`. Resolves { packets, shift, width, height, duration }; rejects
 * with a MuxError.
 */
async function muxPair({ video, audio, outPath, platform = process.platform, signal, onProgress = () => {}, limits = {}, mediabunnyPath, fsApi = fsp }) {
	const lim = { ...MUX_LIMITS, ...limits };
	const opened = { handles: [], inputs: [] };
	let target = null;
	let finished = false;
	const checkAbort = () => {
		if (signal && signal.aborted) throw new MuxError({ code: "cancelled" });
	};
	try {
		checkAbort();
		const MB = loadMediabunny({ modulePath: mediabunnyPath });
		const parsed = await openInputs({ MB, video, audio, platform, limits: lim, fsApi, opened });
		checkAbort();
		target = await createOutput({ MB, outPath, platform, maxBytes: video.size + audio.size + lim.outputSlackBytes, limits: lim, fsApi, v: parsed.v, a: parsed.a });
		const result = await copyPackets({ MB, parsed, sizes: { video: video.size, audio: audio.size }, target, limits: lim, checkAbort, onProgress });
		finished = true;
		return result;
	} catch (error) {
		if (error instanceof MuxError) throw error;
		throw badOutput(String(error && error.message ? error.message : error).slice(0, 300));
	} finally {
		const output = target && target.output;
		if (!finished && output && output.state !== "finalized" && output.state !== "canceled") await output.cancel().catch(() => {});
		for (const input of opened.inputs) input.dispose();
		if (target) await target.handle.close().catch(() => {});
		for (const handle of opened.handles) await handle.close().catch(() => {});
		// Only a file this call created is deleted (target is set only after O_EXCL succeeded).
		if (!finished && target) await fsApi.unlink(outPath).catch(() => {});
	}
}

/** The worker side: one job from workerData, "cancel" messages, progress/done/error replies. */
function startWorker({ parentPort, workerData }) {
	const controller = new AbortController();
	parentPort.on("message", (message) => {
		if (message && message.type === "cancel") controller.abort();
	});
	const { video, audio, outPath } = workerData.job;
	muxPair({ video, audio, outPath, mediabunnyPath: workerData.mediabunnyPath, signal: controller.signal, onProgress: ({ fraction }) => parentPort.postMessage({ type: "progress", fraction }) }).then(
		(result) => parentPort.postMessage({ type: "done", result }),
		(error) => parentPort.postMessage({ type: "error", code: error instanceof MuxError ? error.code : "bad-output", detail: String(error && error.message).slice(0, 300) }),
	);
}

if (!workerThreads.isMainThread && workerThreads.workerData && workerThreads.workerData.kind === WORKER_KIND) {
	startWorker({ parentPort: workerThreads.parentPort, workerData: workerThreads.workerData });
}

module.exports = { MUX_LIMITS, MuxError, WORKER_KIND, copyPackets, loadMediabunny, muxPair, takeVideoNext, writableFor };
