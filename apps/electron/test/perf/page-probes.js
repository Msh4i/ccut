// Code the playback harness runs INSIDE the page, sent through CDP Runtime.evaluate as source text
// (pageCall). Each page function may use only its argument and the page's globals: no closure.
// The harness removes everything it installed when it collects (collectProbes).

/**
 * Starts recording, every list capped at maxEntries: requestAnimationFrame times, Space key downs
 * (capture phase, so Play/Pause are timed on the page clock), long tasks, and every
 * GPUCanvasContext.getCurrentTexture() call with the canvas it was for (one call per frame the
 * WebGPU compositor draws into a canvas: the frames the user sees). Replaces an earlier install.
 */
function installProbes({ maxEntries }) {
	const previous = window.__ccutPerf;
	if (previous && typeof previous.stop === "function") previous.stop();
	const state = { raf: [], keys: [], longTasks: [], present: [], canvases: [], running: true, stop: null };
	const push = ({ list, value }) => {
		if (list.length < maxEntries) list.push(value);
	};
	const loop = (time) => {
		if (!state.running) return;
		push({ list: state.raf, value: time });
		requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);
	let observer = null;
	try {
		observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) push({ list: state.longTasks, value: [entry.startTime, entry.duration] });
		});
		observer.observe({ type: "longtask", buffered: false });
	} catch {
		observer = null;
	}
	const onKey = (event) => {
		if (event.code === "Space") push({ list: state.keys, value: [performance.now(), event.type] });
	};
	window.addEventListener("keydown", onKey, true);
	const proto = typeof GPUCanvasContext === "function" ? GPUCanvasContext.prototype : null;
	const original = proto && typeof proto.getCurrentTexture === "function" ? proto.getCurrentTexture : null;
	if (original) {
		proto.getCurrentTexture = function getCurrentTexture(...args) {
			let index = state.canvases.indexOf(this.canvas);
			if (index === -1 && state.canvases.length < 16) {
				state.canvases.push(this.canvas);
				index = state.canvases.length - 1;
			}
			push({ list: state.present, value: [performance.now(), index] });
			return original.apply(this, args);
		};
	}
	state.stop = () => {
		state.running = false;
		if (observer) observer.disconnect();
		window.removeEventListener("keydown", onKey, true);
		if (original) proto.getCurrentTexture = original;
		state.stop = () => {};
	};
	window.__ccutPerf = state;
	return { now: performance.now(), present: original !== null, longTask: observer !== null };
}

/** Stops the recording (everything installed is removed) and returns it; previewCanvas = the recorded canvas inside the preview panel, -1 if none. */
function collectProbes({ panelSelector, panelIndex }) {
	const state = window.__ccutPerf;
	if (!state) return null;
	state.stop();
	const panel = document.querySelectorAll(panelSelector)[panelIndex] || null;
	const isNode = (value) => typeof Node === "function" && value instanceof Node;
	const previewCanvas = panel ? state.canvases.findIndex((canvas) => isNode(canvas) && panel.contains(canvas)) : -1;
	const presentCounts = state.canvases.map((_, index) => state.present.filter((entry) => entry[1] === index).length);
	return { now: performance.now(), raf: state.raf, keys: state.keys, longTasks: state.longTasks, present: state.present, previewCanvas, presentCounts };
}

/**
 * Called with `this` = the array CDP Runtime.queryObjects returned for Object.prototype: keeps the
 * objects that have the fields of the video cache's FrameCacheCounters as plain number properties
 * (property descriptors only: no getter of the page is ever called). Later versions may add counters
 * (e.g. `lruHits`): extra own properties are allowed when they are plain numbers too.
 * The known fields are tested FIRST, by descriptor, which is O(1) per object: `Object.keys` on the
 * page's typed arrays (wasm memory views, media caches of many MB) would build one string per element
 * and can freeze the renderer, so it only runs on objects that already passed.
 */
function selectFrameCacheCounters() {
	const fields = ["requests", "hits", "readAheadHits", "advances", "restarts", "stalePresents", "draws", "skipped", "keyframeLookups", "errors", "waitMs", "maxWaitMs"];
	const maxKeys = 32;
	const isPlainNumber = (object, key) => {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "number";
	};
	const found = [];
	for (const object of this) {
		if (found.length >= 64) break;
		if (object === null || typeof object !== "object" || ArrayBuffer.isView(object)) continue;
		if (!fields.every((field) => isPlainNumber(object, field))) continue;
		const keys = Object.keys(object);
		if (keys.length <= maxKeys && keys.every((key) => isPlainNumber(object, key))) found.push(object);
	}
	window.__ccutPerfCounters = found;
	return found.length;
}

/** The live totals: of the objects found, the one with the most requests (copies made by getCounters() are older). */
function readFrameCacheCounters() {
	const list = window.__ccutPerfCounters;
	if (!Array.isArray(list) || list.length === 0) return null;
	let best = list[0];
	for (const candidate of list) if (candidate.requests > best.requests) best = candidate;
	return { atMs: performance.now(), counters: Object.assign({}, best) };
}

// ---------------------------------------------------------------- harness side (Node)

/** The page expression that calls `fn` (a page function above) with `arg`. */
const pageCall = ({ fn, arg }) => `(${fn.toString()})(${JSON.stringify(arg)})`;

/** The frame times of the preview canvas, else of the canvas that got the most frames. */
function previewFrames({ present, previewCanvas, presentCounts }) {
	let chosen = previewCanvas;
	let how = "preview canvas";
	if (chosen < 0) {
		chosen = presentCounts.reduce((best, count, index) => (count > (presentCounts[best] ?? -1) ? index : best), -1);
		how = chosen < 0 ? "none" : "busiest canvas";
	}
	return { timestamps: present.filter((entry) => entry[1] === chosen).map((entry) => entry[0]), chosen, how };
}

/** The first two Space key downs recorded in the page are Play and Pause. */
function playWindowFromKeys({ keys }) {
	const downs = keys.filter((entry) => entry[1] === "keydown");
	return downs.length >= 2 ? { playMs: downs[0][0], pauseMs: downs[1][0] } : null;
}

module.exports = { collectProbes, installProbes, pageCall, playWindowFromKeys, previewFrames, readFrameCacheCounters, selectFrameCacheCounters };
