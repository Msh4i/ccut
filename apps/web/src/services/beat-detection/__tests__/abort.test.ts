import { describe, expect, test } from "bun:test";
import { abortable, isAbortError } from "../abort";

describe("isAbortError", () => {
	test("recognises the error an AbortController produces", () => {
		const controller = new AbortController();
		controller.abort();
		expect(isAbortError(controller.signal.reason)).toBe(true);
		expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
	});

	test("rejects everything else", () => {
		for (const value of [new Error("boom"), "AbortError", null, undefined, {}, { name: "AbortError" }]) {
			expect(isAbortError(value)).toBe(false);
		}
	});
});

describe("abortable", () => {
	test("passes the promise result through", async () => {
		const controller = new AbortController();
		await expect(
			abortable({ promise: Promise.resolve(7), signal: controller.signal }),
		).resolves.toBe(7);
	});

	test("passes the promise rejection through", async () => {
		const controller = new AbortController();
		await expect(
			abortable({ promise: Promise.reject(new Error("boom")), signal: controller.signal }),
		).rejects.toThrow("boom");
	});

	test("rejects with an AbortError the moment the signal aborts, without waiting for the promise", async () => {
		const controller = new AbortController();
		const never = new Promise<number>(() => {});
		const pending = abortable({ promise: never, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	test("rejects at once when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			abortable({ promise: Promise.resolve(1), signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	test("does not leave an abort listener behind once the promise settles", async () => {
		const controller = new AbortController();
		let added = 0;
		let removed = 0;
		const add = controller.signal.addEventListener.bind(controller.signal);
		const remove = controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
			added++;
			add(...args);
		};
		controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
			removed++;
			remove(...args);
		};
		await abortable({ promise: Promise.resolve(1), signal: controller.signal });
		expect(added).toBe(1);
		expect(removed).toBe(1);
	});

	test("a promise that rejects after the abort does not become an unhandled rejection", async () => {
		const controller = new AbortController();
		let rejectLate: (error: Error) => void = () => {};
		const late = new Promise<number>((_, reject) => {
			rejectLate = reject;
		});
		const pending = abortable({ promise: late, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		rejectLate(new Error("too late"));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
});
