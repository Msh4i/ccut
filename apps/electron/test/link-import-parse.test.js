const { describe, expect, test } = require("bun:test");
const {
	MAX_PROGRESS_LINE_CHARS,
	createLineSplitter,
	mapYtDlpError,
	parsePairResultText,
	parseProgressLine,
	parseResultText,
	sanitizeTitle,
} = require("../link-import-parse");

// What comes back from yt-dlp: progress lines with the job's nonce prefix, one line of
// JSON in the result file, and stderr text that is mapped to an error code. Everything is
// parsed strictly; anything malformed is ignored (progress) or refused (result).

const prefix = "ccut-progress-0123456789abcdef0123456789abcdef";

describe("parseProgressLine", () => {
	test("a line as yt-dlp prints it with the template: bytes, total, estimate, speed (float), eta", () => {
		expect(parseProgressLine({ line: `${prefix} 1048576 10485760 NA 524288.3164 17`, prefix })).toEqual({
			downloadedBytes: 1048576,
			totalBytes: 10485760,
			speed: 524288.3164,
			eta: 17,
		});
	});

	test("unknown values are NA: the total falls back to the estimate, a missing speed/eta is null", () => {
		expect(parseProgressLine({ line: `${prefix} 2048 NA 99000.0 NA NA`, prefix })).toEqual({
			downloadedBytes: 2048,
			totalBytes: 99000,
			speed: null,
			eta: null,
		});
		expect(parseProgressLine({ line: `${prefix} 0 NA NA NA NA`, prefix })).toEqual({ downloadedBytes: 0, totalBytes: null, speed: null, eta: null });
	});

	test("Python's float formats (exponent, long fractions) are numbers too", () => {
		expect(parseProgressLine({ line: `${prefix} 10 20 NA 1.5e-05 0`, prefix }).speed).toBe(1.5e-5);
		expect(parseProgressLine({ line: `${prefix} 10 20 NA 1234.5678901234567 3.0`, prefix })).toEqual({ downloadedBytes: 10, totalBytes: 20, speed: 1234.5678901234567, eta: 3 });
	});

	test("the final line of a finished download (downloaded == total, speed known, eta 0)", () => {
		expect(parseProgressLine({ line: `${prefix} 734003 734003 NA 2389012.11 0`, prefix })).toEqual({ downloadedBytes: 734003, totalBytes: 734003, speed: 2389012.11, eta: 0 });
	});

	test("malformed or foreign lines are ignored (null)", () => {
		const bad = [
			"[download]  12.5% of   10.00MiB at    1.00MiB/s ETA 00:08",
			"[youtube] dQw4w9WgXcQ: Downloading webpage",
			`${prefix} 1 2 3 4`, // a field missing
			`${prefix} 1 2 3 4 5 6`, // one too many
			`${prefix}  1 2 3 4 5`, // double space
			`${prefix} -1 2 NA 4 5`, // negative
			`${prefix} 1e999 2 NA 4 5`, // not finite
			`${prefix} 0x10 2 NA 4 5`,
			`${prefix} 1 2 NA 4 5 `, // trailing space
			` ${prefix} 1 2 NA 4 5`, // leading space
			`${prefix} 1 2 NA inf 5`,
			`${prefix} 1 2 NA nan 5`,
			`${prefix}1 2 NA 4 5`,
			`ccut-progress-ffffffffffffffffffffffffffffffff 1 2 NA 4 5`, // another job's nonce
			`${prefix} ${"9".repeat(400)} 2 NA 4 5`,
			"",
		];
		for (const line of bad) expect(parseProgressLine({ line, prefix })).toBeNull();
	});

	test("a line longer than the limit is ignored even if it would parse", () => {
		const padded = `${prefix} 1 2 NA ${"1".repeat(10)}.${"0".repeat(MAX_PROGRESS_LINE_CHARS)} 5`;
		expect(padded.length).toBeGreaterThan(MAX_PROGRESS_LINE_CHARS);
		expect(parseProgressLine({ line: padded, prefix })).toBeNull();
	});

	test("downloaded bytes above a safe integer are refused", () => {
		expect(parseProgressLine({ line: `${prefix} 9007199254740993 NA NA NA NA`, prefix })).toBeNull();
	});
});

describe("parseProgressLine with the format id (the pair download: two files, one after the other)", () => {
	test("the format id comes first and is returned; the numbers parse as before", () => {
		expect(parseProgressLine({ line: `${prefix} 137 1048576 10485760 NA 524288.3164 17`, prefix, withFormatId: true })).toEqual({
			formatId: "137",
			downloadedBytes: 1048576,
			totalBytes: 10485760,
			speed: 524288.3164,
			eta: 17,
		});
		expect(parseProgressLine({ line: `${prefix} 140-drc 1 2 NA NA NA`, prefix, withFormatId: true }).formatId).toBe("140-drc");
		expect(parseProgressLine({ line: `${prefix} a_B-9 1 2 NA NA NA`, prefix, withFormatId: true }).formatId).toBe("a_B-9");
	});

	test("the two line shapes never pass for each other", () => {
		expect(parseProgressLine({ line: `${prefix} 137 1 2 NA 4 5`, prefix })).toBeNull();
		expect(parseProgressLine({ line: `${prefix} 1 2 NA 4 5`, prefix, withFormatId: true })).toBeNull();
	});

	test("a format id that is not 1..32 of [0-9A-Za-z_-] is refused", () => {
		for (const id of ["../137", "137/x", "13.7", "a".repeat(33), "", "13 7", "%(info.format_id)s", "137\u202e"]) {
			expect(parseProgressLine({ line: `${prefix} ${id} 1 2 NA 4 5`, prefix, withFormatId: true })).toBeNull();
		}
		expect(parseProgressLine({ line: `${prefix} ${"a".repeat(32)} 1 2 NA 4 5`, prefix, withFormatId: true }).formatId).toBe("a".repeat(32));
	});
});

describe("parsePairResultText (two --print-to-file lines: the video-only file and the audio-only file)", () => {
	const video = { id: "dQw4w9WgXcQ", title: "A title", format_id: "137", ext: "mp4", width: 1920, height: 1080, vcodec: "avc1.640028", acodec: "none", duration: 213 };
	const audio = { id: "dQw4w9WgXcQ", title: "A title", format_id: "140", ext: "m4a", width: null, height: null, vcodec: "none", acodec: "mp4a.40.2", duration: 213 };
	const text = (...lines) => lines.map((fields) => `${JSON.stringify(fields)}\n`).join("");

	test("a valid pair, in either order: the video and the audio line with their format ids", () => {
		const expected = {
			ok: true,
			video: { id: "dQw4w9WgXcQ", title: "A title", formatId: "137", ext: "mp4", width: 1920, height: 1080, vcodec: "avc1.640028", acodec: "none", duration: 213 },
			audio: { id: "dQw4w9WgXcQ", title: "A title", formatId: "140", ext: "m4a", width: null, height: null, vcodec: "none", acodec: "mp4a.40.2", duration: 213 },
		};
		expect(parsePairResultText(text(video, audio))).toEqual(expected);
		expect(parsePairResultText(text(audio, video))).toEqual(expected);
		expect(parsePairResultText(text({ ...video, vcodec: "avc3.4d401f" }, audio)).ok).toBe(true);
		expect(parsePairResultText(`${JSON.stringify(video)}\r\n${JSON.stringify(audio)}\r\n`).ok).toBe(true);
	});

	test("one line only (yt-dlp found the video but no m4a, or the m4a but no H.264 video): refused as partial", () => {
		expect(parsePairResultText(text(video))).toEqual({ ok: false, reason: "partial" });
		expect(parsePairResultText(text(audio))).toEqual({ ok: false, reason: "partial" });
		expect(parsePairResultText("")).toEqual({ ok: false, reason: "partial" });
		expect(parsePairResultText(null)).toEqual({ ok: false, reason: "partial" });
	});

	test("refused: three lines, two different ids, the same format twice, two videos, two audios", () => {
		expect(parsePairResultText(text(video, audio, audio)).ok).toBe(false);
		expect(parsePairResultText(text(video, { ...audio, id: "other" })).ok).toBe(false);
		expect(parsePairResultText(text(video, { ...audio, format_id: "137" })).ok).toBe(false);
		expect(parsePairResultText(text(video, { ...video, format_id: "136" })).ok).toBe(false);
		expect(parsePairResultText(text(audio, { ...audio, format_id: "139" })).ok).toBe(false);
	});

	test("refused codecs and containers: VP9/AV1/HEVC video, video with sound, webm, Opus or no codec on the audio side", () => {
		const bad = [
			[{ ...video, vcodec: "vp9" }, audio],
			[{ ...video, vcodec: "av01.0.08M.08" }, audio],
			[{ ...video, vcodec: "hev1.1.6.L93.B0" }, audio],
			[{ ...video, vcodec: "avc1x" }, audio],
			[{ ...video, vcodec: null }, audio],
			[{ ...video, acodec: "mp4a.40.2" }, audio],
			[{ ...video, ext: "webm" }, audio],
			[video, { ...audio, ext: "webm", acodec: "opus" }],
			[video, { ...audio, acodec: "opus" }],
			[video, { ...audio, acodec: null }],
			[video, { ...audio, vcodec: "avc1.640028" }],
			[video, { ...audio, ext: "mp4" }],
		];
		for (const lines of bad) expect(parsePairResultText(text(...lines)).ok).toBe(false);
	});

	test("refused format ids: missing, not a string, outside [0-9A-Za-z_-], longer than 32", () => {
		for (const formatId of [undefined, null, 137, "", "../137", "137/x", "13 7", "137.mp4", "a".repeat(33)]) {
			expect(parsePairResultText(text({ ...video, format_id: formatId }, audio)).ok).toBe(false);
		}
	});

	test("the per-line rules of the single result still apply (JSON object, string id/title, ext, sizes)", () => {
		expect(parsePairResultText(`not json\n${JSON.stringify(audio)}\n`).ok).toBe(false);
		expect(parsePairResultText(text({ ...video, width: -1 }, audio)).ok).toBe(false);
		expect(parsePairResultText(text({ ...video, title: 5 }, audio)).ok).toBe(false);
		expect(parsePairResultText(text(video, { ...audio, title: "x".repeat(70_000) })).ok).toBe(false);
	});

	test("prototype keys do not pollute anything", () => {
		const polluted = `{"__proto__":{"polluted":true},${JSON.stringify(video).slice(1)}\n${JSON.stringify(audio)}\n`;
		expect(parsePairResultText(polluted).ok).toBe(true);
		expect({}.polluted).toBeUndefined();
	});
});

describe("parseResultText (the --print-to-file line)", () => {
	const line = (fields) => `${JSON.stringify(fields)}\n`;

	test("a real-looking YouTube result", () => {
		const text = line({ id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", ext: "mp4", width: 640, height: 360, vcodec: "avc1.42001E", acodec: "mp4a.40.2", duration: 213 });
		expect(parseResultText(text)).toEqual({
			ok: true,
			info: { id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", ext: "mp4", width: 640, height: 360, vcodec: "avc1.42001E", acodec: "mp4a.40.2", duration: 213 },
		});
	});

	test("an audio-only result: no width/height, vcodec none; a missing field is null", () => {
		expect(parseResultText(line({ id: "x", title: "Song", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", width: null, height: null }))).toEqual({
			ok: true,
			info: { id: "x", title: "Song", ext: "m4a", width: null, height: null, vcodec: "none", acodec: "mp4a.40.2", duration: null },
		});
	});

	test("escaped newlines and non-ASCII in a title survive as text (one line of JSON)", () => {
		const result = parseResultText(`{"id":"1","title":"a\\nb \\u00e7\\u011f","ext":"mp4"}\r\n`);
		expect(result.ok).toBe(true);
		expect(result.info.title).toBe("a\nb çğ");
	});

	test("refused: not exactly one line, not JSON, not an object, wrong types, bad ext, too big", () => {
		const bad = [
			"",
			"\n",
			`${line({ id: "1", title: "a", ext: "mp4" })}${line({ id: "2", title: "b", ext: "mp4" })}`,
			"not json\n",
			"[1,2]\n",
			"null\n",
			`"str"\n`,
			line({ id: 1, title: "a", ext: "mp4" }),
			line({ id: "1", title: 5, ext: "mp4" }),
			line({ id: "1", title: "a" }),
			line({ id: "1", title: "a", ext: "MP4" }),
			line({ id: "1", title: "a", ext: "../x" }),
			line({ id: "1", title: "a", ext: "mp4", width: -1 }),
			line({ id: "1", title: "a", ext: "mp4", height: 1.5 }),
			line({ id: "1", title: "a", ext: "mp4", duration: -3 }),
			line({ id: "1", title: "a", ext: "mp4", vcodec: { x: 1 } }),
			line({ id: "1", title: "x".repeat(70_000), ext: "mp4" }),
		];
		for (const text of bad) expect(parseResultText(text)).toEqual({ ok: false });
		expect(parseResultText(undefined)).toEqual({ ok: false });
	});

	test("prototype keys in the JSON do not pollute anything", () => {
		const result = parseResultText(`{"id":"1","title":"a","ext":"mp4","__proto__":{"polluted":true}}\n`);
		expect(result.ok).toBe(true);
		expect({}.polluted).toBeUndefined();
		expect(Object.keys(result.info).sort()).toEqual(["acodec", "duration", "ext", "height", "id", "title", "vcodec", "width"]);
	});
});

describe("sanitizeTitle", () => {
	test("control and direction characters removed, whitespace collapsed, at most 200 code points", () => {
		expect(sanitizeTitle("  My\tvideo\n\u202etxt.exe\u0000  ")).toBe("My video txt.exe");
		expect(Array.from(sanitizeTitle("😀".repeat(300)))).toHaveLength(200);
		expect(sanitizeTitle(5)).toBe("");
	});
});

describe("mapYtDlpError (real yt-dlp error lines)", () => {
	const cases = [
		["private", ["ERROR: [youtube] AbCdEfGhIjK: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies."]],
		["private", ["ERROR: [TikTok] 7234567890123456789: This post is private"]],
		["geo-blocked", ["ERROR: [youtube] AbCdEfGhIjK: Video unavailable. The uploader has not made this video available in your country"]],
		["geo-blocked", ["ERROR: [youtube] AbCdEfGhIjK: This video is not available from your location due to geo restriction"]],
		["geo-blocked", ["ERROR: [TikTok] 7234567890123456789: Your IP address is blocked from accessing this post"]],
		["login-required", ["ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication."]],
		["login-required", ["ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp"]],
		["login-required", ["ERROR: [youtube] AbCdEfGhIjK: Join this channel to get access to members-only content like this video, and other exclusive perks."]],
		["rate-limited", ["ERROR: [youtube] AbCdEfGhIjK: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)"]],
		["rate-limited", ["ERROR: unable to download video data: HTTP Error 429: Too Many Requests"]],
		["too-large", ["\r[download] File is larger than max-filesize (2361298127 bytes > 2147483648 bytes). Aborting."]],
		["unsupported", ["ERROR: Unsupported URL: https://www.youtube.com/feed/library"]],
		["unsupported", ["ERROR: No suitable extractor found for URL https://www.youtube.com/@somechannel"]],
		["no-compatible-format", ["ERROR: [youtube] AbCdEfGhIjK: Requested format is not available. Use --list-formats for a list of available formats"]],
		["unavailable", ["ERROR: [youtube] AbCdEfGhIjK: Video unavailable. This video has been removed by the uploader"]],
		["unavailable", ["ERROR: [youtube] AbCdEfGhIjK: This video is no longer available because the YouTube account associated with this video has been terminated."]],
		["unavailable", ["ERROR: [TikTok] 7234567890123456789: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)"]],
		["network", ["ERROR: [youtube] AbCdEfGhIjK: Unable to download webpage: [Errno -3] Temporary failure in name resolution (caused by TransportError('[Errno -3] Temporary failure in name resolution'))"]],
		["network", ["ERROR: [youtube] AbCdEfGhIjK: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed> (caused by URLError(gaierror(11001, 'getaddrinfo failed')))"]],
		["network", ["ERROR: [download] Got error: HTTPSConnectionPool(host='rr3---sn-4g5e6nzz.googlevideo.com', port=443): Read timed out. (read timeout=20.0)"]],
		["network", ["ERROR: Unable to download video data: <urlopen error [Errno 101] Network is unreachable>"]],
		["tool-outdated", ["Usage: yt-dlp [OPTIONS] URL [URL...]", "", "yt-dlp: error: no such option: --no-plugin-dirs"]],
		["extractor-failed", ["ERROR: [youtube] AbCdEfGhIjK: Unable to download video data: HTTP Error 403: Forbidden"]],
		["extractor-failed", ["ERROR: [youtube] AbCdEfGhIjK: Unable to extract uploader id; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template."]],
		["extractor-failed", ["ERROR: [TikTok] 7234567890123456789: Unable to extract webpage video data"]],
		["extractor-failed", ["ERROR: [youtube] AbCdEfGhIjK: nsig extraction failed: Some formats may be missing"]],
		["unknown", ["ERROR: something nobody has seen before"]],
		["unknown", []],
	];
	for (const [code, lines] of cases) {
		test(`${code}: ${(lines[lines.length - 1] ?? "(no output)").slice(0, 90)}`, () => {
			expect(mapYtDlpError({ lines })).toBe(code);
		});
	}

	test("the ERROR line decides over earlier warnings that look like another failure", () => {
		const lines = [
			"WARNING: [youtube] Unable to download webpage: The read operation timed out; retrying (1/3)",
			"WARNING: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot",
			"ERROR: [youtube] AbCdEfGhIjK: Requested format is not available. Use --list-formats for a list of available formats",
		];
		expect(mapYtDlpError({ lines })).toBe("no-compatible-format");
	});

	test("a warning that merely mentions a missing tool is not an error", () => {
		expect(mapYtDlpError({ lines: ["WARNING: ffmpeg not found. The downloaded format may not be the best available."] })).toBe("unknown");
	});

	test("a broken extractor is not mistaken for the cases a newer yt-dlp cannot fix", () => {
		// rate limit, private/login and a network failure keep their own codes even if the line also says "Unable to extract"
		expect(mapYtDlpError({ lines: ["ERROR: [youtube] AbCdEfGhIjK: Unable to download API page: HTTP Error 429: Too Many Requests"] })).toBe("rate-limited");
		expect(mapYtDlpError({ lines: ["ERROR: [youtube] AbCdEfGhIjK: Private video. Unable to extract player"] })).toBe("private");
		expect(mapYtDlpError({ lines: ["ERROR: [youtube] AbCdEfGhIjK: Unable to download webpage: [Errno -3] Temporary failure in name resolution"] })).toBe("network");
		// text of someone else (a claimant) or an offline run is not a breakage signal
		expect(mapYtDlpError({ lines: ["ERROR: [youtube] AbCdEfGhIjK: Video unavailable. This video contains content from Unable to extract Media, who has blocked it on copyright grounds"] })).toBe("unavailable");
		expect(mapYtDlpError({ lines: ["ERROR: [youtube] AbCdEfGhIjK: Failed to extract any player response"] })).toBe("unknown");
		expect(mapYtDlpError({ lines: ["ERROR: [youtube] AbCdEfGhIjK: This video is private. Unable to extract uploader id"] })).toBe("private");
		expect(mapYtDlpError({ lines: ["WARNING: [youtube] AbCdEfGhIjK: nsig extraction failed: Some formats may be missing"] })).toBe("unknown");
	});

	test("non-array input is unknown", () => {
		expect(mapYtDlpError({ lines: "ERROR: Private video" })).toBe("unknown");
	});
});

describe("createLineSplitter", () => {
	const collect = (maxLineChars = 100) => {
		const lines = [];
		const splitter = createLineSplitter({ maxLineChars, onLine: (line) => lines.push(line) });
		return { lines, splitter };
	};

	test("lines split on \\n, \\r\\n and \\r; empty lines dropped; the last unterminated line comes with end()", () => {
		const { lines, splitter } = collect();
		splitter.push(Buffer.from("one\r\ntwo\n\nthr"));
		splitter.push(Buffer.from("ee\rfour"));
		expect(lines).toEqual(["one", "two", "three"]);
		splitter.end();
		expect(lines).toEqual(["one", "two", "three", "four"]);
	});

	test("a multi-byte character split between two chunks is decoded once, correctly", () => {
		const { lines, splitter } = collect();
		const bytes = Buffer.from("çağ😀\n");
		splitter.push(bytes.subarray(0, 2));
		splitter.push(bytes.subarray(2, 6));
		splitter.push(bytes.subarray(6));
		expect(lines).toEqual(["çağ😀"]);
	});

	test("a line longer than the cap is dropped whole (never buffered past the cap); the next line is fine", () => {
		const { lines, splitter } = collect(10);
		for (let i = 0; i < 1000; i++) splitter.push(Buffer.from("x".repeat(100)));
		expect(splitter.bufferedChars()).toBeLessThanOrEqual(10);
		splitter.push(Buffer.from("tail\nok\n"));
		expect(lines).toEqual(["ok"]);
		expect(splitter.droppedLines()).toBe(1);
	});
});
