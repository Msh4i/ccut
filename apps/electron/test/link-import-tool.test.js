const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
	DOWNLOAD_HOSTS,
	LIMITS,
	MIN_VERSION,
	ToolError,
	compareVersions,
	createToolResolver,
	findOnPath,
	installManagedBinary,
	managedAssetFor,
	parseSha256Sums,
	parseVersion,
	readManagedBinary,
	sweepToolLeftovers,
} = require("../link-import-tool");
const { YT_DLP_SIGNING_KEY_FINGERPRINT } = require("../link-import-ytdlp-key");

// yt-dlp itself: from PATH (an absolute entry only, at least MIN_VERSION), or, after the user
// agreed, the official release binary. The SAME release's SHA2-256SUMS is trusted only with a
// valid signature (SHA2-256SUMS.sig) by the pinned yt-dlp key, and the binary is checked
// against it before it is ever made executable or run.

// gpg-made fixtures (fixtures/openpgp/README.md): a test key stands in for yt-dlp's so that the
// tests can sign sums of files they control. The production default is the embedded yt-dlp key.
const OPENPGP = path.join(__dirname, "fixtures", "openpgp");
const fixture = (name) => fs.readFileSync(path.join(OPENPGP, name));
const TEST_KEY = Object.freeze({ armored: fixture("test-key.asc").toString("utf8"), fingerprint: "9A837733E6D8970CF21377578E3B95A0078605B9" });
const RELEASE = fixture("release.sh"); // stand-in for yt-dlp_linux; test-sums lists its sha256

let dir;
beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-link-tool-"));
});
afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function codeOf(promise) {
	try {
		await promise;
	} catch (error) {
		return error instanceof ToolError ? error.code : `not a ToolError: ${error && error.message}`;
	}
	return "resolved";
}

describe("findOnPath", () => {
	const fakeStat = (files) => async (candidate) => files[candidate] ?? null;

	test("the first ABSOLUTE PATH entry holding an executable yt-dlp file wins", async () => {
		const found = await findOnPath({
			envPath: "/usr/local/bin:/usr/bin",
			platform: "linux",
			pathApi: path.posix,
			statFile: fakeStat({ "/usr/bin/yt-dlp": { isFile: true, executable: true } }),
		});
		expect(found).toBe("/usr/bin/yt-dlp");
	});

	test("relative entries, '.', empty entries (the current directory) are never searched", async () => {
		const seen = [];
		const statFile = async (candidate) => {
			seen.push(candidate);
			return { isFile: true, executable: true };
		};
		const found = await findOnPath({ envPath: ".:bin:./tools::../x:/opt/bin", platform: "linux", pathApi: path.posix, statFile });
		expect(found).toBe("/opt/bin/yt-dlp");
		expect(seen).toEqual(["/opt/bin/yt-dlp"]);
	});

	test("absent, a directory named yt-dlp, or a file that is not executable: null", async () => {
		const statFile = fakeStat({ "/a/yt-dlp": { isFile: false, executable: true }, "/b/yt-dlp": { isFile: true, executable: false } });
		expect(await findOnPath({ envPath: "/a:/b:/c", platform: "linux", pathApi: path.posix, statFile })).toBeNull();
		expect(await findOnPath({ envPath: undefined, platform: "linux", pathApi: path.posix, statFile })).toBeNull();
		expect(await findOnPath({ envPath: "", platform: "linux", pathApi: path.posix, statFile })).toBeNull();
	});

	test("Windows: yt-dlp.exe, ';' separated, quoted entries unquoted, drive-relative entries ignored", async () => {
		const seen = [];
		const statFile = async (candidate) => {
			seen.push(candidate);
			return candidate === "C:\\Program Files\\yt\\yt-dlp.exe" ? { isFile: true, executable: true } : null;
		};
		const found = await findOnPath({ envPath: 'C:tools;.;"C:\\Program Files\\yt";D:\\x', platform: "win32", pathApi: path.win32, statFile });
		expect(found).toBe("C:\\Program Files\\yt\\yt-dlp.exe");
		expect(seen).toEqual(["C:\\Program Files\\yt\\yt-dlp.exe"]);
	});

	test("with the real file system: an executable stub is found, a non-executable one is not", async () => {
		const binA = path.join(dir, "a");
		const binB = path.join(dir, "b");
		await fsp.mkdir(binA);
		await fsp.mkdir(binB);
		await fsp.writeFile(path.join(binA, "yt-dlp"), "#!/bin/sh\n", { mode: 0o644 });
		await fsp.writeFile(path.join(binB, "yt-dlp"), "#!/bin/sh\n", { mode: 0o755 });
		expect(await findOnPath({ envPath: `${binA}:${binB}`, platform: "linux" })).toBe(path.join(binB, "yt-dlp"));
	});
});

describe("findOnPath: a PATH candidate that others can write is refused (POSIX)", () => {
	const posixOnly = process.platform === "win32" ? test.skip : test;
	let tmp;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ccut-path-perm-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});
	// A directory with the given mode (mkdir is masked by umask, hence the chmod) holding an
	// executable yt-dlp stub with the given file mode.
	const make = async ({ name, dirMode = 0o755, fileMode = 0o755 }) => {
		const bin = path.join(tmp, name);
		await fsp.mkdir(bin);
		await fsp.writeFile(path.join(bin, "yt-dlp"), "#!/bin/sh\n");
		await fsp.chmod(path.join(bin, "yt-dlp"), fileMode);
		await fsp.chmod(bin, dirMode);
		return bin;
	};
	const find = async ({ bins, logs }) => findOnPath({ envPath: bins.join(":"), platform: "linux", log: (line) => logs.push(line) });

	posixOnly("a group- or world-writable file is skipped (logged), the next safe entry is used", async () => {
		const groupFile = await make({ name: "g", fileMode: 0o775 });
		const worldFile = await make({ name: "w", fileMode: 0o757 });
		const safe = await make({ name: "s" });
		const logs = [];
		expect(await find({ bins: [groupFile, worldFile, safe], logs })).toBe(path.join(safe, "yt-dlp"));
		expect(logs).toHaveLength(2);
		expect(logs[0]).toContain(path.join(groupFile, "yt-dlp"));
		expect(logs[0]).toContain("writable");
	});

	posixOnly("a file in a group- or world-writable directory is skipped", async () => {
		const groupDir = await make({ name: "gd", dirMode: 0o775 });
		const worldDir = await make({ name: "wd", dirMode: 0o777 });
		const logs = [];
		expect(await find({ bins: [groupDir, worldDir], logs })).toBeNull();
		expect(logs).toHaveLength(2);
	});

	posixOnly("a symlink is judged by its target: a writable target directory refuses a safe-looking link", async () => {
		const unsafe = await make({ name: "target", dirMode: 0o777 });
		const links = path.join(tmp, "links");
		await fsp.mkdir(links);
		await fsp.chmod(links, 0o755);
		await fsp.symlink(path.join(unsafe, "yt-dlp"), path.join(links, "yt-dlp"));
		const logs = [];
		expect(await find({ bins: [links], logs })).toBeNull();
		expect(logs).toHaveLength(1);
	});

	posixOnly("mode 0755 file in a 0755 directory (owner-only write) is found, nothing logged", async () => {
		const safe = await make({ name: "ok" });
		const logs = [];
		expect(await find({ bins: [safe], logs })).toBe(path.join(safe, "yt-dlp"));
		expect(logs).toEqual([]);
	});

	test("Windows: no permission-bit check (the injected stat decides)", async () => {
		const found = await findOnPath({
			envPath: "C:\\yt",
			platform: "win32",
			pathApi: path.win32,
			statFile: async () => ({ isFile: true, executable: true }),
		});
		expect(found).toBe("C:\\yt\\yt-dlp.exe");
	});

	test("an injected stat that reports it unsafe is skipped and logged on any platform", async () => {
		const logs = [];
		const found = await findOnPath({
			envPath: "/a:/b",
			platform: "linux",
			pathApi: path.posix,
			log: (line) => logs.push(line),
			statFile: async (candidate) => (candidate === "/a/yt-dlp" ? { isFile: true, executable: true, unsafe: "writable by others" } : { isFile: true, executable: true }),
		});
		expect(found).toBe("/b/yt-dlp");
		expect(logs).toEqual(["[ccut] link import: skipping /a/yt-dlp on PATH (writable by others)"]);
	});
});

describe("parseSha256Sums", () => {
	const hashA = "a".repeat(64);
	const hashB = "0123456789abcdef".repeat(4);
	const sums = `${hashA}  yt-dlp\n${hashB}  yt-dlp_linux\n${"c".repeat(64)}  yt-dlp.exe\n`;

	test("the asset's hash; binary-mode '*' entries too", () => {
		expect(parseSha256Sums({ text: sums, assetName: "yt-dlp_linux" })).toBe(hashB);
		expect(parseSha256Sums({ text: `${hashB} *yt-dlp_macos\n`, assetName: "yt-dlp_macos" })).toBe(hashB);
	});

	test("missing entry, duplicate entry, malformed line, upper-case hash, short hash, huge file: tool-verify-failed", () => {
		const bad = [
			[sums, "yt-dlp_macos"],
			[`${sums}${hashA}  yt-dlp_linux\n`, "yt-dlp_linux"],
			[`${sums}garbage line\n`, "yt-dlp_linux"],
			[`${hashB.toUpperCase()}  yt-dlp_linux\n`, "yt-dlp_linux"],
			[`${hashB.slice(1)}  yt-dlp_linux\n`, "yt-dlp_linux"],
			[`${hashB}\tyt-dlp_linux\n`, "yt-dlp_linux"],
			[`${hashB}  ../yt-dlp_linux\n`, "yt-dlp_linux"],
			[`${hashB}  yt-dlp_linux\n`.repeat(1) + "x".repeat(LIMITS.maxSumsBytes), "yt-dlp_linux"],
			["", "yt-dlp_linux"],
			[undefined, "yt-dlp_linux"],
		];
		for (const [text, assetName] of bad) {
			expect(() => parseSha256Sums({ text, assetName })).toThrow(ToolError);
			try {
				parseSha256Sums({ text, assetName });
			} catch (error) {
				expect(error.code).toBe("tool-verify-failed");
			}
		}
	});
});

describe("versions", () => {
	test("yt-dlp's date versions parse and compare; anything else is null", () => {
		expect(parseVersion("2025.09.26\n")).toEqual([2025, 9, 26, 0]);
		expect(parseVersion("2024.12.06.232909")).toEqual([2024, 12, 6, 232909]);
		for (const bad of ["", "v2025.01.01", "2025.1.1", "yt-dlp 2025.01.01", "2025.01.01 extra", "2025.01.01\n2026.01.01", 5]) {
			expect(parseVersion(bad)).toBeNull();
		}
		expect(compareVersions(parseVersion("2025.02.19"), parseVersion("2025.02.19"))).toBe(0);
		expect(compareVersions(parseVersion("2025.02.18.9"), parseVersion("2025.02.19"))).toBeLessThan(0);
		expect(compareVersions(parseVersion("2026.01.01"), parseVersion("2025.12.31.1"))).toBeGreaterThan(0);
		expect(parseVersion(MIN_VERSION)).not.toBeNull();
	});
});

describe("managedAssetFor", () => {
	test("the official release asset for the three platforms; anything else has none", () => {
		expect(managedAssetFor({ platform: "linux", arch: "x64" })).toBe("yt-dlp_linux");
		expect(managedAssetFor({ platform: "win32", arch: "x64" })).toBe("yt-dlp.exe");
		expect(managedAssetFor({ platform: "darwin", arch: "x64" })).toBe("yt-dlp_macos");
		expect(managedAssetFor({ platform: "darwin", arch: "arm64" })).toBe("yt-dlp_macos");
		expect(managedAssetFor({ platform: "linux", arch: "arm64" })).toBeNull();
		expect(managedAssetFor({ platform: "freebsd", arch: "x64" })).toBeNull();
	});
});

// A fake GitHub: /releases/latest redirects to the tag page, release downloads redirect to the
// asset host, which serves the bytes. Every request is recorded.
function fakeGitHub({ tag = "2025.09.26", binary = RELEASE, sums = fixture("test-sums"), sig = fixture("test-sums.sig"), assetHost = "release-assets.githubusercontent.com", overrides = {} } = {}) {
	const requests = [];
	const asset = "yt-dlp_linux";
	const routes = {
		"https://github.com/yt-dlp/yt-dlp/releases/latest": () => ({ status: 302, location: `https://github.com/yt-dlp/yt-dlp/releases/tag/${tag}` }),
		[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`]: () => ({ status: 302, location: `https://${assetHost}/github-production-release-asset/1/sums?sig=x` }),
		[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS.sig`]: () => ({ status: 302, location: `https://${assetHost}/github-production-release-asset/1/sig?sig=z` }),
		[`https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${asset}`]: () => ({ status: 302, location: `https://${assetHost}/github-production-release-asset/1/bin?sig=y` }),
		[`https://${assetHost}/github-production-release-asset/1/sums?sig=x`]: () => ({ status: 200, body: Buffer.from(sums) }),
		[`https://${assetHost}/github-production-release-asset/1/sig?sig=z`]: () => ({ status: 200, body: Buffer.from(sig) }),
		[`https://${assetHost}/github-production-release-asset/1/bin?sig=y`]: () => ({ status: 200, body: binary }),
		...overrides,
	};
	const fetch = async (url, init) => {
		requests.push({ url, redirect: init && init.redirect });
		const route = routes[url];
		const answer = route ? route() : { status: 404 };
		const headers = new Headers();
		if (answer.location) headers.set("location", answer.location);
		if (answer.body && answer.contentLength !== false) headers.set("content-length", String(answer.contentLength ?? answer.body.length));
		const chunks = answer.chunks ?? (answer.body ? [answer.body] : []);
		return {
			status: answer.status,
			headers,
			body: {
				async *[Symbol.asyncIterator]() {
					for (const chunk of chunks) {
						if (answer.beforeChunk) await answer.beforeChunk();
						yield new Uint8Array(chunk);
					}
				},
			},
		};
	};
	return { fetch, requests, binary, asset, tag };
}

const install = (gitHub, extra = {}) =>
	installManagedBinary({ fetch: gitHub.fetch, binDir: path.join(dir, "bin"), platform: "linux", arch: "x64", now: () => Date.UTC(2025, 9, 1), signingKey: TEST_KEY, ...extra });

describe("installManagedBinary", () => {
	test("good: the binary lands as bin/yt-dlp, 0755, with a manifest (tag, asset, sha256, size, signing key); no temp file is left", async () => {
		const gitHub = fakeGitHub();
		const result = await install(gitHub);
		const target = path.join(dir, "bin", "yt-dlp");
		expect(result).toEqual({ path: target, version: "2025.09.26", sha256: sha(gitHub.binary), size: gitHub.binary.length });
		expect(fs.readFileSync(target)).toEqual(gitHub.binary);
		expect(fs.statSync(target).mode & 0o777).toBe(0o755);
		expect(fs.statSync(path.join(dir, "bin")).mode & 0o777).toBe(0o700);
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, "bin", "yt-dlp.manifest.json"), "utf8"));
		expect(manifest).toEqual({
			version: "2025.09.26",
			asset: "yt-dlp_linux",
			sha256: sha(gitHub.binary),
			size: gitHub.binary.length,
			source: "https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/yt-dlp_linux",
			installedAt: "2025-10-01T00:00:00.000Z",
			signingKey: TEST_KEY.fingerprint,
		});
		expect(fs.readdirSync(path.join(dir, "bin")).sort()).toEqual(["yt-dlp", "yt-dlp.manifest.json"]);
		// The tag is resolved once; the sums file, its signature and the binary come from THAT tag;
		// nothing follows redirects by itself.
		expect(gitHub.requests.map((r) => r.url)).toEqual([
			"https://github.com/yt-dlp/yt-dlp/releases/latest",
			"https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/SHA2-256SUMS",
			"https://release-assets.githubusercontent.com/github-production-release-asset/1/sums?sig=x",
			"https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/SHA2-256SUMS.sig",
			"https://release-assets.githubusercontent.com/github-production-release-asset/1/sig?sig=z",
			"https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/yt-dlp_linux",
			"https://release-assets.githubusercontent.com/github-production-release-asset/1/bin?sig=y",
		]);
		expect(gitHub.requests.every((r) => r.redirect === "manual")).toBe(true);
	});

	test("the older asset host objects.githubusercontent.com is accepted too", async () => {
		const gitHub = fakeGitHub({ assetHost: "objects.githubusercontent.com" });
		expect((await install(gitHub)).version).toBe("2025.09.26");
	});

	test("while it downloads the file is not executable (0600) and has a temporary name", async () => {
		const modes = [];
		const binary = RELEASE;
		expect(binary.length).toBeGreaterThan(1000);
		const gitHub = fakeGitHub({
			overrides: {
				"https://release-assets.githubusercontent.com/github-production-release-asset/1/bin?sig=y": () => ({
					status: 200,
					body: binary,
					chunks: [binary.subarray(0, 1000), binary.subarray(1000)],
					beforeChunk: async () => {
						for (const name of fs.readdirSync(path.join(dir, "bin"))) {
							modes.push({ name, mode: fs.statSync(path.join(dir, "bin", name)).mode & 0o777 });
						}
					},
				}),
			},
		});
		await install(gitHub);
		expect(modes.length).toBeGreaterThan(0);
		for (const { name, mode } of modes) {
			expect(name).toMatch(/^\.yt-dlp-[0-9a-f]{16}\.download$/);
			expect(mode).toBe(0o600);
		}
	});

	test("checksum mismatch (validly signed sums, other binary): tool-verify-failed, nothing left in bin (no binary, no manifest, no temp)", async () => {
		const gitHub = fakeGitHub({ sums: fixture("mismatch-sums"), sig: fixture("mismatch-sums.sig") });
		expect(await codeOf(install(gitHub))).toBe("tool-verify-failed");
		expect(fs.readdirSync(path.join(dir, "bin"))).toEqual([]);
	});

	test("the signed SUMS file has no entry for the asset: tool-verify-failed before the binary is fetched", async () => {
		const gitHub = fakeGitHub({ sums: fixture("no-linux-sums"), sig: fixture("no-linux-sums.sig") });
		expect(await codeOf(install(gitHub))).toBe("tool-verify-failed");
		expect(gitHub.requests.some((r) => r.url.endsWith("/yt-dlp_linux"))).toBe(false);
	});

	test("the sums file is trusted only with a valid signature by the pinned key: else tool-signature-failed, the binary is never fetched", async () => {
		const flipped = Buffer.from(fixture("test-sums"));
		flipped[3] ^= 0x01;
		const cases = [
			{ sums: flipped }, // one changed byte in the signed file
			{ sums: "<html>rate limited</html>" }, // not the signed file at all
			{ sig: fixture("test-sums.sha1.sig") }, // a valid signature, but SHA-1
			{ sig: fixture("test-sums.critical.sig") }, // a valid signature with a critical unknown subpacket
			{ sig: fixture("yt-dlp-2026.08.19.SHA2-256SUMS.by-test-key.sig") }, // signed, but another file
			{ sig: Buffer.from("not a signature") },
			{ sig: Buffer.alloc(0) },
		];
		for (const variant of cases) {
			const gitHub = fakeGitHub(variant);
			expect(await codeOf(install(gitHub))).toBe("tool-signature-failed");
			expect(gitHub.requests.some((r) => r.url.endsWith("/yt-dlp_linux"))).toBe(false);
			expect(fs.readdirSync(path.join(dir, "bin"))).toEqual([]);
		}
	});

	test("the default key is the embedded yt-dlp key: sums signed by another key are refused; the REAL yt-dlp signature passes", async () => {
		// The test key's signature is not yt-dlp's.
		const signedByTestKey = fakeGitHub();
		expect(await codeOf(install(signedByTestKey, { signingKey: undefined }))).toBe("tool-signature-failed");
		expect(signedByTestKey.requests.some((r) => r.url.endsWith("/yt-dlp_linux"))).toBe(false);
		// The real 2026.08.19 files: the signature verifies, so the binary is fetched; the stand-in
		// binary is not the real yt-dlp_linux, so the checksum refuses it.
		const real = fakeGitHub({ tag: "2026.08.19", sums: fixture("yt-dlp-2026.08.19.SHA2-256SUMS"), sig: fixture("yt-dlp-2026.08.19.SHA2-256SUMS.sig") });
		expect(await codeOf(install(real, { signingKey: undefined }))).toBe("tool-verify-failed");
		expect(real.requests.some((r) => r.url === "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux")).toBe(true);
		expect(YT_DLP_SIGNING_KEY_FINGERPRINT).toBe("AC0CBBE6848D6A873464AF4E57CF65933B5A7581");
	});

	test("rollback: a tag below the floor, or sums signed before the oldest accepted time, never fetch the binary", async () => {
		expect(LIMITS.minSignedAt).toBe(Date.UTC(2025, 2, 1) / 1000);
		// An old release served as "latest" (unsigned tag below MIN_VERSION).
		const oldTag = fakeGitHub({ tag: "2025.02.19" });
		expect(await codeOf(install(oldTag))).toBe("tool-download-failed");
		expect(oldTag.requests.some((r) => r.url.includes("SHA2-256SUMS"))).toBe(false);
		// A validly signed file whose signature is older than the accepted time: the test key's
		// signature (made 2026-10-05) against a floor after it.
		const stale = fakeGitHub();
		const afterSigning = Date.UTC(2027, 0, 1) / 1000;
		expect(await codeOf(install(stale, { limits: { minSignedAt: afterSigning } }))).toBe("tool-signature-failed");
		expect(stale.requests.some((r) => r.url.endsWith("/yt-dlp_linux"))).toBe(false);
		const fresh = fakeGitHub();
		expect((await install(fresh, { limits: { minSignedAt: Date.UTC(2026, 0, 1) / 1000 } })).version).toBe("2025.09.26");
	});

	test("a key whose fingerprint is not the pinned one is refused before anything is downloaded", async () => {
		const gitHub = fakeGitHub();
		expect(await codeOf(install(gitHub, { signingKey: { armored: TEST_KEY.armored, fingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT } }))).toBe("tool-signature-failed");
		expect(gitHub.requests).toEqual([]);
	});

	test("the signature file: same tag, same redirect checks, at most 16 KiB, missing = tool-download-failed", async () => {
		expect(LIMITS.maxSignatureBytes).toBe(16 * 1024);
		const sigUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/SHA2-256SUMS.sig";
		const sigHost = "https://release-assets.githubusercontent.com/github-production-release-asset/1/sig?sig=z";
		let pulled = 0;
		const variants = [
			{ [sigUrl]: () => ({ status: 404 }) },
			{ [sigUrl]: () => ({ status: 302, location: "https://evil.example/SHA2-256SUMS.sig" }) },
			{ [sigHost]: () => ({ status: 200, body: Buffer.alloc(10), contentLength: LIMITS.maxSignatureBytes + 1, beforeChunk: async () => void pulled++ }) },
			{ [sigHost]: () => ({ status: 200, contentLength: false, chunks: [Buffer.alloc(LIMITS.maxSignatureBytes), Buffer.alloc(1)] }) },
		];
		for (const overrides of variants) {
			const gitHub = fakeGitHub({ overrides });
			expect(await codeOf(install(gitHub))).toBe("tool-download-failed");
			expect(gitHub.requests.map((r) => r.url)).not.toContain("https://evil.example/SHA2-256SUMS.sig");
			expect(gitHub.requests.some((r) => r.url.endsWith("/yt-dlp_linux"))).toBe(false);
		}
		expect(pulled).toBe(0);
	});

	test("a redirect to a host that is not GitHub's, or to http, or with userinfo/port: tool-download-failed, nothing fetched there", async () => {
		for (const location of [
			"https://evil.example/yt-dlp_linux",
			"http://release-assets.githubusercontent.com/x",
			"https://github.com.evil.example/x",
			"https://user@release-assets.githubusercontent.com/x",
			"https://release-assets.githubusercontent.com:8443/x",
			"file:///etc/passwd",
		]) {
			const gitHub = fakeGitHub({
				overrides: { "https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/SHA2-256SUMS": () => ({ status: 302, location }) },
			});
			expect(await codeOf(install(gitHub))).toBe("tool-download-failed");
			expect(gitHub.requests.map((r) => r.url)).not.toContain(location);
			expect(fs.readdirSync(path.join(dir, "bin"))).toEqual([]);
		}
		expect([...DOWNLOAD_HOSTS].sort()).toEqual(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
	});

	test("a redirect loop stops after a few hops", async () => {
		const loop = "https://github.com/yt-dlp/yt-dlp/releases/download/2025.09.26/SHA2-256SUMS";
		const gitHub = fakeGitHub({ overrides: { [loop]: () => ({ status: 302, location: loop }) } });
		expect(await codeOf(install(gitHub))).toBe("tool-download-failed");
		expect(gitHub.requests.length).toBeLessThanOrEqual(2 + LIMITS.maxRedirects);
	});

	test("the latest tag must be a yt-dlp date version on the yt-dlp tag page", async () => {
		for (const location of [
			"https://github.com/yt-dlp/yt-dlp/releases/tag/../../evil",
			"https://github.com/yt-dlp/yt-dlp/releases/tag/latest",
			"https://github.com/other/yt-dlp/releases/tag/2025.09.26",
			"https://github.com/yt-dlp/yt-dlp/releases/tag/2025.09.26?x=1",
		]) {
			const gitHub = fakeGitHub({ overrides: { "https://github.com/yt-dlp/yt-dlp/releases/latest": () => ({ status: 302, location }) } });
			expect(await codeOf(install(gitHub))).toBe("tool-download-failed");
		}
	});

	test("too big: a Content-Length over the cap is refused before reading; a body that keeps going is cut at the cap", async () => {
		let pulled = 0;
		const big = fakeGitHub({
			overrides: {
				"https://release-assets.githubusercontent.com/github-production-release-asset/1/bin?sig=y": () => ({
					status: 200,
					body: Buffer.alloc(10),
					contentLength: LIMITS.maxBinaryBytes + 1,
					beforeChunk: async () => {
						pulled++;
					},
				}),
			},
		});
		expect(await codeOf(install(big))).toBe("tool-download-failed");
		expect(pulled).toBe(0); // not a single byte was read
		const chunk = Buffer.alloc(1024 * 1024);
		let served = 0;
		const endless = fakeGitHub({
			overrides: {
				"https://release-assets.githubusercontent.com/github-production-release-asset/1/bin?sig=y": () => ({
					status: 200,
					contentLength: false,
					chunks: Array.from({ length: 8 }, () => chunk),
					beforeChunk: async () => {
						served++;
					},
				}),
			},
		});
		expect(await codeOf(install(endless, { limits: { maxBinaryBytes: 3 * 1024 * 1024 } }))).toBe("tool-download-failed");
		expect(served).toBeLessThanOrEqual(5);
		expect(fs.readdirSync(path.join(dir, "bin"))).toEqual([]);
	});

	test("a download that stalls is stopped by the time limit even when the job passes its own (Cancel) signal", async () => {
		const jobSignal = new AbortController().signal; // never aborted
		const stalled = {
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		};
		const started = Date.now();
		expect(await codeOf(install(stalled, { signal: jobSignal, limits: { downloadTimeoutMs: 100 } }))).toBe("tool-download-failed");
		expect(Date.now() - started).toBeLessThan(3000);
	});

	test("Cancel during the download (the job's signal) stops it at once, long before the time limit", async () => {
		const job = new AbortController();
		const stalled = {
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("aborted")));
					setTimeout(() => job.abort(), 50);
				}),
		};
		const started = Date.now();
		expect(await codeOf(install(stalled, { signal: job.signal, limits: { downloadTimeoutMs: 60_000 } }))).toBe("tool-download-failed");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("a network failure (fetch throws) or an HTTP error: tool-download-failed", async () => {
		const throwing = { fetch: async () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com")) };
		expect(await codeOf(install(throwing))).toBe("tool-download-failed");
		const failing = fakeGitHub({ overrides: { "https://release-assets.githubusercontent.com/github-production-release-asset/1/bin?sig=y": () => ({ status: 500 }) } });
		expect(await codeOf(install(failing))).toBe("tool-download-failed");
	});

	test("an unsupported platform has nothing to install: tool-missing", async () => {
		expect(await codeOf(install(fakeGitHub(), { platform: "linux", arch: "arm64" }))).toBe("tool-missing");
	});
});

describe("readManagedBinary", () => {
	test("valid install: the path and version; a tampered binary, a symlink, a broken manifest: null", async () => {
		const gitHub = fakeGitHub();
		await install(gitHub);
		const binDir = path.join(dir, "bin");
		const read = () => readManagedBinary({ binDir, platform: "linux", signingKey: TEST_KEY });
		expect(await read()).toEqual({ path: path.join(binDir, "yt-dlp"), version: "2025.09.26", sha256: sha(gitHub.binary) });

		fs.appendFileSync(path.join(binDir, "yt-dlp"), "x");
		expect(await read()).toBeNull();

		// Same size, other bytes: only the hash can tell.
		await install(gitHub);
		const original = fs.readFileSync(path.join(binDir, "yt-dlp"));
		const swapped = Buffer.from(original);
		swapped[0] ^= 0xff;
		fs.writeFileSync(path.join(binDir, "yt-dlp"), swapped);
		expect(await read()).toBeNull();

		await install(gitHub);
		const real = path.join(dir, "elsewhere");
		fs.copyFileSync(path.join(binDir, "yt-dlp"), real);
		fs.rmSync(path.join(binDir, "yt-dlp"));
		fs.symlinkSync(real, path.join(binDir, "yt-dlp"));
		expect(await read()).toBeNull();

		await install(gitHub);
		// verified with another key than the one asked for (the default: yt-dlp's), or before
		// signatures were checked (no signingKey in the manifest): not used, downloaded again
		expect(await readManagedBinary({ binDir, platform: "linux" })).toBeNull();
		const manifestPath = path.join(binDir, "yt-dlp.manifest.json");
		const { signingKey, ...unsigned } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		expect(signingKey).toBe(TEST_KEY.fingerprint);
		fs.writeFileSync(manifestPath, JSON.stringify(unsigned));
		expect(await read()).toBeNull();
		// An installed copy older than the floor is not used (a raised MIN_VERSION replaces it).
		fs.writeFileSync(manifestPath, JSON.stringify({ ...unsigned, signingKey, version: "2025.02.19" }));
		expect(await read()).toBeNull();
		fs.writeFileSync(manifestPath, JSON.stringify({ ...unsigned, signingKey }));
		expect(await read()).not.toBeNull();

		fs.writeFileSync(path.join(binDir, "yt-dlp.manifest.json"), "{not json");
		expect(await read()).toBeNull();
		fs.writeFileSync(path.join(binDir, "yt-dlp.manifest.json"), JSON.stringify({ version: "x", sha256: "y" }));
		expect(await read()).toBeNull();
		fs.rmSync(path.join(binDir, "yt-dlp.manifest.json"));
		expect(await read()).toBeNull();
	});
});

describe("sweepToolLeftovers", () => {
	test("removes temporary downloads from an earlier run, nothing else", async () => {
		const binDir = path.join(dir, "bin");
		fs.mkdirSync(binDir);
		fs.writeFileSync(path.join(binDir, ".yt-dlp-0123456789abcdef.download"), "partial");
		fs.writeFileSync(path.join(binDir, ".yt-dlp-0123456789abcdef.manifest"), "partial");
		fs.writeFileSync(path.join(binDir, "yt-dlp"), "keep");
		fs.writeFileSync(path.join(binDir, "notes.txt"), "keep");
		await sweepToolLeftovers({ binDir });
		expect(fs.readdirSync(binDir).sort()).toEqual(["notes.txt", "yt-dlp"]);
		await sweepToolLeftovers({ binDir: path.join(dir, "missing") });
	});
});

describe("createToolResolver", () => {
	const managed = { path: "/data/bin/yt-dlp", version: "2025.09.26", sha256: "a".repeat(64) };
	const resolver = (overrides = {}) => {
		const calls = { consent: 0, install: 0, version: [] };
		const deps = {
			envPath: "/usr/bin",
			platform: "linux",
			arch: "x64",
			findOnPath: async () => null,
			runVersion: async ({ binary }) => {
				calls.version.push(binary);
				return "2025.09.26\n";
			},
			readManaged: async () => null,
			confirmDownload: async () => {
				calls.consent++;
				return true;
			},
			install: async () => {
				calls.install++;
				return { ...managed, size: 10 };
			},
			log: () => {},
			...overrides,
		};
		return { resolve: createToolResolver(deps), calls };
	};

	test("yt-dlp on PATH that is new enough is used; no consent asked, nothing downloaded", async () => {
		const { resolve, calls } = resolver({ findOnPath: async () => "/usr/bin/yt-dlp" });
		expect(await resolve({ onPhase: () => {} })).toEqual({ binary: "/usr/bin/yt-dlp", version: "2025.09.26", source: "path" });
		expect(calls).toEqual({ consent: 0, install: 0, version: ["/usr/bin/yt-dlp"] });
	});

	test("yt-dlp on PATH that is too old, or does not answer with a version: the managed one is used instead", async () => {
		for (const runVersion of [async () => "2023.03.04\n", async () => "2025.03.20.1\n", async () => "garbage", async () => Promise.reject(new Error("ENOENT"))]) {
			const logs = [];
			const { resolve, calls } = resolver({ findOnPath: async () => "/usr/bin/yt-dlp", runVersion, readManaged: async () => managed, log: (line) => logs.push(line) });
			expect(await resolve({ onPhase: () => {} })).toEqual({ binary: managed.path, version: managed.version, source: "managed" });
			expect(calls.consent).toBe(0);
			expect(logs.some((line) => line.includes("/usr/bin/yt-dlp") && line.includes("2025.03.21"))).toBe(true);
		}
	});

	test("the floor is 2025.03.21 (--no-plugin-dirs, the newest option Ccut passes); exactly that version is used", async () => {
		expect(MIN_VERSION).toBe("2025.03.21");
		for (const text of ["2025.03.21\n", "2025.03.21.1\n", "2026.08.19\n"]) {
			const { resolve } = resolver({ findOnPath: async () => "/usr/bin/yt-dlp", runVersion: async () => text });
			expect(await resolve({ onPhase: () => {} })).toEqual({ binary: "/usr/bin/yt-dlp", version: text.trim(), source: "path" });
		}
	});

	test("PATH yt-dlp too old and no managed copy: the consent dialog hears which one and its version; declining is tool-outdated", async () => {
		const seen = [];
		const { resolve, calls } = resolver({
			findOnPath: async () => "/usr/bin/yt-dlp",
			runVersion: async () => "2025.02.19\n",
			confirmDownload: async (context) => {
				seen.push(context);
				return false;
			},
		});
		expect(await codeOf(resolve({ onPhase: () => {} }))).toBe("tool-outdated");
		expect(seen).toEqual([{ asset: "yt-dlp_linux", signal: undefined, outdated: { binary: "/usr/bin/yt-dlp", version: "2025.02.19" } }]);
		expect(calls.install).toBe(0);
	});

	test("PATH yt-dlp too old, consent given: the verified managed copy is downloaded and used", async () => {
		const { resolve, calls } = resolver({ findOnPath: async () => "/usr/bin/yt-dlp", runVersion: async () => "2024.04.09\n" });
		expect(await resolve({ onPhase: () => {} })).toEqual({ binary: managed.path, version: managed.version, source: "managed" });
		expect(calls).toMatchObject({ consent: 1, install: 1 });
	});

	test("PATH yt-dlp too old on a platform without an official binary: tool-outdated (not tool-missing), no consent asked", async () => {
		const { resolve, calls } = resolver({ arch: "arm64", findOnPath: async () => "/usr/bin/yt-dlp", runVersion: async () => "2024.04.09\n" });
		expect(await codeOf(resolve({ onPhase: () => {} }))).toBe("tool-outdated");
		expect(calls.consent).toBe(0);
	});

	test("a PATH yt-dlp that does not answer with a version is not called outdated: declining stays consent-declined", async () => {
		const seen = [];
		const { resolve } = resolver({
			findOnPath: async () => "/usr/bin/yt-dlp",
			runVersion: async () => "garbage",
			confirmDownload: async (context) => {
				seen.push(context.outdated);
				return false;
			},
		});
		expect(await codeOf(resolve({ onPhase: () => {} }))).toBe("consent-declined");
		expect(seen).toEqual([null]);
	});

	test("nothing installed: consent, then the verified download; phases reported in order", async () => {
		const phases = [];
		const { resolve, calls } = resolver();
		expect(await resolve({ onPhase: (phase) => phases.push(phase) })).toEqual({ binary: managed.path, version: managed.version, source: "managed" });
		expect(calls.consent).toBe(1);
		expect(calls.install).toBe(1);
		expect(phases).toEqual(["tool-check", "consent", "tool-download"]);
	});

	test("the job's signal, env and cwd reach the version check, the dialog and the download", async () => {
		const seen = {};
		const controller = new AbortController();
		const env = { PATH: "/usr/bin" };
		const { resolve } = resolver({
			findOnPath: async () => "/usr/bin/yt-dlp",
			runVersion: async (context) => {
				seen.version = context;
				return "2001.01.01\n"; // too old: falls through to the managed copy
			},
			confirmDownload: async (context) => {
				seen.consent = context;
				return true;
			},
			install: async (context) => {
				seen.install = context;
				return { ...managed, size: 10 };
			},
		});
		await resolve({ onPhase: () => {}, signal: controller.signal, env, cwd: "/job" });
		expect(seen.version).toEqual({ binary: "/usr/bin/yt-dlp", env, cwd: "/job", signal: controller.signal });
		expect(seen.consent).toEqual({ asset: "yt-dlp_linux", signal: controller.signal, outdated: { binary: "/usr/bin/yt-dlp", version: "2001.01.01" } });
		expect(seen.install).toEqual({ signal: controller.signal });
	});

	test("Cancel while the consent dialog is open: consent-declined even if the dialog answered yes", async () => {
		const controller = new AbortController();
		const { resolve, calls } = resolver({
			confirmDownload: async () => {
				controller.abort();
				return true;
			},
		});
		expect(await codeOf(resolve({ onPhase: () => {}, signal: controller.signal }))).toBe("consent-declined");
		expect(calls.install).toBe(0);
	});

	test("consent declined (no yt-dlp on PATH): consent-declined and no download", async () => {
		const { resolve, calls } = resolver({ confirmDownload: async () => false });
		expect(await codeOf(resolve({ onPhase: () => {} }))).toBe("consent-declined");
		expect(calls.install).toBe(0);
	});

	test("no official binary for this platform: tool-missing, no consent asked", async () => {
		const { resolve, calls } = resolver({ arch: "arm64" });
		expect(await codeOf(resolve({ onPhase: () => {} }))).toBe("tool-missing");
		expect(calls.consent).toBe(0);
	});
});
