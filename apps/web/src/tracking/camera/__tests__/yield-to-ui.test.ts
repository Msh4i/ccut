import { afterEach, describe, expect, test } from "bun:test";
import { yieldToUi } from "../yield-to-ui";

afterEach(() => {
	Reflect.deleteProperty(globalThis, "scheduler");
});

describe("yieldToUi", () => {
	test("hands back a whole task: work queued as a microtask after it runs before it resolves", async () => {
		const order: string[] = [];
		const yielded = yieldToUi().then(() => order.push("yielded"));
		queueMicrotask(() => order.push("microtask"));
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["microtask"]);
		await yielded;
		expect(order).toEqual(["microtask", "yielded"]);
	});

	test("does not use scheduler.yield where the browser has it: its continuations outrank painting", async () => {
		let calls = 0;
		Reflect.set(globalThis, "scheduler", {
			yield: () => {
				calls++;
				return Promise.resolve();
			},
		});
		await yieldToUi();
		expect(calls).toBe(0);
	});

	test("one yield per frame in sequence, as the analysis does, runs through", async () => {
		let frames = 0;
		for (let i = 0; i < 300; i++) {
			await yieldToUi();
			frames++;
		}
		expect(frames).toBe(300);
	});

	test("yields taken at the same time all resolve (none is lost)", async () => {
		const done = new Set<number>();
		await Promise.all(Array.from({ length: 50 }, (_, i) => yieldToUi().then(() => done.add(i))));
		expect(done.size).toBe(50);
	});
});
