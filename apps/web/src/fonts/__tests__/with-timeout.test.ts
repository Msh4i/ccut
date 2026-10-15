import { describe, expect, it } from "bun:test";
import { raceWithTimeout } from "../with-timeout";

describe("raceWithTimeout", () => {
	it("returns the value when the promise settles first", async () => {
		expect(
			await raceWithTimeout({ promise: Promise.resolve(42), ms: 1000 }),
		).toEqual({ timedOut: false, value: 42 });
	});

	it("reports a timeout when the promise never settles", async () => {
		const never = new Promise<number>(() => {});
		expect(await raceWithTimeout({ promise: never, ms: 10 })).toEqual({
			timedOut: true,
		});
	});

	it("passes a rejection through", async () => {
		await expect(
			raceWithTimeout({ promise: Promise.reject(new Error("boom")), ms: 1000 }),
		).rejects.toThrow("boom");
	});
});
