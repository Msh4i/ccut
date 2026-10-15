// features.js senaryosu X: gerçek Electron penceresinde dışa aktarma (MP4+AAC, WebM+Opus, iptal, hata arayüzü, okunamayan ses, çok kısa ses, sticker ön kontrolü).
// features.js çağırır: scenarioExport(ctx, deps). Kaynak medya ffmpeg ile geçici klasörde üretilir (/usr/bin/ffmpeg), depoya hiçbir şey yazılmaz.
// Yerel kaydet diyaloğu CDP'yi kilitlediği için indirme sayfa içinde yakalanır: HTMLAnchorElement.prototype.click sarmalanır, blob okunup dosyaya yazılır.
// Ölçüm yöntemi (parlama + bip): kaynakta t=2.0 sn'de 3 kare beyaz parlama ve 1 kHz bip (2.0-2.2 sn) var; çıktıda ses başlangıcı (ffprobe start_time +
// ilk örnek |x| > 0,5 tepe) ile video parlaması (ilk parlak kare) aynı yöntemle kaynakla karşılaştırılır.
// Ürün hatası = adım FAIL kalır, burada düzeltilmez.
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ed = require("./features-editor");
const lib = require("./features-lib");
const { centroidWhere, decodePng, regionDiff, regionStats } = require("./png");
const content = require("./features-content");

const { OUT, byTextFinder, clickEl, expect, notVerified, press, projectElements, readProjects, rectOf, sleep, waitFor } = lib;

const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const AAC_MARKER = "Lavc62.23.103"; // libavcodec dizgisi: yalnızca AAC işçi paketinde (@mediabunny/aac-encoder)
const STANDALONE_CHUNKS = path.join(__dirname, "../../web/.next/standalone/apps/web/.next/static/chunks");
const SOURCE_SECONDS = 6;
const FLASH_AT = 2.0;
const COMBOS = [
	{ sampleRate: 44100, layout: "stereo", name: "44100-stereo" },
	{ sampleRate: 48000, layout: "mono", name: "48000-mono" },
	{ sampleRate: 44100, layout: "mono", name: "44100-mono" },
	{ sampleRate: 48000, layout: "stereo", name: "48000-stereo" },
];

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const ms = (seconds) => round2(seconds * 1000);

// ---------------------------------------------------------------- ffmpeg / ffprobe
function run(command, args, { input, allowFail = false } = {}) {
	const result = cp.spawnSync(command, args, { input, maxBuffer: 1 << 30 });
	if (!allowFail && result.status !== 0) {
		throw new Error(`${path.basename(command)} ${args.join(" ").slice(0, 160)} failed: ${result.stderr?.toString().slice(-500)}`);
	}
	return result;
}
const ffmpeg = (args, opts) => run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], opts);
const probeJson = (file) => JSON.parse(run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).stdout.toString());
const streamOf = (probe, type) => probe.streams.find((s) => s.codec_type === type) ?? null;

// kaynak: 640x360 testsrc2 + t=2.0'da 3 kare beyaz parlama + 2.0-2.2 sn 1 kHz bip (başka yerde sessiz).
// Bip aevalsrc ile örnek doğruluğunda (volume'un enable'ı yalnızca 1024 örneklik çerçeve sınırında anahtarlar), video B-karesiz (ilk kare pts 0).
function makeSource({ file, sampleRate, layout, withAudio = true }) {
	const beep = "if(between(t\\,2\\,2.2)\\,0.5*sin(2*PI*1000*t)\\,0)";
	const exprs = layout === "stereo" ? `${beep}|${beep}` : beep;
	const inputs = ["-f", "lavfi", "-i", `testsrc2=s=640x360:r=30:d=${SOURCE_SECONDS}`];
	if (withAudio) inputs.push("-f", "lavfi", "-i", `aevalsrc=exprs=${exprs}:s=${sampleRate}:d=${SOURCE_SECONDS}`);
	ffmpeg([
		...inputs,
		"-filter_complex", "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,2,2.09)'[v]",
		"-map", "[v]", ...(withAudio ? ["-map", "1:a"] : []),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-bf", "0",
		...(withAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate)] : ["-an"]),
		file,
	]);
}

function generateExportAssets({ dir }) {
	fs.mkdirSync(dir, { recursive: true });
	const files = { sources: {} };
	for (const combo of COMBOS) {
		const file = path.join(dir, `x-${combo.name}.mp4`);
		makeSource({ file, sampleRate: combo.sampleRate, layout: combo.layout });
		files.sources[combo.name] = file;
	}
	files.silentVideo = path.join(dir, "x-silentvideo.mp4");
	makeSource({ file: files.silentVideo, sampleRate: 44100, layout: "stereo", withAudio: false });
	// 10 dk mono 44,1 kHz 16 bit WAV (~53 MB): iptal ve ses evresi ölçümü
	files.longAudio = path.join(dir, "x-long.wav");
	ffmpeg(["-f", "lavfi", "-i", "sine=f=440:r=44100:d=600", "-ac", "1", "-c:a", "pcm_s16le", files.longAudio]);
	// 2 sn ses: bozulan/silinen medya senaryosu (sessiz video + bu ses klibi)
	files.voiceAudio = path.join(dir, "x-voice.wav");
	ffmpeg(["-f", "lavfi", "-i", "sine=f=600:r=44100:d=2", "-ac", "1", "-c:a", "pcm_s16le", files.voiceAudio]);
	// 20 ms ses: 1024 örnekten (23,2 ms) kısa
	files.tinyAudio = path.join(dir, "x-tiny.wav");
	ffmpeg(["-f", "lavfi", "-i", "sine=f=1000:r=44100:d=0.02", "-ac", "1", "-c:a", "pcm_s16le", files.tinyAudio]);
	// 10 sn ses: 6 sn'lik videodan UZUN (son 4 sn'de görüntü yok = siyah kareler); önizleme bayat kare testi (X.7/X.8)
	files.tailAudio = path.join(dir, "x-tail.wav");
	ffmpeg(["-f", "lavfi", "-i", "sine=f=330:r=44100:d=10", "-ac", "1", "-c:a", "pcm_s16le", files.tailAudio]);
	files.emptyMp3 = path.join(dir, "x-empty.mp3");
	fs.writeFileSync(files.emptyMp3, Buffer.alloc(0));
	return files;
}

// Ses başlangıcı (sn): ffprobe start_time + ilk |x| > 0,5 * tepe örneği. Dönüş: { onset, start, peak, sampleRate }
function audioOnset(file, { sampleRate = 44100 } = {}) {
	const probe = probeJson(file);
	const audio = streamOf(probe, "audio");
	// Sol kanal (pan): "-ac 1" iki kanalı toplayıp 0,707 ile çarpar, mono kaynak (0,5) ile stereo çıktı (0,71) karşılaştırılamaz
	const result = run(FFMPEG, ["-v", "error", "-i", file, "-vn", "-af", "pan=mono|c0=c0", "-ar", String(sampleRate), "-f", "f32le", "-"]);
	const bytes = result.stdout;
	const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 4)));
	let peak = 0;
	for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
	let index = -1;
	let last = -1;
	for (let i = 0; i < pcm.length; i++) {
		if (Math.abs(pcm[i]) > 0.5 * peak) {
			if (index < 0) index = i;
			last = i;
		}
	}
	// beep'ten ÖNCE (0..1,9 sn) sessizlik: ortalama |x| tepenin %2'sinin altında olmalı (gürültü/çöp yok)
	const preEnd = Math.min(pcm.length, Math.floor(1.9 * sampleRate));
	let preSum = 0;
	for (let i = 0; i < preEnd; i++) preSum += Math.abs(pcm[i]);
	const start = Number(audio?.start_time ?? 0);
	return {
		onset: index < 0 ? null : start + index / sampleRate,
		beepSeconds: index < 0 ? null : (last - index) / sampleRate,
		preSilenceRatio: peak > 0 ? preSum / Math.max(1, preEnd) / peak : null,
		start,
		peak: round2(peak),
		decodedSeconds: pcm.length / sampleRate,
	};
}

// İlk parlak kare ve parlak kare sayısı: 32x18 gri küçük resimlerin ortalaması (testsrc2 ~orta gri, parlama = beyaz)
function flashTimes(file) {
	const times = run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file])
		.stdout.toString().split("\n").map((line) => Number.parseFloat(line)).filter((n) => Number.isFinite(n));
	const raw = run(FFMPEG, ["-v", "error", "-i", file, "-an", "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "-"]).stdout;
	const frameBytes = 32 * 18;
	const frames = Math.floor(raw.length / frameBytes);
	const bright = [];
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let i = 0; i < frameBytes; i++) sum += raw[f * frameBytes + i];
		if (sum / frameBytes > 200) bright.push(f);
	}
	return { frames, ptsCount: times.length, flashFrames: bright.length, firstFlash: bright.length ? (times[bright[0]] ?? bright[0] / 30) : null, firstFlashFrame: bright[0] ?? null };
}

// Dışa aktarılan dosyanın kareleri tek tek çözülür mü ("-xerror": ilk hatada çık)
function decodeClean(file) {
	const result = run(FFMPEG, ["-xerror", "-v", "error", "-i", file, "-f", "null", "-"], { allowFail: true });
	return { ok: result.status === 0 && result.stderr.length === 0, status: result.status, stderr: result.stderr.toString().slice(0, 300) };
}

// Tek kare (PNG) çıkar: png.js ile piksellere bak
function frameAt(file, seconds) {
	const png = run(FFMPEG, ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]).stdout;
	return { png, image: decodePng(png) };
}

// Kare kare uygunluk: çıktı karesi i için kaynağın [i-12, i+12] aralığındaki en iyi eşleşen karesi (64x36 gri, ortalama mutlak fark).
// Kayıplı kodlama gürültüsü ~2-3 (en iyi eşleşme farkı), komşu kareler testsrc2 sayaç/hareket alanlarında bundan çok daha farklı. "Kaymış" kare = en iyi eşleşme i değil.
function frameFidelity(outFile, srcFile, { w = 64, h = 36, reach = 12 } = {}) {
	const decode = (file) => run(FFMPEG, ["-v", "error", "-i", file, "-an", "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"]).stdout;
	const a = decode(outFile);
	const b = decode(srcFile);
	const size = w * h;
	const n = Math.min(Math.floor(a.length / size), Math.floor(b.length / size));
	const off = [];
	let worstBest = 0;
	for (let f = 0; f < n; f++) {
		let bestJ = -1;
		let best = Infinity;
		let own = Infinity;
		for (let j = Math.max(0, f - reach); j <= Math.min(n - 1, f + reach); j++) {
			let diff = 0;
			for (let i = 0; i < size; i++) diff += Math.abs(a[f * size + i] - b[j * size + i]);
			diff /= size;
			if (j === f) own = diff;
			if (diff < best) {
				best = diff;
				bestJ = j;
			}
		}
		worstBest = Math.max(worstBest, best);
		// identical source frames (the 3 white flash frames) tie: a frame is only "off" when its OWN source frame is clearly worse than the best match
		if (bestJ !== f && own - best > 1) off.push(`${f}->${bestJ}`);
	}
	return { compared: n, offFrames: off.length, first: off.slice(0, 8), worstBestMatchDiff: round1(worstBest) };
}

// ---------------------------------------------------------------- süreç belleği
function treeRssMB(pid) {
	const rows = cp.execFileSync("ps", ["-eo", "pid=,ppid=,rss="]).toString().trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
	const children = new Map();
	for (const [p, parent, rss] of rows) {
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent).push({ p, rss });
	}
	let total = 0;
	const stack = [pid];
	const self = rows.find((row) => row[0] === pid);
	if (self) total += self[2];
	for (let guard = 0; stack.length && guard < 500; guard++) {
		for (const child of children.get(stack.pop()) ?? []) {
			total += child.rss;
			stack.push(child.p);
		}
	}
	return Math.round(total / 1024);
}

// ---------------------------------------------------------------- sayfa kancası: indirme yakalama
const DOWNLOAD_HOOK = `(() => {
	if (window.__ccutHook) return;
	window.__ccutHook = true;
	window.__ccutDownloads = [];
	const originalClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (this.download) {
			// blob adresi bu çağrı içinde çözülür: dışa aktarma kodunun hemen ardından yaptığı revokeObjectURL onu bozmaz
			window.__ccutDownloads.push({ name: this.download, href: this.href, blob: fetch(this.href).then((r) => r.blob()), at: performance.now() });
			return;
		}
		return originalClick.call(this);
	};
})()`;

async function installHook(client) {
	await client.send("Page.addScriptToEvaluateOnNewDocument", { source: DOWNLOAD_HOOK });
	await client.evaluate(DOWNLOAD_HOOK);
}

async function readDownload(client, index) {
	const meta = await client.evaluate(`(async () => {
		const d = window.__ccutDownloads[${index}];
		const blob = await d.blob;
		window.__ccutRead = new Uint8Array(await blob.arrayBuffer());
		return { name: d.name, size: blob.size, type: blob.type };
	})()`);
	const parts = [];
	const step = 1_500_000;
	for (let offset = 0; offset < meta.size; offset += step) {
		const b64 = await client.evaluate(`(() => {
			const a = window.__ccutRead.subarray(${offset}, ${offset + step});
			let s = "";
			for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
			return btoa(s);
		})()`);
		parts.push(Buffer.from(b64, "base64"));
	}
	await client.evaluate("window.__ccutRead = null");
	return { ...meta, buffer: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- dışa aktarma penceresi
const POPOVER = `[...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find((w) => /Export project|Exporting project|Export failed/.test(w.innerText))`;
const popoverState = (client) =>
	client.evaluate(`(() => {
		const w = ${POPOVER};
		const text = (w?.innerText ?? "").replace(/\\s+/g, " ").trim();
		const pct = /Exporting project (\\d+)%/.exec(text)?.[1];
		return { open: !!w, text: text.slice(0, 600), view: !w ? null : /Export failed/.test(text) ? "error" : /Exporting project/.test(text) ? "exporting" : "settings", pct: pct === undefined ? null : Number(pct), downloads: window.__ccutDownloads?.length ?? 0 };
	})()`);
const inPopover = (selector) => `() => (${POPOVER})?.querySelector(${JSON.stringify(selector)})`;
const popoverButton = (text) => byTextFinder("button", text, `(${POPOVER})`);

// Açılır kutunun konumu/boyutu 250 ms değişmeden dursun: animasyon sürerken basılan tık yanlış yere düşebilir
async function settlePopover(client, { timeoutMs = 4000 } = {}) {
	let previous = null;
	let since = Date.now();
	const deadline = Date.now() + timeoutMs;
	for (let i = 0; i < 80 && Date.now() < deadline; i++) {
		const rect = await client.evaluate(`(() => { const w = ${POPOVER}; if (!w) return null; const r = w.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10).join(","); })()`);
		if (rect !== previous) {
			previous = rect;
			since = Date.now();
		} else if (rect && Date.now() - since >= 250) return rect;
		await sleep(50);
	}
	throw new Error(`export popover geometry did not settle (last ${previous})`);
}

async function openExport(client) {
	const state = await popoverState(client);
	if (!state.open) {
		await clickEl(client, "header Export button", byTextFinder("header button", "Export"));
		await waitFor("export popover", async () => (await popoverState(client)).open, { timeoutMs: 8000 });
		await settlePopover(client);
	}
	if ((await popoverState(client)).view === "error") {
		await clickEl(client, "Back to export settings", popoverButton("Back to export settings"));
		await waitFor("settings view", async () => (await popoverState(client)).view === "settings", { timeoutMs: 5000 });
	}
}

async function setExportOptions(client, { format, includeAudio }) {
	await openExport(client);
	// Daraltılmış bölümün içeriği DOM'da ama 0 yükseklikli kapta kırpılır: görünürlük = merkez noktadaki öğe kendisi
	const visible = (selector) =>
		client.evaluate(`(() => { const el = (${inPopover(selector)})(); if (!el) return false; const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return top === el || el.contains(top); })()`);
	// Bölüm açık mı: başlık satırındaki ok düğmesinin etiketi ("Collapse section" = açık, "Expand section" = kapalı)
	const sectionLabel = (title) =>
		client.evaluate(`(() => { const w = ${POPOVER}; const b = [...(w?.querySelectorAll("button") ?? [])].find((x) => x.innerText.trim() === ${JSON.stringify(title)}); return b?.closest("div.flex.h-11")?.querySelector('button[aria-label$=" section"]')?.getAttribute("aria-label") ?? null; })()`);
	const ensureSection = async (title, selector) => {
		let last = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (await visible(selector)) return;
			last = await sectionLabel(title);
			if (last === "Collapse section") {
				await sleep(300); // açık, animasyon sürüyor
				continue;
			}
			await settlePopover(client);
			await client.evaluate(`(() => { const w = ${POPOVER}; if (w) w.dataset.xmark = "1"; })()`);
			await clickEl(client, `section ${title}`, popoverButton(title));
			await sleep(350);
		}
		if (await visible(selector)) return;
		const remounted = await client.evaluate(`(() => { const w = ${POPOVER}; return w ? w.dataset.xmark !== "1" : null; })()`);
		throw new Error(`${title} section did not open after 3 clicks (chevron "${last}", popover remounted since the click: ${remounted})`);
	};
	await ensureSection("Format", `#${format}`);
	if ((await client.evaluate(`(${inPopover(`#${format}`)})().getAttribute("aria-checked")`)) !== "true") {
		await clickEl(client, `${format} radio`, inPopover(`#${format}`));
	}
	await ensureSection("Audio", "#include-audio");
	const checked = (await client.evaluate(`(${inPopover("#include-audio")})().getAttribute("aria-checked")`)) === "true";
	if (checked !== includeAudio) await clickEl(client, "Include audio checkbox", inPopover("#include-audio"));
	await settlePopover(client);
	const now = await client.evaluate(`({ format: (${inPopover(`#${format}`)})().getAttribute("aria-checked"), audio: (${inPopover("#include-audio")})().getAttribute("aria-checked") })`);
	expect(now.format === "true" && now.audio === String(includeAudio), "export options did not take", { expected: { format, includeAudio }, actual: now });
}

// Export düğmesine basar, sonuç gelene dek yoklar. Dönüş: { outcome: "success"|"error"|"timeout", ms, samples[{ms,pct,view}], errorText, download? }
async function runExport(ctx, { timeoutMs = 90_000, saveAs = null, onTick = null, stop = null, pollMs = 100, readOnSuccess = true } = {}) {
	const { client } = ctx;
	const before = (await popoverState(client)).downloads;
	const popoverRect = await settlePopover(client);
	const t0 = Date.now();
	const clicked = await clickEl(client, "popover Export", popoverButton("Export"));
	const samples = [];
	let last = null;
	let outcome = "timeout";
	let errorText = null;
	const maxPolls = Math.ceil(timeoutMs / pollMs);
	for (let i = 0; i < maxPolls; i++) {
		const state = await popoverState(client);
		const key = `${state.view}|${state.pct}`;
		if (key !== last) {
			samples.push({ ms: Date.now() - t0, pct: state.pct, view: state.view });
			last = key;
		}
		if (onTick) await onTick(state, Date.now() - t0);
		if (stop) {
			const reason = await stop(state, Date.now() - t0);
			if (reason) {
				outcome = reason;
				break;
			}
		}
		if (state.downloads > before) {
			outcome = "success";
			break;
		}
		if (state.view === "error") {
			outcome = "error";
			errorText = state.text;
			break;
		}
		await sleep(pollMs);
	}
	const result = { outcome, ms: Date.now() - t0, samples, errorText, downloadsAfter: (await popoverState(client)).downloads - before, click: { x: Math.round(clicked.x), y: Math.round(clicked.y), popoverRect } };
	if (outcome === "success" && readOnSuccess) {
		result.download = await readDownload(client, before);
		if (saveAs) {
			result.file = path.join(OUT, saveAs);
			fs.writeFileSync(result.file, result.download.buffer);
		}
	}
	return result;
}

// İçe aktarma süreleri: ed.importMedia 60 sn'de vazgeçer; burada 180 sn beklenir ve yavaş içe aktarmalar (> 15 sn) kaydedilir
// (tam koşuda küçük dosyaların "Processing your files (0%)" ekranında ~60 sn kaldığı görüldü)
const slowImports = [];
async function importTimed(ctx, files) {
	const { client } = ctx;
	const names = files.map((file) => path.basename(file));
	await ed.openAssetsTab(client, "Media");
	const t0 = Date.now();
	await lib.chooseFiles(client, files, () => clickEl(client, "Import button", byTextFinder("button", "Import", ed.ASSETS)));
	await waitFor(
		`asset cards ${names.join(", ")}`,
		() => client.evaluate(`(() => { const have = [...${ed.ASSETS}.querySelectorAll("span.sr-only")].map((s) => s.textContent.trim()); return ${JSON.stringify(names)}.every((n) => have.includes(n)); })()`),
		{ timeoutMs: 180_000 },
	);
	const took = Date.now() - t0;
	if (took > 15_000) {
		slowImports.push({ names, ms: took, visibility: await client.evaluate("document.visibilityState"), hasFocus: await client.evaluate("document.hasFocus()") });
	}
	return took;
}

async function importAndPlace(ctx, file) {
	const name = path.basename(file);
	await ed.newProject(ctx.client);
	await importTimed(ctx, [file]);
	await ed.addAssetToTimeline(ctx.client, name);
	await sleep(800);
	return name;
}

// Sayfayı taze belgeyle aç (AAC bölümü modül durumu sıfırlanır). Dönüş: bu belgenin istek dizini
async function freshDocument(ctx) {
	await ed.waitSaved(ctx.client, readProjects, { timeoutMs: 8000 }).catch(() => {});
	await ctx.client.send("Page.navigate", { url: "ccut://app/projects" });
	await waitFor("projects page", () => ctx.client.evaluate('location.pathname === "/projects" && document.readyState === "complete"').catch(() => false), { timeoutMs: 30_000 });
	await sleep(500);
	return ctx.requests.length;
}

const aacRequests = (ctx, chunkName, from = 0) => ctx.requests.slice(from).filter((url) => url.includes(chunkName));

// Beklenen (kasıtlı yaratılmış) hatalar: F.1'in "0 sorun" sayacından çıkarılır, adımda ayrıca doğrulanır. Dönüş: çıkarılanlar
function takeProblems(ctx, from, predicate) {
	const taken = [];
	for (let i = ctx.problems.length - 1; i >= from; i--) {
		if (predicate(ctx.problems[i])) taken.unshift(...ctx.problems.splice(i, 1));
	}
	return taken;
}

// Proje kaydındaki (IndexedDB) bir sticker öğesinin kimliğini değiştirir (editör açıkken DEĞİL: otomatik kayıt ezerdi)
const setStickerId = (client, projectId, elementName, stickerId) =>
	client.evaluate(`(async () => {
		const open = indexedDB.open("video-editor-projects");
		const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
		const tx = db.transaction("projects", "readwrite");
		const store = tx.objectStore("projects");
		const record = await new Promise((resolve, reject) => { const get = store.get(${JSON.stringify(projectId)}); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
		let changed = 0;
		for (const scene of record.scenes) {
			const t = scene.tracks;
			for (const track of [...t.overlay, t.main, ...t.audio]) {
				for (const el of track.elements) {
					if (el.type === "sticker" && el.name === ${JSON.stringify(elementName)}) { el.stickerId = ${JSON.stringify(stickerId)}; changed++; }
				}
			}
		}
		await new Promise((resolve, reject) => { const put = store.put(record); put.onsuccess = () => resolve(); put.onerror = () => reject(put.error); });
		await new Promise((resolve) => { tx.oncomplete = () => resolve(); });
		db.close();
		return changed;
	})()`);

// Kayıtlı medya dosyalarının en küçüğünü (ses) bozar: "zero-fill" aynı boyutta sıfırlar, "truncate-0" 0 bayta indirir, "delete" dosyayı kaldırır. /projects sayfasında çağrılır.
const corruptStoredMedia = (client, projectId, variant) =>
	client.evaluate(`(async () => {
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle("media-files-${projectId}");
		const files = [];
		for await (const [name, handle] of dir.entries()) files.push({ name, size: (await handle.getFile()).size });
		files.sort((a, b) => a.size - b.size);
		const target = files[0];
		if (${JSON.stringify(variant)} === "delete") {
			await dir.removeEntry(target.name);
		} else {
			const writable = await (await dir.getFileHandle(target.name)).createWritable();
			if (${JSON.stringify(variant)} === "zero-fill") await writable.write(new Uint8Array(target.size));
			else await writable.truncate(0);
			await writable.close();
		}
		return { files, target };
	})()`);

// Sessiz video + 2 sn ses klibi olan proje; ses dosyası bozulur; proje yeniden açılır. Dönüş: { projectId, stored }
async function brokenAudioProject(ctx, deps, state, variant) {
	const { client } = ctx;
	await freshDocument(ctx);
	await ed.newProject(client);
	await importTimed(ctx, [state.assets.silentVideo, state.assets.voiceAudio]);
	await ed.addAssetToTimeline(client, "x-silentvideo.mp4");
	await ed.addAssetToTimeline(client, "x-voice.wav");
	await sleep(800);
	expect((await ed.clipsInfo(client)).length === 2, "video and audio clips are not both on the timeline");
	await ed.waitSaved(client, readProjects);
	const projectId = await client.evaluate("location.pathname.split('/').pop()");
	await freshDocument(ctx);
	const stored = await corruptStoredMedia(client, projectId, variant);
	await deps.reopenProject(ctx, projectId);
	return { projectId, stored };
}

const inspectOutput = (result) => {
	const probe = probeJson(result.file);
	return { streams: probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`), decode: decodeClean(result.file) };
};

// ---------------------------------------------------------------- senaryo
async function scenarioExport(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-export-assets-"));
	const problemsFrom = ctx.problems.length;
	const consoleLog = [];
	client.on("Runtime.consoleAPICalled", ({ type, args }) => consoleLog.push({ type, text: args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300) }));
	const state = { chunk: null, assets: null, sourceOnsets: {}, exports: {} };
	const unwantedConsole = () => consoleLog.filter((entry) => /loaded twice|already registered|Audio encoder already/i.test(entry.text));

	slowImports.length = 0;
	// Pencere odağı/görünürlüğü yüzünden ortam kısılmasın (CDP odak öykünmesi)
	await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
	try {
		await R.step("X.0", "setup: sources (flash + beep, 44.1/48 kHz x mono/stereo, silent video, 10 min audio, 20 ms audio), AAC chunk found, download hook installed", async () => {
			await installHook(client);
			state.assets = generateExportAssets({ dir });
			const chunkFiles = fs.readdirSync(STANDALONE_CHUNKS).filter((name) => name.endsWith(".js"));
			const holders = chunkFiles.filter((name) => fs.readFileSync(path.join(STANDALONE_CHUNKS, name)).includes(AAC_MARKER));
			expect(holders.length === 1, `expected exactly one chunk holding ${AAC_MARKER}`, { actual: holders });
			state.chunk = { name: holders[0], bytes: fs.statSync(path.join(STANDALONE_CHUNKS, holders[0])).size };
			const sizes = chunkFiles.map((name) => ({ name, bytes: fs.statSync(path.join(STANDALONE_CHUNKS, name)).size })).sort((a, b) => b.bytes - a.bytes);
			const others = sizes.filter((s) => s.name !== state.chunk.name);
			R.metric("X.chunks", { aacChunk: state.chunk, largestOtherChunks: others.slice(0, 3), chunkCount: chunkFiles.length });
			expect(others.every((s) => s.bytes < state.chunk.bytes * 1.4), "unexpected: a chunk far larger than the AAC chunk (AAC may have merged into another chunk)", { actual: others.slice(0, 3) });
			// kaynakların ses başlangıcı (aynı yöntem, dışa aktarılanla karşılaştırmak için)
			for (const combo of COMBOS) {
				const src = state.assets.sources[combo.name];
				const probe = probeJson(src);
				state.sourceOnsets[combo.name] = { ...audioOnset(src), flash: flashTimes(src), audio: streamOf(probe, "audio") && { codec: streamOf(probe, "audio").codec_name, rate: streamOf(probe, "audio").sample_rate, channels: streamOf(probe, "audio").channels } };
				const s = state.sourceOnsets[combo.name];
				expect(s.onset !== null && Math.abs(s.onset - FLASH_AT) < 0.003, `source ${combo.name}: beep onset is not at 2.000 s (the measuring method or the source is wrong)`, { actual: s });
				expect(s.flash.flashFrames === 3 && Math.abs(s.flash.firstFlash - FLASH_AT) < 0.002, `source ${combo.name}: flash is not 3 frames at 2.0 s`, { actual: s.flash });
			}
			return { aacChunk: `${state.chunk.name} (${state.chunk.bytes} bytes)`, sourceOnsetSeconds: Object.fromEntries(COMBOS.map((c) => [c.name, round1(state.sourceOnsets[c.name].onset * 1000) / 1000])) };
		});
		expect(state.assets && state.chunk, "setup did not finish");

		// ------------------------------------------------ X.1 gerçek AAC
		let firstDocFrom = 0;
		for (const [index, combo] of COMBOS.entries()) {
			await R.step(`X.1.${index + 1}`, `MP4+audio from a ${combo.sampleRate / 1000} kHz ${combo.layout} source: real AAC-LC, decodes clean, audio onset within 5 ms of the source, audio 0..23.2 ms longer than video`, async () => {
				const from = await freshDocument(ctx);
				if (index === 0) firstDocFrom = from;
				const name = await importAndPlace(ctx, state.assets.sources[combo.name]);
				await setExportOptions(client, { format: "mp4", includeAudio: true });
				const problemsBefore = ctx.problems.length;
				const result = await runExport(ctx, { saveAs: `X1-${combo.name}.mp4` });
				state.exports[combo.name] = result;
				expect(result.outcome === "success", `MP4+audio export did not succeed (${result.outcome})`, { actual: { errorText: result.errorText, samples: result.samples.slice(-4) } });
				const probe = probeJson(result.file);
				const audio = streamOf(probe, "audio");
				const video = streamOf(probe, "video");
				const decode = decodeClean(result.file);
				const out = audioOnset(result.file);
				const flash = flashTimes(result.file);
				const src = state.sourceOnsets[combo.name];
				const delta = out.onset - src.onset;
				const durationGap = Number(audio?.duration) - Number(video?.duration);
				const newProblems = ctx.problems.slice(problemsBefore);
				R.metric(`X.1.${combo.name}`, {
					exportMs: result.ms, bytes: result.download.size, audio: audio && { codec: audio.codec_name, profile: audio.profile, rate: audio.sample_rate, channels: audio.channels, startTime: audio.start_time, duration: audio.duration },
					video: video && { codec: video.codec_name, size: `${video.width}x${video.height}`, duration: video.duration },
					beepMs: { out: ms(out.beepSeconds), src: ms(src.beepSeconds) }, peak: { out: out.peak, src: src.peak }, preSilenceRatio: round2(out.preSilenceRatio),
					onsetOut: round2(out.onset * 1000), onsetSrc: round2(src.onset * 1000), onsetDeltaMs: ms(delta), flash, avSkewOutMs: ms(out.onset - flash.firstFlash), avSkewSrcMs: ms(src.onset - src.flash.firstFlash), audioMinusVideoMs: ms(durationGap),
				});
				expect(audio && audio.codec_name === "aac" && audio.profile === "LC", "audio is not AAC-LC", { actual: audio && { codec: audio.codec_name, profile: audio.profile } });
				expect(!probe.streams.some((s) => s.codec_name === "opus"), "an Opus stream is in the MP4", { actual: probe.streams.map((s) => s.codec_name) });
				expect(video && video.codec_name === "h264", "video is not H.264", { actual: video?.codec_name });
				expect(decode.ok, "ffmpeg -xerror reports decode errors", { actual: decode });
				expect(Math.abs(delta) <= 0.005, `audio onset differs from the source by ${ms(delta)} ms (limit 5 ms)`, { expected: "|delta| <= 5 ms", actual: { out: out.onset, src: src.onset } });
				// içerik gerçekten kaynağın bip'i mi: süre aynı (zaman uzatma yok), seviye aynı, öncesi sessiz
				expect(Math.abs(out.beepSeconds - src.beepSeconds) <= 0.006, `the beep is ${ms(out.beepSeconds)} ms long, the source's ${ms(src.beepSeconds)} ms`, { actual: { out: out.beepSeconds, src: src.beepSeconds } });
				expect(out.peak / src.peak > 0.8 && out.peak / src.peak < 1.2, "exported audio level differs from the source", { actual: { out: out.peak, src: src.peak } });
				expect(out.preSilenceRatio < 0.02, "the exported audio has noise before the beep", { actual: out.preSilenceRatio });
				expect(durationGap >= -0.0005 && durationGap <= 0.0232 + 0.0005, `audio is ${ms(durationGap)} ms longer than the video (expected 0..23.2 ms)`, { actual: { audio: audio?.duration, video: video?.duration } });
				expect(flash.flashFrames === 3 && Math.abs(flash.firstFlash - FLASH_AT) < 0.002, "the 3-frame flash moved or changed length in the export", { actual: flash });
				expect(newProblems.length === 0, "console/network problems during the export", { actual: newProblems.slice(0, 3) });
				return { name, exportMs: result.ms, audio: `${audio.codec_name}/${audio.profile} ${audio.sample_rate} Hz ${audio.channels} ch`, onsetDeltaMs: ms(delta), audioMinusVideoMs: ms(durationGap), avSkewMs: `${ms(out.onset - flash.firstFlash)} (source ${ms(src.onset - src.flash.firstFlash)})` };
			}, { timeoutMs: 150_000 });
		}

		await R.step("X.1.5", "AAC worker opens in the CSP window: no exception, no 'loaded twice' / 'already registered' in the console, AAC chunk fetched once per document", async () => {
			const bad = unwantedConsole();
			const exceptions = ctx.problems.slice(problemsFrom).filter((p) => p.kind === "exception");
			const csp = ctx.problems.slice(problemsFrom).filter((p) => /content security policy|refused to/i.test(`${p.text} ${p.url ?? ""}`));
			const fetched = aacRequests(ctx, state.chunk.name, firstDocFrom);
			R.metric("X.aacChunkRequests", { totalAcrossFourDocuments: fetched.length, urls: [...new Set(fetched)].map((u) => u.replace("ccut://app", "")) });
			expect(bad.length === 0, "the console says the encoder was loaded/registered twice", { actual: bad.slice(0, 3) });
			expect(exceptions.length === 0 && csp.length === 0, "exceptions or CSP violations", { actual: [...exceptions, ...csp].slice(0, 3) });
			expect(fetched.length === COMBOS.length, "AAC chunk should be fetched exactly once per fresh document (4 documents)", { expected: COMBOS.length, actual: fetched.length });
			return { consoleEntries: consoleLog.length, aacChunkFetches: fetched.length };
		});

		await R.step("X.1.6", "second MP4+audio export in the same document does not fetch the AAC chunk again", async () => {
			const from = await freshDocument(ctx);
			await importAndPlace(ctx, state.assets.sources["44100-stereo"]);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const first = await runExport(ctx);
			expect(first.outcome === "success", "first export failed", { actual: first.errorText });
			const afterFirst = aacRequests(ctx, state.chunk.name, from).length;
			await openExport(client);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const second = await runExport(ctx);
			expect(second.outcome === "success", "second export failed", { actual: second.errorText });
			const afterSecond = aacRequests(ctx, state.chunk.name, from).length;
			// 5 % = AAC ön yoklaması (chunk + kayıt + 1 sn deneme kodlaması) bitti: ilk ve ikinci dışa aktarmada bu süre
			const to5 = (run) => run.samples.find((s) => s.pct !== null && s.pct >= 5)?.ms ?? null;
			R.metric("X.secondExport", { firstMs: first.ms, secondMs: second.ms, firstAacPreflightMs: to5(first), secondAacPreflightMs: to5(second), chunkFetchesAfterFirst: afterFirst, chunkFetchesAfterSecond: afterSecond, bytes: [first.download.size, second.download.size] });
			expect(afterFirst === 1 && afterSecond === 1, "AAC chunk fetched again by the second export", { expected: "1 then 1", actual: `${afterFirst} then ${afterSecond}` });
			return { firstMs: first.ms, secondMs: second.ms, aacPreflightMs: `${to5(first)} (first, loads chunk + trial encode) vs ${to5(second)} (second)`, chunkFetches: `${afterFirst} -> ${afterSecond}` };
		}, { timeoutMs: 200_000 });

		await R.step("X.1.7", "WebM+audio = VP9 + Opus and the AAC chunk is NOT fetched; a silent project exports to MP4 and WebM without it too", async () => {
			const from = await freshDocument(ctx);
			await importAndPlace(ctx, state.assets.sources["44100-stereo"]);
			await setExportOptions(client, { format: "webm", includeAudio: true });
			const webm = await runExport(ctx, { saveAs: "X1-webm.webm" });
			expect(webm.outcome === "success", "WebM export failed", { actual: webm.errorText });
			const probe = probeJson(webm.file);
			const codecs = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`);
			const decode = decodeClean(webm.file);
			expect(codecs.includes("video:vp9") && codecs.includes("audio:opus"), "WebM is not vp9 + opus", { actual: codecs });
			expect(decode.ok, "WebM does not decode clean", { actual: decode });
			// sessiz proje: MP4 ve WebM
			await importAndPlace(ctx, state.assets.silentVideo);
			const silent = {};
			for (const format of ["mp4", "webm"]) {
				await setExportOptions(client, { format, includeAudio: true });
				silent[format] = await runExport(ctx, { saveAs: `X1-silent.${format}` });
				expect(silent[format].outcome === "success", `silent ${format} export failed`, { actual: silent[format].errorText });
			}
			const streams = Object.fromEntries(Object.entries(silent).map(([format, r]) => [format, probeJson(r.file).streams.map((s) => `${s.codec_type}:${s.codec_name}`)]));
			const chunk = aacRequests(ctx, state.chunk.name, from);
			expect(chunk.length === 0, "the AAC chunk was fetched although no AAC audio was needed", { actual: chunk });
			return { webm: codecs, silent: streams, aacChunkFetches: 0 };
		}, { timeoutMs: 200_000 });

		// ------------------------------------------------ X.2 iptal (10 dk ses)
		const pid = ctx.app.child.pid;
		const cancelRun = async ({ cancelAtPct, label }) => {
			await freshDocument(ctx);
			await ed.newProject(client);
			await importTimed(ctx, [state.assets.longAudio]);
			await ed.addAssetToTimeline(client, "x-long.wav");
			await sleep(1000);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const rssBefore = treeRssMB(pid);
			let rssPeak = rssBefore;
			let cancelClickedAt = null;
			let pctAtCancel = null;
			const result = await runExport(ctx, {
				timeoutMs: 240_000,
				pollMs: 50,
				readOnSuccess: false,
				stop: async (popover) => {
					rssPeak = Math.max(rssPeak, treeRssMB(pid));
					if (cancelClickedAt === null && popover.view === "exporting" && popover.pct !== null && popover.pct >= cancelAtPct) {
						await clickEl(client, "Cancel", popoverButton("Cancel"));
						cancelClickedAt = Date.now();
						pctAtCancel = popover.pct;
					}
					if (cancelClickedAt !== null && popover.view === "settings") return "cancelled";
					return null;
				},
			});
			const settledAt = Date.now();
			await sleep(1500);
			const after = await popoverState(client);
			const sampleAt = (predicate) => result.samples.find(predicate)?.ms ?? null;
			const timeline = {
				audioPhaseStartMs: sampleAt((x) => x.pct !== null && x.pct > 5),
				pct8Ms: sampleAt((x) => x.pct !== null && x.pct >= 8),
				pct14Ms: sampleAt((x) => x.pct !== null && x.pct >= 14),
				pct15Ms: sampleAt((x) => x.pct !== null && x.pct >= 15),
			};
			R.metric(`X.2.${label}`, { cancelAtPct, pctAtCancel, cancelLatencyMs: cancelClickedAt === null ? null : settledAt - cancelClickedAt, rssBeforeMB: rssBefore, rssPeakMB: rssPeak, pctSteps: result.samples.map((x) => x.pct).filter((x) => x !== null), timeline, downloadsAfter: after.downloads });
			return { result, cancelClickedAt, settledAt, pctAtCancel, rssBefore, rssPeak, timeline, after };
		};

		await R.step("X.2a", "10 min audio, MP4+audio: Cancel in the AAC audio phase (progress ~8%) stops within ~1 s, progress moved during the phase, no download, back to settings", async () => {
			const run = await cancelRun({ cancelAtPct: 8, label: "midAudio" });
			expect(run.cancelClickedAt !== null, "the export never reached 8% (no audio-phase progress to cancel at)", { actual: run.result.samples.slice(-5) });
			const steps = run.result.samples.map((x) => x.pct).filter((x) => x !== null);
			expect(new Set(steps).size >= 3, "the progress bar did not move in the audio phase", { actual: steps });
			expect(run.pctAtCancel >= 8 && run.pctAtCancel <= 14, "cancel was not in the AAC audio phase (5-14.5%)", { actual: run.pctAtCancel });
			expect(run.result.outcome === "cancelled", `the export did not return to the settings view after Cancel (${run.result.outcome})`, { actual: run.result.samples.slice(-3) });
			const latency = run.settledAt - run.cancelClickedAt;
			expect(latency <= 1000, `cancel took ${latency} ms to take effect (limit 1000 ms)`, { expected: "<= 1000 ms", actual: latency });
			expect(run.after.downloads === 0 && run.after.view === "settings", "a download appeared or the view is wrong after cancel", { actual: run.after });
			return { cancelLatencyMs: latency, pctAtCancel: run.pctAtCancel, progressSteps: steps.join(" -> "), peakTotalRssMB: run.rssPeak, baselineRssMB: run.rssBefore };
		}, { timeoutMs: 320_000 });

		await R.step("X.2b", "10 min audio: measured audio-phase duration and peak process RSS (cancelled at the start of the frame phase, no download)", async () => {
			const run = await cancelRun({ cancelAtPct: 15, label: "audioPhase" });
			expect(run.cancelClickedAt !== null, "the export never reached 15%: the audio phase did not finish", { actual: run.result.samples.slice(-5) });
			const t = run.timeline;
			expect(run.result.outcome === "cancelled" && run.after.downloads === 0, "cancel at the end of the audio phase did not return to settings cleanly", { actual: { outcome: run.result.outcome, after: run.after } });
			const audioMs = t.pct15Ms - t.audioPhaseStartMs;
			return { mixPhaseMs: t.audioPhaseStartMs, audioEncodePhaseMs: audioMs, audioPhaseSecondsPerAudioMinute: round1(audioMs / 1000 / 10), peakTotalRssMB: run.rssPeak, baselineRssMB: run.rssBefore, deltaRssMB: run.rssPeak - run.rssBefore, cancelLatencyMs: run.settledAt - run.cancelClickedAt };
		}, { timeoutMs: 320_000 });

		// ------------------------------------------------ X.3 hata arayüzü (AAC chunk engelli)
		await R.step("X.3a", "AAC chunk blocked: MP4+audio shows 'Export failed ... The AAC audio encoder could not start ... AAC_UNAVAILABLE', no download, 'Back to export settings' returns to the settings", async () => {
			const from = await freshDocument(ctx);
			const problemsFrom2 = ctx.problems.length;
			await importAndPlace(ctx, state.assets.sources["44100-stereo"]);
			await client.send("Network.setBlockedURLs", { urls: [`*${state.chunk.name}`] });
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { readOnSuccess: false });
			state.blockedFrom = from;
			expect(result.outcome === "error", `expected the export to fail (${result.outcome})`, { actual: result.samples.slice(-3) });
			await ctx.shoot("X3a-error-view");
			const text = result.errorText;
			expect(/The AAC audio encoder could not start/.test(text) && /AAC_UNAVAILABLE/.test(text), "error text lacks 'The AAC audio encoder could not start' / AAC_UNAVAILABLE", { actual: text });
			expect(/loading the encoder/.test(text), "the failure stage is not 'loading the encoder'", { actual: text });
			expect(result.downloadsAfter === 0, "a file was downloaded although the export failed", { actual: result.downloadsAfter });
			const buttons = await client.evaluate(`[...(${POPOVER}).querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean)`);
			expect(["Copy", "Retry", "Back to export settings"].every((b) => buttons.includes(b)), "error view lacks Copy / Retry / Back to export settings", { actual: buttons });
			await clickEl(client, "Back to export settings", popoverButton("Back to export settings"));
			await waitFor("settings view", async () => (await popoverState(client)).view === "settings", { timeoutMs: 5000 });
			const blockedRequests = aacRequests(ctx, state.chunk.name, from).length;
			const expected = takeProblems(ctx, problemsFrom2, (p) => /Export failed|ERR_BLOCKED_BY_CLIENT|Failed to load resource|ChunkLoad|Failed to load chunk/i.test(`${p.text} ${p.url ?? ""}`) || (p.url ?? "").includes(state.chunk.name));
			R.metric("X.3.blocked", { errorText: text.slice(0, 380), chunkRequests: blockedRequests, expectedProblems: expected.length });
			return { error: text.replace(/^Export failed /, "").slice(0, 200), blockedChunkRequests: blockedRequests };
		}, { timeoutMs: 120_000 });

		await R.step("X.3b", "block lifted, same document: does the retry work, or did the bundler cache the failed chunk? (reported; a sticky failure is a FAIL)", async () => {
			const problemsFrom2 = ctx.problems.length;
			await client.send("Network.setBlockedURLs", { urls: [] });
			const before = aacRequests(ctx, state.chunk.name, state.blockedFrom).length;
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { readOnSuccess: false });
			const after = aacRequests(ctx, state.chunk.name, state.blockedFrom).length;
			takeProblems(ctx, problemsFrom2, (p) => /Export failed/.test(p.text));
			R.metric("X.3.retry", { outcome: result.outcome, chunkRequestsBefore: before, chunkRequestsAfter: after, errorText: result.errorText?.slice(0, 300) ?? null });
			expect(result.outcome === "success", `retry with the chunk reachable again ${result.outcome === "error" ? "fails" : result.outcome}: the failed chunk load is cached by the bundler (needs an app reload). Chunk requests before/after the retry: ${before}/${after}. Error: ${result.errorText?.slice(0, 200)}`, { actual: { before, after } });
			return { retry: "succeeded without reloading", chunkRequests: `${before} -> ${after}` };
		}, { timeoutMs: 120_000 });
		await client.send("Network.setBlockedURLs", { urls: [] });

		// ------------------------------------------------ X.4 okunamayan ses
		await R.step("X.4a", "0-byte .mp3 import: rejected with a visible message (no asset card, not silent)", async () => {
			const problemsFrom2 = ctx.problems.length;
			await freshDocument(ctx);
			await ed.newProject(client);
			await ed.openAssetsTab(client, "Media");
			await lib.chooseFiles(client, [state.assets.emptyMp3], () => clickEl(client, "Import button", byTextFinder("button", "Import", ed.ASSETS)));
			const seen = new Set();
			let errorToast = null;
			for (let i = 0; i < 100 && !errorToast; i++) {
				for (const text of await lib.toastTexts(client)) {
					seen.add(text);
					if (/fail|could not|couldn't|unsupported|invalid|error|empty|unreadable/i.test(text)) errorToast = text;
				}
				await sleep(100);
			}
			const names = await client.evaluate(`[...${ed.ASSETS}.querySelectorAll("span.sr-only")].map((s) => s.textContent.trim())`);
			await ctx.shoot("X4a-empty-mp3");
			const taken = takeProblems(ctx, problemsFrom2, (p) => /Error processing file|ERR_REQUEST_RANGE_NOT_SATISFIABLE|Could not load media|Failed to load resource/.test(`${p.text} ${p.url ?? ""}`));
			expect(!names.includes("x-empty.mp3"), "the 0-byte file was accepted as an asset", { actual: names });
			expect(errorToast, "the 0-byte .mp3 was rejected SILENTLY: no error toast within 10 s (only console.error 'Error processing file')", { actual: { toastsSeen: [...seen], consoleProblems: taken.map((p) => String(p.text).slice(0, 80)) } });
			return { toast: errorToast.replace(/\s*Close.*$/, "").slice(0, 160) };
		}, { timeoutMs: 120_000 });

		for (const variant of ["zero-fill", "truncate-0", "delete"]) {
			const what = variant === "delete" ? "removed from the project's media storage" : variant === "truncate-0" ? "truncated to 0 bytes" : "overwritten with zeros";
			await R.step(`X.4b.${variant}`, `stored audio clip ${what}: Include audio ON stops with AUDIO_UNREADABLE naming the clip ('Remove or re-add it'), no file; OFF exports`, async () => {
				const problemsFrom2 = ctx.problems.length;
				const { stored } = await brokenAudioProject(ctx, deps, state, variant);
				await setExportOptions(client, { format: "mp4", includeAudio: true });
				const on = await runExport(ctx, { readOnSuccess: false });
				await ctx.shoot(`X4b-${variant}-error`);
				expect(on.outcome === "error", `export with unreadable audio did not stop (${on.outcome})`, { actual: on.samples.slice(-3) });
				expect(/Audio of "x-voice\.wav" could not be read/.test(on.errorText) && /Remove or re-add it/.test(on.errorText) && /AUDIO_UNREADABLE/.test(on.errorText), "error message does not name the clip / lacks 'Remove or re-add it' / AUDIO_UNREADABLE", { actual: on.errorText });
				expect(on.downloadsAfter === 0, "a file was written although audio was unreadable", { actual: on.downloadsAfter });
				await setExportOptions(client, { format: "mp4", includeAudio: false });
				const off = await runExport(ctx, { saveAs: `X4b-${variant}-audio-off.mp4` });
				expect(off.outcome === "success", `export with Include audio OFF failed (${off.outcome})`, { actual: off.errorText });
				const out = inspectOutput(off);
				expect(out.decode.ok && out.streams.includes("video:h264") && !out.streams.some((s) => s.startsWith("audio:")), "Include audio OFF output is not a clean video-only MP4", { actual: out });
				takeProblems(ctx, problemsFrom2, (p) => /Export failed|Failed to initialize video sink|Failed to load|unsupported or unrecognizable|ERR_REQUEST_RANGE|NotFound|Could not/i.test(`${p.text} ${p.url ?? ""}`));
				const reason = /AUDIO_UNREADABLE, (.*?)(?: Copy| Retry|$)/.exec(on.errorText)?.[1]?.slice(0, 100);
				return { stored: `${stored.target.size} bytes -> ${variant}`, reason, audioOff: `${out.streams.join(",")}, decode clean` };
			}, { timeoutMs: 200_000 });
		}

		await R.step("X.4c", "a genuinely silent video clip (no audio track) does NOT block MP4+audio export (Include audio ON): file written, no audio stream, AAC chunk not fetched", async () => {
			const from = await freshDocument(ctx);
			await importAndPlace(ctx, state.assets.silentVideo);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { saveAs: "X4c-silent-audio-on.mp4" });
			expect(result.outcome === "success", `silent video export was blocked (${result.outcome})`, { actual: result.errorText });
			const out = inspectOutput(result);
			expect(out.decode.ok && out.streams.includes("video:h264"), "silent export is not a clean MP4", { actual: out });
			expect(aacRequests(ctx, state.chunk.name, from).length === 0, "the AAC chunk was fetched for a silent project");
			return { streams: out.streams };
		}, { timeoutMs: 120_000 });

		// ------------------------------------------------ X.5 çok kısa ses
		await R.step("X.5a", "20 ms audio project, MP4+audio: AUDIO_TOO_SHORT (no silent/broken file)", async () => {
			const problemsFrom2 = ctx.problems.length;
			await freshDocument(ctx);
			await ed.newProject(client);
			await importTimed(ctx, [state.assets.tinyAudio]);
			await ed.addAssetToTimeline(client, "x-tiny.wav");
			await sleep(800);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { readOnSuccess: false });
			await ctx.shoot("X5a-mp4-too-short");
			takeProblems(ctx, problemsFrom2, (p) => /Export failed/.test(p.text));
			expect(result.outcome === "error", `20 ms audio MP4 export did not stop (${result.outcome})`, { actual: result.samples.slice(-3) });
			expect(/AUDIO_TOO_SHORT/.test(result.errorText) && /no longer than one AAC frame/.test(result.errorText), "error text lacks AUDIO_TOO_SHORT / explanation", { actual: result.errorText });
			expect(result.downloadsAfter === 0, "a file was written", { actual: result.downloadsAfter });
			return { error: result.errorText.replace(/^Export failed /, "").slice(0, 160) };
		}, { timeoutMs: 120_000 });

		await R.step("X.5b", "same 20 ms audio project, WebM+audio works (Opus has no AAC priming limit)", async () => {
			const problemsFrom2 = ctx.problems.length;
			await setExportOptions(client, { format: "webm", includeAudio: true });
			const result = await runExport(ctx, { saveAs: "X5b-webm-short.webm" });
			takeProblems(ctx, problemsFrom2, (p) => /Export failed/.test(p.text));
			expect(result.outcome === "success", `WebM export of a 20 ms audio project failed: ${result.errorText}`, { actual: result.errorText });
			const probe = probeJson(result.file);
			const streams = probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`);
			return { bytes: result.download.size, streams, decode: decodeClean(result.file).ok };
		}, { timeoutMs: 120_000 });

		// ------------------------------------------------ X.6 sticker ön kontrolü
		const isRed = (r, g, b) => r > 200 && g < 110 && b < 110; // Fluent "Red heart" #F8312F
		const isWhite = (r, g, b) => r > 235 && g > 235 && b > 235; // Phosphor ikonları beyaz çizilir
		const sticker = { projectId: null };
		await R.step("X.6a", "valid stickers (Fluent 'Red heart' + Phosphor 'Arrow clockwise') export to MP4 and are visible as pixels in the output frames", async () => {
			const h = content.helpers;
			await freshDocument(ctx);
			sticker.projectId = await ed.newProject(client);
			await ed.openAssetsTab(client, "Stickers");
			await waitFor("sticker tabs", () => client.evaluate(`!!document.querySelector('[aria-label="Sticker categories"]')`));
			await h.stickerTab(client, "Emoji");
			await h.stickerSearch(client, "red heart");
			await clickEl(client, "'+' of Red heart", `() => (${ed.ASSETS}).querySelector('button[aria-label="Add Red heart"]')`);
			await waitFor("heart clip", async () => (await ed.clipsInfo(client)).some((c) => c.name === "Red heart"), { timeoutMs: 10_000 });
			await h.stickerTab(client, "Icons");
			await h.stickerSearch(client, "arrow clockwise");
			await clickEl(client, "'+' of Arrow clockwise", `() => (${ed.ASSETS}).querySelector('button[aria-label="Add Arrow clockwise"]')`);
			await waitFor("icon clip", async () => (await ed.clipsInfo(client)).some((c) => c.name === "Arrow clockwise"), { timeoutMs: 10_000 });
			await ed.waitSaved(client, readProjects);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { saveAs: "X6a-stickers.mp4" });
			expect(result.outcome === "success", `valid sticker export failed (${result.outcome})`, { actual: result.errorText });
			const frame = frameAt(result.file, 1.0);
			fs.writeFileSync(path.join(OUT, "X6a-frame-1s.png"), frame.png);
			const red = centroidWhere(frame.image, isRed);
			const white = centroidWhere(frame.image, isWhite);
			const decode = decodeClean(result.file);
			R.metric("X.6.validFrame", { size: `${frame.image.width}x${frame.image.height}`, redPixels: red.count, whitePixels: white.count, redCentroid: red.count ? `${round1(red.cx)},${round1(red.cy)}` : null });
			expect(decode.ok, "the sticker export does not decode clean", { actual: decode });
			expect(red.count >= 1500, "the Red heart is not in the exported frame", { expected: ">= 1500 red px", actual: red.count });
			expect(white.count >= 300, "the Arrow clockwise icon is not in the exported frame", { expected: ">= 300 white px", actual: white.count });
			return { redPixels: red.count, whitePixels: white.count, frame: `${frame.image.width}x${frame.image.height}` };
		}, { timeoutMs: 200_000 });

		await R.step("X.6b", "one sticker cannot be loaded (corrupt id in the saved project): export STOPS with an error that names that sticker only, no file", async () => {
			expect(sticker.projectId, "no project from X.6a");
			const problemsFrom2 = ctx.problems.length;
			await freshDocument(ctx);
			const changed = await setStickerId(client, sticker.projectId, "Arrow clockwise", "icons:not-a-real-icon");
			expect(changed === 1, "could not corrupt the saved sticker id", { actual: changed });
			await deps.reopenProject(ctx, sticker.projectId);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { readOnSuccess: false });
			await ctx.shoot("X6b-broken-sticker-error");
			const taken = takeProblems(ctx, problemsFrom2, (p) => /Export failed|not-a-real-icon|Failed to load resource|sticker/i.test(`${p.text} ${p.url ?? ""}`));
			expect(result.outcome === "error", `export with an unloadable sticker did not stop (${result.outcome})`, { actual: result.samples.slice(-3) });
			expect(/Sticker "Arrow clockwise" could not be loaded/.test(result.errorText) && /Remove it or re-add it/.test(result.errorText), "error does not name the broken sticker", { actual: result.errorText });
			expect(!/Red heart/.test(result.errorText), "the error also names the healthy sticker", { actual: result.errorText });
			expect(result.downloadsAfter === 0, "a file was written although a sticker was missing", { actual: result.downloadsAfter });
			return { error: result.errorText.replace(/^Export failed /, "").slice(0, 160), expectedConsoleProblems: taken.length };
		}, { timeoutMs: 200_000 });

		await R.step("X.6c", "after restoring the sticker id the export succeeds again and both stickers are back in the frame", async () => {
			expect(sticker.projectId, "no project from X.6a");
			await freshDocument(ctx);
			expect(await setStickerId(client, sticker.projectId, "Arrow clockwise", "icons:arrow-clockwise") === 1, "could not restore the sticker id");
			await deps.reopenProject(ctx, sticker.projectId);
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { saveAs: "X6c-stickers-restored.mp4" });
			expect(result.outcome === "success", `export after restoring failed (${result.outcome})`, { actual: result.errorText });
			const frame = frameAt(result.file, 1.0);
			const white = centroidWhere(frame.image, isWhite);
			const red = centroidWhere(frame.image, isRed);
			expect(red.count >= 1500 && white.count >= 300, "sticker pixels missing after restoring", { actual: { red: red.count, white: white.count } });
			return { redPixels: red.count, whitePixels: white.count };
		}, { timeoutMs: 200_000 });

		// ------------------------------------------------ X.7 / X.8 önizleme dışa aktarmadan sonra
		// Önizleme ve dışa aktarma AYNI kompozitör tuvalini çizer (export-v2.md A7). Önizleme "kare ve sahne aynı" ise yeniden çizmiyordu:
		// dışa aktarma bitince tuval SON dışa aktarılan karede kalıyordu (playhead başta). Proje siyah bitiyorsa (ses videodan uzun,
		// çıkış solması, sondaki boşluk) önizleme siyah kalıyor, Home tuşu bile düzeltmiyor. Kaynak: Plans/assets/black-export-report.md
		const wholeCanvas = (image) => ({ x: 0, y: 0, w: image.width, h: image.height });
		const staleProject = async () => {
			await freshDocument(ctx);
			await ed.newProject(client);
			await importTimed(ctx, [state.assets.sources["44100-stereo"], state.assets.tailAudio]);
			await ed.addAssetToTimeline(client, "x-44100-stereo.mp4");
			await ed.addAssetToTimeline(client, "x-tail.wav");
			await sleep(800);
			await ed.seekStart(client);
			const clips = await ed.clipsInfo(client);
			expect(clips.length === 2, "video and the 10 s audio are not both on the timeline", { actual: clips.map((c) => c.name) });
			return deps.measureCanvas(ctx, "X7-preview-before-export");
		};

		await R.step("X.7", "project ends in black (6 s video + 10 s audio): after the export the preview shows the frame under the playhead again, not the black last exported frame, and Home keeps it", async () => {
			const problemsBefore = ctx.problems.length;
			const pre = await staleProject();
			expect(pre.mean > 60, "premise: the preview at the playhead (video frame 0) is already dark before the export", { actual: pre.mean });
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			const result = await runExport(ctx, { saveAs: "X7-black-tail.mp4" });
			expect(result.outcome === "success", `export did not succeed (${result.outcome})`, { actual: result.errorText });
			// premise on the FILE: first frame is the video, the last frame is black (the timeline has nothing there: by design)
			const firstImage = frameAt(result.file, 0.0).image;
			const lastImage = frameAt(result.file, 9.9).image;
			const first = regionStats(firstImage, wholeCanvas(firstImage));
			const last = regionStats(lastImage, wholeCanvas(lastImage));
			expect(first.mean > 60 && last.mean < 8, "premise: the file's first frame is not bright or its last frame is not black", { actual: { first: first.mean, last: last.mean } });
			await sleep(700); // the popover closes after the download
			const post = await deps.measureCanvas(ctx, "X7-preview-after-export");
			const diffAfter = regionDiff(pre.image, post.image, wholeCanvas(pre.image));
			await ed.seekStart(client);
			const home = await deps.measureCanvas(ctx, "X7-preview-after-home");
			const diffHome = regionDiff(pre.image, home.image, wholeCanvas(pre.image));
			R.metric("X.7.preview", { preMean: round1(pre.mean), postMean: round1(post.mean), diffAfterExport: round2(diffAfter), homeMean: round1(home.mean), diffAfterHome: round2(diffHome), fileFirstMean: round1(first.mean), fileLastMean: round1(last.mean) });
			expect(post.mean > 60, `the preview is dark (mean luma ${round1(post.mean)}) right after the export: it shows the last exported (black) frame, not the playhead frame`, { expected: `> 60 (before the export ${round1(pre.mean)})`, actual: post.mean });
			expect(diffAfter < 2, `the preview after the export differs from the one before it by ${round2(diffAfter)} (mean abs luma): it is not the playhead frame`, { expected: "< 2", actual: diffAfter });
			expect(home.mean > 60 && diffHome < 2, "pressing Home after the export does not bring the playhead frame back", { actual: { mean: home.mean, diff: diffHome } });
			expect(ctx.problems.length === problemsBefore, "console/network problems", { actual: ctx.problems.slice(problemsBefore, problemsBefore + 3) });
			return { preMean: round1(pre.mean), postMean: round1(post.mean), diffAfterExport: round2(diffAfter), homeDiff: round2(diffHome), fileLastFrameMean: round1(last.mean) };
		}, { timeoutMs: 200_000 });

		await R.step("X.8", "export CANCELLED at ~60%: the preview shows the playhead frame again (not the frame the cancelled export stopped on)", async () => {
			const problemsBefore = ctx.problems.length;
			const pre = await staleProject();
			await setExportOptions(client, { format: "mp4", includeAudio: true });
			let cancelledAt = null;
			const result = await runExport(ctx, {
				timeoutMs: 120_000,
				pollMs: 50,
				readOnSuccess: false,
				stop: async (popover) => {
					if (cancelledAt === null && popover.view === "exporting" && popover.pct !== null && popover.pct >= 60) {
						await clickEl(client, "Cancel", popoverButton("Cancel"));
						cancelledAt = popover.pct;
					}
					return cancelledAt !== null && popover.view === "settings" ? "cancelled" : null;
				},
			});
			expect(cancelledAt !== null, "the export finished before it reached 60% (nothing to cancel)", { actual: result.samples.slice(-4) });
			expect(result.outcome === "cancelled" && result.downloadsAfter === 0, `cancel did not end in the settings view without a download (${result.outcome})`, { actual: result.samples.slice(-3) });
			await sleep(700);
			const post = await deps.measureCanvas(ctx, "X8-preview-after-cancel");
			const diff = regionDiff(pre.image, post.image, wholeCanvas(pre.image));
			R.metric("X.8.preview", { cancelledAtPct: cancelledAt, preMean: round1(pre.mean), postMean: round1(post.mean), diffAfterCancel: round2(diff) });
			expect(diff < 2, `after the cancel the preview differs from the playhead frame by ${round2(diff)} (mean abs luma): it kept the frame the cancelled export stopped on`, { expected: "< 2", actual: diff });
			expect(ctx.problems.length === problemsBefore, "console/network problems", { actual: ctx.problems.slice(problemsBefore, problemsBefore + 3) });
			return { cancelledAtPct: cancelledAt, diffAfterCancel: round2(diff) };
		}, { timeoutMs: 200_000 });

		// X.9: dışa aktarılan her kare, kaynağın AYNI sıradaki karesi mi? Önizleme dışa aktarma sürerken çizerse (paylaşılan kompozitör + videoCache'in tek
		// seek-generation'ı) dışa aktarıcı yanlış/bayat kare alır: 6 sn'lik dosyada 180 kareden ~16'sı kaymıştı (ölçüm: black-export-report.md, mutasyon B).
		await R.step("X.9", "plain MP4 export: every exported frame is the source frame with the same index (no stale, repeated or shifted frames)", async () => {
			const source = state.assets.sources["44100-stereo"];
			await freshDocument(ctx);
			await importAndPlace(ctx, source);
			await setExportOptions(client, { format: "mp4", includeAudio: false });
			const result = await runExport(ctx, { saveAs: "X9-fidelity.mp4" });
			expect(result.outcome === "success", `export did not succeed (${result.outcome})`, { actual: result.errorText });
			const fid = frameFidelity(result.file, source);
			R.metric("X.9.fidelity", fid);
			expect(fid.compared === SOURCE_SECONDS * 30, `compared ${fid.compared} frames, expected ${SOURCE_SECONDS * 30}`, { actual: fid });
			expect(fid.offFrames === 0, `${fid.offFrames} of ${fid.compared} exported frames are not the source frame with their index (output->best source frame: ${fid.first.join(", ")})`, { expected: 0, actual: fid });
			return { compared: fid.compared, offFrames: fid.offFrames, worstBestMatchDiff: fid.worstBestMatchDiff };
		}, { timeoutMs: 200_000 });

		// X.10: dışa aktarmasız düz arama. mediabunny CanvasSink video karelerini 3 tuvallik bir havuzdan verir (poolSize 3) ve tuvalleri bir
		// sonraki karelerle YENİDEN çizer; kompozitör doku önbelleği "aynı nesne = aynı piksel" saydığı için, arama yeni kareyi önbellekteki
		// tuvale düşürünce doku yenilenmiyordu: oynat, durdur, Home -> önizleme durduğu karede kalıyordu (ölçüm: 10 denemenin 10'u). Aynı
		// neden iptal edilen dışa aktarmadan sonra (X.8) önizlemeyi ~%40-60 bayat bırakıyordu.
		await R.step("X.10", "play, pause, Home (no export involved): the preview shows frame 0 under the playhead, not the frame playback stopped on", async () => {
			const problemsBefore = ctx.problems.length;
			await freshDocument(ctx);
			await importAndPlace(ctx, state.assets.sources["44100-stereo"]);
			await ed.seekStart(client);
			const ref = await deps.measureCanvas(ctx, "X10-frame0-reference");
			expect(ref.mean > 60, "premise: frame 0 is dark", { actual: ref.mean });
			const diffs = [];
			for (let i = 0; i < 4; i++) {
				await ed.blurActive(client);
				await press(client, "space");
				await sleep(1000 + i * 130);
				await press(client, "space");
				await sleep(300);
				const stopped = await ed.playheadTicks(client);
				await ed.seekStart(client);
				await sleep(200);
				const shot = await deps.measureCanvas(ctx, `X10-after-home-${i}`);
				expect(stopped > 0, "playback did not move the playhead (nothing to jump back from)", { actual: stopped });
				diffs.push(round2(regionDiff(ref.image, shot.image, { x: 0, y: 0, w: ref.image.width, h: ref.image.height })));
			}
			R.metric("X.10.afterHomeDiffs", diffs);
			expect(diffs.every((d) => d < 2), `after play, pause, Home the preview is not frame 0 in ${diffs.filter((d) => d >= 2).length} of ${diffs.length} tries (mean abs luma diff vs frame 0: ${diffs.join(", ")})`, { expected: "< 2 each", actual: diffs });
			expect(ctx.problems.length === problemsBefore, "console/network problems", { actual: ctx.problems.slice(problemsBefore, problemsBefore + 3) });
			return { diffs };
		}, { timeoutMs: 200_000 });
	} finally {
		try {
			await client.send("Network.setBlockedURLs", { urls: [] });
		} catch {
			// sayfa kapanmış olabilir
		}
		const expected = ctx.problems.slice(problemsFrom);
		R.note("X.problemsDuringScenario", expected.length);
		R.note("X.slowImports", slowImports.slice());
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			R.note("X.cleanupWarning", error.message);
		}
	}
}

module.exports = { scenarioExport, generateExportAssets, audioOnset, flashTimes, treeRssMB, internals: { installHook, openExport, setExportOptions, runExport, importAndPlace, freshDocument, popoverState } };
