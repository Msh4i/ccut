import { describe, expect, it } from "bun:test";
import { truncateFileName } from "../string";

describe("truncateFileName", () => {
	it("leaves a short name unchanged", () => {
		expect(truncateFileName({ name: "click.wav" })).toBe("click.wav");
		expect(truncateFileName({ name: "" })).toBe("");
	});

	it("leaves a name at the limit unchanged", () => {
		const name = "abcdefghijk.wav";
		expect(name).toHaveLength(15);
		expect(truncateFileName({ name })).toBe(name);
	});

	it("keeps the extension once after a single ellipsis", () => {
		expect(truncateFileName({ name: "verylongname-final.wav" })).toBe(
			"verylongna….wav",
		);
	});

	it("never exceeds the limit", () => {
		const out = truncateFileName({ name: "a-very-long-clip-name.webm" });
		expect(out).toBe("a-very-lo….webm");
		expect([...out].length).toBeLessThanOrEqual(15);
	});

	it("truncates a long name without an extension", () => {
		expect(truncateFileName({ name: "a-very-long-clip-name" })).toBe(
			"a-very-long-cl…",
		);
	});

	it("does not treat a long dot-suffix as an extension", () => {
		expect(truncateFileName({ name: "recording.verylongsuffix" })).toBe(
			"recording.very…",
		);
	});

	it("does not split surrogate pairs", () => {
		const out = truncateFileName({ name: `${"\u{1F3AC}".repeat(20)}.mp4` });
		expect(out).toBe(`${"\u{1F3AC}".repeat(10)}….mp4`);
	});
});
