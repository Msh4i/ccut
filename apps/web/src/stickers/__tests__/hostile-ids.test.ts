import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_DESCRIBED_LENGTH, describeError, describeId } from "../describe-id";
import { resolveStickerId, safeResolveStickerId } from "../resolver";
import { parseStickerId } from "../sticker-id";

// A sticker id comes from a saved project or the clipboard: it can be any type
// and any length. Nothing that reads one may throw a TypeError or write it
// whole into a message.

const NON_STRINGS: [string, unknown][] = [
	["number", 123],
	["null", null],
	["undefined", undefined],
	["object", {}],
	["array", []],
	["boolean", true],
	["bigint", BigInt(1)],
	["symbol", Symbol("x")],
	["NaN", Number.NaN],
	["function", () => 1],
	["date", new Date(0)],
	["object with a toString that throws", { toString: () => { throw new Error("no"); } }],
];

const HUGE = "x".repeat(10_000);

let warn: ReturnType<typeof spyOn<Console, "warn">>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("describeId", () => {
	test("keeps a short string, cuts a long one with an ellipsis", () => {
		expect(describeId({ value: "emoji:1f600" })).toBe("emoji:1f600");
		const cut = describeId({ value: HUGE });
		expect(cut.length).toBe(MAX_DESCRIBED_LENGTH + 1);
		expect(cut.endsWith("…")).toBe(true);
		expect(describeId({ value: "y".repeat(MAX_DESCRIBED_LENGTH) })).toHaveLength(MAX_DESCRIBED_LENGTH);
	});

	test("names the type of anything that is not a string, never its content", () => {
		expect(describeId({ value: 123 })).toBe("<number>");
		expect(describeId({ value: null })).toBe("<null>");
		expect(describeId({ value: undefined })).toBe("<undefined>");
		expect(describeId({ value: {} })).toBe("<object>");
		expect(describeId({ value: Symbol("x") })).toBe("<symbol>");
		expect(describeId({ value: BigInt(1) })).toBe("<bigint>");
		expect(describeId({ value: () => 1 })).toBe("<function>");
	});

	test("describeError cuts a long error message and survives a non-Error", () => {
		expect(describeError({ error: new Error("short") })).toBe("short");
		expect(describeError({ error: new Error(HUGE) }).length).toBeLessThan(400);
		expect(describeError({ error: "plain" })).toBe("plain");
		expect(describeError({ error: null })).toBe("null");
	});
});

describe("safeResolveStickerId with anything as the id", () => {
	for (const [name, value] of NON_STRINGS) {
		test(`${name}: returns null, does not throw`, () => {
			expect(safeResolveStickerId({ stickerId: value })).toBeNull();
		});
	}

	test("warns once per kind of bad id, not on every render", () => {
		for (let render = 0; render < 30; render++) {
			for (const [, value] of NON_STRINGS.slice(0, 6)) safeResolveStickerId({ stickerId: value });
		}
		expect(warn.mock.calls.length).toBeLessThanOrEqual(6);
	});

	test("every argument of the warning is short, also for a huge id", () => {
		safeResolveStickerId({ stickerId: `nope:${HUGE}` });
		safeResolveStickerId({ stickerId: HUGE });
		expect(warn.mock.calls.length).toBeGreaterThan(0);
		for (const call of warn.mock.calls) {
			for (const argument of call) {
				expect(String(argument).length).toBeLessThan(500);
			}
		}
	});
});

describe("resolveStickerId with anything as the id", () => {
	for (const [name, value] of NON_STRINGS) {
		test(`${name}: an explicit error, not a TypeError`, () => {
			let failure: unknown;
			try {
				resolveStickerId({ stickerId: value });
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(failure instanceof TypeError).toBe(false);
			expect(failure instanceof Error && failure.message).toMatch(/must be a string/);
		});
	}
});

describe("messages stay short for a huge id", () => {
	const message = (run: () => unknown) => {
		try {
			run();
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return "";
	};

	test("parseStickerId, in every way it can fail", () => {
		for (const stickerId of [HUGE, `${HUGE}:`, `:${HUGE}`, ` ${HUGE}`, `${HUGE} :x`, `p: ${HUGE}`]) {
			const text = message(() => parseStickerId({ stickerId }));
			expect(text).not.toBe("");
			expect(text.length).toBeLessThan(300);
		}
	});

	test("resolveStickerId with an unknown provider of a huge name", () => {
		const text = message(() => resolveStickerId({ stickerId: `${HUGE}:x` }));
		expect(text).not.toBe("");
		expect(text.length).toBeLessThan(300);
	});

	test("resolveStickerId whose provider refuses the URL", () => {
		const text = message(() => resolveStickerId({ stickerId: `logos:${HUGE}` }));
		expect(text.length).toBeLessThan(300);
	});
});
