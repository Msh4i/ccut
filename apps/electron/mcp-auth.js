// MCP server (round 8): the small, pure security checks. No Electron import, nothing global.
// The server only ever listens on 127.0.0.1; these decide whether a request that reached it is
// allowed: the Host header (DNS rebinding), the Origin (a web page in a browser), the bearer token
// (compared in constant time) and a per-connection rate limit.
const crypto = require("node:crypto");

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{16,256}$/;

const createToken = () => crypto.randomBytes(32).toString("hex");

/** What only the app (which knows the token) can answer to a nonce: the shim checks it before it sends the token. */
const proofFor = ({ token, nonce }) => crypto.createHmac("sha256", String(token)).update(`ccut-mcp-proof:${nonce}`).digest("hex");
const NONCE_PATTERN = /^[0-9a-f]{16,64}$/;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

/** Constant-time: both sides are hashed first, so the length of the secret does not show either. */
function tokenEquals(given, expected) {
	if (typeof given !== "string" || typeof expected !== "string" || expected === "") return false;
	return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

/** The token of an "Authorization: Bearer <token>" header, or null. */
function parseBearer(header) {
	if (typeof header !== "string") return null;
	const match = /^Bearer (\S+)$/.exec(header);
	return match && TOKEN_PATTERN.test(match[1]) ? match[1] : null;
}

/** The Host header must name this machine and the port the server listens on: nothing else (DNS rebinding). */
function isLoopbackHost(hostHeader, port) {
	if (typeof hostHeader !== "string") return false;
	let url;
	try {
		url = new URL(`http://${hostHeader}`);
	} catch {
		return false;
	}
	if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
	return LOOPBACK_HOSTNAMES.has(url.hostname) && url.port === String(port);
}

/** No Origin (a program, not a browser) is fine; a browser's Origin must itself be a loopback page. */
function isAllowedOrigin(originHeader) {
	if (originHeader === undefined) return true;
	if (typeof originHeader !== "string") return false;
	let url;
	try {
		url = new URL(originHeader);
	} catch {
		return false;
	}
	return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Fixed window per key: at most `limit` requests in `windowMs`. Old keys are forgotten. */
function createRateLimiter({ limit, windowMs, now = Date.now }) {
	const windows = new Map();
	return {
		allow(key) {
			const at = now();
			const current = windows.get(key);
			if (!current || at - current.start >= windowMs) {
				windows.set(key, { start: at, count: 1 });
				if (windows.size > 256) {
					for (const [other, entry] of windows) if (at - entry.start >= windowMs) windows.delete(other);
				}
				return true;
			}
			current.count += 1;
			return current.count <= limit;
		},
		forget(key) {
			windows.delete(key);
		},
	};
}

module.exports = {
	NONCE_PATTERN,
	proofFor, createRateLimiter, createToken, isAllowedOrigin, isLoopbackHost, parseBearer, tokenEquals };
