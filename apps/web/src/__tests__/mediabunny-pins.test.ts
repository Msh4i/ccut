import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// mediabunny and @mediabunny/aac-encoder must be the same exact version: the
// newest aac-encoder (1.61.0) imports `Logging`, which mediabunny 1.41.0 does
// not export, so a floating range would break MP4 audio on the next install
// (export-v2 A13, R10). Upgrading is a deliberate, joint change with an e2e run.

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");

// What 1.41.0 of each package is, so that a node_modules that differs from the
// lock (a re-published tarball, a hand edit, a different install) fails offline.
// Upgrading is a deliberate joint change: update these with the versions.
const PINNED = {
	mediabunny: {
		integrity: "sha512-cJWBHvAyRNgTbsx8Z2oHptX/PdiywwsS+GIvv2k9eioXSOzzAemBsHwf7jM6fvW3b65azvZGP9RLuO1DI8JmdA==",
		bundle: "node_modules/mediabunny/dist/bundles/mediabunny.mjs",
		bundleSha256: "0e978df952d606fdeafef1e90ad695886ffa1a4e64f4a39d77654ada006b4b99",
	},
	aacEncoder: {
		integrity: "sha512-myP827M3uOFXtiIw6NSN5o/NUCqhrHL/M6+bryo8xVn/w6dDMBB5Qm41JCXYg8aSOTvTm2lpVm7/htDrLPY5gw==",
		bundle: "node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.mjs",
		bundleSha256: "ee01db1834706b526959ef184581446285403c2194206580f46611b2b6c5105a",
	},
} as const;

function sha256OfFile({ path }: { path: string }): string {
	return createHash("sha256").update(readFileSync(join(REPOSITORY_ROOT, path))).digest("hex");
}
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function readJson({ path }: { path: string }): {
	version?: string;
	dependencies?: Record<string, string>;
} {
	return JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), "utf8"));
}

describe("mediabunny + @mediabunny/aac-encoder pins", () => {
	const dependencies = readJson({ path: "apps/web/package.json" }).dependencies ?? {};
	const mediabunny = dependencies.mediabunny;
	const aacEncoder = dependencies["@mediabunny/aac-encoder"];

	test("apps/web/package.json pins both to one exact version, with no range", () => {
		expect(mediabunny).toMatch(EXACT_VERSION);
		expect(aacEncoder).toMatch(EXACT_VERSION);
		expect(aacEncoder).toBe(mediabunny);
	});

	test("bun.lock resolves both to exactly that version", () => {
		const lock = readFileSync(join(REPOSITORY_ROOT, "bun.lock"), "utf8");
		const resolvedMediabunny = lock.match(/"mediabunny@([^"]+)"/g);
		expect(resolvedMediabunny).toEqual([`"mediabunny@${mediabunny}"`]);
		const resolvedEncoder = lock.match(/"@mediabunny\/aac-encoder@([^"]+)"/g);
		expect(resolvedEncoder).toEqual([`"@mediabunny/aac-encoder@${aacEncoder}"`]);
	});

	test("the installed packages are those versions", () => {
		expect(readJson({ path: "node_modules/mediabunny/package.json" }).version).toBe(mediabunny);
		expect(readJson({ path: "node_modules/@mediabunny/aac-encoder/package.json" }).version).toBe(aacEncoder);
	});

	test("bun.lock records the registry integrity (sha512) of both packages", () => {
		const lines = readFileSync(join(REPOSITORY_ROOT, "bun.lock"), "utf8").split("\n");
		const mediabunnyLine = lines.find((line) => line.includes('"mediabunny@'));
		const encoderLine = lines.find((line) => line.includes('"@mediabunny/aac-encoder@'));

		expect(mediabunnyLine).toContain(`"${PINNED.mediabunny.integrity}"`);
		expect(encoderLine).toContain(`"${PINNED.aacEncoder.integrity}"`);
	});

	test("the installed bundles are byte for byte the ones the lock was made for (sha256)", () => {
		expect(sha256OfFile({ path: PINNED.mediabunny.bundle })).toBe(PINNED.mediabunny.bundleSha256);
		expect(sha256OfFile({ path: PINNED.aacEncoder.bundle })).toBe(PINNED.aacEncoder.bundleSha256);
	});
});
