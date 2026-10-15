// MCP server (round 8): who is connected, in which colour, and the log of what they did.
// Pure bookkeeping; the server (mcp-server.js) and the settings (mcp-ipc.js) use it.

const COLORS = Object.freeze({ orange: "#ff8a1f", blue: "#2f7bff", violet: "#8b5cf6" });
const COLOR_NAMES = Object.freeze(Object.keys(COLORS));
const LOG_LIMIT = 200;

/** The colour name of a client by its MCP clientInfo.name: Claude orange, Codex / OpenAI blue, any other violet. */
function colorNameFor(clientName) {
	const name = String(clientName ?? "").trim().toLowerCase();
	if (name.startsWith("claude")) return "orange";
	if (name.startsWith("codex") || name.startsWith("openai")) return "blue";
	return "violet";
}

const isColorName = (value) => typeof value === "string" && COLOR_NAMES.includes(value);

/** A client name made safe to show (and to log): printable, short. */
const cleanName = (value) =>
	String(value ?? "")
		.replace(/[^\p{L}\p{N} ._-]/gu, "")
		.trim()
		.slice(0, 40) || "unknown client";

/**
 * `overrides` is the owner's per-client colour choice, by client name. Returns the registry:
 * connect / disconnect, list, and the call log (the last 200 calls).
 */
function createClientRegistry({ overrides = {}, now = Date.now } = {}) {
	const clients = new Map();
	const log = [];
	const colorOverrides = { ...overrides };

	const colorOf = (name) => (isColorName(colorOverrides[name]) ? colorOverrides[name] : colorNameFor(name));
	const publicView = (client) => ({
		id: client.id,
		name: client.name,
		version: client.version,
		level: client.level,
		color: colorOf(client.name),
		connectedAt: client.connectedAt,
		calls: client.calls,
	});

	return {
		connect({ id, name, version, level }) {
			const client = { id, name: cleanName(name), version: cleanName(version ?? ""), level, connectedAt: now(), calls: 0 };
			clients.set(id, client);
			return publicView(client);
		},
		disconnect(id) {
			return clients.delete(id);
		},
		get(id) {
			const client = clients.get(id);
			return client ? publicView(client) : null;
		},
		list() {
			return [...clients.values()].map(publicView);
		},
		setColor({ name, color }) {
			if (!isColorName(color)) return false;
			colorOverrides[cleanName(name)] = color;
			return true;
		},
		colorOverrides() {
			return { ...colorOverrides };
		},
		recordCall({ id, tool, ok, ms, error }) {
			const client = clients.get(id);
			if (client) client.calls += 1;
			log.push({ at: now(), client: client?.name ?? "disconnected client", tool, ok, ms, ...(error ? { error: String(error).slice(0, 200) } : {}) });
			while (log.length > LOG_LIMIT) log.shift();
		},
		log() {
			return log.map((entry) => ({ ...entry }));
		},
	};
}

module.exports = { COLORS, COLOR_NAMES, LOG_LIMIT, cleanName, colorNameFor, createClientRegistry, isColorName };
