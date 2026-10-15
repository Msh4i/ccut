const { describe, expect, test } = require("bun:test");
const { createSampler } = require("./perf/sampler");

// The harness's 500 ms sampler on a fake /proc and /sys/fs/cgroup (files as text, like the kernel's).

const stat = ({ pid, comm, ppid, utime = 0, stime = 0, start = 100 }) => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 30 0 ${start} 1000000 2000\n`;
const status = (rssKiB) => `Name:\tx\nVmRSS:\t ${rssKiB} kB\nRssAnon:\t 1 kB\n`;
const cmd = (...args) => `${args.join("\0")}\0`;
const ELECTRON = "/repo/node_modules/electron/dist/electron";

function fakeFs(files) {
	const enoent = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
	return {
		files,
		readFileSync: (file, encoding) => {
			expect(encoding).toBe("utf8");
			if (!Object.hasOwn(files, file)) throw enoent(file);
			return files[file];
		},
		readdirSync: (dir) => {
			const prefix = `${dir}/`;
			const names = new Set(Object.keys(files).filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split("/")[0]));
			if (names.size === 0) throw enoent(dir);
			return [...names];
		},
	};
}

function tree() {
	return {
		"/proc/1/stat": stat({ pid: 1, comm: "systemd", ppid: 0 }),
		"/proc/1/cmdline": cmd("/sbin/init"),
		"/proc/500/stat": stat({ pid: 500, comm: "electron", ppid: 1, utime: 100, stime: 20 }),
		"/proc/500/cmdline": cmd(ELECTRON, "/repo/apps/electron", "--user-data-dir=/tmp/ccut-perf-ud-x"),
		"/proc/500/status": status(200_000),
		"/proc/500/cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope\n",
		"/proc/510/stat": stat({ pid: 510, comm: "electron", ppid: 500, utime: 5 }),
		"/proc/510/cmdline": cmd(ELECTRON, "--type=zygote"),
		"/proc/510/status": status(50_000),
		"/proc/520/stat": stat({ pid: 520, comm: "electron", ppid: 510, utime: 900, stime: 100 }),
		"/proc/520/cmdline": cmd(ELECTRON, "--type=renderer", "--renderer-client-id=4"),
		"/proc/520/status": status(800_000),
		"/proc/520/task/520/stat": stat({ pid: 520, comm: "CrRendererMain", ppid: 510, utime: 600 }),
		"/proc/520/task/521/stat": stat({ pid: 521, comm: "ThreadPoolForeg", ppid: 510, utime: 300 }),
		"/proc/530/stat": stat({ pid: 530, comm: "electron", ppid: 500, utime: 400 }),
		"/proc/530/cmdline": cmd(ELECTRON, "--type=gpu-process"),
		"/proc/530/status": status(400_000),
		"/proc/540/stat": stat({ pid: 540, comm: "electron", ppid: 500, utime: 50 }),
		"/proc/540/cmdline": cmd(ELECTRON, "--type=utility", "--utility-sub-type=node.mojom.NodeService"),
		// gone between the directory listing and the read: no stat file
		"/proc/550/cmdline": cmd(ELECTRON, "--type=utility"),
		"/proc/900/stat": stat({ pid: 900, comm: "firefox", ppid: 1, utime: 99_999 }),
		"/proc/900/cmdline": cmd("/usr/lib/firefox/firefox"),
		"/proc/meminfo": "MemTotal: 16000000 kB\nMemAvailable: 6000000 kB\nSwapTotal: 8000000 kB\nSwapFree: 7000000 kB\n",
		"/proc/self/stat": "not a pid dir",
		"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope/memory.current": "2147483648\n",
		"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope/memory.max": "4294967296\n",
		"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope/memory.swap.max": "0\n",
		"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope/memory.peak": "3000000000\n",
		"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope/memory.events": "max 0\noom_kill 0\n",
	};
}

describe("createSampler", () => {
	test("every process below the Electron root with its role, CPU ticks and RSS; nothing outside the tree", () => {
		const sampler = createSampler({ fs: fakeFs(tree()), rootPid: 500 });
		expect(sampler.sampleProcesses()).toEqual([
			{ pid: 500, startTimeTicks: 100, role: "browser", subtype: null, ticks: 120, rssKiB: 200_000 },
			{ pid: 510, startTimeTicks: 100, role: "zygote", subtype: null, ticks: 5, rssKiB: 50_000 },
			{ pid: 530, startTimeTicks: 100, role: "gpu", subtype: null, ticks: 400, rssKiB: 400_000 },
			{ pid: 540, startTimeTicks: 100, role: "utility", subtype: "node.mojom.NodeService", ticks: 50, rssKiB: null },
			{ pid: 520, startTimeTicks: 100, role: "renderer", subtype: null, ticks: 1000, rssKiB: 800_000 },
		]);
	});

	test("the threads of one process with their names and ticks; a vanished process has none", () => {
		const sampler = createSampler({ fs: fakeFs(tree()), rootPid: 500 });
		expect(sampler.threads({ pid: 520 })).toEqual([
			{ tid: 520, comm: "CrRendererMain", ticks: 600 },
			{ tid: 521, comm: "ThreadPoolForeg", ticks: 300 },
		]);
		expect(sampler.threads({ pid: 777 })).toEqual([]);
	});

	test("system memory and the cgroup's memory.current, plus its limit files", () => {
		const sampler = createSampler({ fs: fakeFs(tree()), rootPid: 500 });
		expect(sampler.cgroupPath).toBe("/user.slice/user-1000.slice/user@1000.service/app.slice/run-r42.scope");
		expect(sampler.memory()).toEqual({ memAvailableBytes: 6_000_000 * 1024, swapFreeBytes: 7_000_000 * 1024, cgroupCurrentBytes: 2147483648 });
		expect(sampler.cgroupFiles()).toEqual({ maxText: "4294967296\n", swapMaxText: "0\n", peakText: "3000000000\n", eventsText: "max 0\noom_kill 0\n" });
	});

	test("no cgroup v2 path, unreadable meminfo: nulls instead of errors", () => {
		const files = tree();
		files["/proc/500/cgroup"] = "4:memory:/x\n";
		files["/sys/fs/cgroup/memory.events"] = "oom_kill 3\n"; // the root cgroup's, not the app's
		delete files["/proc/meminfo"];
		const sampler = createSampler({ fs: fakeFs(files), rootPid: 500 });
		expect(sampler.cgroupPath).toBeNull();
		expect(sampler.memory()).toEqual({ memAvailableBytes: null, swapFreeBytes: null, cgroupCurrentBytes: null });
		expect(sampler.cgroupFiles()).toEqual({ maxText: undefined, swapMaxText: undefined, peakText: undefined, eventsText: undefined });
	});

	test("the root gone (Electron exited): an empty sample", () => {
		const files = tree();
		delete files["/proc/500/stat"];
		expect(createSampler({ fs: fakeFs(files), rootPid: 500 }).sampleProcesses()).toEqual([]);
	});

	test("a process first seen as a zygote child is classified again later (Chromium renames forked processes)", () => {
		const files = tree();
		files["/proc/520/cmdline"] = cmd(ELECTRON, "--type=zygote");
		const fs = fakeFs(files);
		const sampler = createSampler({ fs, rootPid: 500 });
		expect(sampler.sampleProcesses().find((p) => p.pid === 520).role).toBe("zygote");
		files["/proc/520/cmdline"] = cmd(ELECTRON, "--type=renderer");
		expect(sampler.sampleProcesses().find((p) => p.pid === 520).role).toBe("renderer");
		files["/proc/520/cmdline"] = cmd(ELECTRON, "--type=gpu-process");
		expect(sampler.sampleProcesses().find((p) => p.pid === 520).role).toBe("renderer"); // settled roles are cached per pid + start time
	});
});
