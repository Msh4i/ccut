import type { McpColor } from "./glow-state";

/**
 * `window.ccutMcp`, set by the desktop app's preload (apps/electron/preload.js). In a browser, or
 * without the bridge, `getMcpBridge()` is null and the Integrations screen is not offered.
 */
export type McpClientView = {
	id: string;
	name: string;
	version: string;
	level: "read" | "edit";
	color: McpColor;
	connectedAt: number;
	calls: number;
};

export type McpState = {
	enabled: boolean;
	running: boolean;
	port: number;
	clients: McpClientView[];
	grants: Record<string, "read" | "edit">;
	colors: Record<string, McpColor>;
};

export type McpSnippets = { url: string; token: string; claudeCode: string; codex: string; claudeCodeHttp: string; json: string };
export type McpLogEntry = { at: number; client: string; tool: string; ok: boolean; ms: number; error?: string };

export type McpActivity = { clientId: string; name?: string; color?: string; running: boolean };

export type McpBridge = {
	state(): Promise<McpState | null>;
	setEnabled(enabled: boolean): Promise<McpState | null>;
	regenerateToken(): Promise<McpState | null>;
	snippets(): Promise<McpSnippets | null>;
	disconnect(id: string): Promise<boolean>;
	setColor(request: { name: string; color: McpColor }): Promise<boolean>;
	forget(name: string): Promise<boolean>;
	log(): Promise<McpLogEntry[]>;
	onStateChanged(listener: (state: McpState) => void): () => void;
	onActivity(listener: (event: McpActivity) => void): () => void;
	onRequest(handler: (request: { id: number; tool: unknown; args: unknown }) => Promise<unknown>): () => void;
};

const METHODS = ["state", "setEnabled", "regenerateToken", "snippets", "disconnect", "setColor", "forget", "log", "onStateChanged", "onActivity", "onRequest"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isColor = (value: unknown): value is McpColor => value === "orange" || value === "blue" || value === "violet";

export function parseMcpState(value: unknown): McpState | null {
	if (!isRecord(value) || typeof value.enabled !== "boolean" || typeof value.running !== "boolean" || typeof value.port !== "number") return null;
	const clients: McpClientView[] = [];
	if (Array.isArray(value.clients)) {
		for (const entry of value.clients) {
			if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
			clients.push({
				id: entry.id,
				name: entry.name,
				version: typeof entry.version === "string" ? entry.version : "",
				level: entry.level === "read" ? "read" : "edit",
				color: isColor(entry.color) ? entry.color : "violet",
				connectedAt: typeof entry.connectedAt === "number" ? entry.connectedAt : 0,
				calls: typeof entry.calls === "number" ? entry.calls : 0,
			});
		}
	}
	const grants: McpState["grants"] = {};
	if (isRecord(value.grants)) for (const [name, level] of Object.entries(value.grants)) if (level === "read" || level === "edit") grants[name] = level;
	const colors: McpState["colors"] = {};
	if (isRecord(value.colors)) for (const [name, color] of Object.entries(value.colors)) if (isColor(color)) colors[name] = color;
	return { enabled: value.enabled, running: value.running, port: value.port, clients, grants, colors };
}

function parseSnippets(value: unknown): McpSnippets | null {
	if (!isRecord(value)) return null;
	const { url, token, claudeCode, codex, claudeCodeHttp, json } = value;
	return typeof url === "string" && typeof token === "string" && typeof claudeCode === "string" && typeof codex === "string" && typeof claudeCodeHttp === "string" && typeof json === "string" ? { url, token, claudeCode, codex, claudeCodeHttp, json } : null;
}

function parseLog(value: unknown): McpLogEntry[] {
	if (!Array.isArray(value)) return [];
	const out: McpLogEntry[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.at !== "number" || typeof entry.client !== "string" || typeof entry.tool !== "string") continue;
		out.push({ at: entry.at, client: entry.client, tool: entry.tool, ok: entry.ok === true, ms: typeof entry.ms === "number" ? entry.ms : 0, ...(typeof entry.error === "string" && { error: entry.error }) });
	}
	return out;
}

function isRawBridge(value: unknown): value is Record<(typeof METHODS)[number], (...args: never[]) => unknown> {
	return isRecord(value) && METHODS.every((name) => typeof value[name] === "function");
}

export function getMcpBridge({ scope = globalThis }: { scope?: object } = {}): McpBridge | null {
	const raw: unknown = Reflect.get(scope, "ccutMcp");
	if (!isRawBridge(raw)) return null;
	const call = async ({ name, args = [] }: { name: "state" | "setEnabled" | "regenerateToken" | "snippets" | "disconnect" | "setColor" | "forget" | "log"; args?: unknown[] }): Promise<unknown> => {
		try {
			return await Reflect.apply(raw[name], raw, args);
		} catch {
			return null;
		}
	};
	return {
		state: async () => parseMcpState(await call({ name: "state" })),
		setEnabled: async (enabled) => parseMcpState(await call({ name: "setEnabled", args: [enabled] })),
		regenerateToken: async () => parseMcpState(await call({ name: "regenerateToken" })),
		snippets: async () => parseSnippets(await call({ name: "snippets" })),
		disconnect: async (id) => (await call({ name: "disconnect", args: [id] })) === true,
		setColor: async ({ name, color }) => (await call({ name: "setColor", args: [name, color] })) === true,
		forget: async (name) => (await call({ name: "forget", args: [name] })) === true,
		log: async () => parseLog(await call({ name: "log" })),
		onStateChanged: (listener) => {
			const stop: unknown = Reflect.apply(raw.onStateChanged, raw, [(payload: unknown) => {
				const state = parseMcpState(payload);
				if (state) listener(state);
			}]);
			return typeof stop === "function" ? () => stop() : () => {};
		},
		onActivity: (listener) => {
			const stop: unknown = Reflect.apply(raw.onActivity, raw, [(payload: unknown) => {
				if (isRecord(payload) && typeof payload.clientId === "string" && typeof payload.running === "boolean") {
					listener({ clientId: payload.clientId, name: typeof payload.name === "string" ? payload.name : undefined, color: typeof payload.color === "string" ? payload.color : undefined, running: payload.running });
				}
			}]);
			return typeof stop === "function" ? () => stop() : () => {};
		},
		onRequest: (handler) => {
			const stop: unknown = Reflect.apply(raw.onRequest, raw, [handler]);
			return typeof stop === "function" ? () => stop() : () => {};
		},
	};
}
