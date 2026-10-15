const { describe, expect, test } = require("bun:test");
const { RESULT_SCHEMA, RUN_SCHEMA, TARGETS, buildRun, buildScenarioResult, compareRuns, evaluateTargets, formatCompareTable, formatRunTable, pickFrameSource } = require("./perf/report");
const { summarizeTimestamps } = require("./perf/stats");

// Per-scenario result JSON, the acceptance targets, the stdout table and the before/after diff.

const steady = ({ fps, seconds, from = 10_000, stallAt = null, stallMs = 0 }) => {
	const out = [];
	let t = from;
	for (let i = 0; i < Math.round(fps * seconds); i++) {
		out.push(t);
		t += 1000 / fps + (stallAt !== null && i === stallAt ? stallMs : 0);
	}
	return out;
};
const summary = (timestamps, seconds = 30) => summarizeTimestamps({ timestamps, startMs: 10_000, endMs: 10_000 + seconds * 1000, bucketMs: 5000 });
const frames = (timestamps, seconds) => ({ source: "present", summary: summary(timestamps, seconds) });
const capped = { path: "/run.scope", maxBytes: 4 * 1024 ** 3, swapMaxBytes: 0, peakBytes: 3 * 1024 ** 3, maxEvents: 0, oomKills: 0, capped: true };

describe("evaluateTargets", () => {
	test("synthetic, smooth 30 fps for 30 s under the cap: every check met", () => {
		const result = evaluateTargets({ kind: "synthetic", frames: frames(steady({ fps: 30, seconds: 30 })), cgroup: capped, cgroupSampledMaxBytes: null });
		expect(result.checks.map((c) => [c.id, c.met])).toEqual([
			["fps", true],
			["p95", true],
			["cliff", true],
			["memory", true],
		]);
		expect(result.allMet).toBe(true);
		expect(TARGETS.synthetic).toEqual({ minBucketFps: 29, maxIntervalP95Ms: 40, cliffRatio: 0.9 });
	});

	test("synthetic, 24 fps after 5 s: fps, p95 and cliff missed", () => {
		const timestamps = [...steady({ fps: 30, seconds: 5 }), ...steady({ fps: 24, seconds: 25, from: 15_000 })];
		const result = evaluateTargets({ kind: "synthetic", frames: frames(timestamps), cgroup: capped, cgroupSampledMaxBytes: null });
		const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
		expect(byId.fps.met).toBe(false);
		expect(byId.fps.actual).toBeCloseTo(24, 6);
		expect(byId.p95.met).toBe(false);
		expect(byId.p95.actual).toBeCloseTo(41.67, 1);
		expect(byId.cliff.met).toBe(false);
		expect(result.allMet).toBe(false);
	});

	test("the boundaries: 29 fps in every bucket is sustained, 28.9 is not; 45 fps meets the project target, 44.9 does not", () => {
		const buckets = (fps) => ({ source: "present", summary: { fps, intervalP95Ms: 30, buckets: [0, 5, 10].map((fromS) => ({ fromS, toS: fromS + 5, complete: true, fps, intervalP95Ms: 30 })) } });
		const fpsCheck = (kind, fps) => evaluateTargets({ kind, frames: buckets(fps), cgroup: null, cgroupSampledMaxBytes: null }).checks.find((c) => c.id === "fps").met;
		expect(fpsCheck("synthetic", 29)).toBe(true);
		expect(fpsCheck("synthetic", 28.9)).toBe(false);
		expect(fpsCheck("project", 45)).toBe(true);
		expect(fpsCheck("project", 44.9)).toBe(false);
		expect(fpsCheck("project", 40)).toBe(false);
	});

	test("the project target: mean fps >= 45", () => {
		const fast = evaluateTargets({ kind: "project", frames: frames(steady({ fps: 50, seconds: 30 })), cgroup: capped, cgroupSampledMaxBytes: null });
		expect(fast.checks.map((c) => c.id)).toEqual(["fps", "cliff", "memory"]);
		expect(fast.checks[0]).toMatchObject({ target: 45, met: true });
		const slow = evaluateTargets({ kind: "project", frames: frames(steady({ fps: 26, seconds: 30 })), cgroup: capped, cgroupSampledMaxBytes: null });
		expect(slow.checks[0].met).toBe(false);
	});

	test("memory: met when the cgroup never hit MemoryMax and nothing was OOM-killed in the window; the actual is the highest sample", () => {
		const run = (cgroup, sampled = 2 * 1024 ** 3) => evaluateTargets({ kind: "synthetic", frames: frames(steady({ fps: 30, seconds: 30 })), cgroup, cgroupSampledMaxBytes: sampled }).checks.find((c) => c.id === "memory");
		expect(run(capped)).toMatchObject({ met: true, target: capped.maxBytes, actual: 2 * 1024 ** 3 });
		expect(run({ ...capped, oomKills: 1 }).met).toBe(false);
		expect(run({ ...capped, maxEvents: 3 })).toMatchObject({ met: false });
		expect(run({ ...capped, maxEvents: 3 }).note).toContain("MemoryMax");
		expect(run({ ...capped, capped: false, maxBytes: null }).met).toBeNull();
		expect(run(null).met).toBeNull();
		expect(run({ ...capped, maxEvents: null, oomKills: null }).met).toBeNull();
		expect(run(capped, null)).toMatchObject({ met: true, actual: capped.peakBytes });
	});

	test("nothing measurable: checks are null and so is allMet; one miss among nulls is a miss", () => {
		const none = evaluateTargets({ kind: "synthetic", frames: { source: null, summary: null }, cgroup: null, cgroupSampledMaxBytes: null });
		expect(none.checks.every((c) => c.met === null)).toBe(true);
		expect(none.allMet).toBeNull();
		const oom = evaluateTargets({ kind: "synthetic", frames: { source: null, summary: null }, cgroup: { ...capped, oomKills: 2 }, cgroupSampledMaxBytes: null });
		expect(oom.allMet).toBe(false);
	});

	test("HUD rows have no overall p95: the worst bucket p95 stands in and says so", () => {
		const hudSummary = { fps: 30, intervalP95Ms: null, buckets: [{ fromS: 0, toS: 5, complete: true, fps: 30, intervalP95Ms: 34 }, { fromS: 5, toS: 10, complete: true, fps: 30, intervalP95Ms: 38 }] };
		const p95 = evaluateTargets({ kind: "synthetic", frames: { source: "hud", summary: hudSummary }, cgroup: null, cgroupSampledMaxBytes: null }).checks.find((c) => c.id === "p95");
		expect(p95).toMatchObject({ actual: 38, met: true });
		expect(p95.note).toContain("worst 5 s bucket");
	});
});

describe("pickFrameSource", () => {
	const good = summary(steady({ fps: 30, seconds: 30 }));
	const hud = { elapsedS: 10, rows5s: [{ fromS: 0, toS: 5, fps: 30, intervalP50Ms: 33, intervalP95Ms: 34, intervalMaxMs: 40 }, { fromS: 5, toS: 10, fps: 28, intervalP50Ms: 33, intervalP95Ms: 50, intervalMaxMs: 90 }, { fromS: 10, toS: 15, fps: 2, intervalP50Ms: 33, intervalP95Ms: 33, intervalMaxMs: 33 }] };

	test("the presented frames of the preview canvas first, then the HUD's rows, then rAF", () => {
		expect(pickFrameSource({ present: good, hud, raf: good }).source).toBe("present");
		expect(pickFrameSource({ present: summary([]), hud, raf: good }).source).toBe("hud");
		expect(pickFrameSource({ present: null, hud: null, raf: good }).source).toBe("raf");
		expect(pickFrameSource({ present: null, hud: { elapsedS: 0, rows5s: [] }, raf: summary([]) })).toEqual({ source: null, summary: null });
	});

	test("HUD rows as a summary: completeness from the elapsed time, mean fps over it, worst interval", () => {
		const { summary: s } = pickFrameSource({ present: null, hud, raf: null });
		expect(s.buckets.map((b) => [b.fromS, b.toS, b.complete])).toEqual([
			[0, 5, true],
			[5, 10, true],
			[10, 10, false],
		]);
		expect(s.fps).toBeCloseTo(29, 9);
		expect(s.intervalMaxMs).toBe(90);
		expect(s.intervalP95Ms).toBeNull();
	});
});

function rawScenario(overrides = {}) {
	const playMs = 10_000;
	const pauseMs = 40_000;
	const present = steady({ fps: 30, seconds: 30 });
	return {
		scenario: "S1",
		kind: "synthetic",
		title: "two clips",
		shape: { canvas: { width: 1920, height: 1080 }, fps: 30, background: null, durationS: 40, videos: [] },
		check: { problems: [], window: { fromS: 0, toS: 30 } },
		page: {
			idleFromMs: 8000,
			playMs,
			pauseMs,
			raf: [...steady({ fps: 60, seconds: 2, from: 8000 }), ...steady({ fps: 30, seconds: 30 })],
			present,
			presentCanvas: { chosen: 0, counts: [900] },
			longTasks: [{ startMs: 12_000, durationMs: 70 }],
		},
		hudText: null,
		counterSamples: [
			{ atMs: 9990, counters: { requests: 0, hits: 0, readAheadHits: 0, advances: 0, restarts: 0, stalePresents: 0, draws: 0, skipped: 0, errors: 0, waitMs: 0, keyframeLookups: 0, maxWaitMs: 0 } },
			{ atMs: 40_010, counters: { requests: 1800, hits: 1500, readAheadHits: 280, advances: 20, restarts: 2, stalePresents: 0, draws: 1800, skipped: 0, errors: 0, waitMs: 300, keyframeLookups: 1, maxWaitMs: 40 } },
		],
		node: {
			playAtMs: 1000,
			pauseAtMs: 31_000,
			// the harness's own clock (1 s .. 31 s), not the page's (10 s .. 40 s): busy in the first half only
			processSamples: [
				{ atMs: 1000, processes: [{ pid: 2, startTimeTicks: 1, role: "renderer", subtype: null, ticks: 0, rssKiB: 1024 }] },
				{ atMs: 16_000, processes: [{ pid: 2, startTimeTicks: 1, role: "renderer", subtype: null, ticks: 3000, rssKiB: 2048 }] },
				{ atMs: 31_000, processes: [{ pid: 2, startTimeTicks: 1, role: "renderer", subtype: null, ticks: 3000, rssKiB: 2048 }] },
			],
			memorySamples: [{ atMs: 1000, memAvailableBytes: 8 * 1024 ** 3, swapFreeBytes: 0, cgroupCurrentBytes: 2 * 1024 ** 3 }],
			threadSnapshots: [{ pid: 2, role: "renderer", elapsedMs: 30_000, before: [{ tid: 2, comm: "CrRendererMain", ticks: 0 }], after: [{ tid: 2, comm: "CrRendererMain", ticks: 1500 }] }],
		},
		cdpMetrics: { before: [{ name: "Timestamp", value: 10 }, { name: "TaskDuration", value: 1 }], after: [{ name: "Timestamp", value: 40 }, { name: "TaskDuration", value: 16 }] },
		cgroup: capped,
		playhead: { beforeS: 0, afterS: 30 },
		errors: { exceptions: 0, consoleErrors: 0, samples: [] },
		gpuInfo: { gpu: { featureStatus: { video_decode: "enabled_readback" } }, commandLine: "e --enable-features=AcceleratedVideoDecoder" },
		memoryBridge: { totalBytes: 4 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: 1024 ** 3 },
		mediaEvents: [{ playerId: "p1", properties: [{ name: "kVideoDecoderName", value: '"FFmpegVideoDecoder"' }] }],
		clkTck: 100,
		notes: [],
		...overrides,
	};
}

describe("buildScenarioResult", () => {
	test("one JSON-safe object with every section the doc describes", () => {
		const result = buildScenarioResult(rawScenario());
		expect(result.schema).toBe(RESULT_SCHEMA);
		expect(Object.keys(result)).toEqual(["schema", "scenario", "kind", "title", "project", "window", "frames", "hud", "levers", "longTasks", "cache", "mainThread", "processes", "threads", "memory", "memoryBridge", "gpu", "decoders", "errors", "targets", "notes"]);
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
		expect(result.window).toEqual({ timelineFromS: 0, timelineToS: 30, playedS: 30, playheadAdvancedS: 30 });
		expect(result.frames.source).toBe("present");
		expect(result.frames.fps).toBeCloseTo(30, 6);
		expect(result.frames.buckets).toHaveLength(6);
		expect(result.frames.idleRafFps).toBeCloseTo(60, 6);
		expect(result.frames.raf.fps).toBeCloseTo(30, 6);
		expect(result.longTasks.count).toBe(1);
		expect(result.cache.hitRate).toBeCloseTo(1780 / 1800, 9);
		expect(result.mainThread.mainThreadBusyPercent).toBeCloseTo(50, 9);
		expect(result.processes.byRole.renderer.cpuPercent.mean).toBeCloseTo(100, 9);
		expect(result.processes.byRole.renderer.cpuPercent.max).toBeCloseTo(200, 9);
		expect(result.threads).toEqual([{ pid: 2, role: "renderer", top: [{ name: "CrRendererMain", threads: 1, cpuPercent: 50 }] }]);
		expect(result.memory.cgroup).toEqual(capped);
		expect(result.memoryBridge).toEqual({ totalBytes: 4 * 1024 ** 3, availableBytes: 2 * 1024 ** 3, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: 1024 ** 3, withinCgroupMax: true });
		expect(result.gpu).toMatchObject({ videoDecode: "enabled_readback", enableFeatures: ["AcceleratedVideoDecoder"] });
		expect(result.decoders).toEqual([{ playerId: "p1", properties: { kVideoDecoderName: "FFmpegVideoDecoder" } }]);
		expect(result.targets.allMet).toBe(true);
	});

	test("the bridge's totalBytes must not exceed the cgroup's MemoryMax (it is cgroup-aware); no bridge or no cap: null", () => {
		const off = buildScenarioResult(rawScenario({ memoryBridge: { totalBytes: 16 * 1024 ** 3, availableBytes: 1, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: 1 } }));
		expect(off.memoryBridge.withinCgroupMax).toBe(false);
		expect(buildScenarioResult(rawScenario({ memoryBridge: null })).memoryBridge).toBeNull();
		expect(buildScenarioResult(rawScenario({ cgroup: null })).memoryBridge.withinCgroupMax).toBeNull();
		expect(buildScenarioResult(rawScenario({ cgroup: { ...capped, capped: false, maxBytes: null } })).memoryBridge.withinCgroupMax).toBeNull();
	});

	test("the HUD text is parsed and summarized when present", () => {
		const hudText = [
			"Ccut playback HUD: 30.0 s since play, 900 frames (0 not stored)",
			"columns: ...",
			"per 5 s since play:",
			"    0-5 s |  30.0 fps | int 33/34/40 ms | draw 10/12/20 ms | decode wait 5/2 ms | restarts 1 | waits 3 | stale 0 | skipped 0 | uploads 150 (311.0 MP) | long tasks 0/0 ms | heap 40.0 MB",
			"per second:",
		].join("\n");
		const result = buildScenarioResult(rawScenario({ hudText }));
		expect(result.hud.rows5s).toHaveLength(1);
		expect(result.hud.summary.restarts).toBe(1);
	});

	test("a window without presented frames falls back and notes why", () => {
		const raw = rawScenario();
		raw.page.present = [];
		raw.page.presentCanvas = { chosen: -1, counts: [] };
		const result = buildScenarioResult(raw);
		expect(result.frames.source).toBe("raf");
		expect(result.notes.join(" ")).toContain("no presented frames");
	});
});

describe("formatRunTable / buildRun", () => {
	test("one line per scenario with the headline numbers and the verdict; failures listed", () => {
		const run = buildRun({
			label: "after",
			startedAt: "2026-10-04T10:00:00.000Z",
			finishedAt: "2026-10-04T10:10:00.000Z",
			options: { seconds: 30 },
			machine: { cpus: 12 },
			scenarios: { S1: buildScenarioResult(rawScenario()) },
			failures: [{ scenario: "S2", message: "the project could not be built" }],
		});
		expect(run.schema).toBe(RUN_SCHEMA);
		const text = formatRunTable(run);
		expect(text).toContain("S1");
		expect(text).toContain("30.0");
		expect(text).toContain("all met");
		expect(text).toContain("enabled_readback / FFmpegVideoDecoder");
		expect(text).toContain("S2 FAILED: the project could not be built");
	});
});

describe("compareRuns", () => {
	const runWith = (fpsValue) => buildRun({ label: "x", startedAt: "", finishedAt: "", options: {}, machine: {}, scenarios: { S1: buildScenarioResult(rawScenario({ page: { ...rawScenario().page, present: steady({ fps: fpsValue, seconds: 30 }) } })) }, failures: [] });

	test("per scenario and metric: before, after, delta and whether it is better", () => {
		const { rows } = compareRuns({ before: runWith(24), after: runWith(30) });
		const fps = rows.find((row) => row.scenario === "S1" && row.metric === "fps mean");
		expect(fps.before).toBeCloseTo(24, 6);
		expect(fps.after).toBeCloseTo(30, 6);
		expect(fps.delta).toBeCloseTo(6, 6);
		expect(fps.verdict).toBe("better");
		const p95 = rows.find((row) => row.metric === "interval p95 ms");
		expect(p95.verdict).toBe("better");
		const cpu = rows.find((row) => row.metric === "CPU % renderer");
		expect(cpu.verdict).toBe("-");
	});

	test("worse, same, missing values and scenarios in only one run", () => {
		const { rows, notes } = compareRuns({ before: runWith(30), after: { ...runWith(24), scenarios: { ...runWith(24).scenarios, S3: runWith(24).scenarios.S1 } } });
		expect(rows.find((row) => row.metric === "fps mean").verdict).toBe("worse");
		expect(rows.find((row) => row.metric === "long tasks").verdict).toBe("same");
		expect(notes.join(" ")).toContain("S3");
		const missing = compareRuns({ before: runWith(30), after: runWith(30) }).rows.find((row) => row.metric === "HUD restarts/s");
		expect(missing).toMatchObject({ before: null, after: null, delta: null, verdict: "-" });
	});

	test("a change of the decode path (GPU video decode status or decoder name) is flagged", () => {
		const before = runWith(30);
		const after = runWith(30);
		after.scenarios.S1.gpu.videoDecode = "enabled";
		after.scenarios.S1.decoders = [{ playerId: "p9", properties: { kVideoDecoderName: "VaapiVideoDecoder" } }];
		const notes = compareRuns({ before, after }).notes.join(" ");
		expect(notes).toContain("enabled_readback -> enabled");
		expect(notes).toContain("FFmpegVideoDecoder -> VaapiVideoDecoder");
		expect(compareRuns({ before: runWith(30), after: runWith(30) }).notes).toEqual([]);
	});

	test("different frame sources are flagged", () => {
		const before = runWith(30);
		const after = runWith(30);
		after.scenarios.S1.frames.source = "raf";
		expect(compareRuns({ before, after }).notes.join(" ")).toContain("frame source");
	});

	test("the table prints every row", () => {
		const { rows } = compareRuns({ before: runWith(24), after: runWith(30) });
		const text = formatCompareTable({ rows, notes: ["n1"] });
		expect(text.split("\n").filter((line) => line.startsWith("S1")).length).toBe(rows.length);
		expect(text).toContain("n1");
	});
});
