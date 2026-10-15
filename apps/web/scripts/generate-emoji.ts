/**
 * Generates the emoji sticker library: Microsoft Fluent Emoji (Flat style,
 * default skin tone) plus a search index with English and Turkish keywords.
 *
 * Output (under public/, committed):
 *   emoji/fluent-flat/<unicode-id>.svg   one SVG per emoji (root size set to 512)
 *   emoji/fluent-flat/LICENSE            Fluent Emoji licence (MIT), verbatim
 *   emoji/index.json                     compact index, loaded lazily by the app
 *   emoji/UNICODE-LICENSE.txt            Unicode License V3 for the CLDR data, verbatim
 *
 * Run: bun apps/web/scripts/generate-emoji.ts [--cache=<dir>] [--out=<dir>]
 * Needs network on the first run; downloads are cached (default
 * apps/web/.emoji-cache) and the output is byte-for-byte reproducible. Every
 * request has a 30 s timeout, cache and output files are written atomically
 * (an interrupted run cannot leave a truncated file), and a cached file that
 * fails validation is downloaded again.
 *
 * Upstream data is PINNED. To update, change the commits below, re-run and
 * review the diff (new emoji, changed keywords, licence text).
 */

import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildEmojiIndex,
	fluentUnicodeToId,
	listFluentFolders,
	mergeCldrAnnotations,
	parseCldrAnnotations,
	parseEmojiIndex,
	pickDefaultFlatSvgPath,
	type EmojiIndex,
	type FluentEmojiMetadata,
	type FluentEmojiRecord,
} from "../src/stickers/providers/emoji-index";
import { validateSvgAsset, withSvgSize } from "../src/stickers/providers/svg-asset";
import {
	downloadText,
	readThroughCache,
	removeStaleTemporaryFiles,
	writeFileIfChanged,
} from "./lib/cache-io";
import {
	assertTurkishCoverage,
	cachePath,
	verifySerializedIndex,
} from "./lib/generator-checks";

// microsoft/fluentui-emoji, branch main on 2026-10-03.
// Commit date 2026-08-24, "Pin GitHub Actions to full-length commit SHAs (#193)".
const FLUENT_COMMIT = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc";
// unicode-org/cldr tag release-48-2 (2026-03-16), the latest stable release.
const CLDR_COMMIT = "11299982335beb974c1c63c45265184e759c0f41";

/** Intrinsic size of every emoji sticker; the renderer rasterises at this size. */
const STICKER_SVG_SIZE = 512;
const DOWNLOAD_CONCURRENCY = 24;
const CLDR_FILES = {
	annotations: "common/annotations/tr.xml",
	annotationsDerived: "common/annotationsDerived/tr.xml",
	license: "LICENSE",
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, "..");

function readFlag({ name, fallback }: { name: string; fallback: string }) {
	const prefix = `--${name}=`;
	const argument = process.argv.find((value) => value.startsWith(prefix));
	return argument ? resolve(argument.slice(prefix.length)) : fallback;
}

const cacheDirectory = readFlag({
	name: "cache",
	fallback: join(webDirectory, ".emoji-cache"),
});
const outputDirectory = readFlag({
	name: "out",
	fallback: join(webDirectory, "public"),
});

type CacheValidator = ({ text }: { text: string }) => void;

function cached({
	cachePath,
	url,
	validate,
}: {
	cachePath: string;
	url: string;
	validate: CacheValidator;
}): Promise<string> {
	return readThroughCache({
		cachePath,
		download: () => downloadText({ url }),
		validate,
	});
}

const validateJson: CacheValidator = ({ text }) => void JSON.parse(text);

function validateLicense({ text }: { text: string }): void {
	if (!text.includes("Permission is hereby granted")) {
		throw new Error("Not a licence text");
	}
}

function validateAnnotations({ text }: { text: string }): void {
	if (!text.includes("<annotations>") || !text.trimEnd().endsWith("</ldml>")) {
		throw new Error("Incomplete CLDR annotations file");
	}
}

async function runPool<T>({
	items,
	limit,
	worker,
}: {
	items: T[];
	limit: number;
	worker: (item: T) => Promise<void>;
}): Promise<void> {
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			await worker(item);
		}
	});
	await Promise.all(runners);
}

function fluentRawUrl({ path }: { path: string }): string {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	return `https://raw.githubusercontent.com/microsoft/fluentui-emoji/${FLUENT_COMMIT}/${encoded}`;
}

function cldrRawUrl({ path }: { path: string }): string {
	return `https://raw.githubusercontent.com/unicode-org/cldr/${CLDR_COMMIT}/${path}`;
}

interface GitTree {
	sha: string;
	truncated: boolean;
	tree: { path: string; type: string }[];
}

async function loadFluentTree(): Promise<string[]> {
	const text = await cached({
		cachePath: cachePath({ cacheDirectory, commit: FLUENT_COMMIT, segments: ["fluent-tree.json"] }),
		url: `https://api.github.com/repos/microsoft/fluentui-emoji/git/trees/${FLUENT_COMMIT}?recursive=1`,
		validate: validateJson,
	});
	const tree = JSON.parse(text) as GitTree;
	if (tree.sha !== FLUENT_COMMIT) {
		throw new Error(`Cached Fluent tree is for ${tree.sha}, expected ${FLUENT_COMMIT}`);
	}
	if (tree.truncated) {
		throw new Error("Fluent tree listing is truncated; cannot enumerate all emoji");
	}
	return tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
}

/** One item per line so a data update shows up as a readable diff. */
function serializeIndex({ index }: { index: EmojiIndex }): string {
	const { items, ...header } = index;
	const head = JSON.stringify(header).slice(0, -1);
	return `${head},"items":[\n${items.map((item) => JSON.stringify(item)).join(",\n")}\n]}\n`;
}

async function main() {
	// Leftovers of an interrupted run (cache and output) are removed first.
	const swept =
		(await removeStaleTemporaryFiles({ directory: cacheDirectory })) +
		(await removeStaleTemporaryFiles({ directory: join(outputDirectory, "emoji") }));
	if (swept > 0) {
		console.log(`Removed ${swept} stale temporary file(s) of an interrupted run`);
	}

	const paths = await loadFluentTree();
	const folders = listFluentFolders({ paths });
	console.log(`Fluent Emoji ${FLUENT_COMMIT.slice(0, 7)}: ${folders.length} emoji folders`);

	const records: FluentEmojiRecord[] = [];
	const svgById = new Map<string, string>();
	let totalSvgBytes = 0;

	await runPool({
		items: folders,
		limit: DOWNLOAD_CONCURRENCY,
		worker: async (folder) => {
			const svgPath = pickDefaultFlatSvgPath({ paths, folder });
			if (!svgPath) {
				throw new Error(`No default Flat SVG for "${folder}"`);
			}
			const [metadataText, svgText] = await Promise.all([
				cached({
					cachePath: cachePath({ cacheDirectory, commit: FLUENT_COMMIT, segments: ["fluent", folder, "metadata.json"] }),
					url: fluentRawUrl({ path: `assets/${folder}/metadata.json` }),
					validate: validateJson,
				}),
				cached({
					cachePath: cachePath({ cacheDirectory, commit: FLUENT_COMMIT, segments: ["fluent", folder, "flat.svg"] }),
					url: fluentRawUrl({ path: svgPath }),
					validate: ({ text }) => validateSvgAsset({ svg: text, label: svgPath }),
				}),
			]);

			const metadata = JSON.parse(metadataText) as FluentEmojiMetadata;
			validateSvgAsset({ svg: svgText, label: svgPath });
			const id = fluentUnicodeToId({ unicode: metadata.unicode });
			const svg = withSvgSize({ svg: svgText, size: STICKER_SVG_SIZE });

			records.push({ folder, metadata });
			svgById.set(id, svg);
			totalSvgBytes += Buffer.byteLength(svg);
		},
	});

	const [annotationsXml, derivedXml, cldrLicense, fluentLicense] = await Promise.all([
		cached({
			cachePath: cachePath({ cacheDirectory, commit: CLDR_COMMIT, segments: ["cldr", "common_annotations_tr.xml"] }),
			url: cldrRawUrl({ path: CLDR_FILES.annotations }),
			validate: validateAnnotations,
		}),
		cached({
			cachePath: cachePath({ cacheDirectory, commit: CLDR_COMMIT, segments: ["cldr", "common_annotationsDerived_tr.xml"] }),
			url: cldrRawUrl({ path: CLDR_FILES.annotationsDerived }),
			validate: validateAnnotations,
		}),
		cached({
			cachePath: cachePath({ cacheDirectory, commit: CLDR_COMMIT, segments: ["cldr", "LICENSE"] }),
			url: cldrRawUrl({ path: CLDR_FILES.license }),
			validate: validateLicense,
		}),
		cached({
			cachePath: cachePath({ cacheDirectory, commit: FLUENT_COMMIT, segments: ["fluent", "LICENSE"] }),
			url: fluentRawUrl({ path: "LICENSE" }),
			validate: validateLicense,
		}),
	]);

	const cldr = mergeCldrAnnotations({
		base: parseCldrAnnotations({ xml: annotationsXml }),
		derived: parseCldrAnnotations({ xml: derivedXml }),
	});
	const index: EmojiIndex = {
		...buildEmojiIndex({ fluent: records, cldr }),
		source: { fluentEmoji: FLUENT_COMMIT, cldr: CLDR_COMMIT },
	};
	// Keep `source` right after `version` in the file.
	const ordered: EmojiIndex = {
		version: index.version,
		source: index.source,
		groups: index.groups,
		items: index.items,
	};

	// Everything is checked in memory first; nothing is written if it fails.
	const withTurkish = index.items.filter((item) => item.tr).length;
	assertTurkishCoverage({ withTurkish, total: index.items.length });
	const serializedIndex = serializeIndex({ index: ordered });
	verifySerializedIndex({
		serialized: serializedIndex,
		parse: ({ value }) => parseEmojiIndex({ value }),
		label: "emoji index",
	});

	const emojiDirectory = join(outputDirectory, "emoji");
	const svgDirectory = join(emojiDirectory, "fluent-flat");
	await mkdir(svgDirectory, { recursive: true });

	const ids = [...svgById.keys()].sort();
	await runPool({
		items: ids,
		limit: 32,
		worker: async (id) => {
			await writeFileIfChanged({
				path: join(svgDirectory, `${id}.svg`),
				content: svgById.get(id) as string,
			});
		},
	});
	await writeFileIfChanged({ path: join(svgDirectory, "LICENSE"), content: fluentLicense });
	await writeFileIfChanged({
		path: join(emojiDirectory, "UNICODE-LICENSE.txt"),
		content: cldrLicense,
	});
	await writeFileIfChanged({
		path: join(emojiDirectory, "index.json"),
		content: serializedIndex,
	});

	const stale = (await readdir(svgDirectory)).filter(
		(name) => name.endsWith(".svg") && !svgById.has(name.slice(0, -4)),
	);
	console.log(
		`Wrote ${ids.length} SVGs (${(totalSvgBytes / 1024 / 1024).toFixed(2)} MiB), ` +
			`${index.items.length} index items, ${index.groups.length} groups, ` +
			`Turkish names for ${withTurkish}/${index.items.length}`,
	);
	if (stale.length > 0) {
		console.warn(`Warning: ${stale.length} SVG files are not in the index (stale?): ${stale.slice(0, 5).join(", ")}`);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
