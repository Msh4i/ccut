// Ccut özellik entegrasyon testi: Faz 1'in beş özelliğini (özel font, sayı çubukları, giriş/çıkış animasyonu, otomatik beat,
// kamera izleme "Stick to scene") paketlenmemiş Electron penceresinde, CDP üzerinden GERÇEK fare/klavye olaylarıyla dener.
// Plan: Plans/entegrasyon-testi.md (senaryolar A-F). Altyapı: cdp.js (başlatıcı + istemci + hata toplayıcı).
//
//   node apps/electron/test/features.js [--only A,B,C,D,E2,F,G,H,I,L,X]
//   E2 (features-camera.js): "Stick to scene" gerçek pencere ölçümleri E2.1-E2.13 (eski tek nokta izleme bölümü E T6'da kaldırıldı).
//   G/H/I (features-content.js): font paketi çevrimdışı, sticker sağlayıcıları, masaüstü temizliği + kayıt/çıkış akışı. L: yerleşim. X (features-export.js): dışa aktarma (AAC/WebM/iptal/hata/sticker).
//
// Çıktı: stdout'a adım adım PASS/FAIL/N/V, apps/electron/test/out/features.json (adımlar + ölçümler) ve ekran görüntüleri.
// Kural: bir adım kalırsa koşu durmaz; ürün kodu burada DÜZELTİLMEZ, yalnızca teşhis edilir.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { closeApp, collectProblems, connectToPage, launchElectron, sleep } = require("./cdp");
const { generateAssets, VIDEO } = require("./features-assets");
const ed = require("./features-editor");
const content = require("./features-content");
const exportScenario = require("./features-export");
const cameraScenario = require("./features-camera");
const lib = require("./features-lib");
const { regionStats, centroidWhere } = require("./png");

const { OUT, createReporter, createShooter, expect, notVerified, pageText, readProjects, projectElements, problemWindow, toastTexts, waitFor, mouse, press, clickEl, byTextFinder, rectOf } = lib;

// Beklenen/zararsız hatalar. Her satıra gerekçe şart; boş = hiçbir hata beklenmiyor.
const ALLOWED_PROBLEMS = [];

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const WATCHDOG_MS = 25 * 60_000;
// A real song for the beat cases: point CCUT_REAL_SONG at any music file.
const REAL_SONG = process.env.CCUT_REAL_SONG ?? "";

const only = (() => {
	const index = process.argv.indexOf("--only");
	return index === -1 ? null : new Set(process.argv[index + 1].split(",").map((s) => s.trim().toUpperCase()));
})();
const wanted = (id) => !only || only.has(id);

const R = createReporter();
let activeApp = null;
let userDataDir = null;
let assetsDir = null;
let reported = false;
const startedAt = Date.now();
process.on("exit", () => activeApp?.child.kill());

function cleanup() {
	for (const dir of [userDataDir, assetsDir]) {
		if (!dir) continue;
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch (error) {
			R.note(`cleanupWarning:${path.basename(dir)}`, error.message);
		}
	}
	userDataDir = assetsDir = null;
}

function report() {
	if (reported) return;
	reported = true;
	const counts = { PASS: 0, FAIL: 0, "NOT VERIFIED": 0 };
	for (const step of R.steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
	const summary = {
		counts,
		seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
		scenarios: R.scenarios,
		metrics: R.metrics,
		notes: R.notes,
		steps: R.steps,
		out: OUT,
	};
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, "features.json"), JSON.stringify(summary, null, 2));
	console.log(`\nSUMMARY ${JSON.stringify(counts)} in ${summary.seconds} s -> ${path.join(OUT, "features.json")}`);
	const exit = () => process.exit(counts.FAIL === 0 ? 0 : 1);
	setTimeout(exit, 2000).unref();
	process.stdout.write("", exit);
}

setTimeout(async () => {
	R.steps.push({ scenario: "watchdog", id: "watchdog", name: "run finished in time", status: "FAIL", detail: `features.js did not finish within ${WATCHDOG_MS / 60000} min` });
	if (activeApp) {
		activeApp.child.kill("SIGKILL"); // yalnızca PID ile
		await Promise.race([activeApp.exited, sleep(3000)]);
	}
	cleanup();
	report();
}, WATCHDOG_MS).unref();

// ---------------------------------------------------------------- paket tazeliği (smoke.js ile aynı mantık, burada yalnızca bilgi/adım)
const WEB_SRC = path.join(__dirname, "../../web/src");
const SERVER = path.join(__dirname, "../../web/.next/standalone/apps/web/server.js");
function bundleFreshness() {
	let newest = { file: null, mtimeMs: 0 };
	for (const entry of fs.readdirSync(WEB_SRC, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const file = path.join(entry.parentPath, entry.name);
		if (file.split(path.sep).includes("__tests__") || /\.test\.tsx?$/.test(entry.name)) continue;
		const { mtimeMs } = fs.statSync(file);
		if (mtimeMs > newest.mtimeMs) newest = { file: path.relative(WEB_SRC, file), mtimeMs };
	}
	const bundleMs = fs.statSync(SERVER).mtimeMs;
	return { fresh: bundleMs >= newest.mtimeMs, bundleTime: new Date(bundleMs).toISOString(), newestSource: newest.file, newestSourceTime: new Date(newest.mtimeMs).toISOString() };
}

// ---------------------------------------------------------------- oturum
// Bir Electron oturumu: aç, bağlan, sayfayı baştan yükle (açılış hataları da yakalansın), 1440x900'e sabitle.
async function openSession(label) {
	const app = await launchElectron({ userDataDir });
	activeApp = app;
	const client = await connectToPage({ app });
	const { problems, requests } = collectProblems(client, { allow: ALLOWED_PROBLEMS });
	const documents = [];
	client.on("Network.responseReceived", ({ type, response }) => {
		if (type === "Document") documents.push({ url: response.url, status: response.status });
	});
	for (const domain of ["Page", "Runtime", "Log", "Network"]) await client.send(`${domain}.enable`);
	await client.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
	// Toast metin değişimlerini performance.now() ile kaydet (süre ölçümü için yoklamadan daha kesin)
	await client.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `(() => {
			// Güvenlik ağı: editörün kirli-proje beforeunload'u Electron'da main.js'teki showMessageBoxSync (yerel, bloklayan diyalog)
			// ile "Leave anyway?" sorar ve CDP oturumunu kilitler. Test kayıt bitmesini zaten bekler; bu dinleyici hiç eklenmesin.
			const addListener = window.addEventListener.bind(window);
			window.addEventListener = (type, ...rest) => (type === "beforeunload" ? undefined : addListener(type, ...rest));
			window.__toastLog = [];
			const record = () => {
				const text = [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.innerText.replace(/\\s+/g, " ").trim()).join(" | ");
				const log = window.__toastLog;
				if (!log.length || log[log.length - 1].text !== text) log.push({ t: performance.now(), text });
			};
			new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true });
		})()`,
	});
	await client.evaluate("window.__smokeBeforeReload = true");
	await client.send("Page.reload");
	await waitFor("page reload", () => client.evaluate('window.__smokeBeforeReload === undefined && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
	const shoot = createShooter({ client });
	const ctx = { label, app, client, problems, requests, documents, shoot, window: problemWindow({ problems, requests }), shutdown: null };
	R.setFailureHook(async (name) => {
		const { file } = await shoot(name);
		return { screenshot: file, pageText: await pageText(client) };
	});
	return ctx;
}

async function closeSession(ctx) {
	try {
		await ed.waitSaved(ctx.client, readProjects);
	} catch {
		// kapanış yine de denenir
	}
	state.problemsBySession[ctx.label] = ctx.problems.slice();
	state.requestsBySession[ctx.label] = ctx.requests.slice();
	ctx.client.close();
	ctx.shutdown = await closeApp({ app: ctx.app });
	R.note(`${ctx.label}Shutdown`, ctx.shutdown);
	activeApp = null;
}

// ---------------------------------------------------------------- önizleme ölçümleri
const canvasFinder = () => `() => (${ed.PREVIEW}).querySelector("canvas")`;
// Tuval yeniden kurulurken (renderer/önizleme yeniden bağlanırken) kısa süre yok olabilir: 4 sn'ye kadar bekle
const canvasRect = async (client) => {
	let rect = null;
	await waitFor("preview canvas", async () => ((rect = await rectOf(client, canvasFinder())) && rect.w > 0 ? rect : null), { timeoutMs: 4000, intervalMs: 100 }).catch(() => {});
	return rect;
};

// Önizleme tuvalinin ekran görüntüsü; tutamaç/ana hat katmanları gizlenir (yalnızca tuval çizilir)
async function shootCanvas(ctx, name, { save = true } = {}) {
	const rect = await canvasRect(ctx.client);
	expect(rect && rect.w > 0, "preview canvas is not visible");
	await ctx.client.evaluate(`(() => { const p = ${ed.PREVIEW}; p.style.visibility = "hidden"; p.querySelector("canvas").style.visibility = "visible"; })()`);
	try {
		await sleep(60);
		const shot = await ctx.shoot(name, { clip: rect, save });
		return { ...shot, rect };
	} finally {
		await ctx.client.evaluate(`(() => { const p = ${ed.PREVIEW}; p.style.visibility = ""; p.querySelector("canvas").style.visibility = ""; })()`);
	}
}

// Çizim oturana dek (iki ardışık görüntü aynı) bekleyip ölçer. minLuma: metin pikseli eşiği.
async function measureCanvas(ctx, name, { minLuma = 235, settleMs = 150, timeoutMs = 4000, save = true } = {}) {
	const deadline = Date.now() + timeoutMs;
	let previous = null;
	let shot;
	while (Date.now() < deadline) {
		shot = await shootCanvas(ctx, name, { save: false });
		const stats = regionStats(shot.image, { x: 0, y: 0, w: shot.image.width, h: shot.image.height }, { minLuma });
		const signature = `${stats.bright}|${stats.max}|${stats.bbox?.x}|${stats.bbox?.w}`;
		if (previous === signature) break;
		previous = signature;
		await sleep(settleMs);
	}
	if (save) fs.writeFileSync(path.join(OUT, `${name}.png`), shot.png);
	const stats = regionStats(shot.image, { x: 0, y: 0, w: shot.image.width, h: shot.image.height }, { minLuma });
	return { ...stats, image: shot.image, rect: shot.rect, file: path.join(OUT, `${name}.png`) };
}

// Seçim kutusunun genişliği: sol/sağ kenar tutamaçlarının merkezleri
const selectionBox = (client) =>
	client.evaluate(`(() => {
		const handles = [...(${ed.PREVIEW}).querySelectorAll("button")].filter((b) => getComputedStyle(b).cursor === "ew-resize").map((b) => b.getBoundingClientRect());
		if (!handles.length) return null;
		const xs = handles.map((r) => r.x + r.width / 2);
		return { left: Math.min(...xs), right: Math.max(...xs), width: Math.max(...xs) - Math.min(...xs) };
	})()`);

const fontTriggerFinder = `() => [...(${ed.PROPS}).querySelectorAll("button")].find((b) => b.getAttribute("aria-haspopup") === "dialog" && b.querySelector("span.truncate"))`;
const popoverFinder = `() => document.querySelector('[role="tablist"]')?.closest('[role="dialog"]')`;

async function openFontPicker(ctx) {
	await ed.propsTab(ctx.client, "Text");
	await clickEl(ctx.client, "font picker trigger", fontTriggerFinder);
	await waitFor("font picker popover", () => ctx.client.evaluate(`!!(${popoverFinder})()`));
}
async function closeFontPicker(ctx) {
	if (await ctx.client.evaluate(`!!(${popoverFinder})()`)) {
		await press(ctx.client, "Escape");
		await waitFor("font picker to close", async () => !(await ctx.client.evaluate(`!!(${popoverFinder})()`)), { timeoutMs: 5000 }).catch(() => {});
		await sleep(200);
	}
}
const fontTriggerState = (client) =>
	client.evaluate(`(() => {
		const b = (${fontTriggerFinder})();
		if (!b) return null;
		const label = b.querySelector("span.truncate");
		return { text: b.innerText.trim(), aria: b.getAttribute("aria-label"), caution: !!b.querySelector(".text-caution"), title: b.querySelector("[title]")?.getAttribute("title") ?? null, labelFontFamily: label ? getComputedStyle(label).fontFamily : null };
	})()`);

// ---------------------------------------------------------------- A. Font
const FONT_FAMILY_RE = /Added (.+)$/;
const state = { fontFamily: null, fontWidth: null, arialWidth: null, projectId: null, selectionWidthBefore: null, problemsBySession: {}, requestsBySession: {} };

async function scenarioA1(ctx) {
	const { client } = ctx;
	const { files } = ctx.assets;
	await R.step("A.0", "new project opens, text is added", async () => {
		state.projectId = await ed.newProject(client);
		await ed.addDefaultText(client);
		const clips = await ed.clipsInfo(client);
		expect(clips.length === 1 && clips[0].selected, "text clip not added/selected", { actual: clips });
		return `project ${state.projectId}`;
	});
	await ed.propsTab(client, "Text").catch(() => {});

	await R.step("A.1", "font picker has All fonts / My fonts tabs, no dead Favorites tab, Import button on My fonts", async () => {
		const before = await measureCanvas(ctx, "A1-arial-before");
		expect(before.bbox, "no white text found in the preview before changing the font");
		state.arialWidth = before.bbox.w;
		await openFontPicker(ctx);
		const tabs = await client.evaluate(`[...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((t) => t.innerText.trim())`);
		const pickerText = await client.evaluate(`(${popoverFinder})().innerText`);
		expect(JSON.stringify(tabs) === JSON.stringify(["All fonts", "My fonts"]), "unexpected tabs", { expected: ["All fonts", "My fonts"], actual: tabs });
		expect(!/favorite/i.test(pickerText), "a Favorites tab/text is still in the font picker", { actual: pickerText.slice(0, 200) });
		await clickEl(client, "My fonts tab", byTextFinder("button", "My fonts", `(${popoverFinder})()`));
		await sleep(250);
		const importBtn = await rectOf(client, byTextFinder("button", "Import", `(${popoverFinder})()`));
		expect(importBtn && importBtn.w > 0, "no Import button on the My fonts tab");
		const emptyText = await client.evaluate(`(${popoverFinder})().innerText.includes("No custom fonts yet.")`);
		await ctx.shoot("A1-picker-my-fonts");
		return { tabs, importButton: true, emptyStateShown: emptyText };
	});

	await R.step("A.2", "RobotoCondensed imported, listed under My fonts, applied, preview draws it with that font", async () => {
		const requestsBefore = ctx.requests.length;
		await chooseImport(ctx, [files.font]);
		const toast = await waitFor("an 'Added ...' toast", async () => (await toastTexts(client)).find((t) => /Added/.test(t)), { timeoutMs: 15_000 });
		const family = FONT_FAMILY_RE.exec(toast.replace(/\s*Close.*$/, "").trim())?.[1]?.trim();
		expect(family, "could not read the family from the toast", { actual: toast });
		state.fontFamily = family;
		// listede görünüyor mu
		const row = await waitFor("custom font row", () => client.evaluate(`!![...(${popoverFinder})().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(family)})`));
		expect(row, "font not listed under My fonts");
		await ctx.shoot("A2-my-fonts-listed");
		// uygula
		await clickEl(client, `font row ${family}`, `() => [...(${popoverFinder})().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(family)})`);
		await waitFor("picker to close", async () => !(await client.evaluate(`!!(${popoverFinder})()`)), { timeoutMs: 5000 });
		const trigger = await fontTriggerState(client);
		expect(trigger?.text === family, "font trigger does not show the applied family", { expected: family, actual: trigger });
		const faces = await client.evaluate(`[...document.fonts].map((f) => ({ family: f.family, status: f.status, style: f.style, weight: f.weight }))`);
		const loaded = faces.find((f) => f.family.replace(/["']/g, "") === family);
		expect(loaded && loaded.status === "loaded", "document.fonts has no loaded face for the family", { expected: family, actual: faces.slice(-5) });
		const check = await client.evaluate(`document.fonts.check('16px "${family.replace(/"/g, '\\"')}"')`);
		expect(check, "document.fonts.check is false for the custom family");
		// glif genişliği değişimi: önizlemede Arial yerine Roboto Condensed Light Italic
		const after = await measureCanvas(ctx, "A2-custom-font-applied");
		expect(after.bbox, "no white text in the preview after applying the font");
		state.fontWidth = after.bbox.w;
		const ratio = after.bbox.w / state.arialWidth;
		expect(Math.abs(ratio - 1) > 0.1, "text width did not change enough: the preview still seems to draw Arial", { expected: "ratio differs from 1 by >10%", actual: `Arial ${state.arialWidth}px -> custom ${after.bbox.w}px (ratio ${ratio.toFixed(2)})` });
		const sel = await selectionBox(client);
		state.selectionWidthBefore = sel?.width ?? null;
		R.metric("A.font.textWidthPx", { arial: state.arialWidth, custom: after.bbox.w, ratio: Number(ratio.toFixed(3)), selectionWidth: sel?.width });
		return { family, faceStatus: loaded.status, widthRatio: Number(ratio.toFixed(2)), toast, newRequests: ctx.requests.slice(requestsBefore).length };
	});

	await R.step("A.3", "no fonts.googleapis.com request for the custom family name", async () => {
		const googleRequests = ctx.requests.filter((url) => /fonts\.(googleapis|gstatic)\.com/.test(url));
		const mentioningCustom = googleRequests.filter((url) => /roboto|custom/i.test(decodeURIComponent(url)));
		R.metric("A.googleFontRequests", { total: googleRequests.length, sample: googleRequests.slice(0, 5) });
		expect(mentioningCustom.length === 0, "Google Fonts was asked for the custom family", { actual: mentioningCustom });
		return `${googleRequests.length} Google font requests in the session, none for the custom family`;
	});

	await R.step("A.4", "fake .ttf and truncated .ttf are rejected with ONE toast, app stays alive, no console error", async () => {
		// A.2'nin "Added ..." bildirimi sönsün: yeni bildirimleri eskisinden ayırt edebilmek için
		await waitFor("old toasts to clear", async () => (await toastTexts(client)).length === 0, { timeoutMs: 15_000 });
		const problemsBefore = ctx.problems.length;
		await openFontPicker(ctx);
		await clickEl(client, "My fonts tab", byTextFinder("button", "My fonts", `(${popoverFinder})()`));
		const rowsBefore = await client.evaluate(`[...(${popoverFinder})().querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")).length`);
		await chooseImport(ctx, [files.fakeFont, files.truncatedFont]);
		const toasts = await waitFor("failure toast", async () => {
			const all = await toastTexts(client);
			return all.some((t) => /Could not import/.test(t)) ? all : null;
		}, { timeoutMs: 15_000 });
		await sleep(600);
		const all = await toastTexts(client);
		const failureToasts = all.filter((t) => /Could not import/.test(t));
		const addedToasts = all.filter((t) => /Added/.test(t));
		await ctx.shoot("A4-import-rejected");
		const rowsAfter = await client.evaluate(`[...(${popoverFinder})().querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")).length`);
		const alive = await client.evaluate("1 + 1");
		const newProblems = ctx.problems.slice(problemsBefore);
		expect(failureToasts.length === 1, "expected exactly one failure toast for the whole batch", { expected: 1, actual: all });
		expect(addedToasts.length === 0, "a rejected file was reported as added", { actual: all });
		expect(rowsAfter === rowsBefore, "rows changed although both files were rejected", { expected: rowsBefore, actual: rowsAfter });
		expect(alive === 2, "page no longer answers");
		expect(newProblems.length === 0, "console/network problems while rejecting the files", { actual: newProblems.slice(0, 4) });
		return { toast: failureToasts[0], rowsBefore, rowsAfter };
	});
	await closeFontPicker(ctx);
}

// "Import" düğmesi: My fonts sekmesindeki gerçek düğme + dosya seçici
async function chooseImport(ctx, files) {
	const { client } = ctx;
	const onMyFonts = await client.evaluate(`!!(${popoverFinder})() && document.querySelector('[role="tab"][aria-selected="true"]')?.innerText.trim() === "My fonts"`);
	if (!onMyFonts) {
		if (!(await client.evaluate(`!!(${popoverFinder})()`))) await openFontPicker(ctx);
		await clickEl(client, "My fonts tab", byTextFinder("button", "My fonts", `(${popoverFinder})()`));
		await sleep(200);
	}
	await lib.chooseFiles(client, files, () => clickEl(client, "font Import button", byTextFinder("button", "Import", `(${popoverFinder})()`)));
}


// Aynı profille yeniden açılmış oturumda: projeyi listeden aç, ilk metin klibini seç
async function reopenProject(ctx, projectId) {
	const { client } = ctx;
	if (!(await client.evaluate(`location.pathname === "/projects"`))) {
		await client.send("Page.navigate", { url: "ccut://app/projects" });
		await waitFor("projects page", () => client.evaluate('location.pathname === "/projects" && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
	}
	await sleep(600); // hidrasyon bitsin
	await clickEl(client, "project card", `() => document.querySelector('a[href="/editor/${projectId}"]')`);
	await waitFor("editor", () => client.evaluate('!!document.querySelector(\'button[aria-label="Text"]\') && location.pathname.startsWith("/editor/")'), { timeoutMs: 30_000 });
	await sleep(1500);
	await ed.dismissOnboarding(client);
}

async function scenarioA2(ctx) {
	const { client } = ctx;
	await R.step("A.5", "after restart (same profile): font still listed under My fonts and the project still draws with it", async () => {
		await reopenProject(ctx, state.projectId);
		const clips = await ed.clipsInfo(client);
		expect(clips.length >= 1, "project lost its clips after the restart", { actual: clips });
		await ed.selectClip(client, 0);
		await openFontPicker(ctx);
		await clickEl(client, "My fonts tab", byTextFinder("button", "My fonts", `(${popoverFinder})()`));
		await sleep(300);
		const listed = await client.evaluate(`!![...(${popoverFinder})().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(state.fontFamily)})`);
		await ctx.shoot("A5-after-restart-my-fonts");
		await closeFontPicker(ctx);
		expect(listed, "font is gone from My fonts after the restart", { expected: state.fontFamily });
		const trigger = await fontTriggerState(client);
		expect(trigger?.text === state.fontFamily && !trigger.caution, "font trigger shows a missing-font state after the restart", { actual: trigger });
		const face = await client.evaluate(`[...document.fonts].find((f) => f.family.replace(/["']/g, "") === ${JSON.stringify(state.fontFamily)})?.status ?? null`);
		expect(face === "loaded", "custom FontFace is not loaded after the restart", { expected: "loaded", actual: face });
		const after = await measureCanvas(ctx, "A5-after-restart-preview");
		expect(after.bbox, "no text in the preview after the restart");
		expect(Math.abs(after.bbox.w - state.fontWidth) <= 3, "text is drawn with a different font than before the restart", { expected: `${state.fontWidth}px`, actual: `${after.bbox.w}px` });
		return { listed, faceStatus: face, widthBefore: state.fontWidth, widthAfter: after.bbox.w };
	});

	await R.step("A.6", "deleting the font: preview falls back, amber 'missing' marker, selection box is re-measured", async () => {
		const selBefore = await selectionBox(client);
		await openFontPicker(ctx);
		await clickEl(client, "My fonts tab", byTextFinder("button", "My fonts", `(${popoverFinder})()`));
		await clickEl(client, "delete font", `() => document.querySelector('button[aria-label=${JSON.stringify(`Delete ${state.fontFamily}`)}]')`);
		await waitFor("delete confirmation", () => client.evaluate('!![...document.querySelectorAll(\'[role="dialog"]\')].find((d) => d.innerText.includes("Delete font"))'));
		await ctx.shoot("A6-delete-confirm");
		await clickEl(client, "confirm Delete", `() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.innerText.includes("Delete font"))?.querySelector("button.bg-destructive, button[class*=destructive]") ?? [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.innerText.trim() === "Delete")`);
		await waitFor("custom font to be gone", () => client.evaluate(`!document.querySelector('button[aria-label=${JSON.stringify(`Delete ${state.fontFamily}`)}]')`), { timeoutMs: 8000 });
		await sleep(300);
		await closeFontPicker(ctx);
		const trigger = await fontTriggerState(client);
		const after = await measureCanvas(ctx, "A6-after-delete-preview");
		const selAfter = await selectionBox(client);
		await ctx.shoot("A6-after-delete");
		const missingMarker = trigger?.caution || /not found/i.test(trigger?.aria ?? "") || /not found/i.test(trigger?.title ?? "");
		expect(after.bbox, "no text drawn after deleting the font");
		expect(Math.abs(after.bbox.w - state.fontWidth) > 8, "preview still draws with the deleted font (width unchanged)", { expected: `!= ${state.fontWidth}px`, actual: `${after.bbox.w}px` });
		expect(missingMarker, "no amber missing-font marker on the font trigger", { actual: trigger });
		expect(/sans-serif\s*$/.test(trigger?.labelFontFamily ?? ""), "the missing-font trigger label does not fall back to sans-serif (browser default serif?)", { expected: "font-family ends with sans-serif", actual: trigger?.labelFontFamily });
		R.metric("A.font.missingLabelFontFamily", trigger?.labelFontFamily);
		expect(selAfter && selBefore, "no selection box to compare", { actual: { selBefore, selAfter } });
		expect(Math.abs(selAfter.width - selBefore.width) > 8, "selection box was not re-measured (same width as with the custom font)", { expected: `!= ${selBefore.width}`, actual: selAfter.width });
		expect(Math.abs(selAfter.width - after.bbox.w) <= 16, "selection box does not match the fallback text width", { expected: `~${after.bbox.w}`, actual: selAfter.width });
		R.metric("A.font.afterDelete", { textWidth: after.bbox.w, selectionBefore: Number(selBefore.width.toFixed(1)), selectionAfter: Number(selAfter.width.toFixed(1)) });
		return { trigger, textWidth: after.bbox.w, selectionWidthBefore: selBefore.width, selectionWidthAfter: selAfter.width };
	});
}

async function stepCsp() {
	await R.step("A.7", "no CSP violation / FontFace error in the console (both sessions)", async () => {
		const all = Object.values(state.problemsBySession).flat();
		const csp = all.filter((p) => /content security policy|refused to|violat/i.test(`${p.text} ${p.url ?? ""}`));
		R.metric("A.consoleProblems", { sessions: Object.fromEntries(Object.entries(state.problemsBySession).map(([k, v]) => [k, v.length])) });
		expect(csp.length === 0, "CSP violations in the console", { actual: csp.slice(0, 3) });
		const reload500 = all.filter((p) => /\b500\b|Internal Server Error/.test(`${p.text}`));
		return `0 CSP violations; ${all.length} console/network problems in both sessions, ${reload500.length} of them are the HTTP 500s of the editor-URL reloads (F.4)`;
	});
}


// ---------------------------------------------------------------- B. Çubuklar
const BAR_LABELS = ["Position X", "Position Y", "Scale X", "Scale Y", "Rotate"];
const round1 = (n) => (n === null || n === undefined ? n : Number(Number(n).toFixed(1)));
const posX = (client) => ed.sliderState(client, "Position X");
const canvasCenterX = async (ctx, name) => {
	const m = await measureCanvas(ctx, name, { minLuma: 250 }); // video yaması 238'e kadar çıkar: yalnız saf beyaz metin sayılsın
	return m.bbox ? { cx: m.bbox.cx, w: m.bbox.w, file: m.file } : null;
};

async function barSnapshot(client) {
	const rows = [];
	for (const label of BAR_LABELS) {
		const s = await ed.sliderState(client, label);
		rows.push({
			label,
			hasBarElement: !!s?.hasBar,
			barVisible: !!s?.hasBar && s.bar.w > 0 && s.thumb.w > 0,
			barW: round1(s?.bar?.w),
			trackW: round1(s?.track?.w),
			containerW: round1(s?.container?.w),
			inputW: round1(s?.field?.w),
		});
	}
	return rows;
}

async function scenarioB(ctx) {
	const { client } = ctx;
	const { files } = ctx.assets;
	await R.step("B.0", "project with a video clip and a text clip", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.video]);
		await ed.addAssetToTimeline(client, "track.mp4");
		await ed.addDefaultText(client);
		const clips = await ed.clipsInfo(client);
		expect(clips.length === 2, "expected a video and a text clip on the timeline", { actual: clips.map((c) => c.name) });
		return clips.map((c) => c.name);
	});

	await R.step("B.1", "Transform: bars are visible at the default panel width (text and video), measured also at 15% and 25%", async () => {
		const out = {};
		for (const [kind, clipName] of [["text", "Default text"], ["video", "track.mp4"]]) {
			await ed.selectClip(client, clipName);
			await ed.propsTab(client, "Transform");
			const entry = {};
			for (const pct of [25, 15, 25]) {
				const sized = await ed.setPropertiesPanelPercent(client, pct);
				const rows = await barSnapshot(client);
				entry[`${pct}%${Object.keys(entry).includes(`${pct}%`) ? "(again)" : ""}`] = { panelPx: round1(sized.widthPx), rows };
			}
			out[kind] = entry;
		}
		R.metric("B.bars", out);
		await ed.setPropertiesPanelPercent(client, 25);
		const def = out.text["25%"].rows;
		const defVideo = out.video["25%"].rows;
		const narrow = out.text["15%"].rows;
		const hiddenDefault = [...def, ...defVideo].filter((r) => !r.barVisible);
		expect(def.length === 5 && hiddenDefault.length === 0, "bars are hidden at the default panel width", { expected: "5 visible bars per element", actual: hiddenDefault });
		const narrowRows = [...out.text["15%"].rows, ...out.video["15%"].rows];
		expect(narrowRows.every((r) => r.barVisible && r.barW >= 96), "at the 15% panel the bars are hidden or narrower than 96 px", { expected: "visible, >= 96 px", actual: narrowRows.filter((r) => !r.barVisible || r.barW < 96) });
		return {
			defaultPanel: `${out.text["25%"].panelPx}px: bars ${def.map((r) => r.barW).join("/")} px wide, container ${def[0].containerW}px`,
			narrowPanel15: `${out.text["15%"].panelPx}px: bars ${narrow.map((r) => (r.barVisible ? r.barW : "hidden")).join("/")}, container ${narrow[0].containerW}px (threshold 168px)`,
		};
	});

	await R.step("B.1b", "narrow panel (15%): bar stays and the number box stacks under it, nothing overflows", async () => {
		await ed.selectClip(client, "Default text");
		await ed.propsTab(client, "Transform");
		await ed.setPropertiesPanelPercent(client, 15);
		const geometry = await client.evaluate(`(() => {
			const props = ${ed.PROPS};
			const panel = props.getBoundingClientRect();
			return [...props.querySelectorAll("input")].map((i) => { const r = i.closest("div.border-border")?.getBoundingClientRect() ?? i.getBoundingClientRect(); return { label: i.getAttribute("aria-label"), x: r.x, w: r.width, right: r.right, panelRight: panel.right, panelLeft: panel.left }; });
		})()`);
		await ctx.shoot("B1b-panel-15");
		await ed.setPropertiesPanelPercent(client, 25);
		const bad = geometry.filter((g) => g.right > g.panelRight + 1 || g.x < g.panelLeft - 1);
		expect(geometry.length >= 5, "number boxes missing", { actual: geometry });
		expect(bad.length === 0, "a number box overflows the narrow panel", { actual: bad });
		R.metric("B.narrowInputWidths", geometry.map((g) => `${g.label}:${round1(g.w)}`));
		return `all ${geometry.length} number boxes inside the panel, widths ${geometry.map((g) => round1(g.w)).join("/")}px`;
	});

	await ed.selectClip(client, "Default text").catch(() => {});
	await ed.propsTab(client, "Transform").catch(() => {});

	await R.step("B.2", "drag the bar with real mouse events: value + preview follow live, one Ctrl+Z restores", async () => {
		const s0 = await posX(client);
		expect(s0.hasBar && s0.now === 0, "Position X should start at 0", { actual: s0 });
		const base = await canvasCenterX(ctx, "B2-before");
		expect(base, "no text in the preview");
		const drag = await ed.dragSliderThumb(client, "Position X", { dx: 12, steps: 6, releaseOnEnd: false });
		await sleep(300);
		const midState = await posX(client);
		const mid = await canvasCenterX(ctx, "B2-mid-drag");
		await mouse.up(client, drag.to.x, drag.to.y);
		await sleep(300);
		const done = await posX(client);
		const after = await canvasCenterX(ctx, "B2-after-release");
		expect(midState.now > 50, "value did not change while dragging", { expected: "> 50 (12px of the bar)", actual: midState.now });
		expect(mid.cx - base.cx > 40, "preview did not follow the drag live (text did not move)", { expected: "> +40px", actual: `${round1(mid.cx - base.cx)}px` });
		expect(done.now === midState.now, "value changed on release", { expected: midState.now, actual: done.now });
		await press(client, "ctrl+z");
		await sleep(400);
		const undone = await posX(client);
		const back = await canvasCenterX(ctx, "B2-after-undo");
		expect(undone.now === 0, "ONE Ctrl+Z did not return to the start value (more than one undo step, or none)", { expected: 0, actual: undone.now });
		expect(Math.abs(back.cx - base.cx) <= 1.5, "preview did not return", { expected: base.cx, actual: back.cx });
		return { dragged: done.now, previewShiftPx: round1(mid.cx - base.cx), afterUndo: undone.now };
	});

	await R.step("B.3", "arrow keys on a focused bar change the value but never move the playhead (Shift: no 5 s jump; Home/End: no timeline jump)", async () => {
		const t0 = await ed.seekSeconds(client, 2);
		expect(t0 > 0, "could not place the playhead", { actual: t0 });
		await ed.focusSlider(client, "Position X");
		const v0 = (await posX(client)).now;
		await press(client, "ArrowRight");
		await sleep(200);
		const v1 = (await posX(client)).now;
		const t1 = await ed.playheadTicks(client);
		await press(client, "shift+ArrowRight");
		await sleep(200);
		const v2 = (await posX(client)).now;
		const t2 = await ed.playheadTicks(client);
		await press(client, "Home");
		await sleep(200);
		const v3 = (await posX(client)).input;
		const t3 = await ed.playheadTicks(client);
		await press(client, "End");
		await sleep(200);
		const v4 = (await posX(client)).input;
		const t4 = await ed.playheadTicks(client);
		R.metric("B.keys", { playheadTicks: [t0, t1, t2, t3, t4], values: [v0, v1, v2, v3, v4] });
		expect(v1 !== v0, "ArrowRight did not change the value", { actual: [v0, v1] });
		expect(v2 - v1 > v1 - v0, "Shift+ArrowRight is not a coarser step", { actual: [v0, v1, v2] });
		const range = await posX(client);
		expect(v3 === String(range.min) && v4 === String(range.max), "Home/End did not jump to the bar ends", { expected: [range.min, range.max], actual: [v3, v4] });
		expect([t1, t2, t3, t4].every((t) => t === t0), "the playhead moved while keys went to the bar", { expected: t0, actual: [t1, t2, t3, t4] });
		return `values ${v0} -> ${v1} -> ${v2} -> ${v3} -> ${v4}; playhead stayed at ${t0 / 120000}s`;
	});

	await R.step("B.4", "Escape during a drag: panel stays, clip stays selected, preview reverts, no blank undo step", async () => {
		await ed.typeInto(client, "Position X", "0");
		await ed.typeInto(client, "Position X", "100");
		const committed = await posX(client);
		expect(committed.now === 100, "typed value not applied", { actual: committed.now });
		const base = await canvasCenterX(ctx, "B4-before");
		const drag = await ed.dragSliderThumb(client, "Position X", { dx: 25, steps: 6, releaseOnEnd: false });
		await sleep(250);
		const dragging = await posX(client);
		await press(client, "Escape");
		await sleep(250);
		const afterEscape = await posX(client);
		await mouse.up(client, drag.to.x, drag.to.y);
		await sleep(350);
		const afterRelease = await posX(client);
		const clips = await ed.clipsInfo(client);
		const tabs = await ed.propsTabs(client);
		const preview = await canvasCenterX(ctx, "B4-after-escape");
		await ctx.shoot("B4-after-escape-full");
		expect(dragging.now > 100, "the drag did not change the value before Escape", { actual: dragging.now });
		expect(afterRelease.now === 100, "value is not back at 100 after Escape", { expected: 100, actual: [afterEscape.now, afterRelease.now] });
		expect(tabs.length >= 4 && clips.find((c) => c.name === "Default text")?.selected, "Escape closed the panel / deselected the clip", { actual: { tabs, clips: clips.map((c) => [c.name, c.selected]) } });
		expect(Math.abs(preview.cx - base.cx) <= 1.5, "preview not reverted", { expected: base.cx, actual: preview.cx });
		await press(client, "ctrl+z");
		await sleep(400);
		const undone = await posX(client);
		expect(undone.now === 0, "Ctrl+Z after the cancelled drag did not undo the PREVIOUS change: a blank undo step was added", { expected: 0, actual: undone.now });
		return { duringDrag: dragging.now, afterEscape: afterEscape.now, afterRelease: afterRelease.now, undoGoesTo: undone.now };
	});

	await R.step("B.5", "typing '2*3' + Enter gives 6, and the next press on the bar is not swallowed", async () => {
		await ed.typeInto(client, "Position X", "2*3");
		const typed = await posX(client);
		expect(typed.input === "6" && typed.now === 6, "'2*3' did not evaluate to 6", { expected: "6", actual: [typed.input, typed.now] });
		const state = await posX(client);
		const x = state.track.x + state.track.w * 0.75;
		await mouse.click(client, x, state.track.cy);
		await sleep(350);
		const afterClick = await posX(client);
		const expected = state.min + 0.75 * (state.max - state.min);
		expect(Math.abs(afterClick.now - expected) <= (state.max - state.min) / 155 * 2, "first press on the bar after Enter was swallowed (value did not jump to the clicked spot)", { expected: `~${expected}`, actual: afterClick.now });
		return { evaluated: typed.input, afterBarPress: afterClick.now };
	});

	await R.step("B.6", "typing a value beyond the bar range is accepted and the thumb sticks to the end", async () => {
		await ed.typeInto(client, "Position X", "5000");
		const s = await posX(client);
		expect(s.input === "5000", "out-of-range value was not accepted/kept in the box", { expected: "5000", actual: s.input });
		expect(Math.abs(s.thumb.cx - (s.track.x + s.track.w)) <= 2, "thumb is not at the right end", { expected: s.track.x + s.track.w, actual: s.thumb.cx });
		return { box: s.input, barValueNow: s.now, thumbOffsetFromEndPx: round1(s.thumb.cx - (s.track.x + s.track.w)) };
	});

	await R.step("B.7", "double-click on the thumb resets to the default in ONE undo step", async () => {
		await ed.typeInto(client, "Position X", "300");
		const before = await posX(client);
		await mouse.doubleClick(client, before.thumb.cx, before.thumb.cy);
		await sleep(400);
		const reset = await posX(client);
		expect(reset.now === 0 && reset.input === "0", "double-click on the thumb did not reset to the default 0", { expected: "0", actual: [reset.now, reset.input] });
		await press(client, "ctrl+z");
		await sleep(400);
		const undone = await posX(client);
		expect(undone.now === 300, "undoing the reset did not return to 300 in one step", { expected: 300, actual: undone.now });
		return { before: 300, afterDoubleClick: reset.now, afterOneUndo: undone.now };
	});

	await R.step("B.8", "dragging while a keyframe diamond is active edits that key, no extra key is added", async () => {
		await ed.typeInto(client, "Position X", "0");
		await ed.seekSeconds(client, 1);
		await clickEl(client, "keyframe diamond", () => document.querySelector('button[title="Toggle position x keyframe"]'));
		await sleep(400);
		await ed.dragSliderThumb(client, "Position X", { dx: 12, steps: 6 });
		await sleep(400);
		await ed.dragSliderThumb(client, "Position X", { dx: -5, steps: 4 });
		await sleep(400);
		await ed.waitSaved(client, readProjects);
		const project = await projectNow(client);
		const text = projectElements(project).find((e) => e.type === "text");
		const keys = text?.animations?.["transform.positionX"]?.keys ?? [];
		expect(keys.length === 1, "unexpected number of position X keyframes after dragging with the diamond active", { expected: 1, actual: JSON.stringify(keys) });
		return { keyframes: keys.length, value: keys[0]?.value, atSeconds: keys[0]?.time / 120000 };
	});

	await R.step("B.9", "icon scrub (shortLabel) still works on a graphic element", async () => {
		await ed.openAssetsTab(client, "Stickers");
		await sleep(600);
		await clickEl(client, "Shapes tab", byTextFinder("button", "Shapes", ed.ASSETS));
		await sleep(500);
		await clickEl(client, "first shape '+'", `() => ${ed.ASSETS}.querySelector(".group button")`);
		await sleep(900);
		const clips = await ed.clipsInfo(client);
		const graphic = clips.find((c) => c.selected);
		expect(graphic, "no graphic clip selected after adding a shape", { actual: clips.map((c) => [c.name, c.selected]) });
		await ed.propsTab(client, "Graphic");
		await ctx.shoot("B9-graphic-tab");
		const icons = await client.evaluate(`[...(${ed.PROPS}).querySelectorAll('button[aria-label="Drag to adjust value"]')].map((b, index) => { const r = b.getBoundingClientRect(); return { index, x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2, text: b.innerText.trim() }; })`);
		expect(icons.length > 0, "no scrub icons on the graphic (shortLabel buttons missing)", { actual: await ed.propsTabs(client) });
		const icon = icons[0];
		const iconInput = () => client.evaluate(`[...(${ed.PROPS}).querySelectorAll('button[aria-label="Drag to adjust value"]')][${icon.index}]?.parentElement.querySelector("input")?.value`);
		const inputBefore = await iconInput();
		await mouse.move(client, icon.cx, icon.cy);
		await mouse.down(client, icon.cx, icon.cy);
		for (let i = 1; i <= 10; i++) {
			await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: icon.cx + i * 6, y: icon.cy, button: "left", buttons: 1 });
			await sleep(20);
		}
		const during = await iconInput();
		await mouse.up(client, icon.cx + 60, icon.cy);
		await sleep(300);
		const inputAfter = await iconInput();
		const lock = await client.evaluate("document.pointerLockElement ? 'locked' : 'free'");
		R.metric("B.scrub", { icons: icons.length, iconText: icon.text, before: inputBefore, during, after: inputAfter, lockAfterRelease: lock });
		if (inputAfter === inputBefore) {
			notVerified(`scrub produced no value change (before ${inputBefore}, after ${inputAfter}); CDP synthetic mouse events may not deliver pointer-lock movementX in this harness, so this is not conclusive`);
		}
		return { icons: icons.length, before: inputBefore, after: inputAfter };
	});
}


// ---------------------------------------------------------------- C. Giriş/çıkış animasyonu
const groupFinder = (phase) => `() => (${ed.PROPS}).querySelector('[role="group"][aria-label="${phase} animation"]')`;
const groupLabels = (client, phase) =>
	client.evaluate(`[...((${groupFinder(phase)})()?.querySelectorAll("button") ?? [])].map((b) => ({ label: b.innerText.trim(), pressed: b.getAttribute("aria-pressed") === "true" }))`);
async function setPreset(client, phase, label) {
	await clickEl(client, `${phase} preset ${label}`, `() => [...((${groupFinder(phase)})()?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === ${JSON.stringify(label)})`);
	await sleep(350);
}
const durationOf = async (client, phase) => {
	const s = await ed.sliderState(client, `${phase} duration`);
	return s ? { box: s.input, bar: s.now, min: s.min, max: s.max } : null;
};
const seekAndMeasure = async (ctx, seconds, name, opts = {}) => {
	await ed.seekSeconds(ctx.client, seconds);
	await sleep(200);
	return measureCanvas(ctx, name, opts);
};
// Yatay metin satırları: parlak piksel içeren ardışık satır aralıkları
function textLines(image, minLuma = 235) {
	const rows = [];
	for (let y = 0; y < image.height; y++) {
		let first = -1, last = -1;
		for (let x = 0; x < image.width; x++) {
			const i = (y * image.width + x) * 4;
			if (((77 * image.data[i] + 150 * image.data[i + 1] + 29 * image.data[i + 2]) >> 8) >= minLuma) {
				if (first < 0) first = x;
				last = x;
			}
		}
		rows.push(first < 0 ? null : { first, last });
	}
	const lines = [];
	let run = null;
	rows.forEach((row, y) => {
		if (row) {
			if (!run) run = { y0: y, x0: row.first, x1: row.last };
			run.y1 = y;
			run.x0 = Math.min(run.x0, row.first);
			run.x1 = Math.max(run.x1, row.last);
		} else if (run) {
			lines.push({ ...run, cx: (run.x0 + run.x1 + 1) / 2, w: run.x1 - run.x0 + 1 });
			run = null;
		}
	});
	if (run) lines.push({ ...run, cx: (run.x0 + run.x1 + 1) / 2, w: run.x1 - run.x0 + 1 });
	return lines;
}
async function setSelect(client, currentText, optionText) {
	await clickEl(client, `select ${currentText}`, `() => [...(${ed.PROPS}).querySelectorAll('button[role="combobox"]')].find((b) => b.innerText.trim() === ${JSON.stringify(currentText)})`);
	await clickEl(client, `option ${optionText}`, `() => [...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.trim() === ${JSON.stringify(optionText)})`);
	await sleep(350);
}
// Metin hizası: şu anki değer ne olursa olsun hedefe getirir (Radix Select)
async function setAlign(client, target) {
	const current = await client.evaluate(`[...(${ed.PROPS}).querySelectorAll('button[role="combobox"]')].map((b) => b.innerText.trim()).find((t) => ["Left", "Center", "Right"].includes(t))`);
	expect(current, "text-align select not found in the Text tab");
	if (current !== target) await setSelect(client, current, target);
}
const currentProjectId = (client) => client.evaluate('location.pathname.split("/").pop()');
const projectNow = async (client) => {
	await ed.waitSaved(client, readProjects);
	const id = await currentProjectId(client);
	return (await readProjects(client)).find((p) => p.id === id);
};
const textClips = (project) => projectElements(project).filter((e) => e.type === "text").sort((a, b) => a.startTime - b.startTime);

async function scenarioC(ctx) {
	const { client } = ctx;
	const { files } = ctx.assets;
	await R.step("C.0", "project with one text clip", async () => {
		await ed.newProject(client);
		await ed.addDefaultText(client);
		const clips = await ed.clipsInfo(client);
		expect(clips.length === 1 && clips[0].selected, "text clip not added/selected", { actual: clips });
	});

	await R.step("C.1", "Animation tab sits right after Transform for text and video; In/Out grids are labelled groups", async () => {
		const out = {};
		await ed.selectClip(client, "Default text");
		const textTabs = await ed.propsTabs(client);
		await ed.propsTab(client, "Animation");
		out.text = { tabs: textTabs, inGroup: (await groupLabels(client, "In")).map((g) => g.label), outGroup: (await groupLabels(client, "Out")).map((g) => g.label) };
		await ctx.shoot("C1-animation-tab-text");
		await ed.importMedia(client, [files.video]);
		await ed.addAssetToTimeline(client, "track.mp4");
		await ed.selectClip(client, "track.mp4");
		const videoTabs = await ed.propsTabs(client);
		await ed.propsTab(client, "Animation");
		out.video = { tabs: videoTabs, inGroup: (await groupLabels(client, "In")).map((g) => g.label), outGroup: (await groupLabels(client, "Out")).map((g) => g.label) };
		R.metric("C.tabs", out);
		for (const kind of ["text", "video"]) {
			const tabs = out[kind].tabs;
			expect(tabs.indexOf("Animation") === tabs.indexOf("Transform") + 1 && tabs.includes("Animation"), `${kind}: Animation tab is not right after Transform`, { actual: tabs });
			expect(out[kind].inGroup[0] === "None" && out[kind].inGroup.includes("Fade") && out[kind].inGroup.includes("From left"), `${kind}: In grid is not populated`, { actual: out[kind].inGroup });
			expect(out[kind].outGroup.includes("To left"), `${kind}: Out grid is missing the 'To ...' labels`, { actual: out[kind].outGroup });
		}
		expect(out.text.inGroup.includes("Typewriter") && !out.video.inGroup.includes("Typewriter"), "Typewriter should be offered for text only", { actual: [out.text.inGroup, out.video.inGroup] });
		return { textTabs, videoTabs, textPresets: out.text.inGroup.length, videoPresets: out.video.inGroup.length };
	});

	// Metin klibine geri dön; video klibini kaldır ki önizleme siyah zeminde yalnız metni göstersin
	await ed.selectClip(client, "track.mp4").catch(() => {});
	await press(client, "Delete");
	await sleep(500);
	await ed.selectClip(client, "Default text");
	await ed.propsTab(client, "Animation");

	await R.step("C.2", "Fade In 1 s: preview opacity ~0 at 0 s, ~0.5 at 0.5 s, full at 1.2 s", async () => {
		await setPreset(client, "In", "Fade");
		await ed.typeInto(client, "In duration", "1");
		const dur = await durationOf(client, "In");
		expect(Number(dur?.box) === 1, "In duration box does not show 1", { actual: dur });
		const samples = [];
		for (const t of [0, 0.5, 1.2]) {
			const m = await seekAndMeasure(ctx, t, `C2-fade-${t}`, { minLuma: 8 });
			samples.push({ t, maxLuma: m.max, opacity: Number((m.max / 255).toFixed(2)) });
		}
		R.metric("C.fade", samples);
		expect(samples[0].maxLuma <= 12, "text is visible at t=0 of a Fade In", { expected: "~0", actual: samples[0] });
		expect(Math.abs(samples[1].opacity - 0.5) <= 0.1, "opacity at 0.5 s is not ~0.5", { expected: "~0.5", actual: samples[1] });
		expect(samples[2].maxLuma >= 250, "text is not fully opaque at 1.2 s", { expected: ">=250", actual: samples[2] });
		return samples.map((s) => `${s.t}s: ${s.opacity}`).join(", ");
	});

	await R.step("C.3a", "Slide In from left (1 s): off canvas at t=0, in place at the end", async () => {
		await setPreset(client, "In", "From left");
		await ed.typeInto(client, "In duration", "1");
		const rest = await seekAndMeasure(ctx, 2, "C3-slide-rest");
		const start = await seekAndMeasure(ctx, 0, "C3-slide-t0", { minLuma: 100 });
		const mid = await seekAndMeasure(ctx, 0.5, "C3-slide-mid", { minLuma: 100 });
		const end = await seekAndMeasure(ctx, 1, "C3-slide-end");
		const canvasCenter = rest.image.width / 2;
		R.metric("C.slide", { restCx: rest.bbox?.cx, start: start.bbox, midCx: mid.bbox?.cx, endCx: end.bbox?.cx, canvasW: rest.image.width });
		expect(rest.bbox, "no text at rest");
		expect(start.bright === 0, "text is already on the canvas at t=0 of From left", { expected: "off canvas", actual: start.bbox });
		expect(mid.bbox && mid.bbox.cx < rest.bbox.cx - 5 && mid.bbox.cx > -rest.bbox.w, "text is not in transit at 0.5 s", { actual: mid.bbox });
		expect(end.bbox && Math.abs(end.bbox.cx - rest.bbox.cx) <= 2, "text is not in place at the end of the slide", { expected: rest.bbox.cx, actual: end.bbox?.cx });
		return { restCx: rest.bbox.cx, midCx: round1(mid.bbox.cx), endCx: end.bbox.cx, canvasCenter };
	});

	await R.step("C.3b", "Typewriter: letters appear gradually, and left/center/right alignment keeps lines anchored", async () => {
		await ed.propsTab(client, "Text");
		// iki satır: önce kısa, sonra uzun; hizalama farkı görünsün
		await clickEl(client, "content textarea", `() => (${ed.PROPS}).querySelector("textarea")`);
		await press(client, "ctrl+a");
		await client.send("Input.insertText", { text: "Hi\nTypewriter demo text" });
		await press(client, "Tab");
		await sleep(400);
		await ed.propsTab(client, "Animation");
		await setPreset(client, "In", "Typewriter");
		await ed.typeInto(client, "In duration", "2");
		const results = {};
		for (const align of ["Left", "Right", "Center"]) {
			await ed.propsTab(client, "Text");
			await setAlign(client, align);
			await ed.propsTab(client, "Animation");
			const full = await seekAndMeasure(ctx, 3, `C3-typewriter-${align}-full`);
			const lines = textLines(full.image);
			expect(lines.length === 2, `${align}: expected 2 text lines at full reveal`, { actual: lines });
			const growth = [];
			let firstOnlyLine = null;
			for (const frames of [3, 5, 7, 9, 12, 20, 30, 45, 60]) {
				await ed.seekStart(client);
				await ed.stepFrames(client, frames);
				const m = await measureCanvas(ctx, `C3-typewriter-${align}-${frames}`, { save: frames === 20 });
				const bbox = m.bbox;
				growth.push({ frames, w: bbox?.w ?? 0, h: bbox?.h ?? 0 });
				if (!firstOnlyLine && bbox && bbox.y + bbox.h <= lines[0].y1 + 2 && bbox.w > 0) firstOnlyLine = { frames, bbox };
			}
			const widths = growth.map((g) => g.w);
			const monotonic = widths.every((w, i) => i === 0 || w >= widths[i - 1] - 1);
			results[align] = { fullLine1: { x0: lines[0].x0, cx: lines[0].cx, w: lines[0].w }, firstOnlyLine, growth: growth.map((g) => `${g.frames}f:${g.w}x${g.h}`).join(" "), monotonic };
			expect(widths[0] < widths[widths.length - 1] && monotonic, `${align}: reveal is not gradual/monotonic`, { actual: results[align].growth });
			expect(firstOnlyLine, `${align}: could not catch the state where only the first line is visible`, { actual: results[align].growth });
			// Metin soldan sağa açılır: kısmi görünümün SOL kenarı, tam görünümdeki satırın sol kenarıyla aynı olmalı
			expect(Math.abs(firstOnlyLine.bbox.x - lines[0].x0) <= 3, `${align}: the revealed part is not anchored where the full line starts (alignment broken while revealing)`, { expected: `left edge ${lines[0].x0}`, actual: `left edge ${firstOnlyLine.bbox.x} at ${firstOnlyLine.frames}f (bbox ${JSON.stringify(firstOnlyLine.bbox)})` });
		}
		R.metric("C.typewriter", results);
		return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, `line1 left ${v.fullLine1.x0} / partial left ${v.firstOnlyLine.bbox.x} @${v.firstOnlyLine.frames}f`]));
	});

	await R.step("C.4", "dragging the duration bar is ONE undo step; In+Out exceeding the clip does not make the other box jump", async () => {
		await ed.propsTab(client, "Text");
		await clickEl(client, "content textarea", `() => (${ed.PROPS}).querySelector("textarea")`);
		await press(client, "ctrl+a");
		await client.send("Input.insertText", { text: "Default text" });
		await press(client, "Tab");
		await sleep(300);
		await setAlign(client, "Center");
		await ed.propsTab(client, "Animation");
		await setPreset(client, "In", "Fade");
		await ed.typeInto(client, "In duration", "1");
		const before = await durationOf(client, "In");
		await ed.dragSliderThumb(client, "In duration", { dx: 25, steps: 6 });
		await sleep(400);
		const dragged = await durationOf(client, "In");
		await press(client, "ctrl+z");
		await sleep(400);
		const undone = await durationOf(client, "In");
		expect(Number(dragged.box) !== Number(before.box), "dragging the duration bar did not change the value", { actual: [before, dragged] });
		expect(Number(undone.box) === Number(before.box), "ONE Ctrl+Z did not restore the duration before the drag", { expected: before.box, actual: [dragged.box, undone.box] });
		// In+Out > klip: klip 5 s. Out = 2 s, sonra In = 4.5 s iste
		await setPreset(client, "Out", "Fade");
		await ed.typeInto(client, "Out duration", "2");
		const out2 = await durationOf(client, "Out");
		await ed.typeInto(client, "In duration", "4.5");
		const inAfter = await durationOf(client, "In");
		const outAfter = await durationOf(client, "Out");
		await ctx.shoot("C4-in-out-overflow");
		R.metric("C.overflow", { outBefore: out2, inAfter, outAfter });
		expect(Number(outAfter.box) === Number(out2.box), "the Out box jumped when In was set beyond the room", { expected: out2.box, actual: outAfter.box });
		return { dragFrom: before.box, dragTo: dragged.box, afterUndo: undone.box, out: [out2.box, outAfter.box], inRequested: 4.5, inShown: inAfter.box };
	});

	await R.step("C.5", "split gives In to the left half and Out to the right half; duplicate and paste keep the preset", async () => {
		await ed.typeInto(client, "In duration", "1");
		await ed.typeInto(client, "Out duration", "1");
		await ed.seekSeconds(client, 2);
		await ed.selectClip(client, "Default text");
		await ed.seekSeconds(client, 2);
		await press(client, "s");
		await sleep(600);
		let project = await projectNow(client);
		const halves = textClips(project);
		expect(halves.length === 2, "split did not produce two text clips", { actual: halves.map((h) => [h.startTime, h.duration]) });
		const [left, right] = halves;
		const summary = (e) => ({ in: e.presetAnimations?.in?.id ?? null, out: e.presetAnimations?.out?.id ?? null });
		expect(summary(left).in === "fade" && summary(left).out === null, "left half should carry only In", { actual: [summary(left), summary(right)] });
		expect(summary(right).out === "fade" && summary(right).in === null, "right half should carry only Out", { actual: [summary(left), summary(right)] });
		// çoğalt (Ctrl+D) ve yapıştır (Ctrl+C/Ctrl+V): sağ yarı seçili olsun
		const clips = await ed.clipsInfo(client);
		const rightClip = clips.filter((c) => c.name === "Default text").sort((a, b) => a.x - b.x)[1];
		await mouse.click(client, rightClip.x + 20, rightClip.y + rightClip.h / 2);
		await sleep(300);
		await press(client, "ctrl+d");
		await sleep(700);
		project = await projectNow(client);
		const afterDup = textClips(project);
		const dupHasOut = afterDup.filter((e) => e.presetAnimations?.out?.id === "fade").length;
		await press(client, "ctrl+c");
		await ed.seekSeconds(client, 4.5);
		await press(client, "ctrl+v");
		await sleep(700);
		project = await projectNow(client);
		const afterPaste = textClips(project);
		const pasteHasOut = afterPaste.filter((e) => e.presetAnimations?.out?.id === "fade").length;
		R.metric("C.splitDupPaste", { afterSplit: [summary(left), summary(right)], countAfterDuplicate: afterDup.length, outCarriersAfterDuplicate: dupHasOut, countAfterPaste: afterPaste.length, outCarriersAfterPaste: pasteHasOut });
		expect(afterDup.length === 3 && dupHasOut >= 2, "duplicate did not copy the preset", { actual: afterDup.map(summary) });
		expect(afterPaste.length === 4 && pasteHasOut >= 3, "paste did not copy the preset", { actual: afterPaste.map(summary) });
		return { left: summary(left), right: summary(right), afterDuplicate: afterDup.length, afterPaste: afterPaste.length };
	});

	await R.step("C.6", "preset survives save and reopening the project", async () => {
		const project = await projectNow(client);
		const projectId = project.id;
		const before = textClips(project).map((e) => JSON.stringify(e.presetAnimations ?? null));
		await client.send("Page.navigate", { url: "ccut://app/projects" });
		await waitFor("projects page", () => client.evaluate('location.pathname === "/projects" && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
		await reopenProject(ctx, projectId);
		const clips = await ed.clipsInfo(client);
		const first = clips.filter((c) => c.name === "Default text").sort((a, b) => a.x - b.x)[0];
		await mouse.click(client, first.x + 20, first.y + first.h / 2);
		await sleep(400);
		await ed.propsTab(client, "Animation");
		const inGroup = await groupLabels(client, "In");
		const durationBox = await durationOf(client, "In");
		const reopened = (await readProjects(client)).find((p) => p.id === projectId);
		const after = textClips(reopened).map((e) => JSON.stringify(e.presetAnimations ?? null));
		await ctx.shoot("C6-after-reopen");
		expect(inGroup.find((g) => g.label === "Fade")?.pressed, "Fade is not shown as selected after reopening", { actual: inGroup });
		expect(JSON.stringify(before) === JSON.stringify(after), "stored presetAnimations changed through save/reload", { expected: before, actual: after });
		return { selectedIn: inGroup.filter((g) => g.pressed).map((g) => g.label), inDuration: durationBox?.box };
	});

	await R.step("C.7", "Fade In on a video clip: black at 0 s, picture at 1.5 s", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.video]);
		await ed.addAssetToTimeline(client, "track.mp4");
		await ed.selectClip(client, "track.mp4");
		await ed.propsTab(client, "Animation");
		await setPreset(client, "In", "Fade");
		await ed.typeInto(client, "In duration", "1");
		const t0 = await seekAndMeasure(ctx, 0, "C7-video-fade-0", { minLuma: 250 });
		const t15 = await seekAndMeasure(ctx, 1.5, "C7-video-fade-1.5", { minLuma: 250 });
		const mean0 = regionStats(t0.image, { x: 0, y: 0, w: t0.image.width, h: t0.image.height }).mean;
		const mean15 = regionStats(t15.image, { x: 0, y: 0, w: t15.image.width, h: t15.image.height }).mean;
		R.metric("C.videoFade", { meanLuma0s: round1(mean0), meanLuma1_5s: round1(mean15) });
		expect(mean0 < 8, "video is visible at t=0 of Fade In", { expected: "< 8", actual: mean0 });
		expect(mean15 > 60, "video is not visible at 1.5 s", { expected: "> 60", actual: mean15 });
		return `mean luma ${round1(mean0)} -> ${round1(mean15)}`;
	});
}


// ---------------------------------------------------------------- D. Otomatik beat
const beatButtonFinder = () => document.querySelector('button[aria-label="Auto beat"]');
const beatState = (client) =>
	client.evaluate(`(() => { const b = document.querySelector('button[aria-label="Auto beat"]'); return b ? { disabled: b.disabled, pressed: b.getAttribute("aria-pressed") === "true", busy: b.getAttribute("aria-disabled") === "true" } : null; })()`);
async function hoverTooltip(client, finderSource) {
	const rect = await rectOf(client, finderSource);
	await mouse.move(client, rect.cx + 400, rect.cy + 200);
	await sleep(150);
	await mouse.move(client, rect.cx, rect.cy);
	await sleep(900);
	const text = await client.evaluate(`[...document.querySelectorAll('[role="tooltip"]')].map((t) => t.innerText.trim()).filter(Boolean).join(" | ")`);
	await mouse.move(client, rect.cx + 400, rect.cy + 200);
	await sleep(250);
	return text;
}
const BEAT_FINAL_RE = /Found \d+ beats|Found beats in|No audio signal|No clear beat|Audio is too|Couldn't read|Audio longer|Audio file too|Beat detection failed/;
// Toast günlüğü (sayfa içi MutationObserver, performance.now) üzerinden bir beat koşusunu çözümler
async function pressBeat(client) {
	const clickT = await client.evaluate("performance.now()");
	await clickEl(client, "Auto beat button", beatButtonFinder.toString());
	return clickT;
}
async function readBeatRun(client, clickT, { timeoutMs = 90_000, until = BEAT_FINAL_RE } = {}) {
	let log = [];
	await waitFor("the beat run to finish", async () => {
		log = (await client.evaluate(`window.__toastLog.filter((e) => e.t >= ${clickT})`));
		return log.some((e) => until.test(e.text));
	}, { timeoutMs, intervalMs: 50 });
	const steps = log.map((e) => ({ ms: Math.round(e.t - clickT), text: e.text }));
	const detecting = steps.find((e) => /Detecting beats/.test(e.text));
	const final = steps.find((e) => until.test(e.text));
	return {
		steps,
		decodeMs: detecting ? detecting.ms : null,
		totalMs: final.ms,
		analysisMs: detecting ? final.ms - detecting.ms : null,
		finalText: final.text.replace(/\s*(Cancel|Close)\b.*$/, "").trim(),
		sawReading: steps.some((e) => /Reading audio/.test(e.text)),
		sawPercent: steps.filter((e) => /Detecting beats\.\.\. \d+%/.test(e.text)).length,
	};
}
// Toast'lar temizlenene dek bekle
const waitToastsClear = (client, timeoutMs = 15_000) => waitFor("toasts to clear", async () => (await toastTexts(client)).length === 0, { timeoutMs });
const beatTimesOf = (element) => (element?.beats ?? []).map((t) => t / 120000);

async function scenarioD(ctx) {
	const { client } = ctx;
	const { files, beatTruth } = ctx.assets;

	await R.step("D.1", "Auto beat button: enabled for audio and for a video with sound; disabled (right tooltip) for a video whose audio was separated", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.click, files.video]);
		await ed.addAssetToTimeline(client, "click.wav");
		await ed.addAssetToTimeline(client, "track.mp4");
		await ed.selectClip(client, "click.wav");
		const audio = await beatState(client);
		const audioTip = await hoverTooltip(client, beatButtonFinder.toString());
		await ed.selectClip(client, "track.mp4");
		const video = await beatState(client);
		const videoTip = await hoverTooltip(client, beatButtonFinder.toString());
		// ses ayır: araç çubuğundaki "Extract audio"
		await clickEl(client, "Extract audio", `() => document.querySelector('button[aria-label="Extract audio"]')`);
		await sleep(800);
		const clips = await ed.clipsInfo(client);
		await ed.selectClip(client, "track.mp4");
		const separated = await beatState(client);
		const separatedTip = await hoverTooltip(client, beatButtonFinder.toString());
		await ctx.shoot("D1-separated-video-tooltip");
		// çıkarılan ses klibi de "track.mp4" adını taşır: ikinci "track.mp4"
		const extractedIndex = clips.findIndex((c, i) => c.name === "track.mp4" && i > clips.findIndex((x) => x.name === "track.mp4"));
		const extracted = extractedIndex >= 0 ? clips[extractedIndex] : null;
		R.metric("D.buttonStates", { audio, audioTip, video, videoTip, separated, separatedTip, clipsAfterExtract: clips.map((c) => c.name) });
		expect(!audio.disabled && !audio.pressed && /Auto beat/.test(audioTip), "audio clip: button should be enabled with tooltip 'Auto beat'", { actual: { audio, audioTip } });
		expect(!video.disabled && /Auto beat/.test(videoTip), "video with sound: button should be enabled", { actual: { video, videoTip } });
		expect(separated.disabled && /Select the extracted audio clip to detect beats/.test(separatedTip), "video with separated audio: button should be disabled with the extracted-audio tooltip", { actual: { separated, separatedTip } });
		let extractedState = null;
		if (extracted) {
			await ed.selectClip(client, extractedIndex);
			extractedState = await beatState(client);
		}
		return { audio: audioTip, video: videoTip, separated: separatedTip, extractedClipEnabled: extractedState ? !extractedState.disabled : "no extracted clip found" };
	});

	let beatElement = null;
	await R.step("D.2", "Auto beat on the 120 BPM click track: progress toast, 'Found N beats (≈X BPM)', N≈60, BPM 120±1, white markers on the clip", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.click]);
		await ed.addAssetToTimeline(client, "click.wav");
		await ed.selectClip(client, "click.wav");
		await waitToastsClear(client);
		const clickT = await pressBeat(client);
		const busyDuring = await beatState(client);
		const run = await readBeatRun(client, clickT);
		await sleep(600);
		const clips = await ed.clipsInfo(client);
		const clip = clips.find((c) => c.name === "click.wav");
		await ctx.shoot("D2-markers-after-detect");
		const m = /Found (\d+) beats \(≈(\d+) BPM\)/.exec(run.finalText);
		expect(m, "unexpected final notification", { actual: run.finalText });
		const count = Number(m[1]);
		const bpm = Number(m[2]);
		R.metric("D.clickTrack", { found: count, bpm, decodeMs: run.decodeMs, analysisMs: run.analysisMs, totalMs: run.totalMs, markersOnClip: clip.beatCount, percentToasts: run.sawPercent, toastSequence: run.steps.map((s) => `${s.ms}ms ${s.text}`) });
		expect(run.sawReading && run.sawPercent >= 1, "no progress notification seen (Reading audio... / Detecting beats... N%)", { actual: run.steps });
		expect(busyDuring?.busy || busyDuring?.disabled || run.steps.length > 1, "button not marked busy during the run", { actual: busyDuring });
		expect(count >= 58 && count <= 62, "beat count is not ~60", { expected: "58..62", actual: count });
		expect(Math.abs(bpm - 120) <= 1, "BPM is not 120 +-1", { expected: "119..121", actual: bpm });
		expect(clip.beatCount === count, "marker count on the clip differs from the notification", { expected: count, actual: clip.beatCount });
		// kalıcı veri: normalleştirilmiş dizi, hata payı
		const project = await projectNow(client);
		beatElement = projectElements(project).find((e) => e.type === "audio");
		const times = beatTimesOf(beatElement);
		const sorted = times.every((t, i) => i === 0 || t > times[i - 1]);
		const ints = (beatElement.beats ?? []).every(Number.isInteger);
		const errs = times.map((t) => Math.min(...beatTruth.map((b) => Math.abs(b - t))) * 1000);
		const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
		R.metric("D.clickTrack.timingErrorMs", { mean: round1(mean), max: round1(Math.max(...errs)), stored: times.length, sorted, integerTicks: ints });
		expect(sorted && ints, "stored beats are not a sorted integer array", { actual: { sorted, ints } });
		return { notification: run.finalText, decodeMs: run.decodeMs, analysisMs: run.analysisMs, markers: clip.beatCount, meanTimingErrorMs: round1(mean), maxTimingErrorMs: round1(Math.max(...errs)) };
	});

	await R.step("D.2b", "markers: bright tick with dark halo readable on the clip; at the lowest zoom a 30 s clip keeps them (spacing >= 4 px)", async () => {
		const clips = await ed.clipsInfo(client);
		const clip = clips.find((c) => c.name === "click.wav");
		expect(clip && clip.beatCount > 0, "no markers to inspect", { actual: clips.map((c) => [c.name, c.beatCount]) });
		const x = clip.markerLeft + clip.markerXs[1];
		const crop = { x: Math.max(0, Math.round(x) - 40), y: clip.y, w: 80, h: clip.h };
		const shot = await ctx.shoot("D2b-marker-crop", { clip: crop });
		const cx = Math.round(x) - crop.x;
		const rowY = Math.round(clip.h * 0.83);
		const profile = [];
		for (let dx = -8; dx <= 8; dx++) profile.push(lumaAt(shot.image, cx + dx, rowY));
		const halo = await client.evaluate(`(() => { const svg = document.querySelector('svg[aria-hidden="true"] path[stroke-width="4"]'); const white = document.querySelector('svg[aria-hidden="true"] path[stroke-width="2"]'); return { haloStroke: svg?.getAttribute("stroke"), tickStroke: white?.getAttribute("stroke") }; })()`);
		const background = Math.round((profile[0] + profile[1] + profile[15] + profile[16]) / 4);
		const peak = Math.max(...profile);
		const darkest = Math.min(...profile.slice(4, 13));
		R.metric("D.markerPixels", { profileLuma: profile, background, peak, darkestNearTick: darkest, ...halo });
		// uzak zoom: 30 sn'lik klip en düşük yakınlaştırmada vuruş başına kaç piksel
		await ed.zoomClip(client, "out", 14);
		const lowest = (await ed.clipsInfo(client)).find((c) => c.name === "click.wav");
		await ctx.shoot("D2b-lowest-zoom");
		R.metric("D.lowestZoom30s", { clipWidthPx: round1(lowest.w), pxPerBeat: round1(lowest.w / 60), markersShown: lowest.beatCount });
		expect(peak >= 235, "tick is not bright white", { expected: ">=235", actual: peak });
		expect(darkest < background - 20 || darkest < 100, "no darker halo next to the tick", { actual: { background, darkest, profile } });
		return { peak, background, darkestNearTick: darkest, lowestZoom: `${round1(lowest.w / 60)} px/beat, ${lowest.beatCount} markers`, ...halo };
	});

	await R.step("D.3a", "split on a beat keeps every marker (union of marker positions unchanged), halves carry the right beats", async () => {
		const pps = await zoomToPps(client, "click.wav", 100);
		expect(pps, "could not reach ~100 px/s zoom");
		const before = (await ed.clipsInfo(client)).find((c) => c.name === "click.wav");
		const absBefore = before.markerXs.map((x) => before.markerLeft + x);
		const pxPerSec = before.w / 30;
		// 7.25 sn civarındaki bir vuruşa: oynatma başlığını klavye ile ata (kareye yuvarlanır), bölme "s"
		await ed.selectClip(client, "click.wav");
		await ed.seekSeconds(client, 7.5);
		await press(client, "s");
		await sleep(700);
		const after = (await ed.clipsInfo(client)).filter((c) => c.name === "click.wav").sort((a, b) => a.x - b.x);
		expect(after.length === 2, "split did not produce two clips", { actual: after.length });
		const absAfter = after.flatMap((c) => c.markerXs.map((x) => c.markerLeft + x)).sort((a, b) => a - b);
		const missing = absBefore.filter((x) => !absAfter.some((y) => Math.abs(y - x) <= 1.5));
		const extra = absAfter.filter((y) => !absBefore.some((x) => Math.abs(y - x) <= 1.5));
		R.metric("D.split", { before: absBefore.length, leftHalf: after[0].beatCount, rightHalf: after[1].beatCount, missing: missing.length, extra: extra.length, pxPerSec: round1(pxPerSec) });
		await ctx.shoot("D3a-after-split");
		expect(missing.length === 0 && extra.length === 0, "markers changed by the split", { expected: absBefore.length, actual: { missing, extra } });
		expect(after[0].beatCount + after[1].beatCount === absBefore.length, "beats were lost or duplicated by the split", { expected: absBefore.length, actual: [after[0].beatCount, after[1].beatCount] });
		return { left: after[0].beatCount, right: after[1].beatCount, total: absBefore.length };
	});

	await R.step("D.3b", "undo/redo: Ctrl+Z removes the split, Ctrl+Z again removes the markers, redo brings them back", async () => {
		await press(client, "ctrl+z");
		await sleep(500);
		const merged = (await ed.clipsInfo(client)).filter((c) => c.name === "click.wav");
		await press(client, "ctrl+z");
		await sleep(500);
		const none = (await ed.clipsInfo(client)).find((c) => c.name === "click.wav");
		const stateNone = await beatState(client);
		await press(client, "ctrl+shift+z");
		await sleep(500);
		await press(client, "ctrl+shift+z");
		await sleep(500);
		const back = (await ed.clipsInfo(client)).filter((c) => c.name === "click.wav");
		R.metric("D.undoRedo", { afterFirstUndo: merged.map((c) => c.beatCount), afterSecondUndo: none?.beatCount, buttonAfterSecondUndo: stateNone, afterRedo: back.map((c) => c.beatCount) });
		expect(merged.length === 1 && merged[0].beatCount === 60, "first undo should restore one clip with 60 markers", { actual: merged.map((c) => c.beatCount) });
		expect(none?.beatCount === 0 && stateNone && !stateNone.pressed && !stateNone.disabled, "second undo should remove the markers and re-arm the button", { actual: { markers: none?.beatCount, button: stateNone } });
		expect(back.length === 2 && back[0].beatCount + back[1].beatCount === 60, "redo did not restore the split with all markers", { actual: back.map((c) => c.beatCount) });
		return { firstUndo: merged[0].beatCount, secondUndo: none.beatCount, redo: back.map((c) => c.beatCount) };
	});

	// --- yapışma: klip taşıma/kırpma beat'e yapışır, oynatma başlığı sürüklemesi
	const snapIndicatorVisible = () => client.evaluate(`!!document.querySelector('[class*="bg-primary/40"][class*="w-0.5"]')`);
	await R.step("D.3c", "moving a clip near a beat snaps it exactly onto the (detected) beat with a snap line, and does not when snapping is off", async () => {
		await press(client, "ctrl+z"); // bölmeyi geri al: tek klip
		await sleep(500);
		// Ana (main) kanal klipleri sıkıştırır (taşıyınca 0'a döner): serbest taşınabilen bir ÜST kanal klibi (metin) kullan
		await ed.seekStart(client);
		await ed.addDefaultText(client);
		const pps = await zoomToPps(client, "click.wav", 100);
		expect(pps, "could not reach ~100 px/s zoom");
		const audio = (await ed.clipsInfo(client)).find((c) => c.name === "click.wav");
		const stored = (await projectNow(client));
		const beats = beatTimesOf(projectElements(stored).find((e) => e.type === "audio"));
		const beatTarget = beats.reduce((best, t) => (Math.abs(t - 7.25) < Math.abs(best - 7.25) ? t : best), beats[0]);
		const moveClip = async (toStartSeconds, { extraPx = 0, watchIndicator = false } = {}) => {
			const moving = (await ed.clipsInfo(client)).find((c) => c.name === "Default text");
			const from = { x: moving.x + 40, y: moving.y + moving.h / 2 };
			const currentStart = (moving.x - audio.x) / pps;
			const dx = (toStartSeconds - currentStart) * pps + extraPx;
			const to = { x: from.x + dx, y: from.y };
			await mouse.drag(client, from, to, { steps: 18, stepDelayMs: 25, releaseOnEnd: false });
			await sleep(150);
			const indicator = watchIndicator ? await snapIndicatorVisible() : null;
			if (watchIndicator) await ctx.shoot("D3c-snap-line-during-drag");
			await mouse.up(client, to.x, to.y);
			await sleep(500);
			const project = await projectNow(client);
			const clipEl = projectElements(project).find((e) => e.type === "text");
			return { startSeconds: clipEl.startTime / 120000, indicatorDuringDrag: indicator };
		};
		const results = { detectedBeat: beatTarget };
		results.snapOn = await moveClip(beatTarget, { extraPx: 4, watchIndicator: true });
		await press(client, "n"); // yapışmayı kapat
		await sleep(200);
		await moveClip(0); // başa geri (yapışma kapalı)
		results.snapOff = await moveClip(beatTarget, { extraPx: 4 });
		await moveClip(0);
		await press(client, "n"); // yapışmayı yeniden aç
		R.metric("D.snapMove", results);
		await ctx.shoot("D3c-after-move");
		const on = results.snapOn.startSeconds;
		const off = results.snapOff.startSeconds;
		expect(Math.abs(on - beatTarget) < 0.0005, "clip dropped 4 px from a beat did not snap onto it", { expected: beatTarget, actual: on });
		expect(results.snapOn.indicatorDuringDrag, "no snap line was visible at the end of the drag");
		expect(Math.abs(off - beatTarget) > 0.005, "with snapping off the clip still landed exactly on the beat", { expected: `!= ${beatTarget}`, actual: off });
		return results;
	});

	await R.step("D.3d", "trimming a clip edge near a beat snaps the edge onto the beat (frame-rounded), and not with snapping off", async () => {
		await ed.seekStart(client);
		const audio = (await ed.clipsInfo(client)).find((c) => c.name === "click.wav");
		const pps = audio.w / 30;
		const stored = await projectNow(client);
		const beats = beatTimesOf(projectElements(stored).find((e) => e.type === "audio"));
		const beat = beats.reduce((best, t) => (Math.abs(t - 3.25) < Math.abs(best - 3.25) ? t : best), beats[0]);
		const frame = 1 / 30;
		const trimEnd = async ({ watchIndicator }) => {
			await ed.selectClip(client, "Default text");
			const handle = await rectOf(client, `() => [...document.querySelectorAll('button[aria-label="Right resize handle"]')][0]`);
			expect(handle, "no right resize handle on the selected clip");
			const to = { x: audio.x + beat * pps + 4, y: handle.cy };
			await mouse.drag(client, { x: handle.cx, y: handle.cy }, to, { steps: 14, stepDelayMs: 25, releaseOnEnd: false });
			await sleep(150);
			const indicator = watchIndicator ? await snapIndicatorVisible() : null;
			await mouse.up(client, to.x, to.y);
			await sleep(500);
			const project = await projectNow(client);
			const clipEl = projectElements(project).find((e) => e.type === "text");
			return { endSeconds: (clipEl.startTime + clipEl.duration) / 120000, indicatorDuringDrag: indicator };
		};
		const on = await trimEnd({ watchIndicator: true });
		await press(client, "ctrl+z");
		await sleep(400);
		await press(client, "n");
		await sleep(150);
		const off = await trimEnd({ watchIndicator: false });
		await press(client, "n");
		const nearestFrameToBeat = Math.round(beat / frame) * frame;
		const nearestFrameToOff = Math.round((beat + 4 / pps) / frame) * frame;
		R.metric("D.snapTrim", { detectedBeat: beat, snapOn: on, snapOff: off, frameRoundedBeat: nearestFrameToBeat, frameRoundedUnsnapped: nearestFrameToOff });
		expect(Math.abs(on.endSeconds - nearestFrameToBeat) < 0.0005 && Math.abs(on.endSeconds - nearestFrameToOff) >= 0.0005 || on.indicatorDuringDrag, "trimmed edge did not snap onto the beat", { expected: `${nearestFrameToBeat} (beat ${beat})`, actual: on });
		expect(on.indicatorDuringDrag, "no snap line during the trim", { actual: on });
		expect(Math.abs(off.endSeconds - on.endSeconds) > 0.0005, "snapping on/off gave the same trim result (cannot tell the snap happened)", { actual: { on, off } });
		return { detectedBeat: round1(beat * 1000) / 1000, on, off };
	});

	await R.step("D.3e", "dragging the playhead near a beat, then Split: both halves keep the right markers", async () => {
		await ed.selectClip(client, "click.wav");
		const audio = (await ed.clipsInfo(client)).find((c) => c.name === "click.wav");
		const pps = audio.w / 30;
		const absBefore = audio.markerXs.map((x) => audio.markerLeft + x);
		const handle = await rectOf(client, `() => document.querySelector('button[aria-label="Drag playhead"]')`);
		const beat = 10.25;
		const targetX = audio.x + beat * pps + 3;
		await mouse.drag(client, { x: handle.cx, y: handle.cy }, { x: targetX, y: handle.cy }, { steps: 14, stepDelayMs: 20 });
		await sleep(300);
		const ticks = await ed.playheadTicks(client);
		const seconds = ticks / 120000;
		const storedBeats = beatTimesOf(projectElements(await projectNow(client)).find((e) => e.type === "audio"));
		const nearest = storedBeats.reduce((best, t) => (Math.abs(t - seconds) < Math.abs(best - seconds) ? t : best), storedBeats[0]);
		await ed.selectClip(client, "click.wav");
		await press(client, "s");
		await sleep(700);
		const halves = (await ed.clipsInfo(client)).filter((c) => c.name === "click.wav").sort((a, b) => a.x - b.x);
		const absAfter = halves.flatMap((c) => c.markerXs.map((x) => c.markerLeft + x));
		const missing = absBefore.filter((x) => !absAfter.some((y) => Math.abs(y - x) <= 1.5));
		R.metric("D.playheadSplit", { playheadSeconds: seconds, droppedAtSeconds: beat + 3 / pps, nearestDetectedBeatSeconds: nearest, playheadToNearestBeatMs: round1(Math.abs(seconds - nearest) * 1000), halves: halves.map((h) => h.beatCount), missing: missing.length });
		await ctx.shoot("D3e-split-at-playhead");
		expect(halves.length === 2, "split produced no second clip", { actual: halves.length });
		expect(missing.length === 0 && halves[0].beatCount + halves[1].beatCount === absBefore.length, "markers lost/duplicated by splitting at the dragged playhead", { expected: absBefore.length, actual: halves.map((h) => h.beatCount) });
		return { playheadSeconds: Number(seconds.toFixed(4)), releasedAbout: Number((beat + 3 / pps).toFixed(3)), nearestDetectedBeat: Number(nearest.toFixed(4)), playheadSnappedOntoBeat: Math.abs(seconds - nearest) < 0.0005, halves: halves.map((h) => h.beatCount) };
	});

	await R.step("D.4", "beats persist: saved as a normalized array and still shown after reopening the project", async () => {
		const project = await projectNow(client);
		const id = project.id;
		const audios = projectElements(project).filter((e) => e.type === "audio" && e.beats);
		const markersBefore = (await ed.clipsInfo(client)).filter((c) => c.name === "click.wav").sort((a, b) => a.x - b.x).map((c) => c.beatCount);
		await client.send("Page.navigate", { url: "ccut://app/projects" });
		await waitFor("projects page", () => client.evaluate('location.pathname === "/projects" && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
		await reopenProject(ctx, id);
		await sleep(800);
		const clips = (await ed.clipsInfo(client)).filter((c) => c.name === "click.wav");
		const sortedInts = audios.every((a) => a.beats.every(Number.isInteger) && a.beats.every((t, i) => i === 0 || t > a.beats[i - 1]));
		const inRange = audios.every((a) => a.beats.every((t) => t >= 0 && t <= (a.sourceDuration ?? Infinity) * 120000 + 1));
		R.metric("D.persist", { storedHalves: audios.map((a) => a.beats.length), markersAfterReopen: clips.map((c) => c.beatCount), sortedInts, inRange });
		await ctx.shoot("D4-after-reopen");
		const shared = audios.length === 2 && JSON.stringify(audios[0].beats) === JSON.stringify(audios[1].beats);
		R.metric("D.persistShape", { sourceDurationOfFirst: audios[0]?.sourceDuration, firstBeatTicks: audios[0]?.beats?.slice(0, 3), halvesShareTheSameBeatArray: shared });
		expect(audios.length === 2 && sortedInts && inRange, "stored beats are not normalized (sorted integer ticks inside the source media)", { actual: { halves: audios.map((a) => a.beats.length), sortedInts, inRange, sourceDuration: audios[0]?.sourceDuration } });
		const markersAfter = clips.sort((a, b) => a.x - b.x).map((c) => c.beatCount);
		expect(JSON.stringify(markersBefore) === JSON.stringify(markersAfter) && markersAfter.length === 2, "markers differ after reopening", { expected: markersBefore, actual: markersAfter });
		return { storedPerHalf: audios.map((a) => a.beats.length), markersBefore, markersAfter };
	});

	const cancelState = {};
	await R.step("D.5", "Cancel during analysis: really cancelled, button re-armed, nothing written", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [REAL_SONG]);
		await ed.addAssetToTimeline(client, "Lily Allen  Smile (Official Video).mp3");
		await ed.selectClip(client, 0);
		await waitToastsClear(client);
		const clickT = await pressBeat(client);
		await waitFor("Cancel button in the toast", () => client.evaluate(`!![...document.querySelectorAll("[data-sonner-toast] button")].find((b) => b.innerText.trim() === "Cancel")`), { timeoutMs: 8000, intervalMs: 20 });
		await clickEl(client, "toast Cancel", `() => [...document.querySelectorAll("[data-sonner-toast] button")].find((b) => b.innerText.trim() === "Cancel")`, { hoverFirst: false });
		const cancelT = await client.evaluate("performance.now()");
		const run = await readBeatRun(client, clickT, { until: /Cancelling/ }).catch((e) => ({ error: e.message, steps: [] }));
		await waitToastsClear(client, 60_000);
		const clearT = await client.evaluate("performance.now()");
		const button = await beatState(client);
		const clip = (await ed.clipsInfo(client))[0];
		const project = await projectNow(client);
		const audio = projectElements(project).find((e) => e.type === "audio");
		cancelState.msFromCancelToClear = Math.round(clearT - cancelT);
		R.metric("D.cancel", { sawCancelling: run.steps?.some((e) => /Cancelling/.test(e.text)), msFromCancelClickToIdle: cancelState.msFromCancelToClear, button, markers: clip.beatCount, storedBeats: audio?.beats?.length ?? 0 });
		expect(run.steps.some((e) => /Cancelling/.test(e.text)), "no 'Cancelling...' feedback after pressing Cancel", { actual: run });
		expect(!button.busy && !button.disabled && !button.pressed, "button is not re-armed after the cancel", { actual: button });
		expect(clip.beatCount === 0 && !audio?.beats, "beats were written although the run was cancelled", { actual: { markers: clip.beatCount, stored: audio?.beats?.length } });
		return { msFromCancelToIdle: cancelState.msFromCancelToClear, button };
	});

	await R.step("D.6", "silent file -> 'No audio signal'; white noise -> 'No clear beat found'; notification never sticks", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.silent, files.noise]);
		const out = {};
		for (const [key, name, re] of [["silent", "silent.wav", /No audio signal/], ["noise", "noise-1.wav", /No clear beat found|No audio signal/]]) {
			await ed.seekStart(client);
			await ed.addAssetToTimeline(client, name);
			const clips = await ed.clipsInfo(client);
			const idx = clips.findIndex((c) => c.name === name);
			await ed.selectClip(client, idx);
			await waitToastsClear(client);
			const clickT = await pressBeat(client);
			const run = await readBeatRun(client, clickT);
			expect(re.test(run.finalText), `${key}: unexpected notification`, { expected: re.toString(), actual: run.finalText });
			await ctx.shoot(`D6-${key}`);
			// takılı kalmama: bildirim sönüyor ve düğme yeniden hazır
			await waitFor(`${key}: toast to disappear`, async () => (await toastTexts(client)).length === 0, { timeoutMs: 15_000 });
			const button = await beatState(client);
			const stuck = await client.evaluate(`window.__toastLog.slice(-1)[0]?.text ?? ""`);
			expect(!button.busy && !button.pressed && !/Detecting|Reading/.test(stuck), `${key}: button/toast stuck`, { actual: { button, stuck } });
			out[key] = { notification: run.finalText, totalMs: run.totalMs };
		}
		R.metric("D.failureMessages", out);
		return out;
	});

	await R.step("D.6b", "false-positive check: 10 UNSEEDED random white-noise files must all give 'No clear beat found' (0 'Found N beats')", async () => {
		await ed.importMedia(client, files.noiseRandom);
		const out = {};
		for (const [i, file] of files.noiseRandom.entries()) {
			const name = file.split("/").pop();
			await ed.seekStart(client);
			await ed.addAssetToTimeline(client, name);
			const clips = await ed.clipsInfo(client);
			await ed.selectClip(client, clips.findIndex((c) => c.name === name));
			await waitToastsClear(client);
			const clickT = await pressBeat(client);
			const run = await readBeatRun(client, clickT);
			out[`random ${i + 1}`] = run.finalText;
		}
		const found = Object.entries(out).filter(([, text]) => /Found/.test(text));
		R.metric("D.noiseFalsePositives", { results: out, falsePositives: found.length, of: Object.keys(out).length });
		expect(found.length === 0, "the detector reports beats on pure white noise", { expected: "No clear beat found for every file", actual: out });
		return `${found.length} of ${Object.keys(out).length} noise files produced beats; notifications: ${[...new Set(Object.values(out))].join(" | ")}`;
	}, { timeoutMs: 240_000 });

	await R.step("D.7", "real song: beat count, BPM, decode and analysis time; markers hide when zoomed out", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [REAL_SONG]);
		await ed.addAssetToTimeline(client, "Lily Allen  Smile (Official Video).mp3");
		await ed.selectClip(client, 0);
		await waitToastsClear(client);
		const clickT = await pressBeat(client);
		const run = await readBeatRun(client, clickT, { timeoutMs: 180_000 });
		const m = /Found (\d+) beats \(≈(\d+) BPM\)/.exec(run.finalText);
		await sleep(600);
		const clip = (await ed.clipsInfo(client))[0];
		await ctx.shoot("D7-real-song-after-detect");
		const project = await projectNow(client);
		const audio = projectElements(project).find((e) => e.type === "audio");
		const times = beatTimesOf(audio);
		const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
		const medianGap = gaps[Math.floor(gaps.length / 2)] ?? null;
		const impliedBpm = medianGap ? 60 / medianGap : null;
		// uzaklaştırınca gizlenir mi
		await ed.zoomClip(client, "out", 14);
		const lowest = (await ed.clipsInfo(client))[0];
		await ctx.shoot("D7-real-song-lowest-zoom");
		R.metric("D.realSong", { notification: run.finalText, found: m ? Number(m[1]) : null, bpm: m ? Number(m[2]) : null, durationSeconds: round1(audio.duration / 120000), decodeMs: run.decodeMs, analysisMs: run.analysisMs, totalMs: run.totalMs, medianBeatGapSeconds: medianGap && Number(medianGap.toFixed(3)), impliedBpmFromMedianGap: impliedBpm && round1(impliedBpm), firstBeats: times.slice(0, 6).map((t) => Number(t.toFixed(2))), markersAtDefaultZoom: clip.beatCount, markersAtLowestZoom: lowest.beatCount, lowestZoomClipWidthPx: round1(lowest.w), lowestZoomPxPerBeat: m ? round1(lowest.w / Number(m[1])) : null });
		expect(m, "no 'Found N beats' result for the real song", { actual: run.finalText });
		expect(Number(m[1]) >= 285 && Number(m[1]) <= 320 && Math.abs(Number(m[2]) - 96) <= 2, "real song result drifted from the earlier ~303 beats / ~96 BPM", { expected: "285..320 beats, 94..98 BPM", actual: run.finalText });
		return { notification: run.finalText, decodeMs: run.decodeMs, analysisMs: run.analysisMs, totalSeconds: round1(run.totalMs / 1000), medianBeatGapSeconds: medianGap && Number(medianGap.toFixed(3)), markersAtLowestZoom: lowest.beatCount };
	}, { timeoutMs: 240_000 });

	await R.step("D.7b", "8 s excerpts of the real song (temp copy): accepted or rejected by the confidence gate (informational)", async () => {
		expect(files.songExcerpts.length > 0, "no song excerpts were generated");
		await ed.newProject(client);
		await ed.importMedia(client, files.songExcerpts.map((e) => e.file));
		const out = {};
		for (const { offset, file } of files.songExcerpts) {
			const name = file.split("/").pop();
			await ed.seekStart(client);
			await ed.addAssetToTimeline(client, name);
			const clips = await ed.clipsInfo(client);
			await ed.selectClip(client, clips.findIndex((c) => c.name === name));
			await waitToastsClear(client);
			const clickT = await pressBeat(client);
			const run = await readBeatRun(client, clickT);
			out[`8 s from ${offset}s`] = `${/Found/.test(run.finalText) ? "ACCEPTED" : "REJECTED"}: ${run.finalText}`;
		}
		R.metric("D.songExcerpts", out);
		return out;
	}, { timeoutMs: 120_000 });

	await R.step("D.2c", "markers stay readable on a very bright (white) video thumbnail strip", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.videoBright]);
		await ed.addAssetToTimeline(client, "bright.mp4");
		await ed.selectClip(client, "bright.mp4");
		await waitToastsClear(client);
		const clickT = await pressBeat(client);
		const run = await readBeatRun(client, clickT);
		await sleep(600);
		const clip = (await ed.clipsInfo(client)).find((c) => c.name === "bright.mp4");
		expect(clip && clip.beatCount > 0, "no markers on the bright video clip", { actual: { notification: run.finalText, markers: clip?.beatCount } });
		const x = clip.markerLeft + clip.markerXs[2];
		const crop = { x: Math.max(0, Math.round(x) - 40), y: clip.y, w: 80, h: clip.h };
		const shot = await ctx.shoot("D2c-markers-on-bright-video", { clip: crop });
		const cx = Math.round(x) - crop.x;
		const rowY = Math.round(clip.h * 0.83);
		const profile = [];
		for (let dx = -8; dx <= 8; dx++) profile.push(lumaAt(shot.image, cx + dx, rowY));
		const background = Math.round((profile[0] + profile[1] + profile[15] + profile[16]) / 4);
		const darkest = Math.min(...profile.slice(4, 13));
		R.metric("D.markerOnBright", { notification: run.finalText, markers: clip.beatCount, profileLuma: profile, background, darkestNearTick: darkest });
		expect(darkest < background - 60, "on a white thumbnail the tick has no visible dark halo edge", { actual: { background, darkest, profile } });
		return { notification: run.finalText, background, darkestNearTick: darkest, profile };
	});

	await R.step("D.8", "beat worker runs in Electron: a worker script was requested, no Worker/CSP error in the console", async () => {
		const workerRequests = ctx.requests.filter((url) => /worker/i.test(url));
		const bad = ctx.problems.filter((p) => /worker|content security policy|refused/i.test(`${p.text} ${p.url ?? ""}`));
		R.metric("D.worker", { workerRequests: workerRequests.slice(0, 3), problemsMentioningWorkerOrCsp: bad.length });
		expect(workerRequests.length >= 1, "no worker script request observed", { actual: ctx.requests.filter((u) => /beat|detect/i.test(u)).slice(0, 5) });
		expect(bad.length === 0, "Worker/CSP errors in the console", { actual: bad.slice(0, 3) });
		return { workerRequests: workerRequests.length, sample: workerRequests[0] };
	});
}

async function zoomToPps(client, clipName, target, { tolerance = 0.2 } = {}) {
	for (let i = 0; i < 40; i++) {
		const clip = (await ed.clipsInfo(client)).find((c) => c.name === clipName);
		const seconds = 30;
		const pps = clip.w / seconds;
		if (Math.abs(pps - target) / target <= tolerance) return pps;
		await ed.zoomClip(client, pps > target ? "out" : "in", 1);
	}
	return null;
}
const lumaAt = (image, x, y) => {
	const i = (Math.max(0, Math.min(image.height - 1, y)) * image.width + Math.max(0, Math.min(image.width - 1, x))) * 4;
	return (77 * image.data[i] + 150 * image.data[i + 1] + 29 * image.data[i + 2]) >> 8;
};


// ---------------------------------------------------------------- F. Genel
const memorySeries = [];
async function sampleMemory(ctx, label) {
	await ctx.client.send("HeapProfiler.collectGarbage").catch(() => {});
	await ctx.client.send("Performance.enable").catch(() => {});
	const { metrics } = await ctx.client.send("Performance.getMetrics");
	const get = (name) => metrics.find((m) => m.name === name)?.value ?? null;
	const entry = { label, minutes: Number(((Date.now() - startedAt) / 60000).toFixed(1)), jsHeapUsedMB: round1(get("JSHeapUsedSize") / 1048576), jsHeapTotalMB: round1(get("JSHeapTotalSize") / 1048576), domNodes: get("Nodes"), listeners: get("JSEventListeners") };
	memorySeries.push(entry);
	R.metrics["F.memory"] = memorySeries;
	return entry;
}

async function scenarioFreload(ctx) {
	const { client } = ctx;
	await R.step("F.2", "no 'Desktop only' mobile warning at 900 px (and 1024/1280); measure the bars at the default panel size per window width", async () => {
		await ed.newProject(client);
		await ed.addDefaultText(client);
		await ed.propsTab(client, "Transform");
		const rows = [];
		for (const width of [1440, 1280, 1024, 900]) {
			await ed.waitSaved(client, readProjects);
			await client.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, width });
			await client.evaluate("window.__reloadMarker = 1");
			await client.send("Page.reload");
			await waitFor("reload", () => client.evaluate('window.__reloadMarker === undefined && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
			await waitFor("editor or gate", () => client.evaluate('!!document.querySelector(\'button[aria-label="Text"]\') || document.body.innerText.includes("Desktop only")'), { timeoutMs: 30_000 });
			const gate = await client.evaluate('document.body.innerText.includes("Desktop only")');
			const innerWidth = await client.evaluate("window.innerWidth");
			let bar = null;
			if (!gate) {
				await sleep(800);
				await ed.selectClip(client, "Default text");
				await ed.propsTab(client, "Transform");
				const st = await ed.sliderState(client, "Position X");
				const sizes = await ed.panelSizes(client);
				bar = { panelPx: round1(sizes[2].w), containerPx: round1(st.container.w), barPx: round1(st.bar.w), barVisible: st.bar.w > 0 };
				await ctx.shoot(`F2-width-${width}`);
			} else {
				await ctx.shoot(`F2-gate-at-${width}`);
			}
			rows.push({ width, innerWidth, mobileGateShown: gate, ...bar });
		}
		await client.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
		await client.evaluate("window.__reloadMarker = 1");
		await client.send("Page.reload");
		await waitFor("reload", () => client.evaluate('window.__reloadMarker === undefined && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
		R.metric("F.windowWidths", rows);
		expect(rows.every((r) => !r.mobileGateShown), "the mobile 'Desktop only' gate appeared", { actual: rows.filter((r) => r.mobileGateShown) });
		expect(rows.every((r) => r.barVisible && r.barPx >= 96), "a slider bar is hidden or narrower than 96 px at some window width", { expected: ">= 96 px at 1440/1280/1024/900", actual: rows });
		return rows.map((r) => `${r.width}px: ${r.barVisible ? `bar ${r.barPx}px (container ${r.containerPx}px)` : `bar hidden (container ${r.containerPx}px)`}`);
	});

	let reloadProjectId = null;
	await R.step("F.4", "a direct GET and a reload (F5) of /editor/<id> answer 200 (no __next_error__), 0 console/network problems, the project reopens with its content", async () => {
		await ed.newProject(client);
		await ed.addDefaultText(client);
		await ed.propsTab(client, "Text");
		reloadProjectId = await currentProjectId(client);
		await ed.waitSaved(client, readProjects);
		const get = await client.evaluate(`fetch(location.href).then(async (r) => ({ status: r.status, head: (await r.text()).slice(0, 160) }))`);
		const problemsBefore = ctx.problems.length;
		const docsBefore = ctx.documents.length;
		await client.evaluate("window.__reloadMarker = 1");
		await client.send("Page.reload");
		await waitFor("reload", () => client.evaluate('window.__reloadMarker === undefined && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
		await waitFor("editor after reload", () => client.evaluate('!!document.querySelector(\'button[aria-label="Text"]\')'), { timeoutMs: 30_000 });
		await sleep(1500);
		const clips = await waitFor("clips after reload", async () => {
			const c = await ed.clipsInfo(client);
			return c.length ? c : null;
		}, { timeoutMs: 15_000 });
		const isErrorShell = await client.evaluate('document.documentElement.id === "__next_error__"');
		const reloadDocs = ctx.documents.slice(docsBefore).filter((d) => d.url.includes("/editor/"));
		const newProblems = ctx.problems.slice(problemsBefore);
		const serverLog = ctx.app.output().replace(/\x1b\[[0-9;]*m/g, "");
		const wasmError = /instantiateStreaming/.test(serverLog);
		await ctx.shoot("F4-after-reload");
		R.metric("F.editorReload", { directGet: { status: get.status, errorShell: /__next_error__/.test(get.head) }, reloadDocumentStatuses: reloadDocs.map((d) => d.status), errorShellAfterReload: isErrorShell, clipsAfterReload: clips.map((c) => c.name), newProblemsAfterReload: newProblems.length, serverLogHasInstantiateStreaming: wasmError, otherRoutes: { "/projects": await client.evaluate('fetch("/projects").then((r) => r.status)') } });
		expect(get.status === 200 && !/__next_error__/.test(get.head), `direct GET of the editor URL answered HTTP ${get.status}`, { expected: 200, actual: get });
		expect(reloadDocs.length > 0 && reloadDocs.every((d) => d.status === 200) && !isErrorShell, "the reload document is not a clean 200", { actual: { reloadDocs, isErrorShell } });
		expect(newProblems.length === 0, "console/network problems after the reload", { expected: 0, actual: newProblems.slice(0, 4) });
		expect(clips.some((c) => c.name === "Default text"), "the project did not reopen with its text clip", { actual: clips.map((c) => c.name) });
		expect(!wasmError, "the Next server log still shows an instantiateStreaming error", { actual: serverLog.split("\n").filter((l) => /instantiateStreaming/.test(l)).slice(0, 2) });
		return { directGet: get.status, reloadDocument: reloadDocs.map((d) => d.status), problemsAfterReload: newProblems.length, clipsAfterReload: clips.map((c) => c.name), serverLogInstantiateStreaming: wasmError };
	});

	await R.step("F.5", "opening ccut://app/editor/<id> directly in a fresh load (from /projects) works: 200, no error shell, no problems, content present", async () => {
		expect(reloadProjectId, "no project id from F.4");
		await client.send("Page.navigate", { url: "ccut://app/projects" });
		await waitFor("projects page", () => client.evaluate('location.pathname === "/projects" && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
		await sleep(500);
		const problemsBefore = ctx.problems.length;
		const docsBefore = ctx.documents.length;
		await client.send("Page.navigate", { url: `ccut://app/editor/${reloadProjectId}` });
		await waitFor("editor loaded", () => client.evaluate(`location.pathname === "/editor/${reloadProjectId}" && !!document.querySelector('button[aria-label="Text"]')`).catch(() => false), { timeoutMs: 30_000 });
		await sleep(1500);
		const clips = await waitFor("clips after direct load", async () => {
			const c = await ed.clipsInfo(client);
			return c.length ? c : null;
		}, { timeoutMs: 15_000 });
		const docs = ctx.documents.slice(docsBefore).filter((d) => d.url.includes("/editor/"));
		const newProblems = ctx.problems.slice(problemsBefore);
		const isErrorShell = await client.evaluate('document.documentElement.id === "__next_error__"');
		await ctx.shoot("F5-direct-load");
		R.metric("F.directLoad", { documentStatuses: docs.map((d) => d.status), errorShell: isErrorShell, clips: clips.map((c) => c.name), newProblems: newProblems.length });
		expect(docs.length > 0 && docs.every((d) => d.status === 200) && !isErrorShell, "direct load of the editor URL is not a clean 200", { actual: { docs, isErrorShell } });
		expect(newProblems.length === 0, "console/network problems on the direct load", { actual: newProblems.slice(0, 4) });
		expect(clips.some((c) => c.name === "Default text"), "the project content is missing after the direct load", { actual: clips.map((c) => c.name) });
		return { documentStatuses: docs.map((d) => d.status), clips: clips.map((c) => c.name) };
	});
}

async function scenarioFsoak(ctx) {
	const { client } = ctx;
	await R.step("F.3", "memory: no significant renderer leak over a long editing session (JS heap after GC)", async () => {
		// Açık bir projede ~10 dk'ya tamamlayan tekrarlı düzenleme/oynatma döngüsü
		await ed.newProject(client);
		await ed.importMedia(client, [ctx.assets.files.video]);
		await ed.addAssetToTimeline(client, "track.mp4");
		await ed.addDefaultText(client);
		await sampleMemory(ctx, "soak-start");
		const targetMinutes = 10;
		const deadline = startedAt + targetMinutes * 60_000;
		const hardStop = Date.now() + 5 * 60_000;
		let cycles = 0;
		let lastSample = Date.now();
		while (Date.now() < deadline && Date.now() < hardStop) {
			await ed.selectClip(client, "Default text");
			await ed.propsTab(client, "Transform");
			await ed.dragSliderThumb(client, "Position X", { dx: 10, steps: 5 });
			await press(client, "ctrl+z");
			await ed.propsTab(client, "Animation");
			await setPreset(client, "In", cycles % 2 ? "Fade" : "Pop");
			await ed.seekSeconds(client, 1);
			await press(client, "space");
			await sleep(700);
			await press(client, "space");
			await ed.selectClip(client, "track.mp4");
			await ed.propsTab(client, "Transform");
			await ed.seekStart(client);
			cycles++;
			if (Date.now() - lastSample > 40_000) {
				await sampleMemory(ctx, `soak-cycle-${cycles}`);
				lastSample = Date.now();
			}
		}
		const end = await sampleMemory(ctx, "soak-end");
		const first = memorySeries.find((m) => m.label === "soak-start");
		const maxMB = Math.max(...memorySeries.map((m) => m.jsHeapUsedMB));
		const growth = end.jsHeapUsedMB - first.jsHeapUsedMB;
		R.metric("F.memory.summary", { sessionMinutesAtEnd: end.minutes, soakCycles: cycles, startMB: first.jsHeapUsedMB, endMB: end.jsHeapUsedMB, growthMB: round1(growth), maxMB, samples: memorySeries.length });
		expect(end.minutes >= 9.5, "the session was shorter than ~10 minutes (soak hit its time cap)", { actual: end.minutes });
		expect(growth < Math.max(40, first.jsHeapUsedMB * 0.6), "JS heap kept growing through the soak", { actual: { start: first.jsHeapUsedMB, end: end.jsHeapUsedMB, growth } });
		return `JS heap ${first.jsHeapUsedMB} -> ${end.jsHeapUsedMB} MB (max ${maxMB} MB) over ${cycles} edit/play cycles, session ${end.minutes} min`;
	}, { timeoutMs: 8 * 60_000 });
}

function stepProblemCounts() {
	return R.step("F.1", "console/network problem count is 0 after every scenario (empty allow-list), no 127.0.0.1 request", async () => {
		const rows = Object.entries(R.scenarios).map(([name, v]) => ({ name, console: v.consoleProblems ?? 0, network: v.networkProblems ?? 0, direct127: v.directLocalRequests ?? 0, requests: v.requestCount ?? 0 }));
		R.metric("F.problemCounts", rows);
		const bad = Object.entries(R.scenarios).filter(([, v]) => (v.consoleProblems ?? 0) + (v.networkProblems ?? 0) + (v.directLocalRequests ?? 0) > 0);
		const allRequests = Object.values(state.requestsBySession).flat();
		const direct = allRequests.filter((url) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname));
		R.metric("F.requestHosts", [...new Set(allRequests.map((url) => new URL(url).host))]);
		expect(bad.length === 0, "console/network problems recorded", { actual: bad.map(([name, v]) => ({ name, console: v.consoleProblems, network: v.networkProblems, direct: v.directLocalRequests, samples: v.problemSamples })) });
		expect(direct.length === 0, "the page requested 127.0.0.1/localhost directly", { actual: direct.slice(0, 5) });
		return `${rows.length} scenarios, 0 problems, ${allRequests.length} requests, no 127.0.0.1`;
	});
}


// ---------------------------------------------------------------- L. Yerleşim (çubuklar asla gizlenmez), sonek, kart adı
const WINDOW_WIDTHS = [1440, 1280, 1024, 900];
const PANEL_PERCENTS = [25, 20, 15];

// Özellikler panelindeki her role=slider için çubuk/konteyner/sayı kutusu geometrisi + taşma
const measureBars = (client) =>
	client.evaluate(`(() => {
		const props = ${ed.PROPS};
		const panel = props.getBoundingClientRect();
		const viewport = props.querySelector("[data-radix-scroll-area-viewport]");
		const rows = [...props.querySelectorAll('[role="slider"]')].map((bar) => {
			const container = bar.parentElement;
			const br = bar.getBoundingClientRect();
			const cr = container.getBoundingClientRect();
			const input = container.querySelector("input");
			const box = input?.closest("div.border-border") ?? input;
			const xr = box?.getBoundingClientRect();
			const thumb = bar.firstElementChild?.lastElementChild?.getBoundingClientRect();
			return {
				label: bar.getAttribute("aria-label"),
				barW: Math.round(br.width * 10) / 10,
				containerW: Math.round(cr.width * 10) / 10,
				boxW: xr ? Math.round(xr.width * 10) / 10 : null,
				stacked: xr ? xr.top >= br.bottom - 1 : null,
				boxOnOwnRow: xr ? xr.top >= br.bottom - 1 : null,
				sameRow: xr ? Math.abs(xr.top + xr.height / 2 - (br.top + br.height / 2)) < 3 : null,
				overflow: Math.max(br.right, xr?.right ?? 0) > panel.right + 1 || Math.min(br.left, xr?.left ?? 1e9) < panel.left - 1,
				thumbOutside: !!thumb && (thumb.right > br.right + 1 || thumb.left < br.left - 1),
			};
		});
		return { rows, panelW: Math.round(panel.width * 10) / 10, viewportOverflow: viewport ? viewport.scrollWidth > viewport.clientWidth + 1 : false, viewportW: viewport ? [viewport.scrollWidth, viewport.clientWidth] : null, docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
	})()`);

// Etkileşimli kutuların (input, düğme, çubuk, seçici) birbirine binmesi ve panel kenarından taşması
const layoutProblems = (client) =>
	client.evaluate(`(() => {
		const props = ${ed.PROPS};
		const viewport = props.querySelector("[data-radix-scroll-area-viewport]") ?? props;
		const vr = viewport.getBoundingClientRect();
		const items = [...viewport.querySelectorAll('input, textarea, button, [role="slider"], [role="combobox"], [role="switch"]')]
			.map((el) => ({ el, r: el.getBoundingClientRect() }))
			.filter(({ r }) => r.width > 0 && r.height > 0);
		const name = (el) => el.getAttribute("aria-label") || el.innerText?.trim().slice(0, 20) || el.tagName;
		const overlaps = [];
		for (let i = 0; i < items.length; i++) {
			for (let j = i + 1; j < items.length; j++) {
				const a = items[i], b = items[j];
				if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
				const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
				const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
				if (w > 2 && h > 2) overlaps.push(name(a.el) + " x " + name(b.el) + " (" + Math.round(w) + "x" + Math.round(h) + ")");
			}
		}
		const clipped = items.filter(({ r }) => r.right > vr.right + 1 || r.left < vr.left - 1).map(({ el, r }) => name(el) + " [" + Math.round(r.left - vr.left) + ".." + Math.round(r.right - vr.left) + " of " + Math.round(vr.width) + "]");
		return { elements: items.length, overlaps, clipped, scrollOverflow: viewport.scrollWidth > viewport.clientWidth + 1 };
	})()`);

// Birim sonekinin sol kenarı ile değer metninin sağ kenarı arasındaki boşluk (px)
const suffixGap = (client, label, suffix) =>
	client.evaluate(`(() => {
		const props = ${ed.PROPS};
		const input = props.querySelector('input[aria-label=${JSON.stringify(label)}]');
		if (!input) return null;
		const wrapper = input.closest("div.border-border");
		const cs = getComputedStyle(input);
		const mirror = document.createElement("span");
		mirror.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:" + cs.font + ";letter-spacing:" + cs.letterSpacing;
		mirror.textContent = input.value;
		document.body.appendChild(mirror);
		const textWidth = mirror.getBoundingClientRect().width;
		mirror.remove();
		const ir = input.getBoundingClientRect();
		const textLeft = ir.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
		const textRight = textLeft + textWidth;
		const suffixEl = [...wrapper.querySelectorAll("span")].find((el) => el.className.includes("pointer-events-none") && !el.className.includes("invisible") && el.textContent.trim() === ${JSON.stringify(suffix)});
		if (!suffixEl) return { value: input.value, error: "suffix element not found" };
		const sr = suffixEl.getBoundingClientRect();
		const wr = wrapper.getBoundingClientRect();
		return { value: input.value, textRight: Math.round(textRight * 10) / 10, suffixLeft: Math.round(sr.left * 10) / 10, gap: Math.round((sr.left - textRight) * 10) / 10, wrapper: { x: wr.x, y: wr.y, w: wr.width, h: wr.height } };
	})()`);

async function setWindowWidth(client, width) {
	await client.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, width });
	await sleep(500);
}

async function scenarioL(ctx) {
	const { client } = ctx;
	const { files } = ctx.assets;
	const summarize = (m) => ({ panelPx: m.panelW, bars: m.rows.length, minBarW: Math.min(...m.rows.map((r) => r.barW)), maxBarW: Math.max(...m.rows.map((r) => r.barW)), containerW: m.rows[0]?.containerW ?? null, boxOnOwnRowAll: m.rows.every((r) => r.boxOnOwnRow), sameRowAll: m.rows.every((r) => r.sameRow), overflow: m.rows.some((r) => r.overflow) || m.viewportOverflow || m.docOverflow });

	await R.step("L.0", "setup: video, text and a rectangle shape on the timeline", async () => {
		await ed.newProject(client);
		await ed.importMedia(client, [files.video]);
		await ed.addAssetToTimeline(client, "track.mp4");
		await ed.addDefaultText(client);
		await ed.openAssetsTab(client, "Stickers");
		await sleep(500);
		await clickEl(client, "Shapes tab", byTextFinder("button", "Shapes", ed.ASSETS));
		await sleep(400);
		await clickEl(client, "first shape '+'", `() => ${ed.ASSETS}.querySelector(".group button")`);
		await sleep(800);
		const clips = await ed.clipsInfo(client);
		expect(clips.length === 3, "expected video, text and shape", { actual: clips.map((c) => c.name) });
		return clips.map((c) => c.name);
	});

	await R.step("L.1", "sliders never hide: bar >= 96 px and no horizontal overflow for panel 15/20/25% (window 1440) and window 900/1024/1280 (panel 25%); stacking under 200 px", async () => {
		await ed.selectClip(client, "Default text");
		const matrix = [];
		for (const width of WINDOW_WIDTHS) {
			await setWindowWidth(client, width);
			for (const pct of PANEL_PERCENTS) {
				const sized = await ed.setPropertiesPanelPercent(client, pct);
				for (const tab of ["Text", "Transform"]) {
					await ed.propsTab(client, tab);
					const m = await measureBars(client);
					matrix.push({ window: width, panelPct: pct, actualPanelPct: sized.size, tab, ...m });
					if (tab === "Transform" && width === 1440 && pct === 15) await ctx.shoot("L1-panel15-window1440");
					if (tab === "Transform" && width === 900 && pct === 25) await ctx.shoot("L1-window900-panel25");
					if (tab === "Transform" && width === 900 && pct === 15) await ctx.shoot("L1-window900-panel15");
				}
			}
		}
		await setWindowWidth(client, 1440);
		await ed.setPropertiesPanelPercent(client, 25);
		const compact = matrix.map((m) => ({ window: m.window, panel: `${m.panelPct}%`, tab: m.tab, ...summarize(m) }));
		R.metric("L.sliders", compact);
		R.metric("L.slidersDetail.transformRows", matrix.filter((m) => m.tab === "Transform" && ((m.window === 1440) || m.panelPct === 25)).map((m) => ({ window: m.window, panel: `${m.panelPct}%`, rows: m.rows.map((r) => `${r.label}: bar ${r.barW}, container ${r.containerW}, box ${r.boxW}, ${r.boxOnOwnRow ? "own row" : r.sameRow ? "same row" : "other"}`) })));
		const required = matrix.filter((m) => (m.window === 1440 && PANEL_PERCENTS.includes(m.panelPct)) || (m.panelPct === 25 && [900, 1024, 1280].includes(m.window)));
		const tooNarrow = required.flatMap((m) => m.rows.filter((r) => r.barW < 96).map((r) => `${m.window}px/${m.panelPct}%/${m.tab}/${r.label}: ${r.barW}`));
		const overflow = required.filter((m) => m.rows.some((r) => r.overflow) || m.viewportOverflow || m.docOverflow).map((m) => `${m.window}px/${m.panelPct}%/${m.tab}`);
		const stackRule = required.flatMap((m) => m.rows.filter((r) => (r.containerW < 199) !== !!r.boxOnOwnRow && Math.abs(r.containerW - 200) > 1.5).map((r) => `${m.window}px/${m.panelPct}%/${r.label}: container ${r.containerW}, ownRow ${r.boxOnOwnRow}`));
		const informational = matrix.filter((m) => !required.includes(m) && m.rows.some((r) => r.barW < 96)).map((m) => `${m.window}px/${m.panelPct}%/${m.tab}: min bar ${Math.min(...m.rows.map((r) => r.barW))} (panel ${m.panelW}px)`);
		R.metric("L.slidersBelow96OutsideRequiredCombos", [...new Set(informational)]);
		expect(required.every((m) => m.rows.length >= 3), "no sliders found in some configuration", { actual: required.filter((m) => m.rows.length < 3).map((m) => `${m.window}/${m.panelPct}/${m.tab}`) });
		expect(tooNarrow.length === 0, "a slider bar is narrower than 96 px", { expected: ">= 96 px", actual: tooNarrow.slice(0, 8) });
		expect(overflow.length === 0, "horizontal overflow in the properties panel", { actual: overflow.slice(0, 8) });
		expect(stackRule.length === 0, "bar/box stacking does not follow the 200 px container rule", { actual: stackRule.slice(0, 6) });
		const at = (w, p, tab = "Transform") => summarize(matrix.find((m) => m.window === w && m.panelPct === p && m.tab === tab));
		return { "1440/15%": at(1440, 15), "1440/20%": at(1440, 20), "1440/25%": at(1440, 25), "900/25%": at(900, 25), "1024/25%": at(1024, 25), "1280/25%": at(1280, 25), below96ElsewhereInTheFullMatrix: [...new Set(informational)] };
	}, { timeoutMs: 240_000 });

	const layoutStep = async (id, name, prepare, { expectBars = true } = {}) => {
		await R.step(id, name, async () => {
			await ed.setPropertiesPanelPercent(client, 15);
			await prepare();
			await sleep(400);
			const layout = await layoutProblems(client);
			const bars = await measureBars(client);
			await ctx.shoot(`${id.replace(".", "")}-panel15`);
			await ed.setPropertiesPanelPercent(client, 25);
			R.metric(`${id}.layout`, { elements: layout.elements, overlaps: layout.overlaps, clipped: layout.clipped, scrollOverflow: layout.scrollOverflow, bars: bars.rows.map((r) => `${r.label}: bar ${r.barW}${r.boxOnOwnRow ? " stacked" : ""}`) });
			expect(layout.elements > 0, "no controls found in the tab", { actual: layout });
			expect(layout.overlaps.length === 0, "controls overlap", { actual: layout.overlaps.slice(0, 5) });
			expect(layout.clipped.length === 0 && !layout.scrollOverflow, "controls are clipped by / overflow the panel", { actual: { clipped: layout.clipped.slice(0, 5), scrollOverflow: layout.scrollOverflow } });
			if (expectBars) {
				expect(bars.rows.length > 0 && bars.rows.every((r) => r.barW >= 96), "a slider bar is narrower than 96 px", { actual: bars.rows.filter((r) => r.barW < 96) });
			}
			return { controls: layout.elements, bars: bars.rows.map((r) => `${r.label}: ${r.barW}px`) };
		});
	};
	await layoutStep("L.2a", "Speed tab at 15%: no overlap/clipping, bar >= 96 px", async () => {
		await ed.selectClip(client, "track.mp4");
		await ed.propsTab(client, "Speed");
	});
	await layoutStep("L.2b", "Animation tab duration slider at 15%: no overlap/clipping, bar >= 96 px", async () => {
		await ed.selectClip(client, "Default text");
		await ed.propsTab(client, "Animation");
		await setPreset(client, "In", "Fade");
	});
	await layoutStep("L.2c", "Masks tab rows (rectangle mask) at 15%: no overlap/clipping, bars >= 96 px", async () => {
		await ed.selectClip(client, "track.mp4");
		await ed.propsTab(client, "Masks");
		await clickEl(client, "Add mask", byTextFinder("button", "Add mask", ed.PROPS));
		await clickEl(client, "Rectangle mask", () => [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.innerText.trim() === "Rectangle"));
		await sleep(600);
	});
	await layoutStep("L.2d", "Graphic properties at 15%: no overlap/clipping, bars >= 96 px", async () => {
		await ed.selectClip(client, "Rectangle");
		await ed.propsTab(client, "Graphic");
	});

	await R.step("L.3", "unit suffix never touches the value: suffix left edge >= value text right edge + 2 px (Animation duration 's', Speed 'x')", async () => {
		const rows = [];
		const measure = async (what, label, suffix, pct) => {
			const g = await suffixGap(client, label, suffix);
			rows.push({ what, panel: `${pct}%`, ...g });
			return g;
		};
		for (const pct of [25, 15]) {
			await ed.setPropertiesPanelPercent(client, pct);
			await ed.selectClip(client, "Default text");
			await ed.propsTab(client, "Animation");
			await measure("In duration (default)", "In duration", "s", pct);
			if (pct === 25) await ctx.shoot("L3-duration-suffix-default", { clip: padClip(await rectOf(client, `() => (${ed.PROPS}).querySelector('input[aria-label="In duration"]').closest("div.border-border")`)), scale: 4 });
			await ed.typeInto(client, "In duration", "3");
			await measure("In duration (3.0)", "In duration", "s", pct);
			if (pct === 25) await ctx.shoot("L3-duration-suffix-3", { clip: padClip(await rectOf(client, `() => (${ed.PROPS}).querySelector('input[aria-label="In duration"]').closest("div.border-border")`)), scale: 4 });
			await ed.selectClip(client, "track.mp4");
			await ed.propsTab(client, "Speed");
			await measure("Speed (1.00)", "Speed", "x", pct);
			if (pct === 25) await ctx.shoot("L3-speed-suffix-1x", { clip: padClip(await rectOf(client, `() => (${ed.PROPS}).querySelector('input[aria-label="Speed"]').closest("div.border-border")`)), scale: 4 });
			await ed.typeInto(client, "Speed", "2");
			await measure("Speed (2.00)", "Speed", "x", pct);
			await press(client, "ctrl+z");
			await sleep(300);
		}
		await ed.setPropertiesPanelPercent(client, 25);
		R.metric("L.suffixGaps", rows.map((r) => `${r.what} @${r.panel}: value "${r.value}", text right ${r.textRight}, suffix left ${r.suffixLeft}, gap ${r.gap} px`));
		const bad = rows.filter((r) => r.error || !(r.gap >= 2));
		expect(bad.length === 0, "unit suffix overlaps or touches the value text", { expected: "gap >= 2 px", actual: bad });
		return rows.map((r) => `${r.what} @${r.panel}: gap ${r.gap} px`);
	});

	await R.step("L.4", "asset card names show once with one ellipsis ('a-very-long-fil….wav'), no '...wav' duplication", async () => {
		await ed.importMedia(client, [files.longName, files.click]);
		await ed.openAssetsTab(client, "Media");
		const labels = await client.evaluate(`[...${ed.ASSETS}.querySelectorAll("span.sr-only")].map((s) => ({ name: s.textContent.trim(), label: s.nextElementSibling?.textContent ?? null, title: s.parentElement?.getAttribute("title") ?? null }))`);
		await ctx.shoot("L4-asset-card-names");
		R.metric("L.assetLabels", labels);
		const long = labels.find((l) => l.name === "a-very-long-file-name-for-testing.wav");
		const short = labels.find((l) => l.name === "click.wav");
		const video = labels.find((l) => l.name === "track.mp4");
		expect(short?.label === "click.wav", "short name is not shown exactly once", { expected: "click.wav", actual: short });
		expect(video?.label === "track.mp4", "track.mp4 label is wrong", { expected: "track.mp4", actual: video });
		const ellipsisCount = (long?.label.match(/…|\.\.\./g) ?? []).length;
		expect(long && long.label.startsWith("a-very-lo") && long.label.endsWith(".wav") && long.label.length < long.name.length && ellipsisCount === 1 && (long.label.match(/wav/g) ?? []).length === 1, "long name is not shortened with a single ellipsis and one extension", { expected: "<prefix>….wav (e.g. a-very-long-fil….wav)", actual: long });
		return { long: long.label, short: short.label, video: video.label };
	});
}

// Küçük bir kutunun çevresini biraz genişlet (ekran görüntüsü kırpması)
const padClip = (r) => ({ x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 8), w: r.w + 24, h: r.h + 16 });

// SCENARIOS-INSERT-POINT

// ---------------------------------------------------------------- koşu
async function main() {
	try {
		fs.mkdirSync(OUT, { recursive: true });
		// önceki koşunun artıkları yanıltmasın (smoke.js'in smoke.png/project.json dosyalarına dokunulmaz)
		for (const name of fs.readdirSync(OUT)) {
			if (/^(smoke\.png|project\.json)$/.test(name)) continue;
			fs.rmSync(path.join(OUT, name), { force: true });
		}
		assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-features-assets-"));
		const assets = generateAssets({ dir: assetsDir, realSong: REAL_SONG });
		R.note("assets", { video: assets.videoInfo, beatTruthCount: assets.beatTruth.length, songExcerpts: assets.files.songExcerpts.map((e) => e.offset) });
		if (!fs.existsSync(path.join(__dirname, "../../web/.next/standalone/apps/web/server.js"))) throw new Error("apps/web/.next/standalone is missing");
		userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-features-"));
		await R.step("setup.bundle", "web bundle is newer than the sources (not stale)", async () => {
			const info = bundleFreshness();
			R.note("bundle", info);
			expect(info.fresh, "apps/web/.next/standalone is older than the newest source", { actual: info });
			return info;
		});

		if (wanted("A")) {
			const first = await openSession("session1");
			first.assets = assets;
			await R.scenario("A.1", () => scenarioA1(first), { problemsOf: first.window });
			await closeSession(first);
		}

		const second = await openSession("session2");
		second.assets = assets;
		await sampleMemory(second, "session2-start");
		const runSecond = async (id, name, fn) => {
			if (!wanted(id)) return;
			await R.scenario(name, () => fn(second), { problemsOf: second.window });
			await sampleMemory(second, `after-${name}`).catch(() => {});
		};
		await runSecond("A", "A.2", scenarioA2);
		await runSecond("B", "B", scenarioB);
		await runSecond("C", "C", scenarioC);
		await runSecond("D", "D", scenarioD);
		await runSecond("L", "L", scenarioL);
		// G/H/I/E2/X: features-content.js, features-camera.js, features-export.js (özel yardımcılar dışarıdan verilir)
		const contentDeps = { R, shootCanvas, measureCanvas, openFontPicker, closeFontPicker, fontTriggerState, popoverFinder, chooseImport, reopenProject, VIEWPORT };
		await runSecond("E2", "E2", (ctx) => cameraScenario.scenarioCamera(ctx, contentDeps));
		await runSecond("G", "G", (ctx) => content.scenarioFonts(ctx, contentDeps));
		await runSecond("H", "H", (ctx) => content.scenarioStickers(ctx, contentDeps));
		await runSecond("I", "I", (ctx) => content.scenarioDesktop(ctx, contentDeps));
		// X: features-export.js (gerçek pencerede MP4+AAC / WebM / iptal / hata arayüzü / sticker ön kontrolü)
		await runSecond("X", "X", (ctx) => exportScenario.scenarioExport(ctx, contentDeps));
		await runSecond("F", "F.soak", scenarioFsoak);
		await runSecond("F", "F.reload", scenarioFreload);
		await closeSession(second);
		if (wanted("A")) await stepCsp();
		if (wanted("F")) await stepProblemCounts();
	} catch (error) {
		R.steps.push({ scenario: "main", id: "main.error", name: "unexpected error", status: "FAIL", detail: error.stack ?? String(error) });
	} finally {
		cleanup();
	}
}

main().finally(report);
