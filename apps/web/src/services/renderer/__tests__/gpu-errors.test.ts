import { describe, expect, test } from "bun:test";
import { parseGpuErrorStats, readGpuErrorStats } from "@/services/renderer/gpu-errors";

// The GPU device records its uncaptured errors instead of panicking
// (rust/crates/gpu/src/context.rs) and the wasm export getGpuErrorStats()
// returns { count, lastMessage }. The vendored wasm only has that export after
// it is rebuilt, so the reader detects it instead of importing it by name.

describe("parseGpuErrorStats", () => {
	test("takes the export's object", () => {
		expect(parseGpuErrorStats({ count: 3, lastMessage: "Validation Error" })).toEqual({
			count: 3,
			lastMessage: "Validation Error",
		});
		expect(parseGpuErrorStats({ count: 0, lastMessage: null })).toEqual({
			count: 0,
			lastMessage: null,
		});
	});

	test("anything else is no stats", () => {
		const broken: unknown[] = [
			null,
			undefined,
			3,
			"x",
			{ lastMessage: null },
			{ count: "3", lastMessage: null },
			{ count: -1, lastMessage: null },
			{ count: Number.NaN, lastMessage: null },
			{ count: 1, lastMessage: 5 },
			{ count: 1 },
		];
		for (const value of broken) {
			expect(parseGpuErrorStats(value)).toBeNull();
		}
	});
});

describe("readGpuErrorStats", () => {
	test("calls the export when the wasm build has it", () => {
		const wasm = { getGpuErrorStats: () => ({ count: 2, lastMessage: "bad bind group" }) };
		expect(readGpuErrorStats({ wasm })).toEqual({ count: 2, lastMessage: "bad bind group" });
	});

	test("a wasm build without the export (the vendored one before its rebuild) gives no stats", () => {
		expect(readGpuErrorStats({ wasm: {} })).toBeNull();
		expect(readGpuErrorStats({ wasm: { getGpuErrorStats: 5 } })).toBeNull();
	});

	test("an export that throws gives no stats instead of breaking the draw", () => {
		const wasm = {
			getGpuErrorStats: () => {
				throw new Error("RuntimeError: unreachable");
			},
		};
		expect(readGpuErrorStats({ wasm })).toBeNull();
	});
});
