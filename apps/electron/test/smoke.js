// Ccut duman testi: paketlenmemiş Electron'u ayrı, geçici bir profille açar ve editörün ana yolunu
// (proje listesi -> yeni proje -> metin ekle -> kayıt) CDP ile gerçek fare tıklamalarıyla yürür.
//
//   node apps/electron/test/smoke.js [--restart]
//
//   --restart          Kapatıp aynı profille yeniden açar, projenin durduğunu doğrular (sabit ccut:// origin sözü).
//   SMOKE_ALLOW_STALE=1  "paket kaynaklardan eski" denetimini atlar (varsayılan: sıkı, eski paketle sahte yeşil olmasın).
//
// Çıktı: stdout'a JSON özet, apps/electron/test/out/ altına smoke.png ve project.json. Çıkış 0 = geçti, 1 = kaldı.
// Önkoşul: apps/web/.next/standalone (node apps/electron/bundle.js). Gerçek bir pencere açar (başsız Linux'ta xvfb-run).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { closeApp, collectProblems, connectToPage, launchElectron, sleep } = require("./cdp");

// Beklenen/zararsız hatalar. Her satıra gerekçe şart; liste boşsa hiçbir hata beklenmiyor demektir.
const ALLOWED_PROBLEMS = [];

const ROOT = path.join(__dirname, "../../..");
const WEB_SRC = path.join(ROOT, "apps/web/src");
const SERVER = path.join(ROOT, "apps/web/.next/standalone/apps/web/server.js");
const OUT = path.join(__dirname, "out");
const MIN_SCREENSHOT_BYTES = 20 * 1024;
const PROJECTS_DB = "video-editor-projects";
// Pencere yöneticisi pencereyi daraltabilir (<1024 px editörde "Desktop only" kapısını açar): ölçüyü sabitle
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

// Tüm çalıştırma bu sürede bitmezse (donmuş renderer, kapanmayan süreç...) süreç öldürülür, JSON özet yine yazılır
const WATCHDOG_MS = 240_000;

const checks = [];
const notes = {};
let activeApp = null;
let userDataDir = null;
let reported = false;
process.on("exit", () => activeApp?.child.kill());

// Geçici profil silinemezse (Windows'ta Chromium/Defender IndexedDB dosyalarını kısa süre tutabilir) yeşil
// çalıştırmayı bozmaz: uyarı olarak not düşülür.
function cleanupProfile() {
	if (!userDataDir) return;
	try {
		fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (error) {
		notes.cleanupWarning = `could not remove ${userDataDir}: ${error.message}`;
	}
	userDataDir = null;
}

// Her koşulda JSON özet + çıkış kodu üretir. stdout bir boru ise yazma bitmeden process.exit çıktıyı keser:
// yazıldıktan sonra çık (yazma tıkanırsa 3 sn sonra yine çık).
function report() {
	if (reported) return;
	reported = true;
	const ok = checks.length > 0 && checks.every((entry) => entry.ok);
	const exit = () => process.exit(ok ? 0 : 1);
	setTimeout(exit, 3000).unref();
	process.stdout.write(`${JSON.stringify({ ok, checks, ...notes, out: OUT }, null, 2)}\n`, exit);
}

setTimeout(async () => {
	checks.push({ name: "watchdog", ok: false, detail: `smoke test did not finish within ${WATCHDOG_MS / 1000} s` });
	if (activeApp) {
		activeApp.child.kill("SIGKILL"); // PID ile; takılmış bir Electron SIGTERM'e yanıt vermeyebilir
		await Promise.race([activeApp.exited, sleep(3000)]); // süreç gitmeden profili silmek, ölen Chromium'un yeniden yazmasına takılır
	}
	cleanupProfile();
	report();
}, WATCHDOG_MS).unref();

async function step(name, fn) {
	try {
		const detail = await fn();
		checks.push({ name, ok: true, ...(detail !== undefined && { detail }) });
		return detail;
	} catch (error) {
		checks.push({ name, ok: false, detail: error.message });
		error.recorded = true;
		throw error;
	}
}

async function waitFor(what, fn, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value) return value;
		await sleep(intervalMs);
	}
	throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

// Gerçek fare tıklaması: öğe görünür ve başka bir şeyle (ör. açık bir diyalog) örtülü değilse tıklanır.
// finder: sayfada çalışan, öğe döndüren fonksiyon kaynağı.
async function click(client, what, finder) {
	let state = "not found";
	const point = await waitFor(
		what,
		async () => {
			const found = await client.evaluate(`(() => {
				const el = (${finder})();
				if (!el) return { state: "not found" };
				el.scrollIntoView({ block: "center", inline: "center" });
				const r = el.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) return { state: "zero size" };
				const x = r.x + r.width / 2, y = r.y + r.height / 2;
				const top = document.elementFromPoint(x, y);
				if (top !== el && !el.contains(top)) return { state: "covered by " + (top ? top.outerHTML.slice(0, 120) : "nothing") };
				return { state: "ok", x, y };
			})()`);
			state = found.state;
			return found.state === "ok" ? found : null;
		},
		{ timeoutMs: 10_000 },
	).catch((error) => {
		throw new Error(`${error.message} (last state: ${state})`);
	});
	await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	for (const type of ["mousePressed", "mouseReleased"]) {
		await client.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
	}
}

const buttonByText = (text, scope = "document") =>
	`() => [...((${scope})?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === ${JSON.stringify(text)})`;

async function readProjects(client) {
	return client.evaluate(`(async () => {
		// open() yoksa veritabanını boş oluşturur ve uygulamanın kendi açışını bozar: önce var mı bak
		if (!(await indexedDB.databases()).some((db) => db.name === ${JSON.stringify(PROJECTS_DB)})) return [];
		return new Promise((resolve, reject) => {
			const open = indexedDB.open(${JSON.stringify(PROJECTS_DB)});
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				if (!db.objectStoreNames.contains("projects")) return (db.close(), resolve([]));
				const all = db.transaction("projects").objectStore("projects").getAll();
				all.onerror = () => (db.close(), reject(all.error));
				all.onsuccess = () => (db.close(), resolve(all.result));
			};
		});
	})()`);
}

function textElementCount(project) {
	return (project.scenes ?? []).reduce((total, scene) => {
		const { overlay = [], main, audio = [] } = scene.tracks ?? {};
		const elements = [...overlay, ...(main ? [main] : []), ...audio].flatMap((track) => track.elements ?? []);
		return total + elements.filter((element) => element.type === "text").length;
	}, 0);
}

function currentProjectVersion() {
	const source = fs.readFileSync(path.join(WEB_SRC, "services/storage/migrations/index.ts"), "utf8");
	const match = source.match(/CURRENT_PROJECT_VERSION\s*=\s*(\d+)/);
	if (!match) throw new Error("CURRENT_PROJECT_VERSION not found in migrations/index.ts");
	return Number(match[1]);
}

// apps/web/src içindeki en yeni dosya (testler pakete girmez, sayılmaz)
function newestSource() {
	let newest = { file: null, mtimeMs: 0 };
	for (const entry of fs.readdirSync(WEB_SRC, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const file = path.join(entry.parentPath, entry.name);
		if (file.split(path.sep).includes("__tests__") || /\.test\.tsx?$/.test(entry.name)) continue;
		const { mtimeMs } = fs.statSync(file);
		if (mtimeMs > newest.mtimeMs) newest = { file: path.relative(ROOT, file), mtimeMs };
	}
	return newest;
}

function checkBundle() {
	if (!fs.existsSync(SERVER)) {
		throw new Error(`${path.relative(ROOT, SERVER)} is missing: run "node apps/electron/bundle.js" first`);
	}
	const newest = newestSource();
	const bundleMs = fs.statSync(SERVER).mtimeMs;
	if (bundleMs >= newest.mtimeMs) return "bundle is newer than sources";
	const message = `bundle is older than ${newest.file}: run "node apps/electron/bundle.js" (or set SMOKE_ALLOW_STALE=1)`;
	if (process.env.SMOKE_ALLOW_STALE !== "1") throw new Error(message);
	notes.stale = true;
	return `SKIPPED (SMOKE_ALLOW_STALE=1): ${message}`;
}

// Bir Electron oturumu: aç, CDP'ye bağlan, sayfayı baştan yükle (açılış hataları da yakalansın), fn'i çalıştır, kapat.
async function session({ label, userDataDir }, fn) {
	const app = await launchElectron({ userDataDir });
	activeApp = app;
	let client;
	let shutdown;
	let problems = [];
	let requests = [];
	try {
		client = await connectToPage({ app });
		({ problems, requests } = collectProblems(client, { allow: ALLOWED_PROBLEMS }));
		for (const domain of ["Page", "Runtime", "Log", "Network"]) await client.send(`${domain}.enable`);
		await client.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
		await client.evaluate("window.__smokeBeforeReload = true");
		await client.send("Page.reload");
		await waitFor(
			"page reload",
			() => client.evaluate('window.__smokeBeforeReload === undefined && document.readyState === "complete"').catch(() => false),
			{ timeoutMs: 30_000 },
		);
		try {
			await fn(client);
		} catch (error) {
			// Başarısızlığı yorumlamak için o anki ekran ve sayfa metni
			await client
				.send("Page.captureScreenshot", { format: "png" })
				.then(({ data }) => fs.writeFileSync(path.join(OUT, "failure.png"), Buffer.from(data, "base64")))
				.catch(() => {});
			notes.failurePageText = await client.evaluate("location.href + ' | ' + document.body.innerText.slice(0, 400)").catch(() => null);
			throw error;
		}
	} finally {
		client?.close();
		shutdown = await closeApp({ app });
		notes[`${label}Shutdown`] = shutdown;
		notes[`${label}Problems`] = problems;
	}
	// Sabit origin sözü: sayfa hiçbir zaman Next'in yerel portuna (127.0.0.1) doğrudan gitmemeli
	await step(`${label}: no request to 127.0.0.1/localhost`, () => {
		const direct = requests.filter((url) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname));
		if (direct.length > 0) throw new Error(`direct local requests: ${direct.slice(0, 5).join(", ")}`);
		return `${requests.length} requests, hosts: ${[...new Set(requests.map((url) => new URL(url).host).filter(Boolean))].join(", ")}`;
	});
	await step(`${label}: no console errors, failed or 4xx/5xx requests`, () => {
		if (problems.length > 0) throw new Error(JSON.stringify(problems.slice(0, 8)));
	});
	// Pencere kapanınca uygulama kendiliğinden, 0 koduyla çıkmalı: "killed" = kapanışta takıldı (ör. main.js'in
	// will-prevent-unload'daki bloklayan showMessageBoxSync'i), sıfır olmayan kod/sinyal = kapanışta çöktü.
	await step(`${label}: app quits on its own with exit code 0`, () => {
		if (shutdown.outcome === "killed") throw new Error(`still running after Browser.close, had to be killed: ${JSON.stringify(shutdown.exit)}`);
		if (shutdown.exit?.code !== 0) throw new Error(`exited with ${JSON.stringify(shutdown.exit)}`);
		return `exit code ${shutdown.exit.code}`;
	});
}

async function firstSession({ userDataDir, version }) {
	let projectId;
	await session({ label: "first", userDataDir }, async (client) => {
		await step("projects page url is ccut://app/projects", async () => {
			const href = await client.evaluate("location.href");
			if (href !== "ccut://app/projects") throw new Error(`href is ${href}`);
		});
		await step("/api/health answers through the ccut:// proxy", async () => {
			const { status, body } = await client.evaluate(
				"fetch('/api/health', { signal: AbortSignal.timeout(10000) }).then(async (r) => ({ status: r.status, body: await r.text() }))",
			);
			if (status !== 200 || body.length === 0) throw new Error(`status ${status}, body length ${body.length}`);
		});

		await step("New project opens /editor/<id>", async () => {
			await click(client, '"New project" button', buttonByText("New project"));
			const pathname = await waitFor("navigation to the editor", async () => {
				const current = await client.evaluate("location.pathname");
				return /^\/editor\/[^/]+$/.test(current) ? current : null;
			});
			projectId = pathname.split("/").pop();
			return pathname;
		});

		await step("first-run onboarding is completed", async () => {
			// Boş profilde Onboarding açılır; yoksa (ürün değişmiş olabilir) hata değil, not düşülür.
			const next = await waitFor("onboarding or editor", async () => {
				const open = await client.evaluate('!!document.querySelector(\'[role="dialog"]\')');
				const editorReady = await client.evaluate('!!document.querySelector(\'button[aria-label="Text"]\')');
				return open ? "dialog" : editorReady ? "editor" : null;
			}, { timeoutMs: 30_000 });
			if (next === "editor") {
				await sleep(1500); // Onboarding editörden sonra çizilebilir
				if (!(await client.evaluate('!!document.querySelector(\'[role="dialog"]\')'))) return "not shown";
			}
			await click(client, "onboarding Next", buttonByText("Next", 'document.querySelector(\'[role="dialog"]\')'));
			await click(client, "onboarding Finish", buttonByText("Finish", 'document.querySelector(\'[role="dialog"]\')'));
			await waitFor("onboarding dialog to close", async () => !(await client.evaluate('!!document.querySelector(\'[role="dialog"]\')')));
			return "completed";
		});

		await step("Text tab -> Default text adds a text element", async () => {
			await click(client, "Text tab", () => document.querySelector('button[aria-label="Text"]'));
			await click(client, "Default text add button", () =>
				[...document.querySelectorAll("span")].find((span) => span.textContent.trim() === "Default text")?.closest(".group")?.querySelector("button"),
			);
		});

		const saved = await step("autosave wrote a project with a text element", async () => {
			const project = await waitFor(
				"the project to be saved with a text element",
				async () => (await readProjects(client)).find((p) => p.id === projectId && textElementCount(p) >= 1),
				{ timeoutMs: 15_000, intervalMs: 300 },
			);
			if (project.version !== version) throw new Error(`stored version ${project.version}, expected CURRENT_PROJECT_VERSION ${version}`);
			return { version: project.version, textElements: textElementCount(project) };
		});
		notes.saved = saved;
		fs.writeFileSync(path.join(OUT, "project.json"), JSON.stringify(await readProjects(client), null, 2));

		await step("screenshot", async () => {
			const { data } = await client.send("Page.captureScreenshot", { format: "png" });
			const png = Buffer.from(data, "base64");
			fs.writeFileSync(path.join(OUT, "smoke.png"), png);
			if (png.length < MIN_SCREENSHOT_BYTES) throw new Error(`screenshot is only ${png.length} bytes (blank window?)`);
			notes.degradedRenderer = await client.evaluate("document.body.innerText.includes(\"GPU rendering isn't available\")");
			return `${png.length} bytes`;
		});
	});
	return projectId;
}

async function restartSession({ userDataDir, projectId, version }) {
	await session({ label: "restart", userDataDir }, async (client) => {
		await step("restart: same ccut:// origin", async () => {
			const href = await client.evaluate("location.href");
			if (href !== "ccut://app/projects") throw new Error(`href is ${href}`);
		});
		await step("restart: project is still in IndexedDB and listed", async () => {
			const project = (await readProjects(client)).find((p) => p.id === projectId);
			if (!project) throw new Error(`project ${projectId} is gone after restart`);
			if (textElementCount(project) < 1) throw new Error("project lost its text element");
			if (project.version !== version) throw new Error(`stored version ${project.version}, expected ${version}`);
			await waitFor("the project card on /projects", () => client.evaluate(`!!document.querySelector('a[href="/editor/${projectId}"]')`));
		});
	});
}

async function main() {
	try {
		await step("bundle is present and fresh", async () => checkBundle());
		const version = currentProjectVersion();
		fs.mkdirSync(OUT, { recursive: true });
		fs.rmSync(path.join(OUT, "failure.png"), { force: true }); // önceki başarısız çalıştırmanın artığı yanıltmasın
		userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-smoke-"));
		const projectId = await firstSession({ userDataDir, version });
		if (process.argv.includes("--restart")) await restartSession({ userDataDir, projectId, version });
	} catch (error) {
		// step() zaten kaydetti; kaydı olmayan hata (başlatma, CDP bağlantısı...) burada eklenir
		if (!error.recorded) checks.push({ name: "unexpected error", ok: false, detail: error.stack ?? String(error) });
	} finally {
		cleanupProfile();
	}
}

main()
	.catch((error) => checks.push({ name: "unexpected error", ok: false, detail: error.stack ?? String(error) }))
	.finally(report);
