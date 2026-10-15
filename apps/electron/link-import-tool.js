// "Import from link": where the yt-dlp binary comes from. No Electron import: fetch, the file
// system and the consent dialog are injected, so all of it runs under bun.
//
// 1. yt-dlp on PATH: only ABSOLUTE PATH entries are searched (a relative entry, "." or an
//    empty entry would mean the current directory), on POSIX not a file or directory that the
//    group or others can write (skipped and logged), and only if it reports a version that is
//    new enough for the options link-import-args.js passes (MIN_VERSION). An older one is
//    "outdated": it is not run for the job; the managed copy below is used instead, and if there
//    is none the consent dialog names the old one, and declining (or a platform without an
//    official binary) ends the job with "tool-outdated" (the page says which version is needed).
// 2. Otherwise the copy Ccut installed earlier in userData/bin, re-hashed against its manifest
//    before every use (a changed or replaced file is not run). Only a copy whose manifest says it
//    was verified with the pinned signing key is used (older installs are downloaded again).
// 3. Otherwise, only after the user agreed in a main-process dialog: the official release
//    binary from github.com/yt-dlp/yt-dlp. The release tag is resolved once; that SAME tag's
//    SHA2-256SUMS and SHA2-256SUMS.sig are fetched first, and the sums are trusted only if the
//    signature verifies with yt-dlp's signing key embedded in Ccut (link-import-ytdlp-key.js,
//    fingerprint pinned; link-import-openpgp.js). Then the binary is streamed to a temporary
//    0600 file while it is hashed; only a hash matching the signed sums makes it 0755 and
//    renames it into place. Redirects are followed by hand: https only, GitHub's own hosts only,
//    a few hops. Size caps on all three files. This proves who published the sums (yt-dlp's key),
//    not only that they arrived intact (see docs/ccut/link-import-security-notes.md).
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { loadPinnedKey, verifyDetachedSignature } = require("./link-import-openpgp");
const { YT_DLP_SIGNING_KEY_ARMORED, YT_DLP_SIGNING_KEY_FINGERPRINT } = require("./link-import-ytdlp-key");

// The oldest yt-dlp with every option and feature link-import-args.js uses. The newest of them is
// --no-plugin-dirs: yt-dlp 2025.03.21 (Changelog.md "Load plugins on demand", commit 4445f37; the
// 2025.02.19 release answers "no such option: --no-plugin-dirs"). The table with every option
// and its source: docs/ccut/link-import.md, "Sürüm tabanı".
const MIN_VERSION = "2025.03.21";
// The oldest signature creation time (seconds, UTC) a SHA2-256SUMS.sig may carry: 2025-03-01, after
// yt-dlp 2025.02.19 and before 2025.03.21 (MIN_VERSION). The release tag comes from an unsigned
// redirect and the sums name no version, so this signed time is what stops a takeover of the
// GitHub account from serving an older, genuinely signed release as "latest" (it cannot stop a
// rollback to a release newer than this). NOT checked against the real 2025.03.21 signature
// (github.com release files are not reachable from the sandbox).
const MIN_SIGNED_AT = Date.UTC(2025, 2, 1) / 1000;
const RELEASES = "https://github.com/yt-dlp/yt-dlp/releases";
const LATEST_URL = `${RELEASES}/latest`;
const SUMS_ASSET = "SHA2-256SUMS";
const SIG_ASSET = "SHA2-256SUMS.sig";
const MANIFEST_NAME = "yt-dlp.manifest.json";
const YT_DLP_SIGNING_KEY = Object.freeze({ armored: YT_DLP_SIGNING_KEY_ARMORED, fingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT });
const DOWNLOAD_HOSTS = Object.freeze(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const LIMITS = Object.freeze({
	maxRedirects: 5,
	maxSumsBytes: 64 * 1024,
	maxSignatureBytes: 16 * 1024,
	minSignedAt: MIN_SIGNED_AT,
	maxBinaryBytes: 200 * 1024 * 1024,
	maxManifestBytes: 4096,
	downloadTimeoutMs: 10 * 60 * 1000,
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TAG_PATTERN = String.raw`\d{4}\.\d{2}\.\d{2}(?:\.\d{1,10})?`;
const LEFTOVER = /^\.yt-dlp-[0-9a-f]{16}\.(?:download|manifest)$/;

class ToolError extends Error {
	constructor(code) {
		super(`link import tool: ${code}`);
		this.name = "ToolError";
		this.code = code;
	}
}
const fail = (code) => {
	throw new ToolError(code);
};

// --- versions ---

/** "2025.09.26" or "2024.12.06.232909" (with one trailing newline) -> [y, m, d, n]; anything else null. */
function parseVersion(text) {
	if (typeof text !== "string") return null;
	const match = new RegExp(`^(${TAG_PATTERN})$`).exec(text.replace(/\r?\n$/, ""));
	if (!match) return null;
	const [year, month, day, extra = "0"] = match[1].split(".");
	return [Number(year), Number(month), Number(day), Number(extra)];
}

function compareVersions(a, b) {
	for (let i = 0; i < 4; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

// --- PATH ---

const GROUP_OR_WORLD_WRITABLE = 0o022;

/**
 * POSIX only: why this candidate must not be trusted, or null. A yt-dlp that the group or any
 * user can overwrite (the file itself, or the directory it is in: the entry and, for a symlink,
 * the real location) is a way to run someone else's code as the user, so it is skipped like an
 * unusable candidate. `fsp.stat` follows links, so a link is judged by its target.
 */
async function writableByOthers({ candidate, stat }) {
	if (stat.mode & GROUP_OR_WORLD_WRITABLE) return "the file is writable by its group or by others";
	const real = await fsp.realpath(candidate);
	for (const directory of new Set([path.dirname(candidate), path.dirname(real)])) {
		if ((await fsp.stat(directory)).mode & GROUP_OR_WORLD_WRITABLE) return `its directory ${directory} is writable by its group or by others`;
	}
	return null;
}

async function realStatFile({ candidate, platform }) {
	try {
		const stat = await fsp.stat(candidate);
		if (!stat.isFile()) return { isFile: false, executable: false };
		if (platform === "win32") return { isFile: true, executable: true };
		await fsp.access(candidate, fs.constants.X_OK);
		const unsafe = await writableByOthers({ candidate, stat });
		return unsafe ? { isFile: true, executable: true, unsafe } : { isFile: true, executable: true };
	} catch {
		return null;
	}
}

/**
 * The first absolute PATH entry holding an executable yt-dlp, or null. A candidate the stat
 * reports as `unsafe` (POSIX: writable by group or others) is logged and skipped.
 */
async function findOnPath({ envPath, platform, pathApi, statFile, log }) {
	const api = pathApi ?? (platform === "win32" ? path.win32 : path.posix);
	const stat = statFile ?? ((candidate) => realStatFile({ candidate, platform }));
	if (typeof envPath !== "string" || envPath === "") return null;
	const name = platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
	for (const raw of envPath.split(api.delimiter)) {
		const entry = platform === "win32" ? raw.replace(/^"(.*)"$/, "$1") : raw;
		if (entry === "" || !api.isAbsolute(entry)) continue;
		const candidate = api.join(entry, name);
		const info = await stat(candidate);
		if (!info || !info.isFile || !info.executable) continue;
		if (info.unsafe) {
			if (log) log(`[ccut] link import: skipping ${candidate} on PATH (${info.unsafe})`);
			continue;
		}
		return candidate;
	}
	return null;
}

// --- official release ---

function managedAssetFor({ platform, arch }) {
	if (platform === "linux" && arch === "x64") return "yt-dlp_linux";
	if (platform === "win32" && arch === "x64") return "yt-dlp.exe";
	if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return "yt-dlp_macos"; // universal binary
	return null;
}

const installedName = (platform) => (platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

/** The asset's lower-case hex SHA-256 from a sha256sum-style file; any doubt is tool-verify-failed. */
function parseSha256Sums({ text, assetName }) {
	if (typeof text !== "string" || text.length > LIMITS.maxSumsBytes) fail("tool-verify-failed");
	const entries = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]{1,128})$/.exec(line);
		if (!match || entries.has(match[2])) fail("tool-verify-failed");
		entries.set(match[2], match[1]);
	}
	if (!entries.has(assetName)) fail("tool-verify-failed");
	return entries.get(assetName);
}

function checkDownloadUrl(href) {
	let url;
	try {
		url = new URL(href);
	} catch {
		return fail("tool-download-failed");
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !DOWNLOAD_HOSTS.includes(url.hostname)) {
		fail("tool-download-failed");
	}
	return url;
}

const discardBody = (response) => {
	try {
		response.body?.cancel?.();
	} catch {}
};

/** GET with redirect "manual": every hop's URL is checked before it is requested. A 200 response. */
async function fetchFollowing({ fetch, url, signal, limits }) {
	let current = url;
	for (let hop = 0; hop <= limits.maxRedirects; hop++) {
		checkDownloadUrl(current);
		const response = await fetch(current, { redirect: "manual", signal });
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			discardBody(response);
			if (!location) fail("tool-download-failed");
			current = new URL(location, current).href;
			continue;
		}
		if (response.status !== 200) {
			discardBody(response);
			fail("tool-download-failed");
		}
		return response;
	}
	return fail("tool-download-failed");
}

async function resolveLatestTag({ fetch, signal }) {
	checkDownloadUrl(LATEST_URL);
	const response = await fetch(LATEST_URL, { redirect: "manual", signal });
	discardBody(response);
	const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
	if (!location) fail("tool-download-failed");
	const target = new URL(location, LATEST_URL);
	const match = new RegExp(`^/yt-dlp/yt-dlp/releases/tag/(${TAG_PATTERN})$`).exec(target.pathname);
	if (target.origin !== "https://github.com" || target.search !== "" || target.hash !== "" || !match) fail("tool-download-failed");
	return match[1];
}

function declaredLength(response) {
	const header = response.headers.get("content-length");
	return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}

/** Streams the body to `onChunk`, refusing more than `maxBytes` (declared or actual). */
async function streamCapped({ response, maxBytes, onChunk }) {
	const declared = declaredLength(response);
	if (declared !== null && declared > maxBytes) {
		discardBody(response);
		fail("tool-download-failed");
	}
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.byteLength;
		if (total > maxBytes) fail("tool-download-failed"); // leaving the loop cancels the stream
		await onChunk(chunk);
	}
	if (declared !== null && declared !== total) fail("tool-download-failed");
	return total;
}

async function readCappedBytes({ response, maxBytes }) {
	const parts = [];
	await streamCapped({ response, maxBytes, onChunk: (chunk) => parts.push(Buffer.from(chunk)) });
	return Buffer.concat(parts);
}

const asToolError = (error) => (error instanceof ToolError ? error : new ToolError("tool-download-failed"));

/**
 * Downloads, verifies and installs the official binary into `binDir` (created 0700).
 * { path, version, sha256, size }; ToolError "tool-missing" | "tool-download-failed" |
 * "tool-signature-failed" | "tool-verify-failed". `signingKey` ({ armored, fingerprint }) is
 * yt-dlp's embedded key unless a test passes its own. `newerThan` (an installed version, for an
 * update): a release tag that is not newer than it is refused before anything but the tag is fetched,
 * so a stale redirect cannot replace a newer copy with an older one.
 */
async function installManagedBinary({
	fetch,
	binDir,
	platform,
	arch,
	fsApi = fsp,
	pathApi = path,
	now = Date.now,
	randomHex = () => crypto.randomBytes(8).toString("hex"),
	limits: overrides = {},
	signal: outerSignal,
	signingKey = YT_DLP_SIGNING_KEY,
	newerThan = null,
}) {
	const limits = { ...LIMITS, ...overrides };
	const asset = managedAssetFor({ platform, arch });
	if (!asset) fail("tool-missing");
	// The key is loaded (and its fingerprint checked against the pin) before anything is fetched.
	let key;
	try {
		key = loadPinnedKey(signingKey);
	} catch {
		fail("tool-signature-failed");
	}
	// The job's Cancel AND a time limit: a stalled download must end even if nobody cancels.
	// A plain controller and timer (not AbortSignal.any/timeout, whose source signals a runtime
	// may collect before they fire); both are undone when the install ends.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("download time limit")), limits.downloadTimeoutMs);
	const forwardAbort = () => controller.abort(outerSignal.reason);
	if (outerSignal?.aborted) controller.abort(outerSignal.reason);
	else outerSignal?.addEventListener("abort", forwardAbort, { once: true });
	try {
		return await installWithSignal({ fetch, binDir, platform, asset, key, fsApi, pathApi, now, randomHex, limits, newerThan, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		outerSignal?.removeEventListener("abort", forwardAbort);
	}
}

/** The sums file's bytes, only if SHA2-256SUMS.sig of the same tag verifies with `key`. */
async function fetchSignedSums({ fetch, tag, key, signal, limits }) {
	const sumsResponse = await fetchFollowing({ fetch, url: `${RELEASES}/download/${tag}/${SUMS_ASSET}`, signal, limits });
	const sums = await readCappedBytes({ response: sumsResponse, maxBytes: limits.maxSumsBytes });
	const sigResponse = await fetchFollowing({ fetch, url: `${RELEASES}/download/${tag}/${SIG_ASSET}`, signal, limits });
	const signature = await readCappedBytes({ response: sigResponse, maxBytes: limits.maxSignatureBytes });
	let verified;
	try {
		verified = verifyDetachedSignature({ data: sums, signature, key });
	} catch {
		fail("tool-signature-failed");
	}
	if (verified.created < limits.minSignedAt) fail("tool-signature-failed");
	return sums;
}

async function installWithSignal({ fetch, binDir, platform, asset, key, fsApi, pathApi, now, randomHex, limits, newerThan, signal }) {
	await fsApi.mkdir(binDir, { recursive: true, mode: 0o700 });
	if (platform !== "win32") await fsApi.chmod(binDir, 0o700);

	let tag;
	let expected;
	try {
		tag = await resolveLatestTag({ fetch, signal });
		// Early and cheap, not a security boundary (the tag is unsigned): see MIN_SIGNED_AT.
		if (compareVersions(parseVersion(tag), parseVersion(MIN_VERSION)) < 0) fail("tool-download-failed");
		if (newerThan !== null && compareVersions(parseVersion(tag), parseVersion(newerThan) ?? [Infinity, 0, 0, 0]) <= 0) fail("tool-download-failed");
		const sums = await fetchSignedSums({ fetch, tag, key, signal, limits });
		expected = parseSha256Sums({ text: sums.toString("utf8"), assetName: asset });
	} catch (error) {
		throw asToolError(error);
	}

	const source = `${RELEASES}/download/${tag}/${asset}`;
	const tempPath = pathApi.join(binDir, `.yt-dlp-${randomHex()}.download`);
	const hash = crypto.createHash("sha256");
	let handle = null;
	let size = 0;
	try {
		const response = await fetchFollowing({ fetch, url: source, signal, limits });
		handle = await fsApi.open(tempPath, "wx", 0o600); // never executable before the hash matched
		size = await streamCapped({
			response,
			maxBytes: limits.maxBinaryBytes,
			onChunk: async (chunk) => {
				hash.update(chunk);
				await handle.write(chunk);
			},
		});
		const actual = hash.digest("hex");
		if (actual !== expected) fail("tool-verify-failed");
		await handle.sync();
		await handle.close();
		handle = null;
		if (platform !== "win32") await fsApi.chmod(tempPath, 0o755);
		await fsApi.rename(tempPath, pathApi.join(binDir, installedName(platform)));
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		await fsApi.unlink(tempPath).catch(() => {});
		throw asToolError(error);
	}

	const manifest = { version: tag, asset, sha256: expected, size, source, installedAt: new Date(now()).toISOString(), signingKey: key.fingerprint };
	const manifestTemp = pathApi.join(binDir, `.yt-dlp-${randomHex()}.manifest`);
	try {
		await fsApi.writeFile(manifestTemp, `${JSON.stringify(manifest, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		await fsApi.rename(manifestTemp, pathApi.join(binDir, MANIFEST_NAME));
	} catch (error) {
		await fsApi.unlink(manifestTemp).catch(() => {});
		throw asToolError(error);
	}
	return { path: pathApi.join(binDir, installedName(platform)), version: tag, sha256: expected, size };
}

async function sha256OfFile({ fsApi, filePath, size }) {
	const hash = crypto.createHash("sha256");
	const handle = await fsApi.open(filePath, "r");
	const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
	try {
		let position = 0;
		// Bounded: each round reads at least one byte or stops.
		for (let round = 0; position < size && round <= size; round++) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		if (position !== size) return null;
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

/**
 * The installed copy if its manifest is sound, says it was verified with `signingKey` (an install
 * from before signatures were checked has no such field), and the file (not a link) still hashes
 * to it; else null.
 */
async function readManagedBinary({ binDir, platform, fsApi = fsp, pathApi = path, signingKey = YT_DLP_SIGNING_KEY }) {
	try {
		const manifestPath = pathApi.join(binDir, MANIFEST_NAME);
		const manifestStat = await fsApi.lstat(manifestPath);
		if (!manifestStat.isFile() || manifestStat.size > LIMITS.maxManifestBytes) return null;
		const manifest = JSON.parse(await fsApi.readFile(manifestPath, "utf8"));
		const { version, sha256, size, signingKey: signedWith } = manifest ?? {};
		const installedVersion = parseVersion(version);
		// A copy older than today's floor (an old release served as "latest", or a raised MIN_VERSION) is not used.
		if (!installedVersion || compareVersions(installedVersion, parseVersion(MIN_VERSION)) < 0 || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0) return null;
		if (signedWith !== signingKey.fingerprint) return null;
		const binary = pathApi.join(binDir, installedName(platform));
		const stat = await fsApi.lstat(binary);
		if (!stat.isFile() || stat.size !== size) return null;
		if ((await sha256OfFile({ fsApi, filePath: binary, size })) !== sha256) return null;
		return { path: binary, version, sha256 };
	} catch {
		return null;
	}
}

/** Temporary files of an install that never finished (crash, power loss). */
async function sweepToolLeftovers({ binDir, fsApi = fsp, pathApi = path }) {
	let names;
	try {
		names = await fsApi.readdir(binDir);
	} catch {
		return;
	}
	for (const name of names) {
		if (LEFTOVER.test(name)) await fsApi.unlink(pathApi.join(binDir, name)).catch(() => {});
	}
}

/**
 * The resolver a job calls: { binary, version, source: "path"|"managed" } or ToolError
 * "tool-missing" | "tool-outdated" | "consent-declined" | "tool-download-failed" |
 * "tool-signature-failed" | "tool-verify-failed".
 * `onPhase` hears "tool-check", "consent", "tool-download". The job's `signal` (Cancel), `env`
 * and `cwd` are passed on: the version check runs like the job, the dialog and the download stop.
 * `confirmDownload` also hears `outdated`: { binary, version } of a too old PATH yt-dlp, or null.
 */
function createToolResolver({ findOnPath: findBinary, runVersion, readManaged, confirmDownload, install, platform, arch, log }) {
	const minimum = parseVersion(MIN_VERSION);
	return async function resolve({ onPhase, signal, env, cwd }) {
		onPhase("tool-check");
		const onPath = await findBinary();
		let outdated = null;
		if (onPath) {
			let text = null;
			try {
				text = await runVersion({ binary: onPath, env, cwd, signal });
			} catch (error) {
				log(`[ccut] link import: ${onPath} --version failed: ${error && error.message}`);
			}
			const version = parseVersion(text);
			if (version && compareVersions(version, minimum) >= 0) return { binary: onPath, version: text.trim(), source: "path" };
			// Only a real, older version is "outdated"; a binary that does not answer with one is just not used.
			if (version) outdated = { binary: onPath, version: text.trim() };
			log(`[ccut] link import: ignoring ${onPath} (version ${JSON.stringify(String(text).slice(0, 40))}, need ${MIN_VERSION} or newer)`);
		}
		const managed = await readManaged();
		if (managed) return { binary: managed.path, version: managed.version, source: "managed" };
		const asset = managedAssetFor({ platform, arch });
		if (!asset) fail(outdated ? "tool-outdated" : "tool-missing");
		onPhase("consent");
		if (!(await confirmDownload({ asset, signal, outdated })) || (signal && signal.aborted)) fail(outdated ? "tool-outdated" : "consent-declined");
		onPhase("tool-download");
		const installed = await install({ signal });
		return { binary: installed.path, version: installed.version, source: "managed" };
	};
}

module.exports = {
	DOWNLOAD_HOSTS,
	LATEST_URL,
	LIMITS,
	MIN_VERSION,
	RELEASES,
	SIG_ASSET,
	TAG_PATTERN,
	ToolError,
	YT_DLP_SIGNING_KEY,
	compareVersions,
	createToolResolver,
	findOnPath,
	installManagedBinary,
	managedAssetFor,
	parseSha256Sums,
	parseVersion,
	readManagedBinary,
	resolveLatestTag,
	sweepToolLeftovers,
};
