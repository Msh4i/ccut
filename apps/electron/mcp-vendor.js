// MCP server (round 8): ships the official SDK to the main process. electron-builder packs no
// node_modules ("!**/node_modules/**" in package.json), so bundle.js calls this: esbuild bundles
// mcp-sdk-entry.js (the SDK's server side, zod and their dependencies) into one CommonJS file,
// vendor/mcp-sdk.cjs, which mcp-sdk.js prefers over the packages. Only versions pinned in
// package.json are bundled; the file is not committed (vendor/ is built).
const fs = require("node:fs");
const path = require("node:path");

const VENDOR_FILE = path.join("vendor", "mcp-sdk.cjs");
const PINNED = Object.freeze({ "@modelcontextprotocol/sdk": "1.32.1", zod: "3.25.76" });

/** Builds <targetDir>/vendor/mcp-sdk.cjs; returns { file, bytes, versions }. */
function vendorMcpSdk({ targetDir = __dirname, esbuild = require("esbuild") } = {}) {
	const versions = {};
	for (const [name, wanted] of Object.entries(PINNED)) {
		// "@modelcontextprotocol/sdk" has no root "main" that resolves a package.json: use its server entry.
		const probe = name === "@modelcontextprotocol/sdk" ? "@modelcontextprotocol/sdk/server/mcp.js" : name;
		const found = (() => {
			const entry = require.resolve(probe, { paths: [__dirname] });
			let dir = path.dirname(entry);
			for (let depth = 0; depth < 10; depth++, dir = path.dirname(dir)) {
				const file = path.join(dir, "package.json");
				if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === name) return JSON.parse(fs.readFileSync(file, "utf8")).version;
			}
			throw new Error(`${name}: package.json not found`);
		})();
		if (found !== wanted) throw new Error(`${name} ${found} is installed, the pin is ${wanted}: run bun install`);
		versions[name] = found;
	}
	const file = path.join(targetDir, VENDOR_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	esbuild.buildSync({
		entryPoints: [path.join(__dirname, "mcp-sdk-entry.js")],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
		outfile: file,
		logLevel: "warning",
		legalComments: "none",
		// An optional validator the SDK loads only when asked to; not used here.
		external: ["@cfworker/json-schema"],
	});
	return { file, bytes: fs.statSync(file).size, versions };
}

module.exports = { PINNED, VENDOR_FILE, vendorMcpSdk };
