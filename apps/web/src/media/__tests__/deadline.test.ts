import { describe, expect, test } from "bun:test";
import { withDeadline } from "../deadline";
import { createFakeTimers, flushMicrotasks } from "./fake-timers";

describe("withDeadline", () => {
	test("returns the value when the work settles before the deadline", async () => {
		const timers = createFakeTimers();
		const result = await withDeadline({
			run: async () => 42,
			ms: 1000,
			timers,
		});
		expect(result).toEqual({ status: "ok", value: 42 });
		expect(timers.pending()).toBe(0);
	});

	test("reports an error instead of throwing", async () => {
		const timers = createFakeTimers();
		const boom = new Error("boom");
		const result = await withDeadline({
			run: async () => {
				throw boom;
			},
			ms: 1000,
			timers,
		});
		expect(result).toEqual({ status: "error", error: boom });
		expect(timers.pending()).toBe(0);
	});

	test("a synchronous throw inside run is an error result too", async () => {
		const timers = createFakeTimers();
		const result = await withDeadline({
			run: () => {
				throw new Error("sync");
			},
			ms: 1000,
			timers,
		});
		expect(result.status).toBe("error");
	});

	test("work that never answers resolves as a timeout exactly at the deadline", async () => {
		const timers = createFakeTimers();
		let settled: unknown = null;
		const pending = withDeadline({
			run: () => new Promise<number>(() => {}),
			ms: 1000,
			timers,
		}).then((result) => {
			settled = result;
		});

		timers.advance(999);
		await flushMicrotasks();
		expect(settled).toBeNull();

		timers.advance(1);
		await pending;
		expect(settled).toEqual({ status: "timeout", ms: 1000 });
	});

	test("a late rejection after the timeout is swallowed (no unhandled rejection)", async () => {
		const timers = createFakeTimers();
		let rejectLate: (error: Error) => void = () => {};
		const pending = withDeadline({
			run: () =>
				new Promise<number>((_, reject) => {
					rejectLate = reject;
				}),
			ms: 10,
			timers,
		});
		timers.advance(10);
		expect(await pending).toEqual({ status: "timeout", ms: 10 });
		let unhandled = false;
		const onUnhandled = () => {
			unhandled = true;
		};
		process.on("unhandledRejection", onUnhandled);
		rejectLate(new Error("too late"));
		await flushMicrotasks();
		process.off("unhandledRejection", onUnhandled);
		expect(unhandled).toBe(false);
	});

	test("calls onLate with the value that arrives after the timeout so it can be released", async () => {
		const timers = createFakeTimers();
		let resolveLate: (value: string) => void = () => {};
		const late: string[] = [];
		const pending = withDeadline({
			run: () =>
				new Promise<string>((resolve) => {
					resolveLate = resolve;
				}),
			ms: 10,
			timers,
			onLate: (value) => late.push(value),
		});
		timers.advance(10);
		await pending;
		resolveLate("frame");
		await flushMicrotasks();
		expect(late).toEqual(["frame"]);
	});
});
