// Web uygulamasını standalone olarak derler, Electron'un çalıştıracağı hale getirir.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pickEnv } = require("./env");
const { vendorMediabunny } = require("./link-import-vendor");
const { vendorMcpSdk } = require("./mcp-vendor");

const web = path.join(__dirname, "../web");
const out = path.join(web, ".next/standalone/apps/web");

// The main process's link-import mux worker needs mediabunny: its CJS bundle, exactly the version apps/web pins.
const vendored = vendorMediabunny({ webDir: web, targetDir: __dirname });
console.log(`[bundle] mediabunny ${vendored.version} -> ${path.relative(__dirname, vendored.file)}`);

// The MCP server (mcp-server.js) needs the official SDK and zod: one bundled CJS file, exactly the pinned versions.
const mcp = vendorMcpSdk({ targetDir: __dirname });
console.log(`[bundle] MCP SDK ${mcp.versions["@modelcontextprotocol/sdk"]} -> ${path.relative(__dirname, mcp.file)} (${mcp.bytes} bytes)`);

// Kabuğun ortamından yalnızca gerekenler: ileride tanımlanacak bir NEXT_PUBLIC_* paketin içine gömülmesin
const base = pickEnv(["BUN_INSTALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]);

const options = {
	cwd: web,
	stdio: "inherit",
	env: { ...base, ...require("./stub-env"), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
};
// Windows'ta npm'in bun kabuğu bun.cmd: Node >= 18.20.2 kabuksuz .cmd çalıştırmayı EINVAL ile reddeder.
// Sabit komut dizgisi + shell: enjeksiyon yok ve argüman dizisi + shell: true'nun Node 24 DEP0190 uyarısı çıkmaz.
const build =
	process.platform === "win32"
		? spawnSync("bun run build", { ...options, shell: true })
		: spawnSync("bun", ["run", "build"], options);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
if (!fs.existsSync(path.join(out, "server.js"))) throw new Error(`Build finished but ${out}/server.js is missing`);

// standalone sunucu public/ ve .next/static'i kendisi kopyalamaz
fs.cpSync(path.join(web, "public"), path.join(out, "public"), { recursive: true });
if (!fs.existsSync(path.join(out, "public/ort/ort-wasm-simd-threaded.wasm"))) throw new Error("public/ort/ort-wasm-simd-threaded.wasm is missing (the smart cutout runtime; apps/web prebuild copies it)");
fs.cpSync(path.join(web, ".next/static"), path.join(out, ".next/static"), { recursive: true });
