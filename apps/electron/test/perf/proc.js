// /proc parsing for the playback harness (Linux, proc(5)): process stat/status/cmdline, the
// Electron process tree, CPU % from tick deltas, cgroup v2 memory files. Pure: text in, values out.

const INTEGER = /^\d+$/;
const toCount = (text) => (typeof text === "string" && INTEGER.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null);

/**
 * /proc/<pid>/stat (or /proc/<pid>/task/<tid>/stat). The comm field may contain spaces and
 * parentheses, so it ends at the LAST ')'. Fields after it are counted from field 3 (state).
 */
function parseProcStat(text) {
	if (typeof text !== "string") return null;
	const open = text.indexOf(" (");
	const close = text.lastIndexOf(")");
	if (open <= 0 || close < open) return null;
	const pid = toCount(text.slice(0, open));
	const rest = text.slice(close + 2).trim().split(" ");
	if (!pid || rest.length < 20) return null;
	const field = (n) => toCount(rest[n - 3]);
	const parsed = {
		pid,
		comm: text.slice(open + 2, close),
		state: rest[0],
		ppid: field(4),
		utimeTicks: field(14),
		stimeTicks: field(15),
		numThreads: field(20),
		startTimeTicks: field(22),
	};
	return Object.values(parsed).some((value) => value === null) ? null : parsed;
}

const STATUS_FIELDS = { VmRSS: "vmRssKiB", RssAnon: "rssAnonKiB", RssFile: "rssFileKiB", RssShmem: "rssShmemKiB" };

/** /proc/<pid>/status -> resident memory in KiB (null when the line is absent, e.g. a zombie). */
function parseProcStatus(text) {
	const out = { vmRssKiB: null, rssAnonKiB: null, rssFileKiB: null, rssShmemKiB: null };
	if (typeof text !== "string") return out;
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+) kB$/.exec(line);
		if (match && Object.hasOwn(STATUS_FIELDS, match[1])) out[STATUS_FIELDS[match[1]]] = Number(match[2]);
	}
	return out;
}

/** /proc/<pid>/cmdline: NUL-separated arguments. */
function parseCmdline(text) {
	if (typeof text !== "string" || text === "") return [];
	const parts = text.split("\0");
	if (parts[parts.length - 1] === "") parts.pop();
	return parts;
}

const TYPE_ROLES = { renderer: "renderer", "gpu-process": "gpu", utility: "utility", zygote: "zygote" };

/**
 * Which Chromium/Electron process this is: the root of the tree is the browser (Electron main);
 * the others carry --type= (renderer, gpu-process, utility + --utility-sub-type=, zygote, ...).
 */
function classifyProcess({ argv, isRoot }) {
	if (isRoot) return { role: "browser", subtype: null };
	const valueOf = (name) => {
		const arg = argv.find((entry) => entry.startsWith(`--${name}=`));
		return arg === undefined ? null : arg.slice(name.length + 3);
	};
	const type = valueOf("type");
	if (type === null) {
		const exe = argv.length > 0 ? argv[0].split("/").pop() : "";
		return { role: exe.includes("crashpad") ? "crashpad" : "other", subtype: null };
	}
	if (Object.hasOwn(TYPE_ROLES, type)) {
		return { role: TYPE_ROLES[type], subtype: type === "utility" ? valueOf("utility-sub-type") : null };
	}
	return { role: "other", subtype: type };
}

/** The key the harness groups by: the role, utility processes by their sub-type. */
const roleKey = ({ role, subtype }) => (role === "utility" && subtype ? `utility:${subtype}` : role);

/** The root pid and every pid below it ({ pid, ppid } entries of one /proc scan). */
function descendantsOf({ entries, rootPid }) {
	if (!entries.some((entry) => entry.pid === rootPid)) return [];
	const children = new Map();
	for (const { pid, ppid } of entries) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	const seen = new Set([rootPid]);
	const queue = [rootPid];
	for (let i = 0; i < queue.length && i <= entries.length; i++) {
		for (const child of children.get(queue[i]) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			queue.push(child);
		}
	}
	return queue;
}

/** CPU % of one core over `elapsedMs` from utime+stime ticks (USER_HZ = CLK_TCK); null when not computable. */
function cpuPercent({ beforeTicks, afterTicks, elapsedMs, clkTck }) {
	const valid = [beforeTicks, afterTicks, elapsedMs, clkTck].every((value) => typeof value === "number" && Number.isFinite(value));
	if (!valid || elapsedMs <= 0 || clkTck <= 0 || afterTicks < beforeTicks) return null;
	return ((afterTicks - beforeTicks) / clkTck / (elapsedMs / 1000)) * 100;
}

/** `getconf CLK_TCK` output -> a positive integer or null (the harness then assumes 100). */
function parseClkTck(text) {
	const value = typeof text === "string" ? toCount(text.trim()) : null;
	return value && value > 0 ? value : null;
}

/** /proc/<pid>/cgroup -> the cgroup v2 path (the "0::" line), or null. */
function parseCgroupV2Path(text) {
	if (typeof text !== "string") return null;
	const line = text.split("\n").find((entry) => entry.startsWith("0::"));
	if (!line) return null;
	const cgroupPath = line.slice(3);
	if (!cgroupPath.startsWith("/") || cgroupPath.split("/").includes("..") || cgroupPath.includes("\0")) return null;
	return cgroupPath;
}

/** memory.current / memory.peak / memory.max / memory.swap.max: a byte count, "max" or null. */
function parseCgroupValue(text) {
	if (typeof text !== "string") return null;
	const value = text.trim();
	return value === "max" ? "max" : toCount(value);
}

/** "key value" lines (memory.events) -> { key: number }. */
function parseFlatKeyed(text) {
	const out = {};
	if (typeof text !== "string") return out;
	for (const line of text.split("\n")) {
		const match = /^([A-Za-z_]+) (\d+)$/.exec(line.trim());
		if (match) out[match[1]] = Number(match[2]);
	}
	return out;
}

/**
 * Busiest thread names of one process between two snapshots ({ tid, comm, ticks }): threads of
 * the same name are summed (Chromium pools: ThreadPoolForeg, ...); a thread missing from `before`
 * (born in between, or a reused id with another name or fewer ticks) counts from 0.
 */
function topThreadsByName({ before, after, elapsedMs, clkTck, limit }) {
	const previous = new Map(before.map((thread) => [thread.tid, thread]));
	const byName = new Map();
	for (const thread of after) {
		const old = previous.get(thread.tid);
		const base = old && old.comm === thread.comm && old.ticks <= thread.ticks ? old.ticks : 0;
		const cpu = cpuPercent({ beforeTicks: base, afterTicks: thread.ticks, elapsedMs, clkTck });
		if (cpu === null) continue;
		const entry = byName.get(thread.comm) ?? { name: thread.comm, threads: 0, cpuPercent: 0 };
		entry.threads += 1;
		entry.cpuPercent += cpu;
		byName.set(thread.comm, entry);
	}
	return [...byName.values()].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, limit);
}

module.exports = {
	classifyProcess,
	cpuPercent,
	descendantsOf,
	parseCgroupV2Path,
	parseCgroupValue,
	parseClkTck,
	parseCmdline,
	parseFlatKeyed,
	parseProcStat,
	parseProcStatus,
	roleKey,
	topThreadsByName,
};
