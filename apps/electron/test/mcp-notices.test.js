const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const { PINNED } = require("../mcp-vendor");

// The bundled SDK ships without licence comments (esbuild legalComments "none", node_modules is not
// packed), so THIRD_PARTY_NOTICES.md has to carry the licence text of everything the bundle contains.

describe("licences of the MCP bundle", () => {
	test("every pinned package has its licence text in THIRD_PARTY_NOTICES.md", () => {
		const notices = fs.readFileSync(path.join(__dirname, "..", "..", "..", "THIRD_PARTY_NOTICES.md"), "utf8");
		for (const [name, version] of Object.entries(PINNED)) {
			const at = notices.indexOf(`#### ${name} ${version}`);
			expect(at).toBeGreaterThan(-1);
			expect(notices.slice(at, at + 3000)).toMatch(/Permission is hereby granted|MIT License|Redistribution|Permission to use/i);
		}
	});
});
