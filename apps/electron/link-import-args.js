// "Import from link": the one place that builds yt-dlp's argument array. Pure, no Electron.
//
// Fixed options first, then "--" (end of options), then the URL as the LAST element: the
// URL is re-validated here and the canonical form from link-import-url.js is used, so nothing
// typed in the page can become an option. The process runs with cwd = the job directory, so
// the output template and the result file are relative names (an absolute userData path would
// go through yt-dlp's template "%" and "$VAR"/"~" expansion).
//
// There is no ffmpeg. Two strategies (chooseStrategy):
// - "single": one file with video and sound together (formatSelector). Audio only, TikTok,
//   and the fallback of a YouTube video.
// - "pair": a YouTube video in Video mode. One invocation downloads an H.264 MP4 video-only
//   stream and an AAC m4a audio-only stream as two separate files (a comma in -f: no merge,
//   so yt-dlp never needs or runs ffmpeg, whether or not one is installed); the main process
//   then copies their packets into one MP4 (link-import-mux.js). Each file gets its format id
//   as its name, and the progress and result lines carry the format id.
const { validateLinkUrl } = require("./link-import-url");

const MODES = Object.freeze(["video", "audio"]);
const STRATEGIES = Object.freeze(["single", "pair"]);
// The quality limit in pixels of the SHORT side ("1080p" is a 1080x1920 portrait video as well
// as a 1920x1080 one). A format filter cannot do that ([height<=?N] excludes a 1080x1920 video and
// picks a 576x1024 one instead; filters compare one field with a constant), so it is applied as a
// format SORT: -S "res:N" ranks formats by min(width, height), best first among those <= N.
// Unlike the old filter it is a preference, not a ban: if every format is above N, the smallest of
// them is chosen (the --max-filesize cap still applies).
const QUALITY_HEIGHTS = Object.freeze({ best: null, 1080: 1080, 720: 720 });
const DEFAULT_MAX_FILESIZE_BYTES = 2 * 1024 ** 3;
const MIN_FILESIZE_CAP = 1024 ** 2;
const MAX_FILESIZE_CAP = 16 * 1024 ** 3;

const OUTPUT_DIR = "out";
const OUTPUT_TEMPLATE = `${OUTPUT_DIR}/media.%(ext)s`;
const RESULT_FILE = "ccut-result.json";
// Only the fields the page needs; "j" makes it one line of JSON (newlines in a title are escaped).
const RESULT_TEMPLATE = "%(.{id,title,ext,width,height,vcodec,acodec,duration})j";
// The pair: one result line per downloaded file (after_move runs once per file).
const PAIR_OUTPUT_TEMPLATE = `${OUTPUT_DIR}/%(format_id)s.%(ext)s`;
const PAIR_RESULT_TEMPLATE = "%(.{id,title,format_id,ext,width,height,vcodec,acodec,duration})j";
// Extractor names (lower-case IE_NAME, full regex match): single videos only. Playlists,
// channels, user pages and yt-dlp's "generic" extractor (which would follow anything a page
// embeds) are not loaded at all.
const EXTRACTORS = "youtube,tiktok,vm\\.tiktok";

const H264 = "[vcodec~='^(avc1|avc3|h264)']";
// Chromium has no software HEVC decoder; TikTok often offers bytevc1 (HEVC).
const NOT_HEVC = "[vcodec!~=?'^(hev1|hvc1|h265|hevc|bytevc1)']";
// Direct HTTPS downloads only (no HLS/MPEG-TS, no DASH segments). DRC ("140-drc") is YouTube's
// dynamic-range-compressed variant of the same audio: the plain one is wanted.
const PAIR_VIDEO = "bv[vcodec~='^(avc1|avc3)'][ext=mp4][protocol=https]";
const PAIR_AUDIO = "ba[acodec~='^mp4a'][ext=m4a][protocol=https][format_id!*=drc]";

const isNonce = (value) => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

function progressPrefix({ nonce }) {
	if (!isNonce(nonce)) throw new Error("link import: bad nonce");
	return `ccut-progress-${nonce}`;
}

/**
 * yt-dlp's -f value. Video: a combined audio+video file ("b"), H.264 in MP4 preferred, never
 * HEVC; the quality limit is a sort (formatSortArgs). Audio: the best audio-only file, no
 * re-encoding.
 */
function formatSelector({ mode, quality }) {
	if (!MODES.includes(mode)) throw new Error("link import: unknown mode");
	if (!Object.hasOwn(QUALITY_HEIGHTS, quality)) throw new Error("link import: unknown quality");
	if (mode === "audio") return "ba[ext=m4a]/ba[ext=webm]/ba";
	return [`b${H264}[ext=mp4]`, `b${H264}`, `b${NOT_HEVC}`].join("/");
}

/** "pair" only for a YouTube link in Video mode; everything else keeps the single file. */
function chooseStrategy({ mode, platform }) {
	return mode === "video" && platform === "youtube" ? "pair" : "single";
}

/**
 * yt-dlp's -f value for the pair: the best H.264 MP4 video-only stream and, separately, the best AAC m4a audio-only stream that is not DRC (the
 * quality limit is a sort: formatSortArgs).
 */
function pairFormatSelector({ quality }) {
	if (!Object.hasOwn(QUALITY_HEIGHTS, quality)) throw new Error("link import: unknown quality");
	return `${PAIR_VIDEO},${PAIR_AUDIO}`;
}

/**
 * yt-dlp's format-sort arguments: the quality limit on the short side (see QUALITY_HEIGHTS).
 * Nothing for "best" and for audio only (the quality does not apply to audio).
 */
function formatSortArgs({ mode, quality }) {
	if (!MODES.includes(mode)) throw new Error("link import: unknown mode");
	if (!Object.hasOwn(QUALITY_HEIGHTS, quality)) throw new Error("link import: unknown quality");
	const limit = QUALITY_HEIGHTS[quality];
	return mode === "audio" || limit === null ? [] : ["-S", `res:${limit}`];
}

function buildYtDlpArgs({ url, mode, quality, nonce, maxFilesizeBytes = DEFAULT_MAX_FILESIZE_BYTES, strategy = "single" }) {
	const checked = validateLinkUrl(url);
	if (!checked.ok) throw new Error(`link import: URL refused (${checked.reason})`);
	if (!Number.isSafeInteger(maxFilesizeBytes) || maxFilesizeBytes < MIN_FILESIZE_CAP || maxFilesizeBytes > MAX_FILESIZE_CAP) {
		throw new Error("link import: bad max file size");
	}
	if (!STRATEGIES.includes(strategy)) throw new Error("link import: unknown strategy");
	const pair = strategy === "pair";
	if (pair && chooseStrategy({ mode, platform: checked.platform }) !== "pair") throw new Error("link import: the pair strategy is for YouTube videos only");
	const selector = pair ? pairFormatSelector({ quality }) : formatSelector({ mode, quality });
	const prefix = progressPrefix({ nonce });
	return [
		"--ignore-config",
		"--no-plugin-dirs",
		"--no-update",
		"--no-playlist",
		"--use-extractors",
		EXTRACTORS,
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
		String(maxFilesizeBytes),
		"--no-simulate",
		"--newline",
		"--progress",
		"--progress-template",
		`download:${prefix} ${pair ? "%(info.format_id)s " : ""}%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
		"--print-to-file",
		`after_move:${pair ? PAIR_RESULT_TEMPLATE : RESULT_TEMPLATE}`,
		RESULT_FILE,
		"-f",
		selector,
		...formatSortArgs({ mode, quality }),
		"-o",
		pair ? PAIR_OUTPUT_TEMPLATE : OUTPUT_TEMPLATE,
		"--",
		checked.url,
	];
}

module.exports = {
	DEFAULT_MAX_FILESIZE_BYTES,
	MODES,
	OUTPUT_DIR,
	OUTPUT_TEMPLATE,
	PAIR_OUTPUT_TEMPLATE,
	QUALITY_HEIGHTS,
	RESULT_FILE,
	STRATEGIES,
	buildYtDlpArgs,
	chooseStrategy,
	formatSelector,
	formatSortArgs,
	isNonce,
	pairFormatSelector,
	progressPrefix,
};
