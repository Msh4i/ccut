// Runs every scene of scenes.json in its own page of headless Chromium (SwiftShader WebGPU) and prints one JSON line
// per scene plus a summary. Exit code 1 when any scene threw, panicked or reported a GPU validation error.
// Usage: node drive.mjs <clip|scene> [size prefix, e.g. 1920x]    (see README.md)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const root = path.dirname(new URL(import.meta.url).pathname);
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const SCENE_TIMEOUT_MS = 120_000;

const server = http
	.createServer((request, response) => {
		const requested = path.resolve(root, `.${request.url === "/" ? "/index.html" : request.url.split("?")[0]}`);
		const inside = requested === root || requested.startsWith(root + path.sep);
		if (!inside || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) {
			response.statusCode = 404;
			response.end();
			return;
		}
		response.setHeader("content-type", types[path.extname(requested)] ?? "application/octet-stream");
		fs.createReadStream(requested).pipe(response);
	})
	.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const mode = process.argv[2] ?? "clip";
const sizePrefix = process.argv[3];
const scenes = JSON.parse(fs.readFileSync(path.join(root, "scenes.json"), "utf8")).filter(
	(scene) => !sizePrefix || scene.label.startsWith(sizePrefix),
);

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
	headless: true,
	args: [
		"--enable-unsafe-webgpu",
		"--enable-features=Vulkan",
		"--use-angle=swiftshader",
		"--use-webgpu-adapter=swiftshader",
		"--enable-webgpu-developer-features",
		"--no-sandbox",
		"--ignore-gpu-blocklist",
		"--headless=new",
	],
});

const results = [];
for (const scene of scenes) {
	const page = await browser.newPage();
	const logs = [];
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning") logs.push(`${message.type()}: ${message.text().slice(0, 200)}`);
	});
	page.on("pageerror", (error) => logs.push(`pageerror: ${String(error).slice(0, 200)}`));
	await page.goto(url);
	await page.waitForFunction(() => window.__ready);

	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout ${SCENE_TIMEOUT_MS / 1000}s`)), SCENE_TIMEOUT_MS);
	});
	let result;
	try {
		[result] = await Promise.race([page.evaluate(([s, m]) => window.__run(s, m), [[scene], mode]), timeout]);
	} catch (error) {
		result = { label: scene.label, intensity: scene.intensity, ok: false, error: String(error.message).slice(0, 200) };
	}
	clearTimeout(timer);
	result.panic = await page.evaluate(() => (window.__wasmPanic ? String(window.__wasmPanic).slice(0, 200) : null)).catch(() => "page gone");
	result.console = [...new Set(logs.filter((line) => !line.includes("404")))].slice(0, 3);
	console.log(JSON.stringify(result));
	results.push(result);
	await page.close();
}

const failed = results.filter((r) => !r.ok || r.gpuErrors || r.panic);
console.log(`\n${mode}: ${results.length} scenes, ${failed.length} failed (threw, panicked or reported a GPU error)`);
for (const r of failed) console.log(`  ${r.label} intensity ${r.intensity}: ${r.error ?? r.lastGpuError ?? r.panic}`);
await browser.close();
server.close();
process.exitCode = failed.length ? 1 : 0;
