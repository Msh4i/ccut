const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");
const {
	CHANNEL,
	MIN_READ_INTERVAL_MS,
	applyCgroupLimits,
	cgroupAncestry,
	createMemoryInfoReader,
	fromSystemMemoryInfo,
	linuxAppBytes,
	parseCgroupPath,
	parseMeminfo,
	readBoundedText,
	registerSystemMemoryIpc,
	sumAppBytes,
} = require("../system-memory-ipc");
const fsp = require("node:fs/promises");
const os = require("node:os");

// window.ccutSystem.memoryInfo() main side: /proc/meminfo parsing, the fallback, the cgroup v2
// limits (MemoryMax of the scope and its ancestors), the cache (one real read per 500 ms) and the
// IPC handler (trusted sender only, no arguments, null on error).

// Recorded shape of a 16 GB Linux machine with swap (values in kB, like the kernel writes them).
const MEMINFO = [
	"MemTotal:       16039532 kB",
	"MemFree:         1203456 kB",
	"MemAvailable:    6291456 kB",
	"Buffers:          120000 kB",
	"Cached:          4500000 kB",
	"SwapCached:        10240 kB",
	"Active(anon):    5000000 kB",
	"SwapTotal:       8388604 kB",
	"SwapFree:        8000000 kB",
	"Zswap:                 0 kB",
	"HugePages_Total:       0",
	"HugePages_Free:        0",
	"Hugepagesize:       2048 kB",
	"",
].join("\n");

const EXPECTED = {
	totalBytes: 16039532 * 1024,
	availableBytes: 6291456 * 1024,
	swapTotalBytes: 8388604 * 1024,
	swapFreeBytes: 8000000 * 1024,
};

const METRICS = [
	{ pid: 1, type: "Browser", memory: { workingSetSize: 200_000, peakWorkingSetSize: 250_000 } },
	{ pid: 2, type: "Tab", memory: { workingSetSize: 900_000, peakWorkingSetSize: 950_000 } },
	{ pid: 3, type: "GPU", memory: { workingSetSize: 400_000, peakWorkingSetSize: 410_000 } },
];
const METRICS_BYTES = (200_000 + 900_000 + 400_000) * 1024;

// The answer is rounded: system figures DOWN to whole MiB, the app's memory UP (less fingerprinting detail).
const MiB = 1024 ** 2;
const down = (bytes) => Math.floor(bytes / MiB) * MiB;
const up = (bytes) => Math.ceil(bytes / MiB) * MiB;
const ROUNDED = { totalBytes: down(EXPECTED.totalBytes), availableBytes: down(EXPECTED.availableBytes), swapTotalBytes: down(EXPECTED.swapTotalBytes), swapFreeBytes: down(EXPECTED.swapFreeBytes) };

// Linux: Electron 44's app.getAppMetrics() has NO memory key (electron_api_app.cc builds it only
// #if !BUILDFLAG(IS_LINUX)); the pids are what counts. 101 twice: counted once.
const LINUX_METRICS = [{ pid: 101, type: "Browser" }, { pid: 102, type: "Tab" }, { pid: 103, type: "GPU" }, { pid: 101, type: "Browser" }];
const PID_FILES = {
	"/proc/101/smaps_rollup": "55d0a000-7ffd1000 ---p 00000000 00:00 0                          [rollup]\nRss:              300000 kB\nPss:              150000 kB\nPss_Anon:         100000 kB\n",
	// 102: smaps_rollup refused (a sandboxed renderer is not dumpable): VmRSS of status instead
	"/proc/102/status": "Name:\telectron\nVmRSS:\t  900000 kB\nRssAnon:\t 1 kB\n",
	// 103: exited between getAppMetrics() and the read (no files)
};
const LINUX_APP_BYTES = up((150_000 + 900_000) * 1024);
const FALLBACK = { total: 16 * 1024 * 1024, free: 4 * 1024 * 1024, available: 6 * 1024 * 1024, swapTotal: 0, swapFree: 0 };

describe("parseMeminfo", () => {
	test("the four fields of a real /proc/meminfo, kB -> bytes", () => {
		expect(parseMeminfo(MEMINFO)).toEqual(EXPECTED);
	});

	test("CRLF line ends and tabs are accepted", () => {
		expect(parseMeminfo(MEMINFO.replaceAll("\n", "\r\n"))).toEqual(EXPECTED);
		expect(parseMeminfo(MEMINFO.replace("MemTotal:       ", "MemTotal:\t"))).toEqual(EXPECTED);
	});

	test("a missing field (old kernel without MemAvailable, no swap lines) is null, not a guess", () => {
		for (const key of ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"]) {
			const text = MEMINFO.split("\n").filter((line) => !line.startsWith(`${key}:`)).join("\n");
			expect(parseMeminfo(text)).toBeNull();
		}
	});

	test("a machine without swap: zero swap is valid", () => {
		const text = MEMINFO.replace("SwapTotal:       8388604 kB", "SwapTotal:             0 kB").replace("SwapFree:        8000000 kB", "SwapFree:              0 kB");
		expect(parseMeminfo(text)).toEqual({ ...EXPECTED, swapTotalBytes: 0, swapFreeBytes: 0 });
	});

	test("hostile or broken text is null: not a string, empty, huge, wrong unit, negative, fraction, garbage", () => {
		const replaceTotal = (line) => MEMINFO.replace("MemTotal:       16039532 kB", line);
		for (const bad of [
			null,
			undefined,
			42,
			Buffer.from(MEMINFO),
			{ toString: () => MEMINFO },
			"",
			"garbage",
			MEMINFO + "x".repeat(70_000),
			replaceTotal("MemTotal:       16039532 MB"),
			replaceTotal("MemTotal:       16039532 KB"),
			replaceTotal("MemTotal:       16039532 kb"),
			replaceTotal("MemTotal:       16039532"),
			replaceTotal("MemTotal:      -16039532 kB"),
			replaceTotal("MemTotal:       16039532.5 kB"),
			replaceTotal("MemTotal:       1e9 kB"),
			replaceTotal("MemTotal: kB"),
			replaceTotal("MemTotal:       16039532 kB trailing"),
		]) {
			expect(parseMeminfo(bad)).toBeNull();
		}
	});

	test("a value that overflows a safe integer in bytes is null", () => {
		expect(parseMeminfo(MEMINFO.replace("MemTotal:       16039532 kB", "MemTotal:       999999999999999 kB"))).toBeNull();
	});

	test("a duplicated field is refused instead of picking one", () => {
		expect(parseMeminfo(`${MEMINFO}MemAvailable:    1 kB\n`)).toBeNull();
	});

	test("inconsistent figures are refused: available above total, swap free above swap total", () => {
		expect(parseMeminfo(MEMINFO.replace("MemAvailable:    6291456 kB", "MemAvailable:    26291456 kB"))).toBeNull();
		expect(parseMeminfo(MEMINFO.replace("SwapFree:        8000000 kB", "SwapFree:        9000000 kB"))).toBeNull();
	});

	test("look-alike names do not count (prefix, suffix, other case, prototype names)", () => {
		const text = ["XMemTotal: 1 kB", "MemTotalX: 1 kB", "memtotal: 1 kB", "__proto__: 1 kB", "constructor: 1 kB", ...MEMINFO.split("\n").filter((l) => !l.startsWith("MemTotal:"))].join("\n");
		expect(parseMeminfo(text)).toBeNull();
		expect(parseMeminfo(`__proto__: 5 kB\n${MEMINFO}`)).toEqual(EXPECTED);
		// a field name must start the line: these are not fields, so they neither count nor collide
		expect(parseMeminfo(` MemAvailable: 1 kB\nFoo MemTotal: 1 kB\n${MEMINFO}`)).toEqual(EXPECTED);
	});
});

describe("fromSystemMemoryInfo (Electron's process.getSystemMemoryInfo(), kilobytes)", () => {
	test("Linux's 'available' is used when there is one", () => {
		expect(fromSystemMemoryInfo({ total: 1000, free: 100, available: 400, swapTotal: 0, swapFree: 0 })).toEqual({ totalBytes: 1_024_000, availableBytes: 409_600, swapTotalBytes: 0, swapFreeBytes: 0 });
		expect(fromSystemMemoryInfo({ total: 1000, free: 100, available: 4000 })).toBeNull();
		expect(fromSystemMemoryInfo({ total: 1000, free: 100, available: "400" })).toBeNull();
	});

	test("kilobytes -> bytes; without 'available' (Windows, macOS) 'free' is the available figure", () => {
		expect(fromSystemMemoryInfo({ total: 1000, free: 400, swapTotal: 200, swapFree: 50 })).toEqual({
			totalBytes: 1_024_000,
			availableBytes: 409_600,
			swapTotalBytes: 204_800,
			swapFreeBytes: 51_200,
		});
	});

	test("no swap fields (macOS) means zero swap", () => {
		expect(fromSystemMemoryInfo({ total: 1000, free: 400 })).toEqual({ totalBytes: 1_024_000, availableBytes: 409_600, swapTotalBytes: 0, swapFreeBytes: 0 });
	});

	test("anything else is null", () => {
		for (const bad of [null, undefined, 5, "x", {}, { total: 1000 }, { total: -1, free: 0 }, { total: 1000, free: Number.NaN }, { total: 1000, free: 2000 }, { total: 1000, free: 1, swapTotal: 1, swapFree: 2 }, { total: "1000", free: "1" }, { total: 1e300, free: 1 }]) {
			expect(fromSystemMemoryInfo(bad)).toBeNull();
		}
	});
});

describe("sumAppBytes (app.getAppMetrics(), workingSetSize in kilobytes)", () => {
	test("the sum over every process, in bytes", () => {
		expect(sumAppBytes(METRICS)).toBe(METRICS_BYTES);
	});

	test("not a list, an empty list or a process without a valid working set is null", () => {
		for (const bad of [null, undefined, {}, [], [{ pid: 1 }], [{ memory: { workingSetSize: -1 } }], [{ memory: { workingSetSize: "5" } }], [...METRICS, { memory: null }], [{ memory: { workingSetSize: Number.POSITIVE_INFINITY } }]]) {
			expect(sumAppBytes(bad)).toBeNull();
		}
	});
});

const GiB = 1024 ** 3;
const SCOPE = "/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope";
const LEVELS = [SCOPE, "/user.slice/user-1000.slice/user@1000.service/app.slice", "/user.slice/user-1000.slice/user@1000.service", "/user.slice/user-1000.slice", "/user.slice", "/"];
const SYSTEM = { totalBytes: 16 * GiB, availableBytes: 6 * GiB, swapTotalBytes: 8 * GiB, swapFreeBytes: 7 * GiB };
const level = ({ max, current, swapMax, swapCurrent } = {}) => ({ maxText: max, currentText: current, swapMaxText: swapMax, swapCurrentText: swapCurrent });
const unlimited = level({ max: "max\n", current: "123\n", swapMax: "max\n", swapCurrent: "0\n" });

describe("parseCgroupPath (/proc/self/cgroup)", () => {
	test("the cgroup v2 line of a unified or hybrid layout", () => {
		expect(parseCgroupPath(`0::${SCOPE}\n`)).toBe(SCOPE);
		expect(parseCgroupPath("12:memory:/x\n1:name=systemd:/y\n0::/\n")).toBe("/");
		expect(parseCgroupPath("0::/user.slice/app-flatpak-org.x\\x2dy-12.scope\n")).toBe("/user.slice/app-flatpak-org.x\\x2dy-12.scope"); // systemd escapes are plain characters
	});

	test("cgroup v1 only, two v2 lines, or not text: null (fall back)", () => {
		for (const bad of ["4:memory:/x\n1:cpu:/\n", "0::/a\n0::/b\n", "", null, undefined, 42]) expect(parseCgroupPath(bad)).toBeNull();
	});

	test("anything but a clean absolute path is refused: traversal, dot components, relative, empty components, NUL, too deep or long", () => {
		for (const bad of ["0::/a/../b", "0::/..", "0::/../etc", "0::/a/./b", "0::/.", "0::a/b", "0::", "0::/a//b", "0::/a/", "0::/a\0b", "0::\\a", `0::${"/x".repeat(65)}`, `0::/${"x".repeat(5000)}`]) {
			expect(parseCgroupPath(`${bad}\n`)).toBeNull();
		}
	});
});

describe("cgroupAncestry", () => {
	test("the cgroup and every ancestor up to the root", () => {
		expect(cgroupAncestry(SCOPE)).toEqual(LEVELS);
		expect(cgroupAncestry("/")).toEqual(["/"]);
		expect(cgroupAncestry("/a")).toEqual(["/a", "/"]);
	});
});

describe("applyCgroupLimits (pure: the system figures and the cgroup file texts)", () => {
	test("no limit anywhere (all 'max', or the files missing as at the root or on cgroup v1): the system figures", () => {
		expect(applyCgroupLimits({ system: SYSTEM, levels: [unlimited, unlimited, level()] })).toEqual(SYSTEM);
		expect(applyCgroupLimits({ system: SYSTEM, levels: [] })).toEqual(SYSTEM);
	});

	test("the scope's MemoryMax=4G, 1 GiB used: total 4 GiB, available 3 GiB", () => {
		const scope = level({ max: `${4 * GiB}\n`, current: `${1 * GiB}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [scope, unlimited] })).toEqual({ ...SYSTEM, totalBytes: 4 * GiB, availableBytes: 3 * GiB });
	});

	test("an ancestor tighter than the scope wins, for the total and for the headroom", () => {
		const scope = level({ max: `${4 * GiB}\n`, current: `${1 * GiB}\n` });
		const slice = level({ max: `${2 * GiB}\n`, current: `${1.5 * GiB}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [scope, slice, level()] })).toEqual({ ...SYSTEM, totalBytes: 2 * GiB, availableBytes: 0.5 * GiB });
	});

	test("the headroom of a looser level can still be the smaller one (its siblings use memory too)", () => {
		const scope = level({ max: `${2 * GiB}\n`, current: `${0.5 * GiB}\n` });
		const slice = level({ max: `${4 * GiB}\n`, current: `${3.5 * GiB}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [scope, slice] })).toEqual({ ...SYSTEM, totalBytes: 2 * GiB, availableBytes: 0.5 * GiB });
	});

	test("MemAvailable below the headroom stays (the machine is the tighter limit)", () => {
		const scope = level({ max: `${12 * GiB}\n`, current: `${1 * GiB}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [scope] })).toEqual({ ...SYSTEM, totalBytes: 12 * GiB, availableBytes: 6 * GiB });
	});

	test("current above max (the kernel lets it overshoot briefly): available 0, not negative", () => {
		const scope = level({ max: `${4 * GiB}\n`, current: `${4 * GiB + 4096}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [scope] })).toEqual({ ...SYSTEM, totalBytes: 4 * GiB, availableBytes: 0 });
	});

	test("MemorySwapMax=0: no swap at all; a swap limit elsewhere caps total and free swap", () => {
		const noSwap = level({ max: "max\n", current: "1\n", swapMax: "0\n", swapCurrent: "0\n" });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [noSwap] })).toEqual({ ...SYSTEM, swapTotalBytes: 0, swapFreeBytes: 0 });
		const someSwap = level({ swapMax: `${1 * GiB}\n`, swapCurrent: `${0.25 * GiB}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [someSwap] })).toEqual({ ...SYSTEM, swapTotalBytes: 1 * GiB, swapFreeBytes: 0.75 * GiB });
		const overSwap = level({ swapMax: `${1 * GiB}\n`, swapCurrent: `${2 * GiB}\n` });
		expect(applyCgroupLimits({ system: SYSTEM, levels: [overSwap] }).swapFreeBytes).toBe(0);
	});

	test("a limit beyond a safe integer (8 PiB) is no limit", () => {
		expect(applyCgroupLimits({ system: SYSTEM, levels: [level({ max: "9223372036854771712\n", current: "5\n" })] })).toEqual(SYSTEM);
	});

	test("garbage in a limit or in the usage of a limited level: null (never a guess that could overshoot the cap)", () => {
		for (const bad of [
			level({ max: "4G\n", current: "1\n" }),
			level({ max: "-5\n", current: "1\n" }),
			level({ max: "", current: "1\n" }),
			level({ max: `${GiB}\n`, current: "lots\n" }),
			level({ max: `${GiB}\n` }),
			level({ swapMax: "zero\n" }),
			level({ swapMax: `${GiB}\n`, swapCurrent: undefined }),
		]) {
			expect(applyCgroupLimits({ system: SYSTEM, levels: [bad] })).toBeNull();
		}
		// usage of an unlimited level is never needed
		expect(applyCgroupLimits({ system: SYSTEM, levels: [level({ max: "max\n", current: "garbage" })] })).toEqual(SYSTEM);
	});
});

const CGROUP_DIR = `/sys/fs/cgroup${SCOPE}`;
const SCOPE_FILES = {
	"/proc/self/cgroup": `0::${SCOPE}\n`,
	[`${CGROUP_DIR}/memory.max`]: `${4 * GiB}\n`,
	[`${CGROUP_DIR}/memory.current`]: `${1 * GiB}\n`,
	[`${CGROUP_DIR}/memory.swap.max`]: "0\n",
	[`${CGROUP_DIR}/memory.swap.current`]: "0\n",
	"/sys/fs/cgroup/user.slice/memory.max": "max\n",
	"/sys/fs/cgroup/user.slice/memory.current": `${3 * GiB}\n`,
};

function makeReader({ platform = "linux", files = {}, meminfo = MEMINFO, system = FALLBACK, metrics = platform === "linux" ? LINUX_METRICS : METRICS, pidFiles = PID_FILES, clock } = {}) {
	const calls = { readFile: [], getSystemMemoryInfo: 0, getAppMetrics: 0 };
	const logs = [];
	const time = clock ?? { now: 0 };
	const all = { ...pidFiles, ...files, ...(meminfo instanceof Error ? {} : { "/proc/meminfo": meminfo }) };
	const reader = createMemoryInfoReader({
		platform,
		readFile: async (file) => {
			calls.readFile.push(file);
			if (file === "/proc/meminfo" && meminfo instanceof Error) throw meminfo;
			if (!Object.hasOwn(all, file)) throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: "ENOENT" });
			return all[file];
		},
		getSystemMemoryInfo: () => {
			calls.getSystemMemoryInfo += 1;
			if (system instanceof Error) throw system;
			return system;
		},
		getAppMetrics: () => {
			calls.getAppMetrics += 1;
			if (metrics instanceof Error) throw metrics;
			return metrics;
		},
		now: () => time.now,
		log: (line) => logs.push(line),
	});
	const reads = (file) => calls.readFile.filter((entry) => entry === file).length;
	return { reader, calls, logs, time, reads };
}

describe("createMemoryInfoReader", () => {
	test("rendererDataBytes: VmData of the window's renderer on Linux, left out when it cannot be read", async () => {
		const status = "Name:\tchrome\nVmData:\t 8590000 kB\nVmRSS:\t 1000 kB\n";
		const make = (getRendererPid, files = {}) =>
			createMemoryInfoReader({
				platform: "linux",
				readFile: async (file) => {
					if (file === "/proc/meminfo") return MEMINFO;
					if (Object.hasOwn(files, file)) return files[file];
					if (Object.hasOwn(PID_FILES, file)) return PID_FILES[file];
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				},
				getSystemMemoryInfo: () => FALLBACK,
				getAppMetrics: () => LINUX_METRICS,
				getRendererPid,
				now: () => 0,
				log: () => {},
			});
		expect((await make(() => 4242, { "/proc/4242/status": status }).read()).rendererDataBytes).toBe(up(8590000 * 1024));
		expect((await make(() => 4242).read()).rendererDataBytes).toBeUndefined();
		expect((await make(() => -1, { "/proc/-1/status": status }).read()).rendererDataBytes).toBeUndefined();
		expect((await make(() => { throw new Error("gone"); }).read()).rendererDataBytes).toBeUndefined();
	});

	test("Linux without a cgroup v2 path: /proc/meminfo plus the app's processes from /proc, exactly the five fields", async () => {
		const { reader, calls } = makeReader();
		const info = await reader.read();
		expect(info).toStrictEqual({ ...ROUNDED, appBytes: LINUX_APP_BYTES });
		expect(Object.keys(info)).toEqual(["totalBytes", "availableBytes", "swapTotalBytes", "swapFreeBytes", "appBytes"]);
		expect(calls.readFile.slice(0, 2)).toEqual(["/proc/meminfo", "/proc/self/cgroup"]);
		expect(calls.readFile.slice(2).sort()).toEqual(["/proc/101/smaps_rollup", "/proc/102/smaps_rollup", "/proc/102/status", "/proc/103/smaps_rollup", "/proc/103/status"]);
		expect(calls.getAppMetrics).toBe(1);
	});

	test("every figure is a whole MiB: the system ones rounded down, the app's up", async () => {
		const info = await makeReader().reader.read();
		for (const value of Object.values(info)) expect(value % MiB).toBe(0);
		expect(info.totalBytes).toBeLessThan(EXPECTED.totalBytes);
		expect(info.appBytes).toBeGreaterThan((150_000 + 900_000) * 1024);
		const tiny = await makeReader({ pidFiles: { "/proc/101/status": "VmRSS:\t 1 kB\n" } }).reader.read();
		expect(tiny.appBytes).toBe(MiB);
	});

	test("Linux uses /proc even if a future Electron adds memory to the metrics", async () => {
		const withMemory = LINUX_METRICS.map((metric) => ({ ...metric, memory: { workingSetSize: 1 } }));
		expect((await makeReader({ metrics: withMemory }).reader.read()).appBytes).toBe(LINUX_APP_BYTES);
	});

	test("Linux in a capped scope: the scope's limit and headroom, every ancestor read, nothing outside /proc and /sys/fs/cgroup", async () => {
		const { reader, calls } = makeReader({ files: SCOPE_FILES });
		expect(await reader.read()).toStrictEqual({ totalBytes: 4 * GiB, availableBytes: 3 * GiB, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: LINUX_APP_BYTES });
		for (const dir of LEVELS) {
			for (const name of ["memory.max", "memory.current", "memory.swap.max", "memory.swap.current"]) expect(calls.readFile).toContain(`${dir === "/" ? "/sys/fs/cgroup" : `/sys/fs/cgroup${dir}`}/${name}`);
		}
		for (const file of calls.readFile) expect(file === "/proc/meminfo" || file === "/proc/self/cgroup" || file.startsWith("/sys/fs/cgroup/") || /^\/proc\/\d+\/(smaps_rollup|status)$/.test(file)).toBe(true);
	});

	test("cgroup v1, a container without the files, or a refused path: today's numbers, and no cgroup file read for a refused path", async () => {
		for (const cgroupText of ["4:memory:/x\n0::/\n", "0::/a/../../etc\n", "0::relative\n"]) {
			const { reader, calls } = makeReader({ files: { "/proc/self/cgroup": cgroupText } });
			expect(await reader.read()).toStrictEqual({ ...ROUNDED, appBytes: LINUX_APP_BYTES });
			for (const file of calls.readFile) expect(file.includes("..")).toBe(false);
			if (cgroupText !== "4:memory:/x\n0::/\n") expect(calls.readFile.some((file) => file.startsWith("/sys/"))).toBe(false);
		}
	});

	test("garbage in the cgroup's limit file: null, logged once with the source named", async () => {
		const { reader, logs } = makeReader({ files: { ...SCOPE_FILES, [`${CGROUP_DIR}/memory.max`]: "four gigs\n" } });
		expect(await reader.read()).toBeNull();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("cgroup");
	});

	test("other platforms: process.getSystemMemoryInfo(), neither /proc nor /sys is read", async () => {
		const { reader, calls } = makeReader({ platform: "win32", files: SCOPE_FILES, system: { total: 16 * 1024 * 1024, free: 4 * 1024 * 1024, swapTotal: 0, swapFree: 0 } });
		expect(await reader.read()).toStrictEqual({ totalBytes: 16 * GiB, availableBytes: 4 * GiB, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: up(METRICS_BYTES) });
		expect(calls.readFile).toEqual([]);
	});

	test("Linux with an unreadable or unparsable /proc/meminfo falls back to getSystemMemoryInfo(), the cgroup limits still apply", async () => {
		for (const meminfo of [new Error("EACCES /proc/meminfo"), "garbage"]) {
			const { reader, calls } = makeReader({ meminfo });
			expect(await reader.read()).toStrictEqual({ totalBytes: 16 * GiB, availableBytes: 6 * GiB, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: LINUX_APP_BYTES });
			expect(calls.getSystemMemoryInfo).toBe(1);
		}
		const capped = makeReader({ meminfo: "garbage", system: { total: 16 * 1024 * 1024, free: 6 * 1024 * 1024 }, files: SCOPE_FILES });
		expect(await capped.reader.read()).toMatchObject({ totalBytes: 4 * GiB, availableBytes: 3 * GiB });
	});

	test("one real read per 500 ms: calls inside the window get the cached figures (a copy)", async () => {
		const { reader, reads, time } = makeReader({ files: SCOPE_FILES });
		const first = await reader.read();
		time.now = MIN_READ_INTERVAL_MS - 1;
		const second = await reader.read();
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		second.totalBytes = 1;
		expect((await reader.read()).totalBytes).toBe(4 * GiB);
		expect(reads("/proc/meminfo")).toBe(1);
		expect(reads(`${CGROUP_DIR}/memory.max`)).toBe(1);
		time.now = MIN_READ_INTERVAL_MS;
		await reader.read();
		expect(reads("/proc/meminfo")).toBe(2);
	});

	test("1000 calls at once cost one read: the calls during a read share it (a hostile page cannot spin the main process)", async () => {
		const { reader, calls, reads } = makeReader({ files: SCOPE_FILES });
		const answers = await Promise.all(Array.from({ length: 1000 }, () => reader.read()));
		expect(new Set(answers.map((answer) => answer.availableBytes))).toEqual(new Set([3 * GiB]));
		expect(reads("/proc/meminfo")).toBe(1);
		expect(reads("/proc/self/cgroup")).toBe(1);
		expect(calls.getAppMetrics).toBe(1);
		expect(calls.readFile.length).toBe(2 + LEVELS.length * 4 + 5);
	});

	test("a clock that goes backwards does not freeze the cache", async () => {
		const { reader, reads, time } = makeReader();
		time.now = 10_000;
		await reader.read();
		time.now = 5_000;
		await reader.read();
		expect(reads("/proc/meminfo")).toBe(2);
	});

	test("any failure is null, cached for the window too, and logged once without reaching the caller", async () => {
		const { reader, calls, logs, time } = makeReader({ metrics: new Error("boom /secret/path") });
		expect(await reader.read()).toBeNull();
		expect(await reader.read()).toBeNull();
		expect(calls.getAppMetrics).toBe(1);
		time.now = 10_000;
		expect(await reader.read()).toBeNull();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("boom");
	});

	test("unusable figures are null, and the log names the source", async () => {
		const noSystem = makeReader({ meminfo: "garbage", system: { total: 1 } });
		expect(await noSystem.reader.read()).toBeNull();
		expect(noSystem.logs[0]).toContain("system");
		expect(await makeReader({ meminfo: "garbage", system: new Error("x") }).reader.read()).toBeNull();
		const noApp = makeReader({ metrics: [] });
		expect(await noApp.reader.read()).toBeNull();
		expect(noApp.logs[0]).toContain("app");
		expect(await makeReader({ pidFiles: {} }).reader.read()).toBeNull(); // every process gone: no figure
	});
});

describe("linuxAppBytes (pids of app.getAppMetrics(), memory from /proc/<pid>)", () => {
	const readerOf = (files) => {
		const read = [];
		return {
			read,
			readText: async (file) => {
				read.push(file);
				return Object.hasOwn(files, file) ? files[file] : null;
			},
		};
	};

	test("Pss of smaps_rollup, else VmRSS of status; exited processes skipped; each pid once", async () => {
		const { readText } = readerOf(PID_FILES);
		expect(await linuxAppBytes({ metrics: LINUX_METRICS, readText })).toBe((150_000 + 900_000) * 1024);
	});

	test("only Pss itself counts, not Pss_Anon / Pss_File (falls back to VmRSS)", async () => {
		const { readText } = readerOf({ "/proc/7/smaps_rollup": "Pss_Anon:  5 kB\nPss_File:  6 kB\n", "/proc/7/status": "VmRSS:\t 9 kB\n" });
		expect(await linuxAppBytes({ metrics: [{ pid: 7 }], readText })).toBe(9 * 1024);
	});

	test("a pid that is not a positive safe integer refuses the whole figure and no path is built from it", async () => {
		for (const pid of [0, -1, 1.5, "101", "../1", Number.MAX_SAFE_INTEGER + 1, Number.NaN, null, undefined]) {
			const { readText, read } = readerOf(PID_FILES);
			expect(await linuxAppBytes({ metrics: [{ pid: 101 }, { pid }], readText })).toBeNull();
			expect(read).toEqual([]);
		}
		expect(await linuxAppBytes({ metrics: [null], readText: readerOf({}).readText })).toBeNull();
	});

	test("not a list, empty, or more than 256 processes: null without a read", async () => {
		const { readText, read } = readerOf(PID_FILES);
		for (const metrics of [null, {}, [], Array.from({ length: 257 }, (_, i) => ({ pid: i + 1 }))]) expect(await linuxAppBytes({ metrics, readText })).toBeNull();
		expect(read).toEqual([]);
	});
});

describe("readBoundedText (procfs/sysfs files read into a fixed buffer)", () => {
	test("reads a real file whole, and exactly at the limit", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-Ph-bounded-"));
		try {
			const file = path.join(dir, "f");
			await fsp.writeFile(file, "MemTotal: 1 kB\n");
			expect(await readBoundedText({ fsp, file })).toBe("MemTotal: 1 kB\n");
			await fsp.writeFile(file, "x".repeat(32));
			expect(await readBoundedText({ fsp, file, maxBytes: 32 })).toBe("x".repeat(32));
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test("a file over the limit is refused; a missing file rejects", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-Ph-bounded-"));
		try {
			const file = path.join(dir, "f");
			await fsp.writeFile(file, "x".repeat(33));
			let message = "resolved";
			await readBoundedText({ fsp, file, maxBytes: 32 }).catch((error) => (message = error.message));
			expect(message).toContain("more than 32 bytes");
			let missing = "resolved";
			await readBoundedText({ fsp, file: path.join(dir, "nope") }).catch((error) => (missing = error.code));
			expect(missing).toBe("ENOENT");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test("short reads (procfs hands out pieces) are joined until the end; the handle is closed, also on refusal", async () => {
		const content = Buffer.from("Pss:   1234 kB\nVmRSS:  99 kB\n");
		let closed = 0;
		const fakeFsp = () => {
			let offset = 0;
			return {
				open: async () => ({
					read: async (buffer, at, length) => {
						const bytesRead = Math.min(3, length, content.length - offset);
						content.copy(buffer, at, offset, offset + bytesRead);
						offset += bytesRead;
						return { bytesRead };
					},
					close: async () => (closed += 1),
				}),
			};
		};
		expect(await readBoundedText({ fsp: fakeFsp(), file: "/proc/1/status" })).toBe(content.toString());
		expect(closed).toBe(1);
		let message = "resolved";
		await readBoundedText({ fsp: fakeFsp(), file: "/proc/1/status", maxBytes: 10 }).catch((error) => (message = error.message));
		expect(message).toContain("more than 10 bytes");
		expect(closed).toBe(2);
	});
});

const ORIGIN = "ccut://app";

function setupIpc({ metrics = LINUX_METRICS } = {}) {
	const handlers = new Map();
	const mainFrame = { url: `${ORIGIN}/editor/1` };
	const webContents = { id: 3, mainFrame };
	let destroyed = false;
	const win = { webContents, isDestroyed: () => destroyed };
	const calls = { readFile: 0 };
	const time = { now: 0 };
	const files = { ...PID_FILES, ...SCOPE_FILES, "/proc/meminfo": MEMINFO };
	const registered = registerSystemMemoryIpc({
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		getWindow: () => win,
		origin: ORIGIN,
		platform: "linux",
		readFile: async (file) => {
			calls.readFile += 1;
			if (!Object.hasOwn(files, file)) throw new Error(`ENOENT ${file}`);
			return files[file];
		},
		getSystemMemoryInfo: () => ({ total: 1000, free: 400 }),
		getAppMetrics: () => metrics,
		now: () => time.now,
		log: () => {},
	});
	const trusted = { sender: webContents, senderFrame: mainFrame };
	return { handlers, handler: handlers.get(CHANNEL), trusted, webContents, calls, time, registered, destroy: () => (destroyed = true) };
}

const CAPPED = { totalBytes: 4 * GiB, availableBytes: 3 * GiB, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: LINUX_APP_BYTES };

describe("registerSystemMemoryIpc", () => {
	test("exactly one channel, ccut-system:memory-info", () => {
		const { handlers } = setupIpc();
		expect([...handlers.keys()]).toEqual(["ccut-system:memory-info"]);
		expect(CHANNEL).toBe("ccut-system:memory-info");
	});

	test("the app's main frame gets the five numbers (cgroup-aware)", async () => {
		const { handler, trusted } = setupIpc();
		expect(await handler(trusted)).toStrictEqual(CAPPED);
	});

	test("a sub-frame, another webContents, another origin or a closed window gets null, and nothing is read", async () => {
		const { handler, webContents, calls, destroy } = setupIpc();
		for (const event of [
			{ sender: webContents, senderFrame: { url: `${ORIGIN}/x` } },
			{ sender: {}, senderFrame: webContents.mainFrame },
			{ sender: webContents, senderFrame: null },
			null,
			undefined,
		]) {
			expect(await handler(event)).toBeNull();
		}
		webContents.mainFrame.url = "https://evil.example/";
		expect(await handler({ sender: webContents, senderFrame: webContents.mainFrame })).toBeNull();
		webContents.mainFrame.url = `${ORIGIN}/editor/1`;
		destroy();
		expect(await handler({ sender: webContents, senderFrame: webContents.mainFrame })).toBeNull();
		expect(calls.readFile).toBe(0);
	});

	test("arguments are refused: any argument at all answers null without a read", async () => {
		const { handler, trusted, calls } = setupIpc();
		for (const args of [[undefined], [null], ["/etc/passwd"], [{ path: "/etc/passwd" }], [1, 2], ["x".repeat(10_000)]]) {
			expect(await handler(trusted, ...args)).toBeNull();
		}
		expect(calls.readFile).toBe(0);
		expect(await handler(trusted)).toStrictEqual(CAPPED);
	});

	test("the answer never carries an error text or a path, only numbers or null", async () => {
		const { handler, trusted } = setupIpc({ metrics: "not a list" });
		expect(await handler(trusted)).toBeNull();
		const ok = setupIpc();
		const info = await ok.handler(ok.trusted);
		for (const value of Object.values(info)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
	});

	test("calls through the IPC share the 500 ms cache", async () => {
		const { handler, trusted, calls, time } = setupIpc();
		await handler(trusted);
		const perRead = calls.readFile;
		await handler(trusted);
		expect(calls.readFile).toBe(perRead);
		time.now = MIN_READ_INTERVAL_MS;
		await handler(trusted);
		expect(calls.readFile).toBe(2 * perRead);
	});
});

describe("wiring", () => {
	const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");

	test("main.js registers the handler once with the window getter, the app origin, async file reads and Electron's own memory APIs", () => {
		expect([...main.matchAll(/registerSystemMemoryIpc\(\{/g)]).toHaveLength(1);
		const block = main.slice(main.indexOf("registerSystemMemoryIpc({"), main.indexOf("});", main.indexOf("registerSystemMemoryIpc({")));
		expect(block).toContain("getWindow: () => win");
		expect(block).toContain("origin: ORIGIN");
		expect(block).toContain("readFile: (file) => readBoundedText({ fsp, file })");
		expect(main).toMatch(/^const \{ readBoundedText, registerSystemMemoryIpc \} = require\("\.\/system-memory-ipc"\);$/m);
		expect(block).not.toContain("readFileSync");
		expect(block).toContain("process.getSystemMemoryInfo()");
		expect(block).toContain("app.getAppMetrics()");
	});

	test("the packaged app ships the module", () => {
		const { build } = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
		expect(build.files).toContain("system-memory-ipc.js");
	});
});
