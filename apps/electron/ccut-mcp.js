#!/usr/bin/env node
// MCP stdio shim (round 8): for clients that want a command to run (Codex, Claude Desktop). It
// forwards the JSON-RPC lines on stdin to the running Ccut app's MCP endpoint (127.0.0.1) and
// prints the answers. It reads the port from <userData>/mcp/endpoint.json and the token from
// <userData>/mcp/token, both written by the app when the integration is on; nothing is configured
// here and nothing else is contacted. Usage: node ccut-mcp.js [--user-data <dir>]
const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

function defaultUserData() {
	if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Ccut");
	if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Ccut");
	return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Ccut");
}

const isAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM"; // exists, owned by someone else
	}
};

/** { port, token } of the running app, or throws a short message. */
function readEndpoint({ userData, alive = isAlive }) {
	const root = path.join(userData, "mcp");
	let port;
	let pid;
	let token;
	try {
		({ port, pid } = JSON.parse(fs.readFileSync(path.join(root, "endpoint.json"), "utf8")));
		token = fs.readFileSync(path.join(root, "token"), "utf8").trim();
	} catch {
		throw new Error("Ccut is not running with the MCP integration turned on (Settings > Integrations).");
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(token)) throw new Error("The Ccut MCP endpoint file is not valid.");
	// A crash or kill leaves this file behind; another program may have taken the port since.
	if (!Number.isInteger(pid) || pid < 1 || !alive(pid)) throw new Error("Ccut is not running (the endpoint file is left over from an earlier run).");
	return { port, token };
}

/** Asks the endpoint to prove it knows the token (HMAC of a fresh nonce) BEFORE the token is sent to it. */
function verifyEndpoint({ port, token }) {
	const nonce = crypto.randomBytes(16).toString("hex");
	return new Promise((resolve) => {
		const request = http.get({ host: "127.0.0.1", port, path: `/mcp/proof?nonce=${nonce}`, timeout: 5000 }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				try {
					const given = Buffer.from(String(JSON.parse(Buffer.concat(chunks).toString("utf8")).proof ?? ""), "utf8");
					const expected = Buffer.from(crypto.createHmac("sha256", token).update(`ccut-mcp-proof:${nonce}`).digest("hex"), "utf8");
					resolve(given.length === expected.length && crypto.timingSafeEqual(given, expected));
				} catch {
					resolve(false);
				}
			});
		});
		request.on("timeout", () => request.destroy());
		request.on("error", () => resolve(false));
	});
}

/** POST one JSON-RPC message; resolves { status, session, body } (body "" for a 202). */
function post({ port, token, session, message }) {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(message);
		const request = http.request(
			{
				host: "127.0.0.1",
				port,
				path: "/mcp",
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${token}`,
					"content-length": Buffer.byteLength(payload),
					...(session ? { "mcp-session-id": session } : {}),
				},
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => resolve({ status: response.statusCode, session: response.headers["mcp-session-id"], body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		request.on("error", reject);
		request.end(payload);
	});
}

/** Runs the relay on the given streams; resolves when stdin ends. */
async function relay({ input, output, userData }) {
	const { port, token } = readEndpoint({ userData });
	let session = null;
	let buffer = "";
	let chain = Promise.resolve();
	const handleLine = async (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		try {
			if (!(await verifyEndpoint({ port, token }))) throw new Error("not the Ccut app");
			const answer = await post({ port, token, session, message });
			if (answer.session) session = answer.session;
			if (answer.body) output.write(`${answer.body.trim()}\n`);
		} catch {
			if (message && message.id !== undefined) output.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Ccut is not reachable." } })}\n`);
		}
	};
	input.setEncoding("utf8");
	input.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line) chain = chain.then(() => handleLine(line));
		}
	});
	await new Promise((resolve) => input.on("end", resolve));
	await chain;
}

if (require.main === module) {
	const flag = process.argv.indexOf("--user-data");
	const userData = flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : defaultUserData();
	relay({ input: process.stdin, output: process.stdout, userData }).catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	});
}

module.exports = { defaultUserData, readEndpoint, relay, verifyEndpoint };
