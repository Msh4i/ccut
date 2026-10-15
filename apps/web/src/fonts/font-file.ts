import { stripUnsafeFontNameChars } from "./font-family";
import type { CustomFontFormat, CustomFontStyle } from "./types";

export const MAX_FONT_FILE_BYTES = 20 * 1024 * 1024;
export const NOT_A_FONT_REASON = "Not a TTF, OTF, WOFF or WOFF2 font file.";

const MAX_FAMILY_LENGTH = 64;
const SFNT_HEADER_BYTES = 12;
const TABLE_RECORD_BYTES = 16;
const NAME_RECORD_BYTES = 12;
// Work limits for the untrusted name table: a crafted font can otherwise point
// thousands of records at one huge string and freeze parsing for seconds.
const MAX_NAME_RECORDS = 512;
const MAX_NAME_STRING_BYTES = 1024;
const MAX_DECODED_NAME_BYTES = 256;
const NAME_ID_FAMILY = 1;
const NAME_ID_TYPOGRAPHIC_FAMILY = 16;
const SFNT_TABLES_READ = new Set(["name", "OS/2", "head"]);

const MAGIC_TO_FORMAT: Record<number, CustomFontFormat> = {
	0x00010000: "ttf",
	0x74727565: "ttf", // "true"
	0x4f54544f: "otf", // "OTTO"
	0x774f4646: "woff", // "wOFF"
	0x774f4632: "woff2", // "wOF2"
};

const WEIGHT_WORDS: Record<string, number> = {
	thin: 100,
	hairline: 100,
	extralight: 200,
	ultralight: 200,
	light: 300,
	regular: 400,
	normal: 400,
	book: 400,
	medium: 500,
	semibold: 600,
	demibold: 600,
	bold: 700,
	extrabold: 800,
	ultrabold: 800,
	black: 900,
	heavy: 900,
};

const STYLE_WORD_PATTERN = [
	...Object.keys(WEIGHT_WORDS),
	"italic",
	"oblique",
].join("|");
const STYLE_SUFFIX = new RegExp(`^(?:${STYLE_WORD_PATTERN})+$`);
const STYLE_WORD = new RegExp(STYLE_WORD_PATTERN, "g");

export interface SfntInfo {
	family: string | null;
	weightClass: number | null;
	italic: boolean;
}

export type ParsedFont =
	| {
			ok: true;
			family: string;
			weight: number;
			style: CustomFontStyle;
			format: CustomFontFormat;
	  }
	| { ok: false; reason: string };

export function detectFontFormat({
	buffer,
}: {
	buffer: ArrayBuffer;
}): CustomFontFormat | null {
	if (buffer.byteLength < SFNT_HEADER_BYTES) return null;
	return MAGIC_TO_FORMAT[new DataView(buffer).getUint32(0)] ?? null;
}

type TableRange = { offset: number; length: number };

function readTableDirectory({
	view,
}: {
	view: DataView;
}): Map<string, TableRange> | null {
	const numTables = view.getUint16(4);
	if (SFNT_HEADER_BYTES + TABLE_RECORD_BYTES * numTables > view.byteLength) {
		return null;
	}

	const tables = new Map<string, TableRange>();
	for (let i = 0; i < numTables; i++) {
		const record = SFNT_HEADER_BYTES + TABLE_RECORD_BYTES * i;
		const tag = String.fromCharCode(
			view.getUint8(record),
			view.getUint8(record + 1),
			view.getUint8(record + 2),
			view.getUint8(record + 3),
		);
		if (!SFNT_TABLES_READ.has(tag) || tables.has(tag)) continue;

		const offset = view.getUint32(record + 8);
		const length = view.getUint32(record + 12);
		if (offset + length > view.byteLength) return null;
		tables.set(tag, { offset, length });
	}
	return tables;
}

function decodeNameString({
	view,
	start,
	length,
	platformID,
	encodingID,
}: {
	view: DataView;
	start: number;
	length: number;
	platformID: number;
	encodingID: number;
}): string | null {
	let text = "";
	if (platformID === 1) {
		if (encodingID !== 0) return null;
		for (let i = 0; i < length; i++) {
			const byte = view.getUint8(start + i);
			if (byte >= 0x80) return null;
			text += String.fromCharCode(byte);
		}
		return text;
	}

	for (let i = 0; i + 1 < length; i += 2) {
		text += String.fromCharCode(view.getUint16(start + i));
	}
	return text;
}

function rankNameRecord({
	platformID,
	languageID,
}: {
	platformID: number;
	languageID: number;
}): number {
	if (platformID === 3) return languageID === 0x409 ? 4 : 3;
	if (platformID === 0) return 2;
	if (platformID === 1 && languageID === 0) return 1;
	return 0;
}

function readFamilyName({
	view,
	table,
}: {
	view: DataView;
	table: TableRange;
}): string | null {
	if (table.length < 6) return null;

	const end = table.offset + table.length;
	const count = view.getUint16(table.offset + 2);
	const stringStart = table.offset + view.getUint16(table.offset + 4);
	const best = new Map<number, { rank: number; text: string }>();
	const decoded = new Set<string>();

	for (let i = 0; i < Math.min(count, MAX_NAME_RECORDS); i++) {
		const record = table.offset + 6 + NAME_RECORD_BYTES * i;
		if (record + NAME_RECORD_BYTES > end) break;

		const nameID = view.getUint16(record + 6);
		if (nameID !== NAME_ID_FAMILY && nameID !== NAME_ID_TYPOGRAPHIC_FAMILY) {
			continue;
		}

		const platformID = view.getUint16(record);
		const rank = rankNameRecord({
			platformID,
			languageID: view.getUint16(record + 4),
		});
		if (rank <= (best.get(nameID)?.rank ?? 0)) continue;

		const length = view.getUint16(record + 8);
		const start = stringStart + view.getUint16(record + 10);
		if (length > MAX_NAME_STRING_BYTES || start + length > end) continue;

		// One decode per (name ID, rank), whether or not it yields a name.
		const attempt = `${nameID}:${rank}`;
		if (decoded.has(attempt)) continue;
		decoded.add(attempt);

		const text = decodeNameString({
			view,
			start,
			length: Math.min(length, MAX_DECODED_NAME_BYTES),
			platformID,
			encodingID: view.getUint16(record + 2),
		})?.trim();
		if (text) best.set(nameID, { rank, text });
	}

	return (
		best.get(NAME_ID_TYPOGRAPHIC_FAMILY)?.text ??
		best.get(NAME_ID_FAMILY)?.text ??
		null
	);
}

/**
 * Reads family name, weight class and italic flag from the `name`, `OS/2` and
 * `head` tables of an sfnt font. The buffer is untrusted: every read is bounds
 * checked and the function never throws. Returns null if the table directory or
 * one of those tables does not fit inside the buffer.
 */
export function readSfntInfo({
	buffer,
}: {
	buffer: ArrayBuffer;
}): SfntInfo | null {
	try {
		const view = new DataView(buffer);
		const tables = readTableDirectory({ view });
		if (!tables) return null;

		const nameTable = tables.get("name");
		const os2 = tables.get("OS/2");
		const head = tables.get("head");

		const weightClass =
			os2 && os2.length >= 6 ? view.getUint16(os2.offset + 4) : 0;
		const fsSelection =
			os2 && os2.length >= 64 ? view.getUint16(os2.offset + 62) : 0;
		const macStyle =
			head && head.length >= 46 ? view.getUint16(head.offset + 44) : 0;

		return {
			family: nameTable ? readFamilyName({ view, table: nameTable }) : null,
			weightClass: weightClass === 0 ? null : Math.min(weightClass, 1000),
			italic: (fsSelection & 0x201) !== 0 || (macStyle & 0x2) !== 0,
		};
	} catch {
		return null;
	}
}

export function inferStyleFromFileName({ fileName }: { fileName: string }): {
	family: string;
	weight: number;
	style: CustomFontStyle;
} {
	const base = fileName.replace(/\.[^./\\]*$/, "");

	for (let i = 1; i < base.length; i++) {
		if (!/[\s_-]/.test(base[i])) continue;

		const family = base.slice(0, i).replace(/[\s_-]+$/, "");
		const suffix = base
			.slice(i + 1)
			.replace(/[\s_-]+/g, "")
			.toLowerCase();
		if (!family || !STYLE_SUFFIX.test(suffix)) continue;

		let weight = 400;
		let style: CustomFontStyle = "normal";
		for (const [word] of suffix.matchAll(STYLE_WORD)) {
			if (word === "italic" || word === "oblique") style = "italic";
			else weight = WEIGHT_WORDS[word];
		}
		return { family, weight, style };
	}

	return { family: base, weight: 400, style: "normal" };
}

export function sanitizeFamilyName({ name }: { name: string }): string {
	return stripUnsafeFontNameChars({ name })
		.replace(/["\\]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_FAMILY_LENGTH)
		.trimEnd();
}

export function parseFontFile({
	fileName,
	buffer,
}: {
	fileName: string;
	buffer: ArrayBuffer;
}): ParsedFont {
	const format = detectFontFormat({ buffer });
	if (!format) {
		return { ok: false, reason: NOT_A_FONT_REASON };
	}

	const fromFileName = inferStyleFromFileName({ fileName });
	let { family, weight, style } = fromFileName;

	if (format === "ttf" || format === "otf") {
		const info = readSfntInfo({ buffer });
		if (!info) {
			return { ok: false, reason: "The font file is corrupted or truncated." };
		}
		family = info.family ?? family;
		weight = info.weightClass ?? weight;
		if (info.italic) style = "italic";
	}

	const cleanFamily =
		sanitizeFamilyName({ name: family }) ||
		sanitizeFamilyName({ name: fromFileName.family });
	if (!cleanFamily) {
		return { ok: false, reason: "The font has no usable name." };
	}

	return { ok: true, family: cleanFamily, weight, style, format };
}
