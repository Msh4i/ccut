/**
 * Generates the icon sticker library from Phosphor Icons (regular and fill
 * weights; no duotone/bold/light/thin).
 *
 * Output (under public/icons/phosphor/, committed):
 *   <name>.svg        regular weight, e.g. heart.svg
 *   <name>-fill.svg   fill weight, e.g. heart-fill.svg
 *   index.json        compact index (names, groups, tags), loaded lazily by the app
 *   LICENSE           Phosphor Icons licence (MIT), verbatim from the package
 *
 * Input: the devDependency `@phosphor-icons/core` (official package, MIT).
 * Version is pinned by bun.lock, so the output is reproducible offline.
 *
 * Run: bun apps/web/scripts/generate-icons.ts [--out=<dir>]
 *
 * Decisions baked in:
 *  - Company logos (Phosphor's "brands" category and `*-logo` names) are NOT
 *    shipped: trademark risk. See `isBrandIcon`.
 *  - Icons are drawn in white (#FFFFFF). Stickers have no tint parameter, so
 *    the colour is fixed at generation time; white reads on most footage.
 *    Change ICON_COLOR and re-run to ship another neutral.
 *  - Root width/height are set to 512: the renderer rasterises a sticker at
 *    its intrinsic size and scales that, so the default 256 would look soft.
 */

import { icons } from "@phosphor-icons/core";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildIconsIndex,
	expandIconRecords,
	isBrandIcon,
	parseIconsIndex,
	type IconsIndex,
	type PhosphorCatalogEntry,
} from "../src/stickers/providers/icons-index";
import { validateSvgAsset, withSvgSize } from "../src/stickers/providers/svg-asset";
import { removeStaleTemporaryFiles, writeFileIfChanged } from "./lib/cache-io";
import { buildIconSvgs, verifySerializedIndex } from "./lib/generator-checks";

const ICON_COLOR = "#FFFFFF";
const STICKER_SVG_SIZE = 512;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, "..");

function readFlag({ name, fallback }: { name: string; fallback: string }) {
	const prefix = `--${name}=`;
	const argument = process.argv.find((value) => value.startsWith(prefix));
	return argument ? resolve(argument.slice(prefix.length)) : fallback;
}

const outputDirectory = join(
	readFlag({ name: "out", fallback: join(webDirectory, "public") }),
	"icons",
	"phosphor",
);

/** `<package>/dist/index.mjs` -> `<package>`. */
const packageDirectory = resolve(
	dirname(fileURLToPath(import.meta.resolve("@phosphor-icons/core"))),
	"..",
);

/** One item per line so a data update shows up as a readable diff. */
function serializeIndex({ index }: { index: IconsIndex }): string {
	const { items, ...header } = index;
	const head = JSON.stringify(header).slice(0, -1);
	return `${head},"items":[\n${items.map((item) => JSON.stringify(item)).join(",\n")}\n]}\n`;
}

async function buildIconSvg({
	weight,
	id,
}: {
	weight: "regular" | "fill";
	id: string;
}): Promise<string> {
	const sourcePath = join(packageDirectory, "assets", weight, `${id}.svg`);
	const source = await readFile(sourcePath, "utf8");
	if (!source.includes('fill="currentColor"')) {
		throw new Error(`${sourcePath}: expected fill="currentColor" on the root`);
	}
	const coloured = source.replace('fill="currentColor"', `fill="${ICON_COLOR}"`);
	if (coloured.includes("currentColor")) {
		throw new Error(`${sourcePath}: unexpected extra currentColor`);
	}
	validateSvgAsset({ svg: coloured, label: sourcePath });
	return withSvgSize({ svg: coloured, size: STICKER_SVG_SIZE });
}

async function main() {
	const catalog: PhosphorCatalogEntry[] = icons.map((icon) => ({
		name: icon.name,
		categories: icon.categories,
		figma_category: icon.figma_category,
		tags: icon.tags,
	}));
	const index = buildIconsIndex({ catalog });
	const packageJson = JSON.parse(
		await readFile(join(packageDirectory, "package.json"), "utf8"),
	) as { version: string };
	const ordered: IconsIndex = {
		version: index.version,
		source: { phosphorCore: packageJson.version },
		groups: index.groups,
		items: index.items,
	};

	const records = expandIconRecords({ index });

	// Everything is built and checked in memory first; nothing is written if any
	// icon or the index is invalid, so a failed run leaves the folder as it was.
	// The package names its files like the sticker ids: heart.svg, heart-fill.svg.
	const recordById = new Map(records.map((record) => [record.id, record]));
	const svgs = await buildIconSvgs({
		ids: records.map((record) => record.id),
		buildSvg: ({ id }) => {
			const record = recordById.get(id);
			if (!record) {
				throw new Error(`No icon record for ${id}`);
			}
			return buildIconSvg({ weight: record.weight, id });
		},
	});
	const serializedIndex = serializeIndex({ index: ordered });
	verifySerializedIndex({
		serialized: serializedIndex,
		parse: ({ value }) => parseIconsIndex({ value }),
		label: "icons index",
	});
	const license = await readFile(join(packageDirectory, "LICENSE"), "utf8");

	await removeStaleTemporaryFiles({ directory: outputDirectory });
	let totalBytes = 0;
	for (const [id, svg] of svgs) {
		totalBytes += Buffer.byteLength(svg);
		await writeFileIfChanged({ path: join(outputDirectory, `${id}.svg`), content: svg });
	}
	await writeFileIfChanged({ path: join(outputDirectory, "LICENSE"), content: license });
	await writeFileIfChanged({ path: join(outputDirectory, "index.json"), content: serializedIndex });

	const knownFiles = new Set(records.map((record) => `${record.id}.svg`));
	const stale = (await readdir(outputDirectory)).filter(
		(name) => name.endsWith(".svg") && !knownFiles.has(name),
	);
	const excluded = catalog.filter((entry) => isBrandIcon({ entry }));
	console.log(
		`Phosphor ${packageJson.version}: ${catalog.length} icons, ${excluded.length} brand logos excluded, ` +
			`${index.items.length} shipped x 2 weights = ${records.length} SVGs ` +
			`(${(totalBytes / 1024 / 1024).toFixed(2)} MiB), ${index.groups.length} groups`,
	);
	if (stale.length > 0) {
		console.warn(`Warning: ${stale.length} SVG files are not in the index (stale?): ${stale.slice(0, 5).join(", ")}`);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
