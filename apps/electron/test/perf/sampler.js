// The harness's /proc and cgroup reads (Linux). File access is injected (Node's fs in the harness,
// a fake tree in the tests); every read that fails (a process that just exited, a file the kernel
// does not have) gives null instead of an error.
const path = require("node:path");
const { parseMeminfo } = require("../../system-memory-ipc");
const { classifyProcess, descendantsOf, parseCgroupV2Path, parseCgroupValue, parseCmdline, parseProcStat, parseProcStatus } = require("./proc");

const NUMERIC = /^\d+$/;
// A forked child may still carry its parent's command line for a moment: classify it again later.
const UNSETTLED_ROLES = new Set(["zygote", "other"]);

function createSampler({ fs, rootPid, procRoot = "/proc", cgroupRoot = "/sys/fs/cgroup" }) {
	const read = (file) => {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return null;
		}
	};
	const list = (dir) => {
		try {
			return fs.readdirSync(dir).filter((name) => NUMERIC.test(name));
		} catch {
			return [];
		}
	};
	const cgroupPath = parseCgroupV2Path(read(`${procRoot}/${rootPid}/cgroup`));
	const cgroupDir = cgroupPath ? path.join(cgroupRoot, cgroupPath) : null;
	const roles = new Map();

	const classify = ({ pid, startTimeTicks }) => {
		const key = `${pid}:${startTimeTicks}`;
		const cached = roles.get(key);
		if (cached) return cached;
		const kind = classifyProcess({ argv: parseCmdline(read(`${procRoot}/${pid}/cmdline`)), isRoot: pid === rootPid });
		if (!UNSETTLED_ROLES.has(kind.role)) roles.set(key, kind);
		return kind;
	};

	return {
		cgroupPath,
		/** Every process of the Electron tree: [{ pid, startTimeTicks, role, subtype, ticks, rssKiB }]. */
		sampleProcesses() {
			const stats = list(procRoot)
				.map((name) => parseProcStat(read(`${procRoot}/${name}/stat`)))
				.filter(Boolean);
			const byPid = new Map(stats.map((stat) => [stat.pid, stat]));
			return descendantsOf({ entries: stats.map(({ pid, ppid }) => ({ pid, ppid })), rootPid }).map((pid) => {
				const stat = byPid.get(pid);
				const kind = classify({ pid, startTimeTicks: stat.startTimeTicks });
				return {
					pid,
					startTimeTicks: stat.startTimeTicks,
					role: kind.role,
					subtype: kind.subtype,
					ticks: stat.utimeTicks + stat.stimeTicks,
					rssKiB: parseProcStatus(read(`${procRoot}/${pid}/status`)).vmRssKiB,
				};
			});
		},
		/** The threads of one process: [{ tid, comm, ticks }]. */
		threads({ pid }) {
			return list(`${procRoot}/${pid}/task`)
				.map((tid) => parseProcStat(read(`${procRoot}/${pid}/task/${tid}/stat`)))
				.filter(Boolean)
				.map((stat) => ({ tid: stat.pid, comm: stat.comm, ticks: stat.utimeTicks + stat.stimeTicks }));
		},
		/** MemAvailable and SwapFree of the machine, memory.current of the cgroup (bytes or null). */
		memory() {
			const meminfo = parseMeminfo(read(`${procRoot}/meminfo`));
			const current = cgroupDir ? parseCgroupValue(read(`${cgroupDir}/memory.current`)) : null;
			return {
				memAvailableBytes: meminfo ? meminfo.availableBytes : null,
				swapFreeBytes: meminfo ? meminfo.swapFreeBytes : null,
				cgroupCurrentBytes: typeof current === "number" ? current : null,
			};
		},
		/** The texts of the cgroup's limit files (undefined when absent). */
		cgroupFiles() {
			const text = (name) => (cgroupDir ? (read(`${cgroupDir}/${name}`) ?? undefined) : undefined);
			return { maxText: text("memory.max"), swapMaxText: text("memory.swap.max"), peakText: text("memory.peak"), eventsText: text("memory.events") };
		},
	};
}

module.exports = { createSampler };
