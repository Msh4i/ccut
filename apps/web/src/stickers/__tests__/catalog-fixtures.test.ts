import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	PUBLIC_DIRECTORY,
	hashTextFile,
	isInsideDirectory,
	loadSvgForUrl,
} from "./catalog-fixtures";

describe("isInsideDirectory", () => {
	const cases = [
		{
			api: path.posix,
			directory: "/app/public",
			inside: ["/app/public/emoji/a.svg", "/app/public/a.svg"],
			outside: [
				"/app/public",
				"/app",
				"/app/public/../secret.txt",
				"/app/public-evil/a.svg",
				"/etc/passwd",
			],
		},
		{
			api: path.win32,
			directory: "C:\\app\\public",
			inside: ["C:\\app\\public\\emoji\\a.svg", "C:\\app\\public\\a.svg", "c:\\APP\\public\\a.svg"],
			outside: [
				"C:\\app\\public",
				"C:\\app",
				"C:\\app\\public\\..\\secret.txt",
				"C:\\app\\public-evil\\a.svg",
				"D:\\app\\public\\a.svg",
				"\\\\server\\share\\a.svg",
			],
		},
	];

	for (const { api, directory, inside, outside } of cases) {
		test(`${api === path.win32 ? "Windows" : "POSIX"} paths: separators of the platform are understood`, () => {
			for (const candidate of inside) {
				expect(isInsideDirectory({ directory, candidate, pathApi: api })).toBe(true);
			}
			for (const candidate of outside) {
				expect(isInsideDirectory({ directory, candidate, pathApi: api })).toBe(false);
			}
		});
	}

	test("a file name that merely starts with two dots is still inside", () => {
		expect(
			isInsideDirectory({
				directory: "/app/public",
				candidate: "/app/public/..hidden.svg",
				pathApi: path.posix,
			}),
		).toBe(true);
	});
});

describe("loadSvgForUrl", () => {
	test("reads a same-origin URL from public/", () => {
		expect(loadSvgForUrl({ url: "/flags/tr.svg" })).toContain("<svg");
	});

	test("reads an inline data: URL, plain and base64", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
		expect(
			loadSvgForUrl({ url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }),
		).toBe(svg);
		expect(
			loadSvgForUrl({
				url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
			}),
		).toBe(svg);
	});

	test("rejects URLs that climb out of public/, however they are written", () => {
		for (const url of [
			"/../package.json",
			"/emoji/../../package.json",
			"/emoji/%2e%2e/%2e%2e/package.json",
			"/emoji/fluent-flat/../../../package.json",
		]) {
			expect(() => loadSvgForUrl({ url })).toThrow(/escapes public/);
		}
	});

	test("rejects cross-origin and protocol-relative URLs", () => {
		for (const url of ["https://example.com/a.svg", "//example.com/a.svg", "http://localhost/a.svg"]) {
			expect(() => loadSvgForUrl({ url })).toThrow(/Cross-origin/);
		}
	});

	test("the unknown placeholder an invalid id resolves to really does not exist", () => {
		expect(existsSync(path.join(PUBLIC_DIRECTORY, "emoji", "fluent-flat", "unknown.svg"))).toBe(false);
		expect(existsSync(path.join(PUBLIC_DIRECTORY, "icons", "phosphor", "unknown.svg"))).toBe(false);
	});
});

describe("hashTextFile", () => {
	test("is the same for LF and CRLF, different for different text", () => {
		expect(hashTextFile({ text: "a\r\nb\r\n" })).toBe(hashTextFile({ text: "a\nb\n" }));
		expect(hashTextFile({ text: "a\nb\n" })).not.toBe(hashTextFile({ text: "a\nc\n" }));
		expect(hashTextFile({ text: "abc" })).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});
