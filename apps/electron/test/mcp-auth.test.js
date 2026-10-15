const { describe, expect, test } = require("bun:test");
const { createRateLimiter, createToken, isAllowedOrigin, isLoopbackHost, parseBearer, tokenEquals } = require("../mcp-auth");
const { colorNameFor, createClientRegistry } = require("../mcp-clients");

describe("MCP request checks", () => {
	test("the Host header must be this machine and this port", () => {
		for (const host of ["127.0.0.1:4000", "localhost:4000", "[::1]:4000"]) expect(isLoopbackHost(host, 4000)).toBe(true);
		for (const host of ["127.0.0.1:4001", "evil.example:4000", "127.0.0.1", "127.0.0.1:4000.evil.example", "user@127.0.0.1:4000", "127.0.0.1:4000/x", undefined]) {
			expect(isLoopbackHost(host, 4000)).toBe(false);
		}
	});

	test("no Origin is fine, a loopback page is fine, anything else is not", () => {
		expect(isAllowedOrigin(undefined)).toBe(true);
		expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
		expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
		for (const origin of ["null", "https://evil.example", "http://localhost.evil.example", "file://", "garbage", ""]) expect(isAllowedOrigin(origin)).toBe(false);
	});

	test("tokens: a created one is long and unique; only the exact one matches", () => {
		const a = createToken();
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(createToken()).not.toBe(a);
		expect(tokenEquals(a, a)).toBe(true);
		expect(tokenEquals(`${a}x`, a)).toBe(false);
		expect(tokenEquals("", "")).toBe(false);
		expect(tokenEquals(undefined, a)).toBe(false);
	});

	test("Bearer parsing takes one clean token", () => {
		expect(parseBearer(`Bearer ${"a".repeat(32)}`)).toBe("a".repeat(32));
		for (const header of [undefined, "", "Bearer", "Bearer short", `bearer ${"a".repeat(32)}`, `Bearer ${"a".repeat(32)} extra`, `Basic ${"a".repeat(32)}`]) expect(parseBearer(header)).toBeNull();
	});

	test("the rate limiter counts per key within a window and lets the next window start fresh", () => {
		let now = 0;
		const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
		expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a"), limiter.allow("b")]).toEqual([true, true, false, true]);
		now = 1000;
		expect(limiter.allow("a")).toBe(true);
	});
});

describe("MCP client colours", () => {
	test("Claude is orange, Codex and OpenAI blue, anything else violet", () => {
		expect(["claude-code", "Claude Desktop", "claude-ai"].map(colorNameFor)).toEqual(["orange", "orange", "orange"]);
		expect(["codex", "codex-cli", "openai-mcp", "OpenAI"].map(colorNameFor)).toEqual(["blue", "blue", "blue", "blue"]);
		expect(["cursor", "", undefined, "my claude"].map(colorNameFor)).toEqual(["violet", "violet", "violet", "violet"]);
	});

	test("the owner's choice wins over the default, and an unknown colour is refused", () => {
		const registry = createClientRegistry();
		registry.connect({ id: "1", name: "claude-code", level: "read" });
		expect(registry.list()[0].color).toBe("orange");
		expect(registry.setColor({ name: "claude-code", color: "blue" })).toBe(true);
		expect(registry.list()[0].color).toBe("blue");
		expect(registry.setColor({ name: "claude-code", color: "red" })).toBe(false);
		expect(registry.colorOverrides()).toEqual({ "claude-code": "blue" });
	});

	test("a client name is cleaned before it is shown or logged", () => {
		const registry = createClientRegistry();
		registry.connect({ id: "1", name: "<script>alert(1)</script>\n‮ evil", level: "read" });
		expect(registry.list()[0].name).toBe("scriptalert1script evil");
	});
});
