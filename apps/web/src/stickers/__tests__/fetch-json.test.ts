import { describe, expect, spyOn, test } from "bun:test";
import { fetchJson } from "../providers/catalog-utils";

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `typeof fetch` also has `preconnect`; the spy only needs the call signature. */
function mockFetch({ implementation }: { implementation: FetchImplementation }) {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: () => {} }),
	);
}

describe("fetchJson (how the catalogs are loaded)", () => {
	test("returns the parsed body and sends an abort signal", async () => {
		const fetchSpy = mockFetch({ implementation: async () => new Response('{"a":1}') });
		expect(await fetchJson({ url: "/emoji/index.json" })).toEqual({ a: 1 });
		expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
		fetchSpy.mockRestore();
	});

	test("gives up on a request that never answers", async () => {
		// AbortSignal.timeout's timer does not keep the process alive, so give the
		// test runner something else to wait on; a browser has plenty.
		const keepAlive = setTimeout(() => {}, 2_000);
		const fetchSpy = mockFetch({
			implementation: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		});
		const started = Date.now();
		await expect(fetchJson({ url: "/emoji/index.json", timeoutMs: 40 })).rejects.toBeDefined();
		expect(Date.now() - started).toBeLessThan(1500);
		fetchSpy.mockRestore();
		clearTimeout(keepAlive);
	});

	test("uses a 15 second timeout unless told otherwise", async () => {
		const fetchSpy = mockFetch({ implementation: async () => new Response("{}") });
		await fetchJson({ url: "/x.json" });
		const signal = fetchSpy.mock.calls[0]?.[1]?.signal;
		expect(signal?.aborted).toBe(false);
		fetchSpy.mockRestore();
		const { CATALOG_FETCH_TIMEOUT_MS } = await import("../providers/catalog-utils");
		expect(CATALOG_FETCH_TIMEOUT_MS).toBe(15_000);
	});

	test("rejects on a failing status, naming the URL", async () => {
		const fetchSpy = mockFetch({ implementation: async () => new Response("no", { status: 503 }) });
		await expect(fetchJson({ url: "/emoji/index.json" })).rejects.toThrow(/503.*\/emoji\/index\.json/);
		fetchSpy.mockRestore();
	});

	test("rejects on a body that is not JSON", async () => {
		const fetchSpy = mockFetch({ implementation: async () => new Response("<html>") });
		await expect(fetchJson({ url: "/x.json" })).rejects.toBeDefined();
		fetchSpy.mockRestore();
	});
});
