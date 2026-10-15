const { describe, expect, test } = require("bun:test");
const vm = require("node:vm");
const { collectProbes, installProbes, pageCall, playWindowFromKeys, previewFrames, readFrameCacheCounters, selectFrameCacheCounters } = require("./perf/page-probes");

// The functions the harness runs IN the page (through CDP Runtime.evaluate, from their source
// text). Here they run from their source text too, in a vm context with a small fake page, so a
// reference to anything outside the function would fail here as it would in the page.

function fakePage() {
	const time = { now: 1000 };
	const rafQueue = [];
	const listeners = new Map();
	const observers = [];
	class Node {
		constructor(children = []) {
			this.children = children;
		}
		contains(other) {
			return other === this || this.children.some((child) => child === other || (child.contains && child.contains(other)));
		}
	}
	class PerformanceObserver {
		constructor(callback) {
			this.callback = callback;
			this.connected = false;
			observers.push(this);
		}
		observe(options) {
			this.options = options;
			this.connected = true;
		}
		disconnect() {
			this.connected = false;
		}
	}
	const textures = [];
	class GPUCanvasContext {
		constructor(canvas) {
			this.canvas = canvas;
		}
		getCurrentTexture() {
			textures.push(this.canvas);
			return { texture: textures.length };
		}
	}
	const originalGetCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
	const previewCanvas = new Node();
	const otherCanvas = new Node();
	const panels = [new Node(), new Node([new Node([previewCanvas])]), new Node()];
	const window = {
		addEventListener: (type, fn, capture) => listeners.set(`${type}:${capture}`, fn),
		removeEventListener: (type, fn, capture) => {
			if (listeners.get(`${type}:${capture}`) === fn) listeners.delete(`${type}:${capture}`);
		},
	};
	const context = vm.createContext({
		window,
		performance: { now: () => time.now },
		requestAnimationFrame: (fn) => rafQueue.push(fn),
		PerformanceObserver,
		GPUCanvasContext,
		Node,
		document: { querySelectorAll: (selector) => (selector === "PANELS" ? panels : []) },
	});
	const frame = () => {
		const callbacks = rafQueue.splice(0);
		for (const callback of callbacks) callback(time.now);
	};
	const key = ({ type = "keydown", code }) => listeners.get(`${type}:true`)?.({ type, code });
	return { context, window, time, frame, key, observers, textures, GPUCanvasContext, originalGetCurrentTexture, previewCanvas, otherCanvas, listeners };
}

const inPage = ({ page, fn, arg }) => vm.runInContext(pageCall({ fn, arg }), page.context);

describe("installProbes / collectProbes", () => {
	test("records every animation frame, Space key downs, long tasks and the canvas frames; collect stops everything", () => {
		const page = fakePage();
		const installed = inPage({ page, fn: installProbes, arg: { maxEntries: 1000 } });
		expect(installed).toEqual({ now: 1000, present: true, longTask: true });
		const preview = new page.GPUCanvasContext(page.previewCanvas);
		const other = new page.GPUCanvasContext(page.otherCanvas);
		for (let i = 0; i < 5; i++) {
			page.time.now += 16;
			page.frame();
			preview.getCurrentTexture();
			if (i === 2) other.getCurrentTexture();
		}
		page.key({ code: "Space" });
		page.key({ code: "KeyA" });
		page.key({ code: "Space", type: "keyup" });
		page.observers[0].callback({ getEntries: () => [{ startTime: 1020, duration: 75 }] });
		expect(page.textures).toHaveLength(6); // the original still runs

		page.time.now = 2000;
		const collected = inPage({ page, fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } });
		expect(collected.raf).toEqual([1016, 1032, 1048, 1064, 1080]);
		expect(collected.keys).toEqual([[1080, "keydown"]]);
		expect(collected.longTasks).toEqual([[1020, 75]]);
		expect(collected.present.map(([, canvas]) => canvas)).toEqual([0, 0, 0, 1, 0, 0]);
		expect(collected.previewCanvas).toBe(0);
		expect(collected.presentCounts).toEqual([5, 1]);
		expect(collected.now).toBe(2000);

		// stopped: no more frames, the hook is gone, the listener removed, the observer disconnected
		page.time.now += 16;
		page.frame();
		expect(page.GPUCanvasContext.prototype.getCurrentTexture).toBe(page.originalGetCurrentTexture);
		expect(page.listeners.size).toBe(0);
		expect(page.observers[0].connected).toBe(false);
		expect(inPage({ page, fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } }).raf).toHaveLength(5);
	});

	test("the preview canvas is found by the panel that holds it, not by which canvas drew first", () => {
		const page = fakePage();
		inPage({ page, fn: installProbes, arg: { maxEntries: 1000 } });
		new page.GPUCanvasContext(page.otherCanvas).getCurrentTexture();
		new page.GPUCanvasContext(page.previewCanvas).getCurrentTexture();
		const collected = inPage({ page, fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } });
		expect(collected.previewCanvas).toBe(1);
		expect(inPage({ page: fakePage(), fn: installProbes, arg: { maxEntries: 10 } }).present).toBe(true);
	});

	test("a second install first removes the first one's hook (no double wrapping)", () => {
		const page = fakePage();
		inPage({ page, fn: installProbes, arg: { maxEntries: 1000 } });
		inPage({ page, fn: installProbes, arg: { maxEntries: 1000 } });
		new page.GPUCanvasContext(page.previewCanvas).getCurrentTexture();
		const collected = inPage({ page, fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } });
		expect(collected.present).toHaveLength(1);
		expect(page.GPUCanvasContext.prototype.getCurrentTexture).toBe(page.originalGetCurrentTexture);
	});

	test("lists are capped (a stuck run cannot fill the page's memory)", () => {
		const page = fakePage();
		inPage({ page, fn: installProbes, arg: { maxEntries: 3 } });
		for (let i = 0; i < 10; i++) {
			page.time.now += 1;
			page.frame();
		}
		expect(inPage({ page, fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } }).raf).toEqual([1001, 1002, 1003]);
	});

	test("no WebGPU and no long-task support: still installs, says so", () => {
		const page = fakePage();
		page.context.GPUCanvasContext = undefined;
		page.context.PerformanceObserver = class {
			observe() {
				throw new Error("unsupported entry type");
			}
		};
		expect(inPage({ page, fn: installProbes, arg: { maxEntries: 10 } })).toEqual({ now: 1000, present: false, longTask: false });
		expect(inPage({ page, fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } }).present).toEqual([]);
	});

	test("collect without install: null", () => {
		expect(inPage({ page: fakePage(), fn: collectProbes, arg: { panelSelector: "PANELS", panelIndex: 1 } })).toBeNull();
	});
});

describe("frame cache counters (found with CDP Runtime.queryObjects)", () => {
	const counters = (requests) => ({ requests, hits: 1, readAheadHits: 2, advances: 3, restarts: 4, stalePresents: 5, draws: 6, skipped: 7, keyframeLookups: 8, errors: 9, waitMs: 10.5, maxWaitMs: 11 });

	test("keeps only objects with the FrameCacheCounters fields as numbers (extra numeric counters allowed); getters are never called", () => {
		const page = fakePage();
		let getterCalls = 0;
		const withGetter = counters(1);
		Object.defineProperty(withGetter, "requests", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return 1;
			},
		});
		const candidates = [
			counters(5),
			{ ...counters(1), lruHits: 3 },
			{ ...counters(1), extra: "text" },
			{ requests: 1 },
			withGetter,
			{ ...counters(1), hits: "1" },
			null,
			counters(900),
		];
		const found = vm.runInContext(`(${selectFrameCacheCounters.toString()})`, page.context).call(candidates);
		expect(found).toBe(3);
		expect(getterCalls).toBe(0);
		expect(page.window.__ccutPerfCounters).toHaveLength(3);
	});

	// Review blocker B1: Object.keys on the page's typed arrays builds one string per element (16 MiB
	// took 6 s and 735 MB in node 22). Only an object that already has the counter fields gets keyed.
	test("never enumerates typed arrays or big arrays: Object.keys runs only on objects with the counter fields", () => {
		const page = fakePage();
		const calls = vm.runInContext(
			"(() => { const original = Object.keys; const calls = { n: 0 }; Object.keys = (value) => { calls.n += 1; return original(value); }; return calls; })()",
			page.context,
		);
		const candidates = [new Uint8Array(4 * 1024 * 1024), new Float32Array(1_000_000), new Array(100_000).fill(0), counters(7)];
		const started = performance.now();
		const found = vm.runInContext(`(${selectFrameCacheCounters.toString()})`, page.context).call(candidates);
		expect(found).toBe(1);
		expect(calls.n).toBe(1);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("reading picks the live totals (the most requests; the others are old copies) and returns a copy", () => {
		const page = fakePage();
		const live = counters(900);
		page.window.__ccutPerfCounters = [counters(5), live, counters(40)];
		const read = inPage({ page, fn: readFrameCacheCounters, arg: {} });
		expect(read).toEqual({ atMs: 1000, counters: counters(900) });
		expect(read.counters).not.toBe(live);
		page.window.__ccutPerfCounters = [];
		expect(inPage({ page, fn: readFrameCacheCounters, arg: {} })).toBeNull();
	});
});

describe("node-side helpers", () => {
	test("previewFrames: the preview canvas's timestamps, else the canvas with the most frames", () => {
		const present = [
			[10, 0],
			[20, 1],
			[30, 1],
			[40, 0],
			[50, 1],
		];
		expect(previewFrames({ present, previewCanvas: 0, presentCounts: [2, 3] })).toEqual({ timestamps: [10, 40], chosen: 0, how: "preview canvas" });
		expect(previewFrames({ present, previewCanvas: -1, presentCounts: [2, 3] })).toEqual({ timestamps: [20, 30, 50], chosen: 1, how: "busiest canvas" });
		expect(previewFrames({ present: [], previewCanvas: -1, presentCounts: [] })).toEqual({ timestamps: [], chosen: -1, how: "none" });
	});

	test("playWindowFromKeys: the first two Space key downs are Play and Pause", () => {
		expect(playWindowFromKeys({ keys: [[100, "keydown"], [30_100, "keydown"], [40_000, "keydown"]] })).toEqual({ playMs: 100, pauseMs: 30_100 });
		expect(playWindowFromKeys({ keys: [[100, "keydown"], [150, "keyup"], [30_100, "keydown"]] })).toEqual({ playMs: 100, pauseMs: 30_100 });
		expect(playWindowFromKeys({ keys: [[100, "keydown"]] })).toBeNull();
		expect(playWindowFromKeys({ keys: [] })).toBeNull();
	});

	test("pageCall: the function's own source called with its JSON argument (quotes survive)", () => {
		const expression = pageCall({ fn: function f({ a }) { return `${a}!`; }, arg: { a: 'x"y</script>' } });
		expect(expression.endsWith(`)(${JSON.stringify({ a: 'x"y</script>' })})`)).toBe(true);
		expect(vm.runInNewContext(expression)).toBe('x"y</script>!');
	});
});
