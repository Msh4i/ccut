import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";

// The route reads secrets and talks to Upstash at import time: stand in for both.
const checkRateLimit = mock(async (_args: { request: Request }) => ({
	limited: false,
}));
mock.module("@/env/web", () => ({ webEnv: { FREESOUND_API_KEY: "test-key" } }));
mock.module("@/auth/rate-limit", () => ({ checkRateLimit }));

const { GET } = await import("../route");

const originalDesktop = process.env.NEXT_PUBLIC_DESKTOP;

// Bun's `fetch` type also carries `preconnect`, which a plain stub lacks.
function stubFetch({ respond }: { respond: () => Promise<Response> }) {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(respond, { preconnect: () => {} }),
	);
}

function search() {
	return GET(new NextRequest("http://localhost/api/sounds/search?q=rain"));
}

beforeEach(() => {
	checkRateLimit.mockClear();
	spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	mock.restore();
	if (originalDesktop === undefined) {
		delete process.env.NEXT_PUBLIC_DESKTOP;
	} else {
		process.env.NEXT_PUBLIC_DESKTOP = originalDesktop;
	}
});

afterAll(() => {
	mock.restore();
});

describe("GET /api/sounds/search in the desktop app", () => {
	test("answers 503 at once, before the rate limit or Freesound are touched", async () => {
		process.env.NEXT_PUBLIC_DESKTOP = "1";
		const fetchSpy = stubFetch({ respond: async () => new Response("{}") });

		const response = await search();

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: expect.stringMatching(/desktop/i),
		});
		expect(checkRateLimit).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("GET /api/sounds/search in the hosted build", () => {
	test("still rate limits", async () => {
		delete process.env.NEXT_PUBLIC_DESKTOP;
		checkRateLimit.mockResolvedValueOnce({ limited: true });

		const response = await search();

		expect(response.status).toBe(429);
	});

	test("gives the upstream request a timeout, so a stalled Freesound cannot hang the panel", async () => {
		delete process.env.NEXT_PUBLIC_DESKTOP;
		const fetchSpy = stubFetch({
			respond: async () => new Response("{}", { status: 500 }),
		});

		await search();

		expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("a timed out upstream request becomes a 504, not a hung or generic error", async () => {
		delete process.env.NEXT_PUBLIC_DESKTOP;
		stubFetch({
			respond: async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			},
		});

		const response = await search();

		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({ error: expect.any(String) });
	});
});
