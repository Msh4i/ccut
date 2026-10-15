const { describe, expect, test } = require("bun:test");
const { CLIP_DEFAULTS, boxOrder, checkClip, clipSpecs, ffmpegArgs, generateClips, parseClipArgs, parseKeyframeTimes } = require("./perf/clips");

// The deterministic test clips of the playback harness: ffmpeg arguments, the ffprobe checks
// (codec, profile, size, fps, duration, key frame interval, faststart) and the generator glue.

const spec = () => clipSpecs({ seconds: 20 })[0];

function probeJson({ codec = "h264", profile = "High", pixFmt = "yuv420p", width = 1920, height = 1080, rate = "30/1", duration = "20.000000", audio = true } = {}) {
	return {
		streams: [
			{ codec_type: "video", codec_name: codec, profile, pix_fmt: pixFmt, width, height, avg_frame_rate: rate, r_frame_rate: rate, duration, bit_rate: "6220400" },
			...(audio ? [{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }] : []),
		],
		format: { duration, size: "15000000", bit_rate: "6400000" },
	};
}
const keyframes = (seconds, every = 2) => Array.from({ length: Math.ceil(seconds / every) }, (_, i) => i * every);
const goodClip = (overrides = {}) => ({ spec: spec(), probe: probeJson(), keyframeTimes: keyframes(20), boxes: ["ftyp", "moov", "mdat"], ...overrides });

describe("clipSpecs", () => {
	test("two different 1920x1080 30 fps clips with a 2 s GOP, the duration asked for", () => {
		const specs = clipSpecs({ seconds: 40 });
		expect(specs.map((s) => s.file)).toEqual(["perf-a-1080p30.mp4", "perf-b-1080p30.mp4"]);
		for (const s of specs) expect(s).toMatchObject({ width: 1920, height: 1080, fps: 30, seconds: 40, gopFrames: 60 });
		expect(specs[0].hue).not.toBe(specs[1].hue);
		expect(CLIP_DEFAULTS.seconds).toBe(20);
	});

	test("durations outside 1..3600 whole seconds are refused", () => {
		for (const seconds of [0, -1, 1.5, 3601, Number.NaN, "20"]) expect(() => clipSpecs({ seconds })).toThrow("seconds");
	});
});

describe("ffmpegArgs", () => {
	test("testsrc2 + sine, H.264 High yuv420p, GOP 60 without scene cuts, AAC, faststart, no metadata", () => {
		const args = ffmpegArgs({ spec: spec(), outFile: "/tmp/x/a.mp4" });
		const after = (flag) => args[args.indexOf(flag) + 1];
		expect(args).toContain("testsrc2=size=1920x1080:rate=30:duration=20");
		expect(args.some((arg) => arg.startsWith("sine=frequency="))).toBe(true);
		expect(after("-c:v")).toBe("libx264");
		expect(after("-profile:v")).toBe("high");
		expect(after("-pix_fmt")).toBe("yuv420p");
		expect(after("-g")).toBe("60");
		expect(after("-keyint_min")).toBe("60");
		expect(after("-sc_threshold")).toBe("0");
		expect(after("-c:a")).toBe("aac");
		expect(after("-movflags")).toBe("+faststart");
		expect(after("-map_metadata")).toBe("-1");
		expect(after("-threads")).toBe("4"); // a fixed thread count: the same bytes on every machine with the same ffmpeg
		expect(args.at(-1)).toBe("/tmp/x/a.mp4");
		expect(args[0]).toBe("-y");
	});

	test("the second clip is hue-shifted (two different pictures, two decoders)", () => {
		const [a, b] = clipSpecs({ seconds: 20 }).map((s) => ffmpegArgs({ spec: s, outFile: "o.mp4" }));
		expect(a.join(" ")).not.toContain("hue=");
		expect(b.join(" ")).toContain("hue=h=180");
	});
});

describe("parseKeyframeTimes", () => {
	test("ffprobe packet csv (decode order, B-frames) -> sorted key frame times", () => {
		expect(parseKeyframeTimes("0.000000,K__\n0.066667,___\n0.033333,___\n2.000000,K__\n4.000000,K_\n\n")).toEqual([0, 2, 4]);
		expect(parseKeyframeTimes("4.000000,K__\n0.000000,K__\n2.000000,K__\n")).toEqual([0, 2, 4]);
		expect(parseKeyframeTimes("")).toEqual([]);
		expect(parseKeyframeTimes("N/A,K__\n")).toEqual([]);
	});
});

describe("boxOrder (faststart = moov before mdat)", () => {
	const box = (type, size) => {
		const buffer = Buffer.alloc(size);
		buffer.writeUInt32BE(size, 0);
		buffer.write(type, 4, "latin1");
		return buffer;
	};
	const reader = (file) => ({ size: file.length, readAt: ({ offset, length }) => file.subarray(offset, offset + length) });

	test("walks the top-level boxes", () => {
		const file = Buffer.concat([box("ftyp", 24), box("moov", 100), box("free", 8), box("mdat", 300)]);
		expect(boxOrder(reader(file))).toEqual(["ftyp", "moov", "free", "mdat"]);
	});

	test("64-bit sizes (size 1 + largesize) and a last box that runs to the end (size 0)", () => {
		const large = Buffer.alloc(16 + 10);
		large.writeUInt32BE(1, 0);
		large.write("mdat", 4, "latin1");
		large.writeBigUInt64BE(26n, 8);
		const toEnd = box("udta", 8);
		toEnd.writeUInt32BE(0, 0);
		expect(boxOrder(reader(Buffer.concat([box("ftyp", 16), large, toEnd, Buffer.alloc(5)])))).toEqual(["ftyp", "mdat", "udta"]);
	});

	test("broken sizes stop the walk instead of looping", () => {
		const bad = box("ftyp", 16);
		bad.writeUInt32BE(4, 0); // smaller than a header
		expect(boxOrder(reader(bad))).toEqual([]);
		const many = Buffer.concat(Array.from({ length: 50 }, () => box("free", 8)));
		expect(boxOrder({ ...reader(many), maxBoxes: 10 })).toHaveLength(10);
	});
});

describe("checkClip", () => {
	test("a good clip: no problems, and the facts the doc records", () => {
		const { problems, facts } = checkClip(goodClip());
		expect(problems).toEqual([]);
		expect(facts).toMatchObject({ codec: "h264", profile: "High", pixFmt: "yuv420p", width: 1920, height: 1080, fps: 30, durationS: 20, keyframeIntervalS: 2, audio: "aac 48000 Hz 2 ch", faststart: true });
	});

	test("every deviation is named", () => {
		const cases = [
			[{ probe: probeJson({ codec: "hevc" }) }, "codec"],
			[{ probe: probeJson({ profile: "Main" }) }, "profile"],
			[{ probe: probeJson({ pixFmt: "yuv444p" }) }, "pix_fmt"],
			[{ probe: probeJson({ width: 1280 }) }, "size"],
			[{ probe: probeJson({ rate: "60/1" }) }, "fps"],
			[{ probe: probeJson({ duration: "19.5" }) }, "duration"],
			[{ probe: probeJson({ audio: false }) }, "audio"],
			[{ keyframeTimes: keyframes(20, 1) }, "key frame"],
			[{ keyframeTimes: [0, 2, 5, 6] }, "key frame"],
			[{ keyframeTimes: [] }, "key frame"],
			[{ boxes: ["ftyp", "mdat", "moov"] }, "faststart"],
			[{ probe: { streams: [] } }, "video"],
		];
		for (const [overrides, word] of cases) {
			const { problems } = checkClip(goodClip(overrides));
			expect(problems.join(" ")).toContain(word);
		}
	});
});

describe("generateClips (glue with injected ffmpeg / ffprobe / fs)", () => {
	function fakes({ failEncode = false, probe = probeJson() } = {}) {
		const calls = [];
		const spawnSync = (command, args) => {
			calls.push([command, args]);
			if (command === "ffmpeg") return failEncode ? { status: 1, stderr: Buffer.from("Unknown encoder 'libx264'") } : { status: 0, stderr: Buffer.from("") };
			if (args.includes("packet=pts_time,flags")) return { status: 0, stdout: Buffer.from(keyframes(20).map((t) => `${t.toFixed(6)},K__`).join("\n")) };
			return { status: 0, stdout: Buffer.from(JSON.stringify(probe)) };
		};
		const file = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from("ftyp"), Buffer.from([0, 0, 0, 8]), Buffer.from("moov"), Buffer.from([0, 0, 0, 8]), Buffer.from("mdat")]);
		const fs = {
			mkdirSync: () => {},
			statSync: () => ({ size: file.length }),
			openSync: () => 3,
			readSync: (fd, buffer, offset, length, position) => file.copy(buffer, offset, position, position + length),
			closeSync: () => {},
			readFileSync: () => file,
		};
		return { calls, spawnSync, fs };
	}

	test("encodes and probes both clips, returns their paths and facts", () => {
		const { calls, spawnSync, fs } = fakes();
		const result = generateClips({ dir: "/tmp/clips", seconds: 20, spawnSync, fs, log: () => {} });
		expect(result.clips.map((c) => c.file)).toEqual(["/tmp/clips/perf-a-1080p30.mp4", "/tmp/clips/perf-b-1080p30.mp4"]);
		expect(result.problems).toEqual([]);
		expect(result.clips[0].facts.faststart).toBe(true);
		expect(result.clips[0].facts.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(calls.filter(([command]) => command === "ffmpeg")).toHaveLength(2);
	});

	test("a clip that does not match its spec is reported with its file name", () => {
		const { spawnSync, fs } = fakes({ probe: probeJson({ profile: "Main" }) });
		const result = generateClips({ dir: "/tmp/clips", seconds: 20, spawnSync, fs, log: () => {} });
		expect(result.problems).toEqual(["perf-a-1080p30.mp4: profile Main, expected High", "perf-b-1080p30.mp4: profile Main, expected High"]);
	});

	test("a failing encode throws with ffmpeg's message", () => {
		const { spawnSync, fs } = fakes({ failEncode: true });
		expect(() => generateClips({ dir: "/tmp/clips", seconds: 20, spawnSync, fs, log: () => {} })).toThrow("libx264");
	});
});

describe("parseClipArgs (script/make-perf-clips.js)", () => {
	test("<outDir> [--seconds N]", () => {
		expect(parseClipArgs(["/tmp/c"])).toEqual({ dir: "/tmp/c", seconds: 20 });
		expect(parseClipArgs(["/tmp/c", "--seconds", "40"])).toEqual({ dir: "/tmp/c", seconds: 40 });
		for (const bad of [[], ["--seconds", "40"], ["/tmp/c", "--seconds"], ["/tmp/c", "--seconds", "x"], ["/tmp/c", "--bogus"], ["/a", "/b"]]) expect(() => parseClipArgs(bad)).toThrow();
	});
});
