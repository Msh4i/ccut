// features.js E2: "Stick to scene" (camera tracking v2) in the REAL unpackaged Electron window, real mouse/keyboard events over CDP.
// Plan: docs/ccut/camera-tracking-v2.md section (e), cases E2.1-E2.13. Footage: features-camera-assets.js (textured world, two green
// square markers whose true centres come from the camera maths; the element that is stuck is a magenta two-ring PNG or a magenta text).
// features.js calls scenarioCamera(ctx, deps). Select cases with CAMERA_CASES=E2.1,E2.10 (comma list), default all.
// Rule: product code is NOT fixed here. A miss against a threshold is a finding, thresholds are never loosened to pass.
const fs = require("node:fs");
const path = require("node:path");
const ed = require("./features-editor");
const lib = require("./features-lib");
const assets = require("./features-camera-assets");
const cp = require("node:child_process");
const { decodePng } = require("./png");

const { byTextFinder, clickEl, expect, keyDown, keyUp, mouse, notVerified, press, projectElements, readProjects, rectOf, sleep, waitFor } = lib;

const CAMERA_OUT = path.join(process.env.CCUT_E2E_DIR ?? require("node:os").tmpdir(), "ccut-camera-e2e");
const SHOT_DIR = path.join(CAMERA_OUT, "shots");
const round1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? n : Math.round(n * 10) / 10);
const round2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? n : Math.round(n * 100) / 100);

// Notice texts word for word from plan section (d)
const TEXTS = {
	noTexture: "Not enough detail in this clip to follow the scene.",
	noMotion: "No camera movement in this clip, nothing to stick to.",
	cut: /^Scene cut at \d+:\d\d\.\d, stuck until there\.$/,
	lowQuality: "Video quality is low, the stick may drift.",
	object: "This spot moves differently from the scene: following the object.",
	stale: "The clip changed after sticking. Stick again.",
	noVideo: "There is no video under this clip.",
};

// ---------------------------------------------------------------- measuring the preview
const projectNow = async (client) => {
	await ed.waitSaved(client, readProjects);
	const id = await client.evaluate('location.pathname.split("/").pop()');
	return (await readProjects(client)).find((p) => p.id === id);
};
const canvasSizeOf = async (client) => (await projectNow(client)).settings.canvasSize;
const canvasFinder = () => `() => (${ed.PREVIEW}).querySelector("canvas")`;
async function canvasRect(client) {
	let rect = null;
	await waitFor("preview canvas", async () => ((rect = await rectOf(client, canvasFinder())) && rect.w > 0 ? rect : null), { timeoutMs: 6000, intervalMs: 100 }).catch(() => {});
	return rect;
}

// Canvas-only screenshot (overlay hidden: no handles, no chip), twice until two shots are byte-identical (the frame has settled)
async function shootCanvasOnce(ctx) {
	const rect = await canvasRect(ctx.client);
	expect(rect && rect.w > 0, "preview canvas is not visible");
	await ctx.client.evaluate(`(() => { const p = ${ed.PREVIEW}; p.style.visibility = "hidden"; p.querySelector("canvas").style.visibility = "visible"; })()`);
	try {
		await sleep(40);
		const shot = await ctx.shoot(null, { clip: rect, save: false });
		return { ...shot, rect };
	} finally {
		await ctx.client.evaluate(`(() => { const p = ${ed.PREVIEW}; p.style.visibility = ""; p.querySelector("canvas").style.visibility = ""; })()`);
	}
}
async function shootSettled(ctx, name) {
	let previous = null;
	let shot = null;
	for (let i = 0; i < 16; i++) {
		shot = await shootCanvasOnce(ctx);
		if (previous && previous.equals(shot.png)) break;
		previous = shot.png;
		await sleep(150);
	}
	fs.mkdirSync(SHOT_DIR, { recursive: true });
	if (name) fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), shot.png);
	return shot;
}

const scoreGreen = (r, g, b) => g - Math.max(r, b);
const scoreMagenta = (r, g, b) => Math.min(r, b) - g;
const scoreOrange = (r, g, b) => r - b - 20;

// Connected blobs of a colour score. Centroid is soft-weighted (score/full) so edge pixels give sub-pixel positions.
function findBlobs(image, score, { threshold = 60, full = 215, minCount = 30, pad = 3 } = {}) {
	const { width, height, data } = image;
	const total = width * height;
	const scores = new Float32Array(total);
	const mask = new Uint8Array(total);
	for (let i = 0; i < total; i++) {
		const s = score(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
		scores[i] = s;
		mask[i] = s > threshold ? 1 : 0;
	}
	const seen = new Uint8Array(total);
	const blobs = [];
	const stack = new Int32Array(total);
	for (let start = 0; start < total; start++) {
		if (!mask[start] || seen[start]) continue;
		let sp = 0;
		stack[sp++] = start;
		seen[start] = 1;
		let count = 0;
		let x0 = width;
		let x1 = 0;
		let y0 = height;
		let y1 = 0;
		while (sp > 0) {
			const p = stack[--sp];
			const x = p % width;
			const y = (p - x) / width;
			count++;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
			for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
				if (q >= 0 && mask[q] && !seen[q]) {
					seen[q] = 1;
					stack[sp++] = q;
				}
			}
		}
		if (count < minCount) continue;
		let sw = 0;
		let sx = 0;
		let sy = 0;
		for (let y = Math.max(0, y0 - pad); y <= Math.min(height - 1, y1 + pad); y++) {
			for (let x = Math.max(0, x0 - pad); x <= Math.min(width - 1, x1 + pad); x++) {
				const s = scores[y * width + x];
				if (s <= 8) continue;
				const w = Math.min(1, s / full);
				sw += w;
				sx += w * (x + 0.5);
				sy += w * (y + 0.5);
			}
		}
		blobs.push({ x: sx / sw, y: sy / sw, count, area: sw, w: x1 - x0 + 1, h: y1 - y0 + 1 });
	}
	return blobs.sort((a, b) => b.count - a.count);
}

// Blobs in canvas pixels (the screenshot is rect.w wide; canvas is canvasSize.width wide)
function inCanvas({ blobs, image, canvasSize }) {
	const k = canvasSize.width / image.width;
	return blobs.map((b) => ({ x: b.x * k, y: b.y * k, count: b.count, area: b.area * k * k, w: b.w * k, h: b.h * k, k }));
}

// order the two markers/rings along the pair axis so the ones from different times match up
function orderPair(blobs, axis = "x") {
	const two = blobs.slice(0, 2);
	return two.sort((a, b) => a[axis] - b[axis]);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// px at the plan's 1920-wide canvas: scale by the longer side (a portrait 720x1280 canvas counts like 1280x720)
const planScale = (canvasSize) => 1920 / Math.max(canvasSize.width, canvasSize.height);
const angleOf = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

// one measurement of the preview: the two green markers and the two magenta rings, in canvas pixels
async function measureScene(ctx, { name, canvasSize, axis = "x", needGreen = true, needRings = true, tries = 12 }) {
	let last = null;
	for (let attempt = 0; attempt < tries; attempt++) {
		const shot = await shootSettled(ctx, attempt === tries - 1 || !name ? name : null);
		const greens = orderPair(inCanvas({ blobs: findBlobs(shot.image, scoreGreen, { threshold: 70, full: 215, minCount: 120 }), image: shot.image, canvasSize }), axis);
		const rings = orderPair(inCanvas({ blobs: findBlobs(shot.image, scoreMagenta, { threshold: 80, full: 255, minCount: 60 }), image: shot.image, canvasSize }), axis);
		last = { greens, rings, rect: shot.rect, imageWidth: shot.image.width, png: shot.png };
		if ((!needGreen || greens.length === 2) && (!needRings || rings.length === 2)) {
			if (name) fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), shot.png);
			return { ...last, ok: true };
		}
		await sleep(250);
	}
	if (name) fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), last.png);
	return { ...last, ok: false };
}

// ---------------------------------------------------------------- pin UI state
// What the chip (preview) and the Tracking tab show right now
const pinState = (client) =>
	client.evaluate(`(() => {
		const read = (area) => {
			if (!area) return null;
			const buttons = [...area.querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean);
			const progress = area.querySelector('[aria-label="Analysis progress"]');
			const notices = [...area.querySelectorAll('[role="status"] > div')].map((e) => (e.querySelector("span.min-w-0") ?? e).innerText.replace(/\\s+/g, " ").trim()).filter(Boolean);
			const statuses = [...area.querySelectorAll('[role="status"]')].map((e) => e.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean);
			return { buttons, analysing: !!progress, percent: progress ? Number(progress.getAttribute("aria-valuenow")) : null, notices, statuses, hasStick: buttons.includes("Stick to scene"), hasUnstick: buttons.includes("Unstick"), hasCancel: buttons.includes("Cancel") };
		};
		return { chip: read(${ed.PREVIEW}), tab: read(${ed.PROPS}) };
	})()`);

const noticeTexts = (state) => [...new Set([...(state.chip?.notices ?? []), ...(state.tab?.notices ?? [])])];

// Press Stick to scene (chip or Tracking tab), poll every 25 ms until it ends (stuck, a notice, or an error)
async function stickAndWait(ctx, { via = "chip", timeoutMs = 90_000 } = {}) {
	const { client } = ctx;
	const area = via === "chip" ? ed.PREVIEW : ed.PROPS;
	// In-page timing: from the click event to the frame in which "Unstick" is on screen. The polling loop below only
	// accepts a state after 150 ms (so a stale pre-click state is never taken), which made every pin read as >= 150 ms.
	await client.evaluate(`(() => {
		const probe = (window.__stickProbe = { click: null, dom: null, frame: null });
		const root = (${area});
		const isDone = () => [...root.querySelectorAll("button")].some((b) => b.innerText.trim() === "Unstick");
		document.addEventListener("click", () => { if (probe.click === null) probe.click = performance.now(); }, { capture: true, once: true });
		const observer = new MutationObserver(() => {
			if (probe.click === null || probe.dom !== null || !isDone()) return;
			probe.dom = performance.now();
			requestAnimationFrame(() => { probe.frame = performance.now(); });
			observer.disconnect();
		});
		observer.observe(root, { childList: true, subtree: true, characterData: true });
	})()`);
	const t0 = Date.now();
	await clickEl(client, `Stick to scene (${via})`, byTextFinder("button", "Stick to scene", area));
	const clickedAt = Date.now();
	const percentSamples = [];
	let sawAnalysing = false;
	let state = null;
	let doneAt = null;
	for (let i = 0; i < Math.ceil(timeoutMs / 25); i++) {
		state = await pinState(client);
		const view = via === "chip" ? state.chip : state.tab;
		const elapsed = Date.now() - clickedAt;
		if (view?.analysing) {
			sawAnalysing = true;
			if (view.percent !== null) percentSamples.push({ ms: elapsed, percent: view.percent });
		} else if (elapsed > 150 && (view?.hasUnstick || ((sawAnalysing || elapsed > 3000) && (noticeTexts(state).length > 0 || view?.hasStick)))) {
			doneAt = Date.now();
			break;
		}
		await sleep(25);
	}
	expect(doneAt !== null, `Stick to scene did not finish within ${timeoutMs} ms`, { actual: state });
	const probe = await client.evaluate("window.__stickProbe");
	const pageMs = probe && probe.click !== null && probe.frame !== null ? { dom: round1(probe.dom - probe.click), frame: round1(probe.frame - probe.click) } : null;
	return { ms: doneAt - clickedAt, pageMs, sawAnalysing, percentSamples, state, stuck: !!(state.chip?.hasUnstick || state.tab?.hasUnstick), notices: noticeTexts(state), clickToDone: doneAt - t0 };
}

// keys per transform channel of an element
const channelKeys = (element) => {
	const out = {};
	for (const [key, value] of Object.entries(element?.animations?.channels ?? element?.animations ?? {})) {
		if (!/^transform\./.test(key)) continue;
		out[key.replace("transform.", "")] = value?.keys?.length ?? 0;
	}
	return out;
};
const elementOf = async (client, predicate) => projectElements(await projectNow(client)).find(predicate);
const totalKeys = (keys) => Object.values(keys).reduce((a, b) => a + b, 0);


// value of a keyed channel at t seconds (keys: {time (ticks), value}, linear between keys, held outside)
function keyedValueAt(element, channel, seconds) {
	const keys = [...(element?.animations?.[`transform.${channel}`]?.keys ?? element?.animations?.channels?.[`transform.${channel}`]?.keys ?? [])].sort((a, b) => a.time - b.time);
	if (!keys.length) return null;
	const t = seconds * 120_000;
	if (t <= keys[0].time) return keys[0].value;
	if (t >= keys.at(-1).time) return keys.at(-1).value;
	for (let i = 0; i < keys.length - 1; i++) {
		if (t >= keys[i].time && t <= keys[i + 1].time) {
			const f = (t - keys[i].time) / (keys[i + 1].time - keys[i].time);
			return keys[i].value + f * (keys[i + 1].value - keys[i].value);
		}
	}
	return null;
}

// ---------------------------------------------------------------- setup helpers
const cameraOnly = (() => {
	const env = process.env.CAMERA_CASES;
	return env ? new Set(env.split(",").map((s) => s.trim())) : null;
})();
const cameraWanted = (id) => !cameraOnly || cameraOnly.has(id);

async function setTransform(client, { x, y, scale, rotate }) {
	await ed.propsTab(client, "Transform");
	if (scale !== undefined) {
		await ed.typeInto(client, "Scale X", String(scale));
		await ed.typeInto(client, "Scale Y", String(scale));
	}
	if (rotate !== undefined) await ed.typeInto(client, "Rotate", String(rotate));
	if (x !== undefined) await ed.typeInto(client, "Position X", String(x));
	if (y !== undefined) await ed.typeInto(client, "Position Y", String(y));
}
const readTransform = async (client) => ({
	x: (await ed.sliderState(client, "Position X"))?.now,
	y: (await ed.sliderState(client, "Position Y"))?.now,
	scaleX: (await ed.sliderState(client, "Scale X"))?.now,
	scaleY: (await ed.sliderState(client, "Scale Y"))?.now,
	rotate: (await ed.sliderState(client, "Rotate"))?.now,
});

// seek to t seconds (frame-exact, Home + ArrowRight) and wait for the playhead
const seekLog = [];
async function seekToSeconds(client, seconds) {
	const want = Math.round(seconds * assets.FPS) * 4000; // 120000 ticks per second, 30 fps
	let ticks = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		ticks = await ed.seekSeconds(client, seconds);
		if (ticks === want) break;
		seekLog.push({ seconds, attempt, ticks, want, focus: await client.evaluate(`document.activeElement ? document.activeElement.tagName + ":" + (document.activeElement.getAttribute("aria-label") || document.activeElement.getAttribute("role") || "") : "none"`) });
		await sleep(300);
	}
	expect(ticks === want, `could not put the playhead at ${seconds} s`, { expected: want, actual: { ticks, seekLog: seekLog.slice(-4) } });
	await sleep(250);
	return ticks;
}

// Footage + ring png in a fresh project; the video is on the main track, the playhead at 0. Returns what the test needs.
async function openFootageProject(ctx, { footageName, withRing = true, footageOptions = {}, rotate90 = false, singleRing = false }) {
	const { client } = ctx;
	const footage = await assets.makeFootage({ name: footageName, ...footageOptions, log: (line) => console.log(`        ${line}`) });
	let videoFile = footage.file;
	let rotation = null;
	if (rotate90) {
		rotation = assets.makeRotatedCopy(footage.file, path.join(assets.CACHE_DIR, `${path.basename(footage.file, ".mp4")}-rot90.mp4`));
		if (!rotation.ok) notVerified(`ffmpeg could not write a 90 degree display rotation into the copy (${JSON.stringify(rotation)})`);
		videoFile = rotation.file;
	}
	const ringFile = path.join(assets.CACHE_DIR, singleRing ? "ring-single.png" : "ring-pair.png");
	assets.makeRingPng(ringFile, { single: singleRing });
	await ed.newProject(client);
	await ed.importMedia(client, withRing ? [videoFile, ringFile] : [videoFile]);
	await ed.addAssetToTimeline(client, path.basename(videoFile));
	await ed.seekStart(client);
	const canvasSize = await canvasSizeOf(client);
	return { footage, ringFile, canvasSize, footageBase: path.basename(videoFile), rotation };
}

// Add the ring PNG over the video, scaled/rotated/positioned so each ring sits on a green marker at the playhead (t = 0).
// Placement is derived from the MEASURED marker positions (no assumption on the video-to-canvas mapping), then corrected once.
async function addRingsOnMarkers(ctx, { canvasSize, axis = "x", tag }) {
	const { client } = ctx;
	const before = await measureScene(ctx, { name: `${tag}-0-markers`, canvasSize, axis, needRings: false });
	expect(before.ok && before.greens.length === 2, "the two green markers are not visible at t = 0", { actual: before.greens });
	const [g1, g2] = before.greens;
	const mid = { x: (g1.x + g2.x) / 2, y: (g1.y + g2.y) / 2 };
	const spacing = dist(g1, g2);
	const angle = angleOf(g1, g2);
	const contain = Math.min(canvasSize.width / assets.RING.width, canvasSize.height / assets.RING.height);
	const spacingAtScale1 = assets.RING.centreSpacingNative * contain;
	const scale = round2(spacing / spacingAtScale1);
	await ed.addAssetToTimeline(client, "ring-pair.png");
	await ed.selectClip(client, "ring-pair.png");
	const px = round2(mid.x - canvasSize.width / 2);
	const py = round2(mid.y - canvasSize.height / 2);
	await setTransform(client, { scale, rotate: round1(angle), x: px, y: py });
	let placed = await measureScene(ctx, { name: `${tag}-0-placed`, canvasSize, axis });
	expect(placed.ok, "the rings are not visible after placing them", { actual: { greens: placed.greens.length, rings: placed.rings.length } });
	// one correction from the measured residual (position is in canvas px, x right, y down)
	const residual = { x: (placed.greens[0].x + placed.greens[1].x - placed.rings[0].x - placed.rings[1].x) / 2, y: (placed.greens[0].y + placed.greens[1].y - placed.rings[0].y - placed.rings[1].y) / 2 };
	let corrected = false;
	if (Math.hypot(residual.x, residual.y) > 1.2) {
		corrected = true;
		await setTransform(client, { x: round2(px + residual.x), y: round2(py + residual.y) });
		placed = await measureScene(ctx, { name: `${tag}-0-placed2`, canvasSize, axis });
	}
	const e0 = [dist(placed.greens[0], placed.rings[0]), dist(placed.greens[1], placed.rings[1])];
	return { mid, spacing, angle, scale, placement: { x: px, y: py }, residual, corrected, e0: e0.map(round1), placed, greenSide: Math.sqrt(placed.greens[0].count) * placed.greens[0].k, ringOuter: Math.max(placed.rings[0].w, placed.rings[0].h) };
}

// marker/ring geometry of one measurement
function geometryOf({ greens, rings }) {
	return {
		errors: [round1(dist(greens[0], rings[0])), round1(dist(greens[1], rings[1]))],
		greenDist: dist(greens[0], greens[1]),
		ringDist: dist(rings[0], rings[1]),
		greenAngle: angleOf(greens[0], greens[1]),
		ringAngle: angleOf(rings[0], rings[1]),
		ringOuter: Math.max(rings[0].w, rings[0].h),
		ringSize: Math.sqrt(rings[0].area + rings[1].area),
	};
}

async function measureAtTimes(ctx, { times, canvasSize, axis = "x", tag, footage, truthFallback = false }) {
	const rows = [];
	let base = null;
	const k = footage ? canvasSize.width / footage.video.width : null;
	for (const t of times) {
		await seekToSeconds(ctx.client, t);
		const m = await measureScene(ctx, { name: `${tag}-t${t}`, canvasSize, axis, needGreen: !truthFallback });
		const truth = footage?.frames?.[Math.round(t * assets.FPS)]?.markers ?? [];
		let greenFromTruth = false;
		if (truthFallback && m.rings.length === 2 && m.greens.length < 2 && truth.length === 2) {
			m.greens = truth.map((c) => ({ x: c.x * k, y: c.y * k, count: 0, area: 0, w: 0, h: 0, k: 1 }));
			greenFromTruth = true;
			m.ok = true;
		}
		if (!m.ok) {
			rows.push({ t, missing: { greens: m.greens.length, rings: m.rings.length } });
			continue;
		}
		const g = geometryOf(m);
		if (!base) base = g;
		const truthDev = truth.length === 2 && !greenFromTruth ? [dist(m.greens[0], { x: truth[0].x * k, y: truth[0].y * k }), dist(m.greens[1], { x: truth[1].x * k, y: truth[1].y * k })].map(round1) : null;
		rows.push({
			t,
			greenFromTruth,
			errPx: g.errors,
			maxErrPx: Math.max(...g.errors),
			errPx1920: g.errors.map((e) => round1(e * planScale(canvasSize))),
			maxErrPx1920: round1(Math.max(...g.errors) * planScale(canvasSize)),
			scaleRing: round2(g.ringDist / base.ringDist),
			scaleScene: round2(g.greenDist / base.greenDist),
			ringOuterRatio: round2(g.ringOuter / base.ringOuter),
			ringSizeRatio: round2(g.ringSize / base.ringSize),
			rotRingDeg: round1(angleDiff(g.ringAngle, base.ringAngle)),
			rotSceneDeg: round1(angleDiff(g.greenAngle, base.greenAngle)),
			rotErrDeg: round2(angleDiff(g.ringAngle, g.greenAngle) - angleDiff(base.ringAngle, base.greenAngle)),
			truthDev,
		});
	}
	return rows;
}

// ---------------------------------------------------------------- glue check (scene motion estimated from the two green markers themselves)
// Similarity that carries the marker pair (p1, p2) to (q1, q2): used to predict where the rings of a reference time should be later
function similarityOf({ from, to }) {
	const s = dist(to[0], to[1]) / dist(from[0], from[1]);
	const phi = ((angleOf(to[0], to[1]) - angleOf(from[0], from[1])) * Math.PI) / 180;
	const c = Math.cos(phi) * s;
	const d = Math.sin(phi) * s;
	return { scale: s, rotDeg: (phi * 180) / Math.PI, apply: (p) => ({ x: to[0].x + c * (p.x - from[0].x) - d * (p.y - from[0].y), y: to[0].y + d * (p.x - from[0].x) + c * (p.y - from[0].y) }) };
}

// At playhead tg take the reference (greens + rings as they are now); at each time t compare the measured rings with the reference rings carried by the scene motion
async function glueCheck(ctx, { tg, times, canvasSize, tag, axis = "x" }) {
	await seekToSeconds(ctx.client, tg);
	const ref = await measureScene(ctx, { name: `${tag}-ref-t${tg}`, canvasSize, axis });
	expect(ref.ok, `${tag}: markers/rings not visible at the reference time ${tg}`, { actual: { greens: ref.greens.length, rings: ref.rings.length } });
	const to1920 = planScale(canvasSize);
	const rows = [];
	for (const t of times) {
		if (t === tg) continue;
		await seekToSeconds(ctx.client, t);
		const m = await measureScene(ctx, { name: `${tag}-t${t}`, canvasSize, axis });
		if (!m.ok) {
			rows.push({ t, missing: { greens: m.greens.length, rings: m.rings.length } });
			continue;
		}
		const sim = similarityOf({ from: ref.greens, to: m.greens });
		const predicted = ref.rings.map((r) => sim.apply(r));
		const err = [dist(predicted[0], m.rings[0]), dist(predicted[1], m.rings[1])];
		rows.push({ t, errPx1920: err.map((e) => round1(e * to1920)), maxErrPx1920: round1(Math.max(...err) * to1920), scene: { zoom: round2(sim.scale), rollDeg: round1(sim.rotDeg) } });
	}
	return { ref: { greens: ref.greens, rings: ref.rings }, rows, worst: Math.max(...rows.map((r) => r.maxErrPx1920 ?? Infinity)) };
}

// the selection handles in DOM order: four corners, right/left/bottom edges, rotation (apps/web/src/preview/components/transform-handles.tsx)
const handleCentres = (client) =>
	client.evaluate(`(() => {
		const buttons = [...(${ed.PREVIEW}).querySelectorAll("button")].filter((b) => !b.innerText.trim() && !b.getAttribute("aria-label"));
		return buttons.map((b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, cursor: getComputedStyle(b).cursor.slice(0, 20) }; });
	})()`);

// ring pair centre in screen coordinates from a measurement
const ringMidScreen = (m) => ({ x: m.rect.x + ((m.rings[0].x + m.rings[1].x) / 2) / m.rings[0].k, y: m.rect.y + ((m.rings[0].y + m.rings[1].y) / 2) / m.rings[0].k });
const ringMid = (m) => ({ x: (m.rings[0].x + m.rings[1].x) / 2, y: (m.rings[0].y + m.rings[1].y) / 2 });

async function waitStuck(client, { timeoutMs = 15_000 } = {}) {
	return waitFor("the chip to be stuck again", async () => {
		const st = await pinState(client);
		return st.chip && !st.chip.analysing && st.chip.hasUnstick ? st : null;
	}, { timeoutMs, intervalMs: 40 });
}


// A drag with Shift held: the preview then does not snap (preview-interaction-controller.ts: shouldSnap = !isShiftHeld). Without it a snap
// guide within 8 screen px pulls the element, which would hide the thing under test (the first E2.10h run saw +20 px@1920 from a snap).
async function dragWithShift(client, from, to, options = {}) {
	const held = await keyDown(client, "shift");
	try {
		return await mouse.drag(client, from, to, { ...options, modifiers: 8 });
	} finally {
		await keyUp(client, held);
	}
}


// ---------------------------------------------------------------- E2.2, E2.3, E2.7, E2.8, E2.9: the ring pair on the markers
const ringKeys = async (client) => channelKeys(await elementOf(client, (e) => e.type === "image" && /^ring-/.test(e.name ?? "")));

async function ringPairCase(ctx, deps, spec) {
	const { R } = deps;
	const { client } = ctx;
	const { id, title, footageName } = spec;
	const axis = spec.axis ?? "x";
	let setup = null;
	let place = null;
	let canvasSize = null;
	let stick = null;

	await R.step(`${id}.0`, `${title}: footage + project, rings placed on the two markers`, async () => {
		// a portrait canvas is small in a 900 px window: a taller window gives the preview (and the measurement) more pixels
		if (spec.viewport) await client.send("Emulation.setDeviceMetricsOverride", { ...deps.VIEWPORT, ...spec.viewport });
		setup = await openFootageProject(ctx, { footageName, rotate90: !!spec.rotate90 });
		canvasSize = setup.canvasSize;
		if (spec.rotate90) expect(canvasSize.height > canvasSize.width, "the rotated clip is shown as landscape: the 90 degree rotation metadata is not applied to the project canvas", { expected: "portrait canvas", actual: canvasSize });
		place = await addRingsOnMarkers(ctx, { canvasSize, axis, tag: id });
		R.metric(`${id}.placement`, { canvasSize, placement: place.placement, scale: place.scale, angleDeg: round2(place.angle), e0: place.e0, rotation: setup.rotation });
		expect(Math.max(...place.e0) * planScale(canvasSize) <= 4.5, "the rings could not be placed on the markers at t = 0 (test setup)", { expected: "<= 4.5 px@1920", actual: place.e0.map((e) => round1(e * planScale(canvasSize))) });
		return { canvasSize, e0: place.e0, footageCached: setup.footage.cached };
	}, { timeoutMs: 240_000 });

	await R.step(`${id}.1`, `${title}: Stick to scene ends 'Stuck' (keys written, no unexpected notice)`, async () => {
		stick = await stickAndWait(ctx, { via: "chip" });
		await sleep(500);
		const keys = await ringKeys(client);
		R.metric(`${id}.stick`, { analysisMs: stick.ms, notices: stick.notices, keys });
		expect(stick.stuck, "the chip did not reach 'Stuck'", { actual: { notices: stick.notices, chip: stick.state.chip } });
		expect(totalKeys(keys) > 0, "no keyframes were written", { actual: keys });
		return { analysisMs: stick.ms, keys, notices: stick.notices };
	}, { timeoutMs: 120_000 });

	await R.step(`${id}.2`, spec.measureTitle, async () => {
		const rows = await measureAtTimes(ctx, { times: spec.times, canvasSize, axis, tag: id, footage: spec.rotate90 ? null : setup.footage, truthFallback: !!spec.truthFallback }); // the truth JSON is in the unrotated frame
		R.metric(`${id}.table`, rows);
		const missing = rows.filter((r) => r.missing);
		expect(missing.length === 0, "markers or rings could not be found in the preview", { actual: missing });
		const worst = Math.max(...rows.map((r) => r.maxErrPx1920));
		const detail = { worstErrPx1920: worst, rows: rows.map((r) => `${r.t}s: err ${r.errPx1920.join("/")} px@1920${r.greenFromTruth ? " (marker hidden: truth)" : ""}, zoom ${r.scaleScene}, ring x${r.scaleRing}, roll ${r.rotSceneDeg} (ring ${r.rotRingDeg})`) };
		expect(worst <= spec.maxPx, `a ring is more than ${spec.maxPx} px (at 1920 wide) off its marker`, { expected: `<= ${spec.maxPx} px@1920`, actual: rows });
		if (spec.extra) Object.assign(detail, (await spec.extra({ rows, stick, setup, place, canvasSize, keys: await ringKeys(client) })) ?? {});
		return detail;
	}, { timeoutMs: 360_000 }).finally(async () => {
		if (spec.viewport) await client.send("Emulation.setDeviceMetricsOverride", deps.VIEWPORT).catch(() => {});
	});
}


// ---------------------------------------------------------------- E2.4 / E2.5: notices, nothing written
async function noticeCase(ctx, deps, { id, footageName, title, text }) {
	const { R } = deps;
	const { client } = ctx;
	let stick = null;
	let before = null;
	await R.step(`${id}.0`, `${title}: footage + project, ring clip over the video`, async () => {
		const setup = await openFootageProject(ctx, { footageName });
		await ed.addAssetToTimeline(client, "ring-pair.png");
		await ed.selectClip(client, "ring-pair.png");
		await setTransform(client, { scale: 0.4 });
		await shootSettled(ctx, `${id}-before`);
		before = JSON.stringify((await elementOf(client, (e) => e.type === "image" && /^ring-/.test(e.name ?? "")))?.animations ?? null);
		return { canvasSize: setup.canvasSize, animationsBefore: before };
	}, { timeoutMs: 240_000 });
	await R.step(`${id}.1`, `${title}: Stick to scene says exactly "${text}", nothing is stuck, no keys, the element is unchanged`, async () => {
		stick = await stickAndWait(ctx, { via: "chip" });
		await sleep(600);
		const element = await elementOf(client, (e) => e.type === "image" && /^ring-/.test(e.name ?? ""));
		const after = JSON.stringify(element?.animations ?? null);
		await ed.propsTab(client, "Tracking");
		const tabState = await pinState(client);
		await ctx.shoot(`${id}-notice`);
		R.metric(`${id}.notice`, { analysisMs: stick.ms, sawProgress: stick.sawAnalysing, chipNotices: stick.state.chip.notices, tabNotices: tabState.tab.notices, chipButtons: stick.state.chip.buttons, animationsBefore: before, animationsAfter: after });
		expect(stick.notices.includes(text) || tabState.tab.notices.includes(text), `the notice "${text}" is not shown`, { expected: text, actual: { chip: stick.state.chip.notices, tab: tabState.tab.notices } });
		expect(tabState.tab.notices.includes(text) && stick.state.chip.notices.includes(text), "the notice is not shown in BOTH the chip and the Tracking tab", { actual: { chip: stick.state.chip.notices, tab: tabState.tab.notices } });
		expect(!stick.stuck && stick.state.chip.hasStick, "the element was stuck although the stick should have been refused", { actual: stick.state.chip });
		expect(after === before, "the element's animations changed although nothing should be written", { expected: before, actual: after });
		return { notices: stick.state.chip.notices, analysisMs: stick.ms, keysWritten: 0 };
	}, { timeoutMs: 120_000 });
}

// ---------------------------------------------------------------- E2.6: pin on a moving object
async function caseObject(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	let setup = null;
	let canvasSize = null;
	let stick = null;
	const k = () => canvasSize.width / setup.footage.video.width;
	await R.step("E2.6.0", "pin on a moving textured disc: footage + single ring placed on the disc centre at t = 0", async () => {
		setup = await openFootageProject(ctx, { footageName: "moving-disc", singleRing: true });
		canvasSize = setup.canvasSize;
		const disc = setup.footage.frames[0].objects[0];
		await ed.addAssetToTimeline(client, "ring-single.png");
		await ed.selectClip(client, "ring-single.png");
		const contain = Math.min(canvasSize.width / assets.RING.width, canvasSize.height / assets.RING.height);
		const scale = round2(0.6);
		await setTransform(client, { scale, x: round2(disc.x * k() - canvasSize.width / 2), y: round2(disc.y * k() - canvasSize.height / 2) });
		const m = await measureScene(ctx, { name: "E2.6-0-placed", canvasSize, needGreen: false });
		const ring = m.rings[0];
		const e0 = ring ? dist(ring, { x: disc.x * k(), y: disc.y * k() }) : null;
		R.metric("E2.6.placement", { disc: { x: round1(disc.x), y: round1(disc.y), r: disc.r }, scale, containScale: contain, ringToDiscPx1920AtT0: round1(e0 * planScale(canvasSize)) });
		expect(e0 !== null && e0 * planScale(canvasSize) <= 3, "the ring is not on the disc centre at t = 0 (test setup)", { actual: e0 });
		return { e0Px1920: round1(e0 * planScale(canvasSize)) };
	}, { timeoutMs: 240_000 });
	await R.step("E2.6.1", "Stick to scene over the moving disc: the chip says 'following the object' and the mode is 'Moving object'", async () => {
		stick = await stickAndWait(ctx, { via: "chip" });
		await sleep(500);
		await ed.propsTab(client, "Tracking");
		const tabState = await pinState(client);
		await ctx.shoot("E2.6-after-stick");
		R.metric("E2.6.stick", { analysisMs: stick.ms, notices: stick.notices, chipButtons: stick.state.chip.buttons, tabStatuses: tabState.tab.statuses });
		expect(stick.stuck, "the chip did not reach 'Stuck'", { actual: { notices: stick.notices, chip: stick.state.chip } });
		expect(stick.notices.includes(TEXTS.object), `the notice "${TEXTS.object}" is not shown`, { actual: stick.notices });
		expect(stick.state.chip.buttons.some((b) => /Moving object/.test(b)), "the Follow choice does not say 'Moving object'", { actual: stick.state.chip.buttons });
		return { notices: stick.notices, tab: tabState.tab.statuses };
	}, { timeoutMs: 120_000 });
	await R.step("E2.6.2", "the ring stays on the moving disc centre at 0, 1.5, 3, 4.5, 4.9 s (<= 8 px@1920)", async () => {
		const rows = [];
		for (const t of [0, 1.5, 3, 4.5, 4.9]) {
			await seekToSeconds(client, t);
			const m = await measureScene(ctx, { name: `E2.6-t${t}`, canvasSize, needGreen: false, needRings: true });
			const disc = setup.footage.frames[Math.round(t * assets.FPS)].objects[0];
			if (m.rings.length < 1) {
				rows.push({ t, missing: true });
				continue;
			}
			const err = dist(m.rings[0], { x: disc.x * k(), y: disc.y * k() }) * planScale(canvasSize);
			rows.push({ t, errPx1920: round1(err), disc: { x: round1(disc.x), y: round1(disc.y) } });
		}
		R.metric("E2.6.table", rows);
		expect(rows.every((r) => !r.missing), "the ring is not visible", { actual: rows });
		const worst = Math.max(...rows.map((r) => r.errPx1920));
		expect(worst <= 8, "the ring left the moving disc", { expected: "<= 8 px@1920", actual: rows });
		return { worstErrPx1920: worst, rows: rows.map((r) => `${r.t}s: ${r.errPx1920} px@1920`) };
	}, { timeoutMs: 240_000 });
}

// ---------------------------------------------------------------- E2.7: scene cut
async function caseCut(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	let setup = null;
	let canvasSize = null;
	let stick = null;
	await R.step("E2.7.0", "scene-cut clip (the world is replaced at 3.0 s): footage + project, rings placed on the markers", async () => {
		setup = await openFootageProject(ctx, { footageName: "cut" });
		canvasSize = setup.canvasSize;
		const place = await addRingsOnMarkers(ctx, { canvasSize, tag: "E2.7" });
		expect(Math.max(...place.e0) <= 3, "the rings could not be placed on the markers at t = 0 (test setup)", { actual: place.e0 });
		return { e0: place.e0 };
	}, { timeoutMs: 240_000 });
	await R.step("E2.7.1", "Stick to scene: stuck, with the notice 'Scene cut at m:ss.s, stuck until there.' at about 3.0 s", async () => {
		stick = await stickAndWait(ctx, { via: "chip" });
		await sleep(500);
		const cutNotice = stick.notices.find((n) => TEXTS.cut.test(n));
		const cutAt = cutNotice ? Number(/at (\d+):(\d\d\.\d)/.exec(cutNotice).slice(1).reduce((a, b, i) => (i === 0 ? Number(a) * 60 : a + Number(b)), 0)) : null;
		R.metric("E2.7.stick", { analysisMs: stick.ms, notices: stick.notices, cutNotice, cutAtSeconds: cutAt, keys: await ringKeys(client) });
		expect(stick.stuck, "the chip did not reach 'Stuck' (the stick should apply up to the cut)", { actual: { notices: stick.notices, chip: stick.state.chip } });
		expect(cutNotice, "no 'Scene cut at ...' notice", { expected: String(TEXTS.cut), actual: stick.notices });
		expect(Math.abs(cutAt - 3.0) <= 0.25, "the reported cut time is not within 0.25 s of the real cut (3.0 s)", { expected: 3.0, actual: cutAt });
		return { cutNotice, cutAtSeconds: cutAt };
	}, { timeoutMs: 120_000 });
	await R.step("E2.7.2", "before the cut the rings are on the markers (<= 6 px@1920 at 0, 1.5, 2.9 s); after the cut the rings HOLD still (change <= 1.5 px@1920 over 3.3 .. 4.9 s)", async () => {
		const before = await measureAtTimes(ctx, { times: [0, 1.5, 2.9], canvasSize, tag: "E2.7", footage: setup.footage });
		const held = [];
		for (const t of [3.3, 4.0, 4.9]) {
			await seekToSeconds(client, t);
			const m = await measureScene(ctx, { name: `E2.7-after-t${t}`, canvasSize, needGreen: false });
			held.push({ t, rings: m.rings.slice(0, 2).map((r) => ({ x: round1(r.x), y: round1(r.y) })), ok: m.rings.length === 2 });
		}
		const moved = held.every((h) => h.ok) ? Math.max(...held.flatMap((h) => [dist(h.rings[0], held[0].rings[0]), dist(h.rings[1], held[0].rings[1])])) * planScale(canvasSize) : null;
		R.metric("E2.7.table", { before, held, heldMovedPx1920: moved === null ? null : round1(moved) });
		expect(before.every((r) => !r.missing), "markers/rings not visible before the cut", { actual: before });
		const worst = Math.max(...before.map((r) => r.maxErrPx1920));
		expect(worst <= 6, "before the cut a ring is more than 6 px@1920 off its marker", { actual: before });
		expect(moved !== null && moved <= 1.5, "after the cut the rings do not hold still", { expected: "<= 1.5 px@1920", actual: { moved, held } });
		return { beforeCutWorstPx1920: worst, heldMovedPx1920: round1(moved) };
	}, { timeoutMs: 360_000 });
}

// ---------------------------------------------------------------- E2.12: host edited after the stick
async function caseStale(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	let setup = null;
	let canvasSize = null;
	await R.step("E2.12.0", "stick on the pan/zoom/roll clip (setup for the stale-host check)", async () => {
		setup = await openFootageProject(ctx, { footageName: "pan-zoom-roll" });
		canvasSize = setup.canvasSize;
		const place = await addRingsOnMarkers(ctx, { canvasSize, tag: "E2.12" });
		expect(Math.max(...place.e0) <= 3, "the rings could not be placed on the markers (test setup)", { actual: place.e0 });
		const stick = await stickAndWait(ctx, { via: "chip" });
		expect(stick.stuck, "setup stick failed", { actual: stick.state.chip });
		return { analysisMs: stick.ms };
	}, { timeoutMs: 240_000 });
	await R.step("E2.12.1", "trim the host video (Split left at 0.5 s): the chip says 'The clip changed after sticking. Stick again.', no crash, no console error", async () => {
		const problemsBefore = ctx.problems.length;
		await ed.selectClip(client, setup.footageBase);
		await seekToSeconds(client, 0.5);
		await clickEl(client, "Split left", () => document.querySelector('button[aria-label="Split left"]'));
		await sleep(900);
		await ed.selectClip(client, "ring-pair.png");
		await sleep(500);
		const st = await pinState(client);
		await ed.propsTab(client, "Tracking");
		const tab = await pinState(client);
		await ctx.shoot("E2.12-after-host-trim");
		const alive = await client.evaluate("document.querySelectorAll('[aria-label=\"Timeline\"]').length > 0");
		const newProblems = ctx.problems.slice(problemsBefore);
		R.metric("E2.12", { chip: st.chip, tab: tab.tab, pageAlive: alive, newProblems: newProblems.slice(0, 3) });
		expect(alive, "the editor is gone after trimming the host");
		expect(newProblems.length === 0, "console/network problems after the host edit", { actual: newProblems.slice(0, 3) });
		expect(st.chip.notices.includes(TEXTS.stale) && tab.tab.notices.includes(TEXTS.stale), `the notice "${TEXTS.stale}" is not shown in both the chip and the tab`, { expected: TEXTS.stale, actual: { chip: st.chip.notices, tab: tab.tab.notices } });
		return { notices: st.chip.notices, chipButtons: st.chip.buttons };
	}, { timeoutMs: 120_000 });
}


// ---------------------------------------------------------------- process memory (ps), renderer / gpu / main separately
function rssBreakdown(pid) {
	const rows = cp.execFileSync("ps", ["-eo", "pid=,ppid=,rss=,args="]).toString().trim().split("\n").map((line) => {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		return m ? { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), args: m[4] } : null;
	}).filter(Boolean);
	const byParent = new Map();
	for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
	const out = { mainMB: 0, rendererMB: 0, gpuMB: 0, otherMB: 0, totalMB: 0 };
	const stack = [pid];
	const self = rows.find((row) => row.pid === pid);
	if (self) out.mainMB += self.rss;
	for (let guard = 0; stack.length && guard < 500; guard++) {
		for (const child of byParent.get(stack.pop()) ?? []) {
			stack.push(child.pid);
			if (/--type=renderer/.test(child.args)) out.rendererMB += child.rss;
			else if (/--type=gpu-process/.test(child.args)) out.gpuMB += child.rss;
			else out.otherMB += child.rss;
		}
	}
	out.totalMB = out.mainMB + out.rendererMB + out.gpuMB + out.otherMB;
	for (const key of Object.keys(out)) out[key] = Math.round(out[key] / 1024);
	return out;
}

const RAF_PROBE = `(() => {
	if (window.__rafProbe) return;
	const probe = (window.__rafProbe = { frames: 0, running: true });
	const loop = () => { probe.frames++; if (probe.running) requestAnimationFrame(loop); };
	requestAnimationFrame(loop);
})()`;
const rafFrames = (client) => client.evaluate("window.__rafProbe ? window.__rafProbe.frames : null");

// Stretch a clip's right edge to `seconds` by dragging its resize handle (a real user does the same: default new clips are 5 s)
async function extendClipTo(client, name, seconds) {
	expect((await ed.clipsInfo(client)).find((c) => c.name === name), `clip ${name} not on the timeline`);
	await ed.selectClip(client, name);
	// the timeline starts zoomed in (a 5 s clip is wider than the window): zoom out until the stretched clip fits on screen
	for (let i = 0; i < 12; i++) {
		const current = (await ed.clipsInfo(client)).find((c) => c.name === name);
		const secondsNow = (await elementOf(client, (e) => e.name === name))?.duration / 120_000;
		const right = await client.evaluate(`document.querySelector('[aria-label="Timeline"]').getBoundingClientRect().right`);
		if (current.x + current.w * (seconds / secondsNow) < right - 40) break;
		await ed.zoomClip(client, "out", 1);
	}
	await ed.selectClip(client, name);
	const clip = (await ed.clipsInfo(client)).find((c) => c.name === name);
	const elementBefore = (await elementOf(client, (e) => e.name === name))?.duration;
	const secondsBefore = elementBefore / 120_000;
	const pps = clip.w / secondsBefore;
	const handle = await client.evaluate(`(() => [...document.querySelectorAll('[aria-label="Right resize handle"]')].map((h) => { const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }))()`);
	const edge = clip.x + clip.w;
	const mine = handle.filter((h) => Math.abs(h.x - edge) <= 14 && h.y >= clip.y - 4 && h.y <= clip.y + clip.h + 4).sort((a, b) => Math.abs(a.x - edge) - Math.abs(b.x - edge))[0];
	expect(mine, "the clip's right resize handle was not found", { actual: { edge, clipY: clip.y, handles: handle } });
	await mouse.drag(client, mine, { x: mine.x + (seconds - secondsBefore) * pps, y: mine.y }, { steps: 24, stepDelayMs: 20 });
	await sleep(600);
	const after = (await elementOf(client, (e) => e.name === name))?.duration / 120_000;
	return { secondsBefore, secondsAfter: after, pxPerSecond: round1(pps) };
}

// E2.13 (10 s 1080p30: analysis time, Esc cancel, second pin) and the RSS experiment (20 cold analyses, then forced GC)
async function caseLongClip(ctx, deps, shared) {
	const { R } = deps;
	const { client } = ctx;
	const pid = ctx.app.child.pid;
	let setup = null;
	let canvasSize = null;
	await R.step("E2.13.0", "10 s 1920x1080 30 fps footage (pan + zoom + roll) generated; project opens; the ring pair is placed and its clip stretched to 10 s", async () => {
		setup = await openFootageProject(ctx, { footageName: "pan-zoom-roll", footageOptions: { outName: "long-1080p", seconds: 10, outWidth: 1920, outHeight: 1080, poseOverride: (t) => assets.PAN_ZOOM_ROLL(t * 0.6) } });
		canvasSize = setup.canvasSize;
		expect(canvasSize.width === 1920 && canvasSize.height === 1080, "the project canvas is not 1920x1080", { actual: canvasSize });
		const place = await addRingsOnMarkers(ctx, { canvasSize, tag: "E2.13" });
		expect(Math.max(...place.e0) <= 3, "the rings could not be placed on the markers (test setup)", { actual: place.e0 });
		const stretched = await extendClipTo(client, "ring-pair.png", 10);
		R.metric("E2.13.setup", { footage: path.basename(setup.footage.file), generatedSeconds: setup.footage.generatedSeconds ?? "cached", stretched });
		expect(Math.abs(stretched.secondsAfter - 10) <= 0.1, "the ring clip could not be stretched to 10 s", { actual: stretched });
		return { canvasSize, stretched };
	}, { timeoutMs: 300_000 });
	if (!cameraWanted("E2.13")) return caseRss(ctx, deps, { setup, pid });

	await R.step("E2.13.1", "Esc during the analysis (>= 20%): cancelled within 0.5 s, nothing written, the element is unchanged, the chip offers Stick again", async () => {
		await client.evaluate(RAF_PROBE);
		const animationsBefore = JSON.stringify((await elementOf(client, (e) => e.name === "ring-pair.png"))?.animations ?? null);
		await clickEl(client, "Stick to scene (chip)", byTextFinder("button", "Stick to scene", ed.PREVIEW));
		let percent = null;
		for (let i = 0; i < 600; i++) {
			const st = await pinState(client);
			percent = st.chip.percent;
			if (st.chip.analysing && percent >= 20) break;
			await sleep(20);
		}
		expect(percent !== null && percent >= 20, "the analysis never reached 20%", { actual: percent });
		const t0 = Date.now();
		await press(client, "Escape");
		let state = null;
		let cancelMs = null;
		for (let i = 0; i < 500; i++) {
			state = await pinState(client);
			if (!state.chip.analysing) {
				cancelMs = Date.now() - t0;
				break;
			}
			await sleep(5);
		}
		await sleep(400);
		const settled = await pinState(client);
		const animationsAfter = JSON.stringify((await elementOf(client, (e) => e.name === "ring-pair.png"))?.animations ?? null);
		R.metric("E2.13.cancel", { percentWhenEscPressed: percent, escToUiIdleMs: cancelMs, chip: settled.chip, animationsUnchanged: animationsBefore === animationsAfter });
		expect(cancelMs !== null, "the analysis did not stop after Esc", { actual: state.chip });
		expect(cancelMs <= 500, "the cancel took longer than 0.5 s", { expected: "<= 500 ms", actual: cancelMs });
		expect(settled.chip.hasStick && !settled.chip.hasUnstick, "after the cancel the chip does not offer 'Stick to scene'", { actual: settled.chip });
		expect(animationsBefore === animationsAfter, "a cancelled analysis changed the element", { expected: animationsBefore, actual: animationsAfter });
		return { percentWhenEscPressed: percent, escToUiIdleMs: cancelMs, statuses: settled.chip.statuses };
	}, { timeoutMs: 120_000 });

	let analysisMs = null;
	await R.step("E2.13.2", "full analysis of the 10 s 1080p30 window: <= 5 s, the UI stays alive (rAF rate), fps reported", async () => {
		const rssBefore = rssBreakdown(pid);
		const rafBefore = await rafFrames(client);
		const t0 = Date.now();
		const stick = await stickAndWait(ctx, { via: "chip" });
		const wallMs = Date.now() - t0;
		const rafAfter = await rafFrames(client);
		analysisMs = stick.ms;
		await ed.propsTab(client, "Tracking");
		const tab = await pinState(client);
		const range = tab.tab.statuses.find((t) => /^Stuck/.test(t)) ?? null;
		const keys = await ringKeys(client);
		const frames = 300;
		const rssAfter = rssBreakdown(pid);
		const rafPerSecond = round1(((rafAfter - rafBefore) / wallMs) * 1000);
		R.metric("E2.13.analysis", { analysisMs: stick.ms, clickToStuckMs: stick.clickToDone, frames, framesPerSecond: round1((frames / stick.ms) * 1000), realtimeFactor: round2(stick.ms / 10_000), rafPerSecondDuringRun: rafPerSecond, progressSamples: stick.percentSamples.length, range, keys, rssBefore, rssAfter, notices: stick.notices });
		expect(stick.stuck, "the 10 s clip did not end 'Stuck'", { actual: { notices: stick.notices, chip: stick.state.chip } });
		expect(range && /0:09\.\d/.test(range), "the stuck range does not cover the 10 s window", { actual: range });
		expect(stick.ms <= 5000, "the analysis of 10 s of 1080p30 video took longer than 5 s", { expected: "<= 5000 ms", actual: stick.ms });
		return { analysisMs: stick.ms, framesPerSecond: round1((frames / stick.ms) * 1000), xRealtime: round2(10_000 / stick.ms), rafPerSecondDuringRun: rafPerSecond, range, keys };
	}, { timeoutMs: 180_000 });

	await R.step("E2.13.3", "a second element on the same video sticks from the cached analysis in < 100 ms (and 'Stuck' appears without a progress bar)", async () => {
		await ed.seekStart(client);
		await ed.addDefaultText(client);
		await ed.selectClip(client, "Default text");
		await ed.propsTab(client, "Transform");
		const stick = await stickAndWait(ctx, { via: "chip" });
		R.metric("E2.13.secondPin", { polledMs: stick.ms, pageMs: stick.pageMs, sawProgress: stick.sawAnalysing, notices: stick.notices });
		expect(stick.stuck, "the second element did not end 'Stuck'", { actual: { notices: stick.notices, chip: stick.state.chip } });
		expect(!stick.sawAnalysing, "a second pin on the same video ran a new analysis (cache miss)", { actual: stick.percentSamples.slice(0, 3) });
		// the polled time can never be under 150 ms (see stickAndWait): the in-page click-to-frame time is the user-visible latency
		expect(stick.pageMs !== null, "the in-page timing of the second pin was not recorded", { actual: stick.pageMs });
		expect(stick.pageMs.frame < 100, "the second pin took 100 ms or more from the click to the frame showing 'Stuck'", { expected: "< 100 ms (click event to the next frame, in the page)", actual: stick.pageMs });
		return { pageFrameMs: stick.pageMs.frame, pageDomMs: stick.pageMs.dom, polledMs: stick.ms };
	}, { timeoutMs: 120_000 });

	if (cameraWanted("E2.RSS")) await caseRss(ctx, deps, { setup, pid, alreadyStuck: true });
}

// 20 cold analyses (the host clip is deleted and added again each time, so the analysis cache cannot answer), RSS every 5, then forced GC
async function caseRss(ctx, deps, { setup, pid }) {
	const { R } = deps;
	const { client } = ctx;
	const N = Number(process.env.CAMERA_RSS_RUNS ?? 20);
	await R.step("E2.RSS", `${N} cold analyses of the 10 s 1080p clip (stick, unstick), RSS and JS heap every 5 runs, then forced GC (HeapProfiler.collectGarbage) and RSS again`, async () => {
		const heapMB = async () => {
			await client.send("Performance.enable").catch(() => {});
			const { metrics } = await client.send("Performance.getMetrics");
			return round1(metrics.find((m) => m.name === "JSHeapUsedSize").value / 1048576);
		};
		const samples = [];
		const take = async (label) => {
			samples.push({ label, ...rssBreakdown(pid), jsHeapMB: await heapMB() });
			console.log(`        rss ${label}: ${JSON.stringify(samples.at(-1))}`);
		};
		await take("start");
		const runs = [];
		for (let i = 1; i <= N; i++) {
			await ed.seekStart(client);
			await ed.selectClip(client, setup.footageBase);
			await press(client, "delete");
			await sleep(500);
			await ed.addAssetToTimeline(client, setup.footageBase);
			await ed.selectClip(client, "ring-pair.png");
			const stick = await stickAndWait(ctx, { via: "chip" });
			expect(stick.stuck && stick.sawAnalysing, `run ${i}: the stick did not run a cold analysis to 'Stuck'`, { actual: { notices: stick.notices, saw: stick.sawAnalysing } });
			runs.push(stick.ms);
			await clickEl(client, "Unstick", byTextFinder("button", "Unstick", ed.PREVIEW));
			await sleep(300);
			if (i === 1 || i % 5 === 0) await take(`after-${i}`);
		}
		await take("before-gc");
		for (let i = 0; i < 3; i++) {
			await client.send("HeapProfiler.collectGarbage").catch(() => {});
			await sleep(1500);
		}
		await sleep(5000);
		await take("after-gc");
		const first = samples.find((x) => x.label === "after-1");
		const lastBeforeGc = samples.find((x) => x.label === "before-gc");
		const afterGc = samples.at(-1);
		const growthRenderer = lastBeforeGc.rendererMB - first.rendererMB;
		const releasedByGc = lastBeforeGc.rendererMB - afterGc.rendererMB;
		R.metric("E2.RSS", { runs: N, analysisMs: { first: runs[0], median: [...runs].sort((a, b) => a - b)[Math.floor(runs.length / 2)], max: Math.max(...runs) }, samples, rendererGrowthAfterFirstRunToBeforeGcMB: growthRenderer, rendererReleasedByGcMB: releasedByGc, totalGrowthMB: lastBeforeGc.totalMB - first.totalMB });
		return { runs: N, rendererMB: `${first.rendererMB} (after run 1) -> ${lastBeforeGc.rendererMB} (after run ${N}) -> ${afterGc.rendererMB} (after forced GC)`, totalMB: `${first.totalMB} -> ${lastBeforeGc.totalMB} -> ${afterGc.totalMB}`, jsHeapMB: `${first.jsHeapMB} -> ${lastBeforeGc.jsHeapMB} -> ${afterGc.jsHeapMB}`, growthMB: growthRenderer, releasedByGcMB: releasedByGc };
	}, { timeoutMs: 900_000 });
}


// ---------------------------------------------------------------- E2.11: exported frames vs preview
function exportedFrame(file, seconds) {
	const png = cp.execFileSync("/usr/bin/ffmpeg", ["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 1 << 28 });
	return decodePng(png);
}

async function caseExportParity(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	const x = require("./features-export").internals;
	let setup = null;
	let canvasSize = null;
	const TIMES = [1.5, 3, 4.5];
	await R.step("E2.11.0", "stick the pan/zoom/roll clip (setup for the export parity check)", async () => {
		setup = await openFootageProject(ctx, { footageName: "pan-zoom-roll" });
		canvasSize = setup.canvasSize;
		const place = await addRingsOnMarkers(ctx, { canvasSize, tag: "E2.11" });
		expect(Math.max(...place.e0) <= 3, "the rings could not be placed on the markers (test setup)", { actual: place.e0 });
		const stick = await stickAndWait(ctx, { via: "chip" });
		expect(stick.stuck, "setup stick failed", { actual: stick.state.chip });
		return { analysisMs: stick.ms };
	}, { timeoutMs: 240_000 });
	await R.step("E2.11.1", "the exported MP4 frames at 1.5, 3, 4.5 s have the rings and markers where the preview shows them (<= 2 px@1920)", async () => {
		const preview = [];
		for (const t of TIMES) {
			await seekToSeconds(client, t);
			const m = await measureScene(ctx, { name: `E2.11-preview-t${t}`, canvasSize });
			expect(m.ok, `markers/rings not visible in the preview at ${t} s`);
			preview.push({ t, greens: m.greens.map((g) => ({ x: g.x, y: g.y })), rings: m.rings.map((r) => ({ x: r.x, y: r.y })) });
		}
		await seekToSeconds(client, 0);
		await x.installHook(client);
		await x.setExportOptions(client, { format: "mp4", includeAudio: false });
		const result = await x.runExport(ctx, { timeoutMs: 240_000, saveAs: "E2.11-export.mp4" });
		expect(result.outcome === "success", `the export did not succeed (${result.outcome})`, { actual: result.errorText });
		const fileCopy = path.join(SHOT_DIR, "E2.11-export.mp4");
		fs.copyFileSync(result.file, fileCopy);
		const rows = [];
		for (let i = 0; i < TIMES.length; i++) {
			const t = TIMES[i];
			const image = exportedFrame(result.file, t);
			fs.writeFileSync(path.join(SHOT_DIR, `E2.11-export-t${t}.png`), decodedToPng(image));
			const greens = orderPair(inCanvas({ blobs: findBlobs(image, scoreGreen, { threshold: 70, full: 215, minCount: 120 }), image, canvasSize }));
			const rings = orderPair(inCanvas({ blobs: findBlobs(image, scoreMagenta, { threshold: 80, full: 255, minCount: 60 }), image, canvasSize }));
			if (greens.length < 2 || rings.length < 2) {
				rows.push({ t, missing: { greens: greens.length, rings: rings.length } });
				continue;
			}
			const to1920 = planScale(canvasSize);
			const dRing = [dist(rings[0], preview[i].rings[0]), dist(rings[1], preview[i].rings[1])].map((d) => round1(d * to1920));
			const dGreen = [dist(greens[0], preview[i].greens[0]), dist(greens[1], preview[i].greens[1])].map((d) => round1(d * to1920));
			const exportErr = [dist(greens[0], rings[0]), dist(greens[1], rings[1])].map((d) => round1(d * to1920));
			rows.push({ t, ringPreviewVsExportPx1920: dRing, markerPreviewVsExportPx1920: dGreen, ringToMarkerInExportPx1920: exportErr, exportSize: `${image.width}x${image.height}` });
		}
		R.metric("E2.11.table", { exportMs: result.ms, file: fileCopy, rows });
		expect(rows.every((r) => !r.missing), "markers/rings not found in an exported frame", { actual: rows });
		const worst = Math.max(...rows.flatMap((r) => [...r.ringPreviewVsExportPx1920, ...r.markerPreviewVsExportPx1920]));
		expect(worst <= 2, "an exported frame differs from the preview by more than 2 px@1920", { expected: "<= 2 px@1920", actual: rows });
		return { worstPreviewVsExportPx1920: worst, rows: rows.map((r) => `${r.t}s: ring ${r.ringPreviewVsExportPx1920.join("/")}, marker ${r.markerPreviewVsExportPx1920.join("/")}, ring-to-marker in the file ${r.ringToMarkerInExportPx1920.join("/")} px@1920 (${r.exportSize})`) };
	}, { timeoutMs: 400_000 });
}

// png.js has a decoder only: re-encode RGBA for evidence files (tiny encoder, same as the ring PNG)
function decodedToPng(image) {
	return assets.encodePngRgba({ width: image.width, height: image.height, data: image.data });
}


// ---------------------------------------------------------------- E2.1t: a TEXT clip (real text box) on the pan/zoom/roll clip
// All magenta pixels as one cloud: soft area, centroid and principal-axis angle (a long line of text has a clear axis)
function cloudOf(image, score, { full = 255, floor = 8 } = {}) {
	const { width, height, data } = image;
	let sw = 0;
	let sx = 0;
	let sy = 0;
	let x0 = width;
	let x1 = 0;
	let y0 = height;
	let y1 = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const v = score(data[i], data[i + 1], data[i + 2]);
			if (v <= floor) continue;
			const w = Math.min(1, v / full);
			sw += w;
			sx += w * (x + 0.5);
			sy += w * (y + 0.5);
			if (v > 60) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (sw < 30) return null;
	const cx = sx / sw;
	const cy = sy / sw;
	let cxx = 0;
	let cyy = 0;
	let cxy = 0;
	for (let y = Math.max(0, y0 - 2); y <= Math.min(height - 1, y1 + 2); y++) {
		for (let x = Math.max(0, x0 - 2); x <= Math.min(width - 1, x1 + 2); x++) {
			const i = (y * width + x) * 4;
			const v = score(data[i], data[i + 1], data[i + 2]);
			if (v <= floor) continue;
			const w = Math.min(1, v / full);
			cxx += w * (x + 0.5 - cx) ** 2;
			cyy += w * (y + 0.5 - cy) ** 2;
			cxy += w * (x + 0.5 - cx) * (y + 0.5 - cy);
		}
	}
	return { area: sw, x: cx, y: cy, angleDeg: (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI, bboxW: x1 - x0 + 1, bboxH: y1 - y0 + 1, elongation: Math.sqrt(Math.max(cxx, cyy) / Math.max(1e-9, Math.min(cxx, cyy))) };
}
const angleDiff180 = (a, b) => ((((a - b) % 180) + 270) % 180) - 90;

async function measureText(ctx, { name, canvasSize }) {
	let last = null;
	for (let attempt = 0; attempt < 10; attempt++) {
		const shot = await shootSettled(ctx, name);
		const greens = orderPair(inCanvas({ blobs: findBlobs(shot.image, scoreGreen, { threshold: 70, full: 215, minCount: 120 }), image: shot.image, canvasSize }));
		const cloud = cloudOf(shot.image, scoreMagenta);
		const k = canvasSize.width / shot.image.width;
		last = { greens, text: cloud && { ...cloud, x: cloud.x * k, y: cloud.y * k, area: cloud.area * k * k, bboxW: cloud.bboxW * k, bboxH: cloud.bboxH * k }, k };
		if (greens.length === 2 && cloud) return { ...last, ok: true };
		await sleep(250);
	}
	return { ...last, ok: false };
}

async function caseText(ctx, deps) {
	const { R } = deps;
	const { client } = ctx;
	let setup = null;
	let canvasSize = null;
	let ref = null;
	await R.step("E2.1t.0", "TEXT clip (magenta 'Default text') placed on the middle of the two markers at t = 0; its real box is measured", async () => {
		setup = await openFootageProject(ctx, { footageName: "pan-zoom-roll", withRing: false });
		canvasSize = setup.canvasSize;
		const markers = await measureScene(ctx, { name: "E2.1t-0-markers", canvasSize, needRings: false });
		expect(markers.ok, "the two green markers are not visible at t = 0", { actual: markers.greens.length });
		await ed.addDefaultText(client);
		await ed.selectClip(client, "Default text");
		await ed.propsTab(client, "Text");
		await ed.typeInto(client, "Font Size", "6"); // small first: a big text placed at the marker midpoint is cut by the canvas edge and its box cannot be measured
		await clickEl(client, "text colour hex box", `() => [...(${ed.PROPS}).querySelectorAll("input")].find((i) => /^[0-9A-Fa-f]{6}$/.test(i.value))`);
		await press(client, "ctrl+a");
		await client.send("Input.insertText", { text: "FF00FF" });
		await press(client, "Enter");
		await press(client, "Tab");
		await sleep(400);
		const mid = { x: (markers.greens[0].x + markers.greens[1].x) / 2, y: (markers.greens[0].y + markers.greens[1].y) / 2 };
		await setTransform(client, { x: round2(mid.x - canvasSize.width / 2), y: round2(mid.y - canvasSize.height / 2) });
		const textElement = await elementOf(client, (e) => e.type === "text");
		R.metric("E2.1t.transformAfterPlacement", { wanted: { x: round2(mid.x - canvasSize.width / 2), y: round2(mid.y - canvasSize.height / 2) }, read: await readTransform(client), stored: { positionX: textElement?.params?.["transform.positionX"], positionY: textElement?.params?.["transform.positionY"], fontSize: textElement?.params?.fontSize, startTime: textElement?.startTime, duration: textElement?.duration, animations: textElement?.animations ?? null } });
		let m = await measureText(ctx, { name: "E2.1t-0-placed", canvasSize });
		expect(m.ok, "the magenta text is not visible", { actual: m });
		// fit the box between the markers (they are 300 canvas px apart at 1280 wide): text about 190 px wide
		const width6 = m.text.bboxW;
		if (width6 < 150 || width6 > 230) {
			const size = Math.max(1, Math.round((6 * 190) / width6));
			await ed.propsTab(client, "Text");
			await ed.typeInto(client, "Font Size", String(size));
			m = await measureText(ctx, { name: "E2.1t-0-placed2", canvasSize });
			R.metric("E2.1t.fontSize", { widthAtSize6: round1(width6), chosenSize: size, widthAfter: round1(m.text.bboxW) });
		}
		// one position correction from the measured residual
		const residual = { x: mid.x - m.text.x, y: mid.y - m.text.y };
		await ed.propsTab(client, "Transform");
		const tr = await readTransform(client);
		expect(tr.x !== null && tr.x !== undefined, "Position X could not be read from the Transform tab (test setup)", { actual: tr });
		if (Math.hypot(residual.x, residual.y) > 0.8) await setTransform(client, { x: round2(tr.x + residual.x), y: round2(tr.y + residual.y) });
		m = await measureText(ctx, { name: "E2.1t-0-final", canvasSize });
		expect(m.ok, "the magenta text is not visible after the correction");
		ref = { text: m.text, greens: m.greens };
		const offset = dist(m.text, mid) * planScale(canvasSize);
		R.metric("E2.1t.text", { boxWidthCanvasPx: round1(m.text.bboxW), boxHeightCanvasPx: round1(m.text.bboxH), elongation: round1(m.text.elongation), axisDeg: round2(m.text.angleDeg), centreToMarkerMidpointPx1920: round1(offset) });
		expect(m.text.elongation > 2.5, "the text cloud is too round for an angle measurement (test setup)", { actual: m.text.elongation });
		expect(offset <= 3, "the text is not centred between the markers at t = 0 (test setup)", { actual: offset });
		return { boxWidthPx: round1(m.text.bboxW), centreToMidpointPx1920: round1(offset), elongation: round1(m.text.elongation) };
	}, { timeoutMs: 240_000 });
	await R.step("E2.1t.1", "press Stick to scene on the text clip: 'Stuck', keys on all five channels", async () => {
		const stick = await stickAndWait(ctx, { via: "chip" });
		await sleep(500);
		const keys = channelKeys(await elementOf(client, (e) => e.type === "text"));
		R.metric("E2.1t.stick", { analysisMs: stick.ms, notices: stick.notices, keys });
		expect(stick.stuck, "the chip did not reach 'Stuck'", { actual: { notices: stick.notices, chip: stick.state.chip } });
		for (const channel of ["positionX", "positionY", "scaleX", "scaleY", "rotate"]) expect(keys[channel] > 0, `channel ${channel} has no keyframes`, { actual: keys });
		return { analysisMs: stick.ms, keys, notices: stick.notices };
	}, { timeoutMs: 120_000 });
	await R.step("E2.1t.2", "THE TEXT STAYS ON THE SIGN: at 1.5, 3, 4.5, 4.9 s the text sits where the scene motion carries it (<= 6 px@1920), size follows the zoom (<= 3%), its baseline turns with the roll (<= 1.5 deg)", async () => {
		const rows = [];
		const textElementNow = await elementOf(client, (e) => e.type === "text");
		for (const t of [1.5, 3, 4.5, 4.9]) {
			await seekToSeconds(client, t);
			const m = await measureText(ctx, { name: `E2.1t-t${t}`, canvasSize });
			if (!m.ok) {
				rows.push({ t, missing: true });
				continue;
			}
			const sim = similarityOf({ from: ref.greens, to: m.greens });
			const predicted = sim.apply(ref.text);
			const err = dist(predicted, m.text) * planScale(canvasSize);
			const sizeRatio = Math.sqrt(m.text.area / ref.text.area);
			const widthRatio = m.text.bboxW / ref.text.bboxW; // thin glyph strokes make the soft-area ratio read ~3% low, the extent does not
			rows.push({ t, keyedScaleX: round2(keyedValueAt(textElementNow, "scaleX", t)), keyedScaleY: round2(keyedValueAt(textElementNow, "scaleY", t)), keyedRotate: round1(keyedValueAt(textElementNow, "rotate", t)), errPx1920: round1(err), sceneZoom: round2(sim.scale), textSizeRatio: round2(sizeRatio), textWidthRatio: round2(widthRatio), widthErrPct: round2((Math.abs(widthRatio - sim.scale) / sim.scale) * 100), keyedErrPct: round2((Math.abs(keyedValueAt(textElementNow, "scaleX", t) - sim.scale) / sim.scale) * 100), sizeErrPct: round2((Math.abs(sizeRatio - sim.scale) / sim.scale) * 100), sceneRollDeg: round1(sim.rotDeg), textTurnedDeg: round1(angleDiff180(m.text.angleDeg, ref.text.angleDeg)), rotErrDeg: round2(angleDiff180(angleDiff180(m.text.angleDeg, ref.text.angleDeg), sim.rotDeg)) });
		}
		R.metric("E2.1t.table", rows);
		expect(rows.every((r) => !r.missing), "text or markers not visible", { actual: rows });
		const worst = Math.max(...rows.map((r) => r.errPx1920));
		const worstSize = Math.max(...rows.map((r) => r.widthErrPct));
		const worstKeyed = Math.max(...rows.map((r) => r.keyedErrPct));
		const worstArea = Math.max(...rows.map((r) => r.sizeErrPct));
		R.metric("E2.1t.sizeChecks", { worstWidthErrPct: worstSize, worstKeyedScaleErrPct: worstKeyed, worstSoftAreaErrPct: worstArea, note: "width = extent of the text (verdict); soft area is biased low by thin strokes (reported only); keyed = the scale keys the engine wrote vs the scene zoom" });
		const worstRot = Math.max(...rows.map((r) => Math.abs(r.rotErrDeg)));
		expect(worst <= 6, "the text is more than 6 px@1920 away from where the scene carries it", { expected: "<= 6 px@1920", actual: rows });
		expect(worstSize <= 3, "the text width does not follow the zoom within 3%", { expected: "<= 3 %", actual: rows });
		expect(worstKeyed <= 1, "the scale keys written for the text differ from the scene zoom by more than 1%", { expected: "<= 1 %", actual: rows });
		expect(worstRot <= 1.5, "the text does not turn with the roll within 1.5 degrees", { expected: "<= 1.5 deg", actual: rows });
		return { worstErrPx1920: worst, worstWidthErrPct: worstSize, worstKeyedScaleErrPct: worstKeyed, worstSoftAreaErrPct: worstArea, worstRotErrDeg: worstRot, rows: rows.map((r) => `${r.t}s: err ${r.errPx1920} px@1920, zoom ${r.sceneZoom} (text width x${r.textWidthRatio}, soft area x${r.textSizeRatio}, keyed scale ${r.keyedScaleX}/${r.keyedScaleY}), roll ${r.sceneRollDeg} (text ${r.textTurnedDeg}, keyed ${r.keyedRotate})`) };
	}, { timeoutMs: 360_000 });
}

// ---------------------------------------------------------------- the cases
async function scenarioCamera(ctx, deps) {
	const { R } = deps;
	fs.mkdirSync(SHOT_DIR, { recursive: true });
	// screenshots are kept between runs (same names are overwritten); CAMERA_CLEAN_SHOTS=1 empties the folder first
	if (process.env.CAMERA_CLEAN_SHOTS) for (const name of fs.readdirSync(SHOT_DIR)) if (/\.(png|mp4)$/.test(name)) fs.rmSync(path.join(SHOT_DIR, name), { force: true });
	R.note("cameraShots", SHOT_DIR);
	const shared = { memory: [] };

	if (cameraWanted("E2.1") || cameraWanted("E2.10")) await caseCore(ctx, deps, shared);
	if (cameraWanted("E2.1t")) await caseText(ctx, deps);
	if (cameraWanted("E2.13") || cameraWanted("E2.RSS")) await caseLongClip(ctx, deps, shared);
	if (cameraWanted("E2.4")) await noticeCase(ctx, deps, { id: "E2.4", footageName: "flat", title: "flat grey wall (no texture)", text: TEXTS.noTexture });
	if (cameraWanted("E2.5")) await noticeCase(ctx, deps, { id: "E2.5", footageName: "still", title: "static camera", text: TEXTS.noMotion });
	if (cameraWanted("E2.2")) await ringPairCase(ctx, deps, { id: "E2.2", title: "hand shake", footageName: "shake", times: [0, 1.5, 3, 4.5, 4.9], maxPx: 6, measureTitle: "with hand shake the rings stay on the markers at 0, 1.5, 3, 4.5, 4.9 s (<= 6 px@1920)" });
	if (cameraWanted("E2.3")) {
		await ringPairCase(ctx, deps, {
			id: "E2.3",
			title: "object passing in front",
			footageName: "occluder",
			times: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 4.9],
			maxPx: 6,
			truthFallback: true,
			measureTitle: "while a big object crosses in front of the markers the rings stay on them (<= 6 px@1920 at 11 times) with no jump (<= 4 px@1920 between samples)",
			extra: ({ rows }) => {
				const jumps = rows.slice(1).map((r, i) => Math.abs(r.maxErrPx1920 - rows[i].maxErrPx1920));
				const worstJump = Math.max(...jumps);
				expect(worstJump <= 4, "the ring jumps while the object passes", { expected: "<= 4 px@1920 between samples", actual: rows.map((r) => `${r.t}: ${r.maxErrPx1920}`) });
				return { worstJumpPx1920: round1(worstJump), markerHiddenAt: rows.filter((r) => r.greenFromTruth).map((r) => r.t) };
			},
		});
	}
	if (cameraWanted("E2.6")) await caseObject(ctx, deps);
	if (cameraWanted("E2.7")) await caseCut(ctx, deps);
	if (cameraWanted("E2.8")) {
		await ringPairCase(ctx, deps, {
			id: "E2.8",
			title: "perspective pan (yaw 12 degrees)",
			footageName: "yaw",
			times: [0, 1.5, 3, 4.5, 4.9],
			maxPx: 8,
			measureTitle: "with a 12 degree yaw (homography) the rings stay on the markers (<= 8 px@1920) and scaleX differs from scaleY",
			extra: async ({ keys }) => {
				const element = await elementOf(ctx.client, (e) => e.type === "image" && /^ring-/.test(e.name ?? ""));
				const sx = element?.animations?.["transform.scaleX"]?.keys ?? [];
				const sy = element?.animations?.["transform.scaleY"]?.keys ?? [];
				const valueOf = (key) => key?.value ?? key?.v ?? null;
				const lastX = valueOf(sx.at(-1));
				const lastY = valueOf(sy.at(-1));
				const spread = Math.max(0, ...sx.map((key, i) => Math.abs(valueOf(key) - valueOf(sy[Math.min(i, sy.length - 1)]))));
				R.metric("E2.8.scale", { keysX: sx.length, keysY: sy.length, firstKeyShape: sx[0] ?? null, lastScaleX: lastX, lastScaleY: lastY, maxAbsDiffXY: round2(spread) });
				expect(sx.length > 0 && sy.length > 0 && spread > 0.002, "scaleX and scaleY keys are identical (no perspective squeeze written)", { actual: { sx: sx.slice(-2), sy: sy.slice(-2) } });
				return { lastScaleX: lastX, lastScaleY: lastY, maxAbsDiffXY: round2(spread), keys };
			},
		});
	}
	if (cameraWanted("E2.9")) await ringPairCase(ctx, deps, { id: "E2.9", title: "90 degree rotation metadata (phone video)", footageName: "pan-zoom-roll", rotate90: true, axis: "y", viewport: { height: 1800 }, times: [0, 1.5, 3, 4.5, 4.9], maxPx: 6, measureTitle: "the rotated clip is stuck in the right direction: rings on the markers at 0, 1.5, 3, 4.5, 4.9 s (<= 6 px@1920)" });
	if (cameraWanted("E2.11")) await caseExportParity(ctx, deps);
	if (cameraWanted("E2.12")) await caseStale(ctx, deps);
	R.metric("E2.sharedMemory", shared.memory);
	if (seekLog.length) R.metric("E2.seekRetries", seekLog);
}

// E2.1 (pan + zoom + roll, the core promise) and E2.10 (stick / undo / redo / unstick / drag) on one project
async function caseCore(ctx, deps, shared) {
	const { R } = deps;
	const { client } = ctx;
	let setup = null;
	let place = null;
	let canvasSize = null;
	let stick = null;
	const TIMES = [0, 1.5, 3, 4.5, 4.9];

	await R.step("E2.0", "footage (pan 100 px/s + zoom 1 -> 1.4 + roll +-8 deg) + magenta ring PNG generated, project opens with the video", async () => {
		setup = await openFootageProject(ctx, { footageName: "pan-zoom-roll" });
		canvasSize = setup.canvasSize;
		expect(setup.footage.frames.length === 180, "footage has the wrong frame count", { actual: setup.footage.frames.length });
		return { file: setup.footage.file, cached: setup.footage.cached, generatedSeconds: setup.footage.generatedSeconds ?? null, canvasSize };
	}, { timeoutMs: 240_000 });

	await R.step("E2.1.0", "the ring PNG sits on the two green markers at t = 0 before sticking (placement error from the measured markers)", async () => {
		place = await addRingsOnMarkers(ctx, { canvasSize, tag: "E2.1" });
		R.metric("E2.1.placement", { placement: place.placement, scale: place.scale, angleDeg: round2(place.angle), spacingCanvasPx: round1(place.spacing), residualBeforeCorrection: { x: round2(place.residual.x), y: round2(place.residual.y) }, corrected: place.corrected, e0: place.e0, greenSideCanvasPx: round1(place.greenSide), ringOuterCanvasPx: round1(place.ringOuter) });
		expect(Math.max(...place.e0) <= 3, "the rings could not be placed on the markers at t = 0 (test setup)", { actual: place });
		return { e0: place.e0, greenSidePx: round1(place.greenSide), ringOuterDiameterPx: round1(place.ringOuter) };
	});

	await R.step("E2.1.1", "press Stick to scene (chip): progress is shown, the first analysis ends 'Stuck', five keyed channels are written", async () => {
		const selectedRing = await elementOf(client, (e) => e.type === "image" && /^ring-pair/.test(e.name ?? ""));
		expect(selectedRing, "the ring clip is not in the project");
		await ctx.shoot("E2.1-before-stick");
		stick = await stickAndWait(ctx, { via: "chip" });
		await sleep(600);
		const element = await elementOf(client, (e) => e.type === "image" && /^ring-pair/.test(e.name ?? ""));
		const keys = channelKeys(element);
		R.metric("E2.1.stick", { analysisMs: stick.ms, sawProgress: stick.sawAnalysing, progressSamples: stick.percentSamples.length, firstPercent: stick.percentSamples[0], lastPercent: stick.percentSamples.at(-1), notices: stick.notices, keys });
		await shootSettled(ctx, "E2.1-after-stick");
		expect(stick.stuck, "the chip did not reach the 'Stuck' state", { actual: stick.state });
		expect(stick.sawAnalysing, "no analysis progress was ever shown for the first stick", { actual: stick.percentSamples });
		for (const channel of ["positionX", "positionY", "scaleX", "scaleY", "rotate"]) expect(keys[channel] > 0, `channel ${channel} has no keyframes after the stick`, { actual: keys });
		return { analysisMs: stick.ms, progressSamples: stick.percentSamples.length, keys, notices: stick.notices };
	}, { timeoutMs: 120_000 });

	await R.step("E2.1.2", "THE CORE PROMISE: with pan + zoom + roll the rings stay on the markers at t = 0, 1.5, 3, 4.5, 4.9 s: <= 6 px@1920, ring diameter follows the zoom within 3%, rotation follows the roll", async () => {
		const rows = await measureAtTimes(ctx, { times: TIMES, canvasSize, tag: "E2.1", footage: setup.footage });
		R.metric("E2.1.table", rows);
		const missing = rows.filter((r) => r.missing);
		expect(missing.length === 0, "markers or rings could not be found in the preview", { actual: missing });
		const worst = Math.max(...rows.map((r) => r.maxErrPx1920));
		const worstDiameter = Math.max(...rows.map((r) => Math.abs(r.ringOuterRatio - r.scaleScene) / r.scaleScene)); // the ring's outer diameter, as the plan words it
		const worstArea = Math.max(...rows.map((r) => Math.abs(r.ringSizeRatio - r.scaleScene) / r.scaleScene)); // soft area of both rings (more precise, reported)
		const worstPair = Math.max(...rows.map((r) => Math.abs(r.scaleRing - r.scaleScene) / r.scaleScene)); // distance between the two rings
		const worstRot = Math.max(...rows.map((r) => Math.abs(r.rotErrDeg)));
		R.metric("E2.1.worst", { worstErrPx1920: worst, worstErrCanvasPx: Math.max(...rows.map((r) => r.maxErrPx)), canvasWidth: canvasSize.width, worstRingDiameterVsZoomPct: round2(worstDiameter * 100), worstRingAreaVsZoomPct: round2(worstArea * 100), worstRingDistanceVsZoomPct: round2(worstPair * 100), worstRotationErrDeg: worstRot, zoomRange: [rows[0].scaleScene, rows.at(-1).scaleScene], rollRangeDeg: [Math.min(...rows.map((r) => r.rotSceneDeg)), Math.max(...rows.map((r) => r.rotSceneDeg))] });
		expect(worst <= 6, "a ring is more than 6 px (at 1920 wide) off its marker", { expected: "<= 6 px@1920", actual: rows });
		expect(worstDiameter <= 0.03, "the ring diameter does not follow the zoom within 3%", { expected: "<= 3 %", actual: rows });
		expect(worstRot <= 1.5, "the rings do not follow the rotation (6 px over 450 px = 1.5 deg)", { expected: "<= 1.5 deg", actual: rows });
		return { worstErrPx1920: worst, canvasWidth: canvasSize.width, worstRingDiameterVsZoomPct: round2(worstDiameter * 100), worstRingAreaVsZoomPct: round2(worstArea * 100), worstRingDistanceVsZoomPct: round2(worstPair * 100), worstRotationErrDeg: worstRot, rows: rows.map((r) => `${r.t}s: err ${r.errPx1920.join("/")} px@1920 (${r.errPx.join("/")} canvas px), zoom ${r.scaleScene}, ring pair x${r.scaleRing}, ring diameter x${r.ringOuterRatio}, roll ${r.rotSceneDeg} deg (ring ${r.rotRingDeg})`) };
	}, { timeoutMs: 240_000 });


	// ------------------------------------------------------------ E2.10
	const ringElement = () => elementOf(client, (e) => e.type === "image" && /^ring-pair/.test(e.name ?? ""));
	const keyState = async () => channelKeys(await ringElement());
	const WORST_GLUE_PX = 6;
	const GLUE_TIMES = [0, 3, 4.5];

	await R.step("E2.10a", "ONE Ctrl+Z after the stick removes all five channels, the chip/tab show 'Stick to scene' (not 'Stuck'), the ring stops following", async () => {
		await ed.blurActive(client);
		await ed.propsTab(client, "Tracking");
		await seekToSeconds(client, 3);
		await press(client, "ctrl+z");
		await sleep(700);
		const keys = await keyState();
		const st = await pinState(client);
		const m = await measureScene(ctx, { name: "E2.10a-after-undo-t3", canvasSize });
		const drift = m.ok ? round1(Math.max(dist(m.greens[0], m.rings[0]), dist(m.greens[1], m.rings[1])) * planScale(canvasSize)) : null;
		R.metric("E2.10a", { keys, chip: st.chip, tab: st.tab, ringToMarkerPxAt3sAfterUndo1920: drift });
		expect(totalKeys(keys) === 0, "one Ctrl+Z did not remove all channel keys", { expected: "0 keys", actual: keys });
		expect(st.chip.hasStick && !st.chip.hasUnstick && !st.tab.statuses.some((t) => /^Stuck/.test(t)), "after Ctrl+Z the panel still shows the element as stuck", { actual: { chip: st.chip, tab: st.tab } });
		expect(drift !== null && drift > 30, "after Ctrl+Z the ring still follows the marker (it should stand still at its t = 0 place)", { actual: drift });
		return { keys: "0 on all channels", chipButtons: st.chip.buttons, tabStatuses: st.tab.statuses, ringToMarkerAt3s: `${drift} px@1920 (the unstuck ring stays where it was placed)` };
	});

	await R.step("E2.10b", "Ctrl+Y brings the stick back: five channels again, 'Stuck' state, rings back on the markers at 3 s", async () => {
		await ed.blurActive(client);
		await press(client, "ctrl+y");
		await sleep(700);
		const keys = await keyState();
		const st = await pinState(client);
		const m = await measureScene(ctx, { name: "E2.10b-after-redo-t3", canvasSize });
		const drift = m.ok ? round1(Math.max(dist(m.greens[0], m.rings[0]), dist(m.greens[1], m.rings[1])) * planScale(canvasSize)) : null;
		R.metric("E2.10b", { keys, chip: st.chip, tab: st.tab, ringToMarkerPx1920: drift });
		for (const channel of ["positionX", "positionY", "scaleX", "scaleY", "rotate"]) expect(keys[channel] > 0, `Ctrl+Y did not bring back channel ${channel}`, { actual: keys });
		expect(st.chip.hasUnstick && st.tab.statuses.some((t) => /^Stuck/.test(t)), "after Ctrl+Y the panel does not show 'Stuck'", { actual: { chip: st.chip, tab: st.tab } });
		expect(drift !== null && drift <= WORST_GLUE_PX, "after Ctrl+Y the rings are not on the markers", { expected: `<= ${WORST_GLUE_PX} px@1920`, actual: drift });
		return { keys, ringToMarkerPx1920: drift };
	});

	let dragged = null;
	await R.step("E2.10c", "while stuck: drag the element in the preview at 1.5 s: it follows the pointer (+-3 px), stays stuck, and keeps its new offset glued to the scene at 0, 3, 4.5 s", async () => {
		await seekToSeconds(client, 1.5);
		await ed.selectClip(client, "ring-pair.png");
		await ed.propsTab(client, "Tracking");
		const before = await measureScene(ctx, { name: "E2.10c-before-drag", canvasSize });
		expect(before.ok, "markers/rings not visible before the drag");
		const start = ringMidScreen(before);
		const delta = { x: -48, y: 30 };
		const k = before.rings[0].k;
		const shift = await keyDown(client, "shift");
		await mouse.drag(client, start, { x: start.x + delta.x, y: start.y + delta.y }, { steps: 14, releaseOnEnd: false, stepDelayMs: 25, modifiers: 8 });
		await sleep(250);
		const during = await measureScene(ctx, { name: "E2.10c-during-drag", canvasSize });
		await mouse.up(client, start.x + delta.x, start.y + delta.y, { modifiers: 8 });
		await keyUp(client, shift);
		await sleep(900);
		const afterState = await pinState(client);
		const keys = await keyState();
		const after = await measureScene(ctx, { name: "E2.10c-after-drag", canvasSize });
		const moved = (m) => (m.ok ? { x: ringMid(m).x - ringMid(before).x, y: ringMid(m).y - ringMid(before).y } : null);
		const expected = { x: delta.x * k, y: delta.y * k };
		const dDuring = moved(during);
		const dAfter = moved(after);
		const to1920 = planScale(canvasSize);
		const errDuring = dDuring ? Math.hypot(dDuring.x - expected.x, dDuring.y - expected.y) * to1920 : null;
		const errAfter = dAfter ? Math.hypot(dAfter.x - expected.x, dAfter.y - expected.y) * to1920 : null;
		const glue = await glueCheck(ctx, { tg: 1.5, times: GLUE_TIMES, canvasSize, tag: "E2.10c" });
		dragged = { delta, expectedCanvas: expected };
		R.metric("E2.10c", { pointerDeltaScreen: delta, expectedCanvasPx: { x: round1(expected.x), y: round1(expected.y) }, movedDuringDrag: dDuring && { x: round1(dDuring.x), y: round1(dDuring.y) }, movedAfterRelease: dAfter && { x: round1(dAfter.x), y: round1(dAfter.y) }, errDuringPx1920: round1(errDuring), errAfterPx1920: round1(errAfter), keys, chip: afterState.chip.buttons, glue: glue.rows });
		expect(errDuring !== null && errDuring <= 3 * to1920 + 1, "during the drag the element does not follow the pointer", { expected: "+-3 screen px", actual: { dDuring, expected } });
		expect(errAfter !== null && errAfter <= 3 * to1920 + 1, "after the release the element is not where the pointer left it", { expected: "+-3 screen px", actual: { dAfter, expected } });
		expect(afterState.chip.hasUnstick && totalKeys(keys) > 0, "the element is not stuck after the drag (re-pin did not happen)", { actual: { chip: afterState.chip, keys } });
		expect(glue.worst <= WORST_GLUE_PX, "after the drag the element is not glued to the scene at the other times", { expected: `<= ${WORST_GLUE_PX} px@1920`, actual: glue.rows });
		return { followedPointer: `during ${round1(errDuring)} / after ${round1(errAfter)} px@1920`, keys, glueWorstPx1920: glue.worst };
	}, { timeoutMs: 240_000 });

	// Corner SCALE gesture at 1.5 s: a free corner (not under the pin chip) is dragged 40 screen px towards the box centre; returns what happened
	const scaleGesture = async (tag) => {
		await seekToSeconds(client, 1.5);
		await ed.selectClip(client, "ring-pair.png");
		const before = await measureScene(ctx, { name: `${tag}-before`, canvasSize });
		expect(before.ok, "markers/rings not visible before the scale drag");
		const keysBefore = await keyState();
		const handles = await handleCentres(client);
		expect(handles.length >= 8, "selection handles not found", { actual: handles });
		const centre = ringMidScreen(before);
		const corners = [];
		for (let i = 0; i < 4; i++) {
			const hit = await client.evaluate(`(() => { const el = document.elementFromPoint(${handles[i].x}, ${handles[i].y}); const b = el?.closest("button"); return { insideChip: !!el?.closest('[class*="bg-background/95"]'), cursor: b ? getComputedStyle(b).cursor : null }; })()`);
			corners.push({ ...handles[i], free: !hit.insideChip && /resize/.test(hit.cursor ?? ""), distance: Math.hypot(handles[i].x - centre.x, handles[i].y - centre.y) });
		}
		const free = corners.filter((c) => c.free).sort((a, b) => b.distance - a.distance);
		expect(free.length > 0, "every corner handle is covered by the pin chip", { actual: corners });
		const corner = free[0];
		const towards = { x: (centre.x - corner.x) / corner.distance, y: (centre.y - corner.y) / corner.distance };
		const target = { x: corner.x + 40 * towards.x, y: corner.y + 40 * towards.y };
		await mouse.drag(client, corner, target, { steps: 12, stepDelayMs: 25, releaseOnEnd: false });
		await sleep(300);
		const duringShot = await measureScene(ctx, { name: `${tag}-during`, canvasSize });
		await mouse.up(client, target.x, target.y);
		await sleep(900);
		const st = await pinState(client);
		const keysAfter = await keyState();
		const after = await measureScene(ctx, { name: `${tag}-after`, canvasSize });
		const pairRatio = (m) => (m.ok ? round2(dist(m.rings[0], m.rings[1]) / dist(before.rings[0], before.rings[1])) : null);
		return { before, after, st, keysBefore, keysAfter, ratio: pairRatio(after), ratioDuring: pairRatio(duringShot), cornersFree: corners.filter((c) => c.free).length, expectedIfCentreAnchored: round2((corner.distance - 40) / corner.distance) };
	};
	let stuckScaleRatio = null;

	await R.step("E2.10d", "while stuck: a corner SCALE handle does NOT delete the scale keys, the element stays stuck and glued with its new size", async () => {
		const g = await scaleGesture("E2.10d");
		stuckScaleRatio = g.ratio;
		const glue = g.after.ok ? await glueCheck(ctx, { tg: 1.5, times: GLUE_TIMES, canvasSize, tag: "E2.10d" }) : null;
		R.metric("E2.10d", { keysBefore: g.keysBefore, keysAfter: g.keysAfter, chip: g.st.chip.buttons, ringPairDistRatioDuringDrag: g.ratioDuring, ringPairDistRatioAfterRelease: g.ratio, expectedIfCentreAnchored: g.expectedIfCentreAnchored, freeCorners: g.cornersFree, glue: glue?.rows });
		expect(totalKeys(g.keysAfter) > 0 && g.keysAfter.scaleX > 0 && g.keysAfter.scaleY > 0, "the scale handle deleted the scale keyframes of the stuck element (plan a9: it must re-pin instead)", { expected: "scaleX/scaleY keys kept", actual: { keysBefore: g.keysBefore, keysAfter: g.keysAfter } });
		expect(g.st.chip.hasUnstick, "after the scale drag the element is no longer shown as stuck", { actual: g.st.chip });
		expect(g.ratio !== null && Math.abs(g.ratio - 1) > 0.03, "the scale handle drag did not change the size (test did not grab the handle)", { actual: g.ratio });
		expect(glue && glue.worst <= WORST_GLUE_PX, "after the scale drag the element is not glued to the scene at the other times", { expected: `<= ${WORST_GLUE_PX} px@1920`, actual: glue?.rows });
		return { keysAfter: g.keysAfter, ringPairDistRatio: g.ratio, glueWorstPx1920: glue?.worst };
	}, { timeoutMs: 240_000 });

	// what receives a press on the rotate handle? (the pin chip must not sit on top of it)
	const rotateHandleHit = async () => {
		const handles = await handleCentres(client);
		expect(handles.length >= 8, "selection handles not found", { actual: handles });
		const rotate = handles[7];
		const hit = await client.evaluate(`(() => { const el = document.elementFromPoint(${rotate.x}, ${rotate.y}); const handle = el?.closest("button"); return { tag: el?.tagName ?? null, text: el?.innerText?.trim().slice(0, 40) ?? null, buttonText: handle?.innerText?.trim().slice(0, 30) ?? null, cursor: handle ? getComputedStyle(handle).cursor.slice(0, 16) : null, insideChip: !!el?.closest('[class*="bg-background/95"]') }; })()`);
		return { rotate, hit };
	};
	// bring the element into the upper part of the canvas (Shift: no snapping): then the chip has room below it and leaves the rotate handle free
	const moveElementUp = async (tag) => {
		await seekToSeconds(client, 1.5);
		await ed.selectClip(client, "ring-pair.png");
		const m = await measureScene(ctx, { name: `${tag}-before-move-up`, canvasSize });
		expect(m.ok, "markers/rings not visible before moving the element up");
		const start = ringMidScreen(m);
		await dragWithShift(client, start, { x: start.x, y: m.rect.y + 0.3 * m.rect.h }, { steps: 14, stepDelayMs: 25 });
		await sleep(900);
	};

	// every transform handle button and the chip as rectangles (screen px), for "the chip covers none of the handles"
	const chipAndHandleRects = (client) =>
		client.evaluate(`(() => {
			const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
			const handles = [...(${ed.PREVIEW}).querySelectorAll("button")].filter((b) => !b.innerText.trim() && !b.getAttribute("aria-label") && !b.closest('[class*="bg-background/95"]')).map(rect);
			const chip = (${ed.PREVIEW}).querySelector('[class*="bg-background/95"]');
			return { chip: chip ? rect(chip) : null, handles };
		})()`);
	const overlapsHandle = (chip, handle) => chip.x < handle.x + handle.w && handle.x < chip.x + chip.w && chip.y < handle.y + handle.h && handle.y < chip.y + chip.h;

	await R.step("E2.10e0", "the rotate handle of the selected element can be pressed at the element's natural mid-preview place (the pin chip must not sit on it, nor cover any handle)", async () => {
		await seekToSeconds(client, 1.5);
		await ed.selectClip(client, "ring-pair.png");
		const { rotate, hit } = await rotateHandleHit();
		await ctx.shoot("E2.10e0-chip-vs-rotate-handle");
		// not only the handle's centre point: the chip's rectangle against every handle's whole hit area
		const rects = await chipAndHandleRects(client);
		const covered = rects.chip ? rects.handles.map((h, i) => (overlapsHandle(rects.chip, h) ? i : -1)).filter((i) => i >= 0) : [];
		R.metric("E2.10e0", { rotateHandleAt: { x: round1(rotate.x), y: round1(rotate.y) }, pressLandsOn: hit, chipRect: rects.chip, handleRects: rects.handles, handlesUnderChip: covered });
		expect(!hit.insideChip, "a press on the rotate handle lands on the pin chip: the chip covers the handle, so the element cannot be rotated with it (pin-chip-placement.ts)", { expected: "the rotate handle button", actual: hit });
		expect(rects.handles.length >= 8, "selection handles not found", { actual: rects.handles });
		expect(covered.length === 0, "the pin chip covers part of a transform handle (its rectangle overlaps the handle's hit area)", { expected: "no handle under the chip", actual: { chip: rects.chip, coveredHandleIndexes: covered, handles: rects.handles } });
		return { pressLandsOn: hit, chip: rects.chip, handlesUnderChip: covered };
	});

	// rotate handle +20 degrees at 1.5 s; returns what happened
	const rotateGesture = async (tag) => {
		await seekToSeconds(client, 1.5);
		await ed.selectClip(client, "ring-pair.png");
		const before = await measureScene(ctx, { name: `${tag}-before`, canvasSize });
		expect(before.ok, "markers/rings not visible before the rotate drag");
		await ed.propsTab(client, "Transform");
		const rotateBefore = (await ed.sliderState(client, "Rotate"))?.now ?? null;
		const handles = await handleCentres(client);
		expect(handles.length >= 8, "selection handles not found", { actual: handles });
		const rotate = handles[7];
		const centre = ringMidScreen(before);
		const radius = Math.hypot(rotate.x - centre.x, rotate.y - centre.y);
		const a0 = Math.atan2(rotate.y - centre.y, rotate.x - centre.x);
		const arcDeg = Number(process.env.CAMERA_ROT_ARC ?? 20);
		const a1 = a0 + (arcDeg * Math.PI) / 180;
		// what receives a press on the rotate handle? (the pin chip must not sit on top of it)
		const hit = await client.evaluate(`(() => { const el = document.elementFromPoint(${rotate.x}, ${rotate.y}); const handle = el?.closest("button"); return { tag: el?.tagName ?? null, text: el?.innerText?.trim().slice(0, 40) ?? null, buttonText: handle?.innerText?.trim().slice(0, 30) ?? null, cursor: handle ? getComputedStyle(handle).cursor.slice(0, 16) : null, insideChip: !!el?.closest('[class*="bg-background/95"]') }; })()`);
		await ctx.shoot(`${tag}-handles-window`);
		// plain drag, no Shift: rotation snaps only within 5 degrees of a multiple of 90 and the target (28 or 20 degrees) is clear of that (probe: plain drag 0 -> 20 degrees works on a text clip)
		const target = { x: centre.x + radius * Math.cos(a1), y: centre.y + radius * Math.sin(a1) };
		await mouse.drag(client, rotate, target, { steps: 12, stepDelayMs: 25, releaseOnEnd: false });
		await sleep(300);
		const duringShot = await measureScene(ctx, { name: `${tag}-during`, canvasSize });
		const turnedDuring = duringShot.ok ? round1(angleDiff(angleOf(duringShot.rings[0], duringShot.rings[1]), angleOf(before.rings[0], before.rings[1]))) : null;
		await mouse.up(client, target.x, target.y);
		await sleep(900);
		const rotateAfter = (await ed.sliderState(client, "Rotate"))?.now ?? null;
		await ed.propsTab(client, "Tracking");
		const st = await pinState(client);
		const keys = await keyState();
		const after = await measureScene(ctx, { name: `${tag}-after`, canvasSize });
		const turned = after.ok ? round1(angleDiff(angleOf(after.rings[0], after.rings[1]), angleOf(before.rings[0], before.rings[1]))) : null;
		return { arcDeg, before, after, st, keys, turned, turnedDuring, rotateBefore, rotateAfter, radius: round1(radius), handleCursor: rotate.cursor, hit, rotateHandleAt: { x: round1(rotate.x), y: round1(rotate.y) } };
	};

	await R.step("E2.10e", "while stuck: the ROTATE handle (+20 deg), pressed where the chip does not cover it, keeps the stick and the element stays glued with its new angle", async () => {
		await moveElementUp("E2.10e");
		const g = await rotateGesture("E2.10e");
		const glue = g.after.ok ? await glueCheck(ctx, { tg: 1.5, times: GLUE_TIMES, canvasSize, tag: "E2.10e" }) : null;
		R.metric("E2.10e", { arcDeg: g.arcDeg, keys: g.keys, chip: g.st.chip.buttons, ringPairTurnedDeg: g.turned, ringPairTurnedDuringDragDeg: g.turnedDuring, rotateSliderBefore: g.rotateBefore, rotateSliderAfter: g.rotateAfter, handleCursor: g.handleCursor, radius: g.radius, pressLandsOn: g.hit, rotateHandleAt: g.rotateHandleAt, glue: glue?.rows });
		expect(g.st.chip.hasUnstick && totalKeys(g.keys) > 0, "after the rotate drag the element is no longer stuck", { actual: { chip: g.st.chip, keys: g.keys } });
		expect(g.turned !== null && Math.abs(g.turned - g.arcDeg) <= 3, `the rotate handle drag by +${g.arcDeg} degrees did not leave the stuck element turned by +${g.arcDeg} degrees (+-3)`, { expected: `+${g.arcDeg} deg`, actual: { turnedAfterRelease: g.turned, turnedDuringDrag: g.turnedDuring, rotateSliderBefore: g.rotateBefore, rotateSliderAfter: g.rotateAfter } });
		expect(glue && glue.worst <= WORST_GLUE_PX, "after the rotate drag the element is not glued to the scene at the other times", { expected: `<= ${WORST_GLUE_PX} px@1920`, actual: glue?.rows });
		return { ringPairTurnedDeg: g.turned, rotateSlider: `${g.rotateBefore} -> ${g.rotateAfter}`, keys: g.keys, glueWorstPx1920: glue?.worst };
	}, { timeoutMs: 240_000 });

	let lookBeforeUnstick = null;
	await R.step("E2.10f", "Unstick button: all keys go, the panel returns to 'Stick to scene', the ring stays exactly where it is at the playhead (no jump)", async () => {
		await seekToSeconds(client, 3);
		const before = await measureScene(ctx, { name: "E2.10f-before-unstick-t3", canvasSize });
		expect(before.ok, "markers/rings not visible before Unstick");
		lookBeforeUnstick = { rings: before.rings.map((r) => ({ x: r.x, y: r.y })), greens: before.greens.map((g) => ({ x: g.x, y: g.y })) };
		await clickEl(client, "Unstick", byTextFinder("button", "Unstick", ed.PREVIEW));
		await sleep(900);
		const st = await pinState(client);
		const keys = await keyState();
		const after = await measureScene(ctx, { name: "E2.10f-after-unstick-t3", canvasSize });
		const jump = after.ok ? round1(Math.max(dist(after.rings[0], before.rings[0]), dist(after.rings[1], before.rings[1])) * planScale(canvasSize)) : null;
		R.metric("E2.10f", { keys, chip: st.chip.buttons, tabStatuses: st.tab.statuses, ringJumpAtPlayheadPx1920: jump });
		expect(totalKeys(keys) === 0, "Unstick left keys on the transform channels", { actual: keys });
		expect(st.chip.hasStick && !st.chip.hasUnstick, "after Unstick the chip does not offer 'Stick to scene'", { actual: st.chip });
		expect(jump !== null && jump <= 2, "the element jumped when it was unstuck (it must keep its look at the playhead)", { expected: "<= 2 px@1920", actual: jump });
		return { keys: "0", ringJumpAtPlayheadPx1920: jump };
	});

	await R.step("E2.10f2", "CONTROL: the same rotate-handle drag on the now UNSTUCK element turns it (+20 deg): tells a harness problem from a stuck-element problem", async () => {
		await moveElementUp("E2.10f2");
		const g = await rotateGesture("E2.10f2");
		R.metric("E2.10f2", { arcDeg: g.arcDeg, ringPairTurnedDeg: g.turned, ringPairTurnedDuringDragDeg: g.turnedDuring, rotateSliderBefore: g.rotateBefore, rotateSliderAfter: g.rotateAfter, keys: g.keys, handleCursor: g.handleCursor, pressLandsOn: g.hit, rotateHandleAt: g.rotateHandleAt });
		// give the gestures back to the undo stack (the move and, if it happened, the rotation) so E2.10g's Ctrl+Z undoes the Unstick
		const undoSteps = 1 + (g.turned !== null && Math.abs(g.turned) > 1 ? 1 : 0);
		for (let i = 0; i < undoSteps; i++) {
			await ed.blurActive(client);
			await press(client, "ctrl+z");
			await sleep(500);
		}
		expect(g.turned !== null && Math.abs(g.turned - g.arcDeg) <= 3, `the rotate handle drag by +${g.arcDeg} degrees did not turn the plain element by +${g.arcDeg} degrees (+-3)`, { expected: `+${g.arcDeg} deg`, actual: { turnedAfterRelease: g.turned, turnedDuringDrag: g.turnedDuring, rotateSliderBefore: g.rotateBefore, rotateSliderAfter: g.rotateAfter } });
		return { ringPairTurnedDeg: g.turned, rotateSlider: `${g.rotateBefore} -> ${g.rotateAfter}` };
	}, { timeoutMs: 120_000 });

	await R.step("E2.10f3", "CONTROL: the same corner-scale drag on the UNSTUCK element gives the same size change as on the stuck one (+-0.05)", async () => {
		await moveElementUp("E2.10f3");
		const g = await scaleGesture("E2.10f3");
		R.metric("E2.10f3", { unstuckRatioDuring: g.ratioDuring, unstuckRatioAfter: g.ratio, stuckRatioAfterRelease: stuckScaleRatio, expectedIfCentreAnchored: g.expectedIfCentreAnchored, freeCorners: g.cornersFree });
		// restore the undo stack: the move and the scale gesture
		for (let i = 0; i < 2; i++) {
			await ed.blurActive(client);
			await press(client, "ctrl+z");
			await sleep(500);
		}
		expect(g.ratio !== null && Math.abs(g.ratio - 1) > 0.02, "the control scale drag did not change the plain element (harness problem)", { actual: g.ratio });
		expect(stuckScaleRatio !== null && Math.abs(stuckScaleRatio - g.ratio) <= 0.05, "the same corner drag changes the STUCK element by a different amount than the plain element", { expected: `stuck ${stuckScaleRatio} == plain ${g.ratio} (+-0.05)`, actual: { stuck: stuckScaleRatio, plain: g.ratio } });
		return { plain: g.ratio, stuck: stuckScaleRatio };
	}, { timeoutMs: 240_000 });

	await R.step("E2.10g", "Ctrl+Z after Unstick puts the pin back: five channels, 'Stuck' state, the ring follows the markers again at 0 / 3 / 4.5 s", async () => {
		await ed.blurActive(client);
		await press(client, "ctrl+z");
		await sleep(900);
		const st = await pinState(client);
		const keys = await keyState();
		await ed.propsTab(client, "Tracking");
		const tabState = await pinState(client);
		const glue = await glueCheck(ctx, { tg: 3, times: [0, 4.5], canvasSize, tag: "E2.10g" });
		R.metric("E2.10g", { keys, chip: st.chip.buttons, tabStatuses: tabState.tab.statuses, glue: glue.rows });
		for (const channel of ["positionX", "positionY", "scaleX", "scaleY", "rotate"]) expect(keys[channel] > 0, `Ctrl+Z after Unstick did not bring back channel ${channel}`, { actual: keys });
		expect(st.chip.hasUnstick && tabState.tab.statuses.some((t) => /^Stuck/.test(t)), "after Ctrl+Z the panel does not show the element as stuck (plan: pin must come back)", { actual: { chip: st.chip, tab: tabState.tab } });
		expect(glue.worst <= WORST_GLUE_PX, "after Ctrl+Z the element does not follow the scene again", { expected: `<= ${WORST_GLUE_PX} px@1920`, actual: glue.rows });
		return { keys, glueWorstPx1920: glue.worst };
	}, { timeoutMs: 240_000 });

	await R.step("E2.10h", "after that Ctrl+Z: drag the element again: it follows the pointer and re-sticks (state + glue right)", async () => {
		await seekToSeconds(client, 1.5);
		await ed.selectClip(client, "ring-pair.png");
		const before = await measureScene(ctx, { name: "E2.10h-before-drag", canvasSize });
		expect(before.ok, "markers/rings not visible before the drag");
		const start = ringMidScreen(before);
		const delta = { x: -30, y: -30 };
		const k = before.rings[0].k;
		await dragWithShift(client, start, { x: start.x + delta.x, y: start.y + delta.y }, { steps: 14, stepDelayMs: 25 });
		await sleep(900);
		const st = await pinState(client);
		const keys = await keyState();
		const after = await measureScene(ctx, { name: "E2.10h-after-drag", canvasSize });
		const to1920 = planScale(canvasSize);
		const moved = after.ok ? { x: ringMid(after).x - ringMid(before).x, y: ringMid(after).y - ringMid(before).y } : null;
		const err = moved ? Math.hypot(moved.x - delta.x * k, moved.y - delta.y * k) * to1920 : null;
		const glue = await glueCheck(ctx, { tg: 1.5, times: GLUE_TIMES, canvasSize, tag: "E2.10h" });
		R.metric("E2.10h", { followErrPx1920: round1(err), keys, chip: st.chip.buttons, glue: glue.rows });
		expect(err !== null && err <= 3 * to1920 + 1, "the element did not follow the pointer", { actual: { moved, expected: { x: delta.x * k, y: delta.y * k } } });
		expect(st.chip.hasUnstick && totalKeys(keys) > 0, "after the drag the element is not stuck", { actual: { chip: st.chip, keys } });
		expect(glue.worst <= WORST_GLUE_PX, "the dragged element is not glued to the scene", { expected: `<= ${WORST_GLUE_PX} px@1920`, actual: glue.rows });
		return { followErrPx1920: round1(err), glueWorstPx1920: glue.worst };
	}, { timeoutMs: 240_000 });
}

module.exports = { scenarioCamera, internals: { findBlobs, shootSettled, measureScene, stickAndWait, pinState, TEXTS } };
