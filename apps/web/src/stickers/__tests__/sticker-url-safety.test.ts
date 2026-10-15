import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { searchStickers } from "../index";
import { logosProvider } from "../providers/logos";
import { registerDefaultStickerProviders } from "../providers";
import { resolveStickerId } from "../resolver";
import { StickersRegistry } from "../registry";
import { parseStickerId } from "../sticker-id";
import { assertSafeStickerUrl } from "../url-guard";
import { withSvgSize } from "../providers/svg-asset";
import { readEmojiIndexFromDisk, readIconsIndexFromDisk } from "./catalog-fixtures";

// A sticker id comes from saved projects and the clipboard, so it is untrusted:
// whatever a provider turns it into must stay a same-origin file (or an inline
// image), because the Electron app adds its session token to same-origin requests.

describe("parseStickerId is strict about whitespace", () => {
	test("rejects spaces around the provider, the colon or the value", () => {
		for (const stickerId of [" flags:US", "flags:US ", "flags :US", "flags: US", " flags : US ", "flags:\tUS", "flags:US\n"]) {
			expect(() => parseStickerId({ stickerId })).toThrow();
		}
	});

	test("still parses clean ids, including values with inner spaces", () => {
		expect(parseStickerId({ stickerId: "flags:US" })).toEqual({ providerId: "flags", providerValue: "US" });
		expect(parseStickerId({ stickerId: "shapes:my shape" })).toEqual({
			providerId: "shapes",
			providerValue: "my shape",
		});
	});
});

describe("assertSafeStickerUrl", () => {
	const check = (url: string) => assertSafeStickerUrl({ url, stickerId: "x:y" });

	test("accepts the sticker folders, and nothing else of this origin", () => {
		for (const url of ["/emoji/fluent-flat/1f600.svg", "/emoji/fluent-flat/unknown.svg", "/flags/us.svg", "/icons/phosphor/heart.svg", "/icons/phosphor/arrow-up-fill.svg"]) {
			expect(check(url)).toBe(url);
		}
	});

	test("refuses every other path of this origin: the desktop app sends its token with those requests", () => {
		for (const url of [
			"/api/sounds/search?q=x",
			"/api/health",
			"/_next/image?url=https://evil.example/x.png&w=64&q=75",
			"/_next/static/chunks/main.js",
			"/projects",
			"/a/b/c.png?v=2",
			"/emoji/fluent-flat/1f600.svg?x=1",
			"/emoji/fluent-flat/1f600.svg#frag",
			"/emoji/fluent-flat/sub/1f600.svg",
			"/emoji/fluent-flat/1f600.png",
			"/emoji/index.json",
			"/emoji/fluent-flat/",
			"/icons/phosphor/LICENSE",
			"/flags/",
			"/Flags/us.svg",
		]) {
			expect(() => check(url)).toThrow(/unsafe/i);
		}
	});

	test("accepts the inline images the shapes provider makes: a PNG from the canvas, or its small SVG fallback", () => {
		const fallback = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('\n\t<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="102" fill="white" fill-opacity="0.08" /><text x="50%" y="50%" fill="white" font-size="76" font-family="sans-serif">Circle</text></svg>\n')}`;
		for (const url of ["data:image/png;base64,iVBORw0KGgo=", "data:image/png;base64,AAAA", fallback]) {
			expect(check(url)).toBe(url);
		}
	});

	test("refuses other inline content: other image types, scripts and links inside an SVG, huge payloads", () => {
		const svg = (body: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`)}`;
		for (const url of [
			"data:image/jpeg;base64,/9j/4AAQ",
			"data:image/webp;base64,UklG",
			"data:image/gif;base64,R0lGOD",
			"data:image/png;base64,AAAA\nBBBB",
			"data:image/png,not-base64",
			"data:image/png;base64,",
			svg("<script>alert(1)</script>"),
			svg('<image href="https://evil.example/x.png"/>'),
			svg('<use href="https://evil.example/x.svg#a"/>'),
			svg('<rect style="fill:url(//evil.example/x)"/>'),
			svg('<foreignObject><iframe/></foreignObject>'),
			`data:image/png;base64,${"A".repeat(5_000_000)}`,
			`data:image/svg+xml;charset=utf-8,${"%41".repeat(20_000)}`,
		]) {
			expect(() => check(url)).toThrow(/unsafe/i);
		}
	});

	test("rejects protocol-relative, absolute and script URLs", () => {
		for (const url of ["//evil.example/a.svg", "https://evil.example/a.svg", "http://localhost/api/health", "javascript:alert(1)", "file:///etc/passwd", "blob:http://x/y"]) {
			expect(() => check(url)).toThrow(/unsafe/i);
		}
	});

	test("rejects relative paths, traversal and backslashes, however encoded", () => {
		for (const url of [
			"emoji/a.svg",
			"/../api/health",
			"/emoji/../../api/health",
			"/emoji/%2e%2e/api/health",
			"/emoji/%2E%2E%2Fapi",
			"/emoji\\..\\api",
			"/emoji/..%5Capi",
			"\\\\server\\share",
			"/%2F%2Fevil.example/a.svg", // decodes to a protocol-relative path
			"/%2f/evil.example/a.svg",
		]) {
			expect(() => check(url)).toThrow(/unsafe/i);
		}
	});

	test("rejects non-image data URLs and control characters", () => {
		for (const url of ["data:text/html,<script>alert(1)</script>", "data:application/json,{}", "/a\nb.svg", "/a\u0000b.svg", ""]) {
			expect(() => check(url)).toThrow(/unsafe/i);
		}
	});

	test("the message names the sticker, not the whole hostile URL", () => {
		let message = "";
		try {
			assertSafeStickerUrl({ url: `//evil.example/${"x".repeat(5_000)}`, stickerId: "logos:bad" });
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("logos:bad");
		expect(message.length).toBeLessThan(300);
	});
});

describe("resolveStickerId applies the guard to every provider", () => {
	registerDefaultStickerProviders();

	test("the logos provider no longer turns the id into a URL", () => {
		expect(() => logosProvider.resolveUrl({ stickerId: "logos:/../api/health" })).toThrow();
		for (const stickerId of ["logos:/../api/health", "logos://evil.example/x", "logos:https://evil.example/x"]) {
			expect(() => resolveStickerId({ stickerId })).toThrow();
		}
	});

	test("real providers still resolve", () => {
		expect(resolveStickerId({ stickerId: "flags:US" })).toBe("/flags/us.svg");
		expect(resolveStickerId({ stickerId: "emoji:1f600" })).toBe("/emoji/fluent-flat/1f600.svg");
		expect(resolveStickerId({ stickerId: "icons:heart" })).toBe("/icons/phosphor/heart.svg");
	});

	test("ids with padding are refused before reaching a provider", () => {
		expect(() => resolveStickerId({ stickerId: "flags: US" })).toThrow();
		expect(() => resolveStickerId({ stickerId: " flags:US" })).toThrow();
	});
});

describe("resolveStickerId refuses whatever a provider returns if it is unsafe", () => {
	function registryReturning({ url }: { url: string }) {
		const registry = new StickersRegistry();
		registry.register({
			key: "fake",
			definition: {
				id: "fake",
				search: async () => ({ items: [], total: 0, hasMore: false }),
				browse: async () => ({ sections: [] }),
				resolveUrl: () => url,
			},
		});
		return registry;
	}
	const resolve = ({ url }: { url: string }) =>
		resolveStickerId({ stickerId: "fake:x", registry: registryReturning({ url }) });

	test("hostile URLs from a provider are refused, naming the sticker", () => {
		for (const url of ["//evil.example/a.svg", "https://evil.example/a.svg", "/../api/health", "/a/%2e%2e/api", "javascript:alert(1)", "data:text/html,<b>", ""]) {
			expect(() => resolve({ url })).toThrow(/unsafe URL for "fake:x"/);
		}
	});

	test("safe URLs pass through unchanged", () => {
		for (const url of ["/emoji/fluent-flat/x.svg", "data:image/png;base64,AAAA"]) {
			expect(resolve({ url })).toBe(url);
		}
	});

	test("a provider the registry does not know is still an error", () => {
		expect(() => resolveStickerId({ stickerId: "nobody:x", registry: new StickersRegistry() })).toThrow();
	});
});

describe("withSvgSize keeps special replacement patterns literal", () => {
	test("a root tag containing $& or $' is not mangled", () => {
		const svg = `<svg data-note="cost $& then $' and $1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`;
		const resized = withSvgSize({ svg, size: 512 });
		expect(resized).toContain(`data-note="cost $& then $' and $1"`);
		expect(resized.startsWith('<svg width="512" height="512" data-note')).toBe(true);
		expect(resized.endsWith("</svg>")).toBe(true);
		expect(resized.match(/<svg/g)).toHaveLength(1);
	});
});

describe("every URL the real providers return still passes the guard", () => {
	registerDefaultStickerProviders();

	// The emoji and icon catalogs are fetched from the app's own server; serve them from disk.
	let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
	beforeAll(() => {
		const files: Record<string, unknown> = {
			"/emoji/index.json": readEmojiIndexFromDisk(),
			"/icons/phosphor/index.json": readIconsIndexFromDisk(),
		};
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async (input: RequestInfo | URL) => {
				const url = String(input);
				return url in files ? new Response(JSON.stringify(files[url])) : new Response("not found", { status: 404 });
			}, { preconnect: () => {} }),
		);
	});
	afterAll(() => fetchSpy.mockRestore());

	async function everyId(category: "emoji" | "icons" | "flags" | "shapes") {
		const result = await searchStickers({ query: "", category, limit: 100_000 });
		return result.items.map((item) => item.id);
	}

	for (const category of ["emoji", "icons", "flags", "shapes"] as const) {
		test(`${category}: every sticker of the catalog resolves (preview and element URLs)`, async () => {
			const ids = await everyId(category);
			expect(ids.length).toBeGreaterThan(0);
			for (const stickerId of ids) {
				expect(() => resolveStickerId({ stickerId })).not.toThrow();
			}
		});
	}

	test("the preview URLs the providers put on their tiles pass as well (first and last 50 of each)", async () => {
		for (const category of ["emoji", "icons", "flags", "shapes"] as const) {
			const { items } = await searchStickers({ query: "", category, limit: 100_000 });
			for (const item of [...items.slice(0, 50), ...items.slice(-50)]) {
				expect(() => assertSafeStickerUrl({ url: item.previewUrl, stickerId: item.id })).not.toThrow();
			}
		}
	});
});
