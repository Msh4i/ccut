// "Import from link": the yt-dlp update POLICY (L9). No Electron import: everything is injected,
// so all of it runs under bun. Decision: local session, 2026-10-06, measurement pending.
//
// - Only the MANAGED copy (userData/bin) is ever updated. A yt-dlp on PATH is the user's own and
//   is never touched: this module has no way to reach it (it gets no path to it).
// - Nothing downloads or runs by itself. `check()` asks GitHub for the newest release TAG only
//   (the installer's own hardened redirect resolution: https, GitHub hosts, one hop, tag shape),
//   at most once per day, and the answer is only a version string for the dialog to show.
//   `update()` is the user's click: it shows the main-process dialog (what, from where, where to)
//   and only then runs the SAME install as the first download (installManagedBinary: the signed
//   SHA2-256SUMS, the pinned key, the hash, atomic rename). The tag of `check()` is never used
//   by the install: it resolves its own and refuses one that is not newer than the installed copy.
// - The daily throttle is a tiny file next to the managed manifest, written atomically, and
//   tolerant of anything: unreadable, corrupt, oversize or future-dated state counts as "never
//   checked" (so a wrong clock cannot switch the check off for good). It is never project storage.
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { ToolError, TAG_PATTERN, compareVersions, managedAssetFor, parseVersion } = require("./link-import-tool");

const STATE_NAME = "yt-dlp.update-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 1024;
// A clock that is a little ahead is not "the future": more than this is.
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const TAG_TIMEOUT_MS = 15_000;
const PATH_CACHE_MS = 60_000;
// The codes `update()` hands back (the page may show these and no other text).
const UPDATE_CODES = Object.freeze(["tool-missing", "consent-declined", "tool-download-failed", "tool-verify-failed", "tool-signature-failed", "busy", "up-to-date"]);

const TAG = new RegExp(`^${TAG_PATTERN}$`);
const isTag = (value) => typeof value === "string" && TAG.test(value);
const isPlainObject = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/** { checkedAt, latest } of the throttle file, or null for anything that is not a sound, past-dated record. */
async function readUpdateState({ binDir, now, fsApi = fsp, pathApi = path }) {
	try {
		const file = pathApi.join(binDir, STATE_NAME);
		const stat = await fsApi.lstat(file);
		if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return null;
		const state = JSON.parse(await fsApi.readFile(file, "utf8"));
		if (!isPlainObject(state)) return null;
		const { checkedAt, latest } = state;
		if (!Number.isSafeInteger(checkedAt) || checkedAt <= 0 || checkedAt > now + FUTURE_SKEW_MS) return null;
		if (latest !== null && !isTag(latest)) return null;
		return { checkedAt, latest };
	} catch {
		return null;
	}
}

/** Temp file + rename, 0600. False when it could not be written (the caller then does not query). */
async function writeUpdateState({ binDir, state, randomHex, fsApi = fsp, pathApi = path }) {
	// A name the startup sweep of leftovers knows (sweepToolLeftovers).
	const temp = pathApi.join(binDir, `.yt-dlp-${randomHex()}.manifest`);
	try {
		await fsApi.writeFile(temp, `${JSON.stringify({ checkedAt: state.checkedAt, latest: state.latest })}\n`, { flag: "wx", mode: 0o600 });
		await fsApi.rename(temp, pathApi.join(binDir, STATE_NAME));
		return true;
	} catch {
		await fsApi.unlink(temp).catch(() => {});
		return false;
	}
}

/** The tag if it is newer than the installed version, else null. */
function newerTag({ latest, installed }) {
	const a = parseVersion(latest);
	const b = parseVersion(installed);
	return a && b && compareVersions(a, b) > 0 ? latest : null;
}

/**
 * `readManaged` () -> { version } | null, `usablePathTool` () -> boolean (a yt-dlp on PATH that
 * meets the version floor: then the managed copy is not the one in use), `fetchLatestTag`
 * ({ signal }) -> tag (throws a ToolError), `confirmUpdate` ({ asset, current, latest }) -> boolean,
 * `install` ({ newerThan }) -> { version } (the verified install), `isBusy` () -> boolean.
 */
function createUpdateService({
	binDir,
	platform,
	arch,
	readManaged,
	usablePathTool,
	fetchLatestTag,
	confirmUpdate,
	install,
	isBusy,
	log,
	now = Date.now,
	randomHex = () => crypto.randomBytes(8).toString("hex"),
	fsApi = fsp,
	pathApi = path,
	tagTimeoutMs = TAG_TIMEOUT_MS,
}) {
	let checking = null;
	let updating = false;
	// The PATH version check spawns a process: its answer is kept for a minute (dialog opened
	// again and again, or concurrent callers), so the cost stays bounded.
	let pathAnswer = null;
	const pathToolUsable = async () => {
		if (pathAnswer && now() - pathAnswer.at >= 0 && now() - pathAnswer.at < PATH_CACHE_MS) return pathAnswer.usable;
		const usable = await usablePathTool();
		pathAnswer = { at: now(), usable };
		return usable;
	};

	const queryTag = async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("tag query time limit")), tagTimeoutMs);
		try {
			const tag = await fetchLatestTag({ signal: controller.signal });
			return isTag(tag) ? tag : null;
		} finally {
			clearTimeout(timer);
		}
	};

	async function runCheck() {
		// A job is running: no extra yt-dlp process now, and the offer can wait for the next open.
		if (isBusy()) return null;
		const managed = await readManaged();
		if (!managed) return null;
		if (await pathToolUsable()) return null;
		const state = await readUpdateState({ binDir, now: now(), fsApi, pathApi });
		if (state && now() - state.checkedAt < DAY_MS) return newerTag({ latest: state.latest, installed: managed.version });
		// The attempt is written BEFORE the query: a failing or slow network cannot make it retry
		// within the day, and if it cannot be written there is no query at all.
		if (!(await writeUpdateState({ binDir, state: { checkedAt: now(), latest: null }, randomHex, fsApi, pathApi }))) return null;
		let tag = null;
		try {
			tag = await queryTag();
		} catch (error) {
			log(`[ccut] link import: update check failed (${error instanceof ToolError ? error.code : "error"})`);
		}
		if (tag) await writeUpdateState({ binDir, state: { checkedAt: now(), latest: tag }, randomHex, fsApi, pathApi });
		return tag ? newerTag({ latest: tag, installed: managed.version }) : null;
	}

	return {
		/** A newer release tag for the managed copy (shown, never acted on), or null. Never throws. */
		check() {
			if (!checking) {
				checking = runCheck()
					.catch((error) => {
						log(`[ccut] link import: update check failed: ${error && error.message}`);
						return null;
					})
					.finally(() => {
						checking = null;
					});
			}
			return checking;
		},

		/** True while an update installs (the job manager then answers "busy" to a start). */
		isUpdating: () => updating,

		/** The user's click: { ok: true, version } or { ok: false, code } with a code of UPDATE_CODES. */
		async update() {
			if (updating || isBusy()) return { ok: false, code: "busy" };
			updating = true;
			try {
				const managed = await readManaged();
				const asset = managedAssetFor({ platform, arch });
				if (!managed || !asset) return { ok: false, code: "tool-missing" };
				let latest;
				try {
					latest = await queryTag();
				} catch (error) {
					return { ok: false, code: error instanceof ToolError && UPDATE_CODES.includes(error.code) ? error.code : "tool-download-failed" };
				}
				if (!latest) return { ok: false, code: "tool-download-failed" };
				if (!newerTag({ latest, installed: managed.version })) return { ok: false, code: "up-to-date" };
				if (!(await confirmUpdate({ asset, current: managed.version, latest }))) return { ok: false, code: "consent-declined" };
				if (isBusy()) return { ok: false, code: "busy" };
				try {
					const installed = await install({ newerThan: managed.version });
					await writeUpdateState({ binDir, state: { checkedAt: now(), latest: installed.version }, randomHex, fsApi, pathApi });
					return { ok: true, version: installed.version };
				} catch (error) {
					log(`[ccut] link import: update failed (${error instanceof ToolError ? error.code : "error"})`);
					return { ok: false, code: error instanceof ToolError && UPDATE_CODES.includes(error.code) ? error.code : "tool-download-failed" };
				}
			} finally {
				updating = false;
			}
		},
	};
}

module.exports = { DAY_MS, STATE_NAME, UPDATE_CODES, createUpdateService, isTag, readUpdateState, writeUpdateState };
