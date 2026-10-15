// "Import from link": which links the main process lets yt-dlp see. Pure, no Electron.
//
// Rules: a string of printable ASCII only (no whitespace, control, direction or look-alike
// characters), at most 2048 characters, not starting with "-", "https://" followed by an
// authority that is only a host name (no userinfo, no percent-encoding, no IP literal, no
// port but 443), the host EXACTLY one of ALLOWED_HOSTS after lower-casing and removing one
// trailing dot. The URL passed on is re-serialized from the parsed form, so yt-dlp (another
// URL parser, Python's) gets one unambiguous string. YouTube playlist-only links are refused,
// a playlist parameter on a single-video link is removed.
const MAX_URL_CHARS = 2048;

const YOUTUBE_HOSTS = Object.freeze(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const TIKTOK_HOSTS = Object.freeze(["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]);
const ALLOWED_HOSTS = Object.freeze([...YOUTUBE_HOSTS, ...TIKTOK_HOSTS]);

const PLAYLIST_PARAMS = Object.freeze(["list", "index", "start_radio"]);

// Printable ASCII without the space; a backslash is refused too (WHATWG reads it as "/",
// Python's urllib does not).
const SAFE_CHARS = /^[\x21-\x5b\x5d-\x7e]+$/;
// The authority as typed: a DNS-style name and at most the default port.
const PLAIN_AUTHORITY = /^[a-z0-9.-]+(?::443)?$/i;

const refuse = (reason, code = "url-refused") => ({ ok: false, code, reason });

/**
 * { ok: true, url, host, platform: "youtube"|"tiktok" } or
 * { ok: false, code: "url-refused"|"playlist-refused", reason }.
 */
function validateLinkUrl(input) {
	if (typeof input !== "string") return refuse("type");
	if (input === "") return refuse("empty");
	if (input.length > MAX_URL_CHARS) return refuse("too-long");
	if (input.startsWith("-")) return refuse("leading-dash");
	if (!SAFE_CHARS.test(input)) return refuse("characters");
	if (!/^https:\/\//i.test(input)) return refuse("not-https");
	const authority = /^https:\/\/([^/?#]*)/i.exec(input)[1];
	if (!PLAIN_AUTHORITY.test(authority)) return refuse("authority");

	let parsed;
	try {
		parsed = new URL(input);
	} catch {
		return refuse("unparseable");
	}
	if (parsed.protocol !== "https:") return refuse("not-https");
	if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return refuse("authority");
	const host = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
	if (!ALLOWED_HOSTS.includes(host)) return refuse("host");

	const platform = YOUTUBE_HOSTS.includes(host) ? "youtube" : "tiktok";
	if (platform === "youtube") {
		if (parsed.pathname === "/playlist") return refuse("playlist", "playlist-refused");
		if (PLAYLIST_PARAMS.some((name) => parsed.searchParams.has(name))) {
			for (const name of PLAYLIST_PARAMS) parsed.searchParams.delete(name);
		}
	}
	const url = `https://${host}${parsed.pathname}${parsed.search}`;
	// The serializer percent-encodes; this is a guard, not an expected path.
	if (url.length > MAX_URL_CHARS || !SAFE_CHARS.test(url)) return refuse("characters");
	return { ok: true, url, host, platform };
}

module.exports = { ALLOWED_HOSTS, MAX_URL_CHARS, TIKTOK_HOSTS, YOUTUBE_HOSTS, validateLinkUrl };
