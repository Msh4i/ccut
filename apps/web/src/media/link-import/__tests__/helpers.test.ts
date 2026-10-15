import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileNameFor, tempNameFor } from "../file-name";
import { LINK_IMPORT_MESSAGES, messageFor } from "../messages";
import { NOTICE_STORAGE_KEY, acknowledgeNotice, hasAcknowledgedNotice } from "../notice";
import { ALL_ERROR_CODES, JOB_ERROR_CODES } from "../types";
import { prepareLinkUrl } from "../url";

// Pure helpers of the "Import from link" dialog. The URL check here is only for a quick
// answer in the page: the main process decides (apps/electron/link-import-url.js).

describe("prepareLinkUrl (the page's pre-check; the main process decides)", () => {
	test("surrounding whitespace from a paste is trimmed; YouTube and TikTok single-video links pass", () => {
		expect(prepareLinkUrl({ input: "  https://www.youtube.com/watch?v=dQw4w9WgXcQ\n" })).toEqual({
			ok: true,
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		});
		for (const url of [
			"https://youtu.be/dQw4w9WgXcQ",
			"https://music.youtube.com/watch?v=x",
			"https://www.tiktok.com/@a/video/1",
			"https://vm.tiktok.com/ZMabc/",
			"https://vt.tiktok.com/ZSabc/",
			"https://m.tiktok.com/v/1.html",
			"https://tiktok.com/@a/video/1",
			"https://m.youtube.com/watch?v=x",
			"https://youtube.com/shorts/x",
			"https://www.youtube.com./watch?v=x",
		]) {
			expect(prepareLinkUrl({ input: url }).ok).toBe(true);
		}
	});

	test("refused like the main process refuses: other schemes and hosts, look-alikes, userinfo, ports, IPs, inner whitespace, non-ASCII", () => {
		for (const input of [
			"",
			"   ",
			"http://www.youtube.com/watch?v=x",
			"javascript:alert(1)",
			"file:///etc/passwd",
			"https://youtube.com.evil.com/watch?v=x",
			"https://evil-youtube.com/",
			"https://youtube.co/",
			"https://xn--youtube-6ya.com/",
			"https://youtube.com@evil.com/",
			"https://user:pass@www.youtube.com/",
			"https://www.youtube.com:8443/",
			"https://127.0.0.1/",
			"https://[::1]/",
			"https://www.youtube.com/watch?v=x y",
			"https://www.yоutube.com/watch?v=x",
			"https://www.youtube.com\\@evil.com/",
			"-o/etc/passwd",
			`https://www.youtube.com/watch?v=${"a".repeat(2048)}`,
		]) {
			expect(prepareLinkUrl({ input })).toEqual({ ok: false, code: "url-refused" });
		}
	});

	test("a YouTube playlist-only link has its own code", () => {
		expect(prepareLinkUrl({ input: "https://www.youtube.com/playlist?list=PL1" })).toEqual({ ok: false, code: "playlist-refused" });
	});

	test("the host list is the main process's list", () => {
		const main = readFileSync(join(import.meta.dir, "../../../../../electron/link-import-url.js"), "utf8");
		const page = readFileSync(join(import.meta.dir, "../url.ts"), "utf8");
		const hostsOf = (text: string) => [...text.matchAll(/"((?:[a-z]+\.)?(?:youtube\.com|youtu\.be|tiktok\.com))"/g)].map((m) => m[1]).sort();
		expect(hostsOf(page)).toEqual(hostsOf(main));
		expect(hostsOf(page)).toHaveLength(10);
	});
});

describe("fileNameFor (the asset's name)", () => {
	test("the title, made safe as a file name, with the extension", () => {
		expect(fileNameFor({ title: "My video: part 1/2", ext: "mp4", mode: "video" })).toBe("My video- part 1-2.mp4");
		expect(fileNameFor({ title: 'a<b>c"d|e?f*g\\h', ext: "m4a", mode: "audio" })).toBe("a-b-c-d-e-f-g-h.m4a");
	});

	test("control and direction characters removed, whitespace collapsed, no leading/trailing dots", () => {
		expect(fileNameFor({ title: "  ..Clip\u202etxt.exe\n\t2..  ", ext: "mp4", mode: "video" })).toBe("Cliptxt.exe 2.mp4");
	});

	test("at most 100 code points before the extension (never splitting an emoji)", () => {
		const name = fileNameFor({ title: "😀".repeat(300), ext: "webm", mode: "video" });
		expect(Array.from(name.replace(/\.webm$/, ""))).toHaveLength(100);
		expect(name.endsWith(".webm")).toBe(true);
	});

	test("nothing usable left: a plain fallback name per mode", () => {
		expect(fileNameFor({ title: "", ext: "mp4", mode: "video" })).toBe("Imported video.mp4");
		expect(fileNameFor({ title: "...", ext: "m4a", mode: "audio" })).toBe("Imported audio.m4a");
		expect(fileNameFor({ title: "\u202e\u0000", ext: "m4a", mode: "audio" })).toBe("Imported audio.m4a");
	});

	test("the temporary storage name is random hex plus the extension, nothing from the title", () => {
		expect(tempNameFor({ ext: "mp4", randomHex: () => "00ff" })).toBe("00ff.mp4");
	});
});

describe("messages", () => {
	test("every error code has a message; unknown input falls back to the unknown message", () => {
		for (const code of ALL_ERROR_CODES) {
			expect(typeof LINK_IMPORT_MESSAGES[code]).toBe("string");
			expect(LINK_IMPORT_MESSAGES[code].length).toBeGreaterThan(10);
		}
		expect(Object.keys(LINK_IMPORT_MESSAGES).sort()).toEqual([...ALL_ERROR_CODES].sort());
		expect(messageFor({ code: "private" })).toBe("This video is private.");
		expect(messageFor({ code: "rate-limited" })).toContain("429");
	});

	test("the error codes the main process can send are all known here", () => {
		const parse = readFileSync(join(import.meta.dir, "../../../../../electron/link-import-parse.js"), "utf8");
		const jobs = readFileSync(join(import.meta.dir, "../../../../../electron/link-import-jobs.js"), "utf8");
		const tool = readFileSync(join(import.meta.dir, "../../../../../electron/link-import-tool.js"), "utf8");
		const fromRules = [...parse.matchAll(/\[\s*"([a-z-]+)",\s*\//g)].map((m) => m[1]);
		const fromJobs = [...jobs.matchAll(/code: "([a-z-]+)"/g)].map((m) => m[1]);
		// every quoted code inside fail(...), also fail(outdated ? "tool-outdated" : "tool-missing")
		const fromTool = [...tool.matchAll(/fail\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/"([a-z-]+)"/g)].map((code) => code[1]));
		const known = new Set<string>(ALL_ERROR_CODES);
		for (const code of [...fromRules, ...fromJobs, ...fromTool]) expect(known.has(code)).toBe(true);
		expect(fromRules.length).toBeGreaterThan(8);
		expect(fromTool).toContain("tool-signature-failed");
		expect(fromTool).toContain("tool-outdated");
	});

	test("tool-outdated names the oldest yt-dlp the main process accepts and how to update; tool-signature-failed points at a Ccut update", () => {
		const tool = readFileSync(join(import.meta.dir, "../../../../../electron/link-import-tool.js"), "utf8");
		const minimum = /const MIN_VERSION = "(\d{4}\.\d{2}\.\d{2})";/.exec(tool)?.[1];
		expect(minimum).toBe("2025.03.21");
		const outdated = messageFor({ code: "tool-outdated" });
		expect(outdated).toContain(`${minimum} or newer`);
		expect(outdated).toContain("yt-dlp -U");
		expect(outdated).toContain("pip install -U yt-dlp");
		const signature = messageFor({ code: "tool-signature-failed" });
		expect(signature).toContain("signature");
		expect(signature).toContain("update Ccut");
		expect(JOB_ERROR_CODES).toContain("tool-signature-failed");
	});
});

describe("the one-time rights notice", () => {
	const memory = () => {
		const values = new Map<string, string>();
		return {
			getItem: (key: string) => values.get(key) ?? null,
			// The Storage API's (key, value) shape, without a two-parameter function of our own.
			setItem: values.set.bind(values),
			values,
		};
	};

	test("not acknowledged until acknowledged; stored under its own key", () => {
		const storage = memory();
		expect(hasAcknowledgedNotice({ storage })).toBe(false);
		acknowledgeNotice({ storage });
		expect(hasAcknowledgedNotice({ storage })).toBe(true);
		expect([...storage.values.keys()]).toEqual([NOTICE_STORAGE_KEY]);
		expect(NOTICE_STORAGE_KEY).toBe("ccut-link-import-notice-acknowledged");
	});

	test("a storage that throws (disabled, full) never breaks the dialog: not acknowledged, no throw", () => {
		const broken = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		expect(hasAcknowledgedNotice({ storage: broken })).toBe(false);
		expect(() => acknowledgeNotice({ storage: broken })).not.toThrow();
		expect(hasAcknowledgedNotice({ storage: null })).toBe(false);
	});
});
