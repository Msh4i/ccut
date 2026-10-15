// features.js için editöre özgü yardımcılar (proje açma, varlık içe aktarma, zaman çizelgesi, özellikler paneli, çubuklar).
// Yalnızca metin/rol/aria seçicileri kullanır; uygulama koduna data-testid eklenmez.
const {
	byTextFinder,
	chooseFiles,
	clickEl,
	expect,
	keyDown,
	keyUp,
	mouse,
	press,
	rectOf,
	sleep,
	readProjects,
	toastTexts,
	waitFor,
} = require("./features-lib");

const GROUP = '[data-panel-group-direction="horizontal"] > [data-panel]';
const ASSETS = `document.querySelectorAll('${GROUP}')[0]`;
const PREVIEW = `document.querySelectorAll('${GROUP}')[1]`;
const PROPS = `document.querySelectorAll('${GROUP}')[2]`;
const PLAYHEAD = `document.querySelector('[role="slider"][aria-label="Timeline playhead"]')`;
const CLIP_SELECTOR = "button.absolute.inset-0.size-full.flex.flex-col";

// ---------------------------------------------------------------- proje
async function dismissOnboarding(client) {
	const open = await client.evaluate('!!document.querySelector(\'[role="dialog"]\')');
	if (!open) return false;
	const dialog = "document.querySelector('[role=\"dialog\"]')";
	await clickEl(client, "onboarding Next", byTextFinder("button", "Next", dialog));
	await clickEl(client, "onboarding Finish", byTextFinder("button", "Finish", dialog));
	await waitFor("onboarding dialog to close", async () => !(await client.evaluate('!!document.querySelector(\'[role="dialog"]\')')));
	return true;
}

// Proje listesine gider (tam sayfa gezintisi: kayıt bitmiş olmalı, yoksa beforeunload yerel diyalog açar) ve yeni proje açar
async function newProject(client) {
	if (!(await client.evaluate('location.pathname === "/projects"'))) {
		// Kirli proje ile ayrılmak "Leave anyway?" yerel diyaloğunu açar: önce otomatik kayıt bitsin
		if (/^\/editor\//.test(await client.evaluate("location.pathname"))) await waitSaved(client, readProjects, { timeoutMs: 8000 }).catch(() => {});
		await client.send("Page.navigate", { url: "ccut://app/projects" });
		await waitFor("projects page", () => client.evaluate('location.pathname === "/projects" && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
	}
	await sleep(600); // hidrasyon bitsin: yüklenir yüklenmez basılan tık işlenmeyebilir
	let pathname = null;
	for (let attempt = 1; attempt <= 3 && !pathname; attempt++) {
		await clickEl(client, '"New project" button', byTextFinder("button", "New project"));
		pathname = await waitFor("navigation to the editor", async () => {
			const current = await client.evaluate("location.pathname");
			return /^\/editor\/[^/]+$/.test(current) ? current : null;
		}, { timeoutMs: attempt < 3 ? 5000 : 15_000 }).catch((error) => {
			if (attempt === 3) throw error;
			return null;
		});
	}
	await waitFor("editor ready", () => client.evaluate('!!document.querySelector(\'button[aria-label="Text"]\')'), { timeoutMs: 30_000 });
	await sleep(1500);
	await dismissOnboarding(client);
	return pathname.split("/").pop();
}

// Kayıt (otomatik) bitene dek bekle: IndexedDB'deki proje iki ardışık okumada aynı kalsın
async function waitSaved(client, readProjects, { settleMs = 1200, timeoutMs = 15_000 } = {}) {
	let previous = null;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const json = JSON.stringify(await readProjects(client));
		if (previous !== null && json === previous) return true;
		previous = json;
		await sleep(settleMs);
	}
	return false;
}

// ---------------------------------------------------------------- varlıklar paneli
async function openAssetsTab(client, label) {
	await clickEl(client, `${label} tab`, `() => (${ASSETS}).querySelector('button[aria-label="${label}"]')`);
	await sleep(300);
}

// Media sekmesi + gerçek Import düğmesi + dosya seçici; varlık kartları görünene dek bekler. Dönüş: toast metinleri
async function importMedia(client, files, { names } = {}) {
	await openAssetsTab(client, "Media");
	await chooseFiles(client, files, () => clickEl(client, "Import button", byTextFinder("button", "Import", ASSETS)));
	const expected = names ?? files.map((file) => file.split("/").pop());
	await waitFor(
		`asset cards ${expected.join(", ")}`,
		() => client.evaluate(`(() => { const names = [...${ASSETS}.querySelectorAll("span.sr-only")].map((s) => s.textContent.trim()); return ${JSON.stringify(expected)}.every((n) => names.includes(n)); })()`),
		{ timeoutMs: 60_000 },
	);
	return toastTexts(client);
}

async function addAssetToTimeline(client, name) {
	await openAssetsTab(client, "Media");
	await clickEl(
		client,
		`'+' of asset card ${name}`,
		`() => [...${ASSETS}.querySelectorAll("span.sr-only")].find((s) => s.textContent.trim() === ${JSON.stringify(name)})?.closest(".group")?.querySelector("button")`,
	);
	await sleep(700);
}

async function addDefaultText(client) {
	await openAssetsTab(client, "Text");
	await clickEl(client, "Default text '+'", () =>
		[...document.querySelectorAll("span")].find((span) => span.textContent.trim() === "Default text")?.closest(".group")?.querySelector("button"),
	);
	await sleep(700);
}

// ---------------------------------------------------------------- zaman çizelgesi
const clipsInfo = (client) =>
	client.evaluate(`(() => {
		const timeline = document.querySelector('[aria-label="Timeline"]') ?? document;
		return [...timeline.querySelectorAll(${JSON.stringify(CLIP_SELECTOR)})].map((button, index) => {
			const r = button.getBoundingClientRect();
			const outer = button.parentElement.parentElement.parentElement.parentElement;
			const path = outer.querySelector('svg[aria-hidden="true"] path[stroke-width="2"]');
			const svgRect = outer.querySelector('svg[aria-hidden="true"]')?.getBoundingClientRect();
			const d = path?.getAttribute("d") ?? "";
			const markerXs = [...d.matchAll(/M(-?\\d+)/g)].map((m) => Number(m[1]));
			const selected = !!button.parentElement.parentElement.style.boxShadow;
			return { index, name: button.innerText.trim().split("\\n")[0], x: r.x, y: r.y, w: r.width, h: r.height, outerLeft: outer.getBoundingClientRect().left, selected, beatPath: d, beatCount: markerXs.length, markerLeft: svgRect?.left ?? null, markerXs };
		});
	})()`);

async function selectClip(client, which) {
	const clips = await clipsInfo(client);
	const clip = typeof which === "number" ? clips[which] : clips.find((c) => c.name === which);
	expect(clip, `clip ${JSON.stringify(which)} not on the timeline`, { actual: clips.map((c) => c.name) });
	// Zaman çizelgesinde görünür olan bir noktaya tıkla (klip taşabilir)
	const view = await client.evaluate(`(() => { const r = document.querySelector('[aria-label="Timeline"]').getBoundingClientRect(); return { left: r.left + 130, right: r.right - 10 }; })()`);
	const x = Math.min(Math.max(clip.x + 20, view.left + 10), Math.min(clip.x + clip.w - 10, view.right - 10));
	await mouse.click(client, x, clip.y + clip.h / 2);
	await sleep(400);
	return clip;
}

// ---------------------------------------------------------------- zaman çizelgesi yakınlaştırma
const zoomButtonFinder = (which) => `() => { const s = [...document.querySelectorAll('[role="slider"]')].find((x) => !x.getAttribute("aria-label")); const root = s?.closest("span.relative.flex"); return which === "out" ? root?.previousElementSibling : root?.nextElementSibling; }`.replace("which", JSON.stringify(which));
async function zoomClip(client, which, times = 1) {
	for (let i = 0; i < times; i++) {
		await clickEl(client, `zoom ${which}`, zoomButtonFinder(which), { hoverFirst: false });
		await sleep(120);
	}
	await sleep(200);
}

// ---------------------------------------------------------------- oynatma başlığı
async function playheadTicks(client) {
	return Number(await client.evaluate(`${PLAYHEAD}?.getAttribute("aria-valuenow")`));
}
// Klavye odağı metin/slider'dan çıksın (global kısayollar çalışsın)
async function blurActive(client) {
	await client.evaluate("document.activeElement && document.activeElement !== document.body && document.activeElement.blur && document.activeElement.blur()");
}
async function seekStart(client) {
	await blurActive(client);
	await press(client, "home");
	await sleep(120);
}
// n kare ileri (ArrowRight = frame-step-forward)
async function stepFrames(client, count) {
	await blurActive(client);
	for (let i = 0; i < count; i++) await press(client, "ArrowRight");
	await sleep(150);
}
// Home + n kare: saniye cinsinden (fps=30 varsayımı, ticksPerFrame kalibrasyonuyla doğrulanır)
async function seekSeconds(client, seconds, { fps = 30 } = {}) {
	await seekStart(client);
	await stepFrames(client, Math.round(seconds * fps));
	return playheadTicks(client);
}
async function calibrateTicks(client, { fps = 30 } = {}) {
	await seekStart(client);
	const zero = await playheadTicks(client);
	await stepFrames(client, 1);
	const one = await playheadTicks(client);
	await seekStart(client);
	return { ticksPerFrame: one - zero, ticksPerSecond: (one - zero) * fps };
}

// ---------------------------------------------------------------- özellikler paneli
async function propsTab(client, label) {
	await clickEl(client, `properties tab ${label}`, `() => (${PROPS})?.querySelector('button[aria-label="${label}"]')`);
	await sleep(350);
}
const propsTabs = (client) =>
	client.evaluate(`[...((${PROPS})?.querySelectorAll('button[aria-label]') ?? [])].filter((b) => b.querySelector("svg") && !b.getAttribute("aria-haspopup")).map((b) => b.getAttribute("aria-label"))`);

// Çubuk (role=slider) durumu: değer, aralık, kutu değeri, çubuk/iz/başlık dikdörtgenleri
const sliderState = (client, label) =>
	client.evaluate(`(() => {
		const props = ${PROPS};
		const bar = props?.querySelector('[role="slider"][aria-label=${JSON.stringify(label)}]');
		const input = props?.querySelector('input[aria-label=${JSON.stringify(label)}]');
		if (!bar && !input) return null;
		const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
		const track = bar?.firstElementChild;
		const thumb = track?.lastElementChild;
		const container = bar?.parentElement ?? input?.closest(".\\\\@container");
		return {
			hasBar: !!bar,
			now: bar ? Number(bar.getAttribute("aria-valuenow")) : null,
			min: bar ? Number(bar.getAttribute("aria-valuemin")) : null,
			max: bar ? Number(bar.getAttribute("aria-valuemax")) : null,
			text: bar?.getAttribute("aria-valuetext") ?? null,
			input: input?.value ?? null,
			bar: box(bar), track: box(track), thumb: box(thumb), field: box(input?.parentElement),
			container: box(container),
			focused: !!bar && document.activeElement === bar,
		};
	})()`);

// Çubuk başlığını sürükler; to: hedef x (ekran) ya da {dx}. releaseOnEnd=false ise basılı bırakır.
async function dragSliderThumb(client, label, { dx, toX, steps = 10, releaseOnEnd = true, onStep } = {}) {
	const state = await sliderState(client, label);
	expect(state?.hasBar && state.thumb && state.thumb.w > 0, `slider "${label}" has no visible thumb`, { actual: state });
	const from = { x: state.thumb.cx, y: state.thumb.cy };
	const to = { x: toX ?? from.x + dx, y: from.y };
	await mouse.drag(client, from, to, { steps, releaseOnEnd, onStep });
	return { from, to, start: state };
}

// Sayı kutusuna yaz: gerçek tıklama (odaklar + seçer) + Input.insertText + Enter
async function typeInto(client, label, text, { enter = true } = {}) {
	const finder = `() => (${PROPS})?.querySelector('input[aria-label=${JSON.stringify(label)}]')`;
	await clickEl(client, `input ${label}`, finder);
	await client.send("Input.insertText", { text });
	if (enter) await press(client, "Enter");
	await sleep(250);
}

async function focusSlider(client, label) {
	await client.evaluate(`(${PROPS})?.querySelector('[role="slider"][aria-label=${JSON.stringify(label)}]')?.focus()`);
	await sleep(80);
}

// ---------------------------------------------------------------- panel genişliği
const panelSizes = (client) =>
	client.evaluate(`[...document.querySelectorAll('${GROUP}')].map((p) => ({ size: Number(p.getAttribute("data-panel-size")), w: p.getBoundingClientRect().width }))`);

// Özellikler paneli ile önizleme arasındaki ayırıcıyı gerçek fareyle sürükleyerek paneli hedef yüzdeye getirir
async function setPropertiesPanelPercent(client, targetPercent) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const sizes = await panelSizes(client);
		const current = sizes[2];
		const group = sizes.reduce((sum, panel) => sum + panel.w, 0) / (sizes.reduce((sum, panel) => sum + panel.size, 0) / 100);
		if (Math.abs(current.size - targetPercent) < 0.3) return { size: current.size, widthPx: current.w, attempts: attempt };
		const handle = await rectOf(client, `() => document.querySelectorAll('[data-panel-group-direction="horizontal"][data-panel-resize-handle-id]')[1]`);
		expect(handle, "no resize handle between preview and properties");
		const deltaPx = ((current.size - targetPercent) / 100) * group; // sağa sürükle = özellikler paneli küçülür
		await mouse.drag(client, { x: handle.cx, y: handle.cy }, { x: handle.cx + deltaPx, y: handle.cy }, { steps: 8, stepDelayMs: 10 });
		await sleep(250);
	}
	const sizes = await panelSizes(client);
	return { size: sizes[2].size, widthPx: sizes[2].w, attempts: 8 };
}

module.exports = {
	GROUP,
	ASSETS,
	PREVIEW,
	PROPS,
	PLAYHEAD,
	CLIP_SELECTOR,
	dismissOnboarding,
	newProject,
	waitSaved,
	openAssetsTab,
	importMedia,
	addAssetToTimeline,
	addDefaultText,
	clipsInfo,
	zoomClip,
	selectClip,
	playheadTicks,
	blurActive,
	seekStart,
	stepFrames,
	seekSeconds,
	calibrateTicks,
	propsTab,
	propsTabs,
	sliderState,
	dragSliderThumb,
	typeInto,
	focusSlider,
	panelSizes,
	setPropertiesPanelPercent,
	keyDown,
	keyUp,
};
