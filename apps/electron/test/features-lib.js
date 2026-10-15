// features.js yardımcıları: gerçek girdi olayları (fare/klavye), DOM bulucular, ekran görüntüsü, rapor kaydı.
// cdp.js'in başlatıcısını/istemcisini yeniden kullanır; burada yalnızca editöre özgü yardımcılar var.
const fs = require("node:fs");
const path = require("node:path");
const { sleep } = require("./cdp");
const { decodePng } = require("./png");

const OUT = path.join(__dirname, "out");

class NotVerified extends Error {}
const notVerified = (reason) => {
	throw new NotVerified(reason);
};

function fail(message, extra = {}) {
	return Object.assign(new Error(message), extra);
}
// expect(koşul, mesaj, {expected, actual})
function expect(condition, message, extra = {}) {
	if (!condition) throw fail(message, extra);
}

const withTimeout = (promise, ms, label) =>
	Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`step timed out after ${ms} ms${label ? `: ${label}` : ""}`)))]);

async function waitFor(what, fn, { timeoutMs = 15_000, intervalMs = 120 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await sleep(intervalMs);
	}
	throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
}

// ---------------------------------------------------------------- girdi
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEY_DEFS = {
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	home: { key: "Home", code: "Home", vk: 36 },
	end: { key: "End", code: "End", vk: 35 },
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	escape: { key: "Escape", code: "Escape", vk: 27 },
	backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	delete: { key: "Delete", code: "Delete", vk: 46 },
	tab: { key: "Tab", code: "Tab", vk: 9 },
	space: { key: " ", code: "Space", vk: 32, text: " " },
	shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
	ctrl: { key: "Control", code: "ControlLeft", vk: 17 },
};
function keyDef(name) {
	const lower = name.toLowerCase();
	if (KEY_DEFS[lower]) return KEY_DEFS[lower];
	if (/^[a-z]$/.test(lower)) return { key: lower, code: `Key${lower.toUpperCase()}`, vk: lower.toUpperCase().charCodeAt(0), text: lower };
	if (/^[0-9]$/.test(lower)) return { key: lower, code: `Digit${lower}`, vk: lower.charCodeAt(0), text: lower };
	throw new Error(`unknown key ${name}`);
}

// "ctrl+z", "shift+ArrowRight", "ArrowRight", "s"
async function press(client, combo) {
	const parts = combo.split("+");
	const main = keyDef(parts.pop());
	const mods = parts.map((part) => part.toLowerCase());
	let modifiers = 0;
	for (const mod of mods) {
		modifiers |= MODS[mod];
		const def = keyDef(mod);
		await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk });
	}
	const textual = main.text !== undefined && !(modifiers & (MODS.ctrl | MODS.alt | MODS.meta));
	await client.send("Input.dispatchKeyEvent", {
		type: textual ? "keyDown" : "rawKeyDown",
		modifiers,
		key: main.key,
		code: main.code,
		windowsVirtualKeyCode: main.vk,
		...(textual && { text: main.text, unmodifiedText: main.text }),
	});
	await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: main.key, code: main.code, windowsVirtualKeyCode: main.vk });
	for (const mod of [...mods].reverse()) {
		modifiers &= ~MODS[mod];
		const def = keyDef(mod);
		await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk });
	}
}

// Tuşa basılı tut (keyDown), sonra bırak: slider odak testleri için
async function keyDown(client, combo) {
	const parts = combo.split("+");
	const main = keyDef(parts.pop());
	let modifiers = 0;
	for (const mod of parts) {
		modifiers |= MODS[mod.toLowerCase()];
		const def = keyDef(mod);
		await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk });
	}
	await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key: main.key, code: main.code, windowsVirtualKeyCode: main.vk });
	return { modifiers, main, parts };
}
async function keyUp(client, held) {
	let modifiers = held.modifiers;
	await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: held.main.key, code: held.main.code, windowsVirtualKeyCode: held.main.vk });
	for (const mod of [...held.parts].reverse()) {
		modifiers &= ~MODS[mod.toLowerCase()];
		const def = keyDef(mod);
		await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk });
	}
}

const mouse = {
	move: (client, x, y, modifiers = 0) => client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers }),
	down: (client, x, y, { clickCount = 1, modifiers = 0, button = "left" } = {}) =>
		client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : 2, clickCount, modifiers }),
	up: (client, x, y, { clickCount = 1, modifiers = 0, button = "left" } = {}) =>
		client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount, modifiers }),
	async click(client, x, y, opts = {}) {
		await mouse.move(client, x, y, opts.modifiers ?? 0);
		await mouse.down(client, x, y, opts);
		await mouse.up(client, x, y, opts);
	},
	// Çift tık: iki ayrı basma/bırakma, ikincisi clickCount=2
	async doubleClick(client, x, y) {
		await mouse.move(client, x, y);
		await mouse.down(client, x, y, { clickCount: 1 });
		await mouse.up(client, x, y, { clickCount: 1 });
		await mouse.down(client, x, y, { clickCount: 2 });
		await mouse.up(client, x, y, { clickCount: 2 });
	},
	// from -> to, `steps` ara noktayla; releaseOnEnd=false ise bırakmaz (Escape testi). Dönüş: son nokta.
	async drag(client, from, to, { steps = 12, releaseOnEnd = true, modifiers = 0, stepDelayMs = 16, onStep } = {}) {
		await mouse.move(client, from.x, from.y, modifiers);
		await mouse.down(client, from.x, from.y, { modifiers });
		for (let i = 1; i <= steps; i++) {
			const x = from.x + ((to.x - from.x) * i) / steps;
			const y = from.y + ((to.y - from.y) * i) / steps;
			await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, modifiers });
			if (stepDelayMs) await sleep(stepDelayMs);
			if (onStep) await onStep(i, { x, y });
		}
		if (releaseOnEnd) await mouse.up(client, to.x, to.y, { modifiers });
		return to;
	},
};

// ---------------------------------------------------------------- sayfa yardımcıları
const ev = (client, expression) => client.evaluate(expression);

// Sayfada çalışan bulucu kaynağından (öğe döndüren fonksiyon) görünür dikdörtgen: {x,y,w,h,cx,cy} | null
async function rectOf(client, finder, { scroll = false } = {}) {
	return client.evaluate(`(() => {
		const el = (${finder})();
		if (!el) return null;
		${scroll ? 'el.scrollIntoView({ block: "center", inline: "center" });' : ""}
		const r = el.getBoundingClientRect();
		return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
	})()`);
}

// Gerçek tıklama: öğe görünür ve örtülü değilse tıklar. Dönüş: tıklanan merkez.
async function clickEl(client, what, finder, { clickCount = 1, timeoutMs = 10_000, hoverFirst = true } = {}) {
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
		{ timeoutMs },
	).catch((error) => {
		throw new Error(`${error.message} (last state: ${state})`);
	});
	if (hoverFirst) await mouse.move(client, point.x, point.y);
	for (let n = 1; n <= clickCount; n++) {
		await mouse.down(client, point.x, point.y, { clickCount: n });
		await mouse.up(client, point.x, point.y, { clickCount: n });
	}
	return point;
}

const byTextFinder = (selector, text, scope = "document") =>
	`() => [...((${scope})?.querySelectorAll(${JSON.stringify(selector)}) ?? [])].find((e) => e.innerText.trim() === ${JSON.stringify(text)})`;
const byLabelFinder = (label, scope = "document") => `() => (${scope})?.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;

async function pageText(client, max = 600) {
	return client.evaluate(`location.href + " | " + document.body.innerText.replace(/\\s+/g, " ").slice(0, ${max})`).catch(() => null);
}

// Sonner toast metinleri
async function toastTexts(client) {
	return client.evaluate(`[...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.innerText.replace(/\\s+/g, " ").trim())`);
}

// ---------------------------------------------------------------- ekran görüntüsü
function createShooter({ client, dir = OUT }) {
	fs.mkdirSync(dir, { recursive: true });
	// clip: {x,y,w,h} (CSS px). Dönüş: { image (decoded), file | null, png (Buffer) }
	return async function shoot(name, { clip, save = true, scale = 1 } = {}) {
		const { data } = await client.send("Page.captureScreenshot", {
			format: "png",
			...(clip && { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale } }),
		});
		const png = Buffer.from(data, "base64");
		let file = null;
		if (save && name) {
			file = path.join(dir, `${name}.png`);
			fs.writeFileSync(file, png);
		}
		return { image: decodePng(png), file, png };
	};
}

// ---------------------------------------------------------------- dosya seçici
// Gerçek "Import" düğmesine basılır; yerel diyalog yerine CDP'nin dosya seçici yakalama özelliği kullanılır
// (Page.setInterceptFileChooserDialog), dosyalar DOM.setFileInputFiles ile verilir.
const chooserState = new WeakMap();
async function enableFileChooser(client) {
	if (chooserState.has(client)) return;
	const state = { waiters: [] };
	chooserState.set(client, state);
	client.on("Page.fileChooserOpened", (params) => state.waiters.shift()?.(params));
	await client.send("DOM.enable");
	await client.send("Page.setInterceptFileChooserDialog", { enabled: true });
}
// clickAction: seçiciyi açan gerçek tıklamayı yapan async fonksiyon. Dönüş: {mode}
async function chooseFiles(client, files, clickAction) {
	await enableFileChooser(client);
	const state = chooserState.get(client);
	const opened = new Promise((resolve, reject) => {
		state.waiters.push(resolve);
		setTimeout(() => reject(new Error("file chooser did not open within 10 s")), 10_000);
	});
	await clickAction();
	const { backendNodeId, mode } = await opened;
	await client.send("DOM.setFileInputFiles", { files, backendNodeId });
	return { mode };
}

// ---------------------------------------------------------------- IndexedDB
const PROJECTS_DB = "video-editor-projects";
async function readProjects(client) {
	return client.evaluate(`(async () => {
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

function projectElements(project) {
	const out = [];
	for (const scene of project.scenes ?? []) {
		const { overlay = [], main, audio = [] } = scene.tracks ?? {};
		for (const track of [...overlay, ...(main ? [main] : []), ...audio]) {
			for (const element of track.elements ?? []) out.push({ ...element, trackId: track.id });
		}
	}
	return out;
}

// ---------------------------------------------------------------- rapor
function createReporter({ log = console.log } = {}) {
	const steps = [];
	const metrics = {};
	const notes = {};
	const scenarios = {};
	let current = "setup";
	let failureHook = null;

	const reporter = {
		steps,
		metrics,
		notes,
		scenarios,
		setFailureHook: (fn) => (failureHook = fn),
		metric(key, value) {
			metrics[key] = value;
			log(`        metric ${key} = ${typeof value === "object" ? JSON.stringify(value) : value}`);
		},
		note(key, value) {
			notes[key] = value;
		},
		get current() {
			return current;
		},
		async scenario(name, fn, { problemsOf } = {}) {
			current = name;
			const before = problemsOf?.snapshot();
			const started = Date.now();
			log(`\n=== scenario ${name} ===`);
			try {
				await fn();
			} catch (error) {
				log(`  scenario ${name} aborted: ${error.message}`);
				const entry = { scenario: name, id: `${name}.abort`, name: "scenario aborted", status: "FAIL", detail: error.stack ?? String(error) };
				if (failureHook) Object.assign(entry, await failureHook(`${name}-abort`).catch(() => ({})));
				steps.push(entry);
			}
			scenarios[name] = { seconds: Number(((Date.now() - started) / 1000).toFixed(1)), ...(problemsOf ? problemsOf.since(before) : {}) };
		},
		// fn dönüş değeri "detail" olur. NotVerified fırlatırsa NOT VERIFIED, başka hata FAIL.
		async step(id, name, fn, { timeoutMs = 90_000 } = {}) {
			const entry = { scenario: current, id, name };
			try {
				const detail = await withTimeout(Promise.resolve().then(fn), timeoutMs, id);
				entry.status = "PASS";
				if (detail !== undefined) entry.detail = detail;
			} catch (error) {
				if (error instanceof NotVerified) {
					entry.status = "NOT VERIFIED";
					entry.detail = error.message;
				} else {
					entry.status = "FAIL";
					entry.detail = error.message;
					if (error.expected !== undefined) entry.expected = error.expected;
					if (error.actual !== undefined) entry.actual = error.actual;
					if (failureHook) Object.assign(entry, await failureHook(`${id.replace(/[^\w.-]+/g, "_")}-fail`).catch(() => ({})));
				}
			}
			steps.push(entry);
			const mark = { PASS: "PASS", FAIL: "FAIL", "NOT VERIFIED": "N/V " }[entry.status];
			const detail = entry.detail === undefined ? "" : ` -- ${typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail)}`;
			log(`  [${mark}] ${id} ${name}${detail.slice(0, 400)}`);
			return entry;
		},
	};
	return reporter;
}

// collectProblems çıktısından senaryo başına sayaçlar
function problemWindow({ problems, requests }) {
	return {
		snapshot: () => ({ problems: problems.length, requests: requests.length }),
		since: (before) => {
			const newProblems = problems.slice(before.problems);
			const newRequests = requests.slice(before.requests);
			const direct = newRequests.filter((url) => {
				try {
					return ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
				} catch {
					return false;
				}
			});
			return {
				consoleProblems: newProblems.filter((p) => p.kind !== "request.failed" && p.kind !== "http.error").length,
				networkProblems: newProblems.filter((p) => p.kind === "request.failed" || p.kind === "http.error").length,
				directLocalRequests: direct.length,
				requestCount: newRequests.length,
				problemSamples: newProblems.slice(0, 6),
			};
		},
	};
}

module.exports = {
	OUT,
	NotVerified,
	notVerified,
	fail,
	expect,
	withTimeout,
	waitFor,
	chooseFiles,
	enableFileChooser,
	press,
	keyDown,
	keyUp,
	mouse,
	ev,
	rectOf,
	clickEl,
	byTextFinder,
	byLabelFinder,
	pageText,
	toastTexts,
	createShooter,
	readProjects,
	projectElements,
	createReporter,
	problemWindow,
	sleep,
};
