// MCP server (round 8): the Model Context Protocol endpoint of the running app, so an agent
// (Claude Code, Codex ...) can connect and work in the open project. Streamable HTTP on 127.0.0.1
// only, on a random port, OFF until the owner starts it. No Electron import: the SDK, the bridge
// into the page (`bridge.call`) and the consent question (`askPermission`) are injected.
//
// A request passes, in this order: the Host header names this machine and port (DNS rebinding),
// the Origin is absent or a loopback page, the bearer token matches (constant time), the
// per-connection rate limit. A new session then asks the owner (read only / read and edit / deny);
// every tool call is checked against that level again, logged (the last 200) and announced
// (`onActivity`) so the window can glow. Errors reach the agent as short text, never a stack.
const http = require("node:http");
const crypto = require("node:crypto");
const { NONCE_PATTERN, createRateLimiter, isAllowedOrigin, isLoopbackHost, parseBearer, proofFor, tokenEquals } = require("./mcp-auth");
const { cleanName, createClientRegistry } = require("./mcp-clients");
const { buildTools } = require("./mcp-tools");

const ENDPOINT_PATH = "/mcp";
const PROOF_PATH = "/mcp/proof";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 8;
// A session nobody has used for this long is closed, so idle clients cannot fill the pool of 8.
const IDLE_SESSION_MS = 30 * 60_000;
const MAX_RESULT_CHARS = 200_000;
// A preview frame as base64: about 6 MB of text is a ~4.5 MB picture; more is cut off rather than sent to the agent.
const MAX_IMAGE_BASE64_CHARS = 6_000_000;
const DEFAULT_RATE = Object.freeze({ limit: 120, windowMs: 10_000 });

const sendJson = (res, status, body) => {
	if (res.headersSent) return;
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
	res.end(text);
};
const jsonRpcError = (res, status, message) => sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("body is not JSON"), { status: 400 });
	}
}

/** null when `req`/`body` look like a valid MCP initialize request, else { status, message }. */
function checkInitializeRequest({ req, body }) {
	const type = String(req.headers["content-type"] ?? "").toLowerCase();
	if (!type.startsWith("application/json")) return { status: 415, message: "Content-Type must be application/json." };
	const accept = String(req.headers.accept ?? "").toLowerCase();
	if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return { status: 406, message: "Accept must list application/json and text/event-stream." };
	const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
	if (!isObject(body) || body.jsonrpc !== "2.0" || (typeof body.id !== "string" && typeof body.id !== "number") || body.method !== "initialize") return { status: 400, message: "Not an initialize request." };
	const params = body.params;
	if (!isObject(params) || typeof params.protocolVersion !== "string" || !isObject(params.clientInfo) || typeof params.clientInfo.name !== "string") return { status: 400, message: "initialize needs protocolVersion and clientInfo.name." };
	return null;
}

/**
 * `sdk` is { McpServer, StreamableHTTPServerTransport, z }; `bridge.call({ tool, args })` runs a tool in the
 * page; `getToken()` the current bearer token; `askPermission({ clientName })` resolves "read" | "edit" | "deny".
 */
function createMcpService({ sdk, bridge, getToken, askPermission, onChange = () => {}, onActivity = () => {}, now = Date.now, rate = DEFAULT_RATE, colorOverrides = {}, version = "0.1.0", idleMs = IDLE_SESSION_MS }) {
	const { McpServer, StreamableHTTPServerTransport, z } = sdk;
	const registry = createClientRegistry({ overrides: colorOverrides, now });
	const limiter = createRateLimiter({ ...rate, now });
	const sessions = new Map();
	const toolDefs = buildTools(z);
	let server = null;
	let port = 0;
	let idleTimer = null;

	async function sweepIdle() {
		for (const [sessionId, session] of [...sessions]) {
			if (now() - session.lastSeen <= idleMs) continue;
			await session.transport.close().catch(() => {});
			drop(sessionId);
		}
	}

	function registerTools({ mcp, holder, level }) {
		for (const def of toolDefs) {
			if (def.access === "edit" && level !== "edit") continue;
			mcp.registerTool(def.name, { description: def.description, inputSchema: def.input }, async (args) => {
				// Re-checked at the call: the level is the owner's, whatever the tool list showed.
				const sessionId = holder.id;
				const client = registry.get(sessionId);
				if (def.access === "edit" && client?.level !== "edit") {
					return { isError: true, content: [{ type: "text", text: "This client has read-only access. The owner can allow edits in Settings > Integrations." }] };
				}
				const started = now();
				onActivity({ clientId: sessionId, name: client?.name, color: client?.color, running: true });
				try {
					const result = await bridge.call({ tool: def.name, args });
					registry.recordCall({ id: sessionId, tool: def.name, ok: true, ms: now() - started });
					if (def.result === "image") {
						if (typeof result?.base64 !== "string") throw new Error("No frame could be captured.");
						if (result.base64.length > MAX_IMAGE_BASE64_CHARS) throw new Error("The frame is too large to send. Ask for a smaller width.");
						return { content: [{ type: "image", data: result.base64, mimeType: "image/png" }] };
					}
					const text = JSON.stringify(result ?? { ok: true });
					return { content: [{ type: "text", text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)} ... (cut)` : text }] };
				} catch (error) {
					const message = typeof error?.message === "string" && error.message.length <= 300 ? error.message : "The app could not run this tool.";
					registry.recordCall({ id: sessionId, tool: def.name, ok: false, ms: now() - started, error: message });
					return { isError: true, content: [{ type: "text", text: message }] };
				} finally {
					onActivity({ clientId: sessionId, name: client?.name, color: client?.color, running: false });
					onChange();
				}
			});
		}
	}

	async function openSession({ req, res, body }) {
		if (sessions.size >= MAX_SESSIONS) return jsonRpcError(res, 429, "Too many connected clients.");
		// The shape is checked BEFORE the owner is asked: a request the SDK would refuse anyway never opens a dialog.
		const problem = checkInitializeRequest({ req, body });
		if (problem) return jsonRpcError(res, problem.status, problem.message);
		const clientName = cleanName(body.params.clientInfo.name);
		const decision = await askPermission({ clientName });
		if (decision === "busy") return jsonRpcError(res, 429, "The owner is being asked about another program right now. Try again in a few seconds.");
		if (decision !== "read" && decision !== "edit") return jsonRpcError(res, 403, "The owner did not allow this client.");

		const mcp = new McpServer({ name: "ccut", version }, { instructions: "Ccut video editor. Times are in seconds. Edits are undoable by the owner with Ctrl+Z, one step each." });
		// The tools must exist before the transport connects; the session id comes with initialize.
		const holder = { id: null };
		registerTools({ mcp, holder, level: decision });
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			enableJsonResponse: true,
			onsessioninitialized: (sessionId) => {
				holder.id = sessionId;
				sessions.set(sessionId, { transport, mcp, lastSeen: now() });
				registry.connect({ id: sessionId, name: clientName, version: body.params.clientInfo.version, level: decision });
				onChange();
			},
			onsessionclosed: (sessionId) => drop(sessionId),
		});
		transport.onclose = () => {
			if (transport.sessionId) drop(transport.sessionId);
		};
		await mcp.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	function drop(sessionId) {
		if (!sessions.has(sessionId)) return;
		sessions.delete(sessionId);
		registry.disconnect(sessionId);
		limiter.forget(sessionId);
		onChange();
	}

	async function handle(req, res) {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== ENDPOINT_PATH && url.pathname !== PROOF_PATH) return sendJson(res, 404, { error: "not found" });
			if (!isLoopbackHost(req.headers.host, port)) return sendJson(res, 403, { error: "forbidden host" });
			if (!isAllowedOrigin(req.headers.origin)) return sendJson(res, 403, { error: "forbidden origin" });
			if (url.pathname === PROOF_PATH) {
				// No token needed to ask, and none given away: only HMAC(token, nonce) comes back. The stdio shim
				// checks it before it sends the token, so a stranger on a stale port never receives the token.
				const nonce = url.searchParams.get("nonce") ?? "";
				if (req.method !== "GET" || !NONCE_PATTERN.test(nonce)) return sendJson(res, 400, { error: "bad nonce" });
				return sendJson(res, 200, { proof: proofFor({ token: getToken(), nonce }) });
			}
			if (!tokenEquals(parseBearer(req.headers.authorization) ?? "", getToken())) {
				res.setHeader("www-authenticate", "Bearer");
				return sendJson(res, 401, { error: "unauthorized" });
			}
			const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
			if (!limiter.allow(sessionId ?? `ip:${req.socket.remoteAddress}`)) return sendJson(res, 429, { error: "too many requests" });

			if (req.method === "POST") {
				const body = await readJsonBody(req);
				if (sessionId) {
					const session = sessions.get(sessionId);
					if (!session) return jsonRpcError(res, 404, "Unknown session.");
					session.lastSeen = now();
					return await session.transport.handleRequest(req, res, body);
				}
				if (body?.method !== "initialize") return jsonRpcError(res, 400, "Start with initialize.");
				return await openSession({ req, res, body });
			}
			if (req.method === "GET" || req.method === "DELETE") {
				const session = sessionId ? sessions.get(sessionId) : null;
				if (!session) return jsonRpcError(res, 404, "Unknown session.");
				session.lastSeen = now();
				return await session.transport.handleRequest(req, res);
			}
			res.setHeader("allow", "POST, GET, DELETE");
			return sendJson(res, 405, { error: "method not allowed" });
		} catch (error) {
			const status = Number.isInteger(error?.status) ? error.status : 500;
			jsonRpcError(res, status, status === 500 ? "Internal error." : error.message);
		}
	}

	return {
		/** Starts listening on 127.0.0.1 (port 0: a random free one); resolves the port. */
		async start({ preferredPort = 0 } = {}) {
			if (server) return port;
			server = http.createServer((req, res) => void handle(req, res));
			server.requestTimeout = 60_000;
			server.headersTimeout = 15_000;
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen({ host: "127.0.0.1", port: preferredPort }, resolve);
			});
			port = server.address().port;
			idleTimer = setInterval(() => void sweepIdle(), 60_000);
			idleTimer.unref?.();
			return port;
		},
		async stop() {
			clearInterval(idleTimer);
			for (const [sessionId, session] of [...sessions]) {
				await session.transport.close().catch(() => {});
				drop(sessionId);
			}
			const closing = server;
			server = null;
			port = 0;
			if (closing) {
				closing.closeAllConnections?.();
				await new Promise((resolve) => closing.close(resolve));
			}
		},
		/** Closes sessions idle for longer than `idleMs` (also runs every minute). */
		sweepIdle,
		isRunning: () => server !== null,
		getPort: () => port,
		/** Closes one client's session ("Disconnect"). */
		async disconnect(id) {
			const session = sessions.get(id);
			if (!session) return false;
			await session.transport.close().catch(() => {});
			drop(id);
			return true;
		},
		/** Closes every live session of the clients with this (cleaned) name ("Forget"). */
		async disconnectByName(name) {
			const ids = registry.list().filter((client) => client.name === name).map((client) => client.id);
			for (const id of ids) await this.disconnect(id);
			return ids.length;
		},
		clients: () => registry.list(),
		log: () => registry.log(),
		setColor: (change) => registry.setColor(change),
		colorOverrides: () => registry.colorOverrides(),
	};
}

module.exports = { ENDPOINT_PATH, MAX_SESSIONS, checkInitializeRequest, createMcpService };
