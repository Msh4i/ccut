import { describe, expect, it } from "bun:test";
import { formatFontNameList, quoteFontFamily } from "../font-family";

describe("quoteFontFamily", () => {
	it("quotes plain family names, including names a bare identifier cannot express", () => {
		expect(quoteFontFamily({ fontFamily: "Arial" })).toBe('"Arial"');
		expect(quoteFontFamily({ fontFamily: "Press Start 2P" })).toBe(
			'"Press Start 2P"',
		);
		expect(quoteFontFamily({ fontFamily: "2Pac" })).toBe('"2Pac"');
	});

	it("escapes double quotes", () => {
		expect(quoteFontFamily({ fontFamily: 'Foo"Bar' })).toBe('"Foo\\"Bar"');
	});

	it("escapes backslashes so a trailing backslash cannot close the string early", () => {
		expect(quoteFontFamily({ fontFamily: "Foo\\" })).toBe('"Foo\\\\"');
		expect(quoteFontFamily({ fontFamily: 'a\\"b' })).toBe('"a\\\\\\"b"');
	});

	it("leaves CSS generic family keywords unquoted", () => {
		expect(quoteFontFamily({ fontFamily: "serif" })).toBe("serif");
		expect(quoteFontFamily({ fontFamily: "sans-serif" })).toBe("sans-serif");
		expect(quoteFontFamily({ fontFamily: "monospace" })).toBe("monospace");
	});

	it("still quotes a family that merely contains a generic keyword", () => {
		expect(quoteFontFamily({ fontFamily: "Noto Serif" })).toBe('"Noto Serif"');
	});
});

describe("quoteFontFamily with hostile names", () => {
	it("drops control, format, private-use and surrogate characters", () => {
		expect(quoteFontFamily({ fontFamily: "Foo\u000cBar" })).toBe('"FooBar"');
		expect(quoteFontFamily({ fontFamily: "Foo\n\u0000Bar" })).toBe('"FooBar"');
		expect(quoteFontFamily({ fontFamily: "A\u200b\u202eB" })).toBe('"AB"');
		expect(quoteFontFamily({ fontFamily: "A\ue000\ud800B" })).toBe('"AB"');
		expect(quoteFontFamily({ fontFamily: "A\u2028B\u2029C" })).toBe('"ABC"');
	});

	it("produces something a canvas font string can parse for every one of them", () => {
		const hostile = ["\u000c", "\u0007\u0008", "\u2028", "\ud800", "\\\\"];
		for (const fontFamily of hostile) {
			const quoted = quoteFontFamily({ fontFamily });
			expect(quoted).toMatch(/^"(?:[^"\\]|\\.)*"$/u);
		}
	});

	it("normalizes to NFC", () => {
		expect(quoteFontFamily({ fontFamily: "Cafe\u0301" })).toBe('"Caf\u00e9"');
	});
});

describe("formatFontNameList", () => {
	it("joins up to five names and counts the rest", () => {
		expect(formatFontNameList({ names: ["A", "B"] })).toBe("A, B");
		expect(
			formatFontNameList({ names: ["A", "B", "C", "D", "E", "F", "G"] }),
		).toBe("A, B, C, D, E and 2 more");
	});

	it("shortens every name to 40 characters", () => {
		const [shown] = formatFontNameList({ names: ["x".repeat(100)] }).split(
			", ",
		);
		expect(shown).toHaveLength(40);
		expect(shown.endsWith("\u2026")).toBe(true);
	});

	it("never shows control characters from untrusted names", () => {
		expect(formatFontNameList({ names: ["Evil\u000c\u202eName"] })).toBe(
			"EvilName",
		);
	});

	it("returns an empty string for no names", () => {
		expect(formatFontNameList({ names: [] })).toBe("");
	});
});

describe("font names that are not strings (corrupt project data)", () => {
	it("quotes them as an empty name instead of throwing", () => {
		// JSON.parse returns any: the way bad values really arrive from a saved project.
		for (const json of ["7", "null", "{}", '["Roboto"]']) {
			expect(quoteFontFamily({ fontFamily: JSON.parse(json) })).toBe('""');
		}
	});
});
