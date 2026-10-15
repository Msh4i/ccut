// The page's quick check of a pasted link, for an immediate answer in the dialog. It mirrors
// apps/electron/link-import-url.js; the MAIN PROCESS decides (it checks again and is the only
// one that passes anything to yt-dlp).

const MAX_URL_CHARS = 2048;

const YOUTUBE_HOSTS = [
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtu.be",
];
const TIKTOK_HOSTS = [
	"tiktok.com",
	"www.tiktok.com",
	"m.tiktok.com",
	"vm.tiktok.com",
	"vt.tiktok.com",
];
const ALLOWED_HOSTS = [...YOUTUBE_HOSTS, ...TIKTOK_HOSTS];

const SAFE_CHARS = /^[\x21-\x5b\x5d-\x7e]+$/;
const PLAIN_AUTHORITY = /^[a-z0-9.-]+(?::443)?$/i;

export type PreparedUrl =
	| { ok: true; url: string }
	| { ok: false; code: "url-refused" | "playlist-refused" };

const refused: PreparedUrl = { ok: false, code: "url-refused" };

export function prepareLinkUrl({ input }: { input: string }): PreparedUrl {
	const url = input.trim();
	if (
		url === "" ||
		url.length > MAX_URL_CHARS ||
		url.startsWith("-") ||
		!SAFE_CHARS.test(url)
	) {
		return refused;
	}
	const authority = /^https:\/\/([^/?#]*)/i.exec(url);
	if (!authority || !PLAIN_AUTHORITY.test(authority[1])) return refused;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return refused;
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== ""
	) {
		return refused;
	}
	const host = parsed.hostname.endsWith(".")
		? parsed.hostname.slice(0, -1)
		: parsed.hostname;
	if (!ALLOWED_HOSTS.includes(host)) return refused;
	if (YOUTUBE_HOSTS.includes(host) && parsed.pathname === "/playlist") {
		return { ok: false, code: "playlist-refused" };
	}
	return { ok: true, url };
}
