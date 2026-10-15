const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseDevToolsActivePort, remoteDebuggingArgs, waitForDevToolsPort } = require("./cdp");

// cdp.js option used by perf-two-clips.js only: --remote-debugging-port=0 and the port Chromium
// writes into <user-data-dir>/DevToolsActivePort (no free-port probe that another process could
// take between the probe and the launch). The other e2e scripts keep the fixed free port.

describe("parseDevToolsActivePort", () => {
	test("the first line is the port", () => {
		expect(parseDevToolsActivePort("41231\n/devtools/browser/0b1c-...\n")).toBe(41231);
		expect(parseDevToolsActivePort("9222")).toBe(9222);
	});

	test("anything else is null", () => {
		for (const bad of [null, undefined, "", "\n", "0\n", "65536\n", "-1\n", "12a\n", " 9222x", "123456\n", 9222]) expect(parseDevToolsActivePort(bad)).toBeNull();
	});
});

describe("remoteDebuggingArgs", () => {
	test("default: the fixed port; option: port 0", () => {
		expect(remoteDebuggingArgs({ port: 9333, userDataDir: "/tmp/u", portFromUserDataDir: false })).toEqual(["--remote-debugging-port=9333", "--user-data-dir=/tmp/u"]);
		expect(remoteDebuggingArgs({ port: 9333, userDataDir: "/tmp/u", portFromUserDataDir: true })).toEqual(["--remote-debugging-port=0", "--user-data-dir=/tmp/u"]);
	});
});

describe("waitForDevToolsPort", () => {
	let dir;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-Ph-port-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const app = ({ exited = null } = {}) => ({ exitInfo: () => exited, output: () => "electron output" });

	test("waits until Chromium has written the file", async () => {
		const file = path.join(dir, "DevToolsActivePort");
		setTimeout(() => fs.writeFileSync(file, "40001\n/devtools/browser/x\n"), 30);
		expect(await waitForDevToolsPort({ file, app: app(), timeoutMs: 2000, intervalMs: 10 })).toBe(40001);
	});

	test("Electron exits first: rejects with its output; nothing in time: rejects", async () => {
		const file = path.join(dir, "DevToolsActivePort");
		let message = "resolved";
		await waitForDevToolsPort({ file, app: app({ exited: { code: 1 } }), timeoutMs: 2000, intervalMs: 10 }).catch((error) => (message = error.message));
		expect(message).toContain("exited");
		message = "resolved";
		fs.writeFileSync(file, "garbage\n");
		await waitForDevToolsPort({ file, app: app(), timeoutMs: 50, intervalMs: 10 }).catch((error) => (message = error.message));
		expect(message).toContain("DevToolsActivePort");
	});
});
