import { describe, expect, it } from "bun:test";
import { parseAss } from "../ass";

function assWithFontName({ fontName }: { fontName: string }) {
	return [
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize",
		`Style: Default,${fontName},20`,
		"[Events]",
		"Format: Layer, Start, End, Style, Text",
		"Dialogue: 0,0:00:01.00,0:00:02.00,Default,Hello",
	].join("\n");
}

describe("parseAss font name", () => {
	it("keeps an ordinary font name", () => {
		const { captions } = parseAss({
			input: assWithFontName({ fontName: "Press Start 2P" }),
		});
		expect(captions[0].style?.fontFamily).toBe("Press Start 2P");
	});

	it("clamps an oversized font name to 64 characters at the source", () => {
		const { captions } = parseAss({
			input: assWithFontName({ fontName: "A".repeat(5000) }),
		});
		expect(captions[0].style?.fontFamily?.length).toBe(64);
	});
});
