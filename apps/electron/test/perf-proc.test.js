const { describe, expect, test } = require("bun:test");
const {
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
} = require("./perf/proc");

// /proc parsing and process-tree classification of the playback harness, on recorded text
// (the format of Linux 6.x: proc(5)).

// Recorded from a shell on Linux 6.18 (`cat /proc/self/stat`), utime/stime/start time edited.
const STAT = "27996 (cat) R 27995 27996 27995 0 -1 4194304 82 0 0 0 1234 567 0 0 20 0 7 0 185971 2920448 365 18446744073709551615 93959008165888 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0\n";

describe("parseProcStat", () => {
	test("pid, comm, state, ppid, utime, stime, threads and start time (fields 1-4, 14, 15, 20, 22)", () => {
		expect(parseProcStat(STAT)).toEqual({ pid: 27996, comm: "cat", state: "R", ppid: 27995, utimeTicks: 1234, stimeTicks: 567, numThreads: 7, startTimeTicks: 185971 });
	});

	test("a comm with spaces and parentheses (Chromium thread names, hostile names) is cut at the LAST ')'", () => {
		const stat = STAT.replace("(cat)", "(Web Content) R (x)");
		expect(parseProcStat(stat)).toMatchObject({ pid: 27996, comm: "Web Content) R (x", state: "R", ppid: 27995, utimeTicks: 1234 });
	});

	test("broken text is null", () => {
		for (const bad of [null, "", "garbage", "12 (x", "x (cat) R 1 2", "12 (cat) R", STAT.replace(" 1234 ", " -5 "), STAT.replace(" 27995 27996", " abc 27996"), "0 (cat) R 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 5"]) {
			expect(parseProcStat(bad)).toBeNull();
		}
	});
});

describe("parseProcStatus", () => {
	test("VmRSS and its anon / file / shmem parts in KiB", () => {
		const text = "Name:\tgrep\nPPid:\t27995\nVmRSS:\t    1960 kB\nRssAnon:\t     168 kB\nRssFile:\t    1792 kB\nRssShmem:\t       0 kB\nThreads:\t1\n";
		expect(parseProcStatus(text)).toEqual({ vmRssKiB: 1960, rssAnonKiB: 168, rssFileKiB: 1792, rssShmemKiB: 0 });
	});

	test("a kernel thread or zombie without VmRSS: nulls", () => {
		expect(parseProcStatus("Name:\tkworker\nState:\tZ (zombie)\n")).toEqual({ vmRssKiB: null, rssAnonKiB: null, rssFileKiB: null, rssShmemKiB: null });
		expect(parseProcStatus(null)).toEqual({ vmRssKiB: null, rssAnonKiB: null, rssFileKiB: null, rssShmemKiB: null });
		expect(parseProcStatus("VmRSS:\t 5 MB\n").vmRssKiB).toBeNull(); // only kB lines are KiB
	});
});

describe("parseCmdline", () => {
	test("NUL-separated, the trailing NUL dropped", () => {
		expect(parseCmdline("/opt/electron\0--type=renderer\0--lang=en-US\0")).toEqual(["/opt/electron", "--type=renderer", "--lang=en-US"]);
		expect(parseCmdline("")).toEqual([]);
		expect(parseCmdline(undefined)).toEqual([]);
	});
});

describe("classifyProcess", () => {
	const argv = (...args) => ["/home/u/node_modules/electron/dist/electron", ...args];

	test("the root of the tree is the browser (main) process", () => {
		expect(classifyProcess({ argv: argv("/home/u/apps/electron", "--remote-debugging-port=9222"), isRoot: true })).toEqual({ role: "browser", subtype: null });
	});

	test("Chromium --type= values, utility sub-types kept", () => {
		expect(classifyProcess({ argv: argv("--type=renderer", "--renderer-client-id=5"), isRoot: false })).toEqual({ role: "renderer", subtype: null });
		expect(classifyProcess({ argv: argv("--type=gpu-process", "--ozone-platform=wayland"), isRoot: false })).toEqual({ role: "gpu", subtype: null });
		expect(classifyProcess({ argv: argv("--type=utility", "--utility-sub-type=network.mojom.NetworkService", "--lang=en-US"), isRoot: false })).toEqual({ role: "utility", subtype: "network.mojom.NetworkService" });
		expect(classifyProcess({ argv: argv("--type=utility", "--utility-sub-type=node.mojom.NodeService"), isRoot: false })).toEqual({ role: "utility", subtype: "node.mojom.NodeService" });
		expect(classifyProcess({ argv: argv("--type=zygote", "--no-zygote-sandbox"), isRoot: false })).toEqual({ role: "zygote", subtype: null });
		expect(classifyProcess({ argv: argv("--type=broker"), isRoot: false })).toEqual({ role: "other", subtype: "broker" });
	});

	test("crashpad and anything else", () => {
		expect(classifyProcess({ argv: ["/x/chrome_crashpad_handler", "--monitor-self"], isRoot: false })).toEqual({ role: "crashpad", subtype: null });
		expect(classifyProcess({ argv: ["/usr/bin/sh", "-c", "x"], isRoot: false })).toEqual({ role: "other", subtype: null });
		expect(classifyProcess({ argv: [], isRoot: false })).toEqual({ role: "other", subtype: null });
	});

	test("a --type= that is a later argument's value does not fool it: the first --type= wins", () => {
		expect(classifyProcess({ argv: argv("--type=renderer", "--type=gpu-process"), isRoot: false }).role).toBe("renderer");
	});

	test("roleKey joins utility sub-types", () => {
		expect(roleKey({ role: "utility", subtype: "audio.mojom.AudioService" })).toBe("utility:audio.mojom.AudioService");
		expect(roleKey({ role: "utility", subtype: null })).toBe("utility");
		expect(roleKey({ role: "gpu", subtype: null })).toBe("gpu");
		expect(roleKey({ role: "other", subtype: "broker" })).toBe("other");
	});
});

describe("descendantsOf", () => {
	test("the root and every process below it (zygote children included), nothing else", () => {
		const entries = [
			{ pid: 1, ppid: 0 },
			{ pid: 100, ppid: 1 },
			{ pid: 200, ppid: 100 },
			{ pid: 201, ppid: 100 },
			{ pid: 300, ppid: 201 },
			{ pid: 301, ppid: 300 },
			{ pid: 400, ppid: 1 },
		];
		expect(descendantsOf({ entries, rootPid: 100 }).sort((a, b) => a - b)).toEqual([100, 200, 201, 300, 301]);
	});

	test("a root that is gone gives an empty list; a ppid cycle cannot loop", () => {
		expect(descendantsOf({ entries: [{ pid: 2, ppid: 1 }], rootPid: 9 })).toEqual([]);
		const cyclic = [
			{ pid: 5, ppid: 6 },
			{ pid: 6, ppid: 5 },
		];
		expect(descendantsOf({ entries: cyclic, rootPid: 5 }).sort()).toEqual([5, 6]);
	});
});

describe("cpuPercent", () => {
	test("tick delta / CLK_TCK over wall time; 100 = one core", () => {
		expect(cpuPercent({ beforeTicks: 1000, afterTicks: 1050, elapsedMs: 500, clkTck: 100 })).toBeCloseTo(100, 9);
		expect(cpuPercent({ beforeTicks: 0, afterTicks: 300, elapsedMs: 1000, clkTck: 100 })).toBeCloseTo(300, 9);
		expect(cpuPercent({ beforeTicks: 0, afterTicks: 25, elapsedMs: 1000, clkTck: 250 })).toBeCloseTo(10, 9);
	});

	test("no time, ticks going backwards (pid reused) or bad numbers: null", () => {
		expect(cpuPercent({ beforeTicks: 0, afterTicks: 5, elapsedMs: 0, clkTck: 100 })).toBeNull();
		expect(cpuPercent({ beforeTicks: 10, afterTicks: 5, elapsedMs: 500, clkTck: 100 })).toBeNull();
		expect(cpuPercent({ beforeTicks: 0, afterTicks: 5, elapsedMs: 500, clkTck: 0 })).toBeNull();
		expect(cpuPercent({ beforeTicks: null, afterTicks: 5, elapsedMs: 500, clkTck: 100 })).toBeNull();
	});
});

describe("small parsers", () => {
	test("getconf CLK_TCK output", () => {
		expect(parseClkTck("100\n")).toBe(100);
		expect(parseClkTck("250")).toBe(250);
		for (const bad of ["", "0", "-1", "abc", "1.5", null]) expect(parseClkTck(bad)).toBeNull();
	});

	test("cgroup v2 path from /proc/<pid>/cgroup (unified or hybrid)", () => {
		expect(parseCgroupV2Path("0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1a2.scope\n")).toBe("/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1a2.scope");
		expect(parseCgroupV2Path("9:name=systemd:/\n4:memory:/x\n0::/\n")).toBe("/");
		expect(parseCgroupV2Path("4:memory:/x\n")).toBeNull();
		expect(parseCgroupV2Path("0::/../../etc\n")).toBeNull();
		expect(parseCgroupV2Path(null)).toBeNull();
	});

	test("cgroup values: a number, 'max' or null", () => {
		expect(parseCgroupValue("4294967296\n")).toBe(4294967296);
		expect(parseCgroupValue("max\n")).toBe("max");
		expect(parseCgroupValue("x")).toBeNull();
		expect(parseCgroupValue(undefined)).toBeNull();
	});

	test("flat keyed files (memory.events)", () => {
		expect(parseFlatKeyed("low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n")).toEqual({ low: 0, high: 0, max: 12, oom: 1, oom_kill: 1, oom_group_kill: 0 });
		expect(parseFlatKeyed("x y\n\n")).toEqual({});
		expect(parseFlatKeyed(null)).toEqual({});
	});
});

describe("topThreadsByName", () => {
	test("CPU per thread name between two snapshots, threads of one name summed, busiest first; a thread born in between counts from 0", () => {
		const before = [
			{ tid: 1, comm: "CrRendererMain", ticks: 100 },
			{ tid: 2, comm: "ThreadPoolForeg", ticks: 10 },
			{ tid: 3, comm: "ThreadPoolForeg", ticks: 20 },
			{ tid: 4, comm: "Media", ticks: 0 },
			{ tid: 9, comm: "gone", ticks: 50 },
		];
		const after = [
			{ tid: 1, comm: "CrRendererMain", ticks: 150 },
			{ tid: 2, comm: "ThreadPoolForeg", ticks: 40 },
			{ tid: 3, comm: "ThreadPoolForeg", ticks: 50 },
			{ tid: 4, comm: "Media", ticks: 5 },
			{ tid: 5, comm: "new", ticks: 80 },
		];
		const top = topThreadsByName({ before, after, elapsedMs: 1000, clkTck: 100, limit: 4 });
		expect(top).toEqual([
			{ name: "new", threads: 1, cpuPercent: 80 },
			{ name: "ThreadPoolForeg", threads: 2, cpuPercent: 60 },
			{ name: "CrRendererMain", threads: 1, cpuPercent: 50 },
			{ name: "Media", threads: 1, cpuPercent: 5 },
		]);
		expect(topThreadsByName({ before, after, elapsedMs: 1000, clkTck: 100, limit: 1 })).toHaveLength(1);
	});

	test("a thread id reused under another name, or with fewer ticks, is a new thread", () => {
		const before = [{ tid: 7, comm: "Old", ticks: 500 }];
		expect(topThreadsByName({ before, after: [{ tid: 7, comm: "Fresh", ticks: 20 }], elapsedMs: 1000, clkTck: 100, limit: 5 })).toEqual([{ name: "Fresh", threads: 1, cpuPercent: 20 }]);
		expect(topThreadsByName({ before, after: [{ tid: 7, comm: "Old", ticks: 30 }], elapsedMs: 1000, clkTck: 100, limit: 5 })).toEqual([{ name: "Old", threads: 1, cpuPercent: 30 }]);
		const few = [{ tid: 8, comm: "Old", ticks: 10 }];
		expect(topThreadsByName({ before: few, after: [{ tid: 8, comm: "Fresh", ticks: 30 }], elapsedMs: 1000, clkTck: 100, limit: 5 })).toEqual([{ name: "Fresh", threads: 1, cpuPercent: 30 }]);
	});
});
