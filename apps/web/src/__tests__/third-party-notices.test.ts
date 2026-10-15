import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// THIRD_PARTY_NOTICES.md is what lets Ccut ship bundled fonts and sticker
// libraries legally. It is written by hand, so this guard fails as soon as
// something is bundled without an entry (or a licence text drifts).

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const PUBLIC_DIRECTORY = join(REPOSITORY_ROOT, "apps/web/public");
const FONT_DIRECTORY = join(PUBLIC_DIRECTORY, "fonts/files");
const NOTICES_PATH = join(REPOSITORY_ROOT, "THIRD_PARTY_NOTICES.md");

interface FontManifestEntry {
	id: string;
	version: string;
}

function toLf({ text }: { text: string }): string {
	return text.replaceAll("\r\n", "\n");
}

function toPosix({ path }: { path: string }): string {
	return path.split(sep).join("/");
}

/** Font families (manifest.json keys) with no `- <Family> <version>:` line or no licence path. */
function findFontsWithoutNotice({
	notices,
	manifest,
}: {
	notices: string;
	manifest: Record<string, FontManifestEntry>;
}): string[] {
	const lines = notices.split("\n");
	return Object.entries(manifest)
		.filter(([family, { id, version }]) => {
			const line = lines.find((candidate) => candidate.startsWith(`- ${family} ${version}:`));
			return !line?.includes(`apps/web/public/fonts/files/${id}/LICENSE`);
		})
		.map(([family]) => family);
}

/** Bundled font folders that manifest.json does not list. */
function findUnlistedFontFolders({
	folders,
	manifest,
}: {
	folders: string[];
	manifest: Record<string, FontManifestEntry>;
}): string[] {
	const listed = new Set(Object.values(manifest).map((entry) => entry.id));
	return folders.filter((folder) => !listed.has(folder));
}

/** Licence files (repo-relative, POSIX) that the notices neither mention by path nor quote. */
function findLicensesWithoutNotice({
	notices,
	licenses,
}: {
	notices: string;
	licenses: { path: string; text: string }[];
}): string[] {
	return licenses
		.filter(({ path, text }) => !notices.includes(`\`${path}\``) || !notices.includes(toLf({ text }).trimEnd()))
		.map(({ path }) => path);
}

function listFiles({ directory }: { directory: string }): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory() ? listFiles({ directory: path }) : [path];
	});
}

const LICENSE_FILE_NAME = /(^|[-_.])licen[sc]e(\.txt|\.md)?$/i;

function readManifest(): Record<string, FontManifestEntry> {
	return JSON.parse(readFileSync(join(FONT_DIRECTORY, "manifest.json"), "utf8"));
}

/** Every licence file under public/ except the per-font ones (covered by the manifest). */
function readSharedLicenses(): { path: string; text: string }[] {
	return listFiles({ directory: PUBLIC_DIRECTORY })
		.filter((file) => !file.startsWith(`${FONT_DIRECTORY}${sep}`))
		.filter((file) => LICENSE_FILE_NAME.test(file.split(sep).pop() ?? ""))
		.map((file) => ({
			path: toPosix({ path: relative(REPOSITORY_ROOT, file) }),
			text: readFileSync(file, "utf8"),
		}));
}

describe("THIRD_PARTY_NOTICES.md", () => {
	const notices = readFileSync(NOTICES_PATH, "utf8");
	const manifest = readManifest();

	test(".gitattributes keeps it LF on Windows too (autocrlf would break the verbatim licence check)", () => {
		const attributes = readFileSync(join(REPOSITORY_ROOT, ".gitattributes"), "utf8");
		expect(attributes).toMatch(/^THIRD_PARTY_NOTICES\.md[ \t]+text[ \t]+eol=lf[ \t]*$/m);
	});

	test("exists at the repository root, with LF line endings", () => {
		expect(existsSync(NOTICES_PATH)).toBe(true);
		expect(notices).not.toContain("\r");
		expect(notices.length).toBeGreaterThan(10_000);
	});

	test("has an entry, with its licence path, for every bundled font family", () => {
		expect(Object.keys(manifest).length).toBeGreaterThan(0);
		expect(findFontsWithoutNotice({ notices, manifest })).toEqual([]);
	});

	test("states the number of bundled fonts, and it is the number in manifest.json", () => {
		const stated = /(\d+) font families are bundled/.exec(notices)?.[1];
		expect(Number(stated)).toBe(Object.keys(manifest).length);
	});

	test("every bundled font folder is in manifest.json, so none escapes the check above", () => {
		const folders = readdirSync(FONT_DIRECTORY).filter((name) =>
			statSync(join(FONT_DIRECTORY, name)).isDirectory(),
		);
		expect(findUnlistedFontFolders({ folders, manifest })).toEqual([]);
		for (const { id } of Object.values(manifest)) {
			expect(existsSync(join(FONT_DIRECTORY, id, "LICENSE"))).toBe(true);
		}
	});

	test("mentions every other licence file shipped under public/, and quotes it verbatim", () => {
		const licenses = readSharedLicenses();
		expect(licenses.map((license) => license.path).sort()).toEqual([
			"apps/web/public/emoji/UNICODE-LICENSE.txt",
			"apps/web/public/emoji/fluent-flat/LICENSE",
			"apps/web/public/flags/LICENSE",
			"apps/web/public/icons/phosphor/LICENSE",
		]);
		expect(findLicensesWithoutNotice({ notices, licenses })).toEqual([]);
	});

	test("every shipped asset folder is named with its owner and licence", () => {
		const required = [
			"apps/web/public/emoji/fluent-flat/",
			"apps/web/public/icons/phosphor/",
			"apps/web/public/flags/",
			"Copyright (c) Microsoft Corporation",
			"Copyright (c) 2023 Phosphor Icons",
			"Copyright (c) 2013 Panayiotis Lipiridis",
			"Copyright © 2004-2026 Unicode, Inc.",
			"Unicode License V3",
		];
		for (const fragment of required) {
			expect(notices).toContain(fragment);
		}
	});

	test("pins the upstream commits the sticker data came from", () => {
		for (const commit of [
			"1ffb34c752ecf5d402f04cfb4b392c77f57c54bc",
			"11299982335beb974c1c63c45265184e759c0f41",
			"7aa5b2bdddd570ece62c812c0cb588ccdc099e2e",
		]) {
			expect(notices).toContain(commit);
		}
	});

	test("states the licence of Ccut's own code and how npm dependencies are covered", () => {
		expect(notices).toContain("## Ccut's own code");
		expect(notices).toContain("`LICENSE` file at the repository root");
		expect(notices).toContain("Copyright 2025-2026 OpenCut");
		expect(notices).toContain("## 3. npm dependencies");
		expect(notices).toContain("lucide-react");
		expect(notices).toContain("ISC");
		expect(notices).toContain("bun pm ls");
		// The repository LICENSE it points at exists and matches what is quoted.
		expect(toLf({ text: readFileSync(join(REPOSITORY_ROOT, "LICENSE"), "utf8") })).toContain(
			"Copyright 2025-2026 OpenCut",
		);
	});
});

describe("the checks themselves (they must be able to fail)", () => {
	const manifest = {
		Inter: { id: "inter", version: "5.3.0" },
		"Open Sans": { id: "open-sans", version: "5.3.0" },
	};
	const complete = [
		"- Inter 5.3.0: OFL-1.1. Copyright 2016 (licence text: `apps/web/public/fonts/files/inter/LICENSE`)",
		"- Open Sans 5.3.0: OFL-1.1. Copyright 2020 (licence text: `apps/web/public/fonts/files/open-sans/LICENSE`)",
	].join("\n");

	test("a complete file passes", () => {
		expect(findFontsWithoutNotice({ notices: complete, manifest })).toEqual([]);
	});

	test("a missing family is reported", () => {
		const without = complete.split("\n")[0];
		expect(findFontsWithoutNotice({ notices: without, manifest })).toEqual(["Open Sans"]);
	});

	test("a family listed under another version, or without its licence path, is reported", () => {
		const oldVersion = complete.replace("Inter 5.3.0", "Inter 5.2.0");
		expect(findFontsWithoutNotice({ notices: oldVersion, manifest })).toEqual(["Inter"]);
		const noPath = complete.replace("`apps/web/public/fonts/files/inter/LICENSE`", "(none)");
		expect(findFontsWithoutNotice({ notices: noPath, manifest })).toEqual(["Inter"]);
	});

	test("a family whose name is only a prefix of another is not mistaken for it", () => {
		const prefixOnly = "- Open Sans Condensed 5.3.0: OFL-1.1. (apps/web/public/fonts/files/open-sans/LICENSE)";
		expect(findFontsWithoutNotice({ notices: prefixOnly, manifest: { "Open Sans": manifest["Open Sans"] } })).toEqual([
			"Open Sans",
		]);
	});

	test("a font folder missing from the manifest is reported", () => {
		expect(findUnlistedFontFolders({ folders: ["inter", "new-font"], manifest })).toEqual(["new-font"]);
	});

	test("a licence file not mentioned, or mentioned with edited text, is reported", () => {
		const license = { path: "apps/web/public/flags/LICENSE", text: "The MIT License\r\nCopyright (c) 2013 X\r\n" };
		const quoted = "see `apps/web/public/flags/LICENSE`\n```text\nThe MIT License\nCopyright (c) 2013 X\n```";
		expect(findLicensesWithoutNotice({ notices: quoted, licenses: [license] })).toEqual([]);
		expect(findLicensesWithoutNotice({ notices: "nothing", licenses: [license] })).toEqual([license.path]);
		const edited = quoted.replace("2013", "2014");
		expect(findLicensesWithoutNotice({ notices: edited, licenses: [license] })).toEqual([license.path]);
	});
});

// Section 4: the AAC encoder that MP4 export loads is WebAssembly built from
// FFmpeg (LGPL) inside an MPL-2.0 package. Removing or thinning the section, or
// bumping the pinned version without updating it, has to fail here.

const WASM_SECTION_HEADING = "## 4. WebAssembly encoders";
// sha256 of FFmpeg's COPYING.LGPLv2.1 (tag n8.0) with trailing whitespace trimmed.
const LGPL_TEXT_SHA256 = "9dbeb0f8568e2aa001500a3b7f4102deb2fcdaa4fb8eaa275b9a8810ef7b26db";
const LGPL_HEADING = "#### GNU Lesser General Public License 2.1";

interface EncoderVersions {
	mediabunny: string;
	aacEncoder: string;
}

function readPinnedEncoderVersions(): EncoderVersions {
	const manifest: { dependencies: Record<string, string> } = JSON.parse(
		readFileSync(join(REPOSITORY_ROOT, "apps/web/package.json"), "utf8"),
	);
	return {
		mediabunny: manifest.dependencies.mediabunny,
		aacEncoder: manifest.dependencies["@mediabunny/aac-encoder"],
	};
}

/** The text of section 4 (up to the next `## ` heading), or null when it is missing. */
function readWasmSection({ notices }: { notices: string }): string | null {
	const start = notices.indexOf(`\n${WASM_SECTION_HEADING}\n`);
	if (start === -1) return null;
	const bodyStart = start + WASM_SECTION_HEADING.length + 2;
	const next = notices.indexOf("\n## ", bodyStart);
	return notices.slice(bodyStart, next === -1 ? undefined : next);
}

/** Names of the facts section 4 must state that it does not. Empty = complete. */
function findWasmEncoderNoticeGaps({
	notices,
	versions,
}: {
	notices: string;
	versions: EncoderVersions;
}): string[] {
	const section = readWasmSection({ notices });
	if (section === null) return ["section 4 heading"];
	const required: [string, string][] = [
		["mediabunny with its pinned version", `**mediabunny** ${versions.mediabunny}`],
		["aac-encoder with its pinned version", `**@mediabunny/aac-encoder** ${versions.aacEncoder}`],
		["MPL-2.0 licence name", "Mozilla Public License 2.0 (SPDX: MPL-2.0)"],
		["where to get the MPL source", "https://github.com/Vanilagy/mediabunny"],
		["source tag commit", "b285360563b754546cbfb7bbcf853f107e1dd3b9"],
		["npm gitHead", "0d5bf18864438ef4db9ff76398c3dfd02b3d19b9"],
		["FFmpeg libavcodec entry", "**FFmpeg libavcodec**"],
		["LGPL licence name", "LGPL-2.1-or-later"],
		["embedded libavcodec version string", "Lavc62.23.103"],
		["the n8.0 version it is after", "n8.0 is 62.11.100"],
		["the n8.1 version it is before", "n8.1 is 62.28.100"],
		["that it is an unreleased snapshot", "unreleased snapshot between those two tags"],
		["why npm's gitHead differs from the tag commit", "Merge main into release for tag v1.41.0"],
		["that npm lists a provenance attestation", "SLSA provenance attestation"],
		["replacement means a rebuild", "Unmodified; to replace it, rebuild from source."],
		["no claim of LGPL conformance, not legal advice", "does not claim that this satisfies every condition"],
		["Emscripten runtime and its licences", "MIT and the University of Illinois/NCSA licence"],
		["the libc, unresearched", "musl"],
		["FFmpeg's own MIT/BSD-style files", "MIT/X11/BSD-style"],
		["that those components are unresearched", "have not been researched (`?`)"],
		["admission that the FFmpeg commit is not pinned", "the exact source revision is `?`"],
		["build recipe: disable-all", "--disable-all"],
		["build recipe: only the aac encoder", "--enable-encoder=aac"],
		["no GPL/nonfree flags in the recipe", "--enable-gpl"],
		["where FFmpeg source is", "https://github.com/FFmpeg/FFmpeg"],
		["inlined wasm, replaceable by another package build", "SINGLE_FILE"],
		["the one module that isolates the encoder", "apps/web/src/services/renderer/aac-encoder.ts"],
		["no patent claim, and that patents are unresearched", "has not been researched (`?`)"],
		["MPL text heading", "#### Mozilla Public License 2.0"],
		["LGPL text heading", LGPL_HEADING],
	];
	return required.filter(([, fragment]) => !section.includes(fragment)).map(([name]) => name);
}

/** The ```text block that follows `heading` in the notices, or null. */
function readLicenseBlock({ notices, heading }: { notices: string; heading: string }): string | null {
	const headingAt = notices.indexOf(heading);
	if (headingAt === -1) return null;
	const open = notices.indexOf("```text\n", headingAt);
	if (open === -1) return null;
	const bodyStart = open + "```text\n".length;
	const close = notices.indexOf("\n```", bodyStart);
	return close === -1 ? null : notices.slice(bodyStart, close);
}

describe("THIRD_PARTY_NOTICES.md, section 4 (WebAssembly encoders)", () => {
	const notices = readFileSync(NOTICES_PATH, "utf8");

	test("states, for the pinned versions, every fact the MPL-2.0 and LGPL-2.1 distribution needs", () => {
		const versions = readPinnedEncoderVersions();
		expect(versions.mediabunny).toMatch(/^\d+\.\d+\.\d+$/);
		expect(versions.aacEncoder).toBe(versions.mediabunny);
		expect(findWasmEncoderNoticeGaps({ notices, versions })).toEqual([]);
	});

	test("quotes the MPL-2.0 text of mediabunny and of @mediabunny/aac-encoder verbatim, by path", () => {
		const licenses = ["node_modules/mediabunny/LICENSE", "node_modules/@mediabunny/aac-encoder/LICENSE"].map(
			(path) => ({ path, text: readFileSync(join(REPOSITORY_ROOT, path), "utf8") }),
		);
		expect(findLicensesWithoutNotice({ notices, licenses })).toEqual([]);
	});

	test("quotes FFmpeg's LGPL-2.1 text unedited", () => {
		const text = readLicenseBlock({ notices, heading: LGPL_HEADING });
		expect(text).not.toBeNull();
		expect(text?.startsWith("                  GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999")).toBe(true);
		expect(createHash("sha256").update(text?.trimEnd() ?? "").digest("hex")).toBe(LGPL_TEXT_SHA256);
	});

	test("section 3 (npm dependencies) points at section 4 as the exception for these two packages", () => {
		const start = notices.indexOf("\n## 3. npm dependencies\n");
		const end = notices.indexOf(`\n${WASM_SECTION_HEADING}\n`);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(notices.slice(start, end)).toContain("covered, with their licence texts, in section 4");
	});
});

describe("the section 4 checks themselves (they must be able to fail)", () => {
	const versions = { mediabunny: "1.41.0", aacEncoder: "1.41.0" };
	const notices = readFileSync(NOTICES_PATH, "utf8");

	test("a file without section 4 is reported, whatever else it contains", () => {
		const without = notices.slice(0, notices.indexOf(`\n${WASM_SECTION_HEADING}\n`));
		expect(without.length).toBeGreaterThan(10_000);
		expect(findWasmEncoderNoticeGaps({ notices: without, versions })).toEqual(["section 4 heading"]);
	});

	test("a version bump that is not in the notices is reported", () => {
		const gaps = findWasmEncoderNoticeGaps({ notices, versions: { mediabunny: "1.99.0", aacEncoder: "1.99.0" } });
		expect(gaps).toEqual(["mediabunny with its pinned version", "aac-encoder with its pinned version"]);
	});

	test("dropping the FFmpeg entry, or the admission that its commit is unknown, is reported", () => {
		const noFfmpeg = notices.replace("**FFmpeg libavcodec**", "**something else**");
		expect(findWasmEncoderNoticeGaps({ notices: noFfmpeg, versions })).toContain("FFmpeg libavcodec entry");
		const noAdmission = notices.replaceAll("`?`", "known");
		expect(findWasmEncoderNoticeGaps({ notices: noAdmission, versions })).toContain(
			"admission that the FFmpeg commit is not pinned",
		);
	});

	test("an edited LGPL text no longer matches the pinned hash", () => {
		const text = readLicenseBlock({ notices, heading: LGPL_HEADING }) ?? "";
		const edited = text.replace("Version 2.1", "Version 2.2");
		expect(edited).not.toBe(text);
		expect(createHash("sha256").update(edited.trimEnd()).digest("hex")).not.toBe(LGPL_TEXT_SHA256);
	});
});
