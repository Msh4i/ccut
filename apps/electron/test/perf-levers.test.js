const { describe, expect, test } = require("bun:test");
const { LEVERS_STORAGE_KEY, leversCompareNote, leversLineOf, persistedWithLevers } = require("./perf/levers");

// --levers: the value the harness writes into the temporary profile, and what it reads back.

const ON = { decodeWorker: false, bitmapUpload: false, displayResolution: true };
const OFF = { decodeWorker: false, bitmapUpload: false, displayResolution: false };

describe("persistedWithLevers", () => {
	test("the app's store key and persist shape", () => {
		expect(LEVERS_STORAGE_KEY).toBe("ccut-playback-levers");
		expect(JSON.parse(persistedWithLevers({ stored: null, levers: ON }))).toEqual({ state: { levers: ON }, version: 1 });
	});

	test("replaces the stored levers and keeps every other stored field", () => {
		const stored = JSON.stringify({ state: { levers: { decodeWorker: true, bitmapUpload: true, displayResolution: true }, other: "kept" }, version: 1 });
		expect(JSON.parse(persistedWithLevers({ stored, levers: OFF }))).toEqual({ state: { levers: OFF, other: "kept" }, version: 1 });
	});

	test("an unreadable stored value is replaced; only exact true turns a lever on", () => {
		for (const stored of ["not json", "null", "[1]", JSON.stringify({ state: "x" }), JSON.stringify({ state: [1] })]) {
			expect(JSON.parse(persistedWithLevers({ stored, levers: ON }))).toEqual({ state: { levers: ON }, version: 1 });
		}
		expect(JSON.parse(persistedWithLevers({ stored: null, levers: { decodeWorker: "on", bitmapUpload: 1, displayResolution: true, extra: true } })).state.levers).toEqual(ON);
	});
});

describe("levers in the result", () => {
	test("the HUD's levers line, or null", () => {
		expect(leversLineOf("Ccut playback HUD: ...\ncache: budget 1\nlevers: worker off | bitmap off | display on 540x960 (x0.5)")).toBe("levers: worker off | bitmap off | display on 540x960 (x0.5)");
		expect(leversLineOf("Ccut playback HUD: ...")).toBeNull();
		expect(leversLineOf(null)).toBeNull();
	});

	test("--compare notes runs that set the same levers, not runs that differ or did not set them", () => {
		expect(leversCompareNote({ before: { options: { levers: ON } }, after: { options: { levers: { ...ON } } } })).toContain("same --levers");
		expect(leversCompareNote({ before: { options: { levers: OFF } }, after: { options: { levers: ON } } })).toBeNull();
		expect(leversCompareNote({ before: { options: { levers: null } }, after: { options: { levers: null } } })).toBeNull();
		expect(leversCompareNote({ before: { options: {} }, after: { options: { levers: ON } } })).toBeNull();
	});
});
