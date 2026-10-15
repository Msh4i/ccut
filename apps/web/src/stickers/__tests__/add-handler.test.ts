import { describe, expect, spyOn, test } from "bun:test";
import { createAddHandler } from "../add-handler";
import { createSingleFlight } from "../single-flight";

// What a tile does when its add button is pressed, apart from drawing it.

function setup({ add }: { add: () => Promise<void> }) {
	const busy: boolean[] = [];
	const errors: unknown[] = [];
	const handler = createAddHandler({
		flight: createSingleFlight(),
		add,
		onError: ({ error }) => void errors.push(error),
		onBusyChange: ({ busy: value }) => void busy.push(value),
	});
	return { handler, busy, errors };
}

describe("createAddHandler", () => {
	test("two presses while the first is still working add once, and the second does not touch the busy state", async () => {
		let adds = 0;
		let release: () => void = () => {};
		const { handler, busy } = setup({
			add: () =>
				new Promise<void>((done) => {
					adds++;
					release = done;
				}),
		});
		const first = handler();
		const second = handler();
		release();
		await Promise.all([first, second]);
		expect(adds).toBe(1);
		expect(busy).toEqual([true, false]); // one busy period, not two
	});

	test("after a failure the error is reported, the busy state is released and a new press works", async () => {
		let attempt = 0;
		const { handler, busy, errors } = setup({
			add: async () => {
				attempt++;
				if (attempt === 1) throw new Error("could not be loaded");
			},
		});
		await handler();
		expect(errors).toHaveLength(1);
		expect(busy).toEqual([true, false]);

		await handler();
		expect(attempt).toBe(2);
		expect(errors).toHaveLength(1);
		expect(busy).toEqual([true, false, true, false]);
	});

	test("a task that throws before returning a promise is a failure too", async () => {
		const { handler, errors, busy } = setup({
			add: () => {
				throw new Error("sync");
			},
		});
		await handler();
		expect(errors).toHaveLength(1);
		expect(busy).toEqual([true, false]);
	});

	test("the busy state is released even if reporting the error throws", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const busy: boolean[] = [];
		const handler = createAddHandler({
			flight: createSingleFlight(),
			add: async () => {
				throw new Error("x");
			},
			onError: () => {
				throw new Error("the toast failed");
			},
			onBusyChange: ({ busy: value }) => void busy.push(value),
		});
		await expect(handler()).resolves.toBeUndefined();
		expect(busy).toEqual([true, false]);
		expect(consoleError).toHaveBeenCalledTimes(1);
		consoleError.mockRestore();
	});
});
