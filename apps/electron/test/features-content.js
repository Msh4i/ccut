// features.js senaryoları G (font paketi, çevrimdışı), H (sticker sağlayıcıları) ve I (masaüstü temizliği + kayıt/çıkış akışı).
// features.js çağırır: scenarioFonts / scenarioStickers / scenarioDesktop (ctx, deps). deps = features.js'in özel yardımcıları
// (R, shootCanvas, measureCanvas, font seçici yardımcıları, chooseImport, reopenProject).
// Yalnızca metin/rol/aria seçicileri kullanır; uygulama koduna dokunulmaz. Ürün hatası = adım FAIL kalır, burada düzeltilmez.
const fs = require("node:fs");
const path = require("node:path");
const ed = require("./features-editor");
const lib = require("./features-lib");
const { centroidWhere } = require("./png");

const { OUT, byTextFinder, clickEl, expect, mouse, notVerified, press, projectElements, readProjects, rectOf, sleep, toastTexts, waitFor } = lib;

const PUBLIC = path.join(__dirname, "../../web/public");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(PUBLIC, relative), "utf8"));

// Sticker/font isteklerinin gidebileceği dış sunucular. Boş = yalnızca ccut://app (paketli dosyalar).
// Her satıra gerekçe şart (features.js ALLOWED_PROBLEMS ile aynı kural).
const ALLOWED_EXTERNAL_HOSTS = [];

// Beklenen (kasıtlı yaratılmış) hatalar: senaryo sonunda F.1'in "0 sorun" sayacından çıkarılır, adımlarda ayrıca doğrulanır.
function takeExpectedProblems(ctx, fromIndex, predicate) {
	const taken = [];
	for (let i = ctx.problems.length - 1; i >= fromIndex; i--) {
		if (predicate(ctx.problems[i])) taken.unshift(...ctx.problems.splice(i, 1));
	}
	return taken;
}

const round1 = (n) => Math.round(n * 10) / 10;
const pathOf = (client) => client.evaluate("location.pathname");
const hostOf = (url) => {
	try {
		const { protocol, host } = new URL(url);
		return /^(data|blob|about):$/.test(protocol) ? null : `${protocol}//${host}`;
	} catch {
		return url;
	}
};

// ================================================================ G. Fontlar
const FONT_PACK_FAMILY = "Press Start 2P"; // paketli, tek ağırlık, Türkçe kapsamı var (public/fonts/files/manifest.json)
const FONT_REMOTE_FAMILY = "42dot Sans"; // katalogda var, pakette yok, Türkçe harfleri yok (turkish-support.json'da değil)
const TURKISH_SAMPLE = "ğŞİ";
const SYSTEM_BADGED = new Set(["Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "monospace", "sans-serif", "serif"]);
const GOOGLE_FONT_HOST = /(^|\/\/)fonts\.(googleapis|gstatic)\.com/;

// Google Fonts'a giden her isteği CDP Fetch ile durdurur ve kaydeder: çevrimdışı kanıtı ("hiç istek denenmedi")
async function startGoogleFontsBlock(client) {
	const attempts = [];
	let active = true;
	client.on("Fetch.requestPaused", ({ requestId, request }) => {
		if (!active) return;
		attempts.push(request.url);
		client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
	});
	await client.send("Fetch.enable", { patterns: [{ urlPattern: "*fonts.googleapis.com*" }, { urlPattern: "*fonts.gstatic.com*" }] });
	return {
		attempts,
		stop: async () => {
			active = false;
			await client.send("Fetch.disable").catch(() => {});
		},
	};
}

const pickerSearchSelector = 'input[placeholder^="Search"]';
async function pickerSearch(client, deps, text) {
	await clickEl(client, "font picker search", `() => (${deps.popoverFinder})()?.querySelector('${pickerSearchSelector}')`);
	await press(client, "ctrl+a");
	if (text) await client.send("Input.insertText", { text });
	else await press(client, "backspace");
	await sleep(400);
}
// Sanal liste: yalnızca görünen satırlar + taşma satırları DOM'da
const pickerRows = (client, deps) =>
	client.evaluate(`[...(${deps.popoverFinder})().querySelectorAll("button[aria-label]")]
		.filter((b) => !b.getAttribute("aria-label").startsWith("Delete "))
		.map((b) => ({
			name: b.getAttribute("aria-label").replace(/, (failed to load|has all Turkish letters)/g, ""),
			badge: !!b.querySelector('span[title^="Has all Turkish"]'),
			selected: /(^|\\s)bg-popover-hover(\\s|$)/.test(b.parentElement.className),
		}))`);
const pickerRow = async (client, deps, name) => (await pickerRows(client, deps)).find((row) => row.name === name) ?? null;
const pickerNote = (client, deps) =>
	client.evaluate(`(() => { const t = (${deps.popoverFinder})().innerText; return /No Turkish-ready font matches|No fonts found\\./.exec(t)?.[0] ?? null; })()`);
const turkishToggleState = (client, deps) =>
	client.evaluate(`(() => { const b = [...(${deps.popoverFinder})().querySelectorAll("button")].find((x) => x.innerText.trim() === "Turkish only"); return b ? b.getAttribute("aria-pressed") === "true" : null; })()`);
const clickTurkishToggle = (client, deps) => clickEl(client, "Turkish only toggle", byTextFinder("button", "Turkish only", `(${deps.popoverFinder})()`));
const storedTurkishOnly = (client) => client.evaluate(`localStorage.getItem("font-picker-turkish-only")`);

async function scenarioFonts(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	const support = new Set(readJson("fonts/turkish-support.json"));
	const manifest = readJson("fonts/files/manifest.json");
	let block = null;
	const problemsFrom = ctx.problems.length;

	try {
		await R.step("G.0", "setup: text clip in a new project; Google Fonts requests are blocked and recorded (CDP Fetch)", async () => {
			expect(Object.hasOwn(manifest, FONT_PACK_FAMILY) && support.has(FONT_PACK_FAMILY), `${FONT_PACK_FAMILY} is not in the font pack / Turkish list`);
			expect(!support.has(FONT_REMOTE_FAMILY), `${FONT_REMOTE_FAMILY} unexpectedly has Turkish coverage (pick another family)`);
			expect(!Object.hasOwn(manifest, FONT_REMOTE_FAMILY), `${FONT_REMOTE_FAMILY} unexpectedly is in the font pack`);
			const projectId = await ed.newProject(client);
			await ed.addDefaultText(client);
			await ed.propsTab(client, "Text");
			block = await startGoogleFontsBlock(client);
			const trigger = await deps.fontTriggerState(client);
			expect(trigger?.text === "Arial", "default font is not Arial", { actual: trigger });
			return { projectId, fontPack: Object.keys(manifest).length, turkishList: support.size };
		});
		expect(block, "setup did not finish");

		await R.step("G.1a", "font picker: TR badge appears exactly on fonts with Turkish coverage (turkish-support.json + system fonts)", async () => {
			await deps.openFontPicker(ctx);
			await sleep(500);
			const toggleBefore = await turkishToggleState(client, deps);
			expect(toggleBefore === false, "'Turkish only' toggle is missing or already on in a fresh profile", { actual: toggleBefore });
			const rows = await pickerRows(client, deps);
			const wrong = rows.filter((row) => row.badge !== (support.has(row.name) || SYSTEM_BADGED.has(row.name)));
			const badged = rows.filter((row) => row.badge).length;
			const plain = rows.filter((row) => !row.badge).length;
			expect(rows.length >= 10, "too few rows rendered to judge", { actual: rows.length });
			expect(badged >= 3 && plain >= 3, "need both badged and unbadged rows in the visible window", { actual: { badged, plain } });
			expect(wrong.length === 0, "badge does not match turkish-support.json", { actual: wrong.slice(0, 5) });
			const probes = {};
			for (const [name, expected] of [["Press Start 2P", true], ["ABeeZee", false], ["Arial", true], ["Aboreto", true], ["Acme", false]]) {
				await pickerSearch(client, deps, name);
				const row = await pickerRow(client, deps, name);
				expect(row, `font "${name}" not found in the picker`);
				expect(row.badge === expected, `TR badge for "${name}" should be ${expected}`, { actual: row });
				probes[name] = row.badge;
			}
			await pickerSearch(client, deps, "");
			await ctx.shoot("G1a-picker-badges");
			return { rowsChecked: rows.length, badged, plain, probes };
		});

		await R.step("G.1b", "'Turkish only' on: fonts without coverage disappear, the selected font (Arial) stays listed and selected", async () => {
			await clickTurkishToggle(client, deps);
			await sleep(300);
			expect(await turkishToggleState(client, deps) === true, "toggle did not switch on");
			const rows = await pickerRows(client, deps);
			const bad = rows.filter((row) => !row.badge && !row.selected);
			expect(bad.length === 0, "unbadged, unselected rows remain in the Turkish-only list", { actual: bad.slice(0, 5) });
			await pickerSearch(client, deps, "ABeeZee");
			const hidden = await pickerRow(client, deps, "ABeeZee");
			const note = await pickerNote(client, deps);
			expect(!hidden, "ABeeZee (no Turkish coverage) is still listed");
			expect(note === "No Turkish-ready font matches", "empty-state text for the filtered search is wrong", { actual: note });
			await pickerSearch(client, deps, "Aboreto");
			expect(await pickerRow(client, deps, "Aboreto"), "Aboreto (has coverage) is hidden by the filter");
			await pickerSearch(client, deps, "Arial");
			const arial = await pickerRow(client, deps, "Arial");
			expect(arial && arial.selected, "the selected font Arial is not listed/selected under the filter", { actual: arial });
			await pickerSearch(client, deps, "");
			await ctx.shoot("G1b-turkish-only-on");
			const trigger = await deps.fontTriggerState(client);
			expect(trigger?.text === "Arial", "the trigger lost the selected font", { actual: trigger });
			return { visibleRows: rows.length, arialSelected: arial.selected, abeezeeHidden: true };
		});

		await R.step("G.1c", `selected font without coverage (${FONT_REMOTE_FAMILY}) stays listed and selected under 'Turkish only'; other uncovered fonts are hidden`, async () => {
			await clickTurkishToggle(client, deps); // kapat: seçilecek yazı tipi listede olsun
			await sleep(300);
			expect(await turkishToggleState(client, deps) === false, "toggle did not switch off");
			await pickerSearch(client, deps, "42dot");
			const attemptsBefore = block.attempts.length;
			await clickEl(client, `font row ${FONT_REMOTE_FAMILY}`, `() => [...(${deps.popoverFinder})().querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(FONT_REMOTE_FAMILY)})`);
			await waitFor("picker to close", async () => !(await client.evaluate(`!!(${deps.popoverFinder})()`)), { timeoutMs: 20_000 });
			const trigger = await deps.fontTriggerState(client);
			expect(trigger?.text === FONT_REMOTE_FAMILY, "font was not applied", { actual: trigger });
			const googleAttempts = block.attempts.length - attemptsBefore;
			await deps.openFontPicker(ctx);
			await clickTurkishToggle(client, deps);
			await sleep(300);
			expect(await turkishToggleState(client, deps) === true, "toggle did not switch on");
			await pickerSearch(client, deps, "42dot");
			const kept = await pickerRow(client, deps, FONT_REMOTE_FAMILY);
			expect(kept && kept.selected && !kept.badge, "the selected uncovered font vanished or lost its selected state under the filter", { actual: kept });
			await pickerSearch(client, deps, "ABeeZee");
			expect(!(await pickerRow(client, deps, "ABeeZee")), "another uncovered font (ABeeZee) is listed under the filter");
			await pickerSearch(client, deps, "");
			await ctx.shoot("G1c-selected-uncovered-kept");
			await deps.closeFontPicker(ctx);
			const after = await deps.fontTriggerState(client);
			expect(after?.text === FONT_REMOTE_FAMILY, "trigger lost the selected font after closing", { actual: after });
			return { selectedKept: true, googleRequestsForNonBundledFont: googleAttempts, note: "non-bundled catalog fonts still go to Google (blocked here); only the bundled pack is offline" };
		});

		await R.step("G.1d", "'Turkish only' is persisted: survives closing and reopening the picker (localStorage + toggle state)", async () => {
			expect(await storedTurkishOnly(client) === "true", "localStorage font-picker-turkish-only is not true after switching on", { actual: await storedTurkishOnly(client) });
			await deps.openFontPicker(ctx);
			await sleep(300);
			const on = await turkishToggleState(client, deps);
			expect(on === true, "toggle is off after reopening the picker", { actual: on });
			await clickTurkishToggle(client, deps);
			await sleep(300);
			expect(await turkishToggleState(client, deps) === false && (await storedTurkishOnly(client)) === "false", "switching off was not persisted", { actual: await storedTurkishOnly(client) });
			await deps.closeFontPicker(ctx);
			await deps.openFontPicker(ctx);
			await sleep(300);
			expect(await turkishToggleState(client, deps) === false, "toggle came back on after reopening (off was not kept)");
			await deps.closeFontPicker(ctx);
			return "on survives a reopen, off survives a reopen; value is stored under font-picker-turkish-only";
		});

		await R.step("G.2", `bundled font (${FONT_PACK_FAMILY}) works offline: no Google request, face loaded, "ğŞİ" measured and drawn with it`, async () => {
			await ed.propsTab(client, "Text");
			await clickEl(client, "content textarea", `() => (${ed.PROPS}).querySelector("textarea")`);
			await press(client, "ctrl+a");
			await client.send("Input.insertText", { text: TURKISH_SAMPLE });
			await press(client, "Tab");
			await sleep(400);
			const fallback = await deps.measureCanvas(ctx, "G2-turkish-text-fallback");
			expect(fallback.bbox, "no text drawn for the Turkish sample before applying the pack font");

			const attemptsBefore = block.attempts.length;
			const requestsBefore = ctx.requests.length;
			await deps.openFontPicker(ctx);
			await pickerSearch(client, deps, FONT_PACK_FAMILY);
			await clickEl(client, `font row ${FONT_PACK_FAMILY}`, `() => [...(${deps.popoverFinder})().querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith(${JSON.stringify(FONT_PACK_FAMILY)}))`);
			await waitFor("picker to close", async () => !(await client.evaluate(`!!(${deps.popoverFinder})()`)), { timeoutMs: 20_000 });
			const trigger = await deps.fontTriggerState(client);
			expect(trigger?.text === FONT_PACK_FAMILY && !trigger.caution, "font was not applied cleanly", { actual: trigger });
			const faces = await waitFor("pack faces loaded", async () => {
				const list = await client.evaluate(`[...document.fonts].filter((f) => f.family.replace(/["']/g, "") === ${JSON.stringify(FONT_PACK_FAMILY)}).map((f) => ({ status: f.status, range: f.unicodeRange.slice(0, 24) }))`);
				return list.length >= 2 && list.every((f) => f.status === "loaded") ? list : null;
			}, { timeoutMs: 15_000 });

			const attempted = block.attempts.slice(attemptsBefore);
			const googleRequests = ctx.requests.slice(requestsBefore).filter((url) => GOOGLE_FONT_HOST.test(url));
			expect(attempted.length === 0 && googleRequests.length === 0, "a request to fonts.googleapis.com / fonts.gstatic.com was attempted for a bundled family", { expected: 0, actual: [...attempted, ...googleRequests].slice(0, 4) });
			// Resource Timing özel şemaları (ccut://) listelemez: kanıt CDP Network günlüğünden
			const packFetches = ctx.requests.slice(requestsBefore).filter((url) => url.includes("/fonts/files/press-start-2p/"));
			expect(packFetches.length >= 2 && packFetches.every((url) => url.startsWith("ccut://app/")), "pack files were not fetched from ccut://app", { actual: packFetches });

			const metrics = await client.evaluate(`(() => {
				const c = document.createElement("canvas").getContext("2d");
				const measure = (font, text) => { c.font = font; return c.measureText(text).width; };
				const family = ${JSON.stringify(`16px "${FONT_PACK_FAMILY}"`)};
				return {
					check: document.fonts.check(family, ${JSON.stringify(TURKISH_SAMPLE)}),
					sample: measure(family, ${JSON.stringify(TURKISH_SAMPLE)}),
					mWidth: measure(family, "M"),
					fallbackUnknown: measure('16px "NoSuchFamily-ccut-test"', ${JSON.stringify(TURKISH_SAMPLE)}),
					monospace: measure("16px monospace", ${JSON.stringify(TURKISH_SAMPLE)}),
				};
			})()`);
			expect(metrics.check, "document.fonts.check is false for the pack family");
			expect(Math.abs(metrics.sample - metrics.fallbackUnknown) > 1 && Math.abs(metrics.sample - metrics.monospace) > 1, "measureText of the Turkish sample equals a fallback font's", { actual: metrics });
			expect(Math.abs(metrics.sample - 3 * metrics.mWidth) < 0.5, "ğ Ş İ are not drawn from the pack font (width is not 3 x the monospace advance: some glyph fell back)", { expected: 3 * metrics.mWidth, actual: metrics.sample });
			R.metric("G.packFontMeasureText", { ...metrics, faces: faces.length, packFileRequests: packFetches.length });

			const drawn = await deps.measureCanvas(ctx, "G2-turkish-text-press-start");
			expect(drawn.bbox && drawn.bright >= 40, "the preview draws a blank/near-empty text for the Turkish sample", { actual: { bright: drawn.bright, bbox: drawn.bbox } });
			const ratio = drawn.bbox.w / fallback.bbox.w;
			expect(Math.abs(ratio - 1) > 0.05 || Math.abs(drawn.bright / fallback.bright - 1) > 0.1, "the preview did not change when the pack font was applied", { actual: { fallbackW: fallback.bbox.w, drawnW: drawn.bbox.w } });
			return {
				googleAttempts: 0,
				packFiles: packFetches.map((url) => url.replace("ccut://app/fonts/files/", "")),
				measureText: { sample: round1(metrics.sample), fallback: round1(metrics.fallbackUnknown), monospace: round1(metrics.monospace), threeAdvances: round1(3 * metrics.mWidth) },
				previewBox: { fallback: `${fallback.bbox.w}x${fallback.bbox.h}`, packFont: `${drawn.bbox.w}x${drawn.bbox.h}`, brightPixels: drawn.bright },
				pickerPreviewNote: "picker rows draw catalog fonts from AVIF sprites (font-chunk-N.avif), not live text: the live-text proof is the preview canvas above",
			};
		});

		await R.step("G.3", "custom font import still works (My fonts tab, Import button, imported family listed)", async () => {
			await deps.openFontPicker(ctx);
			const tabs = await client.evaluate(`[...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((t) => t.innerText.trim())`);
			expect(tabs.includes("My fonts"), "no 'My fonts' tab in the picker", { actual: tabs });
			await clickEl(client, "My fonts tab", byTextFinder("button", "My fonts", `(${deps.popoverFinder})()`));
			await sleep(250);
			const importButton = await rectOf(client, byTextFinder("button", "Import", `(${deps.popoverFinder})()`));
			expect(importButton && importButton.w > 0, "no Import button on My fonts");
			await deps.chooseImport(ctx, [ctx.assets.files.font]);
			const toast = await waitFor("an 'Added ...' toast", async () => (await toastTexts(client)).find((t) => /Added/.test(t)), { timeoutMs: 15_000 });
			const family = /Added (.+)$/.exec(toast.replace(/\s*Close.*$/, "").trim())?.[1]?.trim();
			expect(family, "could not read the family from the toast", { actual: toast });
			const listed = await waitFor("custom font row", () => client.evaluate(`!![...(${deps.popoverFinder})().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === ${JSON.stringify(family)})`));
			expect(listed, "imported font is not listed under My fonts");
			await deps.closeFontPicker(ctx);
			return { tabs, imported: family };
		});
	} finally {
		if (block) await block.stop();
		try {
			await deps.closeFontPicker(ctx);
			await deps.openFontPicker(ctx);
			if (await turkishToggleState(client, deps)) await clickTurkishToggle(client, deps);
			await deps.closeFontPicker(ctx);
		} catch (error) {
			R.note("G.cleanupWarning", error.message);
		}
		// Kasıtlı olarak engellenen Google istekleri (yalnızca G.1c'deki paket dışı yazı tipi) F.1 sayacına girmesin
		const expected = takeExpectedProblems(ctx, problemsFrom, (p) => GOOGLE_FONT_HOST.test(`${p.url ?? ""} ${p.text}`));
		R.note("G.expectedBlockedGoogleProblems", expected.length);
	}
}

// ================================================================ H. Sticker'lar
const STICKER_TABS = ["All", "Emoji", "Icons", "Flags", "Shapes"];
const isRed = (r, g, b) => r > 200 && g < 110 && b < 110; // Fluent "Red heart" #F8312F
const isWhite = (r, g, b) => r > 235 && g > 235 && b > 235; // Phosphor ikonları beyaz çizilir

const tabListFinder = `() => document.querySelector('[aria-label="Sticker categories"]')`;
const stickerTabFinder = (name) => `() => [...document.querySelectorAll('[aria-label="Sticker categories"] [role="tab"]')].find((t) => t.innerText.trim() === ${JSON.stringify(name)})`;
const tileNames = (client) => client.evaluate(`[...(${ed.ASSETS}).querySelectorAll('button[aria-label^="Add "]')].map((b) => b.getAttribute("aria-label").slice(4))`);
const stickerSnapshot = (client) =>
	client.evaluate(`(() => {
		const root = ${ed.ASSETS};
		const names = [...root.querySelectorAll('button[aria-label^="Add "]')].map((b) => b.getAttribute("aria-label").slice(4));
		const text = root.innerText;
		return { count: names.length, first: names.slice(0, 3), results: /(\\d+) results/.exec(text)?.[1] ?? null, empty: /No stickers found/.test(text), spinner: !!root.querySelector('[role="status"][aria-label="Loading"]') };
	})()`);

// Panel iki ardışık okumada (stableMs arayla) aynı kalınca oturmuş sayılır: arama/gezinme zaman uyumsuz
async function stickersSettled(client, { stableMs = 600, timeoutMs = 15_000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let previous = null;
	let since = Date.now();
	while (Date.now() < deadline) {
		const snapshot = await stickerSnapshot(client);
		const key = JSON.stringify(snapshot);
		if (key !== previous) {
			previous = key;
			since = Date.now();
		} else if (!snapshot.spinner && Date.now() - since >= stableMs) return snapshot;
		await sleep(120);
	}
	throw new Error(`sticker panel did not settle (last ${previous})`);
}
async function stickerTab(client, name) {
	await clickEl(client, `sticker tab ${name}`, stickerTabFinder(name));
	await waitFor(`${name} tab to be active`, () => client.evaluate(`(${stickerTabFinder(name)})()?.getAttribute("data-state") === "active"`));
	return stickersSettled(client);
}
async function stickerSearch(client, text) {
	await clickEl(client, "sticker search", `() => (${ed.ASSETS}).querySelector('input[placeholder="Search..."]')`);
	await press(client, "ctrl+a");
	if (text) await client.send("Input.insertText", { text });
	else await press(client, "backspace");
	return stickersSettled(client);
}
const clearStickerSearch = async (client) => {
	await clickEl(client, "clear search", `() => (${ed.ASSETS}).querySelector('button[aria-label="Clear input"]')`);
	return stickersSettled(client);
};
// Tarayıcı görünümündeki bölümler: başlık, karo sayısı, "See all" var mı
const stickerSections = (client) =>
	client.evaluate(`[...(${ed.ASSETS}).querySelectorAll("p.text-xs")].map((p) => {
		const section = p.closest(".flex-col.gap-2");
		return { title: p.innerText, tiles: section ? section.querySelectorAll('button[aria-label^="Add "]').length : 0, seeAll: [...(section?.querySelectorAll("button") ?? [])].some((b) => b.innerText.trim() === "See all") };
	})`);
const seeAllFinder = (title) =>
	`() => { const p = [...(${ed.ASSETS}).querySelectorAll("p.text-xs")].find((x) => x.innerText === ${JSON.stringify(title)}); return [...(p?.closest(".flex-col.gap-2")?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === "See all"); }`;
const activeStickerTab = (client) => client.evaluate(`document.querySelector('[aria-label="Sticker categories"] [data-state="active"]')?.innerText.trim() ?? null`);

const tabListState = (client) =>
	client.evaluate(`(() => {
		const list = (${tabListFinder})();
		const active = list.querySelector('[data-state="active"]');
		const lr = list.getBoundingClientRect();
		const ar = active.getBoundingClientRect();
		return { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollLeft: list.scrollLeft, overflowX: getComputedStyle(list).overflowX, active: active.innerText.trim(), activeInside: ar.left >= lr.left - 1 && ar.right <= lr.right + 1, activeEdges: [Math.round(ar.left - lr.left), Math.round(lr.right - ar.right)] };
	})()`);

const assetsPanelWidth = (client) => client.evaluate(`(${ed.ASSETS}).getBoundingClientRect().width`);
const assetsHandle = (client) => rectOf(client, `() => document.querySelectorAll('[data-panel-group-direction="horizontal"][data-panel-resize-handle-id]')[0]`);
// Araçlar paneli ile önizleme arasındaki ayırıcıyı gerçek fareyle sürükle (dx<0: panel daralır)
async function dragAssetsDivider(client, dx) {
	const handle = await assetsHandle(client);
	expect(handle, "no resize handle between the tools panel and the preview");
	await mouse.drag(client, { x: handle.cx, y: handle.cy }, { x: handle.cx + dx, y: handle.cy }, { steps: 8, stepDelayMs: 10 });
	await sleep(400);
	return assetsPanelWidth(client);
}

// Tuvalde boya: koşul sağlanana dek (expectAtLeast) bekler. Dönüş: piksel sayısı, ağırlık merkezi, boyut
// expectNone: yeni açılan projenin tuvali bir önceki projenin son karesini kısa süre gösterebilir (yük altında ~saniyeler): boşalana dek bekler
async function paintedPixels(ctx, deps, name, predicate, { expectAtLeast = 0, expectNone = false, timeoutMs = 8000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let shot;
	let stats;
	do {
		shot = await deps.shootCanvas(ctx, name, { save: false });
		stats = centroidWhere(shot.image, predicate);
		if (expectNone ? stats.count === 0 : !expectAtLeast || stats.count >= expectAtLeast) break;
		await sleep(250);
	} while (Date.now() < deadline);
	fs.writeFileSync(path.join(OUT, `${name}.png`), shot.png);
	return { ...stats, width: shot.image.width, height: shot.image.height, file: path.join(OUT, `${name}.png`) };
}
const centered = (p, tolerance = 0.12) => p.count > 0 && Math.abs(p.cx - p.width / 2) <= p.width * tolerance && Math.abs(p.cy - p.height / 2) <= p.height * tolerance;

const savedProject = async (client, projectId) => {
	await ed.waitSaved(client, readProjects);
	return (await readProjects(client)).find((project) => project.id === projectId);
};

async function scenarioStickers(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	const requestsFrom = ctx.requests.length;
	const state = { emojiTotal: null, inserted: [], projectIds: [] };

	await R.step("H.0", "setup: new project, Stickers panel opens with the provider sections", async () => {
		state.projectIds.push(await ed.newProject(client));
		await ed.openAssetsTab(client, "Stickers");
		await waitFor("sticker tab list", () => client.evaluate(`!!(${tabListFinder})()`));
		// Seçili kategori kalıcıdır (localStorage "stickers-settings"): önceki senaryolar (L) Shapes sekmesini açık bırakmış olabilir
		const leftOn = await activeStickerTab(client);
		const snapshot = await stickerTab(client, "All");
		const sections = await stickerSections(client);
		expect(snapshot.count > 0 && sections.length >= 4, "the browse view has no sections/tiles", { actual: { snapshot, sections, leftOn } });
		await ctx.shoot("H0-stickers-panel");
		return { projectId: state.projectIds[0], sections: sections.map((s) => `${s.title}:${s.tiles}`) };
	});

	await R.step("H.1a", "provider tabs All / Emoji / Icons / Flags / Shapes exist; at the default width they all fit", async () => {
		const tabs = await client.evaluate(`[...document.querySelectorAll('[aria-label="Sticker categories"] [role="tab"]')].map((t) => t.innerText.trim())`);
		expect(JSON.stringify(tabs) === JSON.stringify(STICKER_TABS), "unexpected sticker tabs", { expected: STICKER_TABS, actual: tabs });
		const list = await tabListState(client);
		expect(list.scrollWidth <= list.clientWidth + 1 && list.activeInside, "tabs overflow the default-width panel", { actual: list });
		return { tabs, panelWidth: round1(await assetsPanelWidth(client)), tabListWidth: list.clientWidth };
	});

	await R.step("H.1b", "narrow tools panel: the tab bar scrolls sideways (mouse wheel) and the active tab is never clipped", async () => {
		const widthBefore = await assetsPanelWidth(client);
		try {
			const narrow = await dragAssetsDivider(client, -400);
			expect(narrow < widthBefore - 40, "could not narrow the panel with the divider", { actual: { widthBefore, narrow } });
			const initial = await tabListState(client);
			if (initial.scrollWidth <= initial.clientWidth + 1) notVerified(`the narrowest panel (${round1(narrow)} px) still fits all tabs (scrollWidth ${initial.scrollWidth} <= clientWidth ${initial.clientWidth}), so overflow behaviour could not be exercised`);
			expect(["auto", "scroll"].includes(initial.overflowX), "tab list is not horizontally scrollable", { actual: initial });
			const rect = await rectOf(client, tabListFinder);
			await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.cx, y: rect.cy, deltaX: 120, deltaY: 0 });
			await sleep(300);
			const wheeled = await tabListState(client);
			expect(wheeled.scrollLeft > initial.scrollLeft, "horizontal wheel does not scroll the tab bar", { actual: { before: initial.scrollLeft, after: wheeled.scrollLeft } });
			const perTab = {};
			for (const name of [...STICKER_TABS].reverse().concat("All")) {
				await clickEl(client, `sticker tab ${name}`, stickerTabFinder(name));
				await sleep(450);
				perTab[name] = await tabListState(client);
				expect(perTab[name].active === name && perTab[name].activeInside, `active tab "${name}" is clipped in the narrow panel`, { actual: perTab[name] });
			}
			await stickerTab(client, "Shapes");
			await ctx.shoot("H1b-narrow-last-tab-active");
			await stickerTab(client, "All");
			R.metric("H.narrowTabBar", { panelWidth: round1(narrow), scrollWidth: initial.scrollWidth, clientWidth: initial.clientWidth, edgeGaps: Object.fromEntries(Object.entries(perTab).map(([k, v]) => [k, v.activeEdges])) });
			return { panelWidth: round1(narrow), scrollWidth: initial.scrollWidth, clientWidth: initial.clientWidth, wheelScrolled: `${initial.scrollLeft} -> ${wheeled.scrollLeft}`, activeFullyVisibleForAllTabs: true };
		} finally {
			const now = await assetsPanelWidth(client);
			if (Math.abs(now - widthBefore) > 3) await dragAssetsDivider(client, widthBefore - now);
		}
	});

	await R.step("H.2a", "Emoji search 'heart': non-empty, first 3 results are hearts", async () => {
		const all = await stickerTab(client, "Emoji");
		state.emojiTotal = all.count;
		expect(all.count > 1000, "Emoji grid is unexpectedly small", { actual: all.count });
		const found = await stickerSearch(client, "heart");
		const names = await tileNames(client);
		await ctx.shoot("H2a-emoji-heart");
		expect(found.count > 0 && names.length === found.count, "no results for 'heart'", { actual: found });
		expect(String(found.count) === found.results, "result total text does not match the tile count", { expected: found.count, actual: found.results });
		expect(names.slice(0, 3).every((n) => /heart/i.test(n)), "first results for 'heart' are not hearts", { actual: names.slice(0, 5) });
		return { total: found.count, first: names.slice(0, 5) };
	});

	await R.step("H.2b", "pasted emoji character (U+2764 U+FE0F) finds 'Red heart'", async () => {
		await stickerSearch(client, "❤️");
		const names = await tileNames(client);
		expect(names.length > 0 && names[0] === "Red heart", "the pasted glyph does not find Red heart first", { expected: "Red heart", actual: names.slice(0, 5) });
		return { results: names.slice(0, 5) };
	});

	await R.step("H.2c", "Turkish query 'kalp': non-empty, first result is a heart", async () => {
		const found = await stickerSearch(client, "kalp");
		const names = await tileNames(client);
		expect(found.count > 0, "no results for 'kalp'");
		expect(/heart/i.test(names[0]), "the first result for 'kalp' is not a heart", { actual: names.slice(0, 5) });
		return { total: found.count, first: names.slice(0, 5) };
	});

	await R.step("H.2d", "clearing the search restores the full grid", async () => {
		const restored = await clearStickerSearch(client);
		expect(restored.count === state.emojiTotal && restored.results === null, "the grid is not restored after clearing", { expected: state.emojiTotal, actual: restored });
		return { tiles: restored.count };
	});

	await R.step("H.3a", "adding the Red heart: timeline clip, saved project (sticker id shape) and pixels on the preview canvas", async () => {
		await stickerSearch(client, "red heart");
		const names = await tileNames(client);
		expect(names[0] === "Red heart", "search 'red heart' does not lead with Red heart", { actual: names.slice(0, 3) });
		const before = await paintedPixels(ctx, deps, "H3a-canvas-before", isRed, { expectNone: true });
		expect(before.count === 0, "the preview canvas already has red pixels before inserting", { actual: before.count });
		await clickEl(client, "'+' of Red heart", `() => (${ed.ASSETS}).querySelector('button[aria-label="Add Red heart"]')`);
		const clip = await waitFor("sticker clip on the timeline", async () => (await ed.clipsInfo(client)).find((c) => c.name === "Red heart"), { timeoutMs: 10_000 });
		const project = await savedProject(client, state.projectIds[0]);
		const stickers = projectElements(project).filter((e) => e.type === "sticker");
		expect(stickers.length === 1, "saved project does not hold exactly one sticker", { actual: projectElements(project).map((e) => `${e.type}:${e.name}`) });
		const [element] = stickers;
		expect(/^emoji:[0-9a-f]+(-[0-9a-f]+)*$/.test(element.stickerId) && element.stickerId === "emoji:2764-fe0f", "unexpected sticker id", { expected: "emoji:2764-fe0f", actual: element.stickerId });
		expect(element.name === "Red heart" && element.intrinsicWidth > 0 && element.intrinsicHeight > 0, "saved sticker lacks name/intrinsic size", { actual: { name: element.name, w: element.intrinsicWidth, h: element.intrinsicHeight } });
		const after = await paintedPixels(ctx, deps, "H3a-heart-on-canvas", isRed, { expectAtLeast: 1500 });
		expect(after.count >= 1500, "the heart is not painted on the preview canvas", { expected: ">= 1500 red px", actual: after.count });
		expect(centered(after), "the red pixels are not where a default-placed sticker belongs (canvas center)", { actual: { cx: round1(after.cx), cy: round1(after.cy), size: `${after.width}x${after.height}` } });
		state.inserted.push({ id: element.stickerId, name: "Red heart" });
		return { clip: clip.name, stickerId: element.stickerId, intrinsic: `${element.intrinsicWidth}x${element.intrinsicHeight}`, redPixels: after.count, centroid: `${round1(after.cx)},${round1(after.cy)} of ${after.width}x${after.height}` };
	});

	await R.step("H.3b", "adding a Phosphor icon ('arrow' search): timeline clip, saved project and white pixels on the canvas (fresh project)", async () => {
		state.projectIds.push(await ed.newProject(client));
		await ed.openAssetsTab(client, "Stickers");
		await waitFor("sticker tab list", () => client.evaluate(`!!(${tabListFinder})()`));
		await stickerTab(client, "Icons");
		const found = await stickerSearch(client, "arrow");
		const names = await tileNames(client);
		expect(found.count > 20 && /^Arrow /.test(names[0]), "'arrow' does not lead with an Arrow icon", { actual: { count: found.count, first: names.slice(0, 4) } });
		const iconName = names[0];
		const before = await paintedPixels(ctx, deps, "H3b-canvas-before", isWhite, { expectNone: true });
		expect(before.count === 0, "the preview canvas already has white pixels before inserting", { actual: before.count });
		await clickEl(client, `'+' of ${iconName}`, `() => (${ed.ASSETS}).querySelector('button[aria-label=${JSON.stringify(`Add ${iconName}`)}]')`);
		const clip = await waitFor("icon clip on the timeline", async () => (await ed.clipsInfo(client)).find((c) => c.name === iconName), { timeoutMs: 10_000 });
		const project = await savedProject(client, state.projectIds[1]);
		const stickers = projectElements(project).filter((e) => e.type === "sticker");
		expect(stickers.length === 1, "saved project does not hold exactly one sticker", { actual: projectElements(project).map((e) => `${e.type}:${e.name}`) });
		const [element] = stickers;
		expect(/^icons:[a-z0-9]+(-[a-z0-9]+)*$/.test(element.stickerId) && element.name === iconName, "unexpected icon sticker id/name", { actual: { id: element.stickerId, name: element.name } });
		const after = await paintedPixels(ctx, deps, "H3b-icon-on-canvas", isWhite, { expectAtLeast: 300 });
		expect(after.count >= 300, "the icon is not painted on the preview canvas", { expected: ">= 300 white px", actual: after.count });
		expect(centered(after), "the icon is not centered on the canvas", { actual: { cx: round1(after.cx), cy: round1(after.cy), size: `${after.width}x${after.height}` } });
		state.inserted.push({ id: element.stickerId, name: iconName });
		return { clip: clip.name, stickerId: element.stickerId, whitePixels: after.count, centroid: `${round1(after.cx)},${round1(after.cy)} of ${after.width}x${after.height}` };
	});

	await R.step("H.3c", "adding the first Flag and the first Shape: both land on the timeline under their tile names (flag = sticker 'flags:..', shape = graphic element)", async () => {
		await stickerSearch(client, "");
		await stickerTab(client, "Flags");
		const flagName = (await tileNames(client))[0];
		expect(flagName, "the Flags tab has no tiles");
		await clickEl(client, `'+' of ${flagName}`, `() => (${ed.ASSETS}).querySelector('button[aria-label=${JSON.stringify(`Add ${flagName}`)}]')`);
		await waitFor("flag clip", async () => (await ed.clipsInfo(client)).some((c) => c.name === flagName), { timeoutMs: 10_000 });
		await stickerTab(client, "Shapes");
		const shapeName = (await tileNames(client))[0];
		expect(shapeName, "the Shapes tab has no tiles");
		await clickEl(client, `'+' of ${shapeName}`, `() => (${ed.ASSETS}).querySelector('button[aria-label=${JSON.stringify(`Add ${shapeName}`)}]')`);
		await waitFor("shape clip", async () => (await ed.clipsInfo(client)).some((c) => c.name === shapeName), { timeoutMs: 10_000 });
		const project = await savedProject(client, state.projectIds[1]);
		const elements = projectElements(project);
		const flag = elements.find((e) => e.name === flagName);
		const shape = elements.find((e) => e.name === shapeName);
		expect(flag && flag.type === "sticker" && /^flags:/.test(flag.stickerId), "saved flag is not a flags: sticker", { actual: flag && { type: flag.type, id: flag.stickerId } });
		expect(shape && shape.type === "graphic", "saved shape is not a graphic element", { actual: shape && shape.type });
		state.inserted.push({ id: flag.stickerId, name: flagName }, { id: shape.definitionId ?? shapeName, name: shapeName });
		return { flag: `${flagName} -> ${flag.stickerId}`, shape: `${shapeName} -> graphic` };
	});

	await R.step("H.4", "Recently used lists the inserted stickers with the same human-readable names as the tiles (fresh page load: async describeSticker)", async () => {
		// Tam sayfa yenileme: "Recently used" yalnızca kalıcı kimliklerden (localStorage) ve zaman uyumsuz describeSticker ile kurulur
		await ed.waitSaved(client, readProjects);
		await client.evaluate("window.__reloadMarker = 1");
		await client.send("Page.reload");
		await waitFor("page reload", () => client.evaluate('window.__reloadMarker === undefined && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
		await waitFor("editor after reload", () => client.evaluate(`!!document.querySelector('button[aria-label="Text"]')`).catch(() => false), { timeoutMs: 30_000 });
		await sleep(1500);
		await ed.dismissOnboarding(client);
		await ed.openAssetsTab(client, "Stickers");
		await waitFor("sticker tab list", () => client.evaluate(`!!(${tabListFinder})()`));
		await stickerTab(client, "All");
		const sections = await waitFor("Recently used section", async () => {
			const list = await stickerSections(client);
			return list.some((s) => s.title === "Recently used") ? list : null;
		}, { timeoutMs: 10_000 });
		const names = await client.evaluate(`(() => { const p = [...(${ed.ASSETS}).querySelectorAll("p.text-xs")].find((x) => x.innerText === "Recently used"); return [...(p?.closest(".flex-col.gap-2")?.querySelectorAll('button[aria-label^="Add "]') ?? [])].map((b) => b.getAttribute("aria-label").slice(4)); })()`);
		const expected = state.inserted.map((s) => s.name).reverse(); // en son kullanılan başta
		expect(JSON.stringify(names) === JSON.stringify(expected), "recent names differ from the tile names", { expected, actual: names });
		const raw = names.filter((name) => /^[0-9a-f]{4,}(-[0-9a-f]+)*$/i.test(name) || /^(icons?|emoji|flags|shapes):/.test(name));
		expect(raw.length === 0, "a recent sticker shows a raw id instead of its name", { actual: raw });
		await ctx.shoot("H4-recently-used");
		return { sections: sections.map((s) => s.title), recent: names };
	});

	await R.step("H.5a", "'See all' on the All tab: shown for every cut-short provider section and opens exactly that category", async () => {
		const sections = (await stickerSections(client)).filter((s) => s.title !== "Recently used");
		const rows = [];
		for (const section of sections) {
			if (section.seeAll) await clickEl(client, `See all of ${section.title}`, seeAllFinder(section.title));
			const opened = section.seeAll ? await activeStickerTab(client) : null;
			const snapshot = opened === section.title ? await stickersSettled(client) : null;
			rows.push({ title: section.title, rowTiles: section.tiles, seeAll: section.seeAll, opened, categoryTiles: snapshot?.count ?? null });
			if (opened && opened !== "All") await stickerTab(client, "All");
		}
		R.metric("H.seeAll", rows);
		const wrongTarget = rows.filter((r) => r.seeAll && r.opened !== r.title);
		const missing = rows.filter((r) => r.categoryTiles !== null && r.categoryTiles > r.rowTiles && !r.seeAll);
		expect(rows.length >= 4, "fewer than 4 provider sections on the All tab", { actual: rows });
		expect(wrongTarget.length === 0, "'See all' opened the wrong category", { actual: wrongTarget });
		expect(missing.length === 0, "a cut-short section has no 'See all'", { actual: missing });
		return rows.map((r) => `${r.title}: ${r.rowTiles} shown, See all ${r.seeAll ? `-> ${r.opened} (${r.categoryTiles} tiles)` : "absent"}`);
	});

	await R.step("H.5b", "'See all' is NOT shown for a section that is already complete (every tile of the category is in the row)", async () => {
		const rows = R.metrics["H.seeAll"];
		expect(rows, "no section data from H.5a");
		const spurious = rows.filter((r) => r.seeAll && r.categoryTiles !== null && r.categoryTiles <= r.rowTiles);
		expect(spurious.length === 0, "'See all' is offered although the section shows its whole category", { actual: spurious.map((r) => `${r.title}: ${r.rowTiles} of ${r.categoryTiles} tiles shown, See all present`) });
		return "every 'See all' leads to more tiles";
	});

	await R.step("H.5c", "search on the All tab: 'See all' only for sections that were cut short, and it keeps the query", async () => {
		const found = await stickerSearch(client, "heart");
		const sections = await stickerSections(client);
		expect(sections.length >= 2, "All-tab search for 'heart' returns too few sections", { actual: sections });
		const emoji = sections.find((s) => s.title === "Emoji");
		expect(emoji && emoji.seeAll, "Emoji section of 'heart' (cut short) has no 'See all'", { actual: sections });
		await clickEl(client, "See all of Emoji", seeAllFinder("Emoji"));
		const after = await stickersSettled(client);
		const opened = await activeStickerTab(client);
		expect(opened === "Emoji" && Number(after.results) > emoji.tiles, "'See all' did not open Emoji with the full result list", { actual: { opened, results: after.results, shownBefore: emoji.tiles } });
		await stickerTab(client, "All");
		await stickerSearch(client, "red heart");
		const small = await stickerSections(client);
		const notCut = small.filter((s) => s.seeAll);
		expect(small.length >= 1 && notCut.length === 0, "a complete result list still offers 'See all'", { actual: small });
		await stickerSearch(client, "");
		return { heart: sections.map((s) => `${s.title}:${s.tiles}${s.seeAll ? "+see all" : ""}`), seeAllOpenedEmoji: `${emoji.tiles} -> ${after.results} results`, redHeart: small.map((s) => `${s.title}:${s.tiles}`) };
	});

	await R.step("H.6", "network: sticker files come from ccut://app only, nothing leaves the machine", async () => {
		const urls = ctx.requests.slice(requestsFrom);
		const hosts = {};
		for (const url of urls) {
			const host = hostOf(url);
			if (host) hosts[host] = (hosts[host] ?? 0) + 1;
		}
		const external = Object.keys(hosts).filter((host) => host !== "ccut://app" && !ALLOWED_EXTERNAL_HOSTS.includes(host));
		const emoji = urls.filter((url) => /\/emoji\/(fluent-flat\/|index\.json)/.test(url));
		const icons = urls.filter((url) => /\/icons\/phosphor\//.test(url));
		R.metric("H.requestHosts", hosts);
		expect(external.length === 0, "requests left the app origin", { actual: external.map((host) => `${host} (${hosts[host]})`) });
		expect(emoji.length >= 10 && icons.length >= 10, "too few sticker file requests recorded to judge", { actual: { emoji: emoji.length, icons: icons.length } });
		expect(emoji.concat(icons).every((url) => url.startsWith("ccut://app/")), "a sticker file was requested from outside ccut://app", { actual: emoji.concat(icons).filter((url) => !url.startsWith("ccut://app/")).slice(0, 3) });
		return { requests: urls.length, hosts, emojiFiles: emoji.length, iconFiles: icons.length };
	});

	await R.step("H.7", "keyboard: Tab reaches a sticker's 'Add' button and Enter inserts it", async () => {
		await stickerTab(client, "Emoji");
		await ed.stepFrames(client, 5); // oynatma başlığı 0'dan ayrılsın: "başa git" davranışı görünür olsun
		const playheadBefore = await ed.playheadTicks(client);
		const clipsBefore = (await ed.clipsInfo(client)).length;
		await client.evaluate(`window.__enterLog = []; window.__enterListener = (e) => window.__enterLog.push({ key: e.key, defaultPrevented: e.defaultPrevented, target: e.target.tagName + ":" + (e.target.getAttribute("aria-label") ?? "") }); window.addEventListener("keydown", window.__enterListener, false);`);
		const activeLabel = () => client.evaluate(`(() => { const a = document.activeElement; return a.tagName + ":" + (a.getAttribute("aria-label") || a.getAttribute("role") || "") })()`);
		const sequence = [];
		try {
			await client.evaluate(`(${stickerTabFinder("Emoji")})().focus()`);
			sequence.push(await activeLabel());
			let reached = false;
			for (let i = 0; i < 6 && !reached; i++) {
				await press(client, "Tab");
				sequence.push(await activeLabel());
				reached = /^BUTTON:Add /.test(sequence[sequence.length - 1]);
			}
			expect(reached, "no sticker 'Add' button is reachable with Tab", { actual: sequence });
			await press(client, "Enter");
			await sleep(1500);
			const added = (await ed.clipsInfo(client)).length;
			const log = await client.evaluate("window.__enterLog");
			const playheadAfter = await ed.playheadTicks(client);
			const prevented = log.find((entry) => entry.key === "Enter");
			expect(added === clipsBefore + 1, `Enter on the focused '${sequence[sequence.length - 1].slice(7)}' button did not insert the sticker. The Enter keydown has defaultPrevented=${prevented?.defaultPrevented} (global keybinding "goto-start" is bound to Enter in actions/definitions.ts:185; use-keybindings.ts calls preventDefault, which cancels the button's click); playhead ${playheadBefore} -> ${playheadAfter}`, { expected: `${clipsBefore + 1} clips`, actual: { clips: added, tabSequence: sequence, enterKeydown: prevented, playheadBefore, playheadAfter } });
			return { tabSequence: sequence, clips: `${clipsBefore} -> ${added}` };
		} finally {
			await client.evaluate(`window.removeEventListener("keydown", window.__enterListener, false)`).catch(() => {});
		}
	});

	// H.7b-d: Enter/Space gerçek kullanımda. Odak kipi izleyicisi (apps/web/src/actions/focus-modality.ts): fare tıklaması
	// odağı tutan düğmeyi/klibi "fare kipine" alır, Space/Enter genel kısayola gider; Tab "klavye kipine" alır, odaktaki düğme alır.
	const headLeft = (client) => client.evaluate(`document.querySelector('[role="slider"][aria-label="Timeline playhead"]').getBoundingClientRect().left`);
	const clipTotal = async () => (await ed.clipsInfo(client)).length;
	const activeDescription = () => client.evaluate(`(() => { const a = document.activeElement; return a ? a.tagName + ":" + (a.getAttribute("aria-label") || a.getAttribute("role") || "") : "none"; })()`);
	// Space ile oynat, 2. Space ile durdur. Oynatma ölçütü: başlığın ekrandaki konumu (aria-valuenow oynarken güncellenmiyor).
	const spacePlaysThenPauses = async () => {
		const ticks0 = await ed.playheadTicks(client);
		const left0 = await headLeft(client);
		await press(client, "space");
		await sleep(900);
		const leftDuring = await headLeft(client);
		await press(client, "space");
		await sleep(300);
		const ticksStopped = await ed.playheadTicks(client);
		const leftStopped = await headLeft(client);
		await sleep(400);
		const ticksStill = await ed.playheadTicks(client);
		const leftStill = await headLeft(client);
		return { ticks: [ticks0, ticksStopped, ticksStill], leftPx: [round1(left0), round1(leftDuring), round1(leftStopped), round1(leftStill)], played: ticksStopped > ticks0 + 30_000 && leftDuring > left0, pausedAgain: ticksStill === ticksStopped && leftStill === leftStopped };
	};
	const splitFinder = `() => document.querySelector('button[aria-label="Split element"]')`;
	const duplicateFinder = `() => document.querySelector('button[aria-label="Duplicate element"]')`;

	await R.step("H.7b", "mouse then keyboard: click a timeline clip, Space plays, a 2nd Space pauses (the clicked clip keeps focus but must not swallow Space)", async () => {
		await ed.seekStart(client);
		await ed.selectClip(client, 0);
		const focusAfterClick = await activeDescription();
		const probe = await spacePlaysThenPauses();
		R.metric("H.7b", { focusAfterClick, ...probe });
		expect(probe.played, "Space after clicking a timeline clip did not start playback", { actual: { focusAfterClick, ...probe } });
		expect(probe.pausedAgain, "the 2nd Space did not pause playback", { actual: { focusAfterClick, ...probe } });
		return { focusAfterClick, ...probe };
	});

	await R.step("H.7c", "mouse then keyboard: click a toolbar Split/Duplicate button, Space plays instead of re-triggering the button", async () => {
		await ed.seekStart(client);
		await ed.stepFrames(client, 15);
		await ed.selectClip(client, 0);
		const before = await clipTotal();
		await clickEl(client, "Split element", splitFinder);
		await sleep(500);
		const afterSplit = await clipTotal();
		const focusAfterClick = await activeDescription();
		const split = await spacePlaysThenPauses();
		const afterSpace = await clipTotal();
		// Duplicate: sonuç sayısı her tetiklemede artar, tekrar tetiklenirse hemen görünür
		await ed.seekStart(client);
		await ed.stepFrames(client, 15);
		await ed.selectClip(client, 0);
		const beforeDuplicate = await clipTotal();
		await clickEl(client, "Duplicate element", duplicateFinder);
		await sleep(500);
		const afterDuplicate = await clipTotal();
		const duplicate = await spacePlaysThenPauses();
		const afterDuplicateSpace = await clipTotal();
		R.metric("H.7c", { clips: { before, afterSplit, afterSpace, beforeDuplicate, afterDuplicate, afterDuplicateSpace }, focusAfterClick, split, duplicate });
		expect(afterSplit === before + 1, "the Split button click did not split (test setup: playhead must be inside the selected clip)", { expected: before + 1, actual: afterSplit });
		expect(afterSpace === afterSplit, "Space re-triggered the focused Split button instead of toggling playback", { expected: afterSplit, actual: afterSpace });
		expect(split.played && split.pausedAgain, "Space after a Split click did not play/pause", { actual: split });
		expect(afterDuplicate === beforeDuplicate + 1, "the Duplicate button click did not duplicate", { expected: beforeDuplicate + 1, actual: afterDuplicate });
		expect(afterDuplicateSpace === afterDuplicate, "Space re-triggered the focused Duplicate button instead of toggling playback", { expected: afterDuplicate, actual: afterDuplicateSpace });
		expect(duplicate.played && duplicate.pausedAgain, "Space after a Duplicate click did not play/pause", { actual: duplicate });
		return { split: `${before} -> ${afterSplit} clips, Space left it at ${afterSpace}, played=${split.played}`, duplicate: `${beforeDuplicate} -> ${afterDuplicate}, Space left it at ${afterDuplicateSpace}, played=${duplicate.played}` };
	});

	await R.step("H.7d", "keyboard: Tab onto the toolbar Split button, Enter activates it (does not jump the playhead to the start)", async () => {
		await ed.seekStart(client);
		await ed.stepFrames(client, 5);
		// H.7c klibi böldü ve çoğalttı: DOM sırasındaki ilk klip playhead'in altında olmayabilir. Playhead'in altındaki klibi seç.
		const headX = await headLeft(client);
		const under = (await ed.clipsInfo(client)).find((c) => c.x <= headX + 1 && headX + 1 <= c.x + c.w);
		expect(under, "no clip lies under the playhead (test setup)", { actual: { headX, clips: (await ed.clipsInfo(client)).map((c) => [c.name, Math.round(c.x), Math.round(c.w)]) } });
		await ed.selectClip(client, under.index);
		// Odağı Split'ten önceki odaklanabilir öğeye al (betikle), gerisi gerçek Tab
		await client.evaluate(`(() => {
			const split = (${splitFinder})();
			const focusables = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.getBoundingClientRect().width > 0);
			const index = focusables.indexOf(split);
			focusables[index - 1].focus();
		})()`);
		const clipsBefore = await clipTotal();
		const ticksBefore = await ed.playheadTicks(client);
		const sequence = [await activeDescription()];
		await press(client, "Tab");
		sequence.push(await activeDescription());
		expect(sequence[1] === "BUTTON:Split element", "Tab from the previous control did not land on the Split button", { actual: sequence });
		await client.evaluate(`window.__enterLog = []; window.__enterListener = (e) => window.__enterLog.push({ key: e.key, defaultPrevented: e.defaultPrevented, target: e.target.tagName + ":" + (e.target.getAttribute("aria-label") ?? "") }); window.addEventListener("keydown", window.__enterListener, false);`);
		await press(client, "Enter");
		await sleep(500);
		const enterLog = await client.evaluate("window.__enterLog");
		await client.evaluate(`window.removeEventListener("keydown", window.__enterListener, false)`).catch(() => {});
		const clipsAfter = await clipTotal();
		const ticksAfter = await ed.playheadTicks(client);
		R.metric("H.7d", { sequence, clips: [clipsBefore, clipsAfter], playheadTicks: [ticksBefore, ticksAfter], enterKeydown: enterLog });
		expect(clipsAfter === clipsBefore + 1, "Enter on the keyboard-focused Split button did not split", { expected: clipsBefore + 1, actual: { clipsAfter, enterKeydown: enterLog } });
		expect(ticksAfter === ticksBefore, "Enter also ran the global 'go to start' shortcut (playhead moved)", { expected: ticksBefore, actual: ticksAfter });
		return { sequence, clips: `${clipsBefore} -> ${clipsAfter}`, playheadTicks: `${ticksBefore} -> ${ticksAfter}` };
	});
}

// ================================================================ I. Masaüstü temizliği ve kayıt akışı
const REMOVED_TABS = ["Sounds", "Transitions", "Adjustment"];
const DESKTOP_TABS = ["Media", "Text", "Stickers", "Effects", "Captions", "Settings"];

// IndexedDB yazmalarını yalnızca proje deposu için düşür (QuotaExceededError): kayıt hatası benzetimi
const installFailingProjectWrites = (client) =>
	client.evaluate(`(() => {
		if (!window.__idbPatch) {
			const proto = IDBObjectStore.prototype;
			const originals = { put: proto.put, add: proto.add };
			window.__idbPatch = { failing: false, blocked: 0 };
			for (const method of ["put", "add"]) {
				proto[method] = function (...args) {
					if (window.__idbPatch.failing && this.name === "projects" && this.transaction?.db?.name === "video-editor-projects") {
						window.__idbPatch.blocked++;
						throw new DOMException("Simulated: the storage is full", "QuotaExceededError");
					}
					return originals[method].apply(this, args);
				};
			}
		}
		window.__idbPatch.failing = true;
		return true;
	})()`);
const setFailingProjectWrites = (client, failing) => client.evaluate(`(() => { if (window.__idbPatch) window.__idbPatch.failing = ${failing}; return window.__idbPatch?.blocked ?? null; })()`);

const exitMenuTrigger = `() => [...document.querySelectorAll("header button")].find((b) => b.querySelector('img[alt="Project thumbnail"]'))`;
const unsavedDialog = `() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.innerText.includes("Your latest changes are not saved"))`;
async function clickExitProject(client) {
	await clickEl(client, "project menu", exitMenuTrigger);
	await clickEl(client, "Exit project", () => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.innerText.trim() === "Exit project"));
}
const textElementCount = async (client, projectId) => projectElements((await readProjects(client)).find((p) => p.id === projectId) ?? {}).filter((e) => e.type === "text").length;

async function scenarioDesktop(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	const problemsFrom = ctx.problems.length;
	const state = { projectId: null };

	try {
		await R.step("I.0", "setup: new project with a text clip", async () => {
			state.projectId = await ed.newProject(client);
			await ed.addDefaultText(client);
			await ed.waitSaved(client, readProjects);
			expect(await textElementCount(client, state.projectId) === 1, "the text clip was not saved");
			return { projectId: state.projectId };
		});

		await R.step("I.1a", "assets tab bar: no Sounds tab and none of the removed placeholder tabs (Transitions, Adjustment)", async () => {
			const tabs = await client.evaluate(`[...(${ed.ASSETS}).querySelector('button[aria-label="Media"]').parentElement.querySelectorAll(":scope > button")].map((b) => b.getAttribute("aria-label"))`);
			const present = REMOVED_TABS.filter((name) => tabs.includes(name));
			expect(present.length === 0, "removed tabs are still in the tab bar", { actual: present });
			expect(JSON.stringify(tabs) === JSON.stringify(DESKTOP_TABS), "unexpected tab set", { expected: DESKTOP_TABS, actual: tabs });
			await ctx.shoot("I1a-tab-bar");
			return tabs;
		});

		await R.step("I.1b", "no tab panel shows a 'coming soon' placeholder", async () => {
			const texts = {};
			for (const name of DESKTOP_TABS) {
				await ed.openAssetsTab(client, name);
				await sleep(250);
				texts[name] = await client.evaluate(`(${ed.ASSETS}).innerText.replace(/\\s+/g, " ").slice(0, 200)`);
			}
			await ed.openAssetsTab(client, "Media");
			const placeholders = Object.entries(texts).filter(([, text]) => /coming soon/i.test(text)).map(([name]) => name);
			expect(placeholders.length === 0, "a panel still shows a 'coming soon' placeholder", { actual: placeholders });
			return Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, text.slice(0, 50)]));
		});

		await R.step("I.1c", "GET /api/sounds/search answers 503 inside the app", async () => {
			const response = await client.evaluate(`fetch("/api/sounds/search?q=click").then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 160) }))`);
			expect(response.status === 503, "sounds search did not answer 503", { expected: 503, actual: response });
			return response;
		});

		await R.step("I.3", "editor header has no Feedback button (desktop), Export is still there", async () => {
			const header = await client.evaluate(`(() => { const h = document.querySelector("header"); return { buttons: [...h.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || b.innerText || b.querySelector("img")?.alt || "").trim()), text: h.innerText.replace(/\\s+/g, " ") }; })()`);
			expect(header.buttons.some((label) => /export/i.test(label)), "control: no Export button found, the header query is wrong", { actual: header });
			expect(!header.buttons.some((label) => /feedback/i.test(label)) && !/feedback/i.test(header.text), "a Feedback control is in the desktop header", { actual: header });
			const feedbackRequests = ctx.requests.filter((url) => /\/api\/feedback/.test(url));
			expect(feedbackRequests.length === 0, "the page requested /api/feedback", { actual: feedbackRequests });
			return header.buttons;
		});

		await R.step("I.2a", "with project writes failing: an edit is NOT stored, a save-failure toast appears", async () => {
			await installFailingProjectWrites(client);
			await ed.addDefaultText(client);
			expect((await ed.clipsInfo(client)).length === 2, "the edit (second text clip) is not on the timeline");
			const toast = await waitFor("save-failure toast", async () => (await toastTexts(client)).find((t) => /Couldn't save your project/.test(t)), { timeoutMs: 15_000 });
			const blocked = await setFailingProjectWrites(client, true);
			expect(blocked > 0, "the patched IndexedDB put was never reached (autosave did not run)", { actual: blocked });
			const stored = await textElementCount(client, state.projectId);
			expect(stored === 1, "the failing write was stored anyway", { expected: 1, actual: stored });
			return { patchedWritesRejected: blocked, toast: toast.replace(/\s*Close.*$/, "").slice(0, 120), storedTextClips: stored };
		});

		await R.step("I.2b", "'Exit project' with a failing save opens the unsaved dialog (Keep editing / Leave anyway)", async () => {
			await clickExitProject(client);
			await waitFor("unsaved dialog", () => client.evaluate(`!!(${unsavedDialog})()`), { timeoutMs: 20_000 });
			const buttons = await client.evaluate(`[...(${unsavedDialog})().querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean)`);
			await ctx.shoot("I2b-unsaved-dialog");
			expect(buttons.includes("Keep editing") && buttons.includes("Leave anyway"), "dialog buttons are not Keep editing / Leave anyway", { actual: buttons });
			expect(await pathOf(client) === `/editor/${state.projectId}`, "the editor was left before the user answered", { actual: await pathOf(client) });
			return { buttons };
		});

		await R.step("I.2c", "'Keep editing' closes the dialog and stays in the editor with the edit still on the timeline", async () => {
			await clickEl(client, "Keep editing", byTextFinder("button", "Keep editing", `(${unsavedDialog})()`));
			await waitFor("dialog to close", async () => !(await client.evaluate(`!!(${unsavedDialog})()`)), { timeoutMs: 5000 });
			await sleep(500);
			expect(await pathOf(client) === `/editor/${state.projectId}`, "Keep editing left the editor", { actual: await pathOf(client) });
			const clips = await ed.clipsInfo(client);
			expect(clips.length === 2, "the edit is gone after Keep editing", { actual: clips.map((c) => c.name) });
			return { path: await pathOf(client), clips: clips.length };
		});

		await R.step("I.2d", "'Leave anyway' goes to /projects (the unsaved edit is knowingly dropped)", async () => {
			await clickExitProject(client);
			await waitFor("unsaved dialog", () => client.evaluate(`!!(${unsavedDialog})()`), { timeoutMs: 20_000 });
			await clickEl(client, "Leave anyway", byTextFinder("button", "Leave anyway", `(${unsavedDialog})()`));
			await waitFor("/projects", async () => (await pathOf(client)) === "/projects", { timeoutMs: 15_000 });
			const stored = await textElementCount(client, state.projectId);
			expect(stored === 1, "the project in storage changed although every write failed", { expected: 1, actual: stored });
			await ctx.shoot("I2d-after-leave");
			return { path: "/projects", storedTextClips: stored };
		});

		await R.step("I.2e", "failure cause removed: a normal exit saves the edit and goes to /projects without any dialog", async () => {
			await setFailingProjectWrites(client, false);
			await deps.reopenProject(ctx, state.projectId);
			const clipsOnOpen = (await ed.clipsInfo(client)).length;
			expect(clipsOnOpen === 1, "reopened project does not hold the one saved text clip", { actual: clipsOnOpen });
			await ed.addDefaultText(client);
			expect((await ed.clipsInfo(client)).length === 2, "the edit is not on the timeline");
			const t0 = Date.now();
			await clickExitProject(client);
			let dialogSeen = false;
			await waitFor("/projects", async () => {
				if (await client.evaluate(`!!(${unsavedDialog})()`)) dialogSeen = true;
				return (await pathOf(client)) === "/projects";
			}, { timeoutMs: 20_000, intervalMs: 50 });
			const exitMs = Date.now() - t0;
			const stored = await textElementCount(client, state.projectId);
			expect(!dialogSeen, "the unsaved dialog appeared on a healthy exit");
			expect(stored === 2, "the edit was not saved on exit", { expected: 2, actual: stored });
			return { exitMs, storedTextClips: stored, dialogShown: dialogSeen };
		});
	} finally {
		await setFailingProjectWrites(client, false).catch(() => {});
		await sleep(400);
		// Kasıtlı kayıt hatası ve 503 yanıtı F.1 sayacına girmesin (I.1c / I.2a-d adımlarında ayrıca doğrulandı)
		const expected = takeExpectedProblems(ctx, problemsFrom, (p) => /Failed to save project|Failed to prepare project exit|Failed to generate project thumbnail/.test(p.text) || /\/api\/sounds\/search/.test(`${p.url ?? ""} ${p.text}`));
		R.note("I.expectedProblems", { count: expected.length, kinds: [...new Set(expected.map((p) => `${p.kind}: ${String(p.text).slice(0, 60)}`))] });
	}
}

module.exports = { scenarioFonts, scenarioStickers, scenarioDesktop, ALLOWED_EXTERNAL_HOSTS, helpers: { stickerTab, stickerSearch, tileNames, stickersSettled, stickerSections } };
