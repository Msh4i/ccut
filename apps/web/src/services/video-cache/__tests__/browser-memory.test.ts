import { describe, expect, test } from "bun:test";
import {
	createBrowserMemorySource,
	readBridgeMemory,
	readDeviceMemory,
	withTimeout,
} from "../browser-memory";
import { usePerformanceStore } from "../performance-store";

describe("readBridgeMemory", () => {
	test("no window, no bridge, or no memoryInfo function: no reading", async () => {
		for (const host of [null, undefined, 5, {}, { ccutSystem: null }, { ccutSystem: {} }, { ccutSystem: { memoryInfo: 5 } }]) {
			expect(await readBridgeMemory({ host })).toBeNull();
		}
	});

	test("calls memoryInfo on the bridge and passes its answer on unchanged", async () => {
		const answer = { totalBytes: 1, availableBytes: 0, swapTotalBytes: 0, swapFreeBytes: 0, appBytes: 0 };
		const bridge = {
			calls: 0,
			memoryInfo() {
				this.calls += 1;
				return Promise.resolve(answer);
			},
		};
		expect(await readBridgeMemory({ host: { ccutSystem: bridge } })).toBe(answer);
		expect(bridge.calls).toBe(1);
	});

	test("a bridge that rejects rejects (the cache treats it as no reading)", async () => {
		const host = { ccutSystem: { memoryInfo: () => Promise.reject(new Error("ipc closed")) } };
		await expect(readBridgeMemory({ host })).rejects.toThrow("ipc closed");
	});
});

describe("withTimeout", () => {
	test("a reading that never comes is no reading after the timeout", async () => {
		const never = new Promise<unknown>(() => {});
		expect(await withTimeout({ promise: never, ms: 5, fallback: null })).toBeNull();
	});

	test("a reading in time is passed on, a rejection in time rejects", async () => {
		expect(await withTimeout({ promise: Promise.resolve(42), ms: 1000, fallback: null })).toBe(42);
		await expect(
			withTimeout({ promise: Promise.reject(new Error("ipc closed")), ms: 1000, fallback: null }),
		).rejects.toThrow("ipc closed");
	});

	test("a rejection after the timeout is handled (no unhandled rejection)", async () => {
		let rejectLate: (error: Error) => void = () => {};
		const late = new Promise<unknown>((_resolve, reject) => {
			rejectLate = reject;
		});
		expect(await withTimeout({ promise: late, ms: 5, fallback: "none" })).toBe("none");
		rejectLate(new Error("too late"));
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
});

describe("readDeviceMemory", () => {
	test("a number or null", () => {
		expect(readDeviceMemory({ host: { deviceMemory: 8 } })).toBe(8);
		expect(readDeviceMemory({ host: { deviceMemory: "8" } })).toBeNull();
		expect(readDeviceMemory({ host: {} })).toBeNull();
		expect(readDeviceMemory({ host: null })).toBeNull();
	});
});

describe("createBrowserMemorySource", () => {
	test("follows the Performance setting; without a window it reads nothing and starts no timer", async () => {
		const source = createBrowserMemorySource();
		const before = usePerformanceStore.getState().mode;
		usePerformanceStore.getState().setMode("high");
		expect(source.mode()).toBe("high");
		usePerformanceStore.getState().setMode(before);
		expect(await source.readMemory()).toBeNull();
		let ticks = 0;
		const stop = source.schedule?.(() => {
			ticks += 1;
		});
		stop?.();
		expect(ticks).toBe(0);
	});
});
