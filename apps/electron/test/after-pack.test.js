const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { removeEnvFiles } = require("../after-pack");

describe("removeEnvFiles", () => {
	test("deletes .env files at any depth and nothing else", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-afterpack-"));
		try {
			fs.mkdirSync(path.join(dir, "apps/web/.next"), { recursive: true });
			for (const name of [".env", "apps/web/.env", "apps/web/.env.production", "apps/web/.next/.env.local", "apps/web/server.js", "apps/web/environment.js"]) {
				fs.writeFileSync(path.join(dir, name), "SECRET=1");
			}
			const removed = removeEnvFiles({ dir }).map((file) => path.relative(dir, file)).sort();
			expect(removed).toEqual([".env", "apps/web/.env", "apps/web/.env.production", "apps/web/.next/.env.local"]);
			expect(fs.existsSync(path.join(dir, "apps/web/server.js"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "apps/web/environment.js"))).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
