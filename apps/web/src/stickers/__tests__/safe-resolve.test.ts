import { describe, expect, spyOn, test } from "bun:test";
import { resetUnresolvableWarnings, safeResolveStickerId } from "../resolver";

// The timeline draws a thumbnail for every sticker element, including those of
// old or hand-edited projects. A sticker id that cannot be resolved must not
// throw while rendering (there is no error boundary above it).

describe("safeResolveStickerId", () => {
	test("returns the URL of a good sticker", () => {
		expect(safeResolveStickerId({ stickerId: "emoji:1f600" })).toBe("/emoji/fluent-flat/1f600.svg");
		expect(safeResolveStickerId({ stickerId: "flags:US", options: { width: 20, height: 20 } })).toBe("/flags/us.svg");
	});

	test("returns null, and does not throw, for ids that cannot be resolved", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		for (const stickerId of ["", "nonsense", "unknown:thing", "logos:/../api/health", " emoji:1f600", "emoji:", ":x", "emoji:../../x"]) {
			// "emoji:../../x" resolves to the unknown placeholder: a URL, not an error.
			const result = safeResolveStickerId({ stickerId });
			expect(result === null || typeof result === "string").toBe(true);
			if (stickerId !== "emoji:../../x") expect(result).toBeNull();
		}
		warn.mockRestore();
	});

	test("warns once per id, naming it", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		for (let render = 0; render < 20; render++) {
			expect(safeResolveStickerId({ stickerId: "unknown:warn-once-test" })).toBeNull();
		}
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("unknown:warn-once-test");
		warn.mockRestore();
	});

	test("the number of warnings is bounded: a project full of bad ids cannot flood the log", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		resetUnresolvableWarnings();
		try {
			for (let index = 0; index < 700; index++) {
				expect(safeResolveStickerId({ stickerId: `unknown:flood-${index}` })).toBeNull();
			}
			expect(warn.mock.calls.length).toBeGreaterThan(0);
			expect(warn.mock.calls.length).toBeLessThanOrEqual(500);
		} finally {
			resetUnresolvableWarnings(); // the budget is process-wide: leave it full for nobody
			warn.mockRestore();
		}
	});

	test("a hostile id is cut in the warning, not echoed whole", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		safeResolveStickerId({ stickerId: `nope:${"x".repeat(10_000)}` });
		expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThan(400);
		warn.mockRestore();
	});
});
