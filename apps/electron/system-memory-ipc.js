// window.ccutSystem.memoryInfo() (adaptive frame cache, playback P4): ONE channel that answers
// five numbers or null. Contract with the renderer:
//   memoryInfo(): Promise<{ totalBytes, availableBytes, swapTotalBytes, swapFreeBytes, appBytes, rendererDataBytes? } | null>
// `rendererDataBytes` (the window's renderer process, writable private memory) is absent when it cannot be read.
// Only the app's own main frame is answered; the request carries no argument (one that does is
// refused); figures are read at most once per MIN_READ_INTERVAL_MS (everything in between, and
// every call while a read runs, gets the same result), so a hostile page cannot spin the main
// process; any failure is null and is logged here, never sent (an error text could name a path).
// On Linux the figures are cgroup-aware (v2): inside a scope or slice with MemoryMax (systemd-run
// -p MemoryMax=4G, a user slice limit) total and available are what the app may really use; the
// app's own memory comes from /proc/<pid> (Electron gives no memory figures on Linux). Answers are
// rounded to whole MiB (system figures down, the app's own memory up) to give a hostile page less detail.
const { isTrustedSender } = require("./export-files");

const CHANNEL = "ccut-system:memory-info";
const MIN_READ_INTERVAL_MS = 500;
const MEMINFO_PATH = "/proc/meminfo";
const SELF_CGROUP_PATH = "/proc/self/cgroup";
const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_FILES = ["memory.max", "memory.current", "memory.swap.max", "memory.swap.current"];
const PROC_ROOT = "/proc";
const MAX_READ_BYTES = 64 * 1024; // every file read here is a few KB
const MAX_READ_CHUNKS = 1024;
const MAX_APP_PROCESSES = 256;
const MiB = 1024 * 1024;
const KIB_LINE = /^([A-Za-z_]+):[ \t]+(\d{1,15}) kB$/;
const MAX_CGROUP_PATH_CHARS = 4096;
const MAX_CGROUP_DEPTH = 64;
const CGROUP_NUMBER = /^\d{1,20}$/;
const MAX_MEMINFO_CHARS = 64 * 1024; // the real file is about 1.5 KB
const KIB = 1024;

const MEMINFO_FIELDS = new Map([
	["MemTotal", "totalBytes"],
	["MemAvailable", "availableBytes"],
	["SwapTotal", "swapTotalBytes"],
	["SwapFree", "swapFreeBytes"],
]);
const MEMINFO_LINE = /^([A-Za-z0-9_()]+):[ \t]*(\d{1,15})[ \t]+kB\r?$/;

/** A kilobyte count (finite, >= 0) in bytes, or null when it is not one or overflows. */
function kibToBytes(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	const bytes = Math.round(value * KIB);
	return Number.isSafeInteger(bytes) ? bytes : null;
}

function consistent(figures) {
	return figures.availableBytes <= figures.totalBytes && figures.swapFreeBytes <= figures.swapTotalBytes;
}

/**
 * /proc/meminfo text -> { totalBytes, availableBytes, swapTotalBytes, swapFreeBytes }, or null
 * when a field is missing, duplicated, not "<integer> kB", too big, or the figures contradict
 * each other. Lines of other fields are ignored.
 */
function parseMeminfo(text) {
	if (typeof text !== "string" || text.length === 0 || text.length > MAX_MEMINFO_CHARS) return null;
	const found = new Map();
	for (const line of text.split("\n")) {
		const match = MEMINFO_LINE.exec(line);
		if (!match || !MEMINFO_FIELDS.has(match[1])) continue;
		const field = MEMINFO_FIELDS.get(match[1]);
		if (found.has(field)) return null;
		const bytes = kibToBytes(Number(match[2]));
		if (bytes === null) return null;
		found.set(field, bytes);
	}
	if (found.size !== MEMINFO_FIELDS.size) return null;
	const figures = {
		totalBytes: found.get("totalBytes"),
		availableBytes: found.get("availableBytes"),
		swapTotalBytes: found.get("swapTotalBytes"),
		swapFreeBytes: found.get("swapFreeBytes"),
	};
	return consistent(figures) ? figures : null;
}

/**
 * Electron's process.getSystemMemoryInfo() (kilobytes; swap fields absent on macOS) -> the same
 * four figures. It has no "available" figure: `free` (no page cache) stands in, the cautious side.
 */
function fromSystemMemoryInfo(info) {
	if (info === null || typeof info !== "object") return null;
	const figures = {
		totalBytes: kibToBytes(info.total),
		// Linux has "available" (page cache counted as reclaimable); elsewhere "free" is the cautious stand-in
		availableBytes: kibToBytes(info.available ?? info.free),
		swapTotalBytes: info.swapTotal === undefined ? 0 : kibToBytes(info.swapTotal),
		swapFreeBytes: info.swapFree === undefined ? 0 : kibToBytes(info.swapFree),
	};
	if (Object.values(figures).some((value) => value === null)) return null;
	return consistent(figures) ? figures : null;
}

/**
 * Reads at most `maxBytes` of a (procfs/sysfs) file into a fixed buffer; procfs reports size 0, so
 * the file is read in pieces until its end. More than `maxBytes` is refused; the handle is closed.
 */
async function readBoundedText({ fsp, file, maxBytes = MAX_READ_BYTES }) {
	const handle = await fsp.open(file, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		for (let i = 0; i < MAX_READ_CHUNKS && length <= maxBytes; i++) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (bytesRead === 0) return buffer.toString("utf8", 0, length);
			length += bytesRead;
		}
		throw new Error(`${file}: more than ${maxBytes} bytes`);
	} finally {
		await handle.close();
	}
}

/** The KiB value of the "<name>: <n> kB" line of a /proc file (exact name: Pss, not Pss_Anon), or null. */
function kibField({ text, name }) {
	if (typeof text !== "string") return null;
	for (const line of text.split("\n")) {
		const match = KIB_LINE.exec(line);
		if (match && match[1] === name) return Number(match[2]);
	}
	return null;
}

/**
 * Linux: Electron 44's app.getAppMetrics() carries no memory figures (electron_api_app.cc builds
 * "memory" only #if !BUILDFLAG(IS_LINUX)), so the app's memory is the Pss of
 * /proc/<pid>/smaps_rollup of each of its pids, or VmRSS of /proc/<pid>/status where smaps_rollup
 * cannot be read (a sandboxed, non-dumpable child). Paths are built only from positive safe
 * integers; any other pid refuses the figure. A process whose files are gone (it exited) is skipped.
 */
async function linuxAppBytes({ metrics, readText }) {
	if (!Array.isArray(metrics) || metrics.length === 0 || metrics.length > MAX_APP_PROCESSES) return null;
	const pids = [];
	for (const metric of metrics) {
		const pid = metric && typeof metric === "object" ? metric.pid : undefined;
		if (!Number.isSafeInteger(pid) || pid <= 0) return null;
		if (!pids.includes(pid)) pids.push(pid);
	}
	const sizes = await Promise.all(
		pids.map(async (pid) => {
			const dir = `${PROC_ROOT}/${String(pid)}`;
			const pss = kibField({ text: await readText(`${dir}/smaps_rollup`), name: "Pss" });
			return pss !== null ? pss : kibField({ text: await readText(`${dir}/status`), name: "VmRSS" });
		}),
	);
	const counted = sizes.filter((kib) => kib !== null);
	return counted.length > 0 ? kibToBytes(counted.reduce((sum, kib) => sum + kib, 0)) : null;
}

/**
 * The writable private memory of the window's renderer process, rounded up to whole MiB, or null.
 * Linux: VmData of /proc/<pid>/status (what RLIMIT_DATA counts; docs/ccut/round4-status.md, round 5e).
 * Elsewhere: null (no such limit known). The pid is only used when it is a
 * positive safe integer, and only to build a path under /proc.
 */
async function rendererData({ platform, readText, getRendererPid }) {
	if (typeof getRendererPid !== "function") return null;
	let pid;
	try {
		pid = getRendererPid();
	} catch {
		return null;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	// Only Linux has the 8 GiB RLIMIT_DATA this figure guards against; elsewhere the page gets no figure.
	if (platform !== "linux") return null;
	const kib = kibField({ text: await readText(`${PROC_ROOT}/${String(pid)}/status`), name: "VmData" });
	const bytes = kib === null ? null : kibToBytes(kib);
	return bytes === null ? null : Math.ceil(bytes / MiB) * MiB;
}

/** Windows / macOS: app.getAppMetrics() -> the working sets of every process of the app, summed, in bytes; or null. */
function sumAppBytes(metrics) {
	if (!Array.isArray(metrics) || metrics.length === 0) return null;
	let kib = 0;
	for (const metric of metrics) {
		const workingSet = metric && typeof metric.memory === "object" && metric.memory !== null ? metric.memory.workingSetSize : undefined;
		if (kibToBytes(workingSet) === null) return null;
		kib += workingSet;
	}
	return kibToBytes(kib);
}

/**
 * /proc/self/cgroup -> the cgroup v2 path of the "0::<path>" line, or null: cgroup v1 only, more
 * than one such line, or anything but a clean absolute path ("..", ".", empty components, NUL,
 * relative, too deep or too long) is refused, so no read can leave /sys/fs/cgroup.
 */
function parseCgroupPath(text) {
	if (typeof text !== "string") return null;
	const lines = text.split("\n").filter((line) => line.startsWith("0::"));
	if (lines.length !== 1) return null;
	const cgroupPath = lines[0].slice(3);
	if (cgroupPath === "/") return cgroupPath;
	if (cgroupPath.length > MAX_CGROUP_PATH_CHARS || !cgroupPath.startsWith("/")) return null;
	const parts = cgroupPath.slice(1).split("/");
	if (parts.length > MAX_CGROUP_DEPTH) return null;
	return parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\0")) ? null : cgroupPath;
}

/** A clean cgroup path and each of its ancestors, up to and including the root "/". */
function cgroupAncestry(cgroupPath) {
	const levels = [cgroupPath];
	let current = cgroupPath;
	for (let i = 0; i < MAX_CGROUP_DEPTH && current !== "/"; i++) {
		current = current.slice(0, current.lastIndexOf("/")) || "/";
		levels.push(current);
	}
	return levels;
}

/** A cgroup memory file's text: "missing" (no file), "max" (no limit), bytes, or "invalid". */
function parseCgroupBytes(text) {
	if (text === null || text === undefined) return { kind: "missing" };
	if (typeof text !== "string") return { kind: "invalid" };
	const value = text.trim();
	if (value === "max") return { kind: "max" };
	if (!CGROUP_NUMBER.test(value)) return { kind: "invalid" };
	const bytes = Number(value);
	// the kernel stores "no limit" set as a number as a huge page-aligned value: above 8 PiB is no limit
	return Number.isSafeInteger(bytes) ? { kind: "bytes", value: bytes } : { kind: "max" };
}

/**
 * Pure: the system figures limited by every cgroup level (the app's cgroup and its ancestors),
 * each given as the texts of memory.max, memory.current, memory.swap.max, memory.swap.current
 * (undefined/null = the file does not exist). total = min(total, smallest memory.max); available =
 * min(available, smallest memory.max - memory.current of a limited level), at least 0; the swap
 * figures likewise. "max" or a missing file = no limit at that level. A limit or a usage that is
 * not a number gives null (a guess could push the app over its cap).
 */
function applyCgroupLimits({ system, levels }) {
	const figures = { ...system };
	for (const level of levels) {
		for (const [maxText, currentText, totalKey, freeKey] of [
			[level.maxText, level.currentText, "totalBytes", "availableBytes"],
			[level.swapMaxText, level.swapCurrentText, "swapTotalBytes", "swapFreeBytes"],
		]) {
			const max = parseCgroupBytes(maxText);
			if (max.kind === "invalid") return null;
			if (max.kind !== "bytes") continue;
			const current = parseCgroupBytes(currentText);
			if (current.kind !== "bytes") return null;
			figures[totalKey] = Math.min(figures[totalKey], max.value);
			figures[freeKey] = Math.min(figures[freeKey], Math.max(0, max.value - current.value));
		}
	}
	return consistent(figures) ? figures : null;
}

/** Reads the figures at most once per `minIntervalMs`; `read()` resolves to a fresh copy or null, never rejects. */
function createMemoryInfoReader({ platform, readFile, getSystemMemoryInfo, getAppMetrics, getRendererPid, now, log, minIntervalMs = MIN_READ_INTERVAL_MS }) {
	let cached = null;
	let failureLogged = false;

	const fail = (reason) => {
		if (!failureLogged) {
			failureLogged = true;
			log(`[ccut] memory info unavailable (the page gets null): ${reason}`);
		}
		return null;
	};

	// A file that cannot be read counts as missing (no such limit, or the fallback).
	const readText = async (file) => {
		try {
			return await readFile(file);
		} catch {
			return null;
		}
	};

	const readSystem = async () => {
		if (platform === "linux") {
			const figures = parseMeminfo(await readText(MEMINFO_PATH));
			if (figures) return figures;
		}
		return fromSystemMemoryInfo(getSystemMemoryInfo());
	};

	const readCgroupLevels = async () => {
		const cgroupPath = parseCgroupPath(await readText(SELF_CGROUP_PATH));
		if (cgroupPath === null) return [];
		return Promise.all(
			cgroupAncestry(cgroupPath).map(async (level) => {
				const dir = level === "/" ? CGROUP_ROOT : `${CGROUP_ROOT}${level}`;
				const [maxText, currentText, swapMaxText, swapCurrentText] = await Promise.all(CGROUP_FILES.map((name) => readText(`${dir}/${name}`)));
				return { maxText, currentText, swapMaxText, swapCurrentText };
			}),
		);
	};

	const readNow = async () => {
		try {
			const system = await readSystem();
			if (!system) return fail("system memory figures unusable (/proc/meminfo, process.getSystemMemoryInfo())");
			const limited = platform === "linux" ? applyCgroupLimits({ system, levels: await readCgroupLevels() }) : system;
			if (!limited) return fail("cgroup memory figures unusable (/sys/fs/cgroup)");
			const metrics = getAppMetrics();
			const appBytes = platform === "linux" ? await linuxAppBytes({ metrics, readText }) : sumAppBytes(metrics);
			if (appBytes === null) return fail("app process memory unusable (app.getAppMetrics(), /proc/<pid>)");
			const floorMiB = (bytes) => Math.floor(bytes / MiB) * MiB;
			const answer = {
				totalBytes: floorMiB(limited.totalBytes),
				availableBytes: floorMiB(limited.availableBytes),
				swapTotalBytes: floorMiB(limited.swapTotalBytes),
				swapFreeBytes: floorMiB(limited.swapFreeBytes),
				appBytes: Math.ceil(appBytes / MiB) * MiB,
			};
			if (!Object.values(answer).every((value) => Number.isSafeInteger(value))) return fail("figures out of range");
			// The renderer's own writable memory: the figure Chromium's 8 GiB data limit counts. Optional:
			// without it the page simply has no export memory guard.
			const rendererDataBytes = await rendererData({ platform, readText, getRendererPid });
			return rendererDataBytes === null ? answer : { ...answer, rendererDataBytes };
		} catch (error) {
			return fail(error && error.message ? error.message : String(error));
		}
	};

	return {
		read() {
			const at = now();
			const fresh = cached !== null && at >= cached.at && at - cached.at < minIntervalMs;
			if (!fresh) cached = { at, result: readNow() };
			return cached.result.then((value) => (value === null ? null : { ...value }));
		},
	};
}

/** Registers the one handler. Every dependency is injected so the wiring is testable without Electron. */
function registerSystemMemoryIpc({ ipcMain, getWindow, origin, platform, readFile, getSystemMemoryInfo, getAppMetrics, getRendererPid, log, now = () => Date.now() }) {
	const reader = createMemoryInfoReader({ platform, readFile, getSystemMemoryInfo, getAppMetrics, getRendererPid, now, log });
	ipcMain.handle(CHANNEL, (event, ...args) => {
		const win = getWindow();
		const webContents = win && !win.isDestroyed() ? win.webContents : null;
		if (!isTrustedSender({ event, webContents, origin })) return null;
		if (args.length !== 0) return null;
		return reader.read();
	});
	return { reader };
}

module.exports = {
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
};
