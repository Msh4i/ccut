import { describe, expect, spyOn, test } from "bun:test";
import { createCatalogLoader } from "../providers/catalog-utils";

describe("createCatalogLoader", () => {
	test("loads once and shares the value, however many callers", async () => {
		let loads = 0;
		const get = createCatalogLoader({
			label: "test catalog",
			load: async () => {
				loads += 1;
				return { items: [1, 2, 3] };
			},
		});
		const [a, b] = await Promise.all([get(), get()]);
		await get();
		expect(loads).toBe(1);
		expect(a).toEqual({ status: "ready", value: { items: [1, 2, 3] } });
		expect(a).toBe(b);
	});

	test("a failure is reported as failed (not as an empty catalog) and logged with the label", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const get = createCatalogLoader({
			label: "emoji index",
			load: async () => {
				throw new Error("offline");
			},
		});
		const result = await get();
		expect(result.status).toBe("failed");
		expect(result.status === "failed" && result.error.message).toBe("offline");
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(String(consoleError.mock.calls[0]?.[0])).toContain("emoji index");
		consoleError.mockRestore();
	});

	test("a failure is not cached: the next call tries again and can succeed", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const get = createCatalogLoader({
			label: "test catalog",
			load: async () => {
				attempts += 1;
				if (attempts < 3) throw new Error(`attempt ${attempts}`);
				return "ok";
			},
		});
		expect((await get()).status).toBe("failed");
		expect((await get()).status).toBe("failed");
		expect(await get()).toEqual({ status: "ready", value: "ok" });
		expect(attempts).toBe(3);
		expect(consoleError).toHaveBeenCalledTimes(2);
		consoleError.mockRestore();
	});

	test("concurrent callers during a failing load share one attempt and all see the failure", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let attempts = 0;
		const get = createCatalogLoader({
			label: "test catalog",
			load: async () => {
				attempts += 1;
				await new Promise((done) => setTimeout(done, 10));
				throw new Error("down");
			},
		});
		const results = await Promise.all([get(), get(), get()]);
		expect(attempts).toBe(1);
		expect(results.map((result) => result.status)).toEqual(["failed", "failed", "failed"]);
		consoleError.mockRestore();
	});

	test("a load that throws before returning a promise is a failure too", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const get = createCatalogLoader<string>({
			label: "test catalog",
			load: () => {
				throw new Error("sync");
			},
		});
		expect((await get()).status).toBe("failed");
		consoleError.mockRestore();
	});

	test("a non-Error rejection becomes an Error", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const get = createCatalogLoader<string>({
			label: "test catalog",
			load: () => Promise.reject("plain string"),
		});
		const result = await get();
		expect(result.status === "failed" && result.error).toBeInstanceOf(Error);
		consoleError.mockRestore();
	});

	test("reset forgets the loaded catalog: the next call loads it again, then shares that", async () => {
		let loads = 0;
		const get = createCatalogLoader({
			label: "test catalog",
			load: async () => {
				loads += 1;
				return loads;
			},
		});
		expect(await get()).toEqual({ status: "ready", value: 1 });
		expect(await get()).toEqual({ status: "ready", value: 1 });

		get.reset();
		expect(await get()).toEqual({ status: "ready", value: 2 });
		expect(await get()).toEqual({ status: "ready", value: 2 });
		expect(loads).toBe(2);
	});

	test("reset on a loader that never loaded changes nothing", async () => {
		let loads = 0;
		const get = createCatalogLoader({
			label: "test catalog",
			load: async () => {
				loads += 1;
				return "ok";
			},
		});
		get.reset();
		expect(loads).toBe(0);
		expect(await get()).toEqual({ status: "ready", value: "ok" });
		expect(loads).toBe(1);
	});

	test("a load that fails after a reset does not throw away the newer load", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let loads = 0;
		let failFirst: () => void = () => {};
		const get = createCatalogLoader({
			label: "test catalog",
			load: async () => {
				loads += 1;
				if (loads === 1) {
					await new Promise<void>((_, reject) => {
						failFirst = () => reject(new Error("first one is slow and fails"));
					});
				}
				return loads;
			},
		});

		const first = get();
		get.reset();
		expect(await get()).toEqual({ status: "ready", value: 2 });

		failFirst();
		expect((await first).status).toBe("failed");
		// The late failure must not clear the second load: this call shares it.
		expect(await get()).toEqual({ status: "ready", value: 2 });
		expect(loads).toBe(2);
		consoleError.mockRestore();
	});
});
