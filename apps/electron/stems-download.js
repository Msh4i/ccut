// Stems (round 5): one hardened download for the engine installer. No Electron import; fetch and
// the file system are injected. Same rules as link-import-tool.js (which does not export its
// helpers, so the few lines are repeated here): https only, no credentials or port, a host
// allow-list checked on EVERY redirect hop (redirects are followed by hand, a few hops), the body
// streamed to a 0600 temporary file while it is hashed, a size cap, and the file is kept only if
// its SHA-256 and size equal the pinned values. On any failure the temporary file is deleted.
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_LIMITS = Object.freeze({ maxRedirects: 5, timeoutMs: 60 * 60 * 1000 });

// code: "download-failed" (network, host, status) | "verify-failed" (size or hash differs) | "cancelled".
class DownloadError extends Error {
	constructor(code) {
		super(`stems download: ${code}`);
		this.name = "DownloadError";
		this.code = code;
	}
}
const fail = (code) => {
	throw new DownloadError(code);
};

function checkUrl({ href, hosts }) {
	let url;
	try {
		url = new URL(href);
	} catch {
		return fail("download-failed");
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !hosts.includes(url.hostname)) fail("download-failed");
	return url;
}

const discardBody = (response) => {
	try {
		response.body?.cancel?.();
	} catch {}
};

/** GET with redirect "manual": every hop is checked before it is requested. A 200 response. */
async function fetchFollowing({ fetch, url, hosts, signal, maxRedirects }) {
	let current = url;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		checkUrl({ href: current, hosts });
		const response = await fetch(current, { redirect: "manual", signal });
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			discardBody(response);
			if (!location) fail("download-failed");
			current = new URL(location, current).href;
			continue;
		}
		if (response.status !== 200) {
			discardBody(response);
			fail("download-failed");
		}
		return response;
	}
	return fail("download-failed");
}

/**
 * Downloads `url` to `destPath` (created 0600, never overwritten). Resolves { size, sha256 };
 * throws DownloadError. `onProgress(bytes)` hears the running total.
 */
async function downloadVerified({ fetch, fsApi = fsp, url, hosts, destPath, expectedSha256, expectedSize, signal: outerSignal, onProgress = () => {}, limits: overrides = {} }) {
	const limits = { ...DEFAULT_LIMITS, ...overrides };
	// A plain controller and timer (not AbortSignal.any/timeout); both are undone at the end.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("download time limit")), limits.timeoutMs);
	const forward = () => controller.abort(outerSignal.reason);
	if (outerSignal?.aborted) controller.abort(outerSignal.reason);
	else outerSignal?.addEventListener("abort", forward, { once: true });
	const hash = crypto.createHash("sha256");
	let handle = null;
	let kept = false;
	try {
		const response = await fetchFollowing({ fetch, url, hosts, signal: controller.signal, maxRedirects: limits.maxRedirects });
		const header = response.headers.get("content-length");
		if (header !== null && /^\d+$/.test(header) && Number(header) !== expectedSize) {
			discardBody(response);
			fail("verify-failed");
		}
		handle = await fsApi.open(destPath, "wx", 0o600);
		let total = 0;
		for await (const chunk of response.body) {
			total += chunk.byteLength;
			if (total > expectedSize) fail("verify-failed"); // leaving the loop cancels the stream
			hash.update(chunk);
			await handle.write(chunk);
			onProgress(total);
		}
		if (total !== expectedSize) fail("verify-failed");
		const sha256 = hash.digest("hex");
		if (sha256 !== expectedSha256) fail("verify-failed");
		await handle.sync();
		await handle.close();
		handle = null;
		kept = true;
		return { size: total, sha256 };
	} catch (error) {
		if (error instanceof DownloadError) throw error;
		throw new DownloadError(controller.signal.aborted && outerSignal?.aborted ? "cancelled" : "download-failed");
	} finally {
		clearTimeout(timer);
		outerSignal?.removeEventListener("abort", forward);
		if (handle) await handle.close().catch(() => {});
		if (!kept) await fsApi.unlink(destPath).catch(() => {});
	}
}

module.exports = { DownloadError, checkUrl, downloadVerified };
