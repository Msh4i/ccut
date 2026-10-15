import { describe, expect, test } from "bun:test";
import { parseEmojiIndex } from "../../src/stickers/providers/emoji-index";
import { parseIconsIndex } from "../../src/stickers/providers/icons-index";
import {
	MIN_TURKISH_NAME_RATIO,
	assertTurkishCoverage,
	buildIconSvgs,
	cachePath,
	verifySerializedIndex,
} from "../lib/generator-checks";

const COMMIT = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc";

describe("assertTurkishCoverage (a CLDR update that drops the Turkish names must fail the run)", () => {
	test("accepts full and nearly full coverage", () => {
		expect(() => assertTurkishCoverage({ withTurkish: 1595, total: 1595 })).not.toThrow();
		expect(() => assertTurkishCoverage({ withTurkish: Math.ceil(1595 * MIN_TURKISH_NAME_RATIO), total: 1595 })).not.toThrow();
	});

	test("refuses coverage below the threshold, saying how bad it is", () => {
		expect(() => assertTurkishCoverage({ withTurkish: 1000, total: 1595 })).toThrow(/1000 of 1595.*63%/);
		expect(() => assertTurkishCoverage({ withTurkish: 0, total: 1595 })).toThrow();
		expect(() => assertTurkishCoverage({ withTurkish: Math.floor(1595 * MIN_TURKISH_NAME_RATIO) - 1, total: 1595 })).toThrow();
	});

	test("an empty catalog is an error too, not 100%", () => {
		expect(() => assertTurkishCoverage({ withTurkish: 0, total: 0 })).toThrow(/no emoji/i);
	});

	test("the threshold is strict enough to matter and not so strict that one gap fails", () => {
		expect(MIN_TURKISH_NAME_RATIO).toBeGreaterThanOrEqual(0.9);
		expect(MIN_TURKISH_NAME_RATIO).toBeLessThan(1);
	});
});

describe("cachePath (the download cache is tied to the pinned commit)", () => {
	test("puts files under <cache>/<commit>/...", () => {
		expect(cachePath({ cacheDirectory: "/cache", commit: COMMIT, segments: ["fluent", "Grinning face", "flat.svg"] })).toBe(
			`/cache/${COMMIT}/fluent/Grinning face/flat.svg`,
		);
	});

	test("two commits never share a cached file", () => {
		const other = "11299982335beb974c1c63c45265184e759c0f41";
		expect(cachePath({ cacheDirectory: "/cache", commit: COMMIT, segments: ["LICENSE"] })).not.toBe(
			cachePath({ cacheDirectory: "/cache", commit: other, segments: ["LICENSE"] }),
		);
	});

	test("refuses a commit that is not a full SHA (a branch name would defeat the pin)", () => {
		for (const commit of ["main", "HEAD", "", "1ffb34c", "../x", COMMIT.toUpperCase(), `${COMMIT}0`]) {
			expect(() => cachePath({ cacheDirectory: "/cache", commit, segments: ["x"] })).toThrow(/commit/i);
		}
	});

	test("refuses segments that could leave the cache directory", () => {
		for (const segment of ["..", ".", "", "a/b", "a\\b", "../x", "a\0b"]) {
			expect(() => cachePath({ cacheDirectory: "/cache", commit: COMMIT, segments: ["fluent", segment] })).toThrow(/segment/i);
		}
	});

	test("refuses every control character in a segment, not only NUL (newlines break logs and shells)", () => {
		for (const segment of ["a\nb", "a\rb", "a\tb", "a\x01b", "a\x1fb", "a\x7fb", "\n"]) {
			expect(() => cachePath({ cacheDirectory: "/cache", commit: COMMIT, segments: ["fluent", segment] })).toThrow(/segment/i);
		}
		// A space and non-ASCII letters are ordinary file names (the emoji folders have both).
		expect(() => cachePath({ cacheDirectory: "/cache", commit: COMMIT, segments: ["Grinning face", "çay.svg"] })).not.toThrow();
	});

	test("the message does not echo a control character", () => {
		let message = "";
		try {
			cachePath({ cacheDirectory: "/cache", commit: COMMIT, segments: ["a\nb"] });
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("segment");
		expect(message).not.toContain("\n");
	});
});

describe("buildIconSvgs (everything is built before anything is written)", () => {
	test("returns every icon's svg, in order", async () => {
		const svgs = await buildIconSvgs({ ids: ["a", "b-fill", "c"], buildSvg: async ({ id }) => `<svg>${id}</svg>` });
		expect([...svgs.keys()]).toEqual(["a", "b-fill", "c"]);
		expect(svgs.get("b-fill")).toBe("<svg>b-fill</svg>");
	});

	test("one invalid icon fails the whole build, naming it", async () => {
		await expect(
			buildIconSvgs({
				ids: ["a", "broken", "c"],
				buildSvg: async ({ id }) => {
					if (id === "broken") throw new Error("expected fill=currentColor");
					return `<svg>${id}</svg>`;
				},
			}),
		).rejects.toThrow(/broken[\s\S]*expected fill=currentColor/);
	});

	test("builds all of them even when one is slow: it is not a chain of awaits", async () => {
		const started = Date.now();
		await buildIconSvgs({
			ids: Array.from({ length: 20 }, (_, index) => `i${index}`),
			buildSvg: async ({ id }) => {
				await new Promise((done) => setTimeout(done, 30));
				return id;
			},
		});
		expect(Date.now() - started).toBeLessThan(400);
	});
});

describe("verifySerializedIndex (the file about to be written is read back through the app's own validator)", () => {
	const validEmoji = JSON.stringify({
		version: 1,
		groups: ["Symbols"],
		items: [{ id: "1f600", n: "grinning face", g: 0, k: [], kt: [] }],
	});

	test("returns the parsed index when it is valid", () => {
		const index = verifySerializedIndex({ serialized: validEmoji, parse: ({ value }) => parseEmojiIndex({ value }), label: "emoji index" });
		expect(index.items[0].id).toBe("1f600");
	});

	test("rejects an index the app would refuse, naming it", () => {
		const bad = JSON.stringify({ version: 1, groups: ["Symbols"], items: [{ id: "../etc/passwd", n: "x", g: 0, k: [], kt: [] }] });
		expect(() => verifySerializedIndex({ serialized: bad, parse: ({ value }) => parseEmojiIndex({ value }), label: "emoji index" })).toThrow(/emoji index/);
		expect(() => verifySerializedIndex({ serialized: "{ not json", parse: ({ value }) => parseIconsIndex({ value }), label: "icons index" })).toThrow(/icons index/);
	});

	test("works for the icons index too", () => {
		const icons = JSON.stringify({ version: 1, groups: ["Arrows"], items: [{ n: "arrow-up", g: 0, t: [] }] });
		expect(verifySerializedIndex({ serialized: icons, parse: ({ value }) => parseIconsIndex({ value }), label: "icons index" }).items).toHaveLength(1);
	});
});
