import { describe, expect, it } from "bun:test";
import {
	detectFontFormat,
	inferStyleFromFileName,
	parseFontFile,
	readSfntInfo,
	sanitizeFamilyName,
} from "../font-file";
import { bufferFromAscii, buildSfnt, WINDOWS_ENGLISH } from "./sfnt-builder";

describe("detectFontFormat", () => {
	it("recognizes TrueType, OpenType-CFF, 'true', WOFF and WOFF2", () => {
		expect(detectFontFormat({ buffer: buildSfnt() })).toBe("ttf");
		expect(detectFontFormat({ buffer: buildSfnt({ magic: 0x74727565 }) })).toBe(
			"ttf",
		);
		expect(detectFontFormat({ buffer: buildSfnt({ magic: 0x4f54544f }) })).toBe(
			"otf",
		);
		expect(
			detectFontFormat({ buffer: bufferFromAscii({ text: "wOFF" }) }),
		).toBe("woff");
		expect(
			detectFontFormat({ buffer: bufferFromAscii({ text: "wOF2" }) }),
		).toBe("woff2");
	});

	it("rejects font collections, HTML, zero-filled and tiny buffers", () => {
		expect(
			detectFontFormat({ buffer: bufferFromAscii({ text: "ttcf" }) }),
		).toBeNull();
		expect(
			detectFontFormat({
				buffer: bufferFromAscii({ text: "<!DOCTYPE html>" }),
			}),
		).toBeNull();
		expect(detectFontFormat({ buffer: new ArrayBuffer(64) })).toBeNull();
		expect(detectFontFormat({ buffer: new ArrayBuffer(0) })).toBeNull();
		const tiny = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(detectFontFormat({ buffer: tiny.buffer })).toBeNull();
	});
});

describe("readSfntInfo", () => {
	it("prefers typographic family (ID 16) over family (ID 1)", () => {
		const buffer = buildSfnt({
			names: [
				{ ...WINDOWS_ENGLISH, nameID: 1, text: "Inter Bold" },
				{ ...WINDOWS_ENGLISH, nameID: 16, text: "Inter" },
			],
		});
		expect(readSfntInfo({ buffer })?.family).toBe("Inter");
	});

	it("falls back to ID 1 when there is no ID 16", () => {
		const buffer = buildSfnt({
			names: [{ ...WINDOWS_ENGLISH, nameID: 1, text: "Lobster" }],
		});
		expect(readSfntInfo({ buffer })?.family).toBe("Lobster");
	});

	it("decodes UTF-16BE including non-ASCII characters", () => {
		const buffer = buildSfnt({
			names: [{ platformID: 0, nameID: 1, text: "Şahin Çağrı" }],
		});
		expect(readSfntInfo({ buffer })?.family).toBe("Şahin Çağrı");
	});

	it("reads Mac Roman ASCII records and skips non-ASCII ones", () => {
		const ascii = buildSfnt({
			names: [{ platformID: 1, nameID: 1, text: "MacFont" }],
		});
		expect(readSfntInfo({ buffer: ascii })?.family).toBe("MacFont");
		const nonAscii = buildSfnt({
			names: [{ platformID: 1, nameID: 1, text: "Caf\u008e" }],
		});
		expect(readSfntInfo({ buffer: nonAscii })?.family).toBeNull();
	});

	it("prefers the Windows English record over other platforms", () => {
		const buffer = buildSfnt({
			names: [
				{ platformID: 1, nameID: 1, text: "Mac Name" },
				{
					platformID: 3,
					encodingID: 1,
					languageID: 0x41f,
					nameID: 1,
					text: "Turkce Ad",
				},
				{ ...WINDOWS_ENGLISH, nameID: 1, text: "English Name" },
			],
		});
		expect(readSfntInfo({ buffer })?.family).toBe("English Name");
	});

	it("returns a null family when no name table or no usable record exists", () => {
		expect(
			readSfntInfo({ buffer: buildSfnt({ weightClass: 400 }) })?.family,
		).toBeNull();
		const buffer = buildSfnt({
			names: [{ ...WINDOWS_ENGLISH, nameID: 4, text: "Full Name Only" }],
		});
		expect(readSfntInfo({ buffer })?.family).toBeNull();
	});

	it("reads usWeightClass and treats 0 as unknown", () => {
		expect(
			readSfntInfo({ buffer: buildSfnt({ weightClass: 700 }) })?.weightClass,
		).toBe(700);
		expect(
			readSfntInfo({ buffer: buildSfnt({ weightClass: 0 }) })?.weightClass,
		).toBeNull();
		expect(readSfntInfo({ buffer: buildSfnt() })?.weightClass).toBeNull();
	});

	it("clamps usWeightClass to 1..1000", () => {
		expect(
			readSfntInfo({ buffer: buildSfnt({ weightClass: 65535 }) })?.weightClass,
		).toBe(1000);
	});

	it("detects italic from fsSelection bit 0, bit 9 and head.macStyle bit 1", () => {
		expect(
			readSfntInfo({
				buffer: buildSfnt({ weightClass: 400, fsSelection: 0x1 }),
			})?.italic,
		).toBe(true);
		expect(
			readSfntInfo({
				buffer: buildSfnt({ weightClass: 400, fsSelection: 0x200 }),
			})?.italic,
		).toBe(true);
		expect(readSfntInfo({ buffer: buildSfnt({ macStyle: 0x2 }) })?.italic).toBe(
			true,
		);
		expect(
			readSfntInfo({
				buffer: buildSfnt({ weightClass: 400, fsSelection: 0x40, macStyle: 0 }),
			})?.italic,
		).toBe(false);
	});

	it("returns null for a truncated table directory", () => {
		const full = buildSfnt({ weightClass: 400, macStyle: 0 });
		expect(readSfntInfo({ buffer: full.slice(0, 20) })).toBeNull();
		expect(readSfntInfo({ buffer: full.slice(0, 12) })).toBeNull();
	});

	it("returns null when a table offset or length points outside the buffer", () => {
		const names = [{ ...WINDOWS_ENGLISH, nameID: 1, text: "Broken" }];
		const cases = [
			buildSfnt({ names, tableOverrides: { name: { offset: 0xfffffff0 } } }),
			buildSfnt({ names, tableOverrides: { name: { length: 0x7fffffff } } }),
			buildSfnt({
				weightClass: 400,
				tableOverrides: { "OS/2": { offset: 5000 } },
			}),
			buildSfnt({ macStyle: 0, tableOverrides: { head: { length: 9999 } } }),
		];
		for (const buffer of cases) expect(readSfntInfo({ buffer })).toBeNull();
	});

	it("does not throw when name records point outside the name table", () => {
		const buffer = buildSfnt({
			names: [{ ...WINDOWS_ENGLISH, nameID: 1, text: "Whatever" }],
		});
		const view = new DataView(buffer);
		const nameTableOffset = view.getUint32(12 + 8);
		view.setUint16(nameTableOffset + 6 + 10, 0xffff);
		expect(() => readSfntInfo({ buffer })).not.toThrow();
		expect(readSfntInfo({ buffer })?.family).toBeNull();
	});

	it("does not throw on a huge numTables or random bytes", () => {
		const buffer = buildSfnt({ weightClass: 400 });
		new DataView(buffer).setUint16(4, 0xffff);
		expect(readSfntInfo({ buffer })).toBeNull();

		const noise = new Uint8Array(512).map((_, i) => (i * 37 + 11) & 0xff);
		new DataView(noise.buffer).setUint32(0, 0x00010000);
		expect(() => readSfntInfo({ buffer: noise.buffer })).not.toThrow();
	});
});

describe("readSfntInfo work limits", () => {
	function hostileNameTable({
		records,
		stringBytes,
	}: {
		records: number;
		stringBytes: number;
	}): Uint8Array {
		const stringOffset = 6 + 12 * records;
		const table = new Uint8Array(stringOffset + stringBytes);
		const view = new DataView(table.buffer);
		view.setUint16(2, records);
		view.setUint16(4, stringOffset);
		for (let i = 0; i < records; i++) {
			const record = 6 + 12 * i;
			view.setUint16(record, 3);
			view.setUint16(record + 2, 1);
			view.setUint16(record + 4, 0x409);
			view.setUint16(record + 6, 1);
			view.setUint16(record + 8, stringBytes);
		}
		// UTF-16BE spaces: every decode is empty once trimmed.
		for (let j = 0; j + 1 < stringBytes; j += 2) {
			view.setUint16(stringOffset + j, 0x20);
		}
		return table;
	}

	function timeParse({ rawNameTable }: { rawNameTable: Uint8Array }) {
		const buffer = buildSfnt({ rawNameTable, weightClass: 400 });
		const start = performance.now();
		const info = readSfntInfo({ buffer });
		return { info, elapsedMs: performance.now() - start };
	}

	it("skips records whose string is longer than 1024 bytes without decoding them", () => {
		const { info, elapsedMs } = timeParse({
			rawNameTable: hostileNameTable({ records: 5000, stringBytes: 60000 }),
		});
		expect(info?.family).toBeNull();
		expect(elapsedMs).toBeLessThan(200);
	});

	it("decodes each (name ID, platform rank) at most once, even when it decodes to nothing", () => {
		const { info, elapsedMs } = timeParse({
			rawNameTable: hostileNameTable({ records: 5000, stringBytes: 1000 }),
		});
		expect(info?.family).toBeNull();
		expect(elapsedMs).toBeLessThan(200);
	});

	it("falls back to a lower-ranked record after an empty higher-ranked one", () => {
		const buffer = buildSfnt({
			names: [
				{ ...WINDOWS_ENGLISH, nameID: 1, text: "   " },
				{ ...WINDOWS_ENGLISH, nameID: 1, text: "Skipped" },
				{ platformID: 0, nameID: 1, text: "Fallback" },
			],
		});
		expect(readSfntInfo({ buffer })?.family).toBe("Fallback");
	});

	it("reads at most 512 name records", () => {
		const junk = (count: number) =>
			Array.from({ length: count }, () => ({
				...WINDOWS_ENGLISH,
				nameID: 4,
				text: "x",
			}));
		const target = { ...WINDOWS_ENGLISH, nameID: 1, text: "Target" };

		const inside = buildSfnt({ names: [...junk(511), target] });
		expect(readSfntInfo({ buffer: inside })?.family).toBe("Target");

		const outside = buildSfnt({ names: [...junk(512), target] });
		expect(readSfntInfo({ buffer: outside })?.family).toBeNull();
	});

	it("ignores strings over 1024 bytes and caps decoded text at 256 bytes", () => {
		const buffer = buildSfnt({
			names: [
				{ ...WINDOWS_ENGLISH, nameID: 1, text: "L".repeat(600) },
				{ platformID: 0, nameID: 1, text: "Medium".repeat(70) },
			],
		});
		expect(readSfntInfo({ buffer })?.family).toHaveLength(128);
	});
});

describe("inferStyleFromFileName", () => {
	it("maps weight words from Thin to Black", () => {
		const cases: [string, number][] = [
			["Roboto-Thin.ttf", 100],
			["Roboto-ExtraLight.ttf", 200],
			["Roboto-Light.ttf", 300],
			["Roboto-Regular.ttf", 400],
			["Roboto-Medium.ttf", 500],
			["Roboto-SemiBold.ttf", 600],
			["Roboto-Bold.ttf", 700],
			["Roboto-ExtraBold.ttf", 800],
			["Roboto-Black.ttf", 900],
		];
		for (const [fileName, weight] of cases) {
			expect(inferStyleFromFileName({ fileName })).toEqual({
				family: "Roboto",
				weight,
				style: "normal",
			});
		}
	});

	it("detects italic and combined BoldItalic", () => {
		expect(inferStyleFromFileName({ fileName: "Inter-Italic.woff2" })).toEqual({
			family: "Inter",
			weight: 400,
			style: "italic",
		});
		expect(
			inferStyleFromFileName({ fileName: "Inter-BoldItalic.woff2" }),
		).toEqual({
			family: "Inter",
			weight: 700,
			style: "italic",
		});
	});

	it("handles space separated names and multi word families", () => {
		expect(inferStyleFromFileName({ fileName: "Roboto Light.ttf" })).toEqual({
			family: "Roboto",
			weight: 300,
			style: "normal",
		});
		expect(
			inferStyleFromFileName({ fileName: "Open Sans Extra Bold Italic.otf" }),
		).toEqual({
			family: "Open Sans",
			weight: 800,
			style: "italic",
		});
	});

	it("keeps names without a style suffix whole", () => {
		expect(inferStyleFromFileName({ fileName: "Press Start 2P.ttf" })).toEqual({
			family: "Press Start 2P",
			weight: 400,
			style: "normal",
		});
		expect(inferStyleFromFileName({ fileName: "Bold.ttf" })).toEqual({
			family: "Bold",
			weight: 400,
			style: "normal",
		});
		expect(inferStyleFromFileName({ fileName: "noextension" }).family).toBe(
			"noextension",
		);
	});
});

describe("sanitizeFamilyName", () => {
	it("removes quotes, backslashes and control characters", () => {
		expect(sanitizeFamilyName({ name: 'Foo"Bar\\' })).toBe("FooBar");
		expect(sanitizeFamilyName({ name: "Foo\r\nBar\u0000 Baz" })).toBe(
			"FooBarBaz",
		);
	});

	it("collapses whitespace and trims", () => {
		expect(sanitizeFamilyName({ name: "  My   Cool\t Font  " })).toBe(
			"My Cool Font",
		);
	});

	it("removes invisible format, private-use and lone surrogate characters", () => {
		expect(sanitizeFamilyName({ name: "Foo\u200bBar\u202eBaz\ufeff" })).toBe(
			"FooBarBaz",
		);
		expect(sanitizeFamilyName({ name: "A\ue000B\ud800C" })).toBe("ABC");
		expect(sanitizeFamilyName({ name: "Form\u000cFeed" })).toBe("FormFeed");
	});

	it("normalizes to NFC so equal names compare equal", () => {
		expect(sanitizeFamilyName({ name: "Cafe\u0301" })).toBe("Caf\u00e9");
	});

	it("limits the length to 64 characters", () => {
		expect(sanitizeFamilyName({ name: "a".repeat(200) })).toHaveLength(64);
	});

	it("returns an empty string for names with nothing usable", () => {
		expect(sanitizeFamilyName({ name: '"\\\n' })).toBe("");
		expect(sanitizeFamilyName({ name: "" })).toBe("");
	});
});

describe("parseFontFile", () => {
	it("uses name table, OS/2 weight and italic bit for TrueType files", () => {
		const buffer = buildSfnt({
			names: [{ ...WINDOWS_ENGLISH, nameID: 16, text: "Merriweather" }],
			weightClass: 700,
			fsSelection: 0x1,
		});
		expect(parseFontFile({ fileName: "whatever.ttf", buffer })).toEqual({
			ok: true,
			family: "Merriweather",
			weight: 700,
			style: "italic",
			format: "ttf",
		});
	});

	it("reports OpenType-CFF as otf", () => {
		const buffer = buildSfnt({
			magic: 0x4f54544f,
			names: [{ ...WINDOWS_ENGLISH, nameID: 1, text: "Cff Font" }],
			weightClass: 400,
		});
		const result = parseFontFile({ fileName: "x.otf", buffer });
		expect(result).toMatchObject({
			ok: true,
			family: "Cff Font",
			format: "otf",
		});
	});

	it("falls back to the file name when the font has no name or weight data", () => {
		const buffer = buildSfnt({ macStyle: 0 });
		expect(parseFontFile({ fileName: "Lato-BoldItalic.ttf", buffer })).toEqual({
			ok: true,
			family: "Lato",
			weight: 700,
			style: "italic",
			format: "ttf",
		});
	});

	it("takes name, weight and style from the file name for WOFF and WOFF2", () => {
		expect(
			parseFontFile({
				fileName: "Inter-BoldItalic.woff2",
				buffer: bufferFromAscii({ text: "wOF2" }),
			}),
		).toEqual({
			ok: true,
			family: "Inter",
			weight: 700,
			style: "italic",
			format: "woff2",
		});
		expect(
			parseFontFile({
				fileName: "Roboto Light.woff",
				buffer: bufferFromAscii({ text: "wOFF" }),
			}),
		).toEqual({
			ok: true,
			family: "Roboto",
			weight: 300,
			style: "normal",
			format: "woff",
		});
	});

	it("sanitizes the family taken from the font itself", () => {
		const buffer = buildSfnt({
			names: [{ ...WINDOWS_ENGLISH, nameID: 1, text: 'Evil"\\Name' }],
			weightClass: 400,
		});
		expect(parseFontFile({ fileName: "a.ttf", buffer })).toMatchObject({
			ok: true,
			family: "EvilName",
		});
	});

	it("uses the file name when the embedded family sanitizes to nothing", () => {
		const buffer = buildSfnt({
			names: [{ ...WINDOWS_ENGLISH, nameID: 1, text: '""' }],
			weightClass: 400,
		});
		expect(
			parseFontFile({ fileName: "Fallback Name.ttf", buffer }),
		).toMatchObject({
			ok: true,
			family: "Fallback Name",
		});
	});

	it("rejects files that are not fonts, whatever their extension", () => {
		const html = bufferFromAscii({ text: "<html><body>hi</body></html>" });
		expect(parseFontFile({ fileName: "fake.ttf", buffer: html })).toEqual({
			ok: false,
			reason: expect.any(String),
		});
		expect(
			parseFontFile({ fileName: "a.ttf", buffer: new ArrayBuffer(0) }).ok,
		).toBe(false);
		expect(
			parseFontFile({
				fileName: "a.ttc",
				buffer: bufferFromAscii({ text: "ttcf" }),
			}).ok,
		).toBe(false);
	});

	it("rejects corrupt sfnt data without throwing", () => {
		const truncated = buildSfnt({ weightClass: 400 }).slice(0, 20);
		expect(parseFontFile({ fileName: "a.ttf", buffer: truncated })).toEqual({
			ok: false,
			reason: expect.any(String),
		});
	});

	it("rejects a font that has no usable name at all", () => {
		const buffer = bufferFromAscii({ text: "wOFF" });
		expect(parseFontFile({ fileName: '".woff', buffer }).ok).toBe(false);
	});
});
