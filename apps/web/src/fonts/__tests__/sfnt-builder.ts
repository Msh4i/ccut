interface NameRecordInput {
	platformID: number;
	encodingID?: number;
	languageID?: number;
	nameID: number;
	text: string;
}

interface SfntInput {
	magic?: number;
	names?: NameRecordInput[];
	/** A hand-built `name` table, for crafted or hostile inputs. */
	rawNameTable?: Uint8Array;
	weightClass?: number;
	fsSelection?: number;
	macStyle?: number;
	tableOverrides?: Partial<
		Record<string, { offset?: number; length?: number }>
	>;
}

export const WINDOWS_ENGLISH = {
	platformID: 3,
	encodingID: 1,
	languageID: 0x409,
};

function encodeNameText({
	platformID,
	text,
}: {
	platformID: number;
	text: string;
}): Uint8Array {
	if (platformID === 1) {
		return Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
	}
	const bytes = new Uint8Array(text.length * 2);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < text.length; i++)
		view.setUint16(i * 2, text.charCodeAt(i));
	return bytes;
}

function buildNameTable({ names }: { names: NameRecordInput[] }): Uint8Array {
	const encoded = names.map((name) => encodeNameText(name));
	const stringOffset = 6 + 12 * names.length;
	const total =
		stringOffset + encoded.reduce((sum, bytes) => sum + bytes.length, 0);
	const table = new Uint8Array(total);
	const view = new DataView(table.buffer);
	view.setUint16(2, names.length);
	view.setUint16(4, stringOffset);
	let cursor = 0;
	names.forEach((name, i) => {
		const record = 6 + 12 * i;
		view.setUint16(record, name.platformID);
		view.setUint16(record + 2, name.encodingID ?? 0);
		view.setUint16(record + 4, name.languageID ?? 0);
		view.setUint16(record + 6, name.nameID);
		view.setUint16(record + 8, encoded[i].length);
		view.setUint16(record + 10, cursor);
		table.set(encoded[i], stringOffset + cursor);
		cursor += encoded[i].length;
	});
	return table;
}

export function buildSfnt({
	magic = 0x00010000,
	names,
	rawNameTable,
	weightClass,
	fsSelection = 0,
	macStyle,
	tableOverrides = {},
}: SfntInput = {}): ArrayBuffer {
	const tables: { tag: string; data: Uint8Array }[] = [];
	if (rawNameTable) tables.push({ tag: "name", data: rawNameTable });
	else if (names) tables.push({ tag: "name", data: buildNameTable({ names }) });
	if (weightClass !== undefined) {
		const os2 = new Uint8Array(78);
		const view = new DataView(os2.buffer);
		view.setUint16(4, weightClass);
		view.setUint16(62, fsSelection);
		tables.push({ tag: "OS/2", data: os2 });
	}
	if (macStyle !== undefined) {
		const head = new Uint8Array(54);
		new DataView(head.buffer).setUint16(44, macStyle);
		tables.push({ tag: "head", data: head });
	}
	tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));

	const directorySize = 12 + 16 * tables.length;
	const total = tables.reduce(
		(sum, table) => sum + Math.ceil(table.data.length / 4) * 4,
		directorySize,
	);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, magic);
	view.setUint16(4, tables.length);

	let cursor = directorySize;
	tables.forEach((table, i) => {
		const record = 12 + 16 * i;
		const override = tableOverrides[table.tag];
		for (let c = 0; c < 4; c++) out[record + c] = table.tag.charCodeAt(c);
		view.setUint32(record + 8, override?.offset ?? cursor);
		view.setUint32(record + 12, override?.length ?? table.data.length);
		out.set(table.data, cursor);
		cursor += Math.ceil(table.data.length / 4) * 4;
	});
	return out.buffer;
}

export function bufferFromAscii({
	text,
	size = 64,
}: {
	text: string;
	size?: number;
}) {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	return bytes.buffer;
}
