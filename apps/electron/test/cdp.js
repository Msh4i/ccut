// Electron'u ayrı profille açıp Chrome DevTools Protocol (CDP) üzerinden yönetmek için başlatıcı,
// küçük bir CDP istemcisi ve hata toplayıcılar. Bağımlılık yok (Node >= 22: global WebSocket/fetch).
// Playwright bilerek yok: paketli uygulamada nodeCliInspect fuse'u kapalı, CDP yalnızca geliştirme kurulumunda çalışır.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ELECTRON_DIR = path.join(__dirname, "..");

// CDP çağrısı bu sürede yanıtlanmazsa (donmuş renderer, ana süreç bir diyalogda bloklu) reddedilir
const SEND_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// main.js'teki freePort ile aynı kalıp
const freePort = () =>
	new Promise((resolve, reject) => {
		const server = net.createServer().on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

// Anahtarı büyük harfe çevirip karşılaştır: Windows ortam değişkeni adlarında büyük/küçük harf duyarsız.
// ELECTRON_RUN_AS_NODE (VS Code'dan miras kalabiliyor) Electron'u düz Node gibi başlatır, pencere hiç açılmaz.
const cleanEnv = (env) =>
	Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE"));

// DevToolsActivePort (Chromium writes it into the user-data dir when remote debugging is on):
// the first line is the port. Null for anything else.
function parseDevToolsActivePort(text) {
	if (typeof text !== "string") return null;
	const first = text.split("\n")[0];
	if (!/^\d{1,5}$/.test(first)) return null;
	const port = Number(first);
	return port >= 1 && port <= 65535 ? port : null;
}

const remoteDebuggingArgs = ({ port, userDataDir, portFromUserDataDir }) => [`--remote-debugging-port=${portFromUserDataDir ? 0 : port}`, `--user-data-dir=${userDataDir}`];

async function waitForDevToolsPort({ file, app, timeoutMs, intervalMs = 100 }) {
	const deadline = Date.now() + timeoutMs;
	for (let i = 0; Date.now() < deadline && i < Math.ceil(timeoutMs / intervalMs) + 1; i++) {
		if (app.exitInfo()) throw new Error(`Electron exited before writing DevToolsActivePort (${JSON.stringify(app.exitInfo())})\n${app.output().slice(-1500)}`);
		let text = null;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			text = null;
		}
		const port = parseDevToolsActivePort(text);
		if (port) return port;
		await sleep(intervalMs);
	}
	throw new Error(`no usable ${path.basename(file)} within ${timeoutMs} ms`);
}

// Paketlenmemiş Electron'u (apps/electron/main.js) uzaktan hata ayıklama portuyla başlatır.
// userDataDir ayrı olduğu için kullanıcının açık Ccut'unun tek-örnek kilidine takılmaz.
// portFromUserDataDir (perf-two-clips.js only): --remote-debugging-port=0, the port Chromium picked
// is read from <userDataDir>/DevToolsActivePort (no window between a free-port probe and the launch).
async function launchElectron({ userDataDir, portFromUserDataDir = false }) {
	const portFile = path.join(userDataDir, "DevToolsActivePort");
	if (portFromUserDataDir) fs.rmSync(portFile, { force: true }); // a file of an earlier session
	const port = portFromUserDataDir ? 0 : await freePort();
	const child = spawn(
		require("electron"),
		[ELECTRON_DIR, ...remoteDebuggingArgs({ port, userDataDir, portFromUserDataDir })],
		{ stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(process.env) },
	);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (output += chunk));
	// "error": çalıştırılabilir dosya yok/açılamadı (exit olayı hiç gelmez)
	const exited = new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
		child.once("error", (error) => resolve({ error: error.message }));
	});
	let exitInfo = null;
	exited.then((info) => (exitInfo = info));
	const app = { child, port, exited, output: () => output, exitInfo: () => exitInfo };
	if (portFromUserDataDir) {
		try {
			app.port = await waitForDevToolsPort({ file: portFile, app, timeoutMs: 75_000 });
		} catch (error) {
			child.kill("SIGKILL");
			throw error;
		}
	}
	return app;
}

async function getJson(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
	return response.json();
}

// Uygulamanın ccut:// sayfa hedefini bekler (Next sunucusu ayağa kalkana kadar pencere açılmaz).
async function waitForPageTarget({ app, timeoutMs }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (app.exitInfo()) throw new Error(`Electron exited early (${JSON.stringify(app.exitInfo())})\n${app.output().slice(-1500)}`);
		try {
			const targets = await getJson(`http://127.0.0.1:${app.port}/json`);
			const page = targets.find((target) => target.type === "page" && target.url.startsWith("ccut://"));
			if (page) return page;
		} catch {
			// CDP portu henüz dinlemiyor
		}
		await sleep(250);
	}
	throw new Error(`No ccut:// page target within ${timeoutMs} ms\n${app.output().slice(-1500)}`);
}

async function createClient(webSocketUrl) {
	const ws = new WebSocket(webSocketUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`CDP websocket did not open in ${SEND_TIMEOUT_MS} ms: ${webSocketUrl}`)), SEND_TIMEOUT_MS);
		ws.onopen = () => (clearTimeout(timer), resolve());
		ws.onerror = () => (clearTimeout(timer), reject(new Error(`CDP websocket did not open: ${webSocketUrl}`)));
	});
	const pending = new Map();
	const handlers = new Map();
	let nextId = 0;

	ws.onmessage = (message) => {
		const data = JSON.parse(message.data);
		if (data.id !== undefined) {
			const call = pending.get(data.id);
			pending.delete(data.id);
			clearTimeout(call?.timer);
			if (data.error) call?.reject(new Error(`${call.method}: ${data.error.message}`));
			else call?.resolve(data.result);
			return;
		}
		for (const handler of handlers.get(data.method) ?? []) handler(data.params);
	};
	ws.onclose = () => {
		for (const call of pending.values()) {
			clearTimeout(call.timer);
			call.reject(new Error(`${call.method}: CDP connection closed`));
		}
		pending.clear();
	};

	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${method}: no CDP response within ${SEND_TIMEOUT_MS} ms (renderer or main process hung?)`));
			}, SEND_TIMEOUT_MS);
			pending.set(id, { method, resolve, reject, timer });
			ws.send(JSON.stringify({ id, method, params }));
		});

	const on = (method, handler) => {
		handlers.set(method, [...(handlers.get(method) ?? []), handler]);
	};

	// Sayfa içinde ifade çalıştırır, değeri JSON olarak geri verir. Sayfada istisna olursa fırlatır.
	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) {
			throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
		}
		return result.value;
	};

	return { send, on, evaluate, close: () => ws.close() };
}

// main.js sunucuya 60 sn tanıyor (soğuk Windows başlangıcı); hedef ancak sunucu hazır olunca görünür: 75 sn
async function connectToPage({ app, timeoutMs = 75_000 }) {
	const target = await waitForPageTarget({ app, timeoutMs });
	return createClient(target.webSocketDebuggerUrl);
}

// Kapatma: önce tarayıcı düzeyinde CDP Browser.close (pencereyi normal yoldan kapatır, IndexedDB diske yazılır),
// süre dolarsa süreci öldür. { outcome: "graceful" | "killed", exit: { code, signal } | { error } | null } döner.
async function closeApp({ app, gracefulMs = 8000 }) {
	const timeout = (ms) => sleep(ms).then(() => "timeout");
	try {
		const { webSocketDebuggerUrl } = await getJson(`http://127.0.0.1:${app.port}/json/version`);
		const browser = await createClient(webSocketDebuggerUrl);
		browser.send("Browser.close").catch(() => {});
	} catch {
		// CDP zaten kapanmış olabilir
	}
	if ((await Promise.race([app.exited, timeout(gracefulMs)])) !== "timeout") {
		return { outcome: "graceful", exit: app.exitInfo() };
	}
	app.child.kill();
	await Promise.race([app.exited, timeout(5000)]);
	return { outcome: "killed", exit: app.exitInfo() };
}

// Konsol/ağ/istisna hatalarını toplar. Allow-list her satırı gerekçelendirmeli (smoke.js başında).
// requests: sayfanın yaptığı tüm istek URL'leri (sabit origin sözünü denetlemek için).
function collectProblems(client, { allow = [] } = {}) {
	const problems = [];
	const requests = [];
	const urlByRequestId = new Map();
	const add = (kind, text, url) => {
		const line = `${kind} ${text} ${url ?? ""}`;
		if (allow.some(({ match }) => match.test(line))) return;
		problems.push({ kind, text, url });
	};

	client.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) =>
		add("exception", d.exception?.description ?? d.text, d.url),
	);
	client.on("Runtime.consoleAPICalled", ({ type, args }) => {
		if (type !== "error") return;
		add("console.error", args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "));
	});
	client.on("Log.entryAdded", ({ entry }) => {
		if (entry.level === "error") add("log.error", entry.text, entry.url);
	});
	client.on("Network.requestWillBeSent", ({ requestId, request }) => {
		urlByRequestId.set(requestId, request.url);
		requests.push(request.url);
	});
	client.on("Network.loadingFailed", ({ requestId, errorText, canceled }) => {
		// ERR_ABORTED: sayfa değişince iptal edilen istekler, gerçek hata değil
		if (errorText === "net::ERR_ABORTED" || canceled) return;
		add("request.failed", errorText, urlByRequestId.get(requestId));
	});
	client.on("Network.responseReceived", ({ response }) => {
		if (response.status >= 400) add("http.error", String(response.status), response.url);
	});

	return { problems, requests };
}

module.exports = { sleep, launchElectron, connectToPage, closeApp, collectProblems, parseDevToolsActivePort, remoteDebuggingArgs, waitForDevToolsPort };
