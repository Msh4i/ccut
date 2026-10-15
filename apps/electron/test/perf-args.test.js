const { describe, expect, test } = require("bun:test");
const os = require("node:os");
const path = require("node:path");
const { UsageError, isSafeUserDataDir, parseArgs, resultFileName, shouldCopyProfileEntry, usage } = require("./perf/args");

// perf-two-clips.js command line, and the guards that keep the harness off the owner's live profile.

const run = (...argv) => parseArgs({ argv });

describe("parseArgs", () => {
	test("defaults: the four synthetic scenarios, 30 s, 2 s idle, label 'run', environment left alone", () => {
		expect(run()).toEqual({ mode: "run", scenarios: ["S1", "S1b", "S2", "S3"], seconds: 30, idleSeconds: 2, outDir: null, label: "run", clipsDir: null, profileCopy: null, project: null, hwDecode: null, levers: null });
	});

	test("every option", () => {
		expect(run("--scenarios", "S2,S1b,S2", "--seconds", "60", "--idle-seconds", "0", "--out", "/tmp/o", "--label", "after-1.b", "--clips", "/tmp/c", "--hw-decode", "zerocopy")).toEqual({
			mode: "run",
			scenarios: ["S2", "S1b"],
			seconds: 60,
			idleSeconds: 0,
			outDir: "/tmp/o",
			label: "after-1.b",
			clipsDir: "/tmp/c",
			profileCopy: null,
			project: null,
			hwDecode: "zerocopy",
			levers: null,
		});
	});

	test("--levers: off, or named levers (the others off)", () => {
		expect(run("--levers", "off").levers).toEqual({ decodeWorker: false, bitmapUpload: false, displayResolution: false });
		expect(run("--levers", "display=on").levers).toEqual({ decodeWorker: false, bitmapUpload: false, displayResolution: true });
		expect(run("--levers", "worker=on,bitmap=on,display=off").levers).toEqual({ decodeWorker: true, bitmapUpload: true, displayResolution: false });
		for (const value of ["on", "display", "display=yes", "gpu=on", "display=on,display=off", "display=on,", "OFF", "Display=on"]) {
			expect(() => run("--levers", value)).toThrow(UsageError);
		}
		expect(() => run("--levers")).toThrow(UsageError);
	});

	test("--project needs --profile-copy and then measures only that project unless scenarios are named", () => {
		expect(run("--profile-copy", "/b/ud", "--project", "0e90d978-d9ef-4ee3-9f89-c8d4cd30164c")).toMatchObject({ scenarios: ["project"], profileCopy: "/b/ud", project: "0e90d978-d9ef-4ee3-9f89-c8d4cd30164c" });
		expect(run("--profile-copy", "/b/ud", "--project", "p1", "--scenarios", "S1,project")).toMatchObject({ scenarios: ["S1", "project"] });
		expect(() => run("--project", "p1")).toThrow(UsageError);
		expect(() => run("--scenarios", "project")).toThrow("--project");
	});

	test("--compare BEFORE AFTER, and nothing else with it", () => {
		expect(run("--compare", "a.json", "b.json")).toEqual({ mode: "compare", before: "a.json", after: "b.json" });
		expect(() => run("--compare", "a.json")).toThrow(UsageError);
		expect(() => run("--compare", "a.json", "b.json", "--seconds", "5")).toThrow(UsageError);
	});

	test("--help", () => {
		expect(run("--help")).toEqual({ mode: "help" });
		expect(run("-h")).toEqual({ mode: "help" });
		expect(usage()).toContain("--profile-copy");
	});

	test("bad values are usage errors", () => {
		for (const argv of [
			["--seconds", "4"],
			["--seconds", "601"],
			["--seconds", "1.5"],
			["--seconds"],
			["--idle-seconds", "31"],
			["--scenarios", "S1,S9"],
			["--scenarios", ""],
			["--label", "../x"],
			["--label", "a/b"],
			["--label", ".."],
			["--label", "x".repeat(41)],
			["--project", "../../etc", "--profile-copy", "/b"],
			["--hw-decode", "yes"],
			["--bogus"],
			["stray"],
			["--out"],
			["--clips", "--label"],
		]) {
			expect(() => run(...argv)).toThrow(UsageError);
		}
	});
});

describe("guards", () => {
	test("only a ccut-perf-* directory directly made under the temp root is a usable user-data dir", () => {
		const tmpRoot = os.tmpdir();
		expect(isSafeUserDataDir({ dir: path.join(tmpRoot, "ccut-perf-ud-abc123"), tmpRoot })).toBe(true);
		for (const dir of [path.join(os.homedir(), ".config", "Ccut"), path.join(tmpRoot, "other"), path.join(tmpRoot, "ccut-perf-ud-x", ".."), tmpRoot, "/", "relative/ccut-perf-x", path.join(tmpRoot, "a", "ccut-perf-x")]) {
			expect(isSafeUserDataDir({ dir, tmpRoot })).toBe(false);
		}
	});

	test("a relative path is refused even when it would resolve into the temp root", () => {
		expect(isSafeUserDataDir({ dir: "ccut-perf-ud-x", tmpRoot: process.cwd() })).toBe(false);
		expect(isSafeUserDataDir({ dir: path.join(process.cwd(), "ccut-perf-ud-x"), tmpRoot: process.cwd() })).toBe(true);
	});

	test("the profile copy leaves out Chromium's single-instance lock files and the DevTools port file", () => {
		for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) expect(shouldCopyProfileEntry(name)).toBe(false);
		for (const name of ["IndexedDB", "Local Storage", "File System", "Preferences", "SingletonLockX"]) expect(shouldCopyProfileEntry(name)).toBe(true);
	});

	test("result file name: label and a file-safe time stamp", () => {
		expect(resultFileName({ label: "after", startedAt: "2026-10-04T10:05:09.123Z" })).toBe("perf-after-2026-10-04T10-05-09Z.json");
	});
});
