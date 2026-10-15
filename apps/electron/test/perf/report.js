// The playback harness's output: one result object per scenario (written as JSON), the acceptance
// targets, the short stdout table and the before/after comparison. Pure.
const { metricsDelta, summarizeCounters, summarizeMemory, summarizeProcesses } = require("./aggregate");
const { decoderReports, gpuDecodeStatus } = require("./gpu-info");
const { parseHudDump, summarizeHudRows } = require("./hud");
const { leversCompareNote, leversLineOf } = require("./levers");
const { topThreadsByName } = require("./proc");
const { detectCliff, isNumber, summarizeLongTasks, summarizeTimestamps } = require("./stats");

const RESULT_SCHEMA = "ccut-perf-2clips/1";
const RUN_SCHEMA = "ccut-perf-2clips-run/1";
const BUCKET_MS = 5000;
const MiB = 1024 * 1024;
const THREADS_PER_PROCESS = 8;

// docs/ccut/playback-measure-2clips.md "Acceptance targets": 30 fps sustained = every complete
// 5 s bucket at >= 29 fps (one frame per second of slack for bucket edges).
const TARGETS = Object.freeze({
	synthetic: Object.freeze({ minBucketFps: 29, maxIntervalP95Ms: 40, cliffRatio: 0.9 }),
	project: Object.freeze({ minFps: 45, cliffRatio: 0.9 }),
});

const completeBuckets = (summary) => (summary?.buckets ?? []).filter((bucket) => bucket.complete && isNumber(bucket.fps));
const minOf = (values) => (values.length > 0 ? values.reduce((low, value) => Math.min(low, value)) : null);
const maxOf = (values) => (values.length > 0 ? values.reduce((high, value) => Math.max(high, value)) : null);

/** HUD 5 s rows as a frame summary: complete = the row ends inside the HUD's elapsed time. */
function hudAsSummary({ elapsedS, rows5s }) {
	const buckets = rows5s.map((row) => ({
		fromS: row.fromS,
		toS: Math.min(row.toS, elapsedS),
		complete: row.toS <= elapsedS + 1e-6,
		frames: null,
		fps: row.fps,
		intervalP50Ms: row.intervalP50Ms,
		intervalP95Ms: row.intervalP95Ms,
		intervalMaxMs: row.intervalMaxMs,
	}));
	const weighted = buckets.reduce((sum, bucket) => sum + (bucket.fps ?? 0) * Math.max(0, bucket.toS - bucket.fromS), 0);
	return {
		frames: null,
		seconds: elapsedS,
		fps: elapsedS > 0 ? weighted / elapsedS : null,
		intervalP50Ms: null,
		intervalP95Ms: null,
		intervalMaxMs: maxOf(buckets.map((bucket) => bucket.intervalMaxMs).filter(isNumber)),
		buckets,
	};
}

/**
 * Which frame series the targets use: the frames presented on the preview canvas (GPUCanvasContext
 * hook) when there are any, else the HUD's draw rows, else the page's requestAnimationFrame ticks.
 */
function pickFrameSource({ present, hud, raf }) {
	if (present && present.frames >= 2) return { source: "present", summary: present };
	if (hud && Array.isArray(hud.rows5s) && hud.rows5s.length > 0) return { source: "hud", summary: hudAsSummary(hud) };
	if (raf && raf.frames >= 2) return { source: "raf", summary: raf };
	return { source: null, summary: null };
}

/**
 * "RSS inside the budget under the cap": the cgroup never hit MemoryMax in the window (memory.events
 * "max" did not grow: no forced reclaim or throttling) and nothing was OOM-killed. memory.peak
 * cannot exceed memory.max, so it proves nothing by itself. The actual value shown is the highest
 * memory.current sample of the window (else the run's memory.peak).
 */
function memoryCheck({ cgroup, cgroupSampledMaxBytes }) {
	const base = { id: "memory", label: "memory: the cgroup never hit MemoryMax and nothing was OOM-killed" };
	if (!cgroup || !cgroup.capped) return { ...base, target: null, actual: cgroupSampledMaxBytes ?? null, met: null, note: "not run under a MemoryMax cap (systemd-run --scope -p MemoryMax=...)" };
	const actual = isNumber(cgroupSampledMaxBytes) ? cgroupSampledMaxBytes : (cgroup.peakBytes ?? null);
	const out = { ...base, target: cgroup.maxBytes, actual };
	if (cgroup.oomKills > 0) return { ...out, met: false, note: `${cgroup.oomKills} OOM kill(s) in the cgroup during the window` };
	if (cgroup.maxEvents > 0) return { ...out, met: false, note: `usage hit MemoryMax ${cgroup.maxEvents} time(s) in the window: the kernel had to reclaim or throttle` };
	if (cgroup.oomKills === null || cgroup.maxEvents === null) return { ...out, met: null, note: "memory.events was not readable" };
	return { ...out, met: true };
}

/** The acceptance checks of one scenario: { source, checks: [{ id, label, target, actual, met }], allMet }. */
function evaluateTargets({ kind, frames, cgroup, cgroupSampledMaxBytes }) {
	const summary = frames.summary;
	const checks = [];
	const complete = completeBuckets(summary);
	const cliff = detectCliff({ buckets: summary?.buckets ?? [], ratio: TARGETS[kind === "project" ? "project" : "synthetic"].cliffRatio });
	const cliffCheck = {
		id: "cliff",
		label: "no cliff: no later complete 5 s bucket below 90 % of the first",
		target: 0.9,
		actual: cliff.cliff === null ? null : cliff.worstLaterFps / cliff.firstFps,
		met: cliff.cliff === null ? null : !cliff.cliff,
	};
	if (kind === "project") {
		const fps = summary && isNumber(summary.fps) ? summary.fps : null;
		checks.push({ id: "fps", label: `mean fps over the window >= ${TARGETS.project.minFps}`, target: TARGETS.project.minFps, actual: fps, met: fps === null ? null : fps >= TARGETS.project.minFps });
		checks.push(cliffCheck);
	} else {
		const { minBucketFps, maxIntervalP95Ms } = TARGETS.synthetic;
		const lowest = minOf(complete.map((bucket) => bucket.fps));
		checks.push({ id: "fps", label: `30 fps sustained: every complete 5 s bucket >= ${minBucketFps} fps`, target: minBucketFps, actual: lowest, met: lowest === null ? null : lowest >= minBucketFps });
		const overall = summary && isNumber(summary.intervalP95Ms) ? summary.intervalP95Ms : null;
		const worstBucket = maxOf(complete.map((bucket) => bucket.intervalP95Ms).filter(isNumber));
		const p95 = overall ?? worstBucket;
		checks.push({
			id: "p95",
			label: `frame interval p95 <= ${maxIntervalP95Ms} ms`,
			target: maxIntervalP95Ms,
			actual: p95,
			met: p95 === null ? null : p95 <= maxIntervalP95Ms,
			...(overall === null && worstBucket !== null ? { note: "no overall p95 (HUD rows): the worst 5 s bucket p95 stands in" } : {}),
		});
		checks.push(cliffCheck);
	}
	checks.push(memoryCheck({ cgroup, cgroupSampledMaxBytes }));
	const allMet = checks.some((check) => check.met === false) ? false : checks.every((check) => check.met === true) ? true : null;
	return { source: frames.source, checks, allMet };
}

/**
 * Everything the harness collected for one scenario -> its result object. Page times (frames,
 * long tasks, counters) use the page clock, process/memory samples the harness's clock.
 */
function buildScenarioResult(raw) {
	const { page, node } = raw;
	const notes = [...(raw.notes ?? [])];
	const window = { startMs: page.playMs, endMs: page.pauseMs, bucketMs: BUCKET_MS };
	const present = page.present.length > 0 ? summarizeTimestamps({ timestamps: page.present, ...window }) : null;
	const raf = summarizeTimestamps({ timestamps: page.raf, ...window });
	const idle = page.idleFromMs < page.playMs ? summarizeTimestamps({ timestamps: page.raf, startMs: page.idleFromMs, endMs: page.playMs, bucketMs: page.playMs - page.idleFromMs }) : null;
	const parsedHud = parseHudDump(raw.hudText);
	const hud = parsedHud ? { ...parsedHud, summary: summarizeHudRows({ rows: parsedHud.rows5s, elapsedS: parsedHud.elapsedS }) } : null;
	const frames = pickFrameSource({ present, hud, raf });
	if (frames.source !== "present") notes.push(`no presented frames of the preview canvas (GPUCanvasContext hook): frame numbers come from ${frames.source ?? "nothing"}`);
	const memory = { ...summarizeMemory({ samples: node.memorySamples, startMs: node.playAtMs, endMs: node.pauseAtMs }), cgroup: raw.cgroup };
	const sampledMax = memory.cgroupCurrentMiB.max;
	const summary = frames.summary;

	const windowOut = {
		timelineFromS: raw.check.window ? raw.check.window.fromS : null,
		timelineToS: raw.check.window ? raw.check.window.toS : null,
		playedS: (page.pauseMs - page.playMs) / 1000,
		playheadAdvancedS: raw.playhead && isNumber(raw.playhead.beforeS) && isNumber(raw.playhead.afterS) ? raw.playhead.afterS - raw.playhead.beforeS : null,
	};
	if (raw.check.sourceOffsetS !== undefined) windowOut.sourceOffsetS = raw.check.sourceOffsetS;
	if (raw.check.cutS !== undefined) windowOut.cutS = raw.check.cutS;

	return {
		schema: RESULT_SCHEMA,
		scenario: raw.scenario,
		kind: raw.kind,
		title: raw.title,
		project: raw.shape,
		window: windowOut,
		frames: {
			source: frames.source,
			fps: summary ? summary.fps : null,
			minBucketFps: minOf(completeBuckets(summary).map((bucket) => bucket.fps)),
			intervalP50Ms: summary ? summary.intervalP50Ms : null,
			intervalP95Ms: summary ? summary.intervalP95Ms : null,
			intervalMaxMs: summary ? summary.intervalMaxMs : null,
			buckets: summary ? summary.buckets : [],
			present,
			presentCanvas: page.presentCanvas,
			raf,
			idleRafFps: idle ? idle.fps : null,
		},
		hud,
		levers: leversLineOf(raw.hudText),
		longTasks: summarizeLongTasks({ tasks: page.longTasks, ...window }),
		cache: summarizeCounters({ samples: raw.counterSamples, ...window }),
		mainThread: metricsDelta({ before: raw.cdpMetrics?.before ?? null, after: raw.cdpMetrics?.after ?? null }),
		processes: summarizeProcesses({ samples: node.processSamples, clkTck: raw.clkTck, startMs: node.playAtMs, endMs: node.pauseAtMs, bucketMs: BUCKET_MS }),
		threads: (node.threadSnapshots ?? []).map((snapshot) => ({
			pid: snapshot.pid,
			role: snapshot.role,
			top: topThreadsByName({ before: snapshot.before, after: snapshot.after, elapsedMs: snapshot.elapsedMs, clkTck: raw.clkTck, limit: THREADS_PER_PROCESS }),
		})),
		memory,
		memoryBridge: memoryBridgeOf({ bridge: raw.memoryBridge ?? null, cgroup: raw.cgroup }),
		gpu: gpuDecodeStatus(raw.gpuInfo ?? null),
		decoders: decoderReports({ events: raw.mediaEvents ?? [] }),
		errors: raw.errors,
		targets: evaluateTargets({ kind: raw.kind, frames, cgroup: raw.cgroup, cgroupSampledMaxBytes: isNumber(sampledMax) ? sampledMax * MiB : null }),
		notes,
	};
}

/**
 * What window.ccutSystem.memoryInfo() answered during the run. The bridge is cgroup-aware, so
 * under a MemoryMax cap its total must not exceed the cap (withinCgroupMax; null without a cap).
 */
function memoryBridgeOf({ bridge, cgroup }) {
	if (!bridge || typeof bridge !== "object") return null;
	const withinCgroupMax = cgroup && cgroup.capped && isNumber(bridge.totalBytes) ? bridge.totalBytes <= cgroup.maxBytes : null;
	return { ...bridge, withinCgroupMax };
}

function buildRun({ label, startedAt, finishedAt, options, machine, scenarios, failures, notes = [] }) {
	return { schema: RUN_SCHEMA, label, startedAt, finishedAt, options, machine, scenarios, failures, notes };
}

const fmtDigits = ({ value, digits }) => (isNumber(value) ? (Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(digits)) : "-");
const fmt = (value) => fmtDigits({ value, digits: 1 });
const fmt0 = (value) => fmtDigits({ value, digits: 0 });
const roleCpu = ({ result, role }) => result.processes?.byRole?.[role]?.cpuPercent.mean ?? null;

const decoderNamesOf = (result) => [...new Set((result.decoders ?? []).map((report) => report.properties.kVideoDecoderName).filter(Boolean))].join(",") || "-";
const videoDecodeOf = (result) => result.gpu?.videoDecode ?? "-";

/** "<chrome://gpu video decode status> / <decoder names>", e.g. "enabled / VaapiVideoDecoder". */
const decodePathOf = (result) => `${videoDecodeOf(result)} / ${decoderNamesOf(result)}`;

function verdictOf(result) {
	const targets = result.targets;
	if (targets.allMet === true) return "all met";
	const missed = targets.checks.filter((check) => check.met === false).map((check) => check.id);
	return missed.length > 0 ? `MISSED: ${missed.join(",")}` : "not evaluated";
}

function table(rows) {
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
	return rows.map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join(" | ").trimEnd()).join("\n");
}

/** The short stdout table of one run. */
function formatRunTable(run) {
	const header = ["scenario", "source", "fps", "min 5 s", "p95 ms", "max ms", "long tasks", "restarts/s", "hit %", "CPU % rend/gpu/main/all", "RSS max MiB", "cgroup peak MiB", "decode (gpu / decoder)", "targets"];
	const rows = [header];
	for (const [id, result] of Object.entries(run.scenarios)) {
		const restarts = result.hud?.summary.restartsPerSecond ?? result.cache?.restartsPerSecond ?? null;
		const peak = result.memory.cgroup?.peakBytes;
		rows.push([
			id,
			result.frames.source ?? "-",
			fmt(result.frames.fps),
			fmt(result.frames.minBucketFps),
			fmt(result.frames.intervalP95Ms),
			fmt(result.frames.intervalMaxMs),
			`${result.longTasks.count} (${fmt0(result.longTasks.totalMs)} ms)`,
			fmtDigits({ value: restarts, digits: 2 }),
			fmt(isNumber(result.cache?.hitRate) ? result.cache.hitRate * 100 : null),
			["renderer", "gpu", "browser"].map((role) => fmt0(roleCpu({ result, role }))).join("/") + `/${fmt0(result.processes?.total.cpuPercent.mean)}`,
			fmt0(result.processes?.total.rssMiB.max),
			fmt0(isNumber(peak) ? peak / MiB : null),
			decodePathOf(result),
			verdictOf(result),
		]);
	}
	const failures = run.failures.map((failure) => `${failure.scenario} FAILED: ${failure.message}`);
	return [table(rows), ...failures].join("\n");
}

const METRICS = Object.freeze([
	{ metric: "fps mean", get: (r) => r.frames.fps, better: "higher" },
	{ metric: "fps min 5 s", get: (r) => r.frames.minBucketFps, better: "higher" },
	{ metric: "interval p95 ms", get: (r) => r.frames.intervalP95Ms, better: "lower" },
	{ metric: "interval max ms", get: (r) => r.frames.intervalMaxMs, better: "lower" },
	{ metric: "long tasks", get: (r) => r.longTasks?.count, better: "lower" },
	{ metric: "long task ms", get: (r) => r.longTasks?.totalMs, better: "lower" },
	{ metric: "HUD restarts/s", get: (r) => r.hud?.summary.restartsPerSecond, better: "lower" },
	{ metric: "cache restarts/s", get: (r) => r.cache?.restartsPerSecond, better: "lower" },
	{ metric: "cache hit %", get: (r) => (isNumber(r.cache?.hitRate) ? r.cache.hitRate * 100 : null), better: "higher" },
	{ metric: "decode wait ms", get: (r) => r.cache?.waitMs, better: "lower" },
	{ metric: "main thread busy %", get: (r) => r.mainThread?.mainThreadBusyPercent, better: "neutral" },
	{ metric: "CPU % renderer", get: (r) => roleCpu({ result: r, role: "renderer" }), better: "neutral" },
	{ metric: "CPU % gpu", get: (r) => roleCpu({ result: r, role: "gpu" }), better: "neutral" },
	{ metric: "CPU % browser", get: (r) => roleCpu({ result: r, role: "browser" }), better: "neutral" },
	{ metric: "CPU % all", get: (r) => r.processes?.total.cpuPercent.mean, better: "neutral" },
	{ metric: "RSS max MiB", get: (r) => r.processes?.total.rssMiB.max, better: "neutral" },
	{ metric: "cgroup peak MiB", get: (r) => (isNumber(r.memory?.cgroup?.peakBytes) ? r.memory.cgroup.peakBytes / MiB : null), better: "neutral" },
	{ metric: "MemAvailable min MiB", get: (r) => r.memory?.memAvailableMiB.min, better: "neutral" },
]);

function verdict({ before, after, better }) {
	if (!isNumber(before) || !isNumber(after) || better === "neutral") return "-";
	const delta = after - before;
	if (Math.abs(delta) < 1e-9) return "same";
	return (better === "higher") === delta > 0 ? "better" : "worse";
}

/** Two run files -> rows per scenario and metric: { scenario, metric, before, after, delta, deltaPercent, verdict }. */
function compareRuns({ before, after }) {
	const rows = [];
	const notes = [];
	const ids = [...new Set([...Object.keys(before.scenarios), ...Object.keys(after.scenarios)])];
	const leversNote = leversCompareNote({ before, after });
	if (leversNote) notes.push(leversNote);
	for (const id of ids) {
		const a = before.scenarios[id];
		const b = after.scenarios[id];
		if (!a || !b) {
			notes.push(`${id} only in the ${a ? "before" : "after"} run`);
			continue;
		}
		const changes = [
			videoDecodeOf(a) !== videoDecodeOf(b) ? `video decode ${videoDecodeOf(a)} -> ${videoDecodeOf(b)}` : null,
			decoderNamesOf(a) !== decoderNamesOf(b) ? `decoder ${decoderNamesOf(a)} -> ${decoderNamesOf(b)}` : null,
		].filter(Boolean);
		if (changes.length > 0) notes.push(`${id}: the runs did not decode the same way: ${changes.join(", ")}`);
		if (a.frames.source !== b.frames.source) notes.push(`${id}: frame source differs (${a.frames.source} vs ${b.frames.source}), its fps numbers are not comparable`);
		for (const { metric, get, better } of METRICS) {
			const x = get(a);
			const y = get(b);
			const valueBefore = isNumber(x) ? x : null;
			const valueAfter = isNumber(y) ? y : null;
			const delta = valueBefore !== null && valueAfter !== null ? valueAfter - valueBefore : null;
			rows.push({
				scenario: id,
				metric,
				before: valueBefore,
				after: valueAfter,
				delta,
				deltaPercent: delta !== null && valueBefore !== 0 ? (delta / Math.abs(valueBefore)) * 100 : null,
				verdict: verdict({ before: valueBefore, after: valueAfter, better }),
			});
		}
	}
	return { rows, notes };
}

function formatCompareTable({ rows, notes }) {
	const lines = [["scenario", "metric", "before", "after", "delta", "delta %", "verdict"]];
	for (const row of rows) lines.push([row.scenario, row.metric, fmt(row.before), fmt(row.after), fmt(row.delta), fmt(row.deltaPercent), row.verdict]);
	return [table(lines), ...notes.map((note) => `note: ${note}`)].join("\n");
}

module.exports = {
	BUCKET_MS,
	RESULT_SCHEMA,
	RUN_SCHEMA,
	TARGETS,
	buildRun,
	buildScenarioResult,
	compareRuns,
	evaluateTargets,
	formatCompareTable,
	formatRunTable,
	pickFrameSource,
};
