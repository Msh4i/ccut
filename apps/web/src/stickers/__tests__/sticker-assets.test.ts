import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STICKER_CATEGORIES } from "../categories";
import { createEmojiProvider } from "../providers/emoji";
import { createIconsProvider } from "../providers/icons";
import { registerDefaultStickerProviders } from "../providers";
import { stickersRegistry } from "../registry";
import { resolveStickerId } from "../resolver";
import { readSvgViewBox, validateSvgAsset } from "../providers/svg-asset";
import {
	PUBLIC_DIRECTORY,
	hashTextFile,
	isSameOriginOrInline,
	loadSvgForUrl,
	readEmojiIndexFromDisk,
	readIconsIndexFromDisk,
} from "./catalog-fixtures";

const EMOJI_DIRECTORY = join(PUBLIC_DIRECTORY, "emoji");
const EMOJI_SVG_DIRECTORY = join(EMOJI_DIRECTORY, "fluent-flat");
const ICONS_DIRECTORY = join(PUBLIC_DIRECTORY, "icons", "phosphor");

const emojiIndex = readEmojiIndexFromDisk();
const iconsIndex = readIconsIndexFromDisk();

/** Intrinsic size the renderer rasterises stickers at (see generate-*.ts). */
const EXPECTED_INTRINSIC_SIZE = 512;

function directoryBytes({ directory, extension }: { directory: string; extension: string }) {
	return readdirSync(directory)
		.filter((name) => name.endsWith(extension))
		.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
}

/** What `resolveStickerIntrinsicSize` would read from the loaded <img>. */
function rootSize({ svg }: { svg: string }) {
	const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
	return {
		width: Number(/\swidth="([^"]*)"/.exec(root)?.[1]),
		height: Number(/\sheight="([^"]*)"/.exec(root)?.[1]),
	};
}

describe("provider registration", () => {
	registerDefaultStickerProviders();

	test("emoji and icons are registered", () => {
		expect(stickersRegistry.has("emoji")).toBe(true);
		expect(stickersRegistry.has("icons")).toBe(true);
	});

	test("every provider with content has a category with the same key, the picker needs it", () => {
		// "logos" is an empty stub whose tab is deliberately disabled in categories.ts.
		const withContent = stickersRegistry.getAll().filter((provider) => provider.id !== "logos");
		expect(withContent.map((provider) => provider.id).sort()).toEqual(
			["emoji", "flags", "icons", "shapes"],
		);
		for (const provider of withContent) {
			expect(Object.keys(STICKER_CATEGORIES)).toContain(provider.id);
		}
	});

	test("the new tabs are labelled Emoji and Icons", () => {
		expect(STICKER_CATEGORIES).toMatchObject({ emoji: "Emoji", icons: "Icons" });
	});
});

describe("resolver -> asset (insert -> render path)", () => {
	const samples = [
		"emoji:1f600",
		"emoji:2764-fe0f",
		"emoji:1f468-200d-1f4bb",
		"emoji:1f525",
		"icons:heart",
		"icons:heart-fill",
		"icons:arrow-circle-up-right",
		"icons:arrow-circle-up-right-fill",
	];

	for (const stickerId of samples) {
		test(`${stickerId} resolves to a loadable, valid SVG with a viewBox`, () => {
			const url = resolveStickerId({ stickerId });
			expect(isSameOriginOrInline({ url })).toBe(true);

			const svg = loadSvgForUrl({ url });
			expect(() => validateSvgAsset({ svg, label: stickerId })).not.toThrow();
			const viewBox = readSvgViewBox({ svg });
			expect(viewBox?.width).toBeGreaterThan(0);
			expect(viewBox?.height).toBeGreaterThan(0);
		});

		test(`${stickerId} has a crisp intrinsic size, not the 32px/256px source size`, () => {
			const svg = loadSvgForUrl({ url: resolveStickerId({ stickerId }) });
			expect(rootSize({ svg })).toEqual({
				width: EXPECTED_INTRINSIC_SIZE,
				height: EXPECTED_INTRINSIC_SIZE,
			});
		});
	}

	test("a malformed id resolves to a placeholder that is missing, so it fails to load", () => {
		const cases = [
			{ stickerId: "emoji:../../package.json", url: "/emoji/fluent-flat/unknown.svg" },
			{ stickerId: "icons:../../package.json", url: "/icons/phosphor/unknown.svg" },
			{ stickerId: "emoji:zzz", url: "/emoji/fluent-flat/unknown.svg" },
		];
		for (const { stickerId, url } of cases) {
			// The URL stays inside its own folder (nothing was traversed)...
			expect(resolveStickerId({ stickerId })).toBe(url);
			// ...and fails because the file is missing, not because a guard fired.
			let failure: unknown;
			try {
				loadSvgForUrl({ url });
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "ENOENT" });
		}
	});
});

describe("no sticker URL is cross-origin (export canvas must stay clean)", () => {
	registerDefaultStickerProviders();

	test("every id of every shipped emoji and icon resolves to a same-origin URL", () => {
		const ids = [
			...emojiIndex.items.map((item) => `emoji:${item.id}`),
			...iconsIndex.items.flatMap((item) => [`icons:${item.n}`, `icons:${item.n}-fill`]),
		];
		expect(ids.length).toBe(emojiIndex.items.length + iconsIndex.items.length * 2);
		for (const stickerId of ids) {
			const url = resolveStickerId({ stickerId });
			if (!isSameOriginOrInline({ url })) {
				throw new Error(`Cross-origin URL for ${stickerId}: ${url}`);
			}
		}
	});

	test("preview URLs from browse and search are same-origin for every provider", async () => {
		const providers = [
			createEmojiProvider({ loadIndex: async () => emojiIndex }),
			createIconsProvider({ loadIndex: async () => iconsIndex }),
			...stickersRegistry.getAll().filter((provider) => ["flags", "shapes"].includes(provider.id)),
		];
		expect(providers).toHaveLength(4);

		for (const provider of providers) {
			const browsed = await provider.browse({});
			const searched = await provider.search({ query: "a", options: { limit: 1000 } });
			const items = [...browsed.sections.flatMap((section) => section.items), ...searched.items];
			expect(items.length).toBeGreaterThan(0);
			for (const item of items) {
				if (!isSameOriginOrInline({ url: item.previewUrl })) {
					throw new Error(`${provider.id}: cross-origin previewUrl ${item.previewUrl}`);
				}
				const resolved = provider.resolveUrl({ stickerId: item.id });
				if (!isSameOriginOrInline({ url: resolved })) {
					throw new Error(`${provider.id}: cross-origin resolveUrl ${resolved}`);
				}
			}
		}
	});
});

/**
 * SHA-256 of every licence the sticker libraries ship, taken from the upstream
 * files (Fluent Emoji and CLDR at the pinned commits, flag-icons v7.5.0,
 * @phosphor-icons/core 2.1.1). A changed hash means the notice text was edited
 * or upstream was updated: compare with upstream before updating it here.
 */
const PINNED_LICENSE_HASHES: Record<string, string> = {
	"emoji/fluent-flat/LICENSE": "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383",
	"emoji/UNICODE-LICENSE.txt": "b49d0e9f8ead51ca8b7df6fec89cc3ae6809198b4b9d43c74216da0118f23f5b",
	"icons/phosphor/LICENSE": "b5b1f1da112d18ea2147decfd48ddc1bf2b5aeb6c265381579340e95b15a2bb2",
	"flags/LICENSE": "8f1195d55a2fd315a07d812328470ca9ba2abb78c8d317ff19619d5125e00cea",
};

describe("shipped licence texts are the upstream texts, byte for byte", () => {
	for (const [relativePath, expectedHash] of Object.entries(PINNED_LICENSE_HASHES)) {
		test(relativePath, () => {
			const text = readFileSync(join(PUBLIC_DIRECTORY, relativePath), "utf8");
			expect(hashTextFile({ text })).toBe(expectedHash);
		});
	}
});

describe("emoji data shipped in public/emoji", () => {
	test("every index item has a valid SVG file and there are no orphan files", () => {
		const ids = emojiIndex.items.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);

		for (const id of ids) {
			const path = join(EMOJI_SVG_DIRECTORY, `${id}.svg`);
			expect(existsSync(path)).toBe(true);
			validateSvgAsset({ svg: readFileSync(path, "utf8"), label: path });
		}

		const files = readdirSync(EMOJI_SVG_DIRECTORY).filter((name) => name.endsWith(".svg"));
		expect(files.sort()).toEqual(ids.map((id) => `${id}.svg`).sort());
	});

	test("covers the whole Fluent set with Turkish names", () => {
		expect(emojiIndex.items.length).toBe(1595);
		expect(emojiIndex.groups).toHaveLength(9);
		expect(emojiIndex.items.filter((item) => item.tr).length).toBe(1595);
		expect(emojiIndex.items.every((item) => emojiIndex.groups[item.g] !== undefined)).toBe(true);
	});

	test("pins its sources", () => {
		expect(emojiIndex.source?.fluentEmoji).toMatch(/^[0-9a-f]{40}$/);
		expect(emojiIndex.source?.cldr).toMatch(/^[0-9a-f]{40}$/);
	});

	test("stays inside the size budget", () => {
		const svgBytes = directoryBytes({ directory: EMOJI_SVG_DIRECTORY, extension: ".svg" });
		expect(svgBytes).toBeLessThan(6 * 1024 * 1024);
		expect(statSync(join(EMOJI_DIRECTORY, "index.json")).size).toBeLessThan(512 * 1024);
	});

	test("ships the required licence notices verbatim", () => {
		const fluent = readFileSync(join(EMOJI_SVG_DIRECTORY, "LICENSE"), "utf8");
		expect(fluent).toContain("MIT License");
		expect(fluent).toContain("Copyright (c) Microsoft Corporation");

		const unicode = readFileSync(join(EMOJI_DIRECTORY, "UNICODE-LICENSE.txt"), "utf8");
		expect(unicode).toContain("UNICODE LICENSE V3");
		expect(unicode).toContain("COPYRIGHT AND PERMISSION NOTICE");
		expect(unicode).toContain("Copyright © 2004-2026 Unicode, Inc.");
		expect(unicode).toContain("THE DATA FILES AND SOFTWARE ARE PROVIDED \"AS IS\"");
	});
});

describe("icon data shipped in public/icons/phosphor", () => {
	test("every icon has a regular and a fill SVG, and there are no orphan files", () => {
		const expected: string[] = [];
		for (const item of iconsIndex.items) {
			for (const id of [item.n, `${item.n}-fill`]) {
				const path = join(ICONS_DIRECTORY, `${id}.svg`);
				expect(existsSync(path)).toBe(true);
				validateSvgAsset({ svg: readFileSync(path, "utf8"), label: path });
				expected.push(`${id}.svg`);
			}
		}
		const files = readdirSync(ICONS_DIRECTORY).filter((name) => name.endsWith(".svg"));
		expect(files.sort()).toEqual(expected.sort());
	});

	test("no company logo is shipped", () => {
		const names = iconsIndex.items.map((item) => item.n);
		expect(names.filter((name) => /-logo(-|$)/.test(name))).toEqual([]);
		for (const brand of ["github-logo", "google-logo", "facebook-logo", "x-logo", "windows-logo", "apple-logo"]) {
			expect(names).not.toContain(brand);
			expect(existsSync(join(ICONS_DIRECTORY, `${brand}.svg`))).toBe(false);
		}
		expect(names).toContain("parallelogram");
	});

	test("icons are drawn in one fixed neutral colour, with no currentColor left", () => {
		const svg = readFileSync(join(ICONS_DIRECTORY, "heart.svg"), "utf8");
		expect(svg).toContain('fill="#FFFFFF"');
		expect(svg).not.toContain("currentColor");
	});

	test("stays inside the size budget", () => {
		const svgBytes = directoryBytes({ directory: ICONS_DIRECTORY, extension: ".svg" });
		expect(svgBytes).toBeLessThan(5 * 1024 * 1024);
		expect(statSync(join(ICONS_DIRECTORY, "index.json")).size).toBeLessThan(512 * 1024);
	});

	test("ships the Phosphor licence", () => {
		const license = readFileSync(join(ICONS_DIRECTORY, "LICENSE"), "utf8");
		expect(license).toContain("MIT License");
		expect(license).toContain("Copyright (c) 2023 Phosphor Icons");
	});

	test("every group is used and every icon points at a group", () => {
		const usedGroups = new Set(iconsIndex.items.map((item) => item.g));
		expect(usedGroups.size).toBe(iconsIndex.groups.length);
		expect(iconsIndex.items.every((item) => iconsIndex.groups[item.g] !== undefined)).toBe(true);
	});
});

describe("every SVG that ships is valid, including the flags", () => {
	const FLAGS_DIRECTORY = join(PUBLIC_DIRECTORY, "flags");

	test("all 271 flags are complete, safe SVGs with a viewBox", () => {
		const files = readdirSync(FLAGS_DIRECTORY).filter((name) => name.endsWith(".svg"));
		expect(files.length).toBeGreaterThanOrEqual(200);
		for (const name of files) {
			const path = join(FLAGS_DIRECTORY, name);
			validateSvgAsset({ svg: readFileSync(path, "utf8"), label: path });
		}
	});

	test("every emoji, icon and flag passes the same structural checks", () => {
		let checked = 0;
		for (const directory of [EMOJI_SVG_DIRECTORY, ICONS_DIRECTORY, FLAGS_DIRECTORY]) {
			for (const name of readdirSync(directory).filter((file) => file.endsWith(".svg"))) {
				const path = join(directory, name);
				validateSvgAsset({ svg: readFileSync(path, "utf8"), label: path });
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(4_700);
	});
});
