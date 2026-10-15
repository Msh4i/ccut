const { describe, expect, test } = require("bun:test");
const { ALLOWED_HOSTS, MAX_URL_CHARS, validateLinkUrl } = require("../link-import-url");

// The main process decides which links yt-dlp may see. Only https, an exact host from the
// list, no userinfo, no port but the default, nothing a second URL parser could read
// differently. What is passed on is the URL re-serialized from the parsed form.

const accepted = (input) => {
	const result = validateLinkUrl(input);
	if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be accepted, got ${result.code}/${result.reason}`);
	return result;
};
const refusal = (input) => {
	const result = validateLinkUrl(input);
	if (result.ok) throw new Error(`expected ${JSON.stringify(input)} to be refused, got ${result.url}`);
	return result;
};

describe("validateLinkUrl: accepted", () => {
	const cases = [
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "youtube"],
		["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "https://music.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		["https://www.youtube.com/shorts/abcdefghijk", "https://www.youtube.com/shorts/abcdefghijk", "youtube"],
		["https://youtu.be/dQw4w9WgXcQ?si=xyz", "https://youtu.be/dQw4w9WgXcQ?si=xyz", "youtube"],
		["https://www.tiktok.com/@some.user/video/7234567890123456789", "https://www.tiktok.com/@some.user/video/7234567890123456789", "tiktok"],
		["https://tiktok.com/@user/video/1", "https://tiktok.com/@user/video/1", "tiktok"],
		["https://m.tiktok.com/v/7234567890123456789.html", "https://m.tiktok.com/v/7234567890123456789.html", "tiktok"],
		["https://vm.tiktok.com/ZMabcdef/", "https://vm.tiktok.com/ZMabcdef/", "tiktok"],
		["https://vt.tiktok.com/ZSabcdef/", "https://vt.tiktok.com/ZSabcdef/", "tiktok"],
		// Scheme and host are case-insensitive; the passed-on URL is lower-case there.
		["HTTPS://WWW.YouTube.COM/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		// One trailing dot (the fully qualified form) is the same host.
		["https://www.youtube.com./watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		// The default port written out is the same URL; it is not passed on.
		["https://www.youtube.com:443/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		// The fragment never reaches a server: dropped.
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=10", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
		// No path at all becomes "/".
		["https://youtu.be", "https://youtu.be/", "youtube"],
	];
	for (const [input, url, platform] of cases) {
		test(input, () => {
			const result = accepted(input);
			expect(result.url).toBe(url);
			expect(result.platform).toBe(platform);
		});
	}

	test("a playlist parameter on a single-video link is removed (one video only; --no-playlist is passed as well)", () => {
		expect(accepted("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=3&start_radio=1").url).toBe(
			"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		);
		expect(accepted("https://youtu.be/dQw4w9WgXcQ?list=PL123&t=5").url).toBe("https://youtu.be/dQw4w9WgXcQ?t=5");
	});

	test("the host list is exactly the ten agreed hosts", () => {
		expect([...ALLOWED_HOSTS].sort()).toEqual(
			[
				"m.tiktok.com",
				"m.youtube.com",
				"music.youtube.com",
				"tiktok.com",
				"vm.tiktok.com",
				"vt.tiktok.com",
				"www.tiktok.com",
				"www.youtube.com",
				"youtu.be",
				"youtube.com",
			].sort(),
		);
	});

	test("what is passed on is plain printable ASCII starting with https://<allowed host>/", () => {
		for (const input of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=%C3%A7", "https://www.tiktok.com/@a/video/1?q=a%20b"]) {
			const { url } = accepted(input);
			expect(url).toMatch(/^https:\/\/[a-z.]+\/[\x21-\x7e]*$/);
		}
	});
});

describe("validateLinkUrl: refused", () => {
	const cases = [
		// other schemes
		["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "not-https"],
		["file:///etc/passwd", "not-https"],
		["javascript:alert(1)", "not-https"],
		["data:text/html,<script>alert(1)</script>", "not-https"],
		["ftp://youtube.com/x", "not-https"],
		["ytsearch:rickroll", "not-https"],
		["https:www.youtube.com/watch?v=x", "not-https"],
		["https:/www.youtube.com/watch?v=x", "not-https"],
		// look-alike hosts
		["https://youtube.com.evil.com/watch?v=x", "host"],
		["https://evil-youtube.com/watch?v=x", "host"],
		["https://youtube.co/watch?v=x", "host"],
		["https://www.youtube.co.uk/watch?v=x", "host"],
		["https://xn--youtube-6ya.com/watch?v=x", "host"],
		["https://xn--yutube-wqf.com/watch?v=x", "host"],
		["https://wwww.youtube.com/watch?v=x", "host"],
		["https://www.tiktok.com.cn/@a/video/1", "host"],
		["https://tiktokv.com/x", "host"],
		["https://youtube.com../watch?v=x", "host"],
		["https://.youtube.com/watch?v=x", "host"],
		["https://www.youtube-nocookie.com/embed/x", "host"],
		// userinfo tricks
		["https://youtube.com@evil.com/", "authority"],
		["https://user:pass@www.youtube.com/watch?v=x", "authority"],
		["https://www.youtube.com:@evil.com/", "authority"],
		["https://www.youtube.com%40evil.com/", "authority"],
		// a second parser would read these differently (backslash, percent-encoded host)
		["https://www.youtube.com\\@evil.com/", "characters"],
		["https://you%74ube.com/watch?v=x", "authority"],
		// ports
		["https://www.youtube.com:8443/watch?v=x", "authority"],
		["https://www.youtube.com:0/watch?v=x", "authority"],
		["https://www.youtube.com:/watch?v=x", "authority"],
		// IP literals
		["https://127.0.0.1/watch?v=x", "host"],
		["https://[::1]/watch?v=x", "authority"],
		["https://2130706433/watch?v=x", "host"],
		["https://0x7f.1/", "host"],
		// non-ASCII, whitespace, control characters anywhere
		["https://www.yоutube.com/watch?v=x", "characters"], // Cyrillic о
		["https://ｗｗｗ.youtube.com/watch?v=x", "characters"], // full-width letters fold to ASCII in WHATWG
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ\n--exec", "characters"],
		[" https://www.youtube.com/watch?v=x", "characters"],
		["https://www.youtube.com/watch?v=x ", "characters"],
		["https://www.youtube.com/watch?v=x\t", "characters"],
		["https://www.youtube.com/watch?v=x\u0000", "characters"],
		["https://www.youtube.com/watch?v=x\u202e", "characters"],
		// option-looking input
		["-o/etc/passwd", "leading-dash"],
		["--exec=touch /tmp/pwned", "leading-dash"],
		["-https://www.youtube.com/watch?v=x", "leading-dash"],
		// empty
		["", "empty"],
	];
	for (const [input, reason] of cases) {
		test(JSON.stringify(input), () => {
			const result = refusal(input);
			expect(result.code).toBe("url-refused");
			expect(result.reason).toBe(reason);
		});
	}

	test("not a string", () => {
		for (const input of [undefined, null, 5, {}, [], ["https://youtu.be/x"], { toString: () => "https://youtu.be/x" }]) {
			expect(refusal(input)).toEqual({ ok: false, code: "url-refused", reason: "type" });
		}
	});

	test("too long: 2048 characters pass, 2049 do not", () => {
		const base = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=";
		const exact = base + "a".repeat(MAX_URL_CHARS - base.length);
		expect(exact.length).toBe(2048);
		expect(accepted(exact).url).toBe(exact);
		expect(refusal(`${exact}a`).reason).toBe("too-long");
		expect(refusal("h".repeat(10_000_000)).reason).toBe("too-long");
	});

	test("a YouTube playlist-only link is refused with its own code", () => {
		for (const input of ["https://www.youtube.com/playlist?list=PL123", "https://music.youtube.com/playlist?list=OLAK5uy"]) {
			expect(refusal(input)).toEqual({ ok: false, code: "playlist-refused", reason: "playlist" });
		}
	});
});
