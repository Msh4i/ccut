const { afterEach, describe, expect, test } = require("bun:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { loadSdk } = require("../mcp-sdk");
const { createMcpService } = require("../mcp-server");

// The MCP service with the real SDK on both sides over a real loopback socket, and a fake editor
// bridge: tools, schemas, the access level, a bad token, a bad Host / Origin, the rate limit, the
// owner's refusal, disconnect, the activity events and the log.

const TOKEN = "a1".repeat(32);
let service;
afterEach(async () => {
	await service?.stop();
	service = null;
});

function makeService({ decision = "edit", bridgeImpl, rate, token = TOKEN, now, idleMs } = {}) {
	const calls = [];
	const activity = [];
	const asked = [];
	service = createMcpService({
		sdk: loadSdk(),
		getToken: () => token,
		bridge: {
			call: async ({ tool, args }) => {
				calls.push({ tool, args });
				if (bridgeImpl) return bridgeImpl({ tool, args });
				return { ok: true, tool };
			},
		},
		askPermission: async ({ clientName }) => {
			asked.push(clientName);
			return decision;
		},
		onActivity: (event) => activity.push(event),
		rate,
		...(now && { now }),
		...(idleMs && { idleMs }),
	});
	return { calls, activity, asked };
}

async function connect({ name = "claude-code", token = TOKEN, port }) {
	const client = new Client({ name, version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
	await client.connect(transport);
	return { client, transport };
}

const post = (port, { headers = {}, body = { jsonrpc: "2.0", id: 1, method: "ping" } } = {}) =>
	fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

describe("the MCP service", () => {
	test("lists the tools and answers a read and an edit call; the page's bridge does the work", async () => {
		const { calls, asked } = makeService();
		const port = await service.start();
		const { client } = await connect({ port });
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("get_project");
		expect(names).toContain("split_at");
		expect(names).not.toContain("export_project");
		const project = await client.callTool({ name: "get_project", arguments: {} });
		expect(JSON.parse(project.content[0].text)).toEqual({ ok: true, tool: "get_project" });
		await client.callTool({ name: "split_at", arguments: { seconds: 4.5 } });
		expect(calls.map((call) => call.tool)).toEqual(["get_project", "split_at"]);
		expect(calls[1].args).toEqual({ seconds: 4.5 });
		expect(asked).toEqual(["claude-code"]);
		await client.close();
	});

	test("a read-only client does not see the edit tools, and an edit call is refused", async () => {
		const { calls } = makeService({ decision: "read" });
		const port = await service.start();
		const { client } = await connect({ port });
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain("list_elements");
		expect(names).not.toContain("delete_element");
		const refused = await client.callTool({ name: "delete_element", arguments: { elementId: "a" } }).catch((error) => error);
		expect(refused instanceof Error || refused?.isError).toBe(true);
		expect(calls).toEqual([]);
		await client.close();
	});

	test("input is validated by the tool's schema before the bridge hears of it", async () => {
		const { calls } = makeService();
		const port = await service.start();
		const { client } = await connect({ port });
		for (const [name, args] of [
			["split_at", { seconds: -3 }],
			["split_at", { seconds: "soon" }],
			["apply_keyframe_preset", { elementId: "a", presetId: "explode" }],
			["get_preview_frame", { maxWidth: 99999 }],
		]) {
			const outcome = await client.callTool({ name, arguments: args }).catch((error) => error);
			expect(outcome instanceof Error || outcome?.isError).toBe(true);
		}
		expect(calls).toEqual([]);
		await client.close();
	});

	test("a tool error reaches the agent as short text, never a stack", async () => {
		makeService({
			bridgeImpl: ({ tool }) => {
				if (tool === "delete_element") throw new Error("There is no clip with that id.");
				throw new Error(`secret ${"x".repeat(5000)}`);
			},
		});
		const port = await service.start();
		const { client } = await connect({ port });
		const known = await client.callTool({ name: "delete_element", arguments: { elementId: "nope" } });
		expect(known.isError).toBe(true);
		expect(known.content[0].text).toBe("There is no clip with that id.");
		const unknown = await client.callTool({ name: "play", arguments: {} });
		expect(unknown.isError).toBe(true);
		expect(unknown.content[0].text).toBe("The app could not run this tool.");
		await client.close();
	});

	test("a preview frame comes back as an image", async () => {
		makeService({ bridgeImpl: () => ({ base64: "iVBORw0KGgo=" }) });
		const port = await service.start();
		const { client } = await connect({ port });
		const frame = await client.callTool({ name: "get_preview_frame", arguments: {} });
		expect(frame.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
		await client.close();
	});

	test("a preview frame over the size cap is refused with a short message, not sent", async () => {
		makeService({ bridgeImpl: () => ({ base64: "A".repeat(6_000_001) }) });
		const port = await service.start();
		const { client } = await connect({ port });
		const frame = await client.callTool({ name: "get_preview_frame", arguments: {} });
		expect(frame.isError).toBe(true);
		expect(frame.content[0].text).toContain("too large");
		await client.close();
	});

	test("rejects a missing or wrong token, a foreign Host and a foreign Origin before anything runs", async () => {
		const { asked } = makeService();
		const port = await service.start();
		const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
		expect((await post(port, { body: init })).status).toBe(401);
		expect((await post(port, { body: init, headers: { authorization: `Bearer ${"w".repeat(64)}` } })).status).toBe(401);
		expect((await post(port, { body: init, headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" } })).status).toBe(403);
		expect((await post(port, { body: init, headers: { authorization: `Bearer ${TOKEN}`, origin: "null" } })).status).toBe(403);
		// A forged Host cannot be sent through fetch; talk to the socket directly.
		const net = require("node:net");
		const status = await new Promise((resolve) => {
			const socket = net.connect(port, "127.0.0.1", () => {
				const payload = JSON.stringify(init);
				socket.write(`POST /mcp HTTP/1.1\r\nHost: attacker.example:${port}\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`);
			});
			let data = "";
			socket.on("data", (chunk) => (data += chunk));
			socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1])));
		});
		expect(status).toBe(403);
		expect(asked).toEqual([]);
	});

	test("nothing but /mcp is served, and a GET without a session is refused", async () => {
		makeService();
		const port = await service.start();
		expect((await fetch(`http://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
	});

	test("the rate limit answers 429 once a connection asks too often", async () => {
		makeService({ rate: { limit: 3, windowMs: 60_000 } });
		const port = await service.start();
		const statuses = [];
		for (let i = 0; i < 6; i++) statuses.push((await post(port, { headers: { authorization: `Bearer ${TOKEN}` } })).status);
		expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
		expect(statuses.slice(3)).toEqual([429, 429, 429]);
	});

	test("the owner's refusal stops the connection and no session exists", async () => {
		makeService({ decision: "deny" });
		const port = await service.start();
		await expect(connect({ port })).rejects.toBeDefined();
		expect(service.clients()).toEqual([]);
	});

	test("lists the connected client with its colour, disconnects it, and keeps the log", async () => {
		const { activity } = makeService();
		const port = await service.start();
		const claude = await connect({ port, name: "claude-code" });
		const codex = await connect({ port, name: "codex-cli" });
		const other = await connect({ port, name: "my-script" });
		expect(service.clients().map((client) => [client.name, client.color, client.level])).toEqual([
			["claude-code", "orange", "edit"],
			["codex-cli", "blue", "edit"],
			["my-script", "violet", "edit"],
		]);
		await claude.client.callTool({ name: "get_playhead", arguments: {} });
		expect(service.log()).toHaveLength(1);
		expect(service.log()[0]).toMatchObject({ client: "claude-code", tool: "get_playhead", ok: true });
		expect(activity.map((event) => [event.name, event.running])).toEqual([["claude-code", true], ["claude-code", false]]);
		const target = service.clients()[1];
		expect(await service.disconnect(target.id)).toBe(true);
		expect(service.clients().map((client) => client.name)).toEqual(["claude-code", "my-script"]);
		await expect(codex.client.callTool({ name: "get_playhead", arguments: {} })).rejects.toBeDefined();
		await claude.client.close();
		await other.client.close();
	});

	test("the log keeps only the last 200 calls", async () => {
		makeService({ rate: { limit: 100_000, windowMs: 1000 } });
		const port = await service.start();
		const { client } = await connect({ port });
		const burst = Array.from({ length: 210 }, () => client.callTool({ name: "get_playhead", arguments: {} }));
		await Promise.all(burst);
		expect(service.log()).toHaveLength(200);
		await client.close();
	});

	test("it listens on 127.0.0.1 only, and stops cleanly", async () => {
		makeService();
		const port = await service.start();
		expect(service.isRunning()).toBe(true);
		await service.stop();
		expect(service.isRunning()).toBe(false);
		await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toBeDefined();
	});
});

describe("the bundled SDK and the stdio shim", () => {
	test("vendor/mcp-sdk.cjs, built by esbuild, runs the same service", async () => {
		const os = require("node:os");
		const path = require("node:path");
		const fsp = require("node:fs/promises");
		const { vendorMcpSdk } = require("../mcp-vendor");
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-mcp-vendor-"));
		try {
			const built = vendorMcpSdk({ targetDir: dir });
			expect(built.versions).toEqual({ "@modelcontextprotocol/sdk": "1.32.1", zod: "3.25.76" });
			const bundled = require(built.file);
			service = createMcpService({ sdk: bundled, getToken: () => TOKEN, bridge: { call: async () => ({ via: "bundle" }) }, askPermission: async () => "edit" });
			const port = await service.start();
			const { client } = await connect({ port });
			const answer = await client.callTool({ name: "get_project", arguments: {} });
			expect(JSON.parse(answer.content[0].text)).toEqual({ via: "bundle" });
			await client.close();
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test("the shim relays JSON-RPC lines from stdin to the endpoint and prints the answers", async () => {
		const os = require("node:os");
		const path = require("node:path");
		const fsp = require("node:fs/promises");
		const { PassThrough } = require("node:stream");
		const { relay } = require("../ccut-mcp");
		makeService();
		const port = await service.start();
		const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-mcp-shim-"));
		try {
			await fsp.mkdir(path.join(userData, "mcp"));
			await fsp.writeFile(path.join(userData, "mcp", "endpoint.json"), JSON.stringify({ port, pid: process.pid }));
			await fsp.writeFile(path.join(userData, "mcp", "token"), TOKEN);
			const input = new PassThrough();
			const output = new PassThrough();
			const lines = [];
			output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
			const done = relay({ input, output, userData });
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "1" } } })}\n`);
			input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
			input.end();
			await done;
			const answers = lines.map((line) => JSON.parse(line));
			expect(answers.find((a) => a.id === 1).result.serverInfo.name).toBe("ccut");
			expect(answers.find((a) => a.id === 2).result.tools.map((t) => t.name)).toContain("get_project");
			expect(service.clients().map((c) => c.name)).toEqual(["codex"]);
		} finally {
			await fsp.rm(userData, { recursive: true, force: true });
		}
	});

	test("the shim does not send the token to a stale port: a dead pid is refused, and a stranger that cannot prove it knows the token never sees it", async () => {
		const os = require("node:os");
		const path = require("node:path");
		const fsp = require("node:fs/promises");
		const http = require("node:http");
		const { PassThrough } = require("node:stream");
		const { readEndpoint, relay } = require("../ccut-mcp");
		const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-mcp-shim-"));
		const seen = [];
		const stranger = http.createServer((req, res) => {
			seen.push(req.headers.authorization ?? null);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ proof: "00".repeat(32) }));
		});
		await new Promise((resolve) => stranger.listen(0, "127.0.0.1", resolve));
		try {
			const port = stranger.address().port;
			await fsp.mkdir(path.join(userData, "mcp"));
			await fsp.writeFile(path.join(userData, "mcp", "token"), TOKEN);
			// a file a crash left behind: the pid is gone
			await fsp.writeFile(path.join(userData, "mcp", "endpoint.json"), JSON.stringify({ port, pid: 99999999 }));
			expect(() => readEndpoint({ userData })).toThrow("left over");
			// an old file without a pid is refused too
			await fsp.writeFile(path.join(userData, "mcp", "endpoint.json"), JSON.stringify({ port }));
			expect(() => readEndpoint({ userData })).toThrow("left over");
			// the pid is alive, but whoever listens cannot prove it knows the token
			await fsp.writeFile(path.join(userData, "mcp", "endpoint.json"), JSON.stringify({ port, pid: process.pid }));
			const input = new PassThrough();
			const output = new PassThrough();
			const lines = [];
			output.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
			const done = relay({ input, output, userData });
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex", version: "1" } } })}\n`);
			input.end();
			await done;
			expect(JSON.parse(lines[0]).error.message).toBe("Ccut is not reachable.");
			expect(seen.every((authorization) => authorization === null)).toBe(true);
			expect(seen.length).toBeGreaterThan(0);
		} finally {
			stranger.close();
			await fsp.rm(userData, { recursive: true, force: true });
		}
	});

	test("a session nobody uses for the idle time is closed; a busy owner is a 429, not a 'no'; the proof is not rate limited", async () => {
		let clock = 1_000_000;
		makeService({ now: () => clock, idleMs: 60_000 });
		const port = await service.start();
		const { client } = await connect({ port });
		expect(service.clients()).toHaveLength(1);
		clock += 30_000;
		await client.listTools();
		clock += 50_000; // 50 s since the last use: still fine
		await service.sweepIdle();
		expect(service.clients()).toHaveLength(1);
		clock += 20_000; // 70 s idle
		await service.sweepIdle();
		expect(service.clients()).toHaveLength(0);
		await service.stop();

		makeService({ decision: "busy" });
		const busyPort = await service.start();
		const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
		const busy = await post(busyPort, { body: init, headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" } });
		expect(busy.status).toBe(429);
		for (let index = 0; index < 400; index++) {
			expect((await fetch(`http://127.0.0.1:${busyPort}/mcp/proof?nonce=${"a".repeat(32)}`)).status).toBe(200);
		}
	});
});
