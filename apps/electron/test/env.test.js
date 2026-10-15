const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const { pickEnv } = require("../env");

const WINDOWS_ESSENTIALS = [
	"SystemRoot",
	"windir",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ComSpec",
	"PATHEXT",
];

let saved;
beforeEach(() => {
	saved = { ...process.env };
});
afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

// Windows'ta ad büyük/küçük harf duyarsız: sonucu adın büyük harfli haliyle ara
const valueOf = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

describe("pickEnv", () => {
	test("passes only whitelisted names, never secrets or build-time public vars", () => {
		process.env.PATH = "/usr/bin";
		process.env.HOME = "/home/u";
		process.env.DATABASE_URL = "postgres://secret";
		process.env.NEXT_PUBLIC_LEAK = "1";
		process.env.CCUT_DESKTOP_TOKEN = "token";

		const env = pickEnv();

		expect(valueOf(env, "PATH")).toBe("/usr/bin");
		expect(valueOf(env, "HOME")).toBe("/home/u");
		expect(env).not.toHaveProperty("DATABASE_URL");
		expect(env).not.toHaveProperty("NEXT_PUBLIC_LEAK");
		expect(env).not.toHaveProperty("CCUT_DESKTOP_TOKEN");
	});

	test("includes the variables Node and bun need on Windows", () => {
		for (const name of WINDOWS_ESSENTIALS) process.env[name] = `value-of-${name}`;

		const env = pickEnv();

		for (const name of WINDOWS_ESSENTIALS) expect(valueOf(env, name)).toBe(`value-of-${name}`);
	});

	test("matches names case-insensitively and keeps the parent's spelling", () => {
		process.env.systemroot = "C:\\Windows";

		const env = pickEnv();

		expect(Object.keys(env).filter((name) => name.toUpperCase() === "SYSTEMROOT")).toHaveLength(1);
		expect(valueOf(env, "SystemRoot")).toBe("C:\\Windows");
	});

	test("drops empty values", () => {
		process.env.TMP = "";
		process.env.LANG = "tr_TR.UTF-8";

		const env = pickEnv();

		expect(valueOf(env, "TMP")).toBeUndefined();
		expect(valueOf(env, "LANG")).toBe("tr_TR.UTF-8");
	});

	test("extra names are opt-in per caller", () => {
		process.env.XDG_RUNTIME_DIR = "/run/user/1000";

		expect(valueOf(pickEnv(), "XDG_RUNTIME_DIR")).toBeUndefined();
		expect(valueOf(pickEnv(["XDG_RUNTIME_DIR"]), "XDG_RUNTIME_DIR")).toBe("/run/user/1000");
	});
});
