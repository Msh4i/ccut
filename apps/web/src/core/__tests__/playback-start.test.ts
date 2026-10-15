import { describe, expect, test } from "bun:test";
import { waitForStartGate } from "../playback-start";

const never = () => new Promise<void>(() => {});

describe("waitForStartGate", () => {
	test("a gate that never settles gives up at the cap", async () => {
		const result = await waitForStartGate({ gate: never, maxMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
		expect(result).toBe("timeout");
	});

	test("a failing gate does not stop playback", async () => {
		const result = await waitForStartGate({ gate: () => Promise.reject(new Error("gpu")), maxMs: 1000, sleep: never });
		expect(result).toBe("ready");
	});
});
