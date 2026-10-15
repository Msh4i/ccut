const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, utilityProcess } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const tcp = require("node:net");
const path = require("node:path");
const { pickEnv } = require("./env");
const { registerExportIpc } = require("./export-ipc");
const { applyHwDecodeSwitch } = require("./perf-switches");
const { readBoundedText, registerSystemMemoryIpc } = require("./system-memory-ipc");
const { registerLinkImportIpc } = require("./link-import-ipc");
const { registerStemsIpc } = require("./stems-ipc");
const { registerMcpIpc } = require("./mcp-ipc");
const { registerModelsIpc } = require("./models-ipc");
const { decideRenderGone } = require("./render-gone");

// IndexedDB/OPFS (projeler, medya) adrese bağlı. Port her açılışta değişirse veri "kaybolur",
// bu yüzden pencere sabit bir özel şemadan yüklenir, Next sunucusu yalnızca arkada konuşur.
const SCHEME = "ccut";
const ORIGIN = `${SCHEME}://app`;
// pointerLock: sayı alanlarında sürükleyerek değer ayarlama (requestPointerLock) kullanıyor
const ALLOWED_PERMISSIONS = ["clipboard-sanitized-write", "fullscreen", "persistent-storage", "pointerLock"];
// Transkripsiyon (transformers.js) ONNX/wasm dosyalarını jsdelivr'den, modelleri huggingface'ten çeker.
const CSP = [
	"default-src 'self' blob: data:",
	"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' data: https://fonts.gstatic.com",
	"img-src 'self' data: blob: https:",
	"media-src 'self' data: blob: https:",
	"connect-src 'self' data: blob: https:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
	"form-action 'self'",
].join("; ");

const WEB = app.isPackaged
	? path.join(process.resourcesPath, "web/apps/web")
	: path.join(__dirname, "../web/.next/standalone/apps/web");
const TOKEN = crypto.randomBytes(32).toString("hex");
const PROOF = crypto.randomBytes(16).toString("hex"); // port başkası tarafından kapılmasın: /api/health bunu döndürmeli

protocol.registerSchemesAsPrivileged([
	{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Opt-in hardware video decode (CCUT_HW_DECODE=1|zerocopy, Linux only, OFF when unset). Switches
// only count before "ready"; see perf-switches.js and docs/ccut/playback-measure-2clips.md.
applyHwDecodeSwitch({ app, env: process.env, platform: process.platform, log: (line) => console.error(line) });

let server;
let win;
let quitting = false;
let exportIpc;
let linkImportIpc;
let stemsIpc;
let mcpIpc;
let modelsIpc;

const freePort = () =>
	new Promise((resolve, reject) => {
		const s = tcp.createServer().on("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

async function waitForServer(base) {
	const deadline = Date.now() + 60_000; // virüs taramalı soğuk Windows başlangıcı 30 sn'yi aşabiliyor
	while (Date.now() < deadline) {
		try {
			const res = await net.fetch(`${base}/api/health`, {
				headers: { "x-ccut-token": TOKEN },
				signal: AbortSignal.timeout(1000),
			});
			if (res.ok && (await res.text()) === PROOF) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("Local Next server did not start within 60 seconds");
}

const openExternal = (url) => {
	try {
		if (new URL(url).protocol === "https:") shell.openExternal(url).catch(() => {});
	} catch {}
};

function fail(err) {
	console.error(err);
	quitting = true;
	server?.kill();
	dialog.showErrorBox("Ccut could not start", String(err?.message ?? err));
	app.exit(1);
}

async function startServer() {
	const entry = path.join(WEB, "server.js");
	if (!fs.existsSync(entry)) throw new Error(`Missing ${entry}. Run "node apps/electron/bundle.js" first.`);

	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const env = {
		...pickEnv(["XDG_RUNTIME_DIR"]),
		...require("./stub-env"),
		BETTER_AUTH_SECRET: crypto.randomBytes(32).toString("hex"),
		CCUT_DESKTOP_TOKEN: TOKEN,
		CCUT_SERVER_PROOF: PROOF,
		NODE_ENV: "production",
		HOSTNAME: "127.0.0.1",
		PORT: String(port),
	};
	server = utilityProcess.fork(entry, [], { cwd: WEB, env, stdio: "inherit", serviceName: "ccut-next" });

	const exited = new Promise((_, reject) =>
		server.once("exit", (code) => {
			if (!quitting) reject(new Error(`Local Next server exited (code ${code})`));
		}),
	);
	await Promise.race([waitForServer(base), exited]);
	server.once("exit", (code) => {
		if (quitting) return;
		quitting = true;
		dialog.showErrorBox("Ccut", `The local server stopped unexpectedly (code ${code}). Ccut will close.`);
		app.quit(); // app.exit değil: beforeunload çalışsın, bekleyen otomatik kayıt kaybolmasın
	});
	return base;
}

function proxyToServer(base) {
	protocol.handle(SCHEME, async (req) => {
		const { host, pathname, search } = new URL(req.url);
		if (host !== "app") return new Response(null, { status: 404 });
		const headers = new Headers(req.headers);
		headers.set("x-ccut-token", TOKEN);
		headers.delete("origin"); // ccut://app kaynağı Next'in Origin/Host denetimine takılmasın
		headers.set("accept-encoding", "identity"); // gzip'i açıp başlığı bırakınca Chromium çift çözmeye çalışır
		// net.fetch değil Node fetch: net.fetch "manual"da her 3xx'i iptal edip ERR_UNEXPECTED veriyor.
		// "follow" olmaz: token'ı yönlendirme hedefine taşır ve adres değişimini sayfadan gizler.
		const res = await fetch(`${base}${pathname}${search}`, {
			method: req.method,
			headers,
			body: req.body,
			duplex: "half",
			redirect: "manual",
		});
		const out = new Headers(res.headers);
		const location = out.get("location");
		if (location?.startsWith(base)) out.set("location", ORIGIN + location.slice(base.length));
		out.set("content-security-policy", CSP);
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
	});
}

function lockDownSession() {
	const sameOrigin = (url) => typeof url === "string" && url.startsWith(`${ORIGIN}/`);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) =>
		cb(ALLOWED_PERMISSIONS.includes(permission) && sameOrigin(details.requestingUrl)),
	);
	session.defaultSession.setPermissionCheckHandler(
		(_wc, permission, requestingOrigin) => ALLOWED_PERMISSIONS.includes(permission) && requestingOrigin === ORIGIN,
	);
}

app.on("web-contents-created", (_e, contents) => {
	const guard = (event) => {
		if (event.url.startsWith(`${ORIGIN}/`)) return;
		event.preventDefault();
		openExternal(event.url);
	};
	contents.on("will-navigate", guard);
	contents.on("will-redirect", guard);
	contents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: "deny" };
	});
});

function createWindow() {
	win = new BrowserWindow({
		width: 1440,
		height: 900,
		backgroundColor: "#111111",
		autoHideMenuBar: true,
		icon: path.join(__dirname, "icon.png"),
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// window.ccutExport only (export to a file the user picks); see export-ipc.js
			preload: path.join(__dirname, "preload.js"),
		},
	});
	exportIpc.watchWindow(win);
	// A dead renderer (Chromium's 8 GiB limit on a many-clip export) leaves a black window: reload it and say why
	let reloads = [];
	win.webContents.on("render-process-gone", (_event, details) => {
		const decision = decideRenderGone({ reason: details.reason, exitCode: details.exitCode, now: Date.now(), recentReloads: reloads });
		if (!decision) return;
		if (win.isDestroyed()) return;
		reloads = decision.recent;
		console.error(`[ccut] renderer gone: ${details.reason} (exit code ${details.exitCode})`);
		if (decision.reload) win.webContents.reload();
		void dialog.showMessageBox(win, { type: "warning", buttons: ["OK"], title: decision.title, message: decision.title, detail: decision.message }).catch(() => {});
	});
	// Editörün beforeunload'u Electron'da kapanışı sessizce engeller: kullanıcıya sor
	win.webContents.on("will-prevent-unload", (event) => {
		const leave =
			dialog.showMessageBoxSync(win, {
				type: "question",
				buttons: ["Leave", "Stay"],
				defaultId: 1,
				cancelId: 1,
				message: exportIpc.hasOpenExport()
					? "An export is still running. If you leave, the unfinished file is deleted. Leave anyway?"
					: "You have unsaved changes. Leave anyway?",
			}) === 0;
		if (leave) event.preventDefault();
	});
	win.loadURL(`${ORIGIN}/projects`).catch((err) => err.code === "ERR_ABORTED" || fail(err));
}

async function main() {
	// Uzaktan hata ayıklama portu açıkken yerel herhangi bir süreç pencereyi yönetebilir
	if (app.isPackaged && (app.commandLine.hasSwitch("remote-debugging-port") || app.commandLine.hasSwitch("remote-debugging-pipe"))) return app.exit(1);
	// İki kopya aynı IndexedDB/OPFS'e yazıp projeyi bozmasın
	if (!app.requestSingleInstanceLock()) return app.quit();
	app.on("second-instance", () => {
		if (win?.isMinimized()) win.restore();
		win?.focus();
	});

	// Görev çubuğu gruplaması ve bildirimler için kimlik; electron-builder appId'siyle aynı olmalı
	if (process.platform === "win32") app.setAppUserModelId("app.ccut.desktop");

	await app.whenReady();
	lockDownSession();
	exportIpc = registerExportIpc({
		ipcMain,
		dialog,
		shell,
		app,
		getWindow: () => win,
		fs,
		fsp,
		origin: ORIGIN,
		env: process.env,
		log: (line) => console.error(line),
		randomUUID: () => crypto.randomUUID(),
	});
	// window.ccutSystem.memoryInfo(): read-only memory figures for the frame cache; see system-memory-ipc.js
	registerSystemMemoryIpc({
		ipcMain,
		getWindow: () => win,
		origin: ORIGIN,
		platform: process.platform,
		readFile: (file) => readBoundedText({ fsp, file }),
		getSystemMemoryInfo: () => process.getSystemMemoryInfo(),
		getAppMetrics: () => app.getAppMetrics(),
		getRendererPid: () => (win && !win.isDestroyed() ? win.webContents.getOSProcessId() : 0),
		log: (line) => console.error(line),
	});
	// window.ccutLinkImport: "Import from link" (yt-dlp in the main process); see link-import-ipc.js
	linkImportIpc = registerLinkImportIpc({
		ipcMain,
		dialog,
		app,
		getWindow: () => win,
		origin: ORIGIN,
		env: process.env,
		log: (line) => console.error(line),
	});
	// window.ccutStems: separate a song into stems with the managed Python + Demucs engine; see stems-ipc.js
	stemsIpc = registerStemsIpc({
		ipcMain,
		dialog,
		app,
		getWindow: () => win,
		origin: ORIGIN,
		log: (line) => console.error(line),
	});
	// window.ccutModels: the smart cutout model download; see models-ipc.js
	modelsIpc = registerModelsIpc({
		ipcMain,
		dialog,
		app,
		getWindow: () => win,
		origin: ORIGIN,
		log: (line) => console.error(line),
	});
	// window.ccutMcp: the MCP server for agents (Claude Code, Codex ...); OFF until the owner turns it on, see mcp-ipc.js
	mcpIpc = registerMcpIpc({
		ipcMain,
		dialog,
		app,
		getWindow: () => win,
		origin: ORIGIN,
		log: (line) => console.error(line),
		version: app.getVersion(),
	});
	proxyToServer(await startServer());
	createWindow();
}

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
	quitting = true;
	exportIpc?.shutdown(); // half-written exports are deleted, never left as .ccut-part
	linkImportIpc?.shutdown(); // a running yt-dlp is killed, its job directory deleted
	stemsIpc?.shutdown(); // a running separation or install is killed and deleted
	modelsIpc?.shutdown();
	mcpIpc?.shutdown(); // the MCP server stops listening
	server?.kill();
});
main().catch(fail);
