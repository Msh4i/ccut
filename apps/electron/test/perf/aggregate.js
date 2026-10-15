// Turns what the harness sampled every 500 ms (process CPU ticks and RSS, system memory, the
// video cache's running totals) and the CDP Performance metrics into per-scenario numbers. Pure.
const { cpuPercent, parseCgroupValue, parseFlatKeyed, roleKey } = require("./proc");
const { bucketsOf, isNumber, percentile, summarizeSeries } = require("./stats");

const MiB = 1024 * 1024;
// The counter sample taken right after Pause lands a little after the window end.
const END_TOLERANCE_MS = 250;

const processKey = (process) => `${process.pid}:${process.startTimeTicks}`;
const inWindow = ({ atMs, startMs, endMs }) => atMs >= startMs && atMs < endMs;

/**
 * The intervals between consecutive samples: per process key the tick delta (only when the same
 * process, same start time, was seen in both samples with ticks not going down) and the role.
 */
function intervalsOf(samples) {
	const out = [];
	for (let i = 1; i < samples.length; i++) {
		const previous = new Map(samples[i - 1].processes.map((process) => [processKey(process), process]));
		const deltas = [];
		for (const process of samples[i].processes) {
			const before = previous.get(processKey(process));
			if (!before || !isNumber(before.ticks) || !isNumber(process.ticks) || process.ticks < before.ticks) continue;
			deltas.push({ key: processKey(process), role: roleKey(process), ticks: process.ticks - before.ticks });
		}
		const fromMs = samples[i - 1].atMs;
		const toMs = samples[i].atMs;
		if (toMs > fromMs) out.push({ fromMs, toMs, midMs: (fromMs + toMs) / 2, deltas });
	}
	return out;
}

function cpuStats({ intervals, clkTck, select, startMs, endMs, bucketMs }) {
	const percentOf = (list) => {
		const ticks = list.reduce((sum, interval) => sum + interval.deltas.filter(select).reduce((s, d) => s + d.ticks, 0), 0);
		const ms = list.reduce((sum, interval) => sum + (interval.toMs - interval.fromMs), 0);
		return ms > 0 ? cpuPercent({ beforeTicks: 0, afterTicks: ticks, elapsedMs: ms, clkTck }) : null;
	};
	const window = intervals.filter((interval) => inWindow({ atMs: interval.midMs, startMs, endMs }));
	const values = window.map((interval) => percentOf([interval]));
	return {
		mean: percentOf(window),
		p95: percentile({ values, q: 0.95 }),
		max: values.length > 0 ? values.reduce((max, value) => Math.max(max, value)) : null,
		buckets: bucketsOf({ startMs, endMs, bucketMs }).map((bucket) => ({
			fromS: bucket.fromS,
			toS: bucket.toS,
			mean: percentOf(window.filter((interval) => interval.midMs >= bucket.fromMs && interval.midMs < bucket.toMs)),
		})),
		idle: percentOf(intervals.filter((interval) => interval.midMs < startMs)),
	};
}

function rssStats({ samples, select }) {
	const series = samples.map((s) => s.processes.filter(select).reduce((sum, process) => sum + (isNumber(process.rssKiB) ? process.rssKiB : 0), 0) / 1024);
	const summary = summarizeSeries(series);
	return { start: summary.first, max: summary.max, end: summary.last };
}

/**
 * samples: [{ atMs, processes: [{ pid, startTimeTicks, role, subtype, ticks, rssKiB }] }] (ticks =
 * utime + stime). CPU % (100 = one core) per role key, time-weighted over the intervals whose
 * midpoint lies in [startMs, endMs); RSS per role from the samples in [startMs, endMs]; idle =
 * the intervals before the window. Null without samples or without a clock tick rate.
 */
function summarizeProcesses({ samples, clkTck, startMs, endMs, bucketMs }) {
	if (samples.length === 0 || !(clkTck > 0)) return null;
	const intervals = intervalsOf(samples);
	const windowSamples = samples.filter((s) => s.atMs >= startMs && s.atMs <= endMs);
	const seen = new Map();
	for (const s of windowSamples) for (const process of s.processes) seen.set(processKey(process), { pid: process.pid, role: roleKey(process) });
	const roles = [...new Set([...seen.values()].map((entry) => entry.role))].sort();

	const describe = ({ select, processes }) => {
		const cpu = cpuStats({ intervals, clkTck, select, startMs, endMs, bucketMs });
		return {
			processes,
			cpuPercent: { mean: cpu.mean, p95: cpu.p95, max: cpu.max, buckets: cpu.buckets },
			idleCpuPercent: cpu.idle,
			rssMiB: rssStats({ samples: windowSamples, select: (process) => select({ role: roleKey(process), key: processKey(process) }) }),
		};
	};
	const byRole = {};
	for (const role of roles) {
		byRole[role] = describe({ select: (entry) => entry.role === role, processes: [...seen.values()].filter((entry) => entry.role === role).length });
	}
	const perProcess = [...seen.entries()].map(([key, entry]) => {
		const own = intervals
			.filter((interval) => inWindow({ atMs: interval.midMs, startMs, endMs }))
			.map((interval) => ({ ms: interval.toMs - interval.fromMs, delta: interval.deltas.find((d) => d.key === key) }))
			.filter((item) => item.delta);
		const ms = own.reduce((sum, item) => sum + item.ms, 0);
		const ticks = own.reduce((sum, item) => sum + item.delta.ticks, 0);
		const rss = summarizeSeries(windowSamples.map((s) => s.processes.find((process) => processKey(process) === key)?.rssKiB / 1024));
		return { pid: entry.pid, role: entry.role, cpuPercentMean: ms > 0 ? cpuPercent({ beforeTicks: 0, afterTicks: ticks, elapsedMs: ms, clkTck }) : null, rssMaxMiB: rss.max };
	});
	perProcess.sort((a, b) => (b.cpuPercentMean ?? -1) - (a.cpuPercentMean ?? -1));
	return { clkTck, byRole, total: describe({ select: () => true, processes: seen.size }), perProcess };
}

/** samples: [{ atMs, memAvailableBytes, swapFreeBytes, cgroupCurrentBytes }] -> MiB series over [startMs, endMs]. */
function summarizeMemory({ samples, startMs, endMs }) {
	const window = samples.filter((s) => s.atMs >= startMs && s.atMs <= endMs);
	const mib = (field) => summarizeSeries(window.map((s) => (isNumber(s[field]) ? s[field] / MiB : null)));
	return { memAvailableMiB: mib("memAvailableBytes"), swapFreeMiB: mib("swapFreeBytes"), cgroupCurrentMiB: mib("cgroupCurrentBytes") };
}

/**
 * The cgroup v2 the Electron tree runs in (systemd-run --scope -p MemoryMax=...): its limits, its
 * peak since the scope started (the whole harness run, not one scenario), and from memory.events
 * read before/after the window: how often usage hit memory.max (the kernel had to reclaim or
 * throttle) and the OOM kills. Null counts when memory.events was not readable.
 */
function cgroupSummary({ cgroupPath, maxText, swapMaxText, peakText, eventsBefore, eventsAfter }) {
	if (!cgroupPath) return null;
	const bytes = (text) => {
		const value = parseCgroupValue(text);
		return value === "max" ? null : value;
	};
	const before = parseFlatKeyed(eventsBefore);
	const after = parseFlatKeyed(eventsAfter);
	const delta = (key) => (Object.hasOwn(after, key) ? Math.max(0, after[key] - (before[key] ?? 0)) : null);
	const maxBytes = bytes(maxText);
	return { path: cgroupPath, maxBytes, swapMaxBytes: bytes(swapMaxText), peakBytes: bytes(peakText), maxEvents: delta("max"), oomKills: delta("oom_kill"), capped: maxBytes !== null };
}

const COUNTER_FIELDS = ["requests", "hits", "readAheadHits", "advances", "restarts", "stalePresents", "draws", "skipped", "errors", "waitMs"];

/**
 * The video cache's running totals (FrameCacheCounters, sampled with their time) -> deltas over
 * the window and per bucket. Values at a time = the last sample at or before it; the end of the
 * window may use a sample up to END_TOLERANCE_MS later (the one taken right after Pause).
 * hitRate = (hits + readAheadHits) / requests. Totals that went down (a reload) give reset: true
 * and no numbers. Null when no sample carried counters.
 */
function summarizeCounters({ samples, startMs, endMs, bucketMs }) {
	const usable = samples.filter((s) => s.counters && typeof s.counters === "object").sort((a, b) => a.atMs - b.atMs);
	if (usable.length === 0) return null;
	const valueAt = (atMs) => {
		let found = usable[0];
		for (const s of usable) if (s.atMs <= atMs) found = s;
		return found.counters;
	};
	const delta = ({ from, to }) => {
		const out = {};
		for (const field of COUNTER_FIELDS) {
			const value = isNumber(to[field]) && isNumber(from[field]) ? to[field] - from[field] : null;
			if (value !== null && value < 0) return null;
			out[field] = value;
		}
		return out;
	};
	const describeDelta = ({ d, seconds }) => ({
		requests: d ? d.requests : null,
		hits: d ? d.hits + d.readAheadHits : null,
		hitRate: d && d.requests > 0 ? (d.hits + d.readAheadHits) / d.requests : null,
		restarts: d ? d.restarts : null,
		restartsPerSecond: d && seconds > 0 ? d.restarts / seconds : null,
		advances: d ? d.advances : null,
		stalePresents: d ? d.stalePresents : null,
		skipped: d ? d.skipped : null,
		errors: d ? d.errors : null,
		waitMs: d ? d.waitMs : null,
	});
	const overall = delta({ from: valueAt(startMs), to: valueAt(endMs + END_TOLERANCE_MS) });
	const buckets = bucketsOf({ startMs, endMs, bucketMs });
	return {
		...describeDelta({ d: overall, seconds: (endMs - startMs) / 1000 }),
		reset: overall === null,
		buckets: buckets.map((bucket, index) => {
			const last = index === buckets.length - 1;
			const d = delta({ from: valueAt(bucket.fromMs), to: valueAt(bucket.toMs + (last ? END_TOLERANCE_MS : 0)) });
			return { fromS: bucket.fromS, toS: bucket.toS, ...describeDelta({ d, seconds: (bucket.toMs - bucket.fromMs) / 1000 }) };
		}),
	};
}

/** CDP Performance.getMetrics() lists before/after the window -> main-thread seconds and busy %. */
function metricsDelta({ before, after }) {
	if (!Array.isArray(before) || !Array.isArray(after)) return null;
	const map = (list) => new Map(list.filter((m) => m && typeof m.name === "string" && isNumber(m.value)).map((m) => [m.name, m.value]));
	const a = map(before);
	const b = map(after);
	const diff = (name) => (a.has(name) && b.has(name) ? b.get(name) - a.get(name) : null);
	const wallS = diff("Timestamp");
	const taskS = diff("TaskDuration");
	const heap = (m) => (m.has("JSHeapUsedSize") ? m.get("JSHeapUsedSize") / MiB : null);
	return {
		wallS,
		taskS,
		scriptS: diff("ScriptDuration"),
		layoutS: diff("LayoutDuration"),
		recalcStyleS: diff("RecalcStyleDuration"),
		mainThreadBusyPercent: wallS > 0 && taskS !== null ? (taskS / wallS) * 100 : null,
		jsHeapUsedMiB: { before: heap(a), after: heap(b) },
	};
}

module.exports = { cgroupSummary, metricsDelta, summarizeCounters, summarizeMemory, summarizeProcesses };
