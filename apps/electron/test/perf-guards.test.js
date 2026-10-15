const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HarnessError, copyProfile, launchGuarded, removeTempDirs } = require("./perf/guards");

// The harness's three guards around the owner's data: it starts the app only on its own temporary
// directory, it copies a profile without following any link out of it, and it deletes only its own
// temporary directories. Real files in a temporary directory.

let root;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ccut-Ph-guards-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function makeProfile() {
	const profile = path.join(root, "profile");
	fs.mkdirSync(path.join(profile, "IndexedDB", "ccut_app_0.indexeddb.leveldb"), { recursive: true });
	fs.writeFileSync(path.join(profile, "Preferences"), "{}");
	fs.writeFileSync(path.join(profile, "IndexedDB", "ccut_app_0.indexeddb.leveldb", "000003.log"), "data");
	// Chromium's single-instance files are symlinks (dangling here): never copied, so allowed
	fs.symlinkSync("hostname-12345", path.join(profile, "SingletonLock"));
	fs.symlinkSync("/tmp/.org.chromium.Chromium.x/SingletonSocket", path.join(profile, "SingletonSocket"));
	fs.writeFileSync(path.join(profile, "DevToolsActivePort"), "9222\n/devtools/browser/x\n");
	return profile;
}

describe("copyProfile", () => {
	test("copies the files, leaves out the lock files and the DevTools port file, notes a running Ccut", () => {
		const profile = makeProfile();
		const to = path.join(root, "copy");
		const result = copyProfile({ fs, from: profile, to });
		expect(fs.readFileSync(path.join(to, "IndexedDB", "ccut_app_0.indexeddb.leveldb", "000003.log"), "utf8")).toBe("data");
		expect(fs.readdirSync(to).sort()).toEqual(["IndexedDB", "Preferences"]);
		expect(result.source).toBe(fs.realpathSync(profile));
		expect(result.notes.join(" ")).toContain("SingletonLock");
	});

	test("the source is resolved first: a symlink TO the profile is fine", () => {
		const profile = makeProfile();
		const alias = path.join(root, "alias");
		fs.symlinkSync(profile, alias);
		const to = path.join(root, "copy");
		expect(copyProfile({ fs, from: alias, to }).source).toBe(fs.realpathSync(profile));
		expect(fs.existsSync(path.join(to, "Preferences"))).toBe(true);
	});

	test("an absolute symlink inside the profile (a moved IndexedDB) is refused before anything goes through it", () => {
		const profile = makeProfile();
		const live = path.join(root, "live-store");
		fs.mkdirSync(live);
		fs.writeFileSync(path.join(live, "000001.log"), "owner's data");
		fs.symlinkSync(live, path.join(profile, "File System"));
		const to = path.join(root, "copy");
		let error = null;
		try {
			copyProfile({ fs, from: profile, to });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(HarnessError);
		expect(error.message).toContain("File System");
		expect(error.message).toContain("real backup");
		expect(fs.readdirSync(live)).toEqual(["000001.log"]);
		expect(fs.existsSync(path.join(to, "File System"))).toBe(false);
	});

	test("a relative ../ symlink deeper in the profile is refused too", () => {
		const profile = makeProfile();
		fs.symlinkSync("../../outside", path.join(profile, "IndexedDB", "link"));
		expect(() => copyProfile({ fs, from: profile, to: path.join(root, "copy") })).toThrow(path.join("IndexedDB", "link"));
	});

	test("a missing source or a file instead of a directory: HarnessError", () => {
		expect(() => copyProfile({ fs, from: path.join(root, "nope"), to: path.join(root, "copy") })).toThrow(HarnessError);
		fs.writeFileSync(path.join(root, "file"), "x");
		expect(() => copyProfile({ fs, from: path.join(root, "file"), to: path.join(root, "copy") })).toThrow("not a directory");
	});
});

describe("launchGuarded", () => {
	test("starts the app only on a ccut-perf-* directory directly in the temp root", async () => {
		const launched = [];
		const launch = async ({ userDataDir }) => {
			launched.push(userDataDir);
			return { ok: true };
		};
		const tmpRoot = root;
		const good = path.join(root, "ccut-perf-ud-abc");
		expect(await launchGuarded({ userDataDir: good, tmpRoot, launch })).toEqual({ ok: true });
		for (const bad of [path.join(os.homedir(), ".config", "Ccut"), path.join(root, "other"), path.join(root, "a", "ccut-perf-x"), "ccut-perf-rel"]) {
			let error = null;
			await launchGuarded({ userDataDir: bad, tmpRoot, launch }).catch((caught) => (error = caught));
			expect(error).toBeInstanceOf(HarnessError);
		}
		expect(launched).toEqual([good]);
	});
});

describe("removeTempDirs", () => {
	test("deletes only ccut-perf-* directories directly in the temp root; reports the others and failures", () => {
		const removed = [];
		const logs = [];
		const fakeFs = {
			rmSync: (dir, options) => {
				if (dir.endsWith("busy")) throw new Error("EBUSY");
				expect(options).toMatchObject({ recursive: true, force: true });
				removed.push(dir);
			},
		};
		const tmpRoot = "/tmp/x";
		const result = removeTempDirs({
			dirs: ["/tmp/x/ccut-perf-ud-1", "/tmp/x/ccut-perf-clips-2", "/home/u/.config/Ccut", "/tmp/x", "/tmp/x/ccut-perf-ud-1/..", "/tmp/x/ccut-perf-busy"],
			tmpRoot,
			fs: fakeFs,
			log: (line) => logs.push(line),
		});
		expect(removed).toEqual(["/tmp/x/ccut-perf-ud-1", "/tmp/x/ccut-perf-clips-2"]);
		expect(result).toEqual({ removed: 2, refused: 3, failed: 1 });
		expect(logs.join(" ")).toContain("/home/u/.config/Ccut");
		expect(logs.join(" ")).toContain("EBUSY");
	});
});
