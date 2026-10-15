// Deterministic test clips for the playback harness and script/make-perf-clips.js: ffmpeg
// testsrc2 (+ a sine tone), 1920x1080, 30 fps, H.264 High yuv420p, GOP 2 s without scene-cut key
// frames, AAC, faststart, no metadata, a fixed encoder thread count. The same ffmpeg build gives
// the same bytes. Pure helpers plus one glue function whose process/file access is injected.
const crypto = require("node:crypto");
const path = require("node:path");

const CLIP_DEFAULTS = Object.freeze({ width: 1920, height: 1080, fps: 30, seconds: 20, gopFrames: 60, sampleRate: 48000, threads: 4 });

// Two different pictures (b is hue-shifted) and tones: two media, two decoders.
const CLIPS = Object.freeze([
	Object.freeze({ id: "a", file: "perf-a-1080p30.mp4", hue: 0, toneHz: 440 }),
	Object.freeze({ id: "b", file: "perf-b-1080p30.mp4", hue: 180, toneHz: 660 }),
]);

const DURATION_TOLERANCE_S = 0.1;
const KEYFRAME_TOLERANCE_S = 0.01;
const MAX_BOXES = 64;

function clipSpecs({ seconds }) {
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error(`clip seconds must be a whole number in 1..3600, got ${seconds}`);
	const { width, height, fps, gopFrames, sampleRate, threads } = CLIP_DEFAULTS;
	return CLIPS.map((clip) => ({ ...clip, width, height, fps, seconds, gopFrames, sampleRate, threads }));
}

function ffmpegArgs({ spec, outFile }) {
	const gop = String(spec.gopFrames);
	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=${spec.width}x${spec.height}:rate=${spec.fps}:duration=${spec.seconds}`,
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=${spec.toneHz}:sample_rate=${spec.sampleRate}:duration=${spec.seconds}`,
		"-map",
		"0:v:0",
		"-map",
		"1:a:0",
		...(spec.hue ? ["-vf", `hue=h=${spec.hue}`] : []),
		"-c:v",
		"libx264",
		"-profile:v",
		"high",
		"-preset",
		"medium",
		"-pix_fmt",
		"yuv420p",
		"-threads",
		String(spec.threads),
		"-g",
		gop,
		"-keyint_min",
		gop,
		"-sc_threshold",
		"0",
		"-r",
		String(spec.fps),
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-ac",
		"2",
		"-shortest",
		"-map_metadata",
		"-1",
		"-fflags",
		"+bitexact",
		"-flags:v",
		"+bitexact",
		"-flags:a",
		"+bitexact",
		"-movflags",
		"+faststart",
		outFile,
	];
}

/** `ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0` -> sorted key frame times. */
function parseKeyframeTimes(text) {
	const times = [];
	for (const line of String(text ?? "").split("\n")) {
		const [time, flags] = line.trim().split(",");
		const value = Number(time);
		if (flags && flags.startsWith("K") && time !== "" && Number.isFinite(value)) times.push(value);
	}
	return times.sort((a, b) => a - b);
}

/** Top-level MP4 box types in file order, read through `readAt({ offset, length })` (a Buffer). */
function boxOrder({ size, readAt, maxBoxes = MAX_BOXES }) {
	const types = [];
	let offset = 0;
	for (let i = 0; i < maxBoxes && offset + 8 <= size; i++) {
		const header = readAt({ offset, length: Math.min(16, size - offset) });
		const size32 = header.readUInt32BE(0);
		const type = header.toString("latin1", 4, 8);
		if (size32 === 0) {
			types.push(type);
			break;
		}
		let boxSize = size32;
		let headerSize = 8;
		if (size32 === 1) {
			if (header.length < 16) break;
			boxSize = Number(header.readBigUInt64BE(8));
			headerSize = 16;
		}
		if (!Number.isSafeInteger(boxSize) || boxSize < headerSize) break;
		types.push(type);
		offset += boxSize;
	}
	return types;
}

/** ffprobe facts of one clip against its spec -> { problems: string[], facts }. */
function checkClip({ spec, probe, keyframeTimes, boxes }) {
	const problems = [];
	const streams = Array.isArray(probe?.streams) ? probe.streams : [];
	const video = streams.find((stream) => stream.codec_type === "video");
	const audio = streams.find((stream) => stream.codec_type === "audio");
	if (!video) return { problems: ["no video stream"], facts: null };
	const [num, den] = String(video.avg_frame_rate ?? "").split("/").map(Number);
	const fps = den > 0 ? num / den : null;
	const durationS = Number(probe.format?.duration ?? video.duration);
	const intervals = keyframeTimes.slice(1).map((time, i) => time - keyframeTimes[i]);
	const gopS = spec.gopFrames / spec.fps;
	const faststart = boxes.includes("moov") && boxes.includes("mdat") && boxes.indexOf("moov") < boxes.indexOf("mdat");
	const facts = {
		codec: video.codec_name,
		profile: video.profile,
		pixFmt: video.pix_fmt,
		width: video.width,
		height: video.height,
		fps,
		durationS,
		bitrateMbps: Number(probe.format?.bit_rate) / 1e6 || null,
		keyframes: keyframeTimes.length,
		keyframeIntervalS: intervals.length > 0 ? Number(intervals[0].toFixed(3)) : null,
		audio: audio ? `${audio.codec_name} ${audio.sample_rate} Hz ${audio.channels} ch` : null,
		faststart,
	};
	if (video.codec_name !== "h264") problems.push(`codec ${video.codec_name}, expected h264`);
	if (video.profile !== "High") problems.push(`profile ${video.profile}, expected High`);
	if (video.pix_fmt !== "yuv420p") problems.push(`pix_fmt ${video.pix_fmt}, expected yuv420p`);
	if (video.width !== spec.width || video.height !== spec.height) problems.push(`size ${video.width}x${video.height}, expected ${spec.width}x${spec.height}`);
	if (fps === null || Math.abs(fps - spec.fps) > 0.01) problems.push(`fps ${video.avg_frame_rate}, expected ${spec.fps}`);
	if (!(Math.abs(durationS - spec.seconds) <= DURATION_TOLERANCE_S)) problems.push(`duration ${durationS} s, expected ${spec.seconds} s`);
	if (!audio || audio.codec_name !== "aac") problems.push("audio: no AAC track");
	if (keyframeTimes.length === 0 || keyframeTimes[0] > KEYFRAME_TOLERANCE_S) problems.push("key frame: none at 0 s");
	else if (intervals.some((interval) => Math.abs(interval - gopS) > KEYFRAME_TOLERANCE_S)) problems.push(`key frame interval not ${gopS} s: ${intervals.map((i) => i.toFixed(2)).join(",")}`);
	if (!faststart) problems.push(`faststart: moov is not before mdat (${boxes.join(",")})`);
	return { problems, facts };
}

function tail(buffer) {
	return String(buffer ?? "").trim().slice(-600);
}

/** Encodes and checks both clips into `dir`. spawnSync/fs are Node's (injected for tests). */
function generateClips({ dir, seconds, spawnSync, fs, log, ffmpeg = "ffmpeg", ffprobe = "ffprobe" }) {
	fs.mkdirSync(dir, { recursive: true });
	const clips = [];
	const problems = [];
	for (const spec of clipSpecs({ seconds })) {
		const file = path.join(dir, spec.file);
		log(`encoding ${spec.file} (${seconds} s, ${spec.width}x${spec.height} ${spec.fps} fps)`);
		const encode = spawnSync(ffmpeg, ffmpegArgs({ spec, outFile: file }), { maxBuffer: 1 << 26 });
		if (encode.error || encode.status !== 0) throw new Error(`ffmpeg failed for ${spec.file}: ${encode.error ? encode.error.message : tail(encode.stderr)}`);
		const probe = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { maxBuffer: 1 << 26 });
		const packets = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file], { maxBuffer: 1 << 26 });
		if (probe.error || probe.status !== 0 || packets.error || packets.status !== 0) throw new Error(`ffprobe failed for ${spec.file}: ${tail(probe.stderr)} ${tail(packets.stderr)}`);
		const size = fs.statSync(file).size;
		const fd = fs.openSync(file, "r");
		let boxes;
		try {
			boxes = boxOrder({
				size,
				readAt: ({ offset, length }) => {
					const buffer = Buffer.alloc(length);
					fs.readSync(fd, buffer, 0, length, offset);
					return buffer;
				},
			});
		} finally {
			fs.closeSync(fd);
		}
		const checked = checkClip({ spec, probe: JSON.parse(String(probe.stdout)), keyframeTimes: parseKeyframeTimes(String(packets.stdout)), boxes });
		const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		problems.push(...checked.problems.map((problem) => `${spec.file}: ${problem}`));
		clips.push({ id: spec.id, file, facts: { ...checked.facts, sizeBytes: size, sha256 } });
	}
	return { clips, problems };
}

/** script/make-perf-clips.js arguments: <outDir> [--seconds N]. Throws on anything else. */
function parseClipArgs(argv) {
	let dir = null;
	let seconds = CLIP_DEFAULTS.seconds;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--seconds") {
			const value = argv[i + 1];
			if (value === undefined || !/^\d+$/.test(value)) throw new Error("--seconds needs a whole number");
			seconds = Number(value);
			i += 1;
		} else if (arg.startsWith("-")) {
			throw new Error(`unknown option ${arg}`);
		} else if (dir === null) {
			dir = arg;
		} else {
			throw new Error(`one output directory only (got ${dir} and ${arg})`);
		}
	}
	if (dir === null) throw new Error("usage: node script/make-perf-clips.js <outDir> [--seconds N]");
	clipSpecs({ seconds });
	return { dir, seconds };
}

module.exports = { CLIP_DEFAULTS, CLIPS, boxOrder, checkClip, clipSpecs, ffmpegArgs, generateClips, parseClipArgs, parseKeyframeTimes };
