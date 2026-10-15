const { describe, expect, test } = require("bun:test");
const {
	DEFAULT_MAX_FILESIZE_BYTES,
	OUTPUT_TEMPLATE,
	PAIR_OUTPUT_TEMPLATE,
	RESULT_FILE,
	buildYtDlpArgs,
	chooseStrategy,
	formatSelector,
	formatSortArgs,
	pairFormatSelector,
	progressPrefix,
} = require("../link-import-args");

// One pure function builds yt-dlp's argument array: fixed options first, then "--", then
// the URL as the very last element, so nothing the user (or a compromised page) types can
// ever be read as an option.

const nonce = "0123456789abcdef0123456789abcdef";
const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const build = (overrides = {}) => buildYtDlpArgs({ url, mode: "video", quality: "best", nonce, ...overrides });

describe("buildYtDlpArgs: the URL is the last element, right after the only '--'", () => {
	test("for every mode and quality", () => {
		for (const mode of ["video", "audio"]) {
			for (const quality of ["best", "1080", "720"]) {
				const args = build({ mode, quality });
				expect(args.at(-1)).toBe(url);
				expect(args.at(-2)).toBe("--");
				expect(args.indexOf("--")).toBe(args.length - 2);
				expect(args.indexOf(url)).toBe(args.length - 1);
			}
		}
	});

	test("a URL with option-like text in its query stays one argument after '--' and appears nowhere else", () => {
		const hostile = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&--exec=touch%20x&-o=/etc/passwd";
		const args = build({ url: hostile });
		expect(args.at(-1)).toBe(hostile);
		expect(args.at(-2)).toBe("--");
		for (const arg of args.slice(0, -1)) expect(arg).not.toContain("dQw4w9WgXcQ");
	});

	test("input the URL check refuses never reaches the array: the builder throws", () => {
		for (const bad of ["--exec=touch /tmp/pwned", "-o/etc/passwd", "--", "https://evil.com/x", "http://www.youtube.com/watch?v=x", 5, null]) {
			expect(() => build({ url: bad })).toThrow("refused");
		}
	});

	test("the URL passed on is the re-serialized one (fragment dropped, host lower-case, playlist parameter removed)", () => {
		const args = build({ url: "https://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ&list=PL1#t=3" });
		expect(args.at(-1)).toBe(url);
	});
});

describe("buildYtDlpArgs: fixed options", () => {
	test("the complete array for a video download at the best quality (any added or removed option must show up here)", () => {
		expect(build()).toEqual([
			"--ignore-config",
			"--no-plugin-dirs",
			"--no-update",
			"--no-playlist",
			"--use-extractors",
			"youtube,tiktok,vm\\.tiktok",
			"--no-batch-file",
			"--no-cookies",
			"--no-cookies-from-browser",
			"--no-exec",
			"--no-cache-dir",
			"--no-mtime",
			"--restrict-filenames",
			"--fixup",
			"never",
			"--max-filesize",
			String(2 * 1024 ** 3),
			"--no-simulate",
			"--newline",
			"--progress",
			"--progress-template",
			`download:ccut-progress-${nonce} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
			"--print-to-file",
			"after_move:%(.{id,title,ext,width,height,vcodec,acodec,duration})j",
			"ccut-result.json",
			"-f",
			formatSelector({ mode: "video", quality: "best" }),
			"-o",
			"out/media.%(ext)s",
			"--",
			url,
		]);
		expect(DEFAULT_MAX_FILESIZE_BYTES).toBe(2 * 1024 ** 3);
		expect(OUTPUT_TEMPLATE).toBe("out/media.%(ext)s");
		expect(RESULT_FILE).toBe("ccut-result.json");
	});

	test("never: config, plugin dirs, cookies, credentials, exec, info-json loading, unplayable (DRM) formats, updates, external tools", () => {
		const forbidden =
			/^(--exec|--cookies|--cookies-from-browser|--load-info-json|--allow-unplayable-formats|--batch-file|-a|--config-locations?|--plugin-dirs|-U|--update|--update-to|--netrc|--netrc-location|--netrc-cmd|-u|--username|-p|--password|--video-password|--ap-.*|--client-certificate.*|--remote-components|--external-downloader|--downloader|--ffmpeg-location|--no-check-certificates?|--proxy|--paths|-P|--extract-audio|-x|--recode-video|--remux-video|--merge-output-format|--embed-.*|--write-.*|--js-runtimes|--enable-file-urls|--compat-options|--add-headers?|--referer|--user-agent|-k|--keep-video|-i|--ignore-errors|--abort-on-error|--no-ignore-errors|--fixup)$/;
		const fixupAt = (args) => args.indexOf("--fixup");
		for (const args of [build({ mode: "video" }), build({ mode: "audio" }), build({ strategy: "pair" }), build({ strategy: "pair", quality: "720" })]) {
			const options = args.slice(0, -2);
			// "--fixup never" is the one allowed form of --fixup: checked by position, then skipped.
			expect(options[fixupAt(options) + 1]).toBe("never");
			for (const [index, arg] of options.entries()) {
				if (index === fixupAt(options)) continue;
				expect(arg).not.toMatch(forbidden);
			}
		}
	});

	test("the max file size is a whole number of bytes within 1 MiB .. 16 GiB", () => {
		const at = (args) => args[args.indexOf("--max-filesize") + 1];
		expect(at(build({ maxFilesizeBytes: 5_000_000 }))).toBe("5000000");
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1024 ** 2 - 1, 16 * 1024 ** 3 + 1, "100", null]) {
			expect(() => build({ maxFilesizeBytes: bad })).toThrow("max file size");
		}
	});

	test("the progress prefix carries the per-job nonce (a line from elsewhere cannot pass as progress); a bad nonce throws", () => {
		expect(progressPrefix({ nonce })).toBe(`ccut-progress-${nonce}`);
		const template = build()[build().indexOf("--progress-template") + 1];
		expect(template.startsWith(`download:ccut-progress-${nonce} `)).toBe(true);
		for (const bad of ["", "xyz", "0123", "0123456789ABCDEF0123456789ABCDEF", `${nonce} --exec`, 5]) {
			expect(() => build({ nonce: bad })).toThrow("nonce");
		}
	});

	test("unknown mode or quality throws", () => {
		expect(() => build({ mode: "both" })).toThrow("mode");
		expect(() => build({ quality: "4k" })).toThrow("quality");
		expect(() => build({ quality: "toString" })).toThrow("quality");
	});
});

describe("formatSelector: single files only (phase 1 has no ffmpeg to merge)", () => {
	test("video: progressive H.264 in MP4 first, then any H.264, then anything that is not HEVC; never a bare fallback", () => {
		expect(formatSelector({ mode: "video", quality: "best" })).toBe(
			"b[vcodec~='^(avc1|avc3|h264)'][ext=mp4]/b[vcodec~='^(avc1|avc3|h264)']/b[vcodec!~=?'^(hev1|hvc1|h265|hevc|bytevc1)']",
		);
	});

	test("the quality is NOT a height filter in the selector (it is the short-side sort, formatSortArgs)", () => {
		for (const quality of ["1080", "720"]) {
			expect(formatSelector({ mode: "video", quality })).toBe(formatSelector({ mode: "video", quality: "best" }));
			expect(formatSelector({ mode: "video", quality })).not.toContain("height");
		}
	});

	test("every video alternative is a combined audio+video format ('b'), none is video-only or audio-only", () => {
		for (const quality of ["best", "1080", "720"]) {
			for (const alternative of formatSelector({ mode: "video", quality }).split("/")) {
				expect(alternative).toMatch(/^b\[/);
				expect(alternative).not.toMatch(/^(bv|ba|bestvideo|bestaudio|wv|wa)/);
				expect(alternative).not.toContain("+");
			}
		}
	});

	test("audio only: the best audio-only format, m4a then webm then any, no re-encoding; the quality does not apply", () => {
		for (const quality of ["best", "1080", "720"]) {
			expect(formatSelector({ mode: "audio", quality })).toBe("ba[ext=m4a]/ba[ext=webm]/ba");
		}
	});
});

describe("formatSortArgs: the quality limit applies to the SHORT side (a 1080x1920 portrait video is 1080p)", () => {
	test("-S res:N for video at 1080 and 720; nothing for best and for audio only", () => {
		expect(formatSortArgs({ mode: "video", quality: "1080" })).toEqual(["-S", "res:1080"]);
		expect(formatSortArgs({ mode: "video", quality: "720" })).toEqual(["-S", "res:720"]);
		expect(formatSortArgs({ mode: "video", quality: "best" })).toEqual([]);
		for (const quality of ["best", "1080", "720"]) expect(formatSortArgs({ mode: "audio", quality })).toEqual([]);
	});

	test("unknown mode or quality throws", () => {
		expect(() => formatSortArgs({ mode: "video", quality: "4k" })).toThrow("quality");
		expect(() => formatSortArgs({ mode: "video", quality: "toString" })).toThrow("quality");
		expect(() => formatSortArgs({ mode: "gif", quality: "720" })).toThrow("mode");
	});

	test("buildYtDlpArgs puts the sort right after -f's value for single and pair, and no height filter anywhere", () => {
		for (const [overrides, selector] of [
			[{ quality: "1080" }, formatSelector({ mode: "video", quality: "1080" })],
			[{ quality: "720", strategy: "pair" }, pairFormatSelector({ quality: "720" })],
		]) {
			const args = build(overrides);
			const at = args.indexOf("-f");
			expect(args.slice(at, at + 5)).toEqual(["-f", selector, "-S", `res:${overrides.quality}`, "-o"]);
			expect(args.join(" ")).not.toContain("height<=");
		}
		expect(build({ quality: "best" })).not.toContain("-S");
		expect(build({ mode: "audio", quality: "720" })).not.toContain("-S");
	});
});

describe("chooseStrategy: separate video + audio streams only for a YouTube link in Video mode", () => {
	test("YouTube video -> pair; TikTok video, and Audio only anywhere -> today's single file", () => {
		expect(chooseStrategy({ mode: "video", platform: "youtube" })).toBe("pair");
		expect(chooseStrategy({ mode: "video", platform: "tiktok" })).toBe("single");
		expect(chooseStrategy({ mode: "audio", platform: "youtube" })).toBe("single");
		expect(chooseStrategy({ mode: "audio", platform: "tiktok" })).toBe("single");
		expect(chooseStrategy({ mode: "video", platform: undefined })).toBe("single");
	});
});

describe("pairFormatSelector: one H.264 MP4 video-only stream AND one AAC m4a audio stream, downloaded separately (comma, never merged)", () => {
	const VIDEO = "bv[vcodec~='^(avc1|avc3)'][ext=mp4][protocol=https]";
	const AUDIO = "ba[acodec~='^mp4a'][ext=m4a][protocol=https][format_id!*=drc]";

	test("the exact selectors (the quality limit is a sort, not part of the selector)", () => {
		expect(pairFormatSelector({ quality: "best" })).toBe(`${VIDEO},${AUDIO}`);
		expect(pairFormatSelector({ quality: "1080" })).toBe(`${VIDEO},${AUDIO}`);
		expect(pairFormatSelector({ quality: "720" })).toBe(`${VIDEO},${AUDIO}`);
	});

	test("two parts, no merge ('+'), no fallback ('/'), no grouping; video-only first, audio-only second", () => {
		for (const quality of ["best", "1080", "720"]) {
			const selector = pairFormatSelector({ quality });
			const parts = selector.split(",");
			expect(parts).toHaveLength(2);
			// outside the bracketed filters: exactly "bv,ba" (no '+', '/', '(' or a third part)
			expect(selector.replace(/\[[^\]]*\]/g, "")).toBe("bv,ba");
			expect(parts[0].startsWith("bv[")).toBe(true);
			expect(parts[1].startsWith("ba[")).toBe(true);
			// direct HTTPS downloads only: no HLS (MPEG-TS) or DASH-segment formats
			for (const part of parts) expect(part).toContain("[protocol=https]");
		}
	});

	test("an unknown quality throws", () => {
		expect(() => pairFormatSelector({ quality: "4k" })).toThrow("quality");
		expect(() => pairFormatSelector({ quality: "hasOwnProperty" })).toThrow("quality");
	});
});

describe("buildYtDlpArgs with the pair strategy", () => {
	const ytUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

	test("the complete array: the single-file options, plus the format id in progress and result, the pair selector and a per-format output name", () => {
		expect(build({ strategy: "pair", quality: "1080" })).toEqual([
			"--ignore-config",
			"--no-plugin-dirs",
			"--no-update",
			"--no-playlist",
			"--use-extractors",
			"youtube,tiktok,vm\\.tiktok",
			"--no-batch-file",
			"--no-cookies",
			"--no-cookies-from-browser",
			"--no-exec",
			"--no-cache-dir",
			"--no-mtime",
			"--restrict-filenames",
			"--fixup",
			"never",
			"--max-filesize",
			String(2 * 1024 ** 3),
			"--no-simulate",
			"--newline",
			"--progress",
			"--progress-template",
			`download:ccut-progress-${nonce} %(info.format_id)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
			"--print-to-file",
			"after_move:%(.{id,title,format_id,ext,width,height,vcodec,acodec,duration})j",
			"ccut-result.json",
			"-f",
			pairFormatSelector({ quality: "1080" }),
			"-S",
			"res:1080",
			"-o",
			"out/%(format_id)s.%(ext)s",
			"--",
			ytUrl,
		]);
		expect(PAIR_OUTPUT_TEMPLATE).toBe("out/%(format_id)s.%(ext)s");
	});

	test("the single-file strategy is the default and stays byte for byte as before", () => {
		expect(build({ strategy: "single" })).toEqual(build());
	});

	test("refused: the pair for Audio only or for a TikTok link; an unknown strategy", () => {
		expect(() => build({ strategy: "pair", mode: "audio" })).toThrow("strategy");
		expect(() => build({ strategy: "pair", url: "https://www.tiktok.com/@someone/video/7234567890123456789" })).toThrow("strategy");
		expect(() => build({ strategy: "merge" })).toThrow("strategy");
		expect(() => build({ strategy: "toString" })).toThrow("strategy");
	});
});
