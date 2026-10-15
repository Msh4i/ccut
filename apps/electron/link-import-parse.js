// "Import from link": strict parsers for what yt-dlp writes. Pure, no Electron.
//
// - Progress: lines "<prefix> <downloaded> <total> <estimate> <speed> <eta>" from our own
//   --progress-template; the prefix carries a random per-job nonce. Numbers or "NA" only,
//   bounded length; anything else is ignored.
// - Result: the one line of JSON yt-dlp appends to the result file (--print-to-file); for the
//   pair (link-import-args.js) exactly two lines, the video-only file and the audio-only file.
// - Errors: the text yt-dlp prints is mapped to a short code. The text itself never leaves the
//   main process (it is logged, truncated).
const { StringDecoder } = require("node:string_decoder");

const MAX_PROGRESS_LINE_CHARS = 256;
const MAX_RESULT_CHARS = 64 * 1024;
const MAX_TITLE_CODE_POINTS = 200;

const NUMBER = String.raw`\d{1,20}(?:\.\d{1,20})?(?:[eE][+-]?\d{1,3})?`;
const FIELD = `(${NUMBER}|NA)`;
const INTEGER = /^\d{1,16}$/;
// A yt-dlp format id as Ccut accepts it: also the name of a downloaded file in the pair.
const FORMAT_ID = /^[0-9A-Za-z_-]{1,32}$/;
const FORMAT_ID_FIELD = "([0-9A-Za-z_-]{1,32})";

function numberOrNull(text) {
	if (text === "NA") return null;
	const value = Number(text);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * { downloadedBytes, totalBytes, speed, eta } or null for anything that is not our progress
 * line. With `withFormatId` (the pair) the line carries the format id first and it is returned
 * as `formatId`; each shape refuses the other.
 */
function parseProgressLine({ line, prefix, withFormatId = false }) {
	if (typeof line !== "string" || line.length > MAX_PROGRESS_LINE_CHARS || typeof prefix !== "string" || prefix === "") return null;
	const id = withFormatId ? ` ${FORMAT_ID_FIELD}` : "";
	const match = new RegExp(`^${escapeRegExp(prefix)}${id} ${FIELD} ${FIELD} ${FIELD} ${FIELD} ${FIELD}$`).exec(line);
	if (!match) return null;
	const formatId = withFormatId ? match[1] : null;
	const [downloadedText, totalText, estimateText, speedText, etaText] = match.slice(withFormatId ? 2 : 1);
	if (!INTEGER.test(downloadedText)) return null;
	const downloadedBytes = Number(downloadedText);
	if (!Number.isSafeInteger(downloadedBytes)) return null;
	const total = numberOrNull(totalText);
	const estimate = numberOrNull(estimateText);
	const speed = numberOrNull(speedText);
	const eta = numberOrNull(etaText);
	if ([total, estimate, speed, eta].includes(undefined)) return null;
	const totalBytes = total ?? estimate;
	return {
		...(withFormatId ? { formatId } : {}),
		downloadedBytes,
		totalBytes: totalBytes === null ? null : Math.round(totalBytes),
		speed,
		eta: eta === null ? null : Math.round(eta),
	};
}

const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const optionalDimension = (value) => (value === undefined || value === null ? null : Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : undefined);
const optionalCodec = (value) => (value === undefined || value === null ? null : typeof value === "string" && value.length <= 128 ? value : undefined);
const optionalDuration = (value) => (value === undefined || value === null ? null : typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

const resultLines = (text) => text.split(/\r?\n/).filter((line) => line !== "");

/** One result line -> the known fields rebuilt, or null. `withFormatId`: format_id is required. */
function parseResultLine({ line, withFormatId = false }) {
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isPlainObject(value)) return null;
	const { id, title, ext } = value;
	if (typeof id !== "string" || id.length === 0 || id.length > 256) return null;
	if (typeof title !== "string") return null;
	if (typeof ext !== "string" || !/^[a-z0-9]{1,8}$/.test(ext)) return null;
	if (withFormatId && (typeof value.format_id !== "string" || !FORMAT_ID.test(value.format_id))) return null;
	const info = {
		id,
		title,
		...(withFormatId ? { formatId: value.format_id } : {}),
		ext,
		width: optionalDimension(value.width),
		height: optionalDimension(value.height),
		vcodec: optionalCodec(value.vcodec),
		acodec: optionalCodec(value.acodec),
		duration: optionalDuration(value.duration),
	};
	return Object.values(info).includes(undefined) ? null : info;
}

/** The result file's text -> { ok: true, info } or { ok: false }. Exactly one non-empty line of JSON. */
function parseResultText(text) {
	if (typeof text !== "string" || text.length > MAX_RESULT_CHARS) return { ok: false };
	const lines = resultLines(text);
	if (lines.length !== 1) return { ok: false };
	const info = parseResultLine({ line: lines[0] });
	return info ? { ok: true, info } : { ok: false };
}

// The pair's two halves: an H.264 video-only MP4 and an AAC audio-only m4a.
const H264_CODEC = /^(avc1|avc3)(\.|$)/;
const AAC_CODEC = /^mp4a(\.|$)/;
const isPairVideo = (info) => info.ext === "mp4" && typeof info.vcodec === "string" && H264_CODEC.test(info.vcodec) && info.acodec === "none";
const isPairAudio = (info) => info.ext === "m4a" && info.vcodec === "none" && typeof info.acodec === "string" && AAC_CODEC.test(info.acodec);

/**
 * The pair's result file -> { ok: true, video, audio } (each with its formatId) or
 * { ok: false, reason }. Exactly two lines of the same video id with different format ids:
 * one H.264 MP4 video-only file and one AAC m4a audio-only file, in either order. One line
 * means yt-dlp found only one of the two ("partial").
 */
function parsePairResultText(text) {
	// No result file at all (null) means yt-dlp downloaded nothing: not two files either.
	if (text === null || text === undefined) return { ok: false, reason: "partial" };
	if (typeof text !== "string" || text.length > MAX_RESULT_CHARS) return { ok: false, reason: "text" };
	const lines = resultLines(text);
	if (lines.length < 2) return { ok: false, reason: "partial" };
	if (lines.length > 2) return { ok: false, reason: "lines" };
	const infos = lines.map((line) => parseResultLine({ line, withFormatId: true }));
	if (infos.includes(null)) return { ok: false, reason: "line" };
	const [first, second] = infos;
	if (first.id !== second.id || first.formatId === second.formatId) return { ok: false, reason: "ids" };
	const video = infos.find(isPairVideo);
	const audio = infos.find(isPairAudio);
	if (!video || !audio) return { ok: false, reason: "codecs" };
	return { ok: true, video, audio };
}

// C0/C1 controls become spaces; direction marks and other invisible format characters go.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE_CHARS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** A title for display and as a file name's start: plain text, one line, at most 200 code points. */
function sanitizeTitle(title) {
	if (typeof title !== "string") return "";
	const cleaned = title.replace(CONTROL_CHARS, " ").replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim();
	return Array.from(cleaned).slice(0, MAX_TITLE_CODE_POINTS).join("").trim();
}

// First match wins; ERROR lines are looked at before the rest of the output.
const ERROR_RULES = [
	["tool-outdated", /no such option|unrecognized arguments|error: option .* requires/i],
	["too-large", /larger than max-filesize/i],
	["private", /private video|(?:video|post|account) is private/i],
	["geo-blocked", /not (?:made )?(?:this video )?available in your (?:country|region)|available from your location|geo[- ]?restrict|IP address is blocked|blocked in your country/i],
	["login-required", /sign in to confirm|confirm your age|age[- ]restricted|inappropriate for some users|members[- ]only|join this channel|log ?in (?:for access|required|to )|login required|requires? (?:authentication|login|an account)|--cookies/i],
	["rate-limited", /HTTP Error 429|Too Many Requests|rate[- ]limit/i],
	// The site changed under yt-dlp (an extractor or signature breaks): a newer yt-dlp usually fixes it.
	// Not a rate limit, a private/geo/login case or a network failure: those are matched above/below.
	// Only yt-dlp's own error line: "ERROR: [extractor] id: <phrase>" (or the bare "ERROR: unable to download video data: HTTP Error 403"),
	// the phrase right after the prefix. Free text (a claimant's name in a copyright notice) never matches.
	["extractor-failed", /^\s*ERROR:\s*(?:\[[^\]]{1,64}\]\s+[^\s:]{1,64}:\s*)?(?:unable to extract\b|(?:n|nsig|signature) extraction failed|unable to download video data: HTTP Error 403)/i],
	["unsupported", /Unsupported URL|no suitable (?:info)?extractor/i],
	["no-compatible-format", /Requested format is not available|No video formats found/i],
	["unavailable", /video unavailable|no longer available|has been removed|has been terminated|does not exist|HTTP Error 404|video (?:is )?not available|post (?:is )?not available/i],
	[
		"network",
		/Unable to download (?:webpage|API page|video data|JSON metadata|data)|urlopen error|name resolution|Name or service not known|getaddrinfo failed|nodename nor servname|Network is unreachable|No route to host|Connection (?:refused|reset|aborted|timed out|broken)|timed out|Remote end closed|TransportError|CERTIFICATE_VERIFY_FAILED|SSL: /i,
	],
];

// A line with an HTTP status means the server answered: whatever it is, it is not "offline".
const HTTP_STATUS = /HTTP Error \d{3}/i;

function matchRules(lines) {
	for (const [code, pattern] of ERROR_RULES) {
		const matches = (line) => pattern.test(line) && !(code === "network" && HTTP_STATUS.test(line));
		if (lines.some(matches)) return code;
	}
	return null;
}

/** yt-dlp's output lines (no progress lines) -> an error code, "unknown" when nothing matches. */
function mapYtDlpError({ lines }) {
	if (!Array.isArray(lines)) return "unknown";
	const text = lines.filter((line) => typeof line === "string");
	const errors = text.filter((line) => /^\s*ERROR:/.test(line));
	// Without an ERROR line only the messages that never carry that prefix are looked for.
	const fromErrors = matchRules(errors);
	if (fromErrors) return fromErrors;
	const others = text.filter((line) => /no such option|unrecognized arguments|error: option|larger than max-filesize/i.test(line));
	return matchRules(others) ?? "unknown";
}

/**
 * Bytes in, complete lines out (UTF-8, split on \n, \r\n and \r, empty lines dropped). A line
 * longer than `maxLineChars` is dropped whole: at most that many characters are ever buffered.
 */
function createLineSplitter({ maxLineChars, onLine }) {
	const decoder = new StringDecoder("utf8");
	let partial = "";
	let dropping = false;
	let dropped = 0;

	const feed = (text) => {
		const pieces = text.split(/\r\n|\r|\n/);
		const rest = pieces.pop(); // after the last line break: not a complete line yet
		for (const piece of pieces) {
			if (dropping) {
				dropping = false; // this piece ends the line that overflowed (already counted)
				continue;
			}
			const line = partial + piece;
			partial = "";
			if (line.length > maxLineChars) {
				dropped++;
				continue;
			}
			if (line !== "") onLine(line);
		}
		if (dropping) return;
		partial += rest;
		if (partial.length > maxLineChars) {
			partial = "";
			dropping = true;
			dropped++;
		}
	};

	return {
		push(chunk) {
			feed(decoder.write(chunk));
		},
		end() {
			feed(decoder.end());
			if (!dropping && partial !== "") onLine(partial);
			partial = "";
			dropping = false;
		},
		bufferedChars: () => partial.length,
		droppedLines: () => dropped,
	};
}

module.exports = {
	FORMAT_ID,
	MAX_PROGRESS_LINE_CHARS,
	MAX_RESULT_CHARS,
	MAX_TITLE_CODE_POINTS,
	createLineSplitter,
	mapYtDlpError,
	parsePairResultText,
	parseProgressLine,
	parseResultText,
	sanitizeTitle,
};
