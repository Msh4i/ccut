const { describe, expect, test } = require("bun:test");
const { cgroupSummary, metricsDelta, summarizeCounters, summarizeMemory, summarizeProcesses } = require("./perf/aggregate");

// What the harness samples every 500 ms (process ticks/RSS, memory, cache counters) and the CDP
// Performance metrics, turned into the per-scenario numbers.

const MiB = 1024 * 1024;

// One sample: processes as [pid, role, subtype, ticks, rssKiB]
const sample = (atMs, processes, extra = {}) => ({
	atMs,
	processes: processes.map(([pid, role, subtype, ticks, rssKiB]) => ({ pid, startTimeTicks: pid * 10, role, subtype, ticks, rssKiB })),
	...extra,
});

describe("summarizeProcesses", () => {
	// renderer: 50 ticks per 500 ms = 100 % of a core; gpu 25 ticks = 50 %; browser 5 ticks = 10 %
	const samples = [];
	for (let i = 0; i <= 8; i++) {
		samples.push(
			sample(i * 500, [
				[10, "browser", null, 1000 + i * 5, 100_000],
				[20, "renderer", null, 2000 + i * 50, 500_000 + i * 1024],
				[30, "gpu", null, 3000 + i * 25, 300_000],
				[40, "utility", "network.mojom.NetworkService", 10, 20_000],
			]),
		);
	}

	test("CPU % per role (100 = one core), time-weighted over the window, with p95 and max", () => {
		const summary = summarizeProcesses({ samples, clkTck: 100, startMs: 1000, endMs: 4000, bucketMs: 1000 });
		expect(summary.byRole.renderer.cpuPercent.mean).toBeCloseTo(100, 9);
		expect(summary.byRole.renderer.cpuPercent.p95).toBeCloseTo(100, 9);
		expect(summary.byRole.gpu.cpuPercent.mean).toBeCloseTo(50, 9);
		expect(summary.byRole.browser.cpuPercent.max).toBeCloseTo(10, 9);
		expect(summary.byRole["utility:network.mojom.NetworkService"].cpuPercent.mean).toBe(0);
		expect(summary.total.cpuPercent.mean).toBeCloseTo(160, 9);
		expect(summary.byRole.renderer.processes).toBe(1);
	});

	test("RSS per role in MiB: at the start of the window, the maximum and at the end", () => {
		const summary = summarizeProcesses({ samples, clkTck: 100, startMs: 1000, endMs: 4000, bucketMs: 1000 });
		expect(summary.byRole.renderer.rssMiB).toEqual({ start: (500_000 + 2 * 1024) / 1024, max: (500_000 + 8 * 1024) / 1024, end: (500_000 + 8 * 1024) / 1024 });
		expect(summary.total.rssMiB.start).toBeCloseTo((100_000 + 500_000 + 2048 + 300_000 + 20_000) / 1024, 9);
	});

	test("the window excludes intervals whose midpoint is outside it; idle = before the window", () => {
		const busy = [sample(0, [[20, "renderer", null, 0, 1]]), sample(500, [[20, "renderer", null, 0, 1]]), sample(1000, [[20, "renderer", null, 100, 1]]), sample(1500, [[20, "renderer", null, 200, 1]])];
		const summary = summarizeProcesses({ samples: busy, clkTck: 100, startMs: 1000, endMs: 2000, bucketMs: 1000 });
		expect(summary.byRole.renderer.cpuPercent.mean).toBeCloseTo(200, 9);
		expect(summary.byRole.renderer.idleCpuPercent).toBeCloseTo(100, 9); // intervals 0-500 (0 %) and 500-1000 (200 %)
	});

	test("an interval that straddles the window start counts by its midpoint; the mean is weighted by interval length", () => {
		const uneven = [sample(0, [[20, "renderer", null, 0, 1]]), sample(800, [[20, "renderer", null, 0, 1]]), sample(1300, [[20, "renderer", null, 50, 1]]), sample(1400, [[20, "renderer", null, 60, 1]]), sample(2300, [[20, "renderer", null, 60, 1]])];
		const summary = summarizeProcesses({ samples: uneven, clkTck: 100, startMs: 1000, endMs: 2400, bucketMs: 2000 });
		// 800-1300 (midpoint 1050, 100 %), 1300-1400 (100 %), 1400-2300 (0 %): 60 ticks over 1.5 s
		expect(summary.byRole.renderer.cpuPercent.mean).toBeCloseTo(40, 9);
		expect(summary.byRole.renderer.cpuPercent.max).toBeCloseTo(100, 9);
		expect(summary.byRole.renderer.idleCpuPercent).toBe(0);
	});

	test("per bucket means", () => {
		const summary = summarizeProcesses({ samples, clkTck: 100, startMs: 0, endMs: 4000, bucketMs: 2000 });
		expect(summary.byRole.gpu.cpuPercent.buckets.map((b) => [b.fromS, b.toS, Math.round(b.mean)])).toEqual([
			[0, 2, 50],
			[2, 4, 50],
		]);
	});

	test("a pid that vanishes, appears or is reused (other start time) does not produce a bogus delta", () => {
		const churn = [
			sample(0, [[20, "renderer", null, 100, 1], [50, "renderer", null, 900, 1]]),
			{ atMs: 500, processes: [{ pid: 20, startTimeTicks: 777, role: "renderer", subtype: null, ticks: 5, rssKiB: 1 }, { pid: 60, startTimeTicks: 600, role: "renderer", subtype: null, ticks: 5000, rssKiB: 1 }] },
			{ atMs: 1000, processes: [{ pid: 20, startTimeTicks: 777, role: "renderer", subtype: null, ticks: 55, rssKiB: 1 }, { pid: 60, startTimeTicks: 600, role: "renderer", subtype: null, ticks: 5000, rssKiB: 1 }] },
		];
		const summary = summarizeProcesses({ samples: churn, clkTck: 100, startMs: 0, endMs: 1000, bucketMs: 1000 });
		// 0-500: nothing comparable (reused pid 20, new pid 60) -> 0 %; 500-1000: pid 20 +50 ticks = 100 %, pid 60 +0
		expect(summary.byRole.renderer.cpuPercent.max).toBeCloseTo(100, 9);
		expect(summary.byRole.renderer.cpuPercent.mean).toBeCloseTo(50, 9);
		expect(summary.byRole.renderer.processes).toBe(4); // 20 (old), 50, 20 (reused), 60
	});

	test("ticks that go down for the same process (a broken read) are not a delta", () => {
		const broken = [sample(0, [[20, "renderer", null, 100, 1]]), sample(500, [[20, "renderer", null, 40, 1]]), sample(1000, [[20, "renderer", null, 90, 1]])];
		const summary = summarizeProcesses({ samples: broken, clkTck: 100, startMs: 0, endMs: 1000, bucketMs: 1000 });
		expect(summary.byRole.renderer.cpuPercent.max).toBeCloseTo(100, 9);
		expect(summary.byRole.renderer.cpuPercent.mean).toBeCloseTo(50, 9);
	});

	test("per process: the busiest first with role, mean CPU and max RSS", () => {
		const summary = summarizeProcesses({ samples, clkTck: 100, startMs: 1000, endMs: 4000, bucketMs: 1000 });
		expect(summary.perProcess.map((p) => [p.pid, p.role])).toEqual([
			[20, "renderer"],
			[30, "gpu"],
			[10, "browser"],
			[40, "utility:network.mojom.NetworkService"],
		]);
		expect(summary.perProcess[0].cpuPercentMean).toBeCloseTo(100, 9);
		expect(summary.perProcess[0].rssMaxMiB).toBeCloseTo((500_000 + 8 * 1024) / 1024, 9);
	});

	test("no samples or no clock tick: null", () => {
		expect(summarizeProcesses({ samples: [], clkTck: 100, startMs: 0, endMs: 1000, bucketMs: 1000 })).toBeNull();
		expect(summarizeProcesses({ samples, clkTck: 0, startMs: 0, endMs: 1000, bucketMs: 1000 })).toBeNull();
	});
});

describe("summarizeMemory", () => {
	test("MemAvailable, swap free and the cgroup's memory.current in MiB over the window", () => {
		const samples = [
			{ atMs: 0, memAvailableBytes: 8000 * MiB, swapFreeBytes: 100 * MiB, cgroupCurrentBytes: 900 * MiB },
			{ atMs: 1000, memAvailableBytes: 7000 * MiB, swapFreeBytes: 100 * MiB, cgroupCurrentBytes: 1500 * MiB },
			{ atMs: 2000, memAvailableBytes: 6500 * MiB, swapFreeBytes: 90 * MiB, cgroupCurrentBytes: 2100 * MiB },
			{ atMs: 3000, memAvailableBytes: 6800 * MiB, swapFreeBytes: 90 * MiB, cgroupCurrentBytes: null },
			{ atMs: 9000, memAvailableBytes: 1 * MiB, swapFreeBytes: 0, cgroupCurrentBytes: 1 },
		];
		const summary = summarizeMemory({ samples, startMs: 1000, endMs: 3000 });
		expect(summary.memAvailableMiB).toEqual({ first: 7000, last: 6800, min: 6500, max: 7000, mean: (7000 + 6500 + 6800) / 3, p95: 7000, n: 3 });
		expect(summary.swapFreeMiB.min).toBe(90);
		expect(summary.cgroupCurrentMiB).toMatchObject({ first: 1500, last: 2100, max: 2100, n: 2 });
	});
});

describe("cgroupSummary", () => {
	test("limits, the run's peak, and the limit hits and OOM kills that happened during the window", () => {
		expect(
			cgroupSummary({
				cgroupPath: "/user.slice/run-r1.scope",
				maxText: "4294967296\n",
				swapMaxText: "0\n",
				peakText: "3221225472\n",
				eventsBefore: "low 0\nhigh 0\nmax 2\noom 0\noom_kill 0\n",
				eventsAfter: "low 0\nhigh 0\nmax 7\noom 1\noom_kill 1\n",
			}),
		).toEqual({ path: "/user.slice/run-r1.scope", maxBytes: 4294967296, swapMaxBytes: 0, peakBytes: 3221225472, maxEvents: 5, oomKills: 1, capped: true });
	});

	test("no cap ('max'), no memory.peak (older kernels), no memory.events, or no cgroup v2 at all", () => {
		expect(cgroupSummary({ cgroupPath: "/user.slice", maxText: "max\n", swapMaxText: "max\n", peakText: undefined, eventsBefore: "", eventsAfter: "" })).toEqual({ path: "/user.slice", maxBytes: null, swapMaxBytes: null, peakBytes: null, maxEvents: null, oomKills: null, capped: false });
		expect(cgroupSummary({ cgroupPath: null })).toBeNull();
	});
});

describe("summarizeCounters (the video cache's running totals, sampled)", () => {
	const totals = (requests, hits, readAheadHits, restarts, waitMs, extra = {}) => ({ requests, hits, readAheadHits, advances: 0, restarts, stalePresents: 0, draws: requests, skipped: 0, keyframeLookups: 0, errors: 0, waitMs, maxWaitMs: 40, ...extra });

	test("deltas over the window and per bucket; hit rate = (hits + read-ahead hits) / requests", () => {
		const samples = [
			{ atMs: 0, counters: totals(10, 9, 0, 0, 5) },
			{ atMs: 900, counters: totals(100, 90, 0, 1, 50) },
			{ atMs: 1500, counters: totals(130, 110, 10, 1, 60) },
			{ atMs: 2000, counters: totals(160, 130, 20, 2, 100) },
			{ atMs: 2500, counters: totals(190, 150, 30, 2, 110) },
			{ atMs: 3100, counters: totals(220, 170, 40, 3, 150) },
		];
		const summary = summarizeCounters({ samples, startMs: 1000, endMs: 3000, bucketMs: 1000 });
		expect(summary.requests).toBe(120);
		expect(summary.hitRate).toBeCloseTo((80 + 40) / 120, 9);
		expect(summary.restarts).toBe(2);
		expect(summary.restartsPerSecond).toBeCloseTo(1, 9);
		expect(summary.waitMs).toBe(100);
		expect(summary.buckets.map((b) => [b.fromS, b.requests, b.restarts])).toEqual([
			[0, 60, 1],
			[1, 60, 1],
		]);
		expect(summary.reset).toBe(false);
	});

	test("the sample taken right after Pause (a little after the window end) closes the window", () => {
		const samples = [
			{ atMs: 1000, counters: totals(0, 0, 0, 0, 0) },
			{ atMs: 2010, counters: totals(30, 30, 0, 0, 0) },
		];
		expect(summarizeCounters({ samples, startMs: 1000, endMs: 2000, bucketMs: 1000 }).requests).toBe(30);
	});

	test("no counters reachable: null; totals that went down (a reload): reset, no numbers", () => {
		expect(summarizeCounters({ samples: [{ atMs: 0, counters: null }, { atMs: 2000, counters: null }], startMs: 0, endMs: 2000, bucketMs: 1000 })).toBeNull();
		const reset = summarizeCounters({
			samples: [
				{ atMs: 0, counters: totals(500, 400, 0, 5, 10) },
				{ atMs: 1000, counters: totals(20, 10, 0, 1, 1) },
				{ atMs: 2000, counters: totals(50, 30, 0, 1, 2) },
			],
			startMs: 0,
			endMs: 2000,
			bucketMs: 1000,
		});
		expect(reset.reset).toBe(true);
		expect(reset.requests).toBeNull();
		expect(reset.hitRate).toBeNull();
	});

	test("no request in the window: hit rate null, not NaN", () => {
		const samples = [
			{ atMs: 0, counters: totals(10, 10, 0, 0, 0) },
			{ atMs: 1000, counters: totals(10, 10, 0, 0, 0) },
		];
		expect(summarizeCounters({ samples, startMs: 0, endMs: 1000, bucketMs: 1000 }).hitRate).toBeNull();
	});
});

describe("metricsDelta (CDP Performance.getMetrics before/after)", () => {
	const metrics = (values) => Object.entries(values).map(([name, value]) => ({ name, value }));

	test("seconds of main-thread work over wall time, and the JS heap", () => {
		const before = metrics({ Timestamp: 100, TaskDuration: 10, ScriptDuration: 4, LayoutDuration: 1, RecalcStyleDuration: 0.5, JSHeapUsedSize: 100 * MiB });
		const after = metrics({ Timestamp: 130, TaskDuration: 34, ScriptDuration: 12, LayoutDuration: 1.5, RecalcStyleDuration: 1, JSHeapUsedSize: 140 * MiB });
		const delta = metricsDelta({ before, after });
		expect(delta.wallS).toBe(30);
		expect(delta.taskS).toBe(24);
		expect(delta.scriptS).toBe(8);
		expect(delta.layoutS).toBe(0.5);
		expect(delta.recalcStyleS).toBe(0.5);
		expect(delta.mainThreadBusyPercent).toBeCloseTo(80, 9);
		expect(delta.jsHeapUsedMiB).toEqual({ before: 100, after: 140 });
	});

	test("missing metrics are null; no wall time means no busy %", () => {
		const delta = metricsDelta({ before: metrics({ Timestamp: 5 }), after: metrics({ Timestamp: 5 }) });
		expect(delta).toEqual({ wallS: 0, taskS: null, scriptS: null, layoutS: null, recalcStyleS: null, mainThreadBusyPercent: null, jsHeapUsedMiB: { before: null, after: null } });
		expect(metricsDelta({ before: null, after: [] })).toBeNull();
	});
});
